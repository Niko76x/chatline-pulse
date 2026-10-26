// Server-only, fixed-project aggregate reader. Importing the reviewed manual
// preflight shares its pure window/response checks, not its guarded CLI entry.
import { PROJECT, TEAM, CAMPAIGN, ADS, EVENTS, ENDPOINT, requestedWindow, inspectAggregate } from '../scripts/diy-funnel-preflight.mjs';

export const COLLECTION_STARTED_AT = '2026-10-26T02:30:39Z';
export const SOURCE_CODE = 'vercel_diy_events_production';
export const REQUEST_TIMEOUT_MS = 6000;
export const TOTAL_TIMEOUT_MS = 55000;
export const RETENTION_DAYS = 366;
export const METRICS = Object.freeze(['studio_started', 'call_requested', 'checkout_started', 'dashboard_activated']);
const EVENT_KEYS = Object.freeze({ diy_studio_started: 'studio_started', diy_call_requested: 'call_requested',
  diy_checkout_started: 'checkout_started', diy_dashboard_activated: 'dashboard_activated' });
const CODES = new Set(Object.values(ADS));
const START_DAY = COLLECTION_STARTED_AT.slice(0, 10);
const SOURCE_KEYS = new Set(['source_code','site','campaign','timezone','collection_started_at','status','observed_at','attempted_at','period','daily','error']);
const ROW_KEYS = new Set(['date','code',...METRICS]);
const ERRORS = new Set(['DIY_NOT_CONFIGURED','DIY_SCOPE_MISMATCH','DIY_TIMEOUT','DIY_UNAVAILABLE','DIY_LOGIN_REQUIRED',
  'DIY_PERMISSION_REQUIRED','DIY_PLAN_REQUIRED','DIY_RATE_LIMITED','DIY_READ_FAILED','DIY_INVALID_JSON','DIY_QUERY_MISMATCH',
  'DIY_RESPONSE_INVALID','DIY_METRIC_INVALID','DIY_PERIOD_INVALID','DIY_COLLECTION_NOT_STARTED','DIY_SOURCE_INVALID','DIY_CLOCK_INVALID']);
export class DiyFunnelError extends Error {
  constructor(code) { const safe = ERRORS.has(code) ? code : 'DIY_READ_FAILED'; super(safe); this.code = safe; }
}
const fail = code => { throw new DiyFunnelError(code); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.has(key));
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19) === value.slice(0,19);
const count = value => value === null || Number.isSafeInteger(value) && value >= 0;
function safeCode(error) {
  const value = typeof error === 'string' ? error : error?.code;
  return ERRORS.has(value) ? value : 'DIY_READ_FAILED';
}
function assertScope() {
  if (PROJECT !== 'prj_cKWblSdgOD2QY0tUExAkoqB3Z5jH' || TEAM !== 'team_i2XlerNOfSTLE5EGj65B1vau' ||
      CAMPAIGN !== '120274644271350555' || Object.keys(ADS).length !== 13 || CODES.size !== 13 ||
      JSON.stringify(EVENTS) !== JSON.stringify(Object.keys(EVENT_KEYS))) fail('DIY_SCOPE_MISMATCH');
}
function checkedNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('DIY_CLOCK_INVALID');
  return now.toISOString();
}
function base(now) {
  return { source_code: SOURCE_CODE, site: 'start.chatline.app', campaign: CAMPAIGN, timezone: 'UTC',
    collection_started_at: COLLECTION_STARTED_AT, status: 'error', observed_at: null,
    attempted_at: checkedNow(now), period: null, daily: [], error: null };
}

