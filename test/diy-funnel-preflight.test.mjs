import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PROJECT, TEAM, CAMPAIGN, ENDPOINT, EVENTS, ADS, runDiyPreflight, inspectAggregate, safeQueryBound, requestedWindow } from '../scripts/diy-funnel-preflight.mjs';

const now = new Date('2026-10-26T01:30:00.000Z'), day = '2026-10-26';
const window = requestedWindow(now);
const id = Object.keys(ADS)[0], secret = 'ONLY_FIXTURE_SECRET_DO_NOT_OUTPUT';
const filter = event => `environment eq 'production' and eventName eq '${event}' and eventData/campaign_id eq '${CAMPAIGN}'`;
const body = (event = EVENTS[0], rows = [{ eventData: id, count: 3, visitors: 2 }]) => ({
  version: 1, query: { since: day, until: '2026-10-26T02:00:00.000Z', filter: filter(event), groupBy: ['eventData/ad_id'], limit: 32 }, data: rows,
});

test('only four fixed current-UTC-day GETs; token is a header and only approved aggregates survive', async () => {
  const calls = [];
  const report = await runDiyPreflight({ token: secret, now, fetcher: async (url, options) => {
    calls.push({ url: new URL(url), options });
    const event = EVENTS[calls.length - 1];
    const value = body(event, [{ eventData: id, count: 3, visitors: 2, projectId: PROJECT, environment: 'production', eventName: event,
      email: 'PRIVATE_VALUE', PRIVATE_FIELD_NAME: secret }]);
    value.PRIVATE_TOP_FIELD = 'PRIVATE_VALUE';
    return Response.json(value);
  } });
  assert.equal(calls.length, 4);
  for (const [i, call] of calls.entries()) {
    assert.equal(`${call.url.origin}${call.url.pathname}`, ENDPOINT);
    assert.deepEqual([...call.url.searchParams.keys()].sort(), ['by','filter','limit','projectId','since','teamId','until'].sort());
    assert.equal(call.url.searchParams.get('projectId'), PROJECT); assert.equal(call.url.searchParams.get('teamId'), TEAM);
    assert.equal(call.url.searchParams.get('since'), String(window.since)); assert.equal(call.url.searchParams.get('until'), String(window.until));
    assert.equal(call.url.searchParams.get('by'), 'eventData/ad_id'); assert.equal(call.url.searchParams.get('limit'), '32');
    assert.equal(call.url.searchParams.get('filter'), filter(EVENTS[i]));
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(call.url.toString().includes(secret), false);
  }
  const output = JSON.stringify(report);
  assert.equal(output.includes(secret), false); assert.equal(output.includes('PRIVATE'), false);
  assert.equal(report.status, 'aggregate_reads_validated'); assert.equal(report.event_reception_proven, true);
  assert.equal(report.snapshot_written, false); assert.equal(report.published, false); assert.equal(report.events_generated, false);
  assert.deepEqual(report.results[0].rows, [{ ad_id: id, code: ADS[id], count: 3, visitors: 2 }]);
});

test('empty successful reads mean waiting; no fabricated zeros or event reception claim', async () => {
  let calls = 0;
  const report = await runDiyPreflight({ token: secret, now, fetcher: async () => Response.json(body(EVENTS[calls++], [])) });
  assert.equal(report.status, 'awaiting_events'); assert.equal(report.event_reception_proven, false); assert.equal(calls, 4);
  assert.ok(report.results.every(row => row.rows.length === 0 && row.status === 'awaiting_events' && !row.event_reception_proven));
  assert.equal(Object.hasOwn(report, 'observed_at'), false, 'Preflight does not overwrite source freshness');
});

