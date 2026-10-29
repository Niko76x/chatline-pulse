import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PROJECT, TEAM, ENDPOINT, EVENTS, runDiyVolumePreflight, requestedWindow } from '../scripts/diy-funnel-preflight.mjs';
import { trackingContract } from '../lib/tracking-contracts.mjs';

const now = new Date('2026-10-29T10:25:30.300Z');
const since = Date.parse('2026-10-26T00:00:00Z');
const window = requestedWindow(now);
const secret = 'FIXTURE_SECRET_NEVER_RETURN';
const campaigns = ['original','traffic','crm','lookalike'].map(key => ({ key, campaign: trackingContract(key).campaign }));
const filter = event => `environment eq 'production' and eventName eq '${event}'`;
const row = (key = 'crm', count = 3, visitors = 2) => ({ eventData: trackingContract(key).campaign, count, visitors });
const body = (event, data = [row()]) => ({ version: 1,
  query: { since: '2026-10-26T00:00:00Z', until: new Date(window.rounded_until).toISOString(),
    filter: filter(event), groupBy: ['eventData/campaign_id'], limit: 32 }, data });
async function inspectChange(change, rows = [row()]) {
  let calls = 0;
  return runDiyVolumePreflight({ token: secret, now, fetcher: async () => {
    const value = body(EVENTS[calls++], rows); change(value);
    return Response.json(value);
  } });
}

test('exactly four fixed-project read GETs and four approved campaign groups; no arbitrary selection or secrets', async () => {
  const calls = [];
  const report = await runDiyVolumePreflight({ token: secret, now, fetcher: async (url, options) => {
    const i = calls.length; calls.push({ url: new URL(url), options });
    return Response.json(body(EVENTS[i], campaigns.map(({ campaign }, n) => ({ eventData: campaign, count: n + 1, visitors: 1,
      projectId: PROJECT, environment: 'production', eventName: EVENTS[i], timestamp: '2026-10-28T12:00:00Z' }))));
  } });
  assert.equal(calls.length, 4);
  for (const [i,call] of calls.entries()) {
    assert.equal(call.url.origin + call.url.pathname, ENDPOINT);
    assert.deepEqual([...call.url.searchParams.keys()].sort(), ['projectId','teamId','since','until','by','limit','filter'].sort());
    assert.equal(call.url.searchParams.get('projectId'), PROJECT); assert.equal(call.url.searchParams.get('teamId'), TEAM);
    assert.equal(call.url.searchParams.get('since'), String(since)); assert.equal(call.url.searchParams.get('until'), String(now.getTime()));
    assert.equal(call.url.searchParams.get('by'), 'eventData/campaign_id'); assert.equal(call.url.searchParams.get('limit'), '32');
    assert.equal(call.url.searchParams.get('filter'), filter(EVENTS[i])); assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(call.url.href.includes(secret), false);
  }
  assert.equal(report.status, 'aggregate_reads_validated'); assert.equal(report.event_reception_proven, true);
  assert.equal(report.approved_campaign_reception_proven, true); assert.equal(report.run_join_performed, false);
  assert.equal(report.snapshot_written, false); assert.equal(report.published, false); assert.equal(report.events_generated, false);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(report.results[0].rows, campaigns.map(({ key,campaign }, n) => ({ campaign_key: key,campaign_id: campaign,count:n + 1,visitors:1 })));
});

test('empty successful arrays are awaiting_events without fabricated campaign zeros or reception', async () => {
  const report = await inspectChange(() => {}, []);
  assert.equal(report.status, 'awaiting_events'); assert.equal(report.event_reception_proven, false);
  assert.equal(report.approved_campaign_reception_proven, false);
  for (const result of report.results) {
    assert.deepEqual(result.rows, []); assert.equal(result.status, 'awaiting_events');
    assert.equal(result.redacted_unmapped_groups, 0); assert.equal(result.redacted_unmapped_event_count, 0);
    assert.equal(Object.hasOwn(result,'observed_at'), false);
  }
});

