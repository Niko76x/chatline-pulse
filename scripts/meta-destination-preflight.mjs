import { pathToFileURL } from 'node:url';

export const VERSION = 'v26.0';
export const ACCOUNT = '2128240694419507';
export const CAMPAIGN = '120274644271350555';
export const ADSET = '120275421779190555';
export const ORIGIN = 'https://start.chatline.app';
export const FIELDS = 'id,account_id,campaign_id,adset_id,creative{object_story_spec,url_tags,asset_feed_spec}';
export const ADS = Object.freeze({
  '120275421779180555': 'PIL-PA-01', '120275422266100555': 'PIL-PA-02',
  '120275421929330555': 'PIL-PA-03', '120275422266130555': 'PIL-PA-04',
  '120275421929340555': 'PIL-PR-01', '120275422266170555': 'PIL-PR-02',
  '120275422266160555': 'PIL-PR-03', '120275422266150555': 'PIL-PR-04',
  '120275422266110555': 'PIL-SA-01', '120275422266120555': 'PIL-SA-02',
  '120275422266140555': 'PIL-SA-03', '120275421929310555': 'PIL-SA-04',
  '120275421929320555': 'PIL-VID-01',
});
export const TAG_KEYS = Object.freeze(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'campaign_id', 'adset_id', 'ad_id']);
const QUERY_KEYS = new Set(['skin', 'ref', ...TAG_KEYS]);
// Fixed generic parameter NAMES only. Recognition never validates a value or
// removes the existing needs_review result for additional tracking parameters.
const EXTRA_KEY_NAMES = Object.freeze({
  utm_id: 'optional_utm', utm_term: 'optional_utm', utm_creative_format: 'optional_utm', utm_marketing_tactic: 'optional_utm',
  campaign_name: 'platform_label', adset_name: 'platform_label', ad_name: 'platform_label', placement: 'platform_label', site_source_name: 'platform_label',
  fb_campaign_id: 'platform_identifier', fb_adset_id: 'platform_identifier', fb_ad_id: 'platform_identifier',
  fbclid: 'click_identifier', gclid: 'click_identifier', msclkid: 'click_identifier',
  hsa_acc: 'crm_tracking', hsa_cam: 'crm_tracking', hsa_grp: 'crm_tracking', hsa_ad: 'crm_tracking',
  hsa_src: 'crm_tracking', hsa_net: 'crm_tracking', hsa_ver: 'crm_tracking', hsa_la: 'crm_tracking',
  hsa_kw: 'crm_tracking', hsa_tgt: 'crm_tracking', hsa_mt: 'crm_tracking', hsa_mtk: 'crm_tracking',
});
const URL_FIELDS = Object.freeze([
  ['object_story_spec.link_data.link', value => value?.link_data?.link],
  ['object_story_spec.link_data.call_to_action.value.link', value => value?.link_data?.call_to_action?.value?.link],
  ['object_story_spec.video_data.call_to_action.value.link', value => value?.video_data?.call_to_action?.value?.link],
]);
export function expectedTags(id) {
  if (!Object.hasOwn(ADS, id)) return null;
  return {
    utm_source: ['{{site_source_name}}'], utm_medium: ['paid_social'],
    utm_campaign: ['pilates_dach_selftest_20261022'], utm_content: [ADS[id].toLowerCase()],
    campaign_id: ['{{campaign.id}}', CAMPAIGN], adset_id: ['{{adset.id}}', ADSET], ad_id: ['{{ad.id}}', id],
  };
}
function inspectTagParams(params, id) {
  const expected = expectedTags(id);
  const extraNames = [...new Set(params.keys())].filter(key => !QUERY_KEYS.has(key));
  const checks = Object.fromEntries(TAG_KEYS.map(key => [key, params.getAll(key).length === 1 && expected[key].includes(params.get(key))]));
  // Only known key names and accepted static/macro values can be reported.
  const accepted = Object.fromEntries(TAG_KEYS.filter(key => checks[key]).map(key => [key, params.get(key)]));
  return { checks, accepted, known_keys_present: TAG_KEYS.filter(key => params.has(key)),
    unique: [...new Set(params.keys())].every(key => params.getAll(key).length === 1),
    unknown_key_count: extraNames.length,
    recognized_extra_keys: Object.keys(EXTRA_KEY_NAMES).filter(key => extraNames.includes(key)).map(name => ({ name, category: EXTRA_KEY_NAMES[name] })),
    unrecognized_extra_key_count: extraNames.filter(key => !Object.hasOwn(EXTRA_KEY_NAMES, key)).length,
    complete: Object.values(checks).every(Boolean) };
}

