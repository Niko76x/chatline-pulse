import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { VERSION, ACCOUNT, CAMPAIGN, ADSET, ORIGIN, FIELDS, ADS, TAG_KEYS, expectedTags, inspectAdDestination, runDestinationPreflight } from '../scripts/meta-destination-preflight.mjs';

const ids = Object.keys(ADS), id = ids[0], now = new Date('2026-10-26T03:00:00Z');
const canary = 'PRIVATE_VALUE_MUST_NOT_APPEAR', secret = 'FIXTURE_TOKEN_NEVER_OUTPUT';
const target = ad => `${ORIGIN}/?skin=pilates&ref=meta-pilates-de-${ADSET}-${ADS[ad].toLowerCase()}`;
const tags = ad => new URLSearchParams(Object.fromEntries(Object.entries(expectedTags(ad)).map(([key, values]) => [key, values[0]]))).toString();
const ad = (adId = id, video = false) => ({ id: adId, account_id: ACCOUNT, campaign_id: CAMPAIGN, adset_id: ADSET,
  name: canary, creative: { object_story_spec: video ? { video_data: { message: canary, call_to_action: { value: { link: target(adId) } } } }
    : { link_data: { link: target(adId), message: canary, picture: `https://private.invalid/${canary}` } }, url_tags: tags(adId), body: canary } });

test('thirteen fixed ad GETs, v26 fields and header-only token; image/video targets and tag contract validate', async () => {
  const calls = [];
  const result = await runDestinationPreflight({ token: secret, now, fetcher: async (url, options) => {
    calls.push({ url: new URL(url), options });
    const selected = new URL(url).pathname.split('/').at(-1);
    return Response.json(ad(selected, ADS[selected] === 'PIL-VID-01'));
  } });
  assert.equal(calls.length, 13); assert.equal(result.status, 'destinations_validated');
  assert.ok(FIELDS.includes('asset_feed_spec'), 'The same read must include potential destination overrides');
  assert.deepEqual(calls.map(call => call.url.pathname), ids.map(value => `/${VERSION}/${value}`));
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://graph.facebook.com'); assert.equal(call.url.searchParams.get('fields'), FIELDS);
    assert.deepEqual([...call.url.searchParams.keys()], ['fields']);
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, `Bearer ${secret}`); assert.equal(call.url.toString().includes(secret), false);
  }
  assert.ok(result.results.every(row => row.scope_validated && row.status === 'destination_validated'));
  const output = JSON.stringify(result);
  assert.equal(output.includes(canary), false); assert.equal(output.includes(secret), false); assert.equal(output.includes('private.invalid'), false);
  assert.equal(result.ads_changed, false); assert.equal(result.events_generated, false); assert.equal(result.published, false);
  assert.deepEqual(Object.keys(result.results[0].url_tags.accepted), TAG_KEYS);
});

test('foreign identity fails closed before any destination/copy is included', () => {
  for (const mismatch of [{ id: 'PRIVATE_ID' }, { account_id: 'PRIVATE_ACCOUNT' }, { campaign_id: 'PRIVATE_CAMPAIGN' }, { adset_id: 'PRIVATE_ADSET' }]) {
    const result = inspectAdDestination({ ...ad(), ...mismatch }, id);
    assert.equal(result.scope_validated, false); assert.deepEqual(result.failures, ['SCOPE_MISMATCH']);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.deepEqual(result.destinations, []);
  }
  assert.throws(() => inspectAdDestination(ad(), 'PRIVATE_ID'), /DESTINATION_SCOPE_CHANGED/);
});

test('domain, path, skin, ad-specific reference, credentials, private/duplicate query and fragment are checked', () => {
  const invalid = [
    'https://private.invalid/?person=PRIVATE_VALUE',
    target(id).replace('https:', 'http:'), target(id).replace('/?skin', '/private/?skin'),
    target(id).replace('skin=pilates', 'skin=yoga'), target(id).replace('pil-pa-01', 'pil-pa-03'),
    target(id).replace('https://', 'https://PRIVATE_VALUE:PRIVATE_VALUE@'),
    target(id) + '&phone=PRIVATE_VALUE', target(id) + '&skin=pilates', target(id) + '#PRIVATE_VALUE',
  ];
  for (const link of invalid) {
    const value = ad(); value.creative.object_story_spec.link_data.link = link;
    const result = inspectAdDestination(value, id);
    assert.equal(result.status, 'needs_review'); assert.equal(JSON.stringify(result).includes('PRIVATE_VALUE'), false);
  }
  const overrides = ad();
  overrides.creative.object_story_spec.link_data.call_to_action = { value: { link: 'https://private.invalid/PRIVATE_VALUE' } };
  const result = inspectAdDestination(overrides, id);
  assert.equal(result.destinations.length, 2); assert.equal(result.status, 'needs_review', 'One valid link must not conceal a different CTA');
});

test('unknown/wrong macro values and duplicate tags are never echoed; literal IDs must match this ad', () => {
  for (const key of TAG_KEYS) {
    const value = ad(), parameters = new URLSearchParams(value.creative.url_tags);
    parameters.set(key, canary); value.creative.url_tags = parameters.toString();
    const result = inspectAdDestination(value, id);
    assert.equal(result.status, 'needs_review'); assert.equal(result.url_tags.checks[key], false);
    assert.equal(Object.hasOwn(result.url_tags.accepted, key), false); assert.equal(JSON.stringify(result).includes(canary), false);
  }
  const duplicate = ad(); duplicate.creative.url_tags += '&ad_id=PRIVATE_VALUE';
  assert.ok(inspectAdDestination(duplicate, id).failures.includes('AMBIGUOUS_URL_TAGS'));
  const unknown = ad(); unknown.creative.url_tags += '&PRIVATE_FIELD=PRIVATE_VALUE';
  const safe = inspectAdDestination(unknown, id);
  assert.ok(safe.failures.includes('UNEXPECTED_URL_TAG_KEYS')); assert.equal(JSON.stringify(safe).includes('PRIVATE'), false);
  const literal = ad(), parameters = new URLSearchParams(literal.creative.url_tags);
  parameters.set('campaign_id', CAMPAIGN); parameters.set('adset_id', ADSET); parameters.set('ad_id', id);
  literal.creative.url_tags = parameters.toString();
  assert.equal(inspectAdDestination(literal, id).status, 'destination_validated');
});

