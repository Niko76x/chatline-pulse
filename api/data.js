import { TRAFFIC, TRAFFIC_AD_IDS, CRM, CRM_AD_IDS, LOOKALIKE, LOOKALIKE_AD_IDS } from '../public/assets/campaigns.js';
import { ADS as DIY_AD_IDS } from '../scripts/diy-funnel-preflight.mjs';
import { collectDiyFunnel, validateDiyFunnelSource, mergeDiyFunnel } from '../lib/diy-funnel.mjs';
import { assertLinkAuditScope, validateLinkAudit, collectLinkAudit, mergeLinkAudit, linkAuditAttemptedInSlot } from '../lib/link-audit.js';
import { validateCsvMetaSource, csvMetaIsProtected } from '../lib/csv-meta.mjs';

// These are reviewed ChatLine assets. Request parameters cannot change them.
export const SCOPE = Object.freeze({
  account: '2128240694419507',
  dataset: '1727278251668513',
  campaign: '120274644271350555',
  adset: '120275421779190555',
  repository: 'Niko76x/chatline-pulse',
  dataBranch: 'pulse-data',
  since: '2026-10-22',
});
export const AD_IDS = Object.freeze({
  '120275421779180555': 'PIL-PA-01', '120275422266100555': 'PIL-PA-02',
  '120275421929330555': 'PIL-PA-03', '120275422266130555': 'PIL-PA-04',
  '120275421929340555': 'PIL-PR-01', '120275422266170555': 'PIL-PR-02',
  '120275422266160555': 'PIL-PR-03', '120275422266150555': 'PIL-PR-04',
  '120275422266110555': 'PIL-SA-01', '120275422266120555': 'PIL-SA-02',
  '120275422266140555': 'PIL-SA-03', '120275421929310555': 'PIL-SA-04',
  '120275421929320555': 'PIL-VID-01',
});
const META_COHORTS = Object.freeze([
  Object.freeze({ key: 'meta_traffic', scope: TRAFFIC, ids: TRAFFIC_AD_IDS, since: SCOPE.since }),
  Object.freeze({ key: 'meta_crm', scope: CRM, ids: CRM_AD_IDS, since: '2026-10-28' }),
  Object.freeze({ key: 'meta_lookalike', scope: LOOKALIKE, ids: LOOKALIKE_AD_IDS, since: '2026-10-28' }),
]);
function metaContract(scope) {
  if (scope === SCOPE) return { scope: SCOPE, ids: AD_IDS, since: SCOPE.since };
  const contract = META_COHORTS.find(item => item.scope === scope);
  if (!contract) throw new Error('SCOPE_MISMATCH');
  return contract;
}
function berlinDay(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(now); }
function metaWindowCovered(source) {
  const from = Date.parse(source.period?.from), to = Date.parse(source.period?.to), days = (to - from) / 86400000 + 1;
  return Number.isSafeInteger(days) && days > 0 && days <= 700 && source.daily?.length === days &&
    new Set(source.daily.map(row => row.date)).size === days && source.daily.every(row => Date.parse(row.date) >= from && Date.parse(row.date) <= to);
}
assertLinkAuditScope(SCOPE, AD_IDS);
assertLinkAuditScope(SCOPE, DIY_AD_IDS);
assertLinkAuditScope(TRAFFIC, TRAFFIC_AD_IDS, { campaignKey: 'traffic' });
assertLinkAuditScope(CRM, CRM_AD_IDS, { campaignKey: 'crm' });
assertLinkAuditScope(LOOKALIKE, LOOKALIKE_AD_IDS, { campaignKey: 'lookalike' });
const TRACKING_SOURCES = Object.freeze([
  Object.freeze({ campaignKey: 'original', diy: 'diy_funnel', links: 'link_audit' }),
  Object.freeze({ campaignKey: 'traffic', diy: 'diy_funnel_traffic', links: 'link_audit_traffic' }),
  Object.freeze({ campaignKey: 'crm', diy: 'diy_funnel_crm', links: 'link_audit_crm' }),
  Object.freeze({ campaignKey: 'lookalike', diy: 'diy_funnel_lookalike', links: 'link_audit_lookalike' }),
]);
// Verified in the HeyHo Systems Work profile. These are project-production
// aggregates, including the listed aliases; no host-only filter is assumed.
// Browser/environment input cannot substitute a project or enumerate the team.
export const ANALYTICS_PROJECTS = Object.freeze([
  Object.freeze({ site: 'chatline.app', projectId: 'prj_gzg9Y1fg2GOIyQFOZiifk45iahty', teamId: 'team_i2XlerNOfSTLE5EGj65B1vau', scope: 'project',
    hosts: Object.freeze(['chatline.app', 'mindbody-home.chatline.app']), label: 'Projekt chatline-website · chatline.app + mindbody-home.chatline.app' }),
  Object.freeze({ site: 'start.chatline.app', projectId: 'prj_cKWblSdgOD2QY0tUExAkoqB3Z5jH', teamId: 'team_i2XlerNOfSTLE5EGj65B1vau', scope: 'project',
    hosts: Object.freeze(['start.chatline.app']), label: 'Projekt limitless · start.chatline.app' }),
]);
export function assertScope(row, { ad = false, scope = SCOPE, ids = AD_IDS } = {}) {
  const expectedIds = metaContract(scope).ids;
  if (String(row.account_id) !== scope.account || String(row.campaign_id) !== scope.campaign ||
      String(row.adset_id ?? row.id) !== scope.adset || (ad && (!Object.hasOwn(expectedIds, String(row.ad_id ?? row.id)) || ids[String(row.ad_id ?? row.id)] !== expectedIds[String(row.ad_id ?? row.id)]))) {
    throw new Error('SCOPE_MISMATCH');
  }
  return row;
}


const ROOT = 'https://graph.facebook.com';
const ALLOWED = new Set([`act_${SCOPE.account}`, SCOPE.campaign, SCOPE.adset,
  `${SCOPE.adset}/insights`, `${SCOPE.adset}/ads`, TRAFFIC.campaign, TRAFFIC.adset, `${TRAFFIC.adset}/insights`, `${TRAFFIC.adset}/ads`, `${SCOPE.dataset}/stats`]);