/** Inspect stored configuration only. Do not fetch or follow a destination. */
export function inspectAdDestination(body, id) {
  if (!Object.hasOwn(ADS, id)) throw new Error('DESTINATION_SCOPE_CHANGED');
  const result = { ad_id: id, code: ADS[id], status: 'needs_review', scope_validated: false, failures: [], destinations: [], url_tags: null };
  if (!body || body.id !== id || body.account_id !== ACCOUNT || body.campaign_id !== CAMPAIGN || body.adset_id !== ADSET) {
    result.failures.push('SCOPE_MISMATCH'); return result;
  }
  result.scope_validated = true;
  const creative = body.creative, story = creative?.object_story_spec;
  if (!creative || typeof creative !== 'object' || !story || typeof story !== 'object' || Array.isArray(story)) {
    result.failures.push('DESTINATION_UNAVAILABLE'); return result;
  }
  // Carousel/other dynamic destinations need a separate explicit read design;
  // never pretend their first card proves every link, or enumerate assets.
  if (story.link_data?.child_attachments?.length || story.template_data || story.product_data?.length)
    result.failures.push('UNSUPPORTED_DESTINATION_FORMAT');
  // Asset-feed URLs or format/customization rules can override an otherwise
  // valid story URL. Read their presence in this same request, without logging
  // or traversing the assets, and never certify just the story's first link.
  const feed = creative.asset_feed_spec;
  if (feed !== undefined && feed !== null) {
    const configured = value => value !== undefined && value !== null && value !== '' &&
      (!Array.isArray(value) || value.length > 0) &&
      (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0);
    if (typeof feed !== 'object' || Array.isArray(feed) ||
        ['link_urls', 'ad_formats', 'asset_customization_rules', 'optimization_type'].some(key => configured(feed[key])))
      result.failures.push('UNSUPPORTED_DESTINATION_FORMAT');
  }
  const rawTags = creative.url_tags;
  if (rawTags !== undefined && (typeof rawTags !== 'string' || rawTags.length > 4096)) {
    result.failures.push('URL_TAGS_INVALID_FORMAT'); return result;
  }
  const tags = new URLSearchParams(rawTags || '');
  const tagReport = inspectTagParams(tags, id);
  result.url_tags = { field_present: typeof rawTags === 'string', ...tagReport };
  if (tags.has('skin') || tags.has('ref')) result.failures.push('LANDING_KEYS_IN_URL_TAGS');
  if (tagReport.unknown_key_count) result.failures.push('UNEXPECTED_URL_TAG_KEYS');
  if (!tagReport.unique) result.failures.push('AMBIGUOUS_URL_TAGS');
  for (const [field, read] of URL_FIELDS) {
    const raw = read(story);
    if (raw === undefined || raw === null || raw === '') continue;
    let url;
    try { if (typeof raw !== 'string' || raw.length > 8192) throw Error(); url = new URL(raw); }
    catch { result.destinations.push({ field, valid: false, error: 'DESTINATION_INVALID_URL' }); continue; }
    const combined = new URLSearchParams(url.search);
    for (const [key, value] of tags) combined.append(key, value);
    const effective = inspectTagParams(combined, id);
    const checks = {
      https_domain: url.origin === ORIGIN && !url.username && !url.password,
      root_path: url.pathname === '/',
      skin: url.searchParams.getAll('skin').length === 1 && url.searchParams.get('skin') === 'pilates',
      ref: url.searchParams.getAll('ref').length === 1 && url.searchParams.get('ref') === `meta-pilates-de-${ADSET}-${ADS[id].toLowerCase()}`,
      no_fragment: !url.hash,
      known_query_keys: effective.unknown_key_count === 0,
      unique_query_keys: effective.unique,
      effective_utm_contract: effective.complete,
    };
    result.destinations.push({ field, valid: Object.values(checks).every(Boolean), checks,
      tag_checks: effective.checks, known_keys_present: effective.known_keys_present, unknown_key_count: effective.unknown_key_count,
      recognized_extra_keys: effective.recognized_extra_keys, unrecognized_extra_key_count: effective.unrecognized_extra_key_count });
  }
  if (!result.destinations.length) result.failures.push('DESTINATION_UNAVAILABLE');
  if (result.destinations.some(row => !row.valid)) result.failures.push('DESTINATION_OR_UTM_CONTRACT_MISMATCH');
  result.failures = [...new Set(result.failures)];
  if (!result.failures.length) result.status = tagReport.complete ? 'destination_validated' : 'destination_validated_inline_tags';
  return result;
}

