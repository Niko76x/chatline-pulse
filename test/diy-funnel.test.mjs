import assert from 'node:assert/strict';
import test from 'node:test';
import { collectDiyFunnel, validateDiyFunnelSource, mergeDiyFunnel, DiyFunnelError,
  COLLECTION_STARTED_AT, SOURCE_CODE, REQUEST_TIMEOUT_MS, TOTAL_TIMEOUT_MS, RETENTION_DAYS } from '../lib/diy-funnel.mjs';

const token = 'FIXTURE_TOKEN_NEVER_OUTPUT', privateValue = 'PRIVATE_VALUE_NEVER_OUTPUT';
const project = 'prj_cKWblSdgOD2QY0tUExAkoqB3Z5jH', team = 'team_i2XlerNOfSTLE5EGj65B1vau';
const campaign = '120274644271350555', ad1 = '120275421779180555', ad2 = '120275421929330555';
const metrics = ['studio_started','call_requested','checkout_started','dashboard_activated'];
const now = new Date('2026-10-26T04:06:28.321Z');
const responseBody = (url, data = []) => {
  const params = new URL(url).searchParams, since = Number(params.get('since')), until = Number(params.get('until'));
  return { version: 1, query: { since: new Date(since).toISOString(),
    until: new Date(Math.floor(until / 3600000) * 3600000 + 3600000).toISOString(),
    filter: params.get('filter'), groupBy: ['eventData/ad_id'], limit: 32 }, data };
};
const reply = (url, data = []) => ({ ok: true, status: 200, json: async () => responseBody(url, data) });
const row = (date, code, values = {}) => ({ date, code, ...Object.fromEntries(metrics.map(key => [key, null])), ...values });
const source = ({ date = '2026-10-26', at = `${date}T04:06:28.321Z`, from = date, rows = [], status = rows.length ? 'connected' : 'awaiting_events' } = {}) => ({
  source_code: SOURCE_CODE, site: 'start.chatline.app', campaign, timezone: 'UTC', collection_started_at: COLLECTION_STARTED_AT,
  status, observed_at: at, attempted_at: at, period: { from, to: date }, daily: rows, error: null,
});
const codeIs = code => error => error instanceof DiyFunnelError && error.code === code && error.message === code;

test('observed empty-v1 shape produces awaiting_events with four fixed scoped GETs and no invented rows', async () => {
  const calls = [];
  const result = await collectDiyFunnel({ token, now, fetcher: async (url, options) => { calls.push({ url: new URL(url), options }); return reply(url); } });
  assert.equal(calls.length, 4); assert.equal(result.status, 'awaiting_events'); assert.deepEqual(result.daily, []);
  assert.equal(result.collection_started_at, '2026-10-26T02:30:39Z'); assert.equal(result.observed_at, now.toISOString());
  assert.deepEqual(result.period, { from: '2026-10-26', to: '2026-10-26' });
  for (const { url, options } of calls) {
    assert.equal(url.origin, 'https://api.vercel.com'); assert.equal(url.pathname, '/v1/query/web-analytics/events/aggregate');
    assert.equal(url.searchParams.get('projectId'), project); assert.equal(url.searchParams.get('teamId'), team);
    assert.equal(url.searchParams.get('by'), 'eventData/ad_id'); assert.equal(url.searchParams.get('limit'), '32');
    assert.equal(Number(url.searchParams.get('until')), now.getTime());
    assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.equal(options.redirect, 'error');
    assert.equal(options.signal instanceof AbortSignal, true);
  }
  assert.equal(JSON.stringify(result).includes(token), false); assert.equal(validateDiyFunnelSource(result), result);
});

test('current plus previous UTC day only; no day before instrumentation and max eight reads', async () => {
  for (const [at, expectedDays] of [
    ['2026-10-26T23:59:59Z', ['2026-10-26']],
    ['2026-10-27T00:00:00Z', ['2026-10-26','2026-10-27']],
    ['2026-10-28T03:30:00Z', ['2026-10-27','2026-10-28']],
  ]) {
    const calls = [], clock = new Date(at);
    const result = await collectDiyFunnel({ token, now: clock, fetcher: async url => { calls.push(new URL(url)); return reply(url); } });
    assert.equal(calls.length, expectedDays.length * 4);
    assert.deepEqual([...new Set(calls.map(url => new Date(Number(url.searchParams.get('since'))).toISOString().slice(0,10)))], expectedDays);
    if (expectedDays.length === 2) assert.equal(Number(calls[0].searchParams.get('until')), Date.parse(`${expectedDays[0]}T23:59:59.999Z`));
    assert.deepEqual(result.period, { from: expectedDays[0], to: expectedDays.at(-1) });
  }
  let called = false;
  await assert.rejects(collectDiyFunnel({ token, now: new Date('2026-10-26T01:00:00Z'), fetcher: async () => { called = true; } }), codeIs('DIY_COLLECTION_NOT_STARTED'));
  assert.equal(called, false);
});