/** Optional-source validator; it also rejects arbitrary fields/strings. */
export function validateDiyFunnelSource(source) {
  if (!exactKeys(source, SOURCE_KEYS) || Object.keys(source).length !== SOURCE_KEYS.size ||
      source.source_code !== SOURCE_CODE || source.site !== 'start.chatline.app' || source.campaign !== CAMPAIGN ||
      source.timezone !== 'UTC' || source.collection_started_at !== COLLECTION_STARTED_AT ||
      !['awaiting_events','connected','error'].includes(source.status) || !validTimestamp(source.attempted_at) ||
      source.observed_at !== null && !validTimestamp(source.observed_at) || !Array.isArray(source.daily) || source.daily.length > 13 * RETENTION_DAYS)
    fail('DIY_SOURCE_INVALID');
  if (source.observed_at !== null && (Date.parse(source.observed_at) < Date.parse(COLLECTION_STARTED_AT) ||
      Date.parse(source.observed_at) > Date.parse(source.attempted_at))) fail('DIY_SOURCE_INVALID');
  if (source.status === 'error' ? !ERRORS.has(source.error) : source.error !== null || source.observed_at === null)
    fail('DIY_SOURCE_INVALID');
  if (source.period === null) {
    if (source.status !== 'error' || source.observed_at !== null || source.daily.length) fail('DIY_SOURCE_INVALID');
  } else if (!exactKeys(source.period, new Set(['from','to'])) || Object.keys(source.period).length !== 2 ||
      !validDate(source.period.from) || !validDate(source.period.to) || source.period.from < START_DAY ||
      source.period.from > source.period.to || source.period.to > source.attempted_at.slice(0,10) ||
      Date.parse(source.period.to) - Date.parse(source.period.from) > (RETENTION_DAYS - 1) * 86400000) fail('DIY_SOURCE_INVALID');
  const seen = new Set();
  for (const row of source.daily) {
    const key = `${row?.date}:${row?.code}`;
    if (!exactKeys(row, ROW_KEYS) || Object.keys(row).length !== ROW_KEYS.size || !validDate(row.date) || !CODES.has(row.code) ||
        !source.period || row.date < source.period.from || row.date > source.period.to || seen.has(key) ||
        !METRICS.every(metric => count(row[metric])) || METRICS.every(metric => row[metric] === null)) fail('DIY_SOURCE_INVALID');
    seen.add(key);
  }
  if (source.status === 'awaiting_events' && source.daily.length || source.status === 'connected' && !source.daily.length)
    fail('DIY_SOURCE_INVALID');
  return source;
}

function queryWindows(now) {
  if (now.getTime() < Date.parse(COLLECTION_STARTED_AT)) fail('DIY_COLLECTION_NOT_STARTED');
  const current = requestedWindow(now);
  const previousEnd = new Date(current.since - 1);
  return previousEnd.toISOString().slice(0,10) >= START_DAY ? [requestedWindow(previousEnd), current] : [current];
}
function responseError(status) {
  return status === 401 ? 'DIY_LOGIN_REQUIRED' : status === 403 ? 'DIY_PERMISSION_REQUIRED' : status === 402 ? 'DIY_PLAN_REQUIRED'
    : status === 429 ? 'DIY_RATE_LIMITED' : status >= 500 ? 'DIY_UNAVAILABLE' : 'DIY_READ_FAILED';
}
async function readJson(url, token, fetcher, milliseconds) {
  if (milliseconds <= 0) fail('DIY_TIMEOUT');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new DiyFunnelError('DIY_TIMEOUT')); }, milliseconds);
  });
  const read = (async () => {
    let response;
    try { response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: controller.signal }); }
    catch { fail('DIY_UNAVAILABLE'); }
    if (!response.ok) fail(responseError(response.status));
    try { return await response.json(); }
    catch { fail('DIY_INVALID_JSON'); }
  })();
  try { return await Promise.race([read, timeout]); }
  finally { clearTimeout(timer); }
}
function normalize(body, window, event) {
  // Empty-v1 responses have been observed live. Positive rows use only the
  // documented flat ad-group shape; future/unknown formats remain an error.
  const rowFields = new Set(['eventData','count','visitors','projectId','environment','eventName','timestamp']);
  if (Array.isArray(body?.data) && body.data.some(row => !exactKeys(row, rowFields) || typeof row.eventData !== 'string'))
    fail('DIY_RESPONSE_INVALID');
  let inspected;
  try { inspected = inspectAggregate(body, { window, event }); }
  catch { fail('DIY_RESPONSE_INVALID'); }
  if (inspected.status === 'error') {
    const map = { PREFLIGHT_QUERY_MISMATCH: 'DIY_QUERY_MISMATCH', PREFLIGHT_SCOPE_MISMATCH: 'DIY_SCOPE_MISMATCH',
      PREFLIGHT_METRIC_SHAPE_UNVALIDATED: 'DIY_METRIC_INVALID', PREFLIGHT_PERIOD_MISMATCH: 'DIY_PERIOD_INVALID' };
    fail(map[inspected.error] || 'DIY_RESPONSE_INVALID');
  }
  return inspected.rows;
}

