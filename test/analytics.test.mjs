import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ANALYTICS_PROJECTS } from '../api/data.js';
import { analyticsPeriod, createAnalyticsReader, collectWebAnalytics, normalizeAnalytics } from '../api/data.js';
import { mergeAnalytics, mergeMeta, validateSnapshot, canSkipCollection } from '../api/data.js';
import { analyticsView } from './model.mjs';
const now = new Date('2026-10-25T18:00:00.000Z');
const projects = [{ site: 'chatline.app', projectId: 'prj_fixtureWebsite', teamId: 'team_fixture' }, { site: 'start.chatline.app', projectId: 'prj_fixtureDIY' }];
const period = analyticsPeriod(now);
const body = rows => ({ version: 1, query: { since: period.from, until: period.to, groupBy: ['day'], filter: "environment eq 'production'" }, data: rows });
const day = (date = '2026-10-25', visitors = 3, pageviews = 4) => ({ timestamp: date + 'T00:00:00.000Z', visitors, pageviews });
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));

test('production analytics allowlist is empty: even a token cannot trigger a project read', async () => {
  assert.equal(ANALYTICS_PROJECTS.length, 0);
  let reads = 0;
  const result = await collectWebAnalytics({ token: 'test-only', now, fetcher: async () => { reads++; } });
  assert.equal(reads, 0);
  assert.deepEqual(result.map(s => [s.site, s.status, s.observed_at]), [['chatline.app', 'not_connected', null], ['start.chatline.app', 'not_connected', null]]);
});
test('fixture configuration permits only the two separate verified-style ChatLine projects', () => {
  assert.throws(() => createAnalyticsReader({ token: 'test-only' }, [{ site: 'other.example', projectId: 'prj_fixture' }]), /ANALYTICS_SCOPE_INVALID/);
  assert.throws(() => createAnalyticsReader({ token: 'test-only' }, [projects[0], { ...projects[1], projectId: projects[0].projectId }]), /ANALYTICS_SCOPE_INVALID/);
  assert.throws(() => createAnalyticsReader({ token: 'test-only' }, [{ ...projects[0], url: 'https://other.example' }]), /ANALYTICS_SCOPE_INVALID/);
});
test('the reader uses only the official endpoint, fixed project/team, daily production aggregates and bearer header', async () => {
  let reads = 0;
  const read = createAnalyticsReader({ token: 'test-only', now, fetcher: async (url, options) => {
    reads++; assert.equal(url.href.split('?')[0], 'https://api.vercel.com/v1/query/web-analytics/visits/aggregate');
    assert.equal(url.searchParams.get('projectId'), projects[0].projectId);
    assert.equal(url.searchParams.get('teamId'), projects[0].teamId);
    assert.equal(url.searchParams.get('by'), 'day'); assert.equal(url.searchParams.get('limit'), '32');
    assert.equal(url.searchParams.get('filter'), "environment eq 'production'");
    assert.equal(url.searchParams.has('access_token'), false); assert.equal(url.href.includes('test-only'), false);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    return { ok: true, json: async () => body([day()]) };
  } }, [projects[0]]);
  assert.equal((await read('chatline.app')).daily[0].visitors, 3);
  assert.equal((await read('start.chatline.app')).status, 'not_connected');
  await assert.rejects(read('other.example'), /ANALYTICS_SCOPE_INVALID/);
  assert.equal(reads, 1);
});
test('analytics normalization drops non-aggregate data and preserves explicit zero without filling missing days', () => {
  const rows = normalizeAnalytics(body([{ ...day('2026-10-23', 0, 0), visitorId: 'private-user', requestPath: '/private' }, day('2026-10-25')]), projects[0], period);
  assert.deepEqual(rows, [{ date: '2026-10-23', visitors: 0, pageviews: 0 }, { date: '2026-10-25', visitors: 3, pageviews: 4 }]);
  assert.equal(JSON.stringify(rows).includes('private'), false);
  assert.equal(rows.some(r => r.date === '2026-10-24'), false);
  assert.deepEqual(normalizeAnalytics(body([]), projects[0], period), []);
});
test('wrong project, wrong date, duplicates, missing counts and non-daily grouping fail closed', () => {
  for (const rows of [[{ ...day(), projectId: 'prj_foreign' }], [{ ...day(), requestHostname: 'other.example' }], [day('2026-11-01')], [day(), day()], [{ timestamp: '2026-10-25T00:00:00Z', visitors: null, pageviews: 4 }], [day('2026-10-25', 5, 4)]]) {
    assert.throws(() => normalizeAnalytics(body(rows), projects[0], period), /ANALYTICS_INVALID_RESPONSE/);
  }
  assert.throws(() => normalizeAnalytics({ ...body([day()]), query: { ...body([]).query, groupBy: ['country'] } }, projects[0], period), /ANALYTICS_INVALID_RESPONSE/);
});
test('permission and network failures expose fixed codes and never copy private API errors', async () => {
  const read = createAnalyticsReader({ token: 'test-only', now, fetcher: async () => ({ ok: false, status: 403, json: async () => ({ error: 'private message' }) }) }, [projects[0]]);
  const result = await read('chatline.app');
  assert.equal(result.error, 'ANALYTICS_PERMISSION_REQUIRED'); assert.equal(result.observed_at, null);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('a partial failure preserves the failed site values/date and never freshens Meta or the other sources', async () => {
  const read = createAnalyticsReader({ token: 'test-only', now, fetcher: async () => ({ ok: true, json: async () => body([day()]) }) }, projects);
  const initial = mergeAnalytics(original, await Promise.all(projects.map(p => read(p.site))), { now });
  const later = new Date(now.getTime() + 1800000);
  const results = [{ ...initial.sources.analytics.sites[0], observed_at: later.toISOString(), attempted_at: later.toISOString(), daily: [{ date: '2026-10-25', visitors: 5, pageviews: 8 }] }, { site: 'start.chatline.app', status: 'error', error: 'ANALYTICS_PERMISSION_REQUIRED' }];
  const next = mergeAnalytics(initial, results, { now: later });
  assert.equal(next.sources.analytics.status, 'partial');
  assert.equal(next.sources.analytics.sites[0].observed_at, later.toISOString());
  assert.equal(next.sources.analytics.sites[1].observed_at, now.toISOString());
  assert.deepEqual(next.sources.analytics.sites[1].daily, initial.sources.analytics.sites[1].daily);
  assert.equal(next.sources.analytics.observed_at, now.toISOString());
  assert.deepEqual(next.sources.meta, original.sources.meta);
  assert.deepEqual(next.sources.website_events, original.sources.website_events);
});
test('Meta failure does not block a successful analytics merge; global collection time never substitutes source time', async () => {
  const failedMeta = mergeMeta(original, null, { now, error: 'META_LOGIN_REQUIRED' });
  const read = createAnalyticsReader({ token: 'test-only', now, fetcher: async () => ({ ok: true, json: async () => body([day()]) }) }, [projects[0]]);
  const next = mergeAnalytics(failedMeta, [await read('chatline.app'), await read('start.chatline.app')], { now });
  assert.equal(next.sources.meta.observed_at, original.sources.meta.observed_at);
  assert.equal(next.sources.meta.status, 'error');
  assert.equal(next.sources.analytics.sites[0].observed_at, now.toISOString());
  assert.equal(next.sources.analytics.sites[1].observed_at, null);
});
test('UI model uses visitors per returned day and never sums daily/site visitors or invents missing zero', () => {
  const source = { sites: [{ site: 'chatline.app', status: 'connected', observed_at: now.toISOString(), daily: [{ date: '2026-10-24', visitors: 100, pageviews: 150 }, { date: '2026-10-25', visitors: 100, pageviews: 170 }] }, { site: 'start.chatline.app', status: 'connected', observed_at: now.toISOString(), daily: [{ date: '2026-10-25', visitors: 30, pageviews: 70 }] }] };
  assert.equal(analyticsView(source, 'chatline.app', now.getTime()).visitors, 100);
  assert.equal(analyticsView(source, 'start.chatline.app', now.getTime()).visitors, 30);
  assert.equal(analyticsView(null, 'chatline.app').visitors, null);
  assert.equal(analyticsView(null, 'chatline.app').state, 'not_connected');
});
test('snapshot schema rejects foreign analytics sites and malformed visitor numbers', () => {
  const next = structuredClone(original);
  next.sources.analytics.sites = [{ site: 'other.example', observed_at: null, attempted_at: null, daily: [] }];
  assert.throws(() => validateSnapshot(next), /ANALYTICS_SCOPE_MISMATCH/);
  next.sources.analytics.sites[0] = { site: 'chatline.app', observed_at: null, attempted_at: null, daily: [{ date: '2026-10-25', visitors: -1, pageviews: 4 }] };
  assert.throws(() => validateSnapshot(next), /SNAPSHOT_INVALID/);
});
test('the currently published legacy schema-2 analytics shape without sites stays valid and unknown', () => {
  const old = structuredClone(original);
  old.sources.analytics = { status: 'not_connected', observed_at: null, attempted_at: null, error: null };
  assert.doesNotThrow(() => validateSnapshot(old));
  assert.equal(analyticsView(old.sources.analytics, 'chatline.app').visitors, null);
  assert.equal(analyticsView(old.sources.analytics, 'start.chatline.app').visitors, null);
});
test('same-slot retry is skipped only when every enabled independent source succeeded', () => {
  const old = structuredClone(original); const slot = '2026-10-25T18:00:00.000Z';
  old.snapshot_id = slot; old.sources.meta.status = 'connected'; old.sources.meta.observed_at = now.toISOString();
  assert.equal(canSkipCollection(old, { slot, now }), true);
  assert.equal(canSkipCollection(old, { slot, now, analyticsProjects: [projects[0]] }), false);
  old.sources.analytics.sites = [{ site: 'chatline.app', status: 'error', observed_at: now.toISOString(), daily: [] }];
  assert.equal(canSkipCollection(old, { slot, now, analyticsProjects: [projects[0]] }), false);
  old.sources.analytics.sites[0].status = 'connected';
  assert.equal(canSkipCollection(old, { slot, now, analyticsProjects: [projects[0]] }), true);
  assert.equal(canSkipCollection(old, { slot, now, datasetEnabled: true }), false);
  old.sources.website_events.status = 'error'; old.sources.website_events.source_code = 'meta_dataset_stats';
  assert.equal(canSkipCollection(old, { slot, now, datasetEnabled: true }), false);
  old.sources.website_events.status = 'connected'; old.sources.website_events.observed_at = now.toISOString();
  assert.equal(canSkipCollection(old, { slot, now, datasetEnabled: true, analyticsProjects: [projects[0]] }), true);
});
test('enabling a source after a same-slot Meta-only run does not reuse its success from an older slot', () => {
  const slot = '2026-10-25T18:00:00.000Z', current = new Date('2026-10-25T18:10:00.000Z');
  const old = structuredClone(original);
  old.snapshot_id = slot; old.sources.meta.status = 'connected'; old.sources.meta.observed_at = '2026-10-25T18:07:00.000Z';
  old.sources.website_events.status = 'connected'; old.sources.website_events.source_code = 'meta_dataset_stats';
  old.sources.website_events.observed_at = '2026-10-25T17:37:00.000Z';
  old.sources.analytics.sites = [{ site: 'chatline.app', status: 'connected', observed_at: '2026-10-25T17:37:00.000Z', daily: [] }];
  assert.equal(canSkipCollection(old, { slot, now: current, datasetEnabled: false }), true);
  assert.equal(canSkipCollection(old, { slot, now: current, datasetEnabled: true }), false);
  assert.equal(canSkipCollection(old, { slot, now: current, analyticsProjects: [projects[0]] }), false);
  old.sources.website_events.observed_at = '2026-10-25T18:08:00.000Z';
  old.sources.analytics.sites[0].observed_at = '2026-10-25T18:09:00.000Z';
  assert.equal(canSkipCollection(old, { slot, now: current, datasetEnabled: true, analyticsProjects: [projects[0]] }), true);
});
test('future observation times and a later slot cannot suppress a current-slot retry', () => {
  const slot = '2026-10-25T18:00:00.000Z', current = new Date('2026-10-25T18:10:00.000Z');
  const old = structuredClone(original); old.snapshot_id = slot; old.sources.meta.status = 'connected';
  old.sources.meta.observed_at = '2026-10-25T18:11:00.000Z';
  assert.equal(canSkipCollection(old, { slot, now: current }), false);
  old.sources.meta.observed_at = '2026-10-25T18:30:00.000Z';
  assert.equal(canSkipCollection(old, { slot, now: new Date('2026-10-25T18:35:00.000Z') }), false);
});