test('documented explicit ad rows map only their counts; omitted steps/codes stay null/absent', async () => {
  const result = await collectDiyFunnel({ token, now, fetcher: async url => {
    const filter = new URL(url).searchParams.get('filter');
    const data = filter.includes("eventName eq 'diy_studio_started'") ? [{ eventData: ad1, count: 3, visitors: 2 }]
      : filter.includes("eventName eq 'diy_checkout_started'") ? [{ eventData: ad1, count: 0, visitors: 0 }, { eventData: ad2, count: 1, visitors: 1 }] : [];
    return reply(url, data);
  } });
  assert.equal(result.status, 'connected'); assert.equal(result.daily.length, 2);
  assert.deepEqual(result.daily[0], row('2026-10-26','PIL-PA-01',{ studio_started: 3, checkout_started: 0 }));
  assert.deepEqual(result.daily[1], row('2026-10-26','PIL-PA-03',{ checkout_started: 1 }));
  assert.equal(JSON.stringify(result).includes('visitors'), false); assert.equal(JSON.stringify(result).includes(ad1), false);
});

test('unknown positive shape, arbitrary fields, wrong ad or metric never become a successful count', async () => {
  for (const [data, expected] of [
    [[{ eventData: { ad_id: ad1 }, count: 1, visitors: 1 }], 'DIY_RESPONSE_INVALID'],
    [[{ eventData: ad1, count: 1, visitors: 1, email: privateValue }], 'DIY_RESPONSE_INVALID'],
    [[{ eventData: privateValue, count: 1, visitors: 1 }], 'DIY_SCOPE_MISMATCH'],
    [[{ eventData: ad1, count: '1', visitors: 1 }], 'DIY_METRIC_INVALID'],
  ]) {
    let calls = 0;
    await assert.rejects(collectDiyFunnel({ token, now, fetcher: async url => { calls++; return reply(url, data); } }), error => codeIs(expected)(error) && !JSON.stringify(error).includes(privateValue));
    assert.equal(calls, 1, 'Do not retry or publish a partial successful prefix');
  }
});

test('query mismatch and a later request failure reject the entire source result', async () => {
  await assert.rejects(collectDiyFunnel({ token, now, fetcher: async url => {
    const value = responseBody(url); value.query.until = '2026-10-26T12:00:00Z';
    return { ok: true, status: 200, json: async () => value };
  } }), codeIs('DIY_QUERY_MISMATCH'));
  let calls = 0;
  await assert.rejects(collectDiyFunnel({ token, now: new Date('2026-10-27T04:00:00Z'), fetcher: async url => {
    calls++; return calls === 5 ? { ok: false, status: 403 } : reply(url, [{ eventData: ad1, count: 1, visitors: 1 }]);
  } }), codeIs('DIY_PERMISSION_REQUIRED'));
  assert.equal(calls, 5);
});

test('success merge replaces refreshed dates, preserves older observations, and never fills absent steps with zero', () => {
  const previous = source({ date:'2026-10-27',from:'2026-10-26',rows:[
    row('2026-10-26','PIL-PA-01',{ studio_started: 4 }), row('2026-10-27','PIL-PA-01',{ studio_started: 2, call_requested: 9 }),
  ] });
  const fresh = source({ date:'2026-10-28',from:'2026-10-27',rows:[row('2026-10-27','PIL-PA-01',{ studio_started: 3 })] });
  const merged = mergeDiyFunnel(previous,fresh,{now:new Date(fresh.attempted_at)});
  assert.deepEqual(merged.daily[0],previous.daily[0]); assert.equal(merged.daily[1].call_requested,null);
  assert.deepEqual(merged.period,{from:'2026-10-26',to:'2026-10-28'}); assert.equal(merged.observed_at,fresh.observed_at);
  assert.equal(previous.daily[1].call_requested,9,'Never mutate the prior snapshot');
  const emptied = mergeDiyFunnel(source({rows:[row('2026-10-26','PIL-PA-01',{studio_started:1})]}),source(),{now});
  assert.equal(emptied.status,'awaiting_events'); assert.deepEqual(emptied.daily,[]);
});

