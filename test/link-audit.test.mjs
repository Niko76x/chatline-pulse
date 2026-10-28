import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ADS, ACCOUNT, CAMPAIGN, ADSET, FIELDS, expectedTags } from '../scripts/meta-destination-preflight.mjs';
import { collectLinkAudit, mergeLinkAudit, validateLinkAudit, LINK_AUDIT_EXTRA_KEYS, assertLinkAuditScope } from '../lib/link-audit.js';
import { SCOPE, AD_IDS, validateSnapshot, refreshSources, canSkipCollection, mergeAnalytics, ANALYTICS_PROJECTS } from '../api/data.js';
const at = new Date('2026-10-26T04:07:00.000Z'), nextAt = new Date('2026-10-26T04:37:00.000Z');
const slot = '2026-10-26T04:00:00.000Z', nextSlot = '2026-10-26T04:30:00.000Z';
const ids = Object.keys(ADS), first = ids[0];
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
function body(id, { extras = false, unknown = false, dynamic = false, broken = false, inline = false, video = false } = {}) {
  const url = new URL('https://start.chatline.app/');
  url.searchParams.set('skin', 'pilates'); url.searchParams.set('ref', `meta-pilates-de-${ADSET}-${ADS[id].toLowerCase()}`);
  const tags = new URLSearchParams(Object.fromEntries(Object.entries(expectedTags(id)).map(([key, values]) => [key, values[0]])));
  if (extras) for (const key of Object.keys(LINK_AUDIT_EXTRA_KEYS)) tags.set(key, 'PRIVATE-EXTRA-VALUE-CANARY');
  if (unknown) tags.set('private_customer_tag', 'PRIVATE-UNKNOWN-CANARY');
  if (broken) url.searchParams.set('skin', 'wrong');
  if (inline) { for (const [key, value] of tags) url.searchParams.set(key, value); }
  const story = video ? { video_data: { call_to_action: { value: { link: url.href } } } } : { link_data: { link: url.href } };
  return { id, account_id: ACCOUNT, campaign_id: CAMPAIGN, adset_id: ADSET, creative: { object_story_spec: story,
    url_tags: inline ? '' : tags.toString(), ...(dynamic ? { asset_feed_spec: { link_urls: [{ website_url: 'https://private.invalid/SECRET' }] } } : {}) } };
}
const response = value => ({ status: 200, ok: true, json: async () => value });
const options = (fetcher, extra = {}) => ({ enabled: true, token: 'fixture-readonly-token', version: 'v26.0', now: at, fetcher, ...extra });
const validRead = async url => response(body(url.pathname.split('/').at(-1)));
const checked = async (fetcher = validRead, opts = {}) => mergeLinkAudit(null, await collectLinkAudit(options(fetcher, opts)));
function withAudit(source) { const snapshot = structuredClone(original); snapshot.sources.link_audit = source; return snapshot; }

