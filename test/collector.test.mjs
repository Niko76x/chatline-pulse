import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ANALYTICS_PROJECTS } from '../api/data.js';
import { assertConfiguredSources, refreshSources } from '../api/data.js';
import { canSkipCollection } from '../api/data.js';
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-25T18:07:00.000Z'), slot = '2026-10-25T18:00:00.000Z';
const tokens = { 'chatline.app': 'fixture-website-token', 'start.chatline.app': 'fixture-diy-token' };
const analyticsOptions = { tokens, fetcher: async url => {
  assert.equal(url.origin, 'https://api.vercel.com');
  assert.ok(ANALYTICS_PROJECTS.some(p => p.projectId === url.searchParams.get('projectId')));
  assert.equal(url.searchParams.get('filter'), "environment eq 'production'");
  assert.equal(url.searchParams.has('requestHostname'), false);
  return { ok: true, json: async () => ({ version:1, query:{ since:'2026-10-22', until:'2026-10-25', groupBy:['day'], filter:"environment eq 'production'" }, data:[{ timestamp:'2026-10-25T00:00:00Z',visitors:2,pageviews:4 }] }) };
} };
test('Analytics-only collection succeeds while disabled Meta and Dataset remain byte-for-byte unchanged', async () => {
  let metaReads=0;
  const result = await refreshSources(original,{now,slot,analyticsOptions,metaOptions:{ fetcher:async()=>{metaReads++;throw new Error('must not read Meta');} }});
  assert.equal(result.success,true);assert.equal(metaReads,0);
  assert.deepEqual(result.snapshot.sources.meta,original.sources.meta);
  assert.deepEqual(result.snapshot.sources.website_events,original.sources.website_events);
  assert.equal(result.snapshot.sources.analytics.status,'connected');
  assert.equal(result.snapshot.collected_at,now.toISOString());
  assert.equal(canSkipCollection(result.snapshot,{slot,now,metaEnabled:false}),true);
  assert.match(result.snapshot.sources.analytics.sites[0].label,/mindbody-home\.chatline\.app/);
});
test('enabled Meta without auth fails only its own source while Analytics may still publish independently', async () => {
  const result=await refreshSources(original,{now,slot,metaEnabled:true,analyticsOptions});
  assert.equal(result.success,false);
  assert.equal(result.snapshot.sources.meta.status,'error');
  assert.equal(result.snapshot.sources.meta.observed_at,original.sources.meta.observed_at);
  assert.equal(result.snapshot.sources.analytics.status,'connected');
  assert.deepEqual(result.snapshot.sources.website_events,original.sources.website_events);
});
test('zero enabled configured sources are rejected before any read or pretend-success snapshot', async () => {
  let reads=0;
  assert.throws(()=>assertConfiguredSources(),/NO_ENABLED_CONFIGURED_SOURCE/);
  assert.throws(()=>assertConfiguredSources({metaEnabled:true,metaOptions:{}}),/NO_ENABLED_CONFIGURED_SOURCE/);
  await assert.rejects(refreshSources(original,{now,slot,analyticsOptions:{fetcher:async()=>{reads++;}}}),/NO_ENABLED_CONFIGURED_SOURCE/);
  assert.equal(reads,0);
  assert.equal(original.collected_at,'2026-10-25T14:17:21.414Z');
});
