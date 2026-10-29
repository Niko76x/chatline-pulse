import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCOPE, AD_IDS, createMetaReader } from '../api/data.js';
import { runPreflight, safeError, safeDatasetGraphError } from '../scripts/meta-preflight.mjs';

const now = new Date('2026-10-26T10:00:00.000Z');
const date = '2026-10-25';
function fixture(overrides = {}) {
  const calls = [];
  let datasetStatus = null;
  let datasetError = null;
  const row = { account_id: SCOPE.account, campaign_id: SCOPE.campaign, adset_id: SCOPE.adset,
    date_start: date, date_stop: date, spend: '7.50', impressions: '100', reach: '90',
    inline_link_clicks: '2', actions: [{ action_type: 'landing_page_view', value: '1' },
      { action_type: 'offsite_conversion.fb_pixel_start_trial', value: '0' }] };
  const read = createMetaReader({ token: 'fixture-only-never-a-real-token', version: 'v26.0',
    sleep: async () => {}, fetcher: async (url, options) => {
      assert.equal(url.origin, 'https://graph.facebook.com');
      assert.equal(options.method, undefined, 'Only the reader default GET is used');
      assert.equal(options.redirect, 'error');
      assert.equal(url.searchParams.has('access_token'), false);
      assert.equal(url.href.includes('fixture-only'), false);
      const path = url.pathname.slice('/v26.0/'.length);
      calls.push({ path, params: Object.fromEntries(url.searchParams) });
      if (path === `act_${SCOPE.account}`) return Response.json({ id: `act_${SCOPE.account}`,
        currency: 'EUR', timezone_name: 'Europe/Berlin', ...overrides.account });
      if (path === SCOPE.adset) return Response.json({ id: SCOPE.adset, account_id: SCOPE.account,
        campaign_id: SCOPE.campaign, effective_status: 'ACTIVE',
        promoted_object: { pixel_id: SCOPE.dataset }, ...overrides.adset });
      if (path === SCOPE.campaign) return Response.json({ id: SCOPE.campaign,
        account_id: SCOPE.account, daily_budget: '1500', effective_status: 'ACTIVE' });
      if (path === `${SCOPE.adset}/ads`) return Response.json({ data: Object.keys(AD_IDS).map(id => ({
        id, account_id: SCOPE.account, campaign_id: SCOPE.campaign, adset_id: SCOPE.adset,
        status: 'ACTIVE', effective_status: 'ACTIVE',
      })) });
      if (path === `${SCOPE.adset}/insights`) {
        assert.deepEqual(JSON.parse(url.searchParams.get('time_range')), { since: date, until: date });
        assert.equal(url.searchParams.get('time_increment'), '1');
        assert.equal(url.searchParams.get('use_unified_attribution_setting'), 'true');
        assert.equal(url.searchParams.get('action_report_time'), 'conversion');
        const value = url.searchParams.get('level') === 'ad'
          ? { ...row, ad_id: overrides.adId || Object.keys(AD_IDS)[0] } : row;
        return Response.json({ data: overrides.empty ? [] : overrides.duplicate ? [value, value] : [value] });
      }
      if (path === `${SCOPE.dataset}/stats`) {
        datasetStatus = overrides.datasetForbidden ? 403 : 200;
        if (overrides.datasetForbidden) {
          const error = { code: 200, error_subcode: 33, type: 'OAuthException', message: 'PRIVATE_MOCK_DETAIL_DO_NOT_LOG', fbtrace_id: 'PRIVATE_TRACE' };
          datasetError = safeDatasetGraphError(error);
          return Response.json({ error }, { status: 403 });
        }
        assert.equal(url.searchParams.get('aggregation'), 'event_total_counts');
        assert.equal(url.searchParams.get('start_time'), String(Date.parse('2026-10-26T00:00:00.000Z') / 1000));
        assert.equal(url.searchParams.get('end_time'), String(now.getTime() / 1000));
        return Response.json({ data: [{ aggregation: 'event_total_counts',
          start_time: '2026-10-26T00:00:00.000Z', data: [{ event: 'PageView', count: '11' }, { event: 'Lead', count: 0 }] }] });
      }
      throw Error('Unexpected endpoint');
    } });
  return { read, calls, datasetHttpStatus: () => datasetStatus, datasetGraphError: () => datasetError };
}
test('real reader and collector validate identities before reports, narrow both queries and preserve unknown versus zero', async () => {
  const f = fixture();
  const result = await runPreflight({ ...f, reportDate: date, now });
  assert.deepEqual(f.calls.slice(0, 3).map(c => c.path), [`act_${SCOPE.account}`, SCOPE.adset, SCOPE.campaign]);
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.equal(result.status, 'ads_validated');
  assert.equal(result.ads.rows.length, 13);
  assert.equal(result.ads.totals.trials, 0);
  assert.equal(result.ads.totals.studio_tests, null);
  assert.equal(result.ads.rows[1].spend, null);
  assert.equal(result.dataset.status, 'not_requested');
  assert.equal(f.calls.some(c => c.path.endsWith('/stats')), false);
  assert.equal(result.published, false);
  assert.equal(result.snapshot_written, false);
});
for (const [name, account] of [
  ['foreign account', { id: 'act_999' }], ['wrong currency', { currency: 'USD' }],
  ['wrong timezone', { timezone_name: 'UTC' }],
]) test(`${name} stops before any report or later asset request`, async () => {
  const f = fixture({ account });
  await assert.rejects(runPreflight({ ...f, reportDate: date, now }), /MISMATCH/);
  assert.equal(f.calls.length, 1);
});
for (const adset of [{ campaign_id: '999' }, { promoted_object: { pixel_id: '999' } }]) {
  test('foreign campaign or pixel stops before campaign/report reads', async () => {
    const f = fixture({ adset });
    await assert.rejects(runPreflight({ ...f, reportDate: date, now }), /MISMATCH/);
    assert.equal(f.calls.length, 2);
  });
}
test('an unapproved ad is rejected by the existing strict scope', async () => {
  await assert.rejects(runPreflight({ ...fixture({ adId: '999' }), reportDate: date, now }), /SCOPE_MISMATCH/);
});
test('closed-day input is checked before any request and duplicate records are rejected', async () => {
  for (const invalid of ['2026-10-26', '2026-10-27', '2026-10-21', '2026-02-31', 'not a day']) {
    const f = fixture();
    await assert.rejects(runPreflight({ ...f, reportDate: invalid, now }), /PREFLIGHT_INVALID_DAY/);
    assert.equal(f.calls.length, 0);
  }
  await assert.rejects(runPreflight({ ...fixture({ duplicate: true }), reportDate: date, now }), /PREFLIGHT_DUPLICATE_ROW/);
});
test('empty reports never claim measured zero or attempt the optional Dataset', async () => {
  const f = fixture({ empty: true });
  const result = await runPreflight({ ...f, reportDate: date, includeDataset: true, now });
  assert.equal(result.status, 'ads_empty_report');
  assert.equal(result.ads.totals.spend, null);
  assert.equal(result.dataset.status, 'not_attempted_ads_unverified');
  assert.equal(f.calls.some(c => c.path.endsWith('/stats')), false);
});
test('optional Dataset remains independent; forbidden reads reveal no raw message and change no flag', async () => {
  const f = fixture({ datasetForbidden: true });
  const result = await runPreflight({ ...f, reportDate: date, includeDataset: true, now });
  assert.equal(result.status, 'ads_validated');
  assert.deepEqual(result.dataset, { status: 'error', enable_flag_changed: false,
    error: 'META_PERMISSION_REQUIRED', http_status: 403,
    graph_error: { code: 200, subcode: 33, type_category: 'oauth' } });
  assert.equal(JSON.stringify(result).includes('PRIVATE_MOCK'), false);
  assert.equal(JSON.stringify(result).includes('fixture-only'), false);
  assert.equal(safeError(Error('PRIVATE_MOCK_DETAIL_DO_NOT_LOG')), 'PREFLIGHT_FAILED');
});
test('Dataset diagnostic copies only finite numeric codes and fixed type categories, never messages or trace metadata', () => {
  const privateValue = 'PRIVATE_VALUE_DO_NOT_COPY';
  const result = safeDatasetGraphError({ code: 100, error_subcode: 33, type: 'GraphMethodException',
    message: privateValue, fbtrace_id: privateValue, access_token: privateValue });
  assert.deepEqual(result, { code: 100, subcode: 33, type_category: 'graph_method' });
  assert.equal(JSON.stringify(result).includes(privateValue), false);
  assert.deepEqual(safeDatasetGraphError({ code: '100', error_subcode: -1, type: privateValue }),
    { code: null, subcode: null, type_category: 'other' });
  assert.deepEqual(safeDatasetGraphError({ code: Infinity, error_subcode: 2147483648, type_category: privateValue }),
    { code: null, subcode: null, type_category: 'other' });
  assert.deepEqual(safeDatasetGraphError(result), result, 'Already sanitized metadata is checked again before reporting');
});
test('optional valid Dataset uses a bounded UTC window with missing event counts left unknown', async () => {
  const result = await runPreflight({ ...fixture(), reportDate: date, includeDataset: true, now });
  assert.equal(result.dataset.status, 'read_validated');
  assert.equal(result.dataset.events.find(e => e.key === 'Lead').count, 0);
  assert.equal(result.dataset.events.find(e => e.key === 'StartTrial').count, null);
  assert.equal(result.dataset.enable_flag_changed, false);
  assert.equal(result.dataset.deduplication_verified, false);
});
test('Dataset failure reasons are fixed categories without private messages or assumptions about object access', () => {
  const privateDetail = 'PRIVATE_ASSET_DETAIL_DO_NOT_COPY';
  for (const [message, category] of [
    [`Unsupported get request. Object ${privateDetail} does not exist or cannot be loaded due to missing permissions`, 'object_unavailable'],
    [`Tried accessing nonexisting field ${privateDetail}`, 'field_not_supported'],
    [`This operation requires ads_read permission for ${privateDetail}`, 'permission_required'],
    [`Invalid parameter ${privateDetail}`, 'parameter_rejected'],
  ]) {
    const result = safeDatasetGraphError({ code: 100, type: 'OAuthException', message });
    assert.equal(result.reason_category, category);
    assert.equal(JSON.stringify(result).includes(privateDetail), false);
    assert.deepEqual(safeDatasetGraphError(result), result);
  }
  assert.equal(Object.hasOwn(safeDatasetGraphError({ message: privateDetail, reason_category: privateDetail }), 'reason_category'), false);
});
test('workflow is manual/read-only and does not invoke the existing publisher or expose token to tests', async () => {
  const yaml = await readFile(new URL('../.github/workflows/meta-preflight.yml', import.meta.url), 'utf8');
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /contents: read/);
  assert.doesNotMatch(yaml, /schedule:|contents: write|--publish|GITHUB_TOKEN|META_REPORTING_ENABLED|META_DATASET_STATS_ENABLED/);
  assert.match(yaml, /run: node scripts\/meta-preflight\.mjs/);
  assert.ok(yaml.indexOf('run: npm test') < yaml.indexOf('META_REPORTING_ACCESS_TOKEN:'));
});
