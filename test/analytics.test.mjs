import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ANALYTICS_PROJECTS } from '../api/data.js';
import { analyticsPeriod, createAnalyticsReader, collectWebAnalytics, normalizeAnalytics } from '../api/data.js';
import { mergeAnalytics, mergeMeta, validateSnapshot, canSkipCollection } from '../api/data.js';
import { analyticsView } from './model.mjs';
const now = new Date('2026-10-25T18:00:00.000Z');
const projects = ANALYTICS_PROJECTS.map((p,i) => ({ ...p, hosts: [...p.hosts], projectId: i ? 'prj_fixtureDIY' : 'prj_fixtureWebsite', teamId: 'team_fixture' }));
const fixtureTokens = Object.freeze({ 'chatline.app': 'fixture-website-token', 'start.chatline.app': 'fixture-diy-token' });
const period = analyticsPeriod(now);
const body = rows => ({ version: 1, query: { since: period.from, until: period.to, groupBy: ['day'], filter: "environment eq 'production'" }, data: rows });
const day = (date = '2026-10-25', visitors = 3, pageviews = 4) => ({ timestamp: date + 'T00:00:00.000Z', visitors, pageviews });
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));

test('production analytics scope is exactly the two verified projects; missing tokens make zero requests', async () => {
  assert.deepEqual(ANALYTICS_PROJECTS.map(p => [p.site,p.projectId,p.teamId]), [
    ['chatline.app','prj_gzg9Y1fg2GOIyQFOZiifk45iahty','team_i2XlerNOfSTLE5EGj65B1vau'],
    ['start.chatline.app','prj_cKWblSdgOD2QY0tUExAkoqB3Z5jH','team_i2XlerNOfSTLE5EGj65B1vau'],
  ]);
  let reads = 0;
  const result = await collectWebAnalytics({ now, fetcher: async () => { reads++; } });
  assert.equal(reads, 0);
  assert.ok(result.every(s => s.status === 'error' && s.error === 'ANALYTICS_NOT_CONFIGURED' && s.observed_at === null));
});
test('fixture configuration permits only the two separate verified-style ChatLine projects', () => {
  assert.throws(() => createAnalyticsReader({ tokens: fixtureTokens }, [{ site: 'other.example', projectId: 'prj_fixture' }]), /ANALYTICS_SCOPE_INVALID/);
  assert.throws(() => createAnalyticsReader({ tokens: fixtureTokens }, [projects[0], { ...projects[1], projectId: projects[0].projectId }]), /ANALYTICS_SCOPE_INVALID/);
  assert.throws(() => createAnalyticsReader({ tokens: fixtureTokens }, [{ ...projects[0], url: 'https://other.example' }]), /ANALYTICS_SCOPE_INVALID/);
});
test('the reader uses only the official endpoint, fixed project/team, daily production aggregates and bearer header', async () => {
  let reads = 0;
  const read = createAnalyticsReader({ tokens: fixtureTokens, now, fetcher: async (url, options) => {
    reads++; assert.equal(url.href.split('?')[0], 'https://api.vercel.com/v1/query/web-analytics/visits/aggregate');
    assert.equal(url.searchParams.get('projectId'), projects[0].projectId);
    assert.equal(url.searchParams.get('teamId'), projects[0].teamId);
    assert.equal(url.searchParams.get('by'), 'day'); assert.equal(url.searchParams.get('limit'), '32');
    assert.equal(url.searchParams.get('filter'), "environment eq 'production'");
    assert.equal(url.searchParams.has('access_token'), false); assert.equal(url.href.includes('fixture-website-token'), false);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-website-token');
    return { ok: true, json: async () => body([day()]) };
  } }, [projects[0]]);
  assert.equal((await read('chatline.app')).daily[0].visitors, 3);
  assert.equal((await read('start.chatline.app')).status, 'not_connected');
  await assert.rejects(read('other.example'), /ANALYTICS_SCOPE_INVALID/);
  assert.equal(reads, 1);
});
test('each configured project receives only its own token', async () => {
  const calls = [];
  const read = createAnalyticsReader({ tokens: fixtureTokens, now, fetcher: async (url, options) => {
    calls.push({ project: url.searchParams.get('projectId'), auth: options.headers.Authorization });
    return { ok: true, json: async () => body([day()]) };
  } }, projects);
  await Promise.all(projects.map(p => read(p.site)));
  assert.deepEqual(calls.sort((a, b) => a.project.localeCompare(b.project)), [
    { project: projects[1].projectId, auth: 'Bearer fixture-diy-token' },
    { project: projects[0].projectId, auth: 'Bearer fixture-website-token' },
  ].sort((a, b) => a.project.localeCompare(b.project)));
});
test('a missing site token fails only that source without requesting it or borrowing the other token', async () => {
  for (const provided of projects) {
    const calls = [];
    const read = createAnalyticsReader({ tokens: { [provided.site]: fixtureTokens[provided.site] }, now, fetcher: async url => {
      calls.push(url.searchParams.get('projectId'));
      return { ok: true, json: async () => body([day()]) };
    } }, projects);
    const results = await Promise.all(projects.map(p => read(p.site)));
    assert.equal(results.find(s => s.site === provided.site).status, 'connected');
    assert.equal(results.find(s => s.site !== provided.site).error, 'ANALYTICS_NOT_CONFIGURED');
    assert.deepEqual(calls, [provided.projectId]);
  }
});
test('transient retries keep the same project token and never retry a failed source with its neighbour credential', async () => {
  const calls = [];
  const read = createAnalyticsReader({ tokens: fixtureTokens, now, sleep: async () => {}, fetcher: async (url, options) => {
    const project = url.searchParams.get('projectId'); calls.push({ project, auth: options.headers.Authorization });
    return project === projects[0].projectId ? { ok: false, status: 429 } : { ok: true, json: async () => body([day()]) };
  } }, projects);
  const results = await Promise.all(projects.map(p => read(p.site)));
  assert.equal(results[0].error, 'ANALYTICS_RATE_LIMITED'); assert.equal(results[1].status, 'connected');
  assert.equal(calls.filter(c => c.project === projects[0].projectId).length, 3);
  assert.equal(calls.filter(c => c.project === projects[1].projectId).length, 1);
  assert.ok(calls.every(c => c.auth === (c.project === projects[0].projectId ? 'Bearer fixture-website-token' : 'Bearer fixture-diy-token')));
});
test('unknown site/token keys, a shared credential and inherited token maps are rejected before any request', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; };
  for (const tokens of [{ shared: 'fixture-shared' }, { ...fixtureTokens, 'other.example': 'fixture-other' }, { 'chatline.app': 123 }, Object.create({ 'chatline.app': 'fixture-inherited' }), { [Symbol('site')]: 'fixture-symbol' }]) {
    assert.throws(() => createAnalyticsReader({ tokens, now, fetcher }, projects), /ANALYTICS_TOKEN_SCOPE_INVALID/);
  }
  assert.throws(() => createAnalyticsReader({ token: 'fixture-shared', now, fetcher }, projects), /ANALYTICS_TOKEN_SCOPE_INVALID/);
  const read = createAnalyticsReader({ tokens: fixtureTokens, now, fetcher }, projects);
  await assert.rejects(read('other.example'), /ANALYTICS_SCOPE_INVALID/);
  assert.equal(requests, 0);
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
test('known production alias is accepted only for the recognized project-level production query', () => {
  const alias = { ...day(), requestHostname: 'mindbody-home.chatline.app', projectId: projects[0].projectId };
  assert.equal(normalizeAnalytics(body([alias]), projects[0], period)[0].visitors, 3);
  assert.throws(() => normalizeAnalytics({ ...body([alias]), query: { ...body([]).query, filter: "requestHostname eq 'chatline.app'" } }, projects[0], period), /ANALYTICS_INVALID_RESPONSE/);
  assert.throws(() => normalizeAnalytics(body([alias]), { ...projects[0], scope: 'host' }, period), /ANALYTICS_INVALID_RESPONSE/);
  assert.throws(() => normalizeAnalytics(body([{ ...day(), requestHostname: 'mindbody-home.chatline.app' }]), projects[1], period), /ANALYTICS_INVALID_RESPONSE/);
});
test('actual safe response excerpt accepts omitted groupBy and exact exclusive next-day boundary', () => {
  // Provenance: evidence/analytics-diagnostic-job-visible.txt, visible main diagnostic.
  // Only the two actually logged rows are copied; the other two reported rows are not invented.
  const actualExcerpt = { version:1, query:{since:'2026-10-22T00:00:00.000Z',until:'2026-10-26T00:00:00.000Z',filter:"environment eq 'production'"},data:[
    {timestamp:'2026-10-22T00:00:00.000Z',visitors:3,pageviews:4},
    {timestamp:'2026-10-23T00:00:00.000Z',visitors:2,pageviews:3},
  ] };
  assert.deepEqual(normalizeAnalytics(actualExcerpt,projects[0],period),[
    {date:'2026-10-22',visitors:3,pageviews:4},{date:'2026-10-23',visitors:2,pageviews:3},
  ]);
  for (const until of ['2026-10-26T12:00:00.000Z','2026-10-27T00:00:00.000Z','2026-10-25T12:00:00.000Z']) {
    assert.throws(()=>normalizeAnalytics({...actualExcerpt,query:{...actualExcerpt.query,until}},projects[0],period),/ANALYTICS_INVALID_RESPONSE/);
  }
  for(const groupBy of [['country'],['day','country'],'day',null]) assert.throws(()=>normalizeAnalytics({...actualExcerpt,query:{...actualExcerpt.query,groupBy}},projects[0],period),/ANALYTICS_INVALID_RESPONSE/);
  assert.throws(()=>normalizeAnalytics({...actualExcerpt,query:{...actualExcerpt.query,since:'2026-10-22T12:00:00.000Z'}},projects[0],period),/ANALYTICS_INVALID_RESPONSE/);
  assert.throws(()=>normalizeAnalytics({...actualExcerpt,data:[{timestamp:'2026-10-26T00:00:00.000Z',visitors:1,pageviews:1}]},projects[0],period),/ANALYTICS_INVALID_RESPONSE/);
});
test('permission and network failures expose fixed codes and never copy private API errors', async () => {
  const read = createAnalyticsReader({ tokens: fixtureTokens, now, fetcher: async () => ({ ok: false, status: 403, json: async () => ({ error: 'private message' }) }) }, [projects[0]]);
  const result = await read('chatline.app');
  assert.equal(result.error, 'ANALYTICS_PERMISSION_REQUIRED'); assert.equal(result.observed_at, null);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('a partial failure preserves the failed site values/date and never freshens Meta or the other sources', async () => {
  const read = createAnalyticsReader({ tokens: fixtureTokens, now, fetcher: async () => ({ ok: true, json: async () => body([day()]) }) }, projects);
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
  const read = createAnalyticsReader({ tokens: fixtureTokens, now, fetcher: async () => ({ ok: true, json: async () => body([day()]) }) }, [projects[0]]);
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
test('same-slot retry requires every active source and ignores explicitly disabled Meta', () => {
  const old = structuredClone(original), slot = now.toISOString();
  old.snapshot_id = slot;
  old.sources.analytics.sites = projects.map(p => ({ site:p.site,status:'connected',observed_at:now.toISOString(),daily:[] }));
  assert.equal(canSkipCollection(old,{slot,now,metaEnabled:false}),true);
  assert.equal(canSkipCollection(old,{slot,now,metaEnabled:true}),false);
  old.sources.meta.status='connected'; old.sources.meta.observed_at=now.toISOString();
  assert.equal(canSkipCollection(old,{slot,now,metaEnabled:true}),true);
  old.sources.analytics.sites[1].status='error';
  assert.equal(canSkipCollection(old,{slot,now,metaEnabled:false}),false);
  old.sources.analytics.sites[1].status='connected';
  assert.equal(canSkipCollection(old,{slot,now,datasetEnabled:true}),false);
  old.sources.website_events.status='connected';old.sources.website_events.source_code='meta_dataset_stats';old.sources.website_events.observed_at=now.toISOString();
  assert.equal(canSkipCollection(old,{slot,now,datasetEnabled:true}),true);
  assert.equal(canSkipCollection(old,{slot,now,metaEnabled:false,analyticsProjects:[]}),false);
});
test('newly activated source cannot reuse an older success within a same-slot Meta-only snapshot', () => {
  const slot='2026-10-25T18:00:00.000Z',current=new Date('2026-10-25T18:10:00.000Z');
  const old=structuredClone(original);old.snapshot_id=slot;old.sources.meta.status='connected';old.sources.meta.observed_at='2026-10-25T18:07:00.000Z';
  old.sources.website_events.status='connected';old.sources.website_events.source_code='meta_dataset_stats';old.sources.website_events.observed_at='2026-10-25T17:37:00.000Z';
  old.sources.analytics.sites=[{site:'chatline.app',status:'connected',observed_at:'2026-10-25T17:37:00.000Z',daily:[]}];
  assert.equal(canSkipCollection(old,{slot,now:current,metaEnabled:true,analyticsProjects:[]}),true);
  assert.equal(canSkipCollection(old,{slot,now:current,metaEnabled:true,datasetEnabled:true,analyticsProjects:[]}),false);
  assert.equal(canSkipCollection(old,{slot,now:current,metaEnabled:true,analyticsProjects:[projects[0]]}),false);
});
test('future source times and later slots cannot suppress a current-slot retry', () => {
  const slot='2026-10-25T18:00:00.000Z',current=new Date('2026-10-25T18:10:00.000Z');
  const old=structuredClone(original);old.snapshot_id=slot;old.sources.meta.status='connected';
  old.sources.meta.observed_at='2026-10-25T18:11:00.000Z';
  assert.equal(canSkipCollection(old,{slot,now:current,metaEnabled:true,analyticsProjects:[]}),false);
  old.sources.meta.observed_at='2026-10-25T18:30:00.000Z';
  assert.equal(canSkipCollection(old,{slot,now:new Date('2026-10-25T18:35:00.000Z'),metaEnabled:true,analyticsProjects:[]}),false);
});
