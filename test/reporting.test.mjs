import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCOPE } from '../api/data.js';
import { createMetaReader, collectAds, normalizeInsight } from '../api/data.js';
import { mergeMeta, validateSnapshot } from '../api/data.js';
import { freshness, summarize, reviewAd } from './model.mjs';
import { readData } from '../api/data.js';
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-25T16:00:00Z');
const row = { account_id: SCOPE.account, campaign_id: SCOPE.campaign, adset_id: SCOPE.adset, ad_id: '120275421779180555', date_start: '2026-10-25', date_stop: '2026-10-25', spend: '10', impressions: '100', reach: '80', inline_link_clicks: '5' };

test('a different ad account is rejected before any aggregate is published', () => {
  assert.throws(() => normalizeInsight({ ...row, account_id: '11111111' }), /SCOPE_MISMATCH/);
  assert.throws(() => normalizeInsight({ ...row, adset_id: '11111111' }), /SCOPE_MISMATCH/);
  assert.throws(() => normalizeInsight({ ...row, ad_id: '11111111' }, true), /SCOPE_MISMATCH/);
});
test('unknown conversion actions stay unknown; an explicit zero remains zero', () => {
  assert.equal(normalizeInsight(row).studio_tests, null);
  assert.equal(normalizeInsight({ ...row, actions: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '0' }] }).studio_tests, 0);
});
test('the four standard website actions retain their distinct funnel meaning without adding overlapping aliases', () => {
  const normalized = normalizeInsight({ ...row, actions: [
    { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },
    { action_type: 'omni_lead', value: '99' },
    { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '1' },
    { action_type: 'offsite_conversion.fb_pixel_initiate_checkout', value: '0' },
    { action_type: 'offsite_conversion.fb_pixel_start_trial', value: '1' },
  ] }, true);
  assert.deepEqual([normalized.studio_tests, normalized.call_requests, normalized.checkouts, normalized.trials], [2, 1, 0, 1]);
});
test('reader has fixed paths and never puts the credential in the URL', async () => {
  let calls = 0;
  const read = createMetaReader({ token: 'test-only', version: 'v99.0', fetcher: async (url, options) => {
    calls++; assert.equal(url.hostname, 'graph.facebook.com'); assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(options.headers.Authorization, 'Bearer test-only'); assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ id: SCOPE.adset }) };
  } });
  await assert.rejects(read('me/adaccounts'), /PATH_NOT_ALLOWED/);
  assert.equal(calls, 0);
  await read(SCOPE.adset); assert.equal(calls, 1);
});
test('pagination ignores untrusted next URL and rebuilds the fixed ChatLine path', async () => {
  let calls = 0;
  const read = createMetaReader({ token: 'test-only', version: 'v99.0', fetcher: async url => {
    assert.equal(url.hostname, 'graph.facebook.com'); assert.equal(url.pathname, `/v99.0/${SCOPE.adset}/ads`);
    calls++;
    return { ok: true, json: async () => calls === 1 ? { data: [{ id: 'one' }], paging: { next: 'https://untrusted.invalid/collect', cursors: { after: 'opaque' } } } : { data: [{ id: 'two' }] } };
  } });
  assert.equal((await read(`${SCOPE.adset}/ads`)).length, 2);
});
test('permission errors are classified without copying private API messages', async () => {
  const read = createMetaReader({ token: 'test-only', version: 'v99.0', fetcher: async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 200, message: 'private body with secret' } }) }) });
  await assert.rejects(read(SCOPE.adset), e => e.code === 'META_PERMISSION_REQUIRED' && !e.message.includes('private'));
});
test('wrong dataset cannot enter an otherwise matching adset report', async () => {
  const read = async path => path.startsWith('act_') ? { id: SCOPE.account, currency: 'EUR', timezone_name: 'Europe/Berlin' } : { id: SCOPE.adset, account_id: SCOPE.account, campaign_id: SCOPE.campaign, promoted_object: { pixel_id: 'wrong' } };
  await assert.rejects(collectAds(read, now), /DATASET_MISMATCH/);
});
test('a missing or different account timezone stops before later assets and preserves previous Meta observations', async () => {
  for (const timezone_name of [undefined, 'UTC', 'Europe/Vienna']) {
    const calls = [];
    const read = async path => {
      calls.push(path);
      return { id: SCOPE.account, currency: 'EUR', timezone_name };
    };
    let failure;
    try { await collectAds(read, now); } catch (error) { failure = error; }
    assert.equal(failure?.code, 'ACCOUNT_CONFIG_MISMATCH');
    assert.deepEqual(calls, [`act_${SCOPE.account}`], 'No adset, campaign or insights read after a timezone mismatch');
    const next = mergeMeta(original, null, { now, error: failure.code });
    assert.equal(next.sources.meta.observed_at, original.sources.meta.observed_at);
    assert.deepEqual(next.sources.meta.daily, original.sources.meta.daily);
    assert.deepEqual(next.sources.meta.ads_daily, original.sources.meta.ads_daily);
    assert.equal(next.collected_at, original.collected_at);
  }
});
test('failed collection preserves every source observation time and last successful collection', () => {
  const next = mergeMeta(original, null, { now, error: 'META_LOGIN_REQUIRED', slot: 'slot' });
  assert.equal(next.collected_at, original.collected_at);
  for (const key of Object.keys(original.sources)) assert.equal(next.sources[key].observed_at, original.sources[key].observed_at);
  assert.equal(next.sources.meta.attempted_at, now.toISOString());
  assert.equal(next.sources.meta.error, 'META_LOGIN_REQUIRED');
});
test('public schema rejects extra fields and credential-looking content', () => {
  const extra = structuredClone(original); extra.access_token = 'not-allowed';
  assert.throws(() => validateSnapshot(extra), /UNKNOWN_FIELD/);
  const leak = structuredClone(original); leak.goals[0].note = 'Bearer do-not-publish';
  assert.throws(() => validateSnapshot(leak), /PRIVATE_DATA/);
  const cross = structuredClone(original); cross.sources.meta.statuses[0].code = 'FOREIGN';
  assert.throws(() => validateSnapshot(cross), /SCOPE_MISMATCH/);
});
test('freshness is based on successful source time, not page load or failed attempt', () => {
  assert.equal(freshness(original.sources.meta.observed_at, now.getTime()).state, 'stale');
  assert.equal(freshness(null, now.getTime()).state, 'missing');
  assert.equal(freshness('2026-10-26T00:00:00Z', now.getTime()).state, 'error');
});
test('CPC is calculated from cumulative totals; reach is not summed over days', () => {
  const result = summarize([{ spend: 4, link_clicks: 1, reach: 10 }, { spend: 4, link_clicks: 3, reach: 10 }]);
  assert.equal(result.cpc, 2); assert.equal(result.reach, null);
  assert.equal(summarize([{ spend: 10, link_clicks: 0 }]).cpc, null);
  assert.equal(summarize([{ spend: 10, link_clicks: null }]).cpc, null);
});
test('CPC exactly 2 EUR does not trigger the optional over-2 review, and no auto-pause exists', () => {
  const source = { status: 'connected', observed_at: now.toISOString(), complete_test_window: true };
  const config = { enabled: true, cpc_review_start: 5, cpc_review_above: 2, funnel_review_clicks: 25 };
  const base = { spend: 10, link_clicks: 5, cpc: 2, landing_page_views: 4, studio_tests: 0 };
  assert.equal(reviewAd(base, source, config, now.getTime()).state, 'untested');
  assert.equal(reviewAd({ ...base, cpc: 2.001 }, source, config, now.getTime()).state, 'review');
  assert.equal(reviewAd({ ...base, cpc: 8 }, source, { ...config, enabled: false }, now.getTime()).state, 'untested');
});
test('public fallback is explicitly historical and does not re-date metrics', async () => {
  const result = await readData({ live: true, now, fetcher: async () => { throw new Error('network'); } });
  assert.equal(result.transport.status, 'historical_fallback');
  assert.equal(result.snapshot.sources.meta.observed_at, original.sources.meta.observed_at);
  assert.notEqual(result.snapshot.sources.meta.observed_at, result.transport.attempted_at);
});
