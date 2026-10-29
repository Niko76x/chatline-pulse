import { pathToFileURL } from 'node:url';
import { SCOPE, AD_IDS, createMetaReader, collectAds, collectDatasetStats } from '../api/data.js';

const VERSION = 'v26.0';
const ZONE = 'Europe/Berlin';
const EXPECTED_ADS = [
  '120275421779180555', '120275422266100555', '120275421929330555',
  '120275422266130555', '120275421929340555', '120275422266170555',
  '120275422266160555', '120275422266150555', '120275422266110555',
  '120275422266120555', '120275422266140555', '120275421929310555',
  '120275421929320555',
];
const METRICS = ['spend', 'impressions', 'reach', 'link_clicks', 'landing_page_views',
  'studio_tests', 'call_requests', 'checkouts', 'trials'];
const SAFE_ERRORS = new Set([
  'META_NOT_CONFIGURED', 'META_UNAVAILABLE', 'META_INVALID_RESPONSE', 'META_LOGIN_REQUIRED',
  'META_PERMISSION_REQUIRED', 'META_RATE_LIMITED', 'META_READ_FAILED', 'META_PAGINATION_INVALID',
  'META_PAGINATION_LIMIT', 'META_INVALID_METRIC', 'META_INVALID_PERIOD', 'PATH_NOT_ALLOWED',
  'ACCOUNT_CONFIG_MISMATCH', 'SCOPE_MISMATCH', 'DATASET_MISMATCH', 'DATASET_NO_STATS',
  'DATASET_INVALID_RESPONSE', 'DATASET_INVALID_PERIOD', 'DATASET_DUPLICATE_EVENT',
  'PREFLIGHT_SCOPE_CHANGED', 'PREFLIGHT_INVALID_DAY', 'PREFLIGHT_TIMEZONE_MISMATCH',
  'PREFLIGHT_IDENTITY_NOT_VERIFIED', 'PREFLIGHT_DUPLICATE_ROW', 'PREFLIGHT_GRAPH_VERSION',
]);
const fail = code => { throw new Error(code); };
export const safeError = error => SAFE_ERRORS.has(error?.code || error?.message)
  ? error.code || error.message : 'PREFLIGHT_FAILED';
const GRAPH_TYPES = Object.freeze({ OAuthException: 'oauth', GraphMethodException: 'graph_method', GraphAPIException: 'graph_api', RateLimitException: 'rate_limit' });
const GRAPH_CATEGORIES = new Set(['oauth', 'graph_method', 'graph_api', 'rate_limit', 'other']);
const DATASET_REASONS = new Set(['object_unavailable', 'permission_required', 'field_not_supported', 'parameter_rejected']);
function datasetReason(error) {
  if (DATASET_REASONS.has(error?.reason_category)) return error.reason_category;
  const message = typeof error?.message === 'string' ? error.message.slice(0, 4096) : '';
  // Object-not-found can also mean inaccessible. Never turn this ambiguous
  // Graph response into a claim that the token needs wider permissions.
  if (/unsupported get request/i.test(message)) return 'object_unavailable';
  if (/tried accessing nonexisting field|nonexisting field|unknown field/i.test(message)) return 'field_not_supported';
  if (/requires? .*permission|must have .*permission|does not have .*permission|permissions? (?:are |is )?required/i.test(message)) return 'permission_required';
  if (/invalid parameter|aggregation must be|param .* must be|parameter .* is not supported/i.test(message)) return 'parameter_rejected';
  return null;
}
const graphCode = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null;
// Only fixed numeric/type metadata leaves the optional Dataset error path.
// Never return messages, trace IDs, arbitrary type strings or response bodies.
export function safeDatasetGraphError(error) {
  const reason = datasetReason(error);
  return {
    code: graphCode(error?.code),
    subcode: graphCode(error?.error_subcode ?? error?.subcode),
    type_category: Object.hasOwn(GRAPH_TYPES, error?.type) ? GRAPH_TYPES[error.type]
      : GRAPH_CATEGORIES.has(error?.type_category) ? error.type_category : 'other',
    ...(reason ? { reason_category: reason } : {}),
  };
}
const metrics = row => Object.fromEntries(METRICS.map(key => [key, row?.[key] ?? null]));

