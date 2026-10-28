// Server-side sidecar. This module never follows an ad destination or sends events.
// The inspector is pure; its guarded CLI cannot run when imported by this module.
import { VERSION, FIELDS, TAG_KEYS, inspectAdDestination } from '../scripts/meta-destination-preflight.mjs';
import { trackingContract } from './tracking-contracts.mjs';

export const LINK_AUDIT_SOURCE = 'meta_ad_destination_checks';
export const LINK_AUDIT_CHECKS = Object.freeze(['scope_validated', 'destination_present', 'format_supported',
  'landing_keys_in_url_tags_absent', 'https_domain', 'root_path', 'skin', 'ref', 'no_fragment', 'unique_query_keys', 'effective_utm_contract']);
// Only generic parameter names actually approved for this source. Values are never retained.
export const LINK_AUDIT_EXTRA_KEYS = Object.freeze({ utm_id: 'optional_utm', hsa_acc: 'crm_tracking', hsa_cam: 'crm_tracking',
  hsa_grp: 'crm_tracking', hsa_ad: 'crm_tracking', hsa_src: 'crm_tracking', hsa_net: 'crm_tracking', hsa_ver: 'crm_tracking' });
const ERRORS = new Set(['META_NOT_CONFIGURED', 'META_VERSION_NOT_ALLOWED', 'META_LOGIN_REQUIRED', 'META_PERMISSION_REQUIRED',
  'META_RATE_LIMITED', 'META_UNAVAILABLE', 'META_READ_FAILED', 'META_INVALID_RESPONSE', 'META_SCOPE_MISMATCH',
  'META_AUDIT_DEADLINE', 'DESTINATION_CONFIG_REVIEW_REQUIRED']);
const ROW_STATES = new Set(['valid', 'core_verified_extra_review', 'needs_review', 'read_error', 'pending']);
const SOURCE_STATES = new Set(['pending', 'connected', 'partial', 'error']);
const nulls = keys => Object.fromEntries(keys.map(key => [key, null]));
const iso = value => value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const count = (value, maximum = 13) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const booleans = (value, keys) => exactKeys(value, keys) && Object.values(value).every(v => v === null || typeof v === 'boolean');
const allTrue = value => Object.values(value).every(v => v === true);
const safeError = error => ERRORS.has(error) ? error : 'META_READ_FAILED';