test('gate defaults off with zero reads; existing optional-source-free schema remains valid', async () => {
  let reads = 0;
  assert.equal(await collectLinkAudit({ fetcher: async () => { reads++; } }), null);
  assert.equal(reads, 0); assert.equal(validateSnapshot(original), original);
  assertLinkAuditScope(SCOPE, AD_IDS);
  assert.throws(() => assertLinkAuditScope({ ...SCOPE, account: 'other' }, AD_IDS), /SCOPE/);
});
test('exactly thirteen fixed GETs use fixed fields, auth header and no destination follows', async () => {
  const requested = [];
  const source = await checked(async (url, init) => {
    assert.equal(url.origin, 'https://graph.facebook.com'); assert.equal(url.pathname, `/v26.0/${ids[requested.length]}`);
    assert.equal(url.searchParams.get('fields'), FIELDS); assert.equal([...url.searchParams].length, 1);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fixture-readonly-token'); assert.ok(init.signal instanceof AbortSignal);
    requested.push(url.pathname.split('/').at(-1)); return response(body(requested.at(-1)));
  });
  assert.deepEqual(requested, ids); assert.equal(source.status, 'connected'); assert.equal(source.request_count, 13);
  assert.equal(source.checked_count, 13); assert.equal(source.complete, true); assert.equal(source.observed_at, at.toISOString());
  assert.ok(source.ads.every(row => row.status === 'valid')); validateSnapshot(withAudit(source));
});
test('four actual extra-name patterns preserve correct core contracts without certifying extra values', async () => {
  const extras = new Set([ids[0], ids[3], ids[9], ids[12]]);
  const source = await checked(async url => { const id = url.pathname.split('/').at(-1); return response(body(id, { extras: extras.has(id), video: id === ids[12] })); });
  assert.equal(source.status, 'connected'); assert.equal(source.ads.filter(row => row.status === 'core_verified_extra_review').length, 4);
  for (const row of source.ads.filter(row => extras.has(row.ad_id))) {
    assert.ok(Object.values(row.checks).every(Boolean)); assert.ok(Object.values(row.tag_checks).every(Boolean));
    assert.equal(row.extra_keys.length, 8); assert.equal(row.unrecognized_extra_key_count, 0); assert.equal(row.error, null);
  }
  const json = JSON.stringify(withAudit(source));
  for (const forbidden of ['PRIVATE', 'private_customer_tag', 'https://', 'fixture-readonly-token', 'accepted', '"url_tags":', 'website_url'])
    assert.equal(JSON.stringify(source).includes(forbidden), false, forbidden);
  assert.ok(json.includes('crm_tracking')); validateSnapshot(withAudit(source));
});
test('unsupported dynamic assets, unknown keys and wrong destination remain inspected review rows, not read failures', async () => {
  const source = await checked(async url => {
    const id = url.pathname.split('/').at(-1);
    return response(body(id, { dynamic: id === ids[0], unknown: id === ids[1], broken: id === ids[2], inline: id === ids[3] }));
  });
  assert.equal(source.status, 'connected'); assert.equal(source.checked_count, 13);
  assert.equal(source.ads[0].status, 'needs_review'); assert.equal(source.ads[0].checks.format_supported, false);
  assert.equal(source.ads[1].status, 'needs_review'); assert.equal(source.ads[1].unrecognized_extra_key_count, 1);
  assert.equal(source.ads[2].status, 'needs_review'); assert.equal(source.ads[2].checks.skin, false);
  assert.equal(source.ads[3].status, 'valid'); assert.equal(source.ads[3].checked_at, at.toISOString());
  assert.equal(JSON.stringify(source).includes('private_customer_tag'), false);
});
test('scope mismatch is a failed read and cannot establish a fresh checked timestamp', async () => {
  const source = await checked(async url => response({ ...body(url.pathname.split('/').at(-1)), account_id: 'foreign-account' }));
  assert.equal(source.status, 'error'); assert.equal(source.checked_count, 0); assert.equal(source.observed_at, null);
  assert.ok(source.ads.every(row => row.error === 'META_SCOPE_MISMATCH' && row.checked_at === null && row.checks.skin === null));
});
test('every supported destination is checked; a differing CTA override cannot be certified by the first URL', async () => {
  const source = await checked(async url => {
    const id = url.pathname.split('/').at(-1), value = body(id);
    if (id === first) value.creative.object_story_spec.link_data.call_to_action = { value: { link: 'https://private.invalid/' } };
    return response(value);
  });
  assert.equal(source.ads[0].status, 'needs_review'); assert.equal(source.ads[0].checks.https_domain, false);
  assert.equal(source.ads[0].tag_checks.utm_source, true); assert.equal(source.status, 'connected');
  assert.equal(JSON.stringify(source).includes('private.invalid'), false);
});
test('partial failures retain historical checks and last complete observation while fresh rows advance', async () => {
  const old = await checked();
  const result = await collectLinkAudit(options(async url => {
    const id = url.pathname.split('/').at(-1);
    return id === first ? { ok: false, status: 403, json: async () => ({ error: { code: 200, message: 'PRIVATE API MESSAGE', fbtrace_id: 'PRIVATE' } }) } : response(body(id));
  }, { now: nextAt }));
  const source = mergeLinkAudit(old, result);
  assert.equal(source.status, 'partial'); assert.equal(source.checked_count, 12); assert.equal(source.complete, false);
  assert.equal(source.observed_at, old.observed_at); assert.equal(source.ads[0].checked_at, old.ads[0].checked_at);
  assert.deepEqual(source.ads[0].checks, old.ads[0].checks); assert.equal(source.ads[0].attempted_at, nextAt.toISOString());
  assert.equal(source.ads[0].error, 'META_PERMISSION_REQUIRED'); assert.equal(source.ads[1].checked_at, nextAt.toISOString());
  assert.equal(JSON.stringify(source).includes('PRIVATE'), false); validateSnapshot(withAudit(source));
});
test('all failures retain every historic observation and classify only safe errors', async () => {
  const old = await checked();
  const source = mergeLinkAudit(old, await collectLinkAudit(options(async () => { throw new Error('https://secret.invalid/?access_token=private'); }, { now: nextAt })));
  assert.equal(source.status, 'error'); assert.equal(source.observed_at, old.observed_at); assert.equal(source.checked_count, 0);
  for (let i = 0; i < 13; i++) { assert.equal(source.ads[i].checked_at, old.ads[i].checked_at); assert.deepEqual(source.ads[i].tag_checks, old.ads[i].tag_checks); }
  assert.equal(JSON.stringify(source).includes('secret.invalid'), false); validateSnapshot(withAudit(source));
});
test('missing auth and foreign graph version issue zero metadata requests and do not broaden scope', async () => {
  let reads = 0; const fetcher = async () => { reads++; };
  for (const extra of [{ token: '' }, { version: 'v99.0' }]) {
    const source = await checked(fetcher, extra); assert.equal(source.status, 'error'); assert.equal(source.request_count, 0);
  }
  assert.equal(reads, 0);
});
test('bounded concurrency and whole-read deadline cover both fetch and response parsing', async () => {
  let active = 0, maximum = 0;
  await checked(async url => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 3)); active--; return response(body(url.pathname.split('/').at(-1))); });
  assert.equal(maximum, 3);
  const started = Date.now();
  const source = await checked(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }), { deadlineMs: 45, requestTimeoutMs: 30 });
  assert.ok(Date.now() - started < 500); assert.equal(source.status, 'error'); assert.ok(source.request_count >= 3 && source.request_count <= 13);
  assert.ok(source.ads.some(row => row.error === 'META_AUDIT_DEADLINE'));
});
test('dedicated snapshot validator rejects arbitrary names/values, foreign IDs and false green states', async () => {
  const source = await checked();
  const mutations = [
    value => { value.ads[0].ad_id = 'other'; },
    value => { value.ads[0].checks.skin = 'https://private.invalid'; },
    value => { value.ads[0].extra_keys = [{ key: 'private_key', category: 'crm_tracking' }]; },
    value => { value.ads[0].error = 'PRIVATE API ERROR'; },
    value => { value.ads[0].status = 'core_verified_extra_review'; },
    value => { value.ads[0].checked_at = '2026-02-31T04:07:00.000Z'; },
    value => { value.checked_count = 12; },
    value => { value.ads[0].tag_checks.utm_content = null; },
    value => { value.ads[0].extra_keys = [{ key: 'utm_id', category: 'private_category' }]; },
    value => { value.ads[0].raw_url = 'https://private.invalid'; },
  ];
  for (const mutate of mutations) { const bad = structuredClone(source); mutate(bad); assert.throws(() => validateSnapshot(withAudit(bad)), /SNAPSHOT/); }
  assert.equal(validateLinkAudit(source), source);
});
function completedCore() {
  const results = ANALYTICS_PROJECTS.map(project => ({ site: project.site, label: project.label, status: 'connected', observed_at: at.toISOString(), attempted_at: at.toISOString(), error: null, timezone: 'UTC', daily: [] }));
  return mergeAnalytics(original, results, { now: at, slot });
}
test('enabling audit in a completed core slot reads only missing audit; failure is attempted once per slot', async () => {
  const previous = completedCore(); let analyticsReads = 0, auditReads = 0;
  const sourceOptions = { now: at, slot, linkAuditEnabled: true,
    metaOptions: { token: 'fixture-readonly-token', version: 'v26.0', fetcher: async () => { auditReads++; throw Error('PRIVATE'); } },
    analyticsOptions: { tokens: { 'chatline.app': 'fixture', 'start.chatline.app': 'fixture' }, fetcher: async () => { analyticsReads++; throw Error('core must not repeat'); } } };
  assert.equal(canSkipCollection(previous, { slot, now: at, linkAuditEnabled: true }), false);
  const result = await refreshSources(previous, sourceOptions);
  assert.equal(result.success, true); assert.deepEqual(result.warnings, ['LINK_AUDIT_READ_FAILED']);
  assert.equal(auditReads, 24); assert.equal(analyticsReads, 0);
  for (const key of ['meta', 'analytics', 'website_events']) assert.deepEqual(result.snapshot.sources[key], previous.sources[key]);
  assert.equal(canSkipCollection(result.snapshot, { slot, now: at, linkAuditEnabled: true }), true);
  const again = await refreshSources(result.snapshot, sourceOptions); assert.equal(auditReads, 24); assert.equal(analyticsReads, 0);
  assert.deepEqual(again.snapshot, result.snapshot);
  assert.equal(canSkipCollection(result.snapshot, { slot: nextSlot, now: nextAt, linkAuditEnabled: true }), false);
});
test('audit-only collection leaves every core source unchanged, and no optional gate means no new source', async () => {
  const result = await refreshSources(original, { now: at, slot, linkAuditEnabled: true, metaOptions: { token: 'fixture', version: 'v26.0', fetcher: validRead } });
  assert.equal(result.success, true); assert.equal(result.snapshot.sources.link_audit.complete, true);
  for (const key of ['meta', 'analytics', 'website_events']) assert.deepEqual(result.snapshot.sources[key], original.sources[key]);
  assert.equal(canSkipCollection(result.snapshot, { slot, now: at, analyticsProjects: [], linkAuditEnabled: true }), true);
});
test('a failing optional audit cannot roll back fresh core Analytics or fail a successful core collection', async () => {
  let analyticReads = 0, metaReads = 0;
  const result = await refreshSources(original, { now: at, slot, linkAuditEnabled: true,
    metaOptions: { token: 'fixture', version: 'v26.0', fetcher: async () => { metaReads++; throw Error('private'); } },
    analyticsOptions: { tokens: { 'chatline.app': 'fixture-site', 'start.chatline.app': 'fixture-diy' }, fetcher: async () => {
      analyticReads++; return response({ version: 1, query: { since: '2026-10-22', until: '2026-10-26', groupBy: ['day'], filter: "environment eq 'production'" },
        data: [{ timestamp: '2026-10-26T00:00:00Z', visitors: 2, pageviews: 4 }] });
    } } });
  assert.equal(result.success, true); assert.equal(analyticReads, 2); assert.equal(metaReads, 24);
  assert.equal(result.snapshot.sources.analytics.status, 'connected');
  assert.equal(result.snapshot.sources.analytics.observed_at, at.toISOString());
  assert.equal(result.snapshot.sources.link_audit.status, 'error');
  assert.deepEqual(result.snapshot.sources.meta, original.sources.meta);
});
test('API module graph imports with Git blob LF and checkout CRLF, without executing the inspector CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatline-link-audit-'));
  try {
    for (const eol of ['\n', '\r\n']) {
      const folder = join(directory, eol === '\n' ? 'git-blob' : 'checkout');
      for (const path of ['package.json', 'api/data.js', 'public/assets/campaigns.js', 'lib/tracking-contracts.mjs', 'lib/csv-meta.mjs', 'lib/link-audit.js', 'scripts/meta-destination-preflight.mjs', 'lib/diy-funnel.mjs', 'scripts/diy-funnel-preflight.mjs', 'public/data/fallback.json']) {
        const target = join(folder, path); await mkdir(dirname(target), { recursive: true });
        const source = (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').replace(/\n/g, eol);
        await writeFile(target, source);
      }
      const api = await import(pathToFileURL(join(folder, 'api/data.js')).href);
      assert.equal(api.SCOPE.account, ACCOUNT); assert.equal(api.validateSnapshot(structuredClone(original)).schema_version, 2);
      const result = await api.readData({ live: false, now: at }); assert.equal(result.transport.status, 'historical_fallback');
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^chatline-link-audit-/);
    await rm(directory, { recursive: true, force: true });
  }
});