// Called only by the manual CLI below. An injected reader permits offline safety
// tests; account/asset IDs cannot be configured by workflow/browser parameters.
export async function runPreflight({ read, reportDate, includeDataset = false, now = new Date(), datasetHttpStatus = () => null, datasetGraphError = () => null }) {
  if (SCOPE.account !== '2128240694419507' || SCOPE.dataset !== '1727278251668513' ||
      SCOPE.campaign !== '120274644271350555' || SCOPE.adset !== '120275421779190555' ||
      SCOPE.repository !== 'Niko76x/chatline-pulse' || SCOPE.since !== '2026-10-22' ||
      Object.keys(AD_IDS).sort().join() !== [...EXPECTED_ADS].sort().join()) fail('PREFLIGHT_SCOPE_CHANGED');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(now);
  const parsed = new Date(`${reportDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate || '') || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== reportDate || reportDate < SCOPE.since || reportDate >= today) fail('PREFLIGHT_INVALID_DAY');
  const verified = { account: false, currency: false, timezone: false, adset: false, campaign: false, pixel: false };
  const allVerified = () => Object.values(verified).every(Boolean);
  const guardedRead = async (path, params) => {
    const insights = path === `${SCOPE.adset}/insights`;
    if (insights || path === `${SCOPE.adset}/ads`) {
      if (!allVerified()) fail('PREFLIGHT_IDENTITY_NOT_VERIFIED');
    }
    // Narrow the existing collector's daily queries to exactly the requested
    // closed account day. No result.period from collectAds is published/reused.
    const query = insights ? { ...params, time_range: { since: reportDate, until: reportDate } } : params;
    const result = await read(path, query);
    if (path === `act_${SCOPE.account}`) {
      if (String(result.id).replace(/^act_/, '') !== SCOPE.account || result.currency !== 'EUR') fail('ACCOUNT_CONFIG_MISMATCH');
      if (result.timezone_name !== ZONE) fail('PREFLIGHT_TIMEZONE_MISMATCH');
      verified.account = verified.currency = verified.timezone = true;
    } else if (path === SCOPE.adset) {
      if (String(result.id) !== SCOPE.adset || String(result.account_id) !== SCOPE.account || String(result.campaign_id) !== SCOPE.campaign) fail('SCOPE_MISMATCH');
      if (String(result.promoted_object?.pixel_id) !== SCOPE.dataset) fail('DATASET_MISMATCH');
      verified.adset = verified.pixel = true;
    } else if (path === SCOPE.campaign) {
      if (String(result.id) !== SCOPE.campaign || String(result.account_id) !== SCOPE.account) fail('SCOPE_MISMATCH');
      verified.campaign = true;
    }
    if (insights && (!Array.isArray(result) || result.some(row => row.date_start !== reportDate || row.date_stop !== reportDate))) fail('META_INVALID_PERIOD');
    return result;
  };
  const report = await collectAds(guardedRead, now);
  if (!allVerified()) fail('PREFLIGHT_IDENTITY_NOT_VERIFIED');
  const codes = report.ads_daily.map(row => row.code);
  if (report.daily.length > 1 || new Set(codes).size !== codes.length) fail('PREFLIGHT_DUPLICATE_ROW');
  const hasData = report.daily.length === 1 && report.ads_daily.length > 0;
  const summary = {
    status: hasData ? 'ads_validated' : 'ads_empty_report',
    snapshot_written: false, published: false, checks: verified,
    comparison: { date: reportDate, timezone: ZONE, currency: 'EUR',
      attribution: 'use_unified_attribution_setting=true', action_report_time: 'conversion' },
    ads: { totals: metrics(report.daily[0]), insight_rows: report.ads_daily.length,
      returned_status_rows: report.statuses.length, approved_ads: EXPECTED_ADS.length,
      rows: Object.values(AD_IDS).map(code => {
        const row = report.ads_daily.find(item => item.code === code);
        return { code, has_data: Boolean(row), ...metrics(row) };
      }) },
    dataset: { status: includeDataset ? 'not_attempted_ads_unverified' : 'not_requested', enable_flag_changed: false },
  };
  if (includeDataset && hasData) {
    try {
      const dataset = await collectDatasetStats(read, { enabled: true, now });
      summary.dataset = { status: 'read_validated', enable_flag_changed: false,
        window: { from: `${now.toISOString().slice(0, 10)}T00:00:00.000Z`, to: now.toISOString(), timezone: 'UTC' },
        events: dataset.events.map(({ key, count }) => ({ key, count })),
        deduplication_verified: false };
    } catch (error) {
      const http = datasetHttpStatus();
      const graph = datasetGraphError();
      summary.dataset = { status: 'error', enable_flag_changed: false, error: safeError(error),
        http_status: Number.isInteger(http) && http >= 100 && http <= 599 ? http : null,
        ...(graph ? { graph_error: safeDatasetGraphError(graph) } : {}) };
    }
  }
  return summary;
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== 'Niko76x/chatline-pulse') fail('PREFLIGHT_SCOPE_CHANGED');
  if (process.env.META_GRAPH_VERSION !== VERSION) fail('PREFLIGHT_GRAPH_VERSION');
  if (!process.env.META_REPORTING_ACCESS_TOKEN?.trim()) fail('META_NOT_CONFIGURED');
  let statsHttp = null;
  let statsGraph = null;
  const read = createMetaReader({ token: process.env.META_REPORTING_ACCESS_TOKEN.trim(), version: VERSION,
    fetcher: async (url, options) => {
      const response = await fetch(url, options);
      if (url.origin === 'https://graph.facebook.com' && url.pathname === `/${VERSION}/${SCOPE.dataset}/stats`) {
        statsHttp = response.status;
        statsGraph = null;
        if (!response.ok) {
          try {
            const body = await response.clone().json();
            if (body?.error && typeof body.error === 'object' && !Array.isArray(body.error)) statsGraph = safeDatasetGraphError(body.error);
          } catch { /* No raw parse/error detail is copied. */ }
        }
      }
      return response;
    } });
  const result = await runPreflight({ read, reportDate: process.env.PREFLIGHT_REPORT_DATE,
    includeDataset: process.env.PREFLIGHT_INCLUDE_DATASET_STATS === 'true', datasetHttpStatus: () => statsHttp, datasetGraphError: () => statsGraph });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'ads_validated' || result.dataset.status === 'error') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stdout.write(`${JSON.stringify({ status: 'failed', error: safeError(error), snapshot_written: false, published: false })}\n`);
    process.exitCode = 1;
  });
}
