import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { freshness, summarize, reviewAd, analyticsView } from './model.mjs';
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
let client;
try { client = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'); }
catch { client = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1]; }
client = client.replace(/^import[^\n]+;\r?\n/gm, '');
async function renderFixture(snapshot) {
  const ids = new Set([...html.matchAll(/id="([^\"]+)"/g)].map(m => m[1]));
  const nodes = new Map();
  function node(selector) {
    const id = selector.match(/^#([\w-]+)/)?.[1];
    if (id && !ids.has(id)) throw new Error('Missing markup for ' + selector);
    if (!nodes.has(selector)) nodes.set(selector, { value: selector === '#period' ? 'latest' : selector === '#chart-metric' ? 'link_clicks' : selector === '#analytics-site' ? 'chatline.app' : '', innerHTML: '', textContent: '', className: '', style: {}, dataset: {}, listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } });
    return nodes.get(selector);
  }
  const context = { document: { querySelector: node, querySelectorAll: () => [] }, location: { hostname: '127.0.0.1' }, setInterval: () => {}, Intl, Date, freshness, summarize, reviewAd, analyticsView,
    fetch: async url => { assert.equal(url, '/api/data'); return { ok: true, json: async () => ({ snapshot, transport: { status: 'snapshot' } }) }; } };
  await vm.runInNewContext(`(async () => { ${client}\n })()`, context, { timeout: 1000 });
  return node;
}
test('the actual client renders the currently published legacy analytics source without sites', async () => {
  const legacy = structuredClone(original);
  legacy.sources.analytics = { status: 'not_connected', observed_at: null, attempted_at: null, error: null };
  const get = await renderFixture(legacy);
  assert.equal((get('#creative-list').innerHTML.match(/class="creative-card"/g) || []).length, 13);
  assert.equal(get('#analytics-state').textContent, 'Nicht verbunden');
  assert.match(get('#analytics-project').textContent, /Alle Live-Domains des Hauptseiten-Projekts, darunter chatline\.app und mindbody-home\.chatline\.app\./);
  assert.equal((get('#analytics-metrics').innerHTML.match(/<b>—<\/b>/g) || []).length, 2);
  assert.match(get('#event-source').textContent, /Historischer UI-Beleg/);
  assert.doesNotMatch(get('#freshness-banner').textContent, /konnten nicht geladen/);
  assert.match(get('#freshness-banner').innerHTML, /Historischer Meta-Stand/);
});
test('a fresh dataset timestamp with error still renders failure and retains the correct API caption', async () => {
  const fixture = structuredClone(original);
  fixture.sources.website_events.status = 'error';
  fixture.sources.website_events.source_code = 'meta_dataset_stats';
  fixture.sources.website_events.observed_at = new Date().toISOString();
  fixture.sources.website_events.note = 'UTC-Testfixture; kein Live-Datenbeleg.';
  const get = await renderFixture(fixture);
  assert.equal(get('#event-state').textContent, 'Abruf fehlgeschlagen');
  assert.match(get('#event-source').textContent, /Meta Dataset API/);
  assert.doesNotMatch(get('#event-source').textContent, /Historischer UI-Beleg/);
});
test('the actual client switches the two website sources without adding their visitors', async () => {
  const fixture = structuredClone(original), at = new Date().toISOString();
  fixture.sources.analytics.sites = [
    { site: 'chatline.app', status: 'connected', observed_at: at, daily: [{ date: '2026-10-24', visitors: 10, pageviews: 20 }, { date: '2026-10-25', visitors: 10, pageviews: 25 }] },
    { site: 'start.chatline.app', status: 'error', observed_at: at, daily: [{ date: '2026-10-25', visitors: 3, pageviews: 7 }] },
  ];
  const get = await renderFixture(fixture);
  assert.match(get('#analytics-metrics').innerHTML, /<b>10<\/b>/);
  assert.doesNotMatch(get('#analytics-metrics').innerHTML, /<b>20<\/b>|<b>23<\/b>/);
  get('#analytics-site').value = 'start.chatline.app'; get('#analytics-site').listeners.change();
  assert.match(get('#analytics-metrics').innerHTML, /<b>3<\/b>/);
  assert.equal(get('#analytics-state').textContent, 'Abruf fehlgeschlagen');
});
test('the actual client shows checkout in the six-step funnel and all five signals per ad', async () => {
  const fixture = structuredClone(original);
  const metrics = { date: '2026-10-25', spend: 8, impressions: 100, reach: 80, link_clicks: 5, landing_page_views: 4, studio_tests: 2, call_requests: 1, checkouts: 0, trials: null };
  fixture.sources.meta.daily = [metrics];
  fixture.sources.meta.ads_daily = [{ ...metrics, code: 'PIL-PA-01' }];
  const get = await renderFixture(fixture);
  const funnel = get('#funnel-steps').innerHTML;
  assert.equal((funnel.match(/class="funnel-step"/g) || []).length, 6);
  assert.match(funnel, /<b>0<\/b><h4>Checkout begonnen<\/h4>/);
  assert.match(funnel, /<b>—<\/b><h4>Testphase begonnen<\/h4>/);
  assert.doesNotMatch(funnel, /Studio-Test angelegt|Testphase aktiviert/);
  const cards = get('#creative-list').innerHTML;
  const first = cards.match(/<article class="creative-card">[\s\S]*?<\/article>/)[0];
  assert.match(first, /data-signal="landing_page_views"><small>Landingpage-Aufrufe<\/small><b>4<\/b>/);
  assert.match(first, /data-signal="studio_tests"><small>Lead-Signale<\/small><b>2<\/b>/);
  assert.match(first, /data-signal="call_requests"><small>Testanruf angefordert<\/small><b>1<\/b>/);
  assert.match(first, /data-signal="checkouts"><small>Checkout begonnen<\/small><b>0<\/b>/);
  assert.match(first, /data-signal="trials"><small>Testphase begonnen<\/small><b>—<\/b>/);
  assert.equal((cards.match(/aria-label="Von Meta zugerechnete Signale"/g) || []).length, 13);
  assert.match(get('#kpis').innerHTML, /Kosten je Lead-Signal/);
  assert.doesNotMatch(get('#kpis').innerHTML, /Kosten je Studio-Test/);
});
test('old dataset labels are clarified without changing historical counts or observation time', async () => {
  const fixture = structuredClone(original);
  const lead = fixture.sources.website_events.events.find(e => e.key === 'Lead');
  lead.label = 'Studio-Test angelegt'; lead.meaning = 'Ein neuer Studio-Run.'; lead.count = 2;
  const trial = fixture.sources.website_events.events.find(e => e.key === 'StartTrial');
  trial.label = 'Testphase aktiviert'; trial.count = null;
  const before = structuredClone(fixture.sources.website_events);
  const get = await renderFixture(fixture);
  const list = get('#event-list').innerHTML;
  assert.match(list, /<b>Lead-Signale<\/b>/);
  assert.match(list, /<b>Testphase begonnen<\/b>/);
  assert.doesNotMatch(list, /Studio-Test angelegt|Testphase aktiviert|Ein neuer Studio-Run/);
  assert.match(list, /class="count">2<\/span>/);
  assert.match(list, /class="count">—<\/span>/);
  assert.deepEqual(fixture.sources.website_events, before);
});