export function assertLinkAuditScope(scope, ids, { campaignKey = 'original' } = {}) {
  const contract = trackingContract(campaignKey);
  if (scope?.account !== contract.account || scope?.campaign !== contract.campaign || scope?.adset !== contract.adset ||
      Object.keys(ids || {}).length !== Object.keys(contract.ads).length || Object.entries(contract.ads).some(([id, code]) => ids[id] !== code)) throw new Error('LINK_AUDIT_SCOPE_MISMATCH');
}
export function pendingLinkAuditRow(id, { campaignKey = 'original' } = {}) {
  const ads = trackingContract(campaignKey).ads;
  if (!Object.hasOwn(ads, id)) throw new Error('LINK_AUDIT_SCOPE_MISMATCH');
  return { ad_id: id, code: ads[id], status: 'pending', checked_at: null, attempted_at: null,
    checks: nulls(LINK_AUDIT_CHECKS), tag_checks: nulls(TAG_KEYS), extra_keys: [], unrecognized_extra_key_count: null, error: null };
}
export function validateLinkAudit(source, { campaignKey = 'original' } = {}) {
  const ads = trackingContract(campaignKey).ads, size = Object.keys(ads).length;
  const fail = () => { throw new Error('SNAPSHOT_INVALID_LINK_AUDIT'); };
  if (!exactKeys(source, ['source_code', 'status', 'observed_at', 'attempted_at', 'error', 'complete', 'checked_count', 'request_count', 'ads']) ||
      source.source_code !== LINK_AUDIT_SOURCE || !SOURCE_STATES.has(source.status) || !iso(source.observed_at) || !iso(source.attempted_at) ||
      ![null, 'LINK_AUDIT_PARTIAL_FAILURE', 'LINK_AUDIT_READ_FAILED'].includes(source.error) || typeof source.complete !== 'boolean' ||
      !count(source.checked_count, size) || !count(source.request_count, size) || source.checked_count > source.request_count ||
      !Array.isArray(source.ads) || source.ads.length !== size || new Set(source.ads.map(row => row.ad_id)).size !== size) fail();
  for (const row of source.ads) {
    if (!exactKeys(row, ['ad_id', 'code', 'status', 'checked_at', 'attempted_at', 'checks', 'tag_checks', 'extra_keys', 'unrecognized_extra_key_count', 'error']) ||
        !Object.hasOwn(ads, row.ad_id) || ads[row.ad_id] !== row.code || !ROW_STATES.has(row.status) || !iso(row.checked_at) || !iso(row.attempted_at) ||
        !booleans(row.checks, LINK_AUDIT_CHECKS) || !booleans(row.tag_checks, TAG_KEYS) ||
        !Array.isArray(row.extra_keys) || row.extra_keys.length > Object.keys(LINK_AUDIT_EXTRA_KEYS).length ||
        new Set(row.extra_keys.map(item => item.key)).size !== row.extra_keys.length ||
        row.extra_keys.some(item => !exactKeys(item, ['key', 'category']) || !Object.hasOwn(LINK_AUDIT_EXTRA_KEYS, item.key) || LINK_AUDIT_EXTRA_KEYS[item.key] !== item.category) ||
        !(row.unrecognized_extra_key_count === null || Number.isSafeInteger(row.unrecognized_extra_key_count) && row.unrecognized_extra_key_count >= 0 && row.unrecognized_extra_key_count <= 4096) ||
        !(row.error === null || ERRORS.has(row.error))) fail();
    if (row.checked_at && (!row.attempted_at || row.checked_at > row.attempted_at) || row.attempted_at !== source.attempted_at) fail();
    if (['valid', 'core_verified_extra_review', 'needs_review'].includes(row.status) && (!row.checked_at || row.checked_at !== row.attempted_at)) fail();
    if (row.status === 'pending' && (row.checked_at || row.attempted_at || row.error || row.extra_keys.length || row.unrecognized_extra_key_count !== null ||
        Object.values(row.checks).some(value => value !== null) || Object.values(row.tag_checks).some(value => value !== null))) fail();
    if (['valid', 'core_verified_extra_review'].includes(row.status) && (!allTrue(row.checks) || !allTrue(row.tag_checks) || row.unrecognized_extra_key_count !== 0 || row.error !== null)) fail();
    if (row.status === 'valid' && row.extra_keys.length || row.status === 'core_verified_extra_review' && !row.extra_keys.length) fail();
    if (row.status === 'read_error' && (!row.attempted_at || !row.error) || row.status === 'needs_review' && row.error !== 'DESTINATION_CONFIG_REVIEW_REQUIRED') fail();
  }
  const fresh = source.ads.filter(row => row.checked_at === source.attempted_at && !['read_error', 'pending'].includes(row.status)).length;
  if (fresh !== source.checked_count || source.complete !== (fresh === size) ||
      source.status === 'connected' && (!source.complete || source.observed_at !== source.attempted_at || source.error) ||
      source.status === 'partial' && (fresh === 0 || fresh === size || source.error !== 'LINK_AUDIT_PARTIAL_FAILURE') ||
      source.status === 'error' && (fresh !== 0 || source.error !== 'LINK_AUDIT_READ_FAILED') ||
      source.status === 'pending' && (source.attempted_at || source.observed_at || source.request_count || source.checked_count || source.error) ||
      source.status !== 'pending' && !source.attempted_at || source.observed_at && (!source.attempted_at || source.observed_at > source.attempted_at)) fail();
  return source;
}

function inspectForSnapshot(body, id, at, campaignKey = 'original') {
  const ads = trackingContract(campaignKey).ads;
  const result = inspectAdDestination(body, id, { campaignKey });
  if (!result.scope_validated) throw new Error('META_SCOPE_MISMATCH');
  const destinations = result.destinations, checks = nulls(LINK_AUDIT_CHECKS);
  checks.scope_validated = true;
  checks.destination_present = destinations.length > 0;
  checks.format_supported = !result.failures.includes('UNSUPPORTED_DESTINATION_FORMAT');
  checks.landing_keys_in_url_tags_absent = !result.failures.includes('LANDING_KEYS_IN_URL_TAGS');
  for (const key of LINK_AUDIT_CHECKS.slice(4)) checks[key] = destinations.length ? destinations.every(row => row.checks?.[key] === true) : null;
  const tag_checks = Object.fromEntries(TAG_KEYS.map(key => [key, destinations.length ? destinations.every(row => row.tag_checks?.[key] === true) : null]));
  const reports = [result.url_tags, ...destinations].filter(Boolean), extras = new Set();
  let unknown = 0;
  for (const report of reports) {
    let unapproved = 0;
    for (const extra of report.recognized_extra_keys || []) {
      if (Object.hasOwn(LINK_AUDIT_EXTRA_KEYS, extra.name)) extras.add(extra.name); else unapproved++;
    }
    // Maximum per inspected effective destination/tag field, not distinct names across fields.
    unknown = Math.max(unknown, (report.unrecognized_extra_key_count || 0) + unapproved);
  }
  const extra_keys = Object.keys(LINK_AUDIT_EXTRA_KEYS).filter(key => extras.has(key)).map(key => ({ key, category: LINK_AUDIT_EXTRA_KEYS[key] }));
  const core = allTrue(checks) && allTrue(tag_checks);
  const status = core && unknown === 0 ? extra_keys.length ? 'core_verified_extra_review' : 'valid' : 'needs_review';
  return { ad_id: id, code: ads[id], status, checked_at: at, attempted_at: at, checks, tag_checks, extra_keys,
    unrecognized_extra_key_count: Math.min(4096, unknown), error: status === 'needs_review' ? 'DESTINATION_CONFIG_REVIEW_REQUIRED' : null };
}
function classify(http, body) {
  const code = body?.error?.code;
  if (http === 401 || code === 190) return 'META_LOGIN_REQUIRED';
  if (http === 403 || [10, 200, 294].includes(code)) return 'META_PERMISSION_REQUIRED';
  if (http === 429 || [4, 17, 32, 613].includes(code)) return 'META_RATE_LIMITED';
  return http >= 500 ? 'META_UNAVAILABLE' : 'META_READ_FAILED';
}
function bounded(value, fallback, max) { return Number.isInteger(value) && value >= 1 && value <= max ? value : fallback; }