test('unknown campaign and Others are counted only as redacted unmapped totals; values never escape', async () => {
  const report = await inspectChange(() => {}, [{ eventData:'PRIVATE_UNMAPPED_CAMPAIGN',count:7,visitors:2 }, { eventData:'Others',count:9,visitors:4 }]);
  assert.equal(report.status, 'aggregate_reads_validated'); assert.equal(report.event_reception_proven, true);
  assert.equal(report.approved_campaign_reception_proven, false);
  for (const result of report.results) {
    assert.deepEqual(result.rows, []); assert.equal(result.redacted_unmapped_groups, 2); assert.equal(result.redacted_unmapped_event_count, 16);
  }
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_UNMAPPED|Others/);
});

test('query scope, property grouping, limit and extra fields fail closed without echoing values', async () => {
  for (const replacement of [
    {filter:'PRIVATE_QUERY'}, {filter:`eventName eq '${EVENTS[0]}'`}, {groupBy:['eventData/ad_id']}, {groupBy:[]},
    {limit:33}, {limit:null}, {since:'2026-10-25'}, {until:'2026-10-29T12:00:00Z'}, {PRIVATE_FIELD:'PRIVATE_QUERY'},
  ]) {
    const report = await inspectChange(value => { Object.assign(value.query,replacement); });
    assert.equal(report.status,'failed'); assert.ok(report.results.every(v=>v.error==='PREFLIGHT_QUERY_MISMATCH'));
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_QUERY|PRIVATE_FIELD/);
  }
});

test('only exact or derived next-hour until echoes and exact historical start are accepted', async () => {
  for (const until of [now.getTime(),now.toISOString(),window.rounded_until,new Date(window.rounded_until).toISOString()]) {
    const report=await inspectChange(value=>{value.query.until=until;value.query.since=since;});
    assert.equal(report.status,'aggregate_reads_validated');
  }
  for (const until of ['2026-10-29','2026-10-29T10:00:00Z','2026-10-29T11:00:00.000000001Z']) {
    const report=await inspectChange(value=>{value.query.until=until;});
    assert.equal(report.status,'failed'); assert.ok(report.results.every(v=>v.error==='PREFLIGHT_QUERY_MISMATCH'));
  }
});

test('pagination, unknown envelope, nonflat rows and excess results are rejected with no data leakage', async () => {
  for (const change of [
    value=>{value.pagination={next:'PRIVATE_NEXT'};}, value=>{value.paging={};},value=>{value.nextPage='PRIVATE_NEXT';},
    value=>{value.PRIVATE_TOP='PRIVATE_VALUE';},value=>{value.version=2;},value=>{value.data={PRIVATE_DATA:'PRIVATE_VALUE'};},
    value=>{value.data[0].eventData={campaign_id:campaigns[0].campaign};},value=>{value.data[0].PRIVATE_ROW='PRIVATE_VALUE';},
    value=>{value.data=Array.from({length:33},(_,i)=>({eventData:`PRIVATE_${i}`,count:1,visitors:1}));},
  ]) {
    const report=await inspectChange(change);
    assert.equal(report.status,'failed'); assert.ok(report.results.every(v=>v.rows.length===0));
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_(NEXT|TOP|VALUE|DATA|ROW|\d)/);
  }
});

test('wrong project/environment/event, duplicate campaigns, invalid private group strings remain rejected', async () => {
  for(const rows of [
    [{...row(),projectId:'PRIVATE_PROJECT'}],[{...row(),environment:'preview'}],[{...row(),eventName:'PRIVATE_EVENT'}],
    [row(),row()],[{eventData:'PRIVATE_DUP',count:1,visitors:1},{eventData:'PRIVATE_DUP',count:1,visitors:1}],
    [{...row(),eventData:''}],[{...row(),eventData:'PRIVATE'.repeat(100)}],
  ]) {
    const report=await inspectChange(()=>{},rows);
    assert.equal(report.status,'failed'); assert.ok(report.results.every(v=>v.error==='PREFLIGHT_SCOPE_MISMATCH'));
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_PROJECT|PRIVATE_EVENT|PRIVATE_DUP|PRIVATEPRIVATE/);
  }
});

