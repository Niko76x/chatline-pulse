import { pathToFileURL } from 'node:url';
import { trackingContract } from '../lib/tracking-contracts.mjs';

// A manual, four-request diagnostic. No publisher, event sender or dynamic
// asset/project selection is imported. These are public reviewed identifiers.
export const PROJECT = 'prj_cKWblSdgOD2QY0tUExAkoqB3Z5jH';
export const TEAM = 'team_i2XlerNOfSTLE5EGj65B1vau';
export const CAMPAIGN = '120274644271350555';
export const ENDPOINT = 'https://api.vercel.com/v1/query/web-analytics/events/aggregate';
export const EVENTS = Object.freeze(['diy_studio_started', 'diy_call_requested', 'diy_checkout_started', 'diy_dashboard_activated']);
export const ADS = Object.freeze({
  '120275421779180555': 'PIL-PA-01', '120275422266100555': 'PIL-PA-02',
  '120275421929330555': 'PIL-PA-03', '120275422266130555': 'PIL-PA-04',
  '120275421929340555': 'PIL-PR-01', '120275422266170555': 'PIL-PR-02',
  '120275422266160555': 'PIL-PR-03', '120275422266150555': 'PIL-PR-04',
  '120275422266110555': 'PIL-SA-01', '120275422266120555': 'PIL-SA-02',
  '120275422266140555': 'PIL-SA-03', '120275421929310555': 'PIL-SA-04',
  '120275421929320555': 'PIL-VID-01',
});
const FIELDS = new Set(['version', 'query', 'data', 'groups', 'rows', 'values', 'count', 'visitors', 'eventData', 'ad_id', 'campaign_id', 'timestamp', 'eventName', 'projectId', 'environment']);
const knownFields = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.keys(value).filter(key => FIELDS.has(key)).sort() : [];
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const filterFor = (event, campaignKey = 'original') => `environment eq 'production' and eventName eq '${event}' and eventData/campaign_id eq '${trackingContract(campaignKey).campaign}'`;
const httpError = status => status === 401 ? 'ANALYTICS_LOGIN_REQUIRED' : status === 403 ? 'ANALYTICS_PERMISSION_REQUIRED' : status === 402 ? 'ANALYTICS_PLAN_REQUIRED' : status === 429 ? 'ANALYTICS_RATE_LIMITED' : status >= 500 ? 'ANALYTICS_UNAVAILABLE' : 'ANALYTICS_READ_FAILED';

/** Public date diagnostics only; no permissive Date.parse fallback for text. */
export function safeQueryBound(value) {
  const rejected = { valid: false, input_type: kind(value) };
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const parsed = Date.parse(`${value}T00:00:00.000Z`);
      return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
        ? { valid: true, format: 'utc_date', value } : rejected;
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value)) {
      const parsed = Date.parse(value);
      // Validate the calendar and clock without rounding away the API's exact
      // fractional representation. Invalid 24:00/Feb 30 strings cannot pass.
      if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19))
        return { valid: true, format: 'utc_iso', value };
    }
  } else if (Number.isSafeInteger(value) && value >= Date.UTC(2000, 0, 1) && value < Date.UTC(2100, 0, 1)) {
    // The documented numeric form is converted into a UTC ISO value, never
    // echoed as an arbitrary identifier-shaped number.
    return { valid: true, format: 'epoch_milliseconds_as_utc_iso', value: new Date(value).toISOString() };
  }
  return rejected;
}

export function requestedWindow(now) {
  if (!Number.isFinite(now?.getTime?.())) throw new Error('PREFLIGHT_INVALID_TIME');
  const until = now.getTime(), day = now.toISOString().slice(0, 10);
  return { day, since: Date.parse(`${day}T00:00:00.000Z`), until,
    rounded_until: Math.floor(until / 3600000) * 3600000 + 3600000 };
}
function boundaryMilliseconds(value) {
  const echo = safeQueryBound(value);
  if (!echo.valid) return null;
  // Extra fractional digits may be safely displayed, but nonzero sub-ms
  // precision must not silently round into an accepted exact boundary.
  if (typeof value === 'string') {
    const fraction = value.match(/\.(\d+)(?:Z|\+00:00)$/)?.[1];
    if (fraction && /[1-9]/.test(fraction.slice(3))) return null;
  }
  return Date.parse(echo.value);
}
function queryChecks(query, window, filter) {
  const since = boundaryMilliseconds(query?.since), until = boundaryMilliseconds(query?.until);
  const untilMode = until === window.until ? 'exact_request'
    : until === window.rounded_until ? 'derived_next_utc_hour' : null;
  return {
    present: Boolean(query && typeof query === 'object' && !Array.isArray(query)),
    since: since === window.since,
    // Accept only the exact timestamp requested or the precisely derived
    // inclusive-hour boundary supported by the actual passive readback.
    until: untilMode !== null,
    until_mode: untilMode,
    filter: query?.filter === filter,
    group: !Object.hasOwn(query || {}, 'groupBy') ? 'absent' : JSON.stringify(query.groupBy) === '["eventData/ad_id"]' ? 'matches' : 'different',
    limit: !Object.hasOwn(query || {}, 'limit') ? null : query.limit === 32 || query.limit === '32',
  };
}

