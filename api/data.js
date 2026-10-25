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
// Empty until each project ID, owning team and production-domain mapping is verified.
// No environment/browser parameter can substitute a project or enumerate the account.
export const ANALYTICS_PROJECTS = Object.freeze([]);
export function assertScope(row, { ad = false } = {}) {
  if (String(row.account_id) !== SCOPE.account || String(row.campaign_id) !== SCOPE.campaign ||
      String(row.adset_id ?? row.id) !== SCOPE.adset || (ad && !AD_IDS[String(row.ad_id ?? row.id)])) {
    throw new Error('SCOPE_MISMATCH');
  }
  return row;
}


const ROOT = 'https://graph.facebook.com';
const ALLOWED = new Set([`act_${SCOPE.account}`, SCOPE.campaign, SCOPE.adset,
  `${SCOPE.adset}/insights`, `${SCOPE.adset}/ads`, `${SCOPE.dataset}/stats`]);
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
export function normalizeInsight(row, ad = false) {
  assertScope(row, { ad });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date_start || '') || row.date_start !== row.date_stop) throw new ReadError('META_INVALID_PERIOD');
  return {
    date: row.date_start, ...(ad ? { code: AD_IDS[row.ad_id] } : {}),
    spend: number(row.spend), impressions: number(row.impressions), reach: number(row.reach),
    link_clicks: number(row.inline_link_clicks), landing_page_views: action(row.actions, 'landing_page_view'),
    studio_tests: action(row.actions, 'offsite_conversion.fb_pixel_lead'),
    call_requests: action(row.actions, 'offsite_conversion.fb_pixel_complete_registration'),
    checkouts: action(row.actions, 'offsite_conversion.fb_pixel_initiate_checkout'),
    trials: action(row.actions, 'offsite_conversion.fb_pixel_start_trial'),
  };
}
export async function collectAds(read, now = new Date()) {
  const account = await read(`act_${SCOPE.account}`, { fields: 'id,currency,timezone_name' });
  if (String(account.id).replace(/^act_/, '') !== SCOPE.account || account.currency !== 'EUR' || !account.timezone_name) throw new ReadError('ACCOUNT_CONFIG_MISMATCH');
  let today;
  try { today = new Intl.DateTimeFormat('en-CA', { timeZone: account.timezone_name }).format(now); }
  catch { throw new ReadError('ACCOUNT_CONFIG_MISMATCH'); }
  const adset = await read(SCOPE.adset, { fields: 'id,account_id,campaign_id,effective_status,promoted_object' });
  assertScope(adset);
  if (String(adset.promoted_object?.pixel_id) !== SCOPE.dataset) throw new ReadError('DATASET_MISMATCH');
  const campaign = await read(SCOPE.campaign, { fields: 'id,account_id,daily_budget,effective_status' });
  if (String(campaign.id) !== SCOPE.campaign || String(campaign.account_id) !== SCOPE.account) throw new ReadError('SCOPE_MISMATCH');
  const params = { fields: 'account_id,campaign_id,adset_id,ad_id,date_start,date_stop,spend,impressions,reach,inline_link_clicks,actions',
    time_range: { since: SCOPE.since, until: today }, time_increment: 1,
    use_unified_attribution_setting: true, action_report_time: 'conversion', limit: 1000 };
  const [totals, ads, statuses] = await Promise.all([
    read(`${SCOPE.adset}/insights`, { ...params, level: 'adset' }),
    read(`${SCOPE.adset}/insights`, { ...params, level: 'ad' }),
    read(`${SCOPE.adset}/ads`, { fields: 'id,account_id,campaign_id,adset_id,status,effective_status', limit: 100 }),
  ]);
  if (![totals, ads, statuses].every(Array.isArray)) throw new ReadError('META_INVALID_RESPONSE');
  if ([...totals, ...ads].some(r => r.date_start < SCOPE.since || r.date_stop > today)) throw new ReadError('META_INVALID_PERIOD');
  return {
    observed_at: now.toISOString(), timezone: account.timezone_name,
    period: { from: SCOPE.since, to: today }, delivery: adset.effective_status,
    budget_daily: number(campaign.daily_budget) === null ? null : number(campaign.daily_budget) / 100,
    attribution: 'Metas Adset-Attribution · Ereignisdatum der Conversion',
    daily: totals.map(r => normalizeInsight(r)), ads_daily: ads.map(r => normalizeInsight(r, true)),
    statuses: statuses.map(row => { assertScope(row, { ad: true }); return { code: AD_IDS[row.id], status: row.status, delivery: row.effective_status }; }),
  };
}