test('invalid counts/visitors and unmapped sum overflow fail instead of rounding or coercion', async () => {
  for(const rows of [
    [{...row(),count:'3'}],[{...row(),count:-1}],[{...row(),visitors:4}],[{eventData:campaigns[0].campaign,count:1}],
    [{...row(),count:1.5}],[{eventData:'PRIVATE_1',count:Number.MAX_SAFE_INTEGER,visitors:1},{eventData:'PRIVATE_2',count:1,visitors:1}],
  ]) {
    const report=await inspectChange(()=>{},rows);
    assert.equal(report.status,'failed'); assert.ok(report.results.every(v=>v.error==='PREFLIGHT_METRIC_SHAPE_UNVALIDATED'));
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_[12]/);
  }
});

test('out-of-window and invalid timestamp values fail without leaking their text', async () => {
  for(const timestamp of ['2026-10-25T23:59:59.999Z','2026-10-29T11:00:00.001Z','PRIVATE_TIMESTAMP','2026-02-30T00:00:00Z']) {
    const report=await inspectChange(()=>{},[{...row(),timestamp}]);
    assert.equal(report.status,'failed');assert.ok(report.results.every(v=>v.error==='PREFLIGHT_PERIOD_MISMATCH'));
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_TIMESTAMP/);
  }
});

test('HTTP, exception and JSON errors are sanitized; no response body or secret is echoed and no retries', async () => {
  let calls=0,parsed=0;
  const report=await runDiyVolumePreflight({token:secret,now,fetcher:async()=>({ok:false,status:[401,403,402,429][calls++],json:async()=>{parsed++;throw Error(secret);}})});
  assert.equal(calls,4);assert.equal(parsed,0);assert.equal(report.status,'failed');
  assert.deepEqual(report.results.map(v=>v.error),['ANALYTICS_LOGIN_REQUIRED','ANALYTICS_PERMISSION_REQUIRED','ANALYTICS_PLAN_REQUIRED','ANALYTICS_RATE_LIMITED']);
  for(const fetcher of [async()=>{throw Error(secret);},async()=>({ok:true,status:200,json:async()=>{throw Error(secret);}})]) {
    const failed=await runDiyVolumePreflight({token:secret,now,fetcher});assert.equal(failed.status,'failed');
    assert.equal(JSON.stringify(failed).includes(secret),false);
  }
});

test('no credential or pre-start window causes no network; workflow remains unchanged and manual read-only', async () => {
  let calls=0;const fetcher=async()=>{calls++;throw Error(secret);};
  for(const token of ['',undefined,'x'.repeat(4097)])assert.equal((await runDiyVolumePreflight({token,now,fetcher})).status,'not_configured');
  assert.equal((await runDiyVolumePreflight({token:secret,now:new Date('2026-10-25T23:00:00Z'),fetcher})).status,'failed');
  assert.equal(calls,0);
  const script=await readFile(new URL('../scripts/diy-funnel-preflight.mjs',import.meta.url),'utf8');
  assert.match(script,/const result = await runDiyVolumePreflight\(\{ token: process\.env\.VERCEL_ANALYTICS_LIMITLESS_TOKEN \}\)/);
  const workflow=await readFile(new URL('../.github/workflows/diy-funnel-preflight.yml',import.meta.url),'utf8');
  assert.match(workflow,/contents: read/);assert.doesNotMatch(workflow,/schedule:|contents: write/);
  assert.equal((workflow.match(/secrets\./g)||[]).length,1);assert.match(workflow,/Read exactly four approved Production aggregates/);
});