test('unknown ads, duplicate rows, Others, wrong asset context and private row values are rejected without echo', () => {
  for (const rows of [
    [{ eventData: 'PRIVATE_OTHER_ACCOUNT', count: 5, visitors: 1 }],
    [{ eventData: 'Others', count: 5, visitors: 1 }],
    [{ eventData: id, count: 1, visitors: 1 }, { eventData: id, count: 2, visitors: 1 }],
    [{ eventData: id, count: 1, visitors: 1, environment: 'preview' }],
    [{ eventData: id, count: 1, visitors: 1, projectId: 'PRIVATE_PROJECT' }],
    [{ eventData: { ad_id: id, campaign_id: 'PRIVATE_CAMPAIGN' }, count: 1, visitors: 1 }],
  ]) {
    const result = inspectAggregate(body(EVENTS[0], rows), { window, event: EVENTS[0] });
    assert.equal(result.status, 'error'); assert.equal(result.error, 'PREFLIGHT_SCOPE_MISMATCH'); assert.deepEqual(result.rows, []);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
});

test('metrics and query/period mismatches stay unvalidated and do not expose query values', () => {
  for (const metrics of [{ count: '3', visitors: 1 }, { count: -1, visitors: 1 }, { count: 1, visitors: 2 }, { count: 1 }, { count: 1.5, visitors: 1 }]) {
    const result = inspectAggregate(body(EVENTS[0], [{ eventData: id, ...metrics }]), { window, event: EVENTS[0] });
    assert.equal(result.error, 'PREFLIGHT_METRIC_SHAPE_UNVALIDATED'); assert.deepEqual(result.rows, []);
  }
  for (const query of [{ since: '2026-10-25' }, { until: '2026-10-27T12:00:00Z' }, { filter: 'PRIVATE_QUERY' }, { groupBy: ['userId'] }]) {
    const value = body(); value.query = { ...value.query, ...query };
    const result = inspectAggregate(value, { window, event: EVENTS[0] });
    assert.equal(result.error, 'PREFLIGHT_QUERY_MISMATCH'); assert.equal(JSON.stringify(result).includes('PRIVATE_QUERY'), false);
  }
  const outOfDay = inspectAggregate(body(EVENTS[0], [{ eventData: id, count: 1, visitors: 1, timestamp: '2026-10-25T22:00:00Z' }]), { window, event: EVENTS[0] });
  assert.equal(outOfDay.error, 'PREFLIGHT_PERIOD_MISMATCH');
});

test('HTTP errors are classified; bodies/exceptions are never logged or returned, no retry writes', async () => {
  let calls = 0, parsed = 0;
  const statuses = [401, 403, 402, 429];
  const report = await runDiyPreflight({ token: secret, now, fetcher: async () => ({ ok: false, status: statuses[calls++], json: async () => { parsed++; throw Error(secret); } }) });
  assert.equal(calls, 4); assert.equal(parsed, 0); assert.equal(report.status, 'failed');
  assert.deepEqual(report.results.map(row => row.error), ['ANALYTICS_LOGIN_REQUIRED','ANALYTICS_PERMISSION_REQUIRED','ANALYTICS_PLAN_REQUIRED','ANALYTICS_RATE_LIMITED']);
  assert.equal(JSON.stringify(report).includes(secret), false);
  const unavailable = await runDiyPreflight({ token: secret, now, fetcher: async () => { throw Error(secret); } });
  assert.ok(unavailable.results.every(row => row.error === 'ANALYTICS_UNAVAILABLE'));
  assert.equal(JSON.stringify(unavailable).includes(secret), false);
});

test('unrecognized response shape and invalid JSON reveal known field names only', async () => {
  const shape = inspectAggregate({ version: 2, query: body().query, data: { groups: [{ PRIVATE: secret }], PRIVATE_FIELD: secret } }, { window, event: EVENTS[0] });
  assert.equal(shape.error, 'PREFLIGHT_RESPONSE_SHAPE_UNVALIDATED'); assert.equal(shape.api_version, 2);
  assert.deepEqual(shape.known_data_fields, ['groups']); assert.equal(JSON.stringify(shape).includes(secret), false);
  const invalid = await runDiyPreflight({ token: secret, now, fetcher: async () => ({ ok: true, status: 200, json: async () => { throw Error(secret); } }) });
  assert.ok(invalid.results.every(row => row.error === 'ANALYTICS_INVALID_JSON'));
});

test('no secret means no network; fixed UTC date is not the Berlin calendar date', async () => {
  let called = false;
  const report = await runDiyPreflight({ token: '', now: new Date('2026-10-25T23:30:00Z'), fetcher: async () => { called = true; } });
  assert.equal(called, false); assert.equal(report.day, '2026-10-25'); assert.equal(report.status, 'not_configured');
});

test('strict public date echoes diagnose a mismatch without relaxing date acceptance or copying arbitrary text', () => {
  for (const [value, format] of [[day, 'utc_date'], ['2026-10-26T00:00:00Z','utc_iso'], ['2026-10-26T23:59:59.999999Z','utc_iso'], ['2026-10-26T03:00:00+00:00','utc_iso'], [Date.parse('2026-10-26T03:28:44.154Z'),'epoch_milliseconds_as_utc_iso']]) {
    const echo = safeQueryBound(value);
    assert.equal(echo.valid, true); assert.equal(echo.format, format);
  }
  for (const value of [secret, '2026-02-30', '2026-02-30T00:00:00Z', '2026-10-26T24:00:00Z', '2026-10-26T03:00:00+02:00', '2026-10-26T03:00:00Z PRIVATE', { value: secret }, 1727278251668513]) {
    const echo = safeQueryBound(value);
    assert.equal(echo.valid, false); assert.equal(Object.hasOwn(echo, 'value'), false);
    assert.equal(JSON.stringify(echo).includes(secret), false);
  }
  const mismatch = body(); mismatch.query.until = '2026-10-26T00:00:00.000Z';
  const result = inspectAggregate(mismatch, { window, event: EVENTS[0] });
  assert.equal(result.status, 'error'); assert.equal(result.query_checks.until, false);
  assert.deepEqual(result.query_bound_echo.until, { valid: true, format: 'utc_iso', value: '2026-10-26T00:00:00.000Z' });
  mismatch.query.until = secret;
  assert.equal(JSON.stringify(inspectAggregate(mismatch, { window, event: EVENTS[0] })).includes(secret), false);
});

test('only exact requested timestamps or precisely derived next-hour boundaries can pass', () => {
  for (const [until, mode] of [
    [window.until, 'exact_request'], [new Date(window.until).toISOString(), 'exact_request'],
    [window.rounded_until, 'derived_next_utc_hour'], [new Date(window.rounded_until).toISOString(), 'derived_next_utc_hour'],
  ]) {
    const value = body(); value.query.since = window.since; value.query.until = until;
    const result = inspectAggregate(value, { window, event: EVENTS[0] });
    assert.equal(result.status, 'aggregate_read_validated'); assert.equal(result.query_checks.until_mode, mode);
  }
  for (const until of [day, '2026-10-26T01:00:00Z', '2026-10-26T03:00:00Z', '2026-10-26T12:00:00Z', '2026-10-27T00:00:00Z', '2026-10-26T02:00:00.000000001Z']) {
    const value = body(); value.query.until = until;
    const result = inspectAggregate(value, { window, event: EVENTS[0] });
    assert.equal(result.error, 'PREFLIGHT_QUERY_MISMATCH'); assert.equal(result.query_checks.until, false);
    assert.deepEqual(result.rows, []);
  }
  const wrongSince = body(); wrongSince.query.since = '2026-10-26T00:00:00.000000001Z';
  assert.equal(inspectAggregate(wrongSince, { window, event: EVENTS[0] }).error, 'PREFLIGHT_QUERY_MISMATCH');
});

test('UTC midnight, inclusive hour boundary and post-deployment current moment are explicit', async () => {
  const afterDeploy = new Date('2026-10-26T03:52:41.400Z'), activeWindow = requestedWindow(afterDeploy);
  assert.equal(new Date(activeWindow.since).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(activeWindow.until, afterDeploy.getTime());
  assert.equal(new Date(activeWindow.rounded_until).toISOString(), '2026-10-26T04:00:00.000Z');
  let calls = 0;
  const report = await runDiyPreflight({ token: secret, now: afterDeploy, fetcher: async url => {
    calls++;
    assert.equal(new URL(url).searchParams.get('until'), String(afterDeploy.getTime()));
    const event = EVENTS[calls - 1];
    const value = body(event, []); value.query.until = '2026-10-26T04:00:00Z';
    return Response.json(value);
  } });
  assert.equal(calls, 4); assert.equal(report.status, 'awaiting_events'); assert.equal(report.event_reception_proven, false);
  assert.equal(report.requested_window.until_utc, '2026-10-26T03:52:41.400Z');
  const late = requestedWindow(new Date('2026-10-25T23:30:00Z'));
  assert.equal(late.day, '2026-10-25'); assert.equal(new Date(late.rounded_until).toISOString(), '2026-10-26T00:00:00.000Z');
  const exactly = requestedWindow(new Date('2026-10-26T03:00:00Z'));
  assert.equal(new Date(exactly.rounded_until).toISOString(), '2026-10-26T04:00:00.000Z');
});

test('workflow is manual-only, contents-read, main/repository gated, secret only in read step', async () => {
  const workflow = await readFile(new URL('../.github/workflows/diy-funnel-preflight.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /\bschedule:|\bpush:|\bpull_request:/);
  assert.match(workflow, /contents: read/); assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/); assert.match(workflow, /github\.repository == 'Niko76x\/chatline-pulse'/);
  assert.equal((workflow.match(/secrets\./g) || []).length, 1);
  assert.ok(workflow.indexOf('secrets.') > workflow.indexOf('Read exactly four approved Production aggregates'));
  assert.match(workflow, /persist-credentials: false/);
});