test('error merge preserves all prior data/period/observed time and sanitizes unknown error strings', () => {
  const old = source({rows:[row('2026-10-26','PIL-PA-01',{studio_started:2})]});
  const at = new Date('2026-10-27T04:00:00Z');
  const result = mergeDiyFunnel(old,null,{now:at,error:privateValue});
  assert.equal(result.status,'error'); assert.equal(result.error,'DIY_READ_FAILED');
  assert.equal(result.observed_at,old.observed_at); assert.deepEqual(result.period,old.period); assert.deepEqual(result.daily,old.daily);
  assert.equal(result.attempted_at,at.toISOString()); assert.equal(JSON.stringify(result).includes(privateValue),false);
  const first = mergeDiyFunnel(undefined,null,{now,error:'DIY_TIMEOUT'});
  assert.equal(first.period,null); assert.equal(first.observed_at,null); assert.deepEqual(first.daily,[]); assert.equal(first.error,'DIY_TIMEOUT');
});

test('technical 366-day retention trims successful history but does not advance observation on an error', () => {
  assert.equal(RETENTION_DAYS,366);
  const previous = source({date:'2027-10-26',from:'2026-10-26',rows:[
    row('2026-10-26','PIL-PA-01',{studio_started:7}), row('2026-10-27','PIL-PA-03',{studio_started:2}),
  ]});
  const fresh = source({date:'2027-10-27',from:'2027-10-26'});
  const result = mergeDiyFunnel(previous,fresh,{now:new Date(fresh.attempted_at)});
  assert.deepEqual(result.period,{from:'2026-10-27',to:'2027-10-27'});
  assert.deepEqual(result.daily,[previous.daily[1]]);
  const failed = mergeDiyFunnel(previous,null,{now:new Date('2027-10-27T04:00:00Z'),error:'DIY_UNAVAILABLE'});
  assert.deepEqual(failed.daily,previous.daily); assert.deepEqual(failed.period,previous.period); assert.equal(failed.observed_at,previous.observed_at);
});

test('source validator rejects private fields, foreign scope, invalid counts/period and fake unknown rows', () => {
  const good = source({rows:[row('2026-10-26','PIL-PA-01',{studio_started:1})]});
  const invalid = [
    {...good,access_token:token}, {...good,campaign:'OTHER'}, {...good,daily:[row('2026-10-26','PIL-PA-01')]},
    {...good,daily:[row('2026-10-26','PIL-PA-01',{studio_started:-1})]},
    {...good,daily:[{...good.daily[0],phone:privateValue}]}, {...good,daily:[row('2026-10-26','OTHER',{studio_started:1})]},
    {...good,period:{from:'2026-10-25',to:'2026-10-26'}},
    source({date:'2027-10-27',from:'2026-10-26'}),
  ];
  for (const value of invalid) assert.throws(()=>validateDiyFunnelSource(value),codeIs('DIY_SOURCE_INVALID'));
});

test('no configured token means no request and no environment/token fallback', async () => {
  let called = false;
  await assert.rejects(collectDiyFunnel({now,fetcher:async()=>{called=true;}}),codeIs('DIY_NOT_CONFIGURED'));
  assert.equal(called,false);
});

test('per-request timeout also bounds a fetcher that ignores AbortSignal', async t => {
  const waits = []; let aborted = false, calls = 0;
  t.mock.method(globalThis,'setTimeout',(callback, milliseconds)=>{waits.push(milliseconds);queueMicrotask(callback);return 1;});
  t.mock.method(globalThis,'clearTimeout',()=>{});
  await assert.rejects(collectDiyFunnel({token,now,fetcher:async(_url,options)=>{
    calls++; options.signal.addEventListener('abort',()=>{aborted=true;}); return new Promise(()=>{});
  }}),codeIs('DIY_TIMEOUT'));
  assert.equal(calls,1); assert.equal(aborted,true); assert.equal(waits[0],REQUEST_TIMEOUT_MS);
});

test('total monotonic deadline prevents additional requests even when preceding reads succeeded', async t => {
  let clock = 0, calls = 0;
  t.mock.method(performance,'now',()=>clock+=30000);
  await assert.rejects(collectDiyFunnel({token,now,fetcher:async url=>{calls++;return reply(url);}}),codeIs('DIY_TIMEOUT'));
  assert.equal(calls,1); assert.equal(TOTAL_TIMEOUT_MS,55000);
});