/** Sanitize first; never return the response, arbitrary keys, or error text. */
export function inspectAggregate(body, { window, event, campaignKey = 'original' }) {
  const contract = trackingContract(campaignKey), ads = contract.ads;
  const day = window.day;
  const checks = queryChecks(body?.query, window, filterFor(event, campaignKey));
  const rows = Array.isArray(body?.data) ? body.data : null;
  const summary = {
    api_version: Number.isSafeInteger(body?.version) && body.version >= 0 && body.version <= 10000 ? body.version : null,
    known_top_fields: knownFields(body), data_type: kind(body?.data),
    known_data_fields: knownFields(body?.data),
    known_row_fields: rows ? [...new Set(rows.slice(0, 32).flatMap(knownFields))].sort() : [],
    known_event_data_fields: rows ? [...new Set(rows.slice(0, 32).flatMap(row => knownFields(row?.eventData)))].sort() : [],
    query_checks: checks,
    // Representation diagnosis does not alter any acceptance check below.
    query_bound_echo: { since: safeQueryBound(body?.query?.since), until: safeQueryBound(body?.query?.until) },
  };
  const invalid = error => ({ ...summary, status: 'error', error, rows: [], event_reception_proven: false });
  if (body?.version !== 1 || !rows || rows.length > 32) return invalid('PREFLIGHT_RESPONSE_SHAPE_UNVALIDATED');
  if (!checks.present || !checks.since || !checks.until || !checks.filter || checks.group === 'different' || checks.limit === false)
    return invalid('PREFLIGHT_QUERY_MISMATCH');
  if (body.paging || body.pagination || body.nextPage) return invalid('PREFLIGHT_INCOMPLETE_RESPONSE');
  const safeRows = [], seen = new Set();
  for (const row of rows) {
    // Both representations are safe to diagnose. The preflight reports their
    // kinds above; a future source normalizer still needs a real read review.
    const id = typeof row?.eventData === 'string' ? row.eventData : row?.eventData?.ad_id;
    if (typeof id !== 'string' || !Object.hasOwn(ads, id) || seen.has(id) ||
        (row.projectId !== undefined && row.projectId !== PROJECT) ||
        (row.environment !== undefined && row.environment !== 'production') ||
        (row.eventName !== undefined && row.eventName !== event) ||
        (row.eventData && typeof row.eventData === 'object' && row.eventData.campaign_id !== undefined && row.eventData.campaign_id !== contract.campaign))
      return invalid('PREFLIGHT_SCOPE_MISMATCH');
    if (row.timestamp !== undefined && (typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp)) || new Date(row.timestamp).toISOString().slice(0, 10) !== day))
      return invalid('PREFLIGHT_PERIOD_MISMATCH');
    if (!safeCount(row.count) || !safeCount(row.visitors) || row.visitors > row.count)
      return invalid('PREFLIGHT_METRIC_SHAPE_UNVALIDATED');
    seen.add(id);
    safeRows.push({ ad_id: id, code: ads[id], count: row.count, visitors: row.visitors });
  }
  return { ...summary, status: safeRows.length ? 'aggregate_read_validated' : 'awaiting_events', error: null,
    rows: safeRows, event_reception_proven: safeRows.some(row => row.count > 0) };
}

export async function runDiyPreflight({ token, fetcher = fetch, now = new Date() } = {}) {
  const window = requestedWindow(now), day = window.day;
  const report = { status: 'not_configured', checked_at: now.toISOString(), timezone: 'UTC', day,
    requested_window: { since_utc: new Date(window.since).toISOString(), until_utc: now.toISOString(),
      derived_hour_boundary_utc: new Date(window.rounded_until).toISOString() },
    scope: { site: 'start.chatline.app', project: PROJECT, team: TEAM, campaign: CAMPAIGN, approved_ads: 13 },
    snapshot_written: false, published: false, events_generated: false, results: [] };
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) return { ...report, error: 'ANALYTICS_NOT_CONFIGURED' };
  for (const event of EVENTS) {
    const url = new URL(ENDPOINT), filter = filterFor(event);
    for (const [key, value] of Object.entries({ projectId: PROJECT, teamId: TEAM, since: window.since, until: window.until, by: 'eventData/ad_id', limit: '32', filter }))
      url.searchParams.set(key, value);
    // This is the fixed requested query, never an echo of arbitrary API text.
    const request = { event, since: window.since, until: window.until, by: 'eventData/ad_id', limit: 32, filter };
    let response;
    try {
      response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${token.trim()}` }, redirect: 'error', signal: AbortSignal.timeout(12000) });
    } catch {
      report.results.push({ request, status: 'error', error: 'ANALYTICS_UNAVAILABLE', http_status: null, rows: [], event_reception_proven: false }); continue;
    }
    const http_status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
    if (!response.ok) {
      // An error body may contain private request details. Never parse/log it.
      report.results.push({ request, status: 'error', error: httpError(http_status), http_status, rows: [], event_reception_proven: false }); continue;
    }
    let body;
    try { body = await response.json(); }
    catch { report.results.push({ request, status: 'error', error: 'ANALYTICS_INVALID_JSON', http_status, rows: [], event_reception_proven: false }); continue; }
    report.results.push({ request, http_status, ...inspectAggregate(body, { window, event }) });
  }
  report.status = report.results.some(row => row.status === 'error') ? 'failed'
    : report.results.some(row => row.rows.length) ? 'aggregate_reads_validated' : 'awaiting_events';
  report.event_reception_proven = report.results.some(row => row.event_reception_proven);
  return report;
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== 'Niko76x/chatline-pulse' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    throw new Error('PREFLIGHT_EXECUTION_NOT_ALLOWED');
  const result = await runDiyPreflight({ token: process.env.VERCEL_ANALYTICS_LIMITLESS_TOKEN });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed' || result.status === 'not_configured') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const safe = ['PREFLIGHT_INVALID_TIME', 'PREFLIGHT_EXECUTION_NOT_ALLOWED'].includes(error?.message) ? error.message : 'PREFLIGHT_FAILED';
    process.stdout.write(`${JSON.stringify({ status: 'failed', error: safe, snapshot_written: false, published: false, events_generated: false })}\n`);
    process.exitCode = 1;
  });
}