function failureCategory(http, error) {
  const code = error?.code;
  if (code === 190 || http === 401) return 'META_LOGIN_REQUIRED';
  if ([10, 200, 294].includes(code) || http === 403) return 'META_PERMISSION_REQUIRED';
  if ([4, 17, 32, 613].includes(code) || http === 429) return 'META_RATE_LIMITED';
  if (http >= 500) return 'META_UNAVAILABLE';
  if (code === 100) return 'META_FIELD_OR_OBJECT_UNAVAILABLE';
  return 'META_READ_FAILED';
}
export async function runDestinationPreflight({ token, fetcher = fetch, now = new Date() } = {}) {
  if (!Number.isFinite(now?.getTime?.())) throw new Error('DESTINATION_INVALID_TIME');
  const report = { status: 'not_configured', checked_at: now.toISOString(), graph_version: VERSION,
    scope: { account: ACCOUNT, campaign: CAMPAIGN, adset: ADSET, approved_ads: 13 },
    snapshot_written: false, published: false, ads_changed: false, events_generated: false, results: [] };
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) return { ...report, error: 'META_NOT_CONFIGURED' };
  for (const id of Object.keys(ADS)) {
    const url = new URL(`https://graph.facebook.com/${VERSION}/${id}`);
    url.searchParams.set('fields', FIELDS);
    let response;
    try { response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${token.trim()}` }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { report.results.push({ ad_id: id, code: ADS[id], status: 'read_failed', error: 'META_UNAVAILABLE', http_status: null }); continue; }
    const http_status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
    let body;
    try { body = await response.json(); }
    catch { report.results.push({ ad_id: id, code: ADS[id], status: 'read_failed', error: response.ok ? 'META_INVALID_JSON' : failureCategory(http_status), http_status }); continue; }
    if (!response.ok || body?.error) {
      report.results.push({ ad_id: id, code: ADS[id], status: 'read_failed', error: failureCategory(http_status, body?.error), http_status }); continue;
    }
    report.results.push({ http_status, ...inspectAdDestination(body, id) });
  }
  report.status = report.results.some(row => row.status === 'read_failed') ? 'read_failed'
    : report.results.every(row => row.status.startsWith('destination_validated')) ? 'destinations_validated' : 'needs_review';
  return report;
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== 'Niko76x/chatline-pulse' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    throw new Error('DESTINATION_EXECUTION_NOT_ALLOWED');
  const result = await runDestinationPreflight({ token: process.env.META_REPORTING_ACCESS_TOKEN });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'destinations_validated') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const safe = ['DESTINATION_INVALID_TIME', 'DESTINATION_EXECUTION_NOT_ALLOWED', 'DESTINATION_SCOPE_CHANGED'].includes(error?.message) ? error.message : 'DESTINATION_PREFLIGHT_FAILED';
    process.stdout.write(`${JSON.stringify({ status: 'failed', error: safe, snapshot_written: false, published: false, ads_changed: false, events_generated: false })}\n`);
    process.exitCode = 1;
  });
}