export const ANALYTICS_SITES = Object.freeze(['chatline.app', 'start.chatline.app']);
const ANALYTICS_ENDPOINT = 'https://api.vercel.com/v1/query/web-analytics/visits/aggregate';
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
        p.teamId && !/^team_[A-Za-z0-9]+$/.test(p.teamId) || sites.has(p.site) || ids.has(p.projectId)) throw new AnalyticsReadError('ANALYTICS_SCOPE_INVALID');
    if (Object.keys(p).some(k => !['site', 'projectId', 'teamId'].includes(k))) throw new AnalyticsReadError('ANALYTICS_SCOPE_INVALID');
    sites.add(p.site); ids.add(p.projectId);
  }
  return projects;
}
export function normalizeAnalytics(body, project, period) {
  const analyticsDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10) ? value.slice(0, 10) : null;
  if (!body || body.version !== 1 || !Array.isArray(body.data) || body.data.length > 32 ||
      !body.query || JSON.stringify(body.query.groupBy) !== '["day"]' ||
      typeof body.query.since !== 'string' || typeof body.query.until !== 'string' ||
      body.query.since.slice(0, 10) !== period.from || body.query.until.slice(0, 10) !== period.to) throw new AnalyticsReadError('ANALYTICS_INVALID_RESPONSE');
  const days = new Set();
  const rows = body.data.map(row => {
    const day = analyticsDay(row.timestamp);
    if (!day || day < period.from || day > period.to || days.has(day) ||
        !Number.isSafeInteger(row.pageviews) || row.pageviews < 0 || !Number.isSafeInteger(row.visitors) || row.visitors < 0 || row.visitors > row.pageviews ||
        row.projectId && row.projectId !== project.projectId || row.requestHostname && row.requestHostname !== project.site ||
        row.environment && row.environment !== 'production') throw new AnalyticsReadError('ANALYTICS_INVALID_RESPONSE');
    days.add(day);
    // Only these aggregates leave the reader; no referrers, user IDs, URLs or raw rows.
    return { date: day, visitors: row.visitors, pageviews: row.pageviews };
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
// Config injection is for unit fixtures. Production collectWebAnalytics uses only
// ANALYTICS_PROJECTS, a reviewed empty code constant until explicit verification.
export function createAnalyticsReader({ token, fetcher = fetch, now = new Date(), sleep = ms => new Promise(r => setTimeout(r, ms)) }, fixtureProjects = ANALYTICS_PROJECTS) {
  const projects = checkedProjects(fixtureProjects);
  return async function readAnalyticsSite(site) {
    if (!ANALYTICS_SITES.includes(site)) throw new AnalyticsReadError('ANALYTICS_SCOPE_INVALID');
    const project = projects.find(p => p.site === site);
    if (!project) return { site, status: 'not_connected', observed_at: null, attempted_at: null, error: null, timezone: 'UTC', daily: [] };
    if (!token) return { site, status: 'error', observed_at: null, attempted_at: now.toISOString(), error: 'ANALYTICS_NOT_CONFIGURED', timezone: 'UTC', daily: [] };
    const period = analyticsPeriod(now);
    const url = new URL(ANALYTICS_ENDPOINT);
    url.searchParams.set('projectId', project.projectId);
    if (project.teamId) url.searchParams.set('teamId', project.teamId);
    url.searchParams.set('by', 'day');
    url.searchParams.set('since', period.from); url.searchParams.set('until', period.to);
    url.searchParams.set('limit', '32');
    // Documented default is production. Fix it explicitly rather than inheriting another segment.
    url.searchParams.set('filter', "environment eq 'production'");
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
      return { site, status: 'connected', observed_at: now.toISOString(), attempted_at: now.toISOString(), error: null, timezone: 'UTC', period, daily: normalizeAnalytics(body, project, period) };
    } catch (error) {
      return { site, status: 'error', observed_at: null, attempted_at: now.toISOString(), error: error instanceof AnalyticsReadError ? error.code : 'ANALYTICS_READ_FAILED', timezone: 'UTC', daily: [] };
    }
  };
}
export async function collectWebAnalytics(options) {
  const read = createAnalyticsReader(options); // Never accepts runtime project configuration.
  return Promise.all(ANALYTICS_SITES.map(site => read(site)));
}


const ALLOWED_KEYS = new Set(('schema_version scope account dataset campaign adset snapshot_id collected_at sources meta website_events analytics search_console observed_at attempted_at status error period from to date timezone daily ads_daily statuses code delivery budget_daily attribution spend impressions reach link_clicks landing_page_views studio_tests call_requests checkouts trials complete_test_window verification checked_at capi consent attribution_checked_at live_trial_verified ads name angle stage format metrics events key label count meaning goals id target unit note review enabled cpc_review_start cpc_review_strong cpc_review_above funnel_review_clicks test_budget total_test_budget rule_version state message source_code technical_only budget sites site visitors pageviews').split(' '));
const FORBIDDEN = /(?:EAA[A-Za-z0-9]{25,}|gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]+|Bearer\s|access_token=|@(?:gmail|heyho)[\w.]*\.)/i;
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
export function validateSnapshot(data) {
  scan(data);
  if (data.schema_version !== 2 || Object.entries({ account: SCOPE.account, dataset: SCOPE.dataset, campaign: SCOPE.campaign, adset: SCOPE.adset }).some(([k, v]) => data.scope?.[k] !== v)) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
  if (!Array.isArray(data.ads) || data.ads.length !== Object.keys(AD_IDS).length || new Set(data.ads.map(a => a.code)).size !== data.ads.length || data.ads.some(a => !Object.values(AD_IDS).includes(a.code))) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
  for (const source of Object.values(data.sources || {})) {
    if (!timestamp(source.observed_at) || !timestamp(source.attempted_at)) throw new Error('SNAPSHOT_INVALID_DATE');
    for (const row of [...(source.daily || []), ...(source.ads_daily || [])]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) throw new Error('SNAPSHOT_INVALID_DATE');
      if (row.code && !Object.values(AD_IDS).includes(row.code)) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
    }
    if (source.statuses?.some(s => !Object.values(AD_IDS).includes(s.code))) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
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
export function canSkipCollection(previous, { slot, now = new Date(), analyticsProjects = ANALYTICS_PROJECTS, datasetEnabled = false } = {}) {
  const start = Date.parse(slot), current = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(current)) return false;
  const completedInSlot = source => {
    const observed = Date.parse(source?.observed_at);
    return source?.status === 'connected' && Number.isFinite(observed) && observed >= start && observed < start + 1800000 && observed <= current;
  };
  const analyticsDone = analyticsProjects.every(p => completedInSlot(previous.sources.analytics.sites?.find(s => s.site === p.site)));
  const datasetDone = !datasetEnabled || completedInSlot(previous.sources.website_events) && previous.sources.website_events.source_code === 'meta_dataset_stats';
  return previous.snapshot_id === slot && completedInSlot(previous.sources.meta) && analyticsDone && datasetDone;
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
  ['Lead', 'Studio-Test angelegt', 'Ein Onboarding-Run wurde angelegt. Noch kein qualifiziertes Gespräch.'],
  ['CompleteRegistration', 'Testanruf angefordert', 'Ein Testanruf wurde angefordert. Kein Beweis für ein angenommenes Gespräch.'],
  ['InitiateCheckout', 'Checkout begonnen', 'Ein Checkout wurde begonnen. Noch keine Zahlung.'],
  ['StartTrial', 'Testphase aktiviert', 'Ein kostenloser Backend-Trialstatus; keine bestätigte Zahlung.'],
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

export function normalizeDatasetStats(buckets, { start, end }) {
  if (!Array.isArray(buckets) || !buckets.length) fail('DATASET_NO_STATS');
  const counts = new Map(), coverage = new Map(), seenBuckets = new Set();
  for (const bucket of buckets) {
    if (bucket.aggregation !== 'event_total_counts' || !Array.isArray(bucket.data)) fail('DATASET_INVALID_RESPONSE');
    const bucketTime = Date.parse(bucket.start_time);
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
  const buckets = await read(`${SCOPE.dataset}/stats`, {
    aggregation: 'event_total_counts', start_time: start.toISOString(),
    end_time: now.toISOString(), fields: 'aggregation,start_time,data',
  });
  return {
    dataset: SCOPE.dataset, source_code: 'meta_dataset_stats', timezone: 'UTC',
    observed_at: now.toISOString(), period: { from: start.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) },
    note: `Gemeldete Ereigniszählungen im API-Zeitfenster ${start.toISOString()} bis ${now.toISOString()}. Keine eindeutigen Menschen; Browser-/Server-Deduplizierung hier nicht unabhängig bestätigt.`,
    events: normalizeDatasetStats(buckets, { start, end: now }),
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
