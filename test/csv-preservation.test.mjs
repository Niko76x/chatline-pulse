import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSnapshot, mergeMeta, refreshSources, canSkipCoreCollection, ANALYTICS_PROJECTS } from '../api/data.js';
import { validateCsvMetaSource, csvMetaIsProtected, CSV_ATTRIBUTION_SETTING } from '../lib/csv-meta.mjs';
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-26T12:07:00.000Z'), slot = '2026-10-26T12:00:00.000Z';
function fixture() {
  const value = structuredClone(original);
  value.collected_at = '2026-10-26T10:05:00.000Z';
  Object.assign(value.sources.meta, { method: 'csv', status: 'connected', error: null, timezone: 'Europe/Berlin',
    observed_at: '2026-10-26T10:00:00.000Z', attempted_at: '2026-10-26T10:05:00.000Z',
    manual_update: { edition_label: 'Tagesupdate 26.10.2026, 10:00', exported_at: '2026-10-26T10:00:00.000Z',
      imported_at: '2026-10-26T10:05:00.000Z', valid_until: '2026-10-26T23:00:00.000Z',
      attribution_setting: CSV_ATTRIBUTION_SETTING, reporting_basis: 'ads_manager_export', timezone: 'Europe/Berlin' } });
  return value;
}
const tokens = { 'chatline.app': 'fixture-website-token', 'start.chatline.app': 'fixture-diy-token' };
function analytics(fetches) {
  return { tokens, fetcher: async url => {
    fetches.push(url.href);
    assert.equal(url.origin, 'https://api.vercel.com');
    return { ok: true, status: 200, json: async () => ({ version: 1, query: { since: '2026-10-22', until: '2026-10-26', groupBy: ['day'], filter: "environment eq 'production'" }, data: [{ timestamp: '2026-10-26T00:00:00Z', visitors: 2, pageviews: 4 }] }) };
  } };
}
test('strict CSV metadata accepts the agreed seven-field manual export and leaves legacy API snapshots valid', () => {
  validateSnapshot(original); validateSnapshot(fixture());
  assert.equal(csvMetaIsProtected(fixture().sources.meta, now), true);
  assert.equal(csvMetaIsProtected(original.sources.meta, now), false);
});
test('CSV metadata rejects missing pairs, unknown fields, malformed dates and untrusted text', () => {
  const mutations = [
    s => { delete s.manual_update; }, s => { delete s.method; }, s => { s.method = 'api'; },
    s => { delete s.manual_update.exported_at; }, s => { s.manual_update.raw_url = 'https://private.invalid'; },
    s => { s.manual_update.edition_label = '<script>private</script>'; }, s => { s.manual_update.edition_label = 'Tagesupdate 31.02.2026, 10:00'; },
    s => { s.manual_update.exported_at = '2026-02-30T10:00:00Z'; }, s => { s.manual_update.imported_at = '2026-10-26'; },
    s => { s.manual_update.timezone = 'UTC'; }, s => { s.manual_update.reporting_basis = 'api'; },
    s => { s.manual_update.attribution_setting = 'unknown arbitrary attribution'; }
  ];
  for (const mutate of mutations) { const source = structuredClone(fixture().sources.meta); mutate(source); assert.throws(() => validateCsvMetaSource(source), /SNAPSHOT_CSV_META_INVALID/); }
  const leaked = fixture(); leaked.sources.meta.manual_update.edition_label = 'Bearer forbidden';
  assert.throws(() => validateSnapshot(leaked), /SNAPSHOT_PRIVATE_DATA/);
});
test('CSV protection is bounded to at most 24 hours, cannot predate import, and expires at its exclusive boundary', () => {
  for (const change of [
    u => { u.valid_until = u.imported_at; },
    u => { u.valid_until = '2026-10-27T10:05:00.001Z'; },
    u => { u.exported_at = '2026-10-26T10:06:00Z'; },
    u => { u.exported_at = '2026-10-25T10:04:59Z'; }
  ]) { const s = fixture().sources.meta; change(s.manual_update); assert.throws(() => validateCsvMetaSource(s), /SNAPSHOT_CSV_META_INVALID/); }
  const source = fixture().sources.meta;
  assert.equal(csvMetaIsProtected(source, new Date('2026-10-26T10:04:59.999Z')), false);
  assert.equal(csvMetaIsProtected(source, new Date('2026-10-26T22:59:59.999Z')), true);
  assert.equal(csvMetaIsProtected(source, new Date('2026-10-26T23:00:00.000Z')), false);
});
test('both a successful and a failed automated Meta merge preserve active CSV values and clocks exactly', () => {
  const previous = fixture();
  for (const options of [{ now, slot }, { now, slot, error: 'META_LOGIN_REQUIRED' }]) {
    const merged = mergeMeta(previous, { daily: [], observed_at: now.toISOString() }, options);
    assert.deepEqual(merged, previous); assert.notEqual(merged, previous);
  }
});
test('protected CSV performs zero Meta reads while both independent Analytics sources genuinely refresh', async () => {
  const previous = fixture(), reads = []; let metaReads = 0;
  const result = await refreshSources(previous, { now, slot, metaEnabled: true,
    metaOptions: { token: 'fixture-meta-token', version: 'v99.0', fetcher: async () => { metaReads++; throw Error('Meta must not run'); } },
    analyticsOptions: analytics(reads) });
  assert.equal(metaReads, 0); assert.equal(reads.length, 2); assert.equal(result.success, true);
  assert.deepEqual(result.snapshot.sources.meta, previous.sources.meta);
  assert.equal(result.snapshot.sources.analytics.sites.every(s => s.observed_at === now.toISOString()), true);
  assert.equal(result.snapshot.collected_at, now.toISOString());
  for (const key of ['website_events', 'search_console']) assert.deepEqual(result.snapshot.sources[key], previous.sources[key]);
  assert.deepEqual(previous, fixture());
});
test('unrelated Analytics failure does not relabel CSV as an API failure or advance its observation time', async () => {
  const previous = fixture();
  const result = await refreshSources(previous, { now, slot, metaEnabled: true,
    metaOptions: { token: 'fixture-meta-token', version: 'v99.0', fetcher: async () => { throw Error('must not run'); } },
    analyticsOptions: { tokens, fetcher: async () => ({ ok: false, status: 403, json: async () => ({}) }) } });
  assert.equal(result.success, false); assert.deepEqual(result.snapshot.sources.meta, previous.sources.meta);
  assert.equal(result.snapshot.collected_at, previous.collected_at);
});
test('same-slot idempotence treats protected Meta as held, then requires normal Meta collection after expiry', () => {
  const previous = fixture(); previous.snapshot_id = slot;
  previous.sources.analytics = { sites: ANALYTICS_PROJECTS.map(p => ({ site: p.site, status: 'connected', observed_at: now.toISOString() })) };
  assert.equal(canSkipCoreCollection(previous, { slot, now, metaEnabled: true }), true);
  assert.equal(canSkipCoreCollection(previous, { slot, now: new Date('2026-10-26T23:00:00Z'), metaEnabled: true }), false);
});
test('expiry restores existing successful and failed Meta merge behavior without retaining a false fresh CSV claim', () => {
  const previous = fixture(), expired = new Date('2026-10-26T23:00:00Z');
  const result = { ...structuredClone(original.sources.meta), observed_at: expired.toISOString() };
  const success = mergeMeta(previous, result, { now: expired });
  assert.equal(success.sources.meta.method, undefined); assert.equal(success.sources.meta.manual_update, undefined);
  assert.equal(success.sources.meta.observed_at, expired.toISOString()); assert.equal(success.collected_at, expired.toISOString());
  const failure = mergeMeta(previous, null, { now: expired, error: 'META_LOGIN_REQUIRED' });
  assert.equal(failure.sources.meta.status, 'error'); assert.equal(failure.sources.meta.observed_at, previous.sources.meta.observed_at);
  assert.equal(failure.sources.meta.attempted_at, expired.toISOString()); assert.equal(failure.collected_at, previous.collected_at);
});
test('expired CSV returns to the real Meta read path and independently preserves its old values on provider failure', async () => {
  const previous = fixture(); let metaReads = 0;
  const result = await refreshSources(previous, { now: new Date('2026-10-26T23:00:00Z'), metaEnabled: true,
    metaOptions: { token: 'fixture-meta-token', version: 'v99.0', fetcher: async () => { metaReads++; return { ok: false, status: 403, json: async () => ({ error: { code: 190 } }) }; } } });
  assert.equal(metaReads, 1); assert.equal(result.success, false);
  assert.equal(result.snapshot.sources.meta.status, 'error'); assert.deepEqual(result.snapshot.sources.meta.daily, previous.sources.meta.daily);
});