for (const { scope } of META_COHORTS.slice(1)) for (const path of [scope.campaign, scope.adset, `${scope.adset}/insights`, `${scope.adset}/ads`]) ALLOWED.add(path);
export class ReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function createMetaReader({ token, version, fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!token || !/^v\d{2,3}\.\d+$/.test(version || '')) throw new ReadError('META_NOT_CONFIGURED');
  return async function read(path, params = {}) {
    if (!ALLOWED.has(path)) throw new ReadError('PATH_NOT_ALLOWED');
    const url = new URL(`${ROOT}/${version}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : value);
    // Never place the access token in URLs, logs, snapshots, or browser responses.
    const pages = []; let after; const seen = new Set();
    for (let page = 0; page < 10; page++) {
      if (after) url.searchParams.set('after', after);
      let body;
      for (let attempt = 0; attempt < 3; attempt++) {
        let response;
        try { response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
        catch { if (attempt === 2) throw new ReadError('META_UNAVAILABLE'); await sleep(400 * 2 ** attempt); continue; }
        try { body = await response.json(); } catch { throw new ReadError('META_INVALID_RESPONSE'); }
        if (response.ok && !body.error) break;
        const code = body.error?.code;
        const transient = response.status === 429 || response.status >= 500 || body.error?.is_transient;
        if (transient && attempt < 2) { await sleep(400 * 2 ** attempt); continue; }
        // Meta error messages may contain private request details. Return only classified codes.
        throw new ReadError(code === 190 ? 'META_LOGIN_REQUIRED' : [10, 200, 294].includes(code) ? 'META_PERMISSION_REQUIRED' : transient ? 'META_RATE_LIMITED' : 'META_READ_FAILED');
      }
      if (!body || typeof body !== 'object') throw new ReadError('META_INVALID_RESPONSE');
      if (!Array.isArray(body.data)) return body;
      pages.push(...body.data);
      // Rebuild the same fixed path with an opaque cursor; never follow paging.next URLs.
      after = body.paging?.next ? body.paging?.cursors?.after : null;
      if (!after) { if (body.paging?.next) throw new ReadError('META_PAGINATION_INVALID'); return pages; }
      if (seen.has(after)) throw new ReadError('META_PAGINATION_INVALID');
      seen.add(after);
    }
    throw new ReadError('META_PAGINATION_LIMIT');
  };
}
const number = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ReadError('META_INVALID_METRIC');
  return n;
};
function action(rows, key) {
  const row = rows?.find(r => r.action_type === key);
  // Missing action rows do not prove a measured zero.
  return row ? number(row.value) : null;
}
export function normalizeInsight(row, ad = false, scope = SCOPE, ids = AD_IDS) {
  assertScope(row, { ad, scope, ids });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date_start || '') || row.date_start !== row.date_stop) throw new ReadError('META_INVALID_PERIOD');
  return {
    date: row.date_start, ...(ad ? { code: ids[row.ad_id] } : {}),
    spend: number(row.spend), impressions: number(row.impressions), reach: number(row.reach),
    link_clicks: number(row.inline_link_clicks), landing_page_views: action(row.actions, 'landing_page_view'),
    studio_tests: action(row.actions, 'offsite_conversion.fb_pixel_lead'),
    call_requests: action(row.actions, 'offsite_conversion.fb_pixel_complete_registration'),
    checkouts: action(row.actions, 'offsite_conversion.fb_pixel_initiate_checkout'),
    trials: action(row.actions, 'offsite_conversion.fb_pixel_start_trial'),
  };
}
export async function collectAds(read, now = new Date(), scope = SCOPE) {
  const { ids, since } = metaContract(scope);
  const account = await read(`act_${scope.account}`, { fields: 'id,currency,timezone_name' });
  if (String(account.id).replace(/^act_/, '') !== scope.account || account.currency !== 'EUR' || account.timezone_name !== 'Europe/Berlin') throw new ReadError('ACCOUNT_CONFIG_MISMATCH');
  let today;
  try { today = new Intl.DateTimeFormat('en-CA', { timeZone: account.timezone_name }).format(now); }
  catch { throw new ReadError('ACCOUNT_CONFIG_MISMATCH'); }
  const adset = await read(scope.adset, { fields: 'id,account_id,campaign_id,effective_status,promoted_object,daily_budget' });
  assertScope(adset, { scope, ids });
  if ((scope !== TRAFFIC || adset.promoted_object?.pixel_id) && String(adset.promoted_object?.pixel_id) !== SCOPE.dataset) throw new ReadError('DATASET_MISMATCH');
  const campaign = await read(scope.campaign, { fields: 'id,account_id,daily_budget,effective_status' });
  if (String(campaign.id) !== scope.campaign || String(campaign.account_id) !== scope.account) throw new ReadError('SCOPE_MISMATCH');
  const budget = number(campaign.daily_budget) || number(adset.daily_budget);
  const params = { fields: 'account_id,campaign_id,adset_id,ad_id,date_start,date_stop,spend,impressions,reach,inline_link_clicks,actions',
    time_range: { since, until: today }, time_increment: 1,
    use_unified_attribution_setting: true, action_report_time: 'conversion', limit: 1000 };
  const [totals, ads, statuses] = await Promise.all([
    read(`${scope.adset}/insights`, { ...params, level: 'adset' }),
    read(`${scope.adset}/insights`, { ...params, level: 'ad' }),
    read(`${scope.adset}/ads`, { fields: 'id,account_id,campaign_id,adset_id,status,effective_status', limit: 100 }),
  ]);
  if (![totals, ads, statuses].every(Array.isArray)) throw new ReadError('META_INVALID_RESPONSE');
  if ([...totals, ...ads].some(r => r.date_start < since || r.date_stop > today)) throw new ReadError('META_INVALID_PERIOD');
  let retiredExcluded = false;
  const finalStatuses = [];
  for (const row of statuses) {
    // One explicitly retained superseded CRM object is permitted only OFF,
    // after its account and both parents match. No general unknown-ID filter.
    if (scope === CRM && String(row.id) === '120275503974780555') {
      assertScope(row, { scope, ids });
      if (row.status !== 'PAUSED' || row.effective_status === 'ACTIVE') throw new ReadError('META_RETIRED_AD_ACTIVE');
      retiredExcluded = true;
    } else { assertScope(row, { ad: true, scope, ids }); finalStatuses.push({ code: ids[row.id], status: row.status, delivery: row.effective_status }); }
  }
  if (scope === CRM && ads.some(row => String(row.ad_id) === '120275503974780555')) throw new ReadError('META_RETIRED_AD_INSIGHTS');
  if (retiredExcluded) for (const total of totals) for (const field of ['spend', 'impressions', 'inline_link_clicks']) {
    const reported = number(total[field]); if (reported === null) continue;
    const values = ads.filter(row => row.date_start === total.date_start).map(row => number(row[field]));
    if (values.some(value => value === null) || Math.abs(values.reduce((sum, value) => sum + value, 0) - reported) > (field === 'spend' ? 0.005 : 0)) throw new ReadError('META_RETIRED_TOTALS_UNVERIFIED');
  }
  return {
    ...(scope !== SCOPE ? { campaign: scope.campaign, adset: scope.adset } : {}),
    observed_at: now.toISOString(), timezone: account.timezone_name,
    period: { from: since, to: today }, delivery: adset.effective_status,
    budget_daily: budget === null ? null : budget / 100,
    attribution: 'Metas Adset-Attribution · Ereignisdatum der Conversion',
    daily: totals.map(r => normalizeInsight(r, false, scope, ids)), ads_daily: ads.map(r => normalizeInsight(r, true, scope, ids)),
    statuses: finalStatuses,
  };
}


export const ANALYTICS_SITES = Object.freeze(['chatline.app', 'start.chatline.app']);
const ANALYTICS_ENDPOINT = 'https://api.vercel.com/v1/query/web-analytics/visits/aggregate';
const ANALYTICS_FILTER = "environment eq 'production'";
const ANALYTICS_HOSTS = Object.freeze({ 'chatline.app': ['chatline.app', 'mindbody-home.chatline.app'], 'start.chatline.app': ['start.chatline.app'] });
export class AnalyticsReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function analyticsPeriod(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const lower = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29)).toISOString().slice(0, 10);
  return { from: lower < SCOPE.since ? SCOPE.since : lower, to: today };
}
function checkedProjects(projects) {
  if (!Array.isArray(projects) || projects.length > 2) throw new AnalyticsReadError('ANALYTICS_SCOPE_INVALID');
  const sites = new Set(), ids = new Set();
  for (const p of projects) {
    if (!p || !ANALYTICS_SITES.includes(p.site) || !/^prj_[A-Za-z0-9]+$/.test(p.projectId || '') ||
        p.teamId && !/^team_[A-Za-z0-9]+$/.test(p.teamId) || sites.has(p.site) || ids.has(p.projectId) ||
        p.scope !== 'project' || typeof p.label !== 'string' || !p.label || !Array.isArray(p.hosts) || !p.hosts.includes(p.site) || p.hosts.some(host => !ANALYTICS_HOSTS[p.site].includes(host))) throw new AnalyticsReadError('ANALYTICS_SCOPE_INVALID');
    if (Object.keys(p).some(k => !['site', 'projectId', 'teamId', 'scope', 'hosts', 'label'].includes(k))) throw new AnalyticsReadError('ANALYTICS_SCOPE_INVALID');
    sites.add(p.site); ids.add(p.projectId);
  }
  return projects;
}
function checkedAnalyticsTokens(tokens = {}) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(tokens))) throw new AnalyticsReadError('ANALYTICS_TOKEN_SCOPE_INVALID');
  const keys = Reflect.ownKeys(tokens);
  if (keys.some(key => !ANALYTICS_SITES.includes(key) || tokens[key] !== undefined && typeof tokens[key] !== 'string')) throw new AnalyticsReadError('ANALYTICS_TOKEN_SCOPE_INVALID');
  // Copy only own, explicitly named credentials. Never inherit or use a default credential.
  return Object.freeze(Object.fromEntries(keys.map(key => [key, tokens[key]])));
}
export function configuredAnalyticsSites(tokens = {}) {
  const safe = checkedAnalyticsTokens(tokens);
  return checkedProjects(ANALYTICS_PROJECTS).filter(p => safe[p.site]).map(p => p.site);
}
export function normalizeAnalytics(body, project, period) {
  const analyticsDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10) ? value.slice(0, 10) : null;
  const start = Date.parse(period.from + 'T00:00:00.000Z'), inclusiveEnd = Date.parse(period.to + 'T00:00:00.000Z');
  const atMidnight = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value);
  const sinceMatches = body?.query?.since === period.from || atMidnight(body?.query?.since) && Date.parse(body.query.since) === start;
  // Actual response: an inclusive date request is echoed as next-day exclusive UTC midnight.
  // Accept only that exact boundary or the documented inclusive date, never noon/future days.
  const untilMatches = body?.query?.until === period.to || atMidnight(body?.query?.until) && Date.parse(body.query.until) === inclusiveEnd + 86400000;
  const groupingMatches = body?.query && (!Object.hasOwn(body.query,'groupBy') || JSON.stringify(body.query.groupBy) === '["day"]');
  if (!body || project.scope !== 'project' || body.version !== 1 || !Array.isArray(body.data) || body.data.length > 32 ||
      !body.query || !groupingMatches || !sinceMatches || !untilMatches ||
      body.query.filter !== ANALYTICS_FILTER ||
      !Number.isFinite(start) || !Number.isFinite(inclusiveEnd)) throw new AnalyticsReadError('ANALYTICS_INVALID_RESPONSE');
  const days = new Set();
  const rows = body.data.map(row => {
    const day = analyticsDay(row.timestamp);
    if (!day || day < period.from || day > period.to || days.has(day) ||
        !Number.isSafeInteger(row.pageviews) || row.pageviews < 0 || !Number.isSafeInteger(row.visitors) || row.visitors < 0 || row.visitors > row.pageviews ||
        row.projectId && row.projectId !== project.projectId || row.requestHostname && !project.hosts.includes(row.requestHostname) ||
        row.environment && row.environment !== 'production') throw new AnalyticsReadError('ANALYTICS_INVALID_RESPONSE');
    days.add(day);
    // Only these aggregates leave the reader; no referrers, user IDs, URLs or raw rows.
    return { date: day, visitors: row.visitors, pageviews: row.pageviews };
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
// Config injection is for unit fixtures. Production collectWebAnalytics uses only
// ANALYTICS_PROJECTS, the fixed reviewed project-production mappings.
export function createAnalyticsReader(options = {}, fixtureProjects = ANALYTICS_PROJECTS) {
  if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Reflect.ownKeys(options).some(key => !['tokens', 'fetcher', 'now', 'sleep'].includes(key))) throw new AnalyticsReadError('ANALYTICS_TOKEN_SCOPE_INVALID');
  const { tokens, fetcher = fetch, now = new Date(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = options;
  const scopedTokens = checkedAnalyticsTokens(tokens);
  const projects = checkedProjects(fixtureProjects);
  return async function readAnalyticsSite(site) {
    if (!ANALYTICS_SITES.includes(site)) throw new AnalyticsReadError('ANALYTICS_SCOPE_INVALID');
    const project = projects.find(p => p.site === site);
    if (!project) return { site, status: 'not_connected', observed_at: null, attempted_at: null, error: null, timezone: 'UTC', daily: [] };
    const source = { site, label: project.label, source_code: 'vercel_project_production' };
    const token = Object.hasOwn(scopedTokens, site) ? scopedTokens[site] : undefined;
    if (!token) return { ...source, status: 'error', observed_at: null, attempted_at: now.toISOString(), error: 'ANALYTICS_NOT_CONFIGURED', timezone: 'UTC', daily: [] };
    const period = analyticsPeriod(now);
    const url = new URL(ANALYTICS_ENDPOINT);
    url.searchParams.set('projectId', project.projectId);
    if (project.teamId) url.searchParams.set('teamId', project.teamId);
    url.searchParams.set('by', 'day');
    url.searchParams.set('since', period.from); url.searchParams.set('until', period.to);
    url.searchParams.set('limit', '32');
    // Documented default is production. Fix it explicitly rather than inheriting another segment.
    url.searchParams.set('filter', ANALYTICS_FILTER);
    try {
      let body;
      for (let attempt = 0; attempt < 3; attempt++) {
        let response;
        try { response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
        catch { if (attempt === 2) throw new AnalyticsReadError('ANALYTICS_UNAVAILABLE'); await sleep(400 * 2 ** attempt); continue; }
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < 2) { await sleep(400 * 2 ** attempt); continue; }
          throw new AnalyticsReadError(response.status === 401 ? 'ANALYTICS_LOGIN_REQUIRED' : response.status === 403 ? 'ANALYTICS_PERMISSION_REQUIRED' : response.status === 429 ? 'ANALYTICS_RATE_LIMITED' : response.status === 402 ? 'ANALYTICS_PLAN_REQUIRED' : 'ANALYTICS_READ_FAILED');
        }
        try { body = await response.json(); } catch { throw new AnalyticsReadError('ANALYTICS_INVALID_RESPONSE'); }
        break;
      }
      return { ...source, status: 'connected', observed_at: now.toISOString(), attempted_at: now.toISOString(), error: null, timezone: 'UTC', period, daily: normalizeAnalytics(body, project, period) };
    } catch (error) {
      return { ...source, status: 'error', observed_at: null, attempted_at: now.toISOString(), error: error instanceof AnalyticsReadError ? error.code : 'ANALYTICS_READ_FAILED', timezone: 'UTC', daily: [] };
    }
  };
}
export async function collectWebAnalytics(options) {
  const read = createAnalyticsReader(options); // Never accepts runtime project configuration.
  return Promise.all(ANALYTICS_SITES.map(site => read(site)));
}


const DIAGNOSTIC_ENDPOINT = 'https://api.vercel.com/v1/query/web-analytics/visits/aggregate';
const DIAGNOSTIC_KEYS = new Set(['version','query','data','rows','result','results','metrics','values','buckets','timestamp','date','day','pageviews','visitors','count','value','metric','name','key','since','until','groupBy','filter','limit','error','code']);
const DIAGNOSTIC_METRICS = new Set(['pageviews','visitors','count','value']);
const DIAGNOSTIC_DATES = new Set(['timestamp','date','day','since','until']);
const DIAGNOSTIC_NESTED = new Set(['data','rows','result','results','metrics','values','buckets']);
const DIAGNOSTIC_GROUPS = new Set(['hour','day','week','month','year']);
const DIAGNOSTIC_ERROR_CODES = new Set(['not_found','project_not_found','forbidden','unauthorized','invalid_query','bad_request','payment_required','rate_limit_exceeded','too_many_requests','invalid_project','invalid_project_id','invalid_filter','invalid_date_range','invalid_time_range','invalid_since','invalid_until','missing_parameter','missing_project','NOT_FOUND','FORBIDDEN','UNAUTHORIZED','INVALID_QUERY','BAD_REQUEST','PROJECT_NOT_FOUND','INVALID_PROJECT','INVALID_PROJECT_ID','INVALID_FILTER','INVALID_DATE_RANGE','INVALID_TIME_RANGE','INVALID_GROUPING','INVALID_GROUP_BY','ANALYTICS_NOT_ENABLED','WEB_ANALYTICS_NOT_ENABLED','NOT_CONFIGURED','NO_DATA']);
const diagnosticType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const diagnosticKeys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).filter(k => DIAGNOSTIC_KEYS.has(k)).slice(0,20) : [];
function diagnosticDate(value) {
  let milliseconds;
  if (typeof value === 'number' && Number.isFinite(value)) milliseconds = value;
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < Date.UTC(2020,0,1) || milliseconds >= Date.UTC(2100,0,1)) return { type: diagnosticType(value), valid_date: false };
  return { type: diagnosticType(value), utc: new Date(milliseconds).toISOString() };
}
function diagnosticMetric(value) {
  const result = { type: diagnosticType(value) };
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result.number = value;
  // String values are never copied, even when the metric unexpectedly contains text.
  return result;
}
function diagnosticVersion(value) {
  const result = { type: diagnosticType(value) };
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999 || typeof value === 'string' && /^v?\d{1,3}$/.test(value)) result.value = value;
  return result;
}
function diagnosticErrorShape(value) {
  const fields = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).filter(k=>['code','message','name','status','type','details'].includes(k)).slice(0,20)) fields[key]=diagnosticType(value[key]);
  }
  return {type:diagnosticType(value),fields};
}
function diagnosticMessageFlags(value) {
  const text = typeof value === 'string' ? value.slice(0,4096).toLowerCase().replace(/[_-]+/g,' ') : '';
  return {
    analytics_not_enabled: /\banalytics\b/.test(text) && /not (?:been )?enabled|disabled|enable (?:web )?analytics|analytics.{0,80}not (?:active|configured)/.test(text),
    invalid_project: /\b(?:invalid|unknown|missing|not found|does not exist)\b.{0,80}\bproject(?:id)?\b|\bproject(?:id)?\b.{0,80}\b(?:invalid|unknown|missing|not found|does not exist)\b/.test(text),
    invalid_grouping_or_date_range: /\b(?:invalid|unsupported|missing|out of range|must)\b.{0,80}\b(?:group(?:ing|by)?|date|range|since|until|timeframe)\b|\b(?:group(?:ing|by)?|date|range|since|until|timeframe)\b.{0,80}\b(?:invalid|unsupported|out of range)\b/.test(text),
    no_data_or_not_configured: /\bno (?:analytics )?data\b|\bnot (?:yet )?configured\b|\bnot (?:yet )?set up\b/.test(text),
  };
}
function diagnosticShape(value, depth = 0) {
  const type = diagnosticType(value);
  if (Array.isArray(value)) return { type, length: value.length, ...(depth < 3 ? { sample: value.slice(0,2).map(v => diagnosticShape(v, depth + 1)) } : {}) };
  const result = { type };
  if (!value || typeof value !== 'object') return result;
  result.keys = diagnosticKeys(value);
  if (depth >= 3) return result;
  result.fields = {};
  for (const key of result.keys) {
    if (DIAGNOSTIC_DATES.has(key)) result.fields[key] = diagnosticDate(value[key]);
    else if (DIAGNOSTIC_METRICS.has(key)) result.fields[key] = value[key] && typeof value[key] === 'object' ? diagnosticShape(value[key],depth + 1) : diagnosticMetric(value[key]);
    else if (DIAGNOSTIC_NESTED.has(key)) result.fields[key] = diagnosticShape(value[key],depth + 1);
    else if (['metric','name','key'].includes(key)) result.fields[key] = { type: diagnosticType(value[key]), ...(DIAGNOSTIC_METRICS.has(value[key]) ? { aggregate_name: value[key] } : {}) };
    // No arbitrary property values, names, URLs, paths, identifiers or messages.
  }
  return result;
}
export function summarizeAnalyticsDiagnostic(project, status, body) {
  const query = body && typeof body.query === 'object' && body.query ? body.query : {};
  const group = query.groupBy;
  const groupValues = (Array.isArray(group) ? group : [group]).filter(v => DIAGNOSTIC_GROUPS.has(v)).slice(0,2);
  const errorCode = body?.error && typeof body.error === 'object' ? body.error.code : body?.code;
  const errorMessage = typeof body?.error === 'string' ? body.error : body?.error?.message;
  return {
    project: project.site === 'chatline.app' ? 'chatline-website' : 'limitless',
    http_status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    body_type: diagnosticType(body), root_keys: diagnosticKeys(body),
    version: diagnosticVersion(body?.version),
    query: { keys: diagnosticKeys(query), since: diagnosticDate(query.since), until: diagnosticDate(query.until), group_by: { type: diagnosticType(group), values: groupValues }, production_filter: query.filter === "environment eq 'production'" },
    data: diagnosticShape(body?.data),
    error_shape: diagnosticErrorShape(body?.error), message_flags: diagnosticMessageFlags(errorMessage),
    ...(DIAGNOSTIC_ERROR_CODES.has(errorCode) ? { error_code: errorCode } : {}),
  };
}
export function createAnalyticsDiagnosticFetcher({ enabled = false, fetcher = fetch, logger = message => console.log(message) } = {}) {
  if (!enabled) return fetcher;
  return async function diagnosticFetch(input, options) {
    const response = await fetcher(input, options);
    let project;
    try { const url = new URL(input); if (url.origin + url.pathname === DIAGNOSTIC_ENDPOINT) project = ANALYTICS_PROJECTS.find(p => p.projectId === url.searchParams.get('projectId')); }
    catch { /* No logging for unknown requests. */ }
    if (!project) return response;
    let body;
    try { body = await response.clone().json(); } catch { /* Never read/log text on non-JSON responses. */ }
    const summary = summarizeAnalyticsDiagnostic(project,response.status,body);
    try { logger('PULSE_ANALYTICS_DIAGNOSTIC ' + JSON.stringify(summary)); } catch { /* Diagnostics cannot change reporting behavior. */ }
    return response;
  };
}


const ALLOWED_KEYS = new Set(('schema_version clicks scope account dataset campaign adset snapshot_id collected_at sources meta website_events analytics search_console observed_at attempted_at status error period from to date timezone daily ads_daily statuses code delivery budget_daily attribution spend impressions reach link_clicks landing_page_views studio_tests call_requests checkouts trials complete_test_window verification checked_at capi consent attribution_checked_at live_trial_verified ads name angle stage format metrics events key label count meaning goals id target unit note review enabled cpc_review_start cpc_review_strong cpc_review_above funnel_review_clicks test_budget total_test_budget rule_version state message source_code technical_only budget sites site visitors pageviews link_audit ad_id checks tag_checks extra_keys category unrecognized_extra_key_count complete checked_count request_count scope_validated destination_present format_supported landing_keys_in_url_tags_absent https_domain root_path skin ref no_fragment unique_query_keys effective_utm_contract utm_source utm_medium utm_campaign utm_content campaign_id adset_id diy_funnel collection_started_at studio_started call_requested checkout_started dashboard_activated method manual_update edition_label exported_at imported_at valid_until attribution_setting reporting_basis meta_traffic connection_method last_received emq diagnostics deduplication').split(' '));
const FORBIDDEN = /(?:EAA[A-Za-z0-9]{25,}|gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]+|Bearer\s|access_token=|@(?:gmail|heyho)[\w.]*\.)/i;
for (const source of TRACKING_SOURCES) { ALLOWED_KEYS.add(source.diy); ALLOWED_KEYS.add(source.links); }
for (const { key } of META_COHORTS) ALLOWED_KEYS.add(key);
ALLOWED_KEYS.add('landing_parameter_locations_valid');
function scan(value, depth = 0) {
  if (depth > 15) throw new Error('SNAPSHOT_INVALID');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value) || value < 0) throw new Error('SNAPSHOT_INVALID'); return; }
  if (typeof value === 'string') { if (value.length > 2000 || FORBIDDEN.test(value)) throw new Error('SNAPSHOT_PRIVATE_DATA'); return; }
  if (Array.isArray(value)) { if (value.length > 10000) throw new Error('SNAPSHOT_INVALID'); value.forEach(v => scan(v, depth + 1)); return; }
  if (!value || typeof value !== 'object') throw new Error('SNAPSHOT_INVALID');
  for (const [k, v] of Object.entries(value)) { if (!ALLOWED_KEYS.has(k)) throw new Error('SNAPSHOT_UNKNOWN_FIELD'); scan(v, depth + 1); }
}
const timestamp = value => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
export function validateTrafficSource(source, scope = TRAFFIC) {
  const contract = metaContract(scope);
  if (!source || source.campaign !== scope.campaign || source.adset !== scope.adset || source.timezone !== 'Europe/Berlin') throw new Error('SNAPSHOT_SCOPE_MISMATCH');
  validateCsvMetaSource(source);
  const codes = Object.values(contract.ids);
  if (scope !== TRAFFIC) {
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
    if (!['connected','error','historical'].includes(source.status) || !timestamp(source.observed_at) || !timestamp(source.attempted_at) || typeof source.complete_test_window !== 'boolean' || source.complete_test_window && !metaWindowCovered(source)) throw new Error('SNAPSHOT_INVALID');
    if (source.observed_at === null) {
      if (source.status !== 'error' || source.period !== null || source.daily?.length || source.ads_daily?.length || source.statuses?.length) throw new Error('SNAPSHOT_INVALID');
      return source;
    }
    if (!source.attempted_at || source.observed_at > source.attempted_at || !validDate(source.period?.from) || !validDate(source.period?.to) || source.period.from < contract.since || source.period.to < source.period.from) throw new Error('SNAPSHOT_INVALID_DATE');
    const metrics = ['spend','impressions','reach','link_clicks','landing_page_views','studio_tests','call_requests','checkouts','trials'];
    for (const row of [...(source.daily || []), ...(source.ads_daily || [])]) if (!validDate(row.date) || metrics.some(key => row[key] !== null && (!Number.isFinite(row[key]) || row[key] < 0))) throw new Error('SNAPSHOT_INVALID');
  }
  for (const rows of [source.daily, source.ads_daily, source.statuses]) if (!Array.isArray(rows)) throw new Error('SNAPSHOT_INVALID');
  const seen = new Set();
  const dates = new Set();
  for (const row of source.daily) {
    if (dates.has(row.date) || row.date < source.period?.from || row.date > source.period?.to) throw new Error('SNAPSHOT_INVALID_DATE');
    dates.add(row.date);
  }
  for (const row of source.ads_daily) {
    const key = `${row.date}:${row.code}`;
    if (!codes.includes(row.code) || seen.has(key) || row.date < source.period?.from || row.date > source.period?.to) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
    seen.add(key);
  }
  if (source.statuses.length !== codes.length || new Set(source.statuses.map(r => r.code)).size !== codes.length || source.statuses.some(r => !codes.includes(r.code))) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
  return source;
}
export function validateSearchConsoleSource(source) {
  if (source === undefined) return source;
  if (source.status === 'not_connected' && !source.source_code && source.observed_at === null && !source.daily?.length) return source;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (source.source_code !== 'gsc_web_ui_csv' || source.method !== 'csv' || source.site !== 'chatline.app' ||
      source.label !== 'chatline.app + start.chatline.app' || source.timezone !== 'America/Los_Angeles' ||
      !['connected', 'error', 'historical'].includes(source.status) || !source.observed_at ||
      !validDate(source.period?.from) || !validDate(source.period?.to) || source.period.from < SCOPE.since || source.period.to < source.period.from ||
      !Array.isArray(source.daily)) throw new Error('SNAPSHOT_GSC_SCOPE_MISMATCH');
  const expected = (Date.parse(source.period.to) - Date.parse(source.period.from)) / 86400000 + 1;
  if (expected > 700 || source.daily.length !== expected) throw new Error('SNAPSHOT_GSC_INVALID_DAYS');
  source.daily.forEach((row, index) => {
    const date = new Date(Date.parse(source.period.from) + index * 86400000).toISOString().slice(0, 10);
    if (row.date !== date || Object.keys(row).some(key => !['date', 'clicks', 'impressions'].includes(key)) ||
        ['clicks', 'impressions'].some(key => row[key] !== null && (!Number.isSafeInteger(row[key]) || row[key] < 0))) throw new Error('SNAPSHOT_GSC_INVALID_DAYS');
  });
  return source;
}
export function validateSnapshot(data) {
  scan(data);
  if (data.schema_version !== 2 || Object.entries({ account: SCOPE.account, dataset: SCOPE.dataset, campaign: SCOPE.campaign, adset: SCOPE.adset }).some(([k, v]) => data.scope?.[k] !== v)) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
  if (!Array.isArray(data.ads) || data.ads.length !== Object.keys(AD_IDS).length || new Set(data.ads.map(a => a.code)).size !== data.ads.length || data.ads.some(a => !Object.values(AD_IDS).includes(a.code))) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
  validateCsvMetaSource(data.sources?.meta);
  validateSearchConsoleSource(data.sources?.search_console);
  for (const { key, scope } of META_COHORTS) if (data.sources[key] !== undefined) validateTrafficSource(data.sources[key], scope);
  for (const [key, source] of Object.entries(data.sources || {})) {
    const sourceIds = key === 'meta_traffic' || key === 'diy_funnel_traffic' || key === 'link_audit_traffic' ? TRAFFIC_AD_IDS
      : key === 'meta_crm' || key === 'diy_funnel_crm' || key === 'link_audit_crm' ? CRM_AD_IDS
      : key === 'meta_lookalike' || key === 'diy_funnel_lookalike' || key === 'link_audit_lookalike' ? LOOKALIKE_AD_IDS : AD_IDS;
    if (!timestamp(source.observed_at) || !timestamp(source.attempted_at)) throw new Error('SNAPSHOT_INVALID_DATE');
    for (const row of [...(source.daily || []), ...(source.ads_daily || [])]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) throw new Error('SNAPSHOT_INVALID_DATE');
      if (row.code && !Object.values(sourceIds).includes(row.code)) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
    }
    if (source.statuses?.some(s => !Object.values(sourceIds).includes(s.code))) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
  }
  if (data.sources.link_audit !== undefined) validateLinkAudit(data.sources.link_audit);
  if (data.sources.diy_funnel !== undefined) validateDiyFunnelSource(data.sources.diy_funnel);
  for (const source of TRACKING_SOURCES.slice(1)) {
    if (data.sources[source.links] !== undefined) validateLinkAudit(data.sources[source.links], { campaignKey: source.campaignKey });
    if (data.sources[source.diy] !== undefined) validateDiyFunnelSource(data.sources[source.diy], { campaignKey: source.campaignKey });
  }
  const sites = data.sources.analytics?.sites || [];
  if (!Array.isArray(sites) || sites.length > 2 || new Set(sites.map(s => s.site)).size !== sites.length) throw new Error('SNAPSHOT_ANALYTICS_SCOPE_MISMATCH');
  for (const site of sites) {
    if (!ANALYTICS_SITES.includes(site.site) || !timestamp(site.observed_at) || !timestamp(site.attempted_at) || !Array.isArray(site.daily)) throw new Error('SNAPSHOT_ANALYTICS_SCOPE_MISMATCH');
    const seen = new Set();
    for (const row of site.daily) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '') || seen.has(row.date) ||
          !Number.isSafeInteger(row.visitors) || row.visitors < 0 || !Number.isSafeInteger(row.pageviews) || row.pageviews < row.visitors) throw new Error('SNAPSHOT_INVALID_ANALYTICS');
      seen.add(row.date);
    }
  }
  return data;
}
export function canSkipCoreCollection(previous, { slot, now = new Date(), analyticsProjects = ANALYTICS_PROJECTS, metaEnabled = false, datasetEnabled = false } = {}) {
  const metaCollectionEnabled = metaEnabled && !csvMetaIsProtected(previous.sources.meta, now);
  const start = Date.parse(slot), current = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(current)) return false;
  const completedInSlot = source => {
    const observed = Date.parse(source?.observed_at);
    return source?.status === 'connected' && Number.isFinite(observed) && observed >= start && observed < start + 1800000 && observed <= current;
  };
  const analyticsDone = analyticsProjects.every(p => completedInSlot(previous.sources.analytics.sites?.find(s => s.site === p.site)));
  const datasetDone = !datasetEnabled || completedInSlot(previous.sources.website_events) && previous.sources.website_events.source_code === 'meta_dataset_stats';
  const anyEnabled = metaCollectionEnabled || datasetEnabled || analyticsProjects.length > 0;
  return anyEnabled && previous.snapshot_id === slot && (!metaCollectionEnabled || completedInSlot(previous.sources.meta)) && analyticsDone && datasetDone;
}
export function canSkipCollection(previous, options = {}) {
  const { analyticsProjects = ANALYTICS_PROJECTS, metaEnabled = false, datasetEnabled = false, linkAuditEnabled = false, diyFunnelEnabled = false } = options;
  const hasCore = metaEnabled || datasetEnabled || analyticsProjects.length > 0;
  const extraDone = !metaEnabled || META_COHORTS.every(contract => berlinDay(options.now || new Date()) < contract.since || cohortMetaDone(previous.sources[contract.key], options, contract));
  return extraDone && (hasCore || linkAuditEnabled || diyFunnelEnabled) && (!hasCore || canSkipCoreCollection(previous, options)) &&
    (!linkAuditEnabled || TRACKING_SOURCES.every(source => linkAuditAttemptedInSlot(previous.sources[source.links], options))) &&
    (!diyFunnelEnabled || TRACKING_SOURCES.every(source => diyFunnelAttemptedInSlot(previous.sources[source.diy], options)));
}
function cohortMetaDone(source, { slot, now = new Date() } = {}, contract) {
  if (csvMetaIsProtected(source, now)) return true;
  const start = Date.parse(slot), current = now.getTime();
  const at = Date.parse(source?.status === 'error' && contract.scope !== TRAFFIC ? source.attempted_at : source?.observed_at);
  return ['connected', ...(contract.scope !== TRAFFIC ? ['error'] : [])].includes(source?.status) && Number.isFinite(start) && Number.isFinite(at) && at >= start && at < start + 1800000 && at <= current;
}
export function diyFunnelAttemptedInSlot(source, { slot, now = new Date() } = {}) {
  const start = Date.parse(slot), attempted = Date.parse(source?.attempted_at), current = now.getTime();
  return source?.source_code === 'vercel_diy_events_production' && Number.isFinite(start) && Number.isFinite(attempted) &&
    attempted >= start && attempted < start + 1800000 && attempted <= current;
}
export function mergeAnalytics(previous, results, { now = new Date(), slot = null } = {}) {
  validateSnapshot(previous);
  if (!Array.isArray(results) || results.length !== ANALYTICS_SITES.length || new Set(results.map(r => r.site)).size !== results.length || results.some(r => !ANALYTICS_SITES.includes(r.site) || !['connected', 'error', 'not_connected'].includes(r.status))) throw new Error('SNAPSHOT_ANALYTICS_SCOPE_MISMATCH');
  const next = structuredClone(previous);
  const oldSites = next.sources.analytics?.sites || [];
  const sites = ANALYTICS_SITES.map(site => {
    const result = results.find(r => r.site === site);
    const old = oldSites.find(r => r.site === site) || { site, observed_at: null, attempted_at: null, timezone: 'UTC', daily: [] };
    if (result.status === 'connected') return result;
    if (result.status === 'not_connected') return { ...old, status: 'not_connected', error: null };
    return { ...old, status: 'error', attempted_at: now.toISOString(), error: /^[A-Z_]+$/.test(result.error) ? result.error : 'ANALYTICS_READ_FAILED' };
  });
  const known = sites.map(s => s.observed_at).filter(Boolean).sort();
  const attempted = sites.map(s => s.attempted_at).filter(Boolean).sort();
  const connected = sites.filter(s => s.status === 'connected').length;
  next.sources.analytics = {
    status: connected === sites.length ? 'connected' : connected ? 'partial' : sites.every(s => s.status === 'not_connected') ? 'not_connected' : 'error',
    observed_at: known[0] || null, attempted_at: attempted.at(-1) || null,
    error: sites.some(s => s.status === 'error') ? 'ANALYTICS_PARTIAL_FAILURE' : null, sites,
  };
  if (connected) next.collected_at = now.toISOString();
  if (slot) next.snapshot_id = slot;
  return validateSnapshot(next);
}
export function mergeMeta(previous, result, { now = new Date(), error = null, slot = null } = {}) {
  validateSnapshot(previous);
  // Defense in depth: a same-day CSV observation is never relabelled as an API
  // success or failed API attempt while its explicitly bounded hold is active.
  if (csvMetaIsProtected(previous.sources.meta, now)) return structuredClone(previous);
  const next = structuredClone(previous);
  next.snapshot_id = slot || next.snapshot_id;
  if (error) {
    // A failed attempt can advance only its attempt time, never its source observation time.
    next.sources.meta.attempted_at = now.toISOString();
    next.sources.meta.status = 'error';
    next.sources.meta.error = /^[A-Z_]+$/.test(error) ? error : 'META_READ_FAILED';
  } else {
    next.collected_at = now.toISOString();
    next.sources.meta = { ...result, status: 'connected', attempted_at: now.toISOString(), error: null, complete_test_window: true };
  }
  return validateSnapshot(next);
}


// Only aggregate event counts from the approved Dataset. Never request URLs,
// match keys, contact information, raw events or another asset inventory.
const STANDARD_EVENTS = Object.freeze([
  ['PageView', 'Gemeldete Dataset-Seitenaufrufe', 'Gemeldete PageView-Signale; keine eindeutigen Besucher und keine Anzeigenklicks.'],
  ['Lead', 'Lead-Signale', 'Bedeutung je Einstieg; im DIY: Studio-Test gestartet. Kein qualifizierter Kontakt.'],
  ['CompleteRegistration', 'Testanruf angefordert', 'Ein Testanruf wurde angefordert. Kein Beweis für ein angenommenes Gespräch.'],
  ['InitiateCheckout', 'Checkout begonnen', 'Ein Checkout wurde begonnen. Noch keine Zahlung.'],
  ['StartTrial', 'Testphase begonnen', 'Im DIY: Einrichtung läuft oder ist aktiv. Keine bestätigte Zahlung.'],
]);
const EVENT_NAMES = new Set(STANDARD_EVENTS.map(([key]) => key));
const fail = code => { throw new ReadError(code); };
const validCount = count => {
  if (count === null || count === undefined || count === '' ||
      !['string', 'number'].includes(typeof count)) fail('DATASET_INVALID_RESPONSE');
  const value = Number(count);
  if (!Number.isSafeInteger(value) || value < 0) fail('DATASET_INVALID_RESPONSE');
  return value;
};

// The SDK defines returned start_time as datetime. Require an explicit
// ISO datetime/timezone; request Unix seconds do not prove Unix responses.
function datasetBucketTime(value) {
  const parts = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:?\d{2})$/);
  if (!parts) fail('DATASET_INVALID_PERIOD');
  const [, year, month, day, hour, minute, second, milliseconds = '000', zone] = parts;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, +milliseconds));
  if (calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1 || calendar.getUTCDate() !== +day ||
      calendar.getUTCHours() !== +hour || calendar.getUTCMinutes() !== +minute || calendar.getUTCSeconds() !== +second ||
      zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(-2) > 59)) fail('DATASET_INVALID_PERIOD');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail('DATASET_INVALID_PERIOD');
  return time;
}

export function normalizeDatasetStats(buckets, { start, end }) {
  if (!Array.isArray(buckets) || !buckets.length) fail('DATASET_NO_STATS');
  if (!(start instanceof Date) || !(end instanceof Date) || !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) || end < start) fail('DATASET_INVALID_PERIOD');
  const counts = new Map(), coverage = new Map(), seenBuckets = new Set();
  for (const bucket of buckets) {
    if (bucket.aggregation !== 'event_total_counts' || !Array.isArray(bucket.data)) fail('DATASET_INVALID_RESPONSE');
    const bucketTime = datasetBucketTime(bucket.start_time);
    if (!Number.isFinite(bucketTime) || bucketTime < start.getTime() || bucketTime > end.getTime() || seenBuckets.has(bucketTime)) fail('DATASET_INVALID_PERIOD');
    seenBuckets.add(bucketTime);
    const seenEvents = new Set();
    for (const item of bucket.data) {
      // The official SDK exposes both event and value. Accept a recognized
      // event label only; no arbitrary custom names are copied to the report.
      const explicit = EVENT_NAMES.has(item.event) ? item.event : null;
      const dimension = EVENT_NAMES.has(item.value) ? item.value : null;
      if (explicit && dimension && explicit !== dimension) fail('DATASET_INVALID_RESPONSE');
      const key = explicit || dimension;
      if (!key) continue;
      if (seenEvents.has(key)) fail('DATASET_DUPLICATE_EVENT');
      seenEvents.add(key);
      const value = validCount(item.count);
      const sum = (counts.get(key) || 0) + value;
      if (!Number.isSafeInteger(sum)) fail('DATASET_INVALID_RESPONSE');
      counts.set(key, sum);
      coverage.set(key, (coverage.get(key) || 0) + 1);
    }
  }
  // An omitted event is unknown, not evidence of a measured zero.
  return STANDARD_EVENTS.map(([key, label, meaning]) => ({
    key, label, count: coverage.get(key) === buckets.length ? counts.get(key) : null, meaning,
  }));
}

export async function collectDatasetStats(read, { enabled = false, now = new Date() } = {}) {
  if (!enabled) return null;
  if (!Number.isFinite(now.getTime())) fail('DATASET_INVALID_PERIOD');
  // A bounded current UTC day avoids an ever-growing historical stats query.
  // This period is independent from the ad account's local reporting day.
  const start = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const end = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const buckets = await read(`${SCOPE.dataset}/stats`, {
    aggregation: 'event_total_counts', start_time: String(start.getTime() / 1000),
    end_time: String(end.getTime() / 1000), fields: 'aggregation,start_time,data',
  });
  return {
    dataset: SCOPE.dataset, source_code: 'meta_dataset_stats', timezone: 'UTC',
    observed_at: now.toISOString(), period: { from: start.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) },
    note: `Gemeldete Ereigniszählungen im API-Zeitfenster ${start.toISOString()} bis ${end.toISOString()}. Keine eindeutigen Menschen; Browser-/Server-Deduplizierung hier nicht unabhängig bestätigt.`,
    events: normalizeDatasetStats(buckets, { start, end }),
  };
}

export function mergeDatasetStats(previous, result, { now = new Date(), error = null } = {}) {
  validateSnapshot(previous);
  if (!result && !error) return previous;
  const next = structuredClone(previous);
  if (error) {
    next.sources.website_events = {
      ...next.sources.website_events, attempted_at: now.toISOString(), status: 'error',
      error: /^[A-Z_]+$/.test(error) ? error : 'DATASET_READ_FAILED',
    };
  } else {
    if (result.dataset !== SCOPE.dataset || result.source_code !== 'meta_dataset_stats') fail('DATASET_MISMATCH');
    next.sources.website_events = { ...result, attempted_at: now.toISOString(), status: 'connected', error: null };
    if (Date.parse(next.collected_at) < now.getTime()) next.collected_at = now.toISOString();
  }
  return validateSnapshot(next);
}


export function assertConfiguredSources({ metaEnabled = false, datasetEnabled = false, linkAuditEnabled = false, diyFunnelEnabled = false, metaOptions = {}, analyticsOptions = {} } = {}) {
  const metaReady = Boolean(metaOptions.token && /^v\d{2,3}\.\d+$/.test(metaOptions.version || ''));
  const analyticsSites = configuredAnalyticsSites(analyticsOptions.tokens);
  if (!(metaReady && (metaEnabled || datasetEnabled || linkAuditEnabled)) && !analyticsSites.length) throw new Error('NO_ENABLED_CONFIGURED_SOURCE');
}

export async function refreshSources(previous, { now = new Date(), slot = null, metaEnabled = false, datasetEnabled = false, linkAuditEnabled = false, diyFunnelEnabled = false, metaOptions = {}, analyticsOptions = {}, linkAuditOptions = {} } = {}) {
  assertConfiguredSources({ metaEnabled, datasetEnabled, linkAuditEnabled, diyFunnelEnabled, metaOptions, analyticsOptions });
  validateSnapshot(previous);
  const metaCollectionEnabled = metaEnabled && !csvMetaIsProtected(previous.sources.meta, now);
  let next = structuredClone(previous), metaReader, metaInitError = null, success = true;
  const warnings = [];
  const configuredSites = configuredAnalyticsSites(analyticsOptions.tokens);
  const analyticsProjects = ANALYTICS_PROJECTS.filter(project => configuredSites.includes(project.site));
  const hasCore = metaCollectionEnabled || datasetEnabled || analyticsProjects.length > 0;
  // Enabling the optional sidecar must not re-read already complete core sources.
  const coreDone = (linkAuditEnabled || diyFunnelEnabled) && (!hasCore || canSkipCoreCollection(previous, { slot, now, analyticsProjects, metaEnabled: metaCollectionEnabled, datasetEnabled }));
  if (!coreDone) {
    if (metaCollectionEnabled || datasetEnabled) {
      try { metaReader = createMetaReader(metaOptions); }
      catch (error) { metaInitError = error.code || error.message; }
    }
    if (metaCollectionEnabled) {
      try {
        if (metaInitError) throw new Error(metaInitError);
        next = mergeMeta(next, await collectAds(metaReader, now), { now, slot });
      } catch (error) { next = mergeMeta(next, null, { now, slot, error: error.code || error.message }); success = false; }
    }
    // Disabled or protected CSV Meta is copied verbatim, including observation
    // and import times. Independent successful sources can advance collected_at.
    const analyticsResults = await collectWebAnalytics({ ...analyticsOptions, now });
    next = mergeAnalytics(next, analyticsResults, { now, slot });
    success = success && !analyticsResults.some(source => source.status === 'error');
    if (datasetEnabled) {
      try {
        if (metaInitError) throw new Error(metaInitError);
        next = mergeDatasetStats(next, await collectDatasetStats(metaReader, { enabled: true, now }), { now });
      } catch (error) { next = mergeDatasetStats(next, null, { now, error: error.code || error.message }); success = false; }
    }
  }
  for (const contract of META_COHORTS) if (metaEnabled && berlinDay(now) >= contract.since && !csvMetaIsProtected(previous.sources[contract.key], now) &&
      (contract.scope === TRAFFIC || !cohortMetaDone(previous.sources[contract.key], { slot, now }, contract))) {
    try {
      const result = await collectAds(createMetaReader(metaOptions), now, contract.scope);
      next.sources[contract.key] = { ...result, status: 'connected', attempted_at: now.toISOString(), error: null, complete_test_window: contract.scope === TRAFFIC ? false : metaWindowCovered(result) };
      next.collected_at = now.toISOString();
    } catch (error) {
      if (next.sources[contract.key] || contract.scope !== TRAFFIC) next.sources[contract.key] = { ...(next.sources[contract.key] || { campaign: contract.scope.campaign, adset: contract.scope.adset, timezone: 'Europe/Berlin', observed_at: null, period: null, daily: [], ads_daily: [], statuses: [], complete_test_window: false }), status: 'error', attempted_at: now.toISOString(), error: contract.scope === TRAFFIC ? 'META_READ_FAILED' : (['META_LOGIN_REQUIRED','META_PERMISSION_REQUIRED','DATASET_MISMATCH','SCOPE_MISMATCH','ACCOUNT_CONFIG_MISMATCH','META_INVALID_PERIOD','META_RETIRED_AD_ACTIVE','META_RETIRED_AD_INSIGHTS','META_RETIRED_TOTALS_UNVERIFIED'].includes(error?.code || error?.message) ? error.code || error.message : 'META_READ_FAILED') };
      success = false;
    }
  }
  for (const source of TRACKING_SOURCES) if (diyFunnelEnabled && !diyFunnelAttemptedInSlot(previous.sources[source.diy], { slot, now })) {
    try {
      const result = await collectDiyFunnel({ token: analyticsOptions.tokens?.['start.chatline.app'], fetcher: analyticsOptions.fetcher, now, campaignKey: source.campaignKey });
      next.sources[source.diy] = mergeDiyFunnel(previous.sources[source.diy], result, { now, campaignKey: source.campaignKey });
      next.collected_at = now.toISOString();
    } catch (error) {
      next.sources[source.diy] = mergeDiyFunnel(previous.sources[source.diy], null, { now, campaignKey: source.campaignKey, error: error?.code || error?.message || 'DIY_FUNNEL_READ_FAILED' });
      warnings.push('DIY_FUNNEL_READ_FAILED');
    }
    if (slot) next.snapshot_id = slot;
  }
  for (const source of TRACKING_SOURCES) if (linkAuditEnabled && !linkAuditAttemptedInSlot(previous.sources[source.links], { slot, now })) {
    let audit;
    try { audit = await collectLinkAudit({ ...linkAuditOptions, enabled: true, token: metaOptions.token, version: metaOptions.version, fetcher: metaOptions.fetcher, now, campaignKey: source.campaignKey }); }
    catch { audit = await collectLinkAudit({ enabled: true, now, campaignKey: source.campaignKey }); }
    next.sources[source.links] = mergeLinkAudit(previous.sources[source.links], audit, { campaignKey: source.campaignKey });
    if (slot) next.snapshot_id = slot;
    if (next.sources[source.links].checked_count) next.collected_at = now.toISOString();
    if (!next.sources[source.links].complete) warnings.push('LINK_AUDIT_READ_FAILED');
    // An optional audit failure must not turn fresh performance/analytics into failure.
  }
  return { snapshot: validateSnapshot(next), success, warnings: [...new Set(warnings)] };
}

import { readFile } from 'node:fs/promises';

const DATA_URL = `https://raw.githubusercontent.com/${SCOPE.repository}/${SCOPE.dataBranch}/data.json`;
export async function readData({ live = true, fetcher = fetch, now = new Date() } = {}) {
  let snapshot, error = null;
  if (live) {
    try {
      const response = await fetcher(DATA_URL, { cache: 'no-store', signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) throw new Error('SOURCE_UNAVAILABLE');
      snapshot = validateSnapshot(await response.json());
    } catch { error = 'SOURCE_UNAVAILABLE'; }
  }
  if (!snapshot) snapshot = validateSnapshot(JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8')));
  return { snapshot, transport: { status: live && !error ? 'snapshot' : 'historical_fallback', error, attempted_at: now.toISOString() } };
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  if (Object.keys(req.query || {}).length) return res.status(400).json({ error: 'PARAMETERS_NOT_SUPPORTED' });
  try { return res.status(200).json(await readData()); }
  catch { return res.status(503).json({ error: 'NO_VALID_SNAPSHOT' }); }
}