/** Four or eight GETs, no retry; no single-source result escapes on failure. */
export async function collectDiyFunnel({ token, fetcher = fetch, now = new Date() } = {}) {
  assertScope(); checkedNow(now);
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) fail('DIY_NOT_CONFIGURED');
  const windows = queryWindows(now), deadline = performance.now() + TOTAL_TIMEOUT_MS;
  const rows = new Map();
  for (const window of windows) for (const event of EVENTS) {
    const url = new URL(ENDPOINT);
    const filter = `environment eq 'production' and eventName eq '${event}' and eventData/campaign_id eq '${CAMPAIGN}'`;
    for (const [key, value] of Object.entries({ projectId: PROJECT, teamId: TEAM, since: window.since, until: window.until,
      by: 'eventData/ad_id', limit: '32', filter })) url.searchParams.set(key, value);
    const remaining = Math.min(REQUEST_TIMEOUT_MS, deadline - performance.now());
    const body = await readJson(url, token.trim(), fetcher, remaining);
    for (const entry of normalize(body, window, event)) {
      const key = `${window.day}:${entry.code}`;
      const row = rows.get(key) || { date: window.day, code: entry.code, ...Object.fromEntries(METRICS.map(metric => [metric, null])) };
      row[EVENT_KEYS[event]] = entry.count;
      rows.set(key, row);
    }
  }
  const stamp = now.toISOString();
  return validateDiyFunnelSource({ ...base(now), status: rows.size ? 'connected' : 'awaiting_events', observed_at: stamp,
    period: { from: windows[0].day, to: windows.at(-1).day },
    daily: [...rows.values()].sort((a,b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code)), error: null });
}

/** On failure, old counts/period/observation survive verbatim; no fake zeros. */
export function mergeDiyFunnel(previous, result, { now = new Date(), error = null } = {}) {
  const stamp = checkedNow(now);
  if (previous !== undefined && previous !== null) validateDiyFunnelSource(previous);
  if (error !== null) {
    if (result) fail('DIY_SOURCE_INVALID');
    const next = previous ? structuredClone(previous) : base(now);
    next.status = 'error'; next.error = safeCode(error); next.attempted_at = stamp;
    return validateDiyFunnelSource(next);
  }
  if (!result) return previous;
  validateDiyFunnelSource(result);
  if (result.status === 'error') fail('DIY_SOURCE_INVALID');
  if (!previous) return structuredClone(result);
  // The new successful query fully replaces its re-read dates. Omitted event
  // rows become null/absent, rather than being labelled fresh historical data.
  const lower = new Date(Date.parse(result.period.to) - (RETENTION_DAYS - 1) * 86400000).toISOString().slice(0,10);
  const earliest = lower < START_DAY ? START_DAY : lower;
  const retained = previous.daily.filter(row => row.date >= earliest && (row.date < result.period.from || row.date > result.period.to));
  const daily = [...retained, ...result.daily].sort((a,b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
  return validateDiyFunnelSource({ ...structuredClone(result), status: daily.length ? 'connected' : 'awaiting_events',
    period: { from: previous.period && previous.period.from < result.period.from
      ? (previous.period.from < earliest ? earliest : previous.period.from) : result.period.from,
      to: result.period.to }, daily });
}
