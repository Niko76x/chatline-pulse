import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { refreshSources, mergeAnalytics, ANALYTICS_PROJECTS, canSkipCollection, validateSnapshot } from '../api/data.js';
import { ADS, EVENTS } from '../scripts/diy-funnel-preflight.mjs';
import { trackingContract } from '../lib/tracking-contracts.mjs';
const now = new Date('2026-10-26T04:07:00.000Z'), slot = '2026-10-26T04:00:00.000Z';
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
const id = Object.keys(ADS)[0];
const tokens = { 'chatline.app': 'fixture-site-token', 'start.chatline.app': 'fixture-diy-token' };
function core() {
  return mergeAnalytics(original, ANALYTICS_PROJECTS.map(project => ({ site: project.site, label: project.label,
    status: 'connected', observed_at: now.toISOString(), attempted_at: now.toISOString(), error: null, timezone: 'UTC', daily: [] })), { now, slot });
}
function eventReply(url, withSignal = false) {
  const event = EVENTS.find(value => url.searchParams.get('filter').includes(`'${value}'`));
  assert.ok(event);
  const contract=['original','traffic','crm','lookalike'].map(trackingContract).find(value=>url.searchParams.get('filter').includes(value.campaign));
  return { ok: true, status: 200, json: async () => ({ version: 1, query: {
    since: Number(url.searchParams.get('since')), until: Number(url.searchParams.get('until')),
    filter: url.searchParams.get('filter'), groupBy: ['eventData/ad_id'], limit: 32 },
    data: withSignal && event === EVENTS[0] ? [{ eventData: Object.keys(contract.ads)[0], count: 2, visitors: 1 }] : [] }) };
}
test('new DIY gate in completed core slot performs four event GETs per campaign only, empty reads are awaiting_events', async () => {
  const previous = core(), requests = [];
  assert.equal(canSkipCollection(previous, { slot, now, diyFunnelEnabled: true }), false);
  const result = await refreshSources(previous, { slot, now, diyFunnelEnabled: true,
    analyticsOptions: { tokens, fetcher: async (url, init) => {
      requests.push(url.href); assert.equal(url.pathname, '/v1/query/web-analytics/events/aggregate');
      assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, 'Bearer fixture-diy-token');
      return eventReply(url);
    } } });
  assert.equal(requests.length, 16); assert.equal(result.success, true);
  assert.equal(result.snapshot.sources.diy_funnel.status, 'awaiting_events');
  assert.deepEqual(result.snapshot.sources.diy_funnel.daily, []);
  for (const key of ['meta', 'analytics', 'website_events']) assert.deepEqual(result.snapshot.sources[key], previous.sources[key]);
  assert.equal(canSkipCollection(result.snapshot, { slot, now, diyFunnelEnabled: true }), true);
  await refreshSources(result.snapshot, { slot, now, diyFunnelEnabled: true, analyticsOptions: { tokens, fetcher: async () => { throw Error('same-slot read forbidden'); } } });
  assert.equal(requests.length, 16); validateSnapshot(result.snapshot);
});
test('DIY-positive aggregate remains ad/date-specific product events, never attributed Meta leads or payments', async () => {
  const previous = core();
  const result = await refreshSources(previous, { slot, now, diyFunnelEnabled: true, analyticsOptions: { tokens, fetcher: async url => eventReply(url, true) } });
  const source = result.snapshot.sources.diy_funnel;
  assert.equal(source.status, 'connected');
  assert.deepEqual(source.daily, [{ date: '2026-10-26', code: ADS[id], studio_started: 2, call_requested: null, checkout_started: null, dashboard_activated: null }]);
  assert.equal(source.collection_started_at, '2026-10-26T02:30:39Z');
  assert.deepEqual(result.snapshot.sources.meta, previous.sources.meta);
  const bad = structuredClone(result.snapshot); bad.sources.diy_funnel.raw_url = 'https://private.invalid';
  assert.throws(() => validateSnapshot(bad), /SNAPSHOT|DIY/);
});
test('DIY access failure remains optional, isolated and one attempt per slot; unknown is not a zero', async () => {
  const previous = core(); let calls = 0;
  const result = await refreshSources(previous, { slot, now, diyFunnelEnabled: true, analyticsOptions: { tokens, fetcher: async () => {
    calls++; return { ok: false, status: 403, json: async () => { throw Error('PRIVATE body must not be inspected'); } };
  } } });
  assert.equal(result.success, true); assert.deepEqual(result.warnings, ['DIY_FUNNEL_READ_FAILED']);
  assert.equal(result.snapshot.sources.diy_funnel.status, 'error'); assert.equal(result.snapshot.sources.diy_funnel.observed_at, null);
  assert.deepEqual(result.snapshot.sources.diy_funnel.daily, []); assert.equal(result.snapshot.sources.diy_funnel.period, null);
  assert.ok(calls >= 1 && calls <= 4);
  for (const key of ['meta', 'analytics', 'website_events']) assert.deepEqual(result.snapshot.sources[key], previous.sources[key]);
  assert.equal(canSkipCollection(result.snapshot, { slot, now, diyFunnelEnabled: true }), true);
  assert.equal(JSON.stringify(result.snapshot.sources.diy_funnel).includes('PRIVATE'), false);
});
test('optional gates default off; normal core analytics read cannot accidentally add either source', async () => {
  const result = await refreshSources(original, { slot, now, analyticsOptions: { tokens, fetcher: async url => {
    assert.equal(url.pathname, '/v1/query/web-analytics/visits/aggregate');
    return { ok: true, status: 200, json: async () => ({ version: 1, query: { since: '2026-10-22', until: '2026-10-26', groupBy: ['day'], filter: "environment eq 'production'" }, data: [] }) };
  } } });
  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(result.snapshot.sources, 'diy_funnel'), false); assert.equal(Object.hasOwn(result.snapshot.sources, 'link_audit'), false);
  assert.equal(Object.hasOwn(result.snapshot.sources, 'diy_funnel_traffic'), false); assert.equal(Object.hasOwn(result.snapshot.sources, 'link_audit_traffic'), false);
  for(const key of ['diy_funnel_crm','link_audit_crm','diy_funnel_lookalike','link_audit_lookalike']) assert.equal(Object.hasOwn(result.snapshot.sources,key),false);
});