// Exactly the selected contract's 13 or 5 direct GETs. No pagination, retries,
// caller-supplied paths, campaign definitions or destination follows.
export async function collectLinkAudit({ enabled = false, token, version = VERSION, fetcher = fetch, now = new Date(),
  deadlineMs = 45000, requestTimeoutMs = 8000, concurrency = 3, campaignKey = 'original' } = {}) {
  const contract = trackingContract(campaignKey);
  if (!enabled) return null;
  if (!Number.isFinite(now?.getTime?.())) throw new Error('LINK_AUDIT_INVALID_TIME');
  const at = now.toISOString(), ids = Object.keys(contract.ads), rows = new Array(ids.length), deadline = performance.now() + bounded(deadlineMs, 45000, 45000);
  const timeout = bounded(requestTimeoutMs, 8000, 8000), workers = bounded(concurrency, 3, 3);
  const configError = typeof token !== 'string' || !token.trim() || token.length > 4096 ? 'META_NOT_CONFIGURED' : version !== VERSION ? 'META_VERSION_NOT_ALLOWED' : null;
  let cursor = 0, request_count = 0;
  const failed = (id, error) => ({ ...pendingLinkAuditRow(id, { campaignKey }), status: 'read_error', attempted_at: at, error: safeError(error) });
  async function readOne(id) {
    if (configError) return failed(id, configError);
    const remaining = deadline - performance.now();
    if (remaining <= 0) return failed(id, 'META_AUDIT_DEADLINE');
    const controller = new AbortController(); let timer;
    try {
      const task = (async () => {
        const url = new URL(`https://graph.facebook.com/${VERSION}/${id}`); url.searchParams.set('fields', FIELDS);
        request_count++;
        const response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${token.trim()}` }, redirect: 'error', signal: controller.signal });
        let body;
        try { body = await response.json(); }
        catch { throw new Error(response.ok ? 'META_INVALID_RESPONSE' : classify(response.status)); }
        if (!response.ok || body?.error) throw new Error(classify(response.status, body));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('META_INVALID_RESPONSE');
        return inspectForSnapshot(body, id, at, campaignKey);
      })();
      const limit = Math.min(timeout, remaining);
      const expiry = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(limit === remaining ? 'META_AUDIT_DEADLINE' : 'META_UNAVAILABLE')); }, Math.ceil(limit)); });
      return await Promise.race([task, expiry]);
    } catch (error) { return failed(id, error?.message); }
    finally { clearTimeout(timer); }
  }
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < ids.length) { const index = cursor++; rows[index] = await readOne(ids[index]); }
  }));
  return { attempted_at: at, request_count, ads: rows };
}

export function mergeLinkAudit(previous, result, { campaignKey = 'original' } = {}) {
  const size = Object.keys(trackingContract(campaignKey).ads).length;
  if (previous) validateLinkAudit(previous, { campaignKey });
  const oldRows = previous?.ads || [];
  const ads = result.ads.map(row => {
    if (row.status !== 'read_error') return row;
    const old = oldRows.find(item => item.ad_id === row.ad_id) || pendingLinkAuditRow(row.ad_id, { campaignKey });
    return { ...old, status: 'read_error', attempted_at: result.attempted_at, error: safeError(row.error) };
  });
  const checked_count = ads.filter(row => row.status !== 'read_error' && row.checked_at === result.attempted_at).length;
  return validateLinkAudit({ source_code: LINK_AUDIT_SOURCE, status: checked_count === size ? 'connected' : checked_count ? 'partial' : 'error',
    observed_at: checked_count === size ? result.attempted_at : previous?.observed_at || null,
    attempted_at: result.attempted_at, complete: checked_count === size, checked_count, request_count: result.request_count,
    error: checked_count === size ? null : checked_count ? 'LINK_AUDIT_PARTIAL_FAILURE' : 'LINK_AUDIT_READ_FAILED', ads }, { campaignKey });
}
// Attempt bookkeeping is separate from configuration completeness. Do not hammer
// failed metadata endpoints again in the same intended half-hour slot.
export function linkAuditAttemptedInSlot(source, { slot, now = new Date() } = {}) {
  const start = Date.parse(slot), attempted = Date.parse(source?.attempted_at), current = now.getTime();
  return source?.source_code === LINK_AUDIT_SOURCE && Number.isFinite(start) && Number.isFinite(attempted) &&
    attempted >= start && attempted < start + 1800000 && attempted <= current;
}