test('inline valid tags are distinguished; duplicate base/creative tags are ambiguous', () => {
  const inline = ad(); inline.creative.object_story_spec.link_data.link += `&${inline.creative.url_tags}`; inline.creative.url_tags = '';
  assert.equal(inspectAdDestination(inline, id).status, 'destination_validated_inline_tags');
  const duplicate = ad(); duplicate.creative.object_story_spec.link_data.link += `&${duplicate.creative.url_tags}`;
  const result = inspectAdDestination(duplicate, id);
  assert.equal(result.status, 'needs_review'); assert.equal(result.destinations[0].checks.unique_query_keys, false);
});

test('additional diagnostic exposes fixed generic key names/categories, never values or arbitrary key names', () => {
  const value = ad(), extras = ['hsa_acc','hsa_cam','hsa_grp','hsa_ad','hsa_src','hsa_net','hsa_ver','hsa_la'];
  value.creative.url_tags += '&' + new URLSearchParams(Object.fromEntries(extras.map(key => [key, canary]))).toString();
  value.creative.url_tags += '&email=PRIVATE_VALUE&PRIVATE_PARAMETER_NAME=PRIVATE_VALUE';
  const result = inspectAdDestination(value, id);
  assert.equal(result.status, 'needs_review'); assert.equal(result.url_tags.unknown_key_count, 10);
  assert.equal(result.url_tags.unrecognized_extra_key_count, 2);
  assert.deepEqual(result.url_tags.recognized_extra_keys.map(row => row.name).sort(), [...extras].sort());
  assert.ok(result.url_tags.recognized_extra_keys.every(row => row.category === 'crm_tracking'));
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('email'), false);
  assert.ok(result.failures.includes('UNEXPECTED_URL_TAG_KEYS'), 'Name recognition must not silently approve the extra tracking');
});

test('missing stories, carousel/dynamic formats and malformed url_tags are not silently declared correct', () => {
  const missing = ad(); delete missing.creative.object_story_spec;
  assert.ok(inspectAdDestination(missing, id).failures.includes('DESTINATION_UNAVAILABLE'));
  const carousel = ad(); carousel.creative.object_story_spec.link_data.child_attachments = [{ link: canary }];
  assert.ok(inspectAdDestination(carousel, id).failures.includes('UNSUPPORTED_DESTINATION_FORMAT'));
  for (const asset_feed_spec of [
    { link_urls: [{ website_url: 'https://private.invalid/PRIVATE_VALUE' }] },
    { ad_formats: ['AUTOMATIC_FORMAT'] },
    { asset_customization_rules: [{ private: canary }] },
  ]) {
    const overridden = ad(); overridden.creative.asset_feed_spec = asset_feed_spec;
    const result = inspectAdDestination(overridden, id);
    assert.equal(result.status, 'needs_review', 'A valid story must not conceal a dynamic destination override');
    assert.ok(result.failures.includes('UNSUPPORTED_DESTINATION_FORMAT'));
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
  const malformed = ad(); malformed.creative.url_tags = { private: canary };
  const result = inspectAdDestination(malformed, id);
  assert.ok(result.failures.includes('URL_TAGS_INVALID_FORMAT')); assert.equal(JSON.stringify(result).includes(canary), false);
});

test('API error bodies and exception messages yield only fixed categories', async () => {
  const errors = [190, 200, 100, 4]; let calls = 0;
  const report = await runDestinationPreflight({ token: secret, now, fetcher: async () => Response.json({ error: { code: errors[calls++ % errors.length], message: secret, type: canary, fbtrace_id: canary } }, { status: 400 }) });
  assert.equal(calls, 13); assert.equal(report.status, 'read_failed');
  assert.deepEqual(report.results.slice(0,4).map(row => row.error), ['META_LOGIN_REQUIRED','META_PERMISSION_REQUIRED','META_FIELD_OR_OBJECT_UNAVAILABLE','META_RATE_LIMITED']);
  assert.equal(JSON.stringify(report).includes(secret), false); assert.equal(JSON.stringify(report).includes(canary), false);
  const network = await runDestinationPreflight({ token: secret, now, fetcher: async () => { throw Error(secret); } });
  assert.ok(network.results.every(row => row.error === 'META_UNAVAILABLE'));
  assert.equal(JSON.stringify(network).includes(secret), false);
});

test('no token means no requests; workflow is manual-only/main-scoped with only read permissions', async () => {
  let called = false;
  const report = await runDestinationPreflight({ now, fetcher: async () => { called = true; } });
  assert.equal(called, false); assert.equal(report.status, 'not_configured');
  const workflow = await readFile(new URL('../.github/workflows/meta-destination-preflight.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /\bschedule:|\bpush:|\bpull_request:/);
  assert.match(workflow, /contents: read/); assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /github\.repository == 'Niko76x\/chatline-pulse'/); assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.equal((workflow.match(/secrets\./g) || []).length, 1);
  assert.ok(workflow.indexOf('secrets.') > workflow.indexOf('Read the thirteen approved ChatLine ad destinations'));
  assert.match(workflow, /persist-credentials: false/);
});
