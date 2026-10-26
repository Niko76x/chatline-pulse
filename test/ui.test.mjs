import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { freshness, summarize, reviewAd, analyticsView } from '../public/assets/model.js';
import { CREATIVE_CATALOG } from '../public/assets/creative-catalog.js';
import { reportedCount } from '../public/assets/count-display.js';
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const client = (await readFile(new URL('../public/assets/pulse.js', import.meta.url), 'utf8')).replace(/^import[^\n]+;\r?\n/gm, '');

// Execute the shipped client and its actual handlers; fixtures never contact a service.
async function renderFixture(snapshot = structuredClone(original), hash = '#/overview') {
  const nodes = new Map(), events = {}, win = {}, clipboard = [], requests = [], location = { hash };
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, attributes: {}, dataset: {}, listeners: {},
      setAttribute(k,v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; }, addEventListener(k,v) { this.listeners[k] = v; } });
    return nodes.get(selector);
  }
  const nav = ['overview','facebook','website','funnel','tracking'].map(page => ({ ...node('nav:'+page), dataset:{page} }));
  let incoming = snapshot, transport = { status: 'snapshot' }, fail = false;
  const context = { document: { querySelector: node, querySelectorAll: () => nav, addEventListener: (k,v) => { events[k] = v; } },
    window: { addEventListener: (k,v) => { win[k] = v; } }, location, setInterval: () => {}, Intl, Date,
    freshness, summarize, reviewAd, analyticsView, CREATIVE_CATALOG, reportedCount, navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    fetch: async (url, options) => { requests.push([url,options]); assert.equal(url, '/api/data'); if (fail) throw Error('test failure'); return { ok:true, json:async () => ({snapshot:incoming,transport}) }; } };
  await vm.runInNewContext(`(async () => { ${client}\n })()`, context, { timeout:1500 });
  return { node, nav, clipboard, requests, get view() { return node('#view').innerHTML; },
    navigate(hash) { location.hash = hash; win.hashchange(); },
    input(id,value) { events.input({target:{id,value}}); }, select(id,value) { events.change({target:{id,value}}); },
    period(value) { node('#period').listeners.change({target:{value}}); },
    clickSite(site) { return events.click({target:{closest:s => s === '[data-site]' ? {dataset:{site}} : null}}); },
    copy(code) { return events.click({target:{closest:s => s === '[data-copy]' ? {dataset:{copy:code}} : null}}); },
    async reload(next = snapshot, nextTransport = {status:'snapshot'}, shouldFail = false) { incoming = next; transport = nextTransport; fail = shouldFail; await node('#reload').listeners.click(); } };
}
function withMetrics() {
  const fixture = structuredClone(original), row = {date:'2026-10-25',spend:8,impressions:100,reach:80,link_clicks:5,landing_page_views:4,studio_tests:2,call_requests:1,checkouts:0,trials:null};
  fixture.sources.meta.daily = [row]; fixture.sources.meta.ads_daily = [{...row,code:'PIL-PA-01'}]; return fixture;
}
test('overview has four KPIs, real source status and no invented business targets', async () => {
  const app = await renderFixture();
  assert.equal((app.view.match(/class="metric(?: highlight)?"/g)||[]).length,4);
  assert.deepEqual([...app.view.matchAll(/class="metric-label">([^<]+)</g)].map(item=>item[1]),['Ausgaben','Linkklicks','Zielseitenaufrufe','Studio-Tests']);
  assert.match(app.view,/Meta-Lead-Signale · kein Kunden-Nachweis/); assert.doesNotMatch(app.view,/je Lead-Signal/);
  assert.match(app.view,/Historischer Stand/); assert.match(app.view,/noch nicht gemeinsam festgelegt/);
  assert.match(app.view,/Nächster Beleg · Nachweis offen/); assert.match(app.view,/Ein Studio durchläuft den DIY-Einstieg eigenständig bis zum Dashboard\./);
  assert.doesNotMatch(app.view,/creative-card|fb-table|Google Search Console|progress|<img/);
  assert.equal(app.node('#period option[value="all"]').disabled,true);
  assert.equal(app.nav[0].attributes['aria-current'],'page');
});
test('cost per reported studio test is supporting text only when measured', async () => {
  const app=await renderFixture(withMetrics());
  assert.match(app.view,/4 € je Lead-Signal/);
  assert.doesNotMatch(app.view,/class="metric-label">Kosten/);
  assert.match(app.view,/class="metric-label">Zielseitenaufrufe<\/span><strong class="metric-value">4<\/strong>/);
});
test('known positive partial counts are minimums in overview, Facebook, detail and funnel without weakening strict rates', async () => {
  const fixture=withMetrics(), source=fixture.sources.meta;
  source.status='connected'; source.observed_at=new Date().toISOString(); source.complete_test_window=true;
  source.daily=[{...source.daily[0],date:'2026-10-24',landing_page_views:2,studio_tests:1,call_requests:0}, {...source.daily[0],landing_page_views:null,studio_tests:null,call_requests:null}];
  source.ads_daily=source.daily.map(row=>({...row,code:'PIL-PA-01'}));
  const before=structuredClone(fixture), app=await renderFixture(fixture);
  assert.match(app.view,/class="metric-label">Zielseitenaufrufe<\/span><strong class="metric-value">Mind. 2<\/strong>/);
  assert.match(app.view,/class="metric-label">Studio-Tests<\/span><strong class="metric-value">Mind. 1<\/strong>/);
  assert.match(app.view,/1 von 2 gemeldeten Tagen mit Messwert/); assert.doesNotMatch(app.view,/€ je Lead-Signal/);
  assert.match(app.view,/Nächster Beleg · Nachweis offen/,'Meta-Lead signals never complete the independent-journey milestone');
  app.navigate('#/facebook'); const row=app.view.match(/<tbody>(<tr>[\s\S]*?<\/tr>)/)[1];
  assert.match(row,/Mind. 2/); assert.match(row,/Mind. 1/); assert.match(row,/1 von 2 gemeldeten Tagen mit Messwert/);
  assert.match(row,/<td class="numeric">—<\/td><\/tr>/,'No cost per test is derived from a lower bound');
  app.navigate('#/facebook/ad/PIL-PA-01'); assert.match(app.view,/data-signal="studio_tests"><b>Mind. 1<\/b>/);
  assert.match(app.view,/Übergang zur Website prüfen/); assert.doesNotMatch(app.view,/Erste weiterführende Signale/);
  app.navigate('#/funnel'); assert.match(app.view,/funnel-count">Mind. 1/); assert.match(app.view,/funnel-count">—<span class="code">1 von 2 gemeldeten Tagen/);
  assert.doesNotMatch(app.view,/>[\d,.]+ %<\/td>/);
  assert.equal(summarize(source.daily).studio_tests,null); assert.equal(summarize(source.daily).cost_per_test,null);
  assert.deepEqual(fixture,before);
});
test('hash routes show one page at a time with 13 Facebook rows and safe unknown routes', async () => {
  const app = await renderFixture(); app.navigate('#/facebook');
  assert.match(app.view,/class="fb-table"/); assert.doesNotMatch(app.view,/Ziele & Leitplanken/);
  assert.equal((app.view.match(/<tr><td><a class="table-name"/g)||[]).length,13);
  app.navigate('#/website'); assert.match(app.view,/Besucher im Zeitverlauf/); assert.doesNotMatch(app.view,/fb-table/); assert.equal(app.node('#period-wrap').hidden,true);
  app.navigate('#/funnel'); assert.match(app.view,/Vier Schritte/); assert.doesNotMatch(app.view,/Besucher im Zeitverlauf/);
  app.navigate('#/tracking'); assert.match(app.view,/Google Search Console/); assert.doesNotMatch(app.view,/funnel-stage/);
  app.navigate('#/unknown'); assert.equal(app.node('#page-title').textContent,'Übersicht');
});
test('Facebook search, awareness and delivery filters use actual client handlers', async () => {
  const app = await renderFixture(withMetrics(),'#/facebook'); app.input('creative-search','PIL-PA-01');
  assert.equal((app.node('#facebook-results').innerHTML.match(/<tr><td>/g)||[]).length,1);
  app.input('creative-search',''); app.select('creative-stage','Solution-aware');
  assert.equal((app.node('#facebook-results').innerHTML.match(/<tr><td>/g)||[]).length,4);
  app.select('creative-stage','all'); app.select('creative-delivery','ACTIVE');
  assert.equal((app.node('#facebook-results').innerHTML.match(/<tr><td>/g)||[]).length,original.sources.meta.statuses.filter(row=>row.status==='ACTIVE').length);
  app.input('creative-search','no matches'); assert.match(app.node('#facebook-results').innerHTML,/Keine Anzeige/);
});
test('gallery preserves 12 original image hashes and explicitly marks the missing video', async () => {
  const app = await renderFixture(original,'#/facebook/creatives');
  assert.equal((app.view.match(/class="creative-card"/g)||[]).length,13); assert.equal((app.view.match(/<img /g)||[]).length,12);
  assert.match(app.view,/freigegebenen Motive und Texte vom 22.10./); assert.match(app.view,/Originaldatei derzeit nicht verknüpft/);
  assert.match(app.view,/https:\/\/claude.ai\/artifact\/QDK36dCNCCbttM9zscGHx8/); assert.doesNotMatch(app.view,/<video|localStorage|contenteditable/);
  assert.equal(CREATIVE_CATALOG.length,13);
  for (const item of CREATIVE_CATALOG) {
    assert.equal(new URL(item.targetUrl).hostname,'start.chatline.app'); assert.equal(new URL(item.targetUrl).searchParams.get('skin'),'pilates');
    assert.match(item.urlParameters,/ad_id=\{\{ad.id\}\}/);
    if(item.asset) { const bytes=await readFile(new URL('../public'+item.asset,import.meta.url)); assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256.toLowerCase()); }
    else assert.equal(item.code,'PIL-VID-01');
  }
});
test('details map fixed copy and exact Meta ID to five distinct downstream signals', async () => {
  const app = await renderFixture(withMetrics(),'#/facebook/ad/PIL-PA-01'), item=CREATIVE_CATALOG[0];
  assert.ok(app.view.includes(item.primary)); assert.ok(app.view.includes(`act=2128240694419507&amp;selected_ad_ids=${item.adId}`));
  assert.match(app.view,/<b>CPM<\/b> 80 € je 1.000 Impressionen/);
  assert.match(app.view,/<b>CPC<\/b> 1,6 € je Linkklick/);
  assert.match(app.view,/<b>CTR<\/b> 5 % Linkklickrate/);
  for(const [key,value] of [['landing_page_views','4'],['studio_tests','2'],['call_requests','1'],['checkouts','0'],['trials','—']]) assert.ok(app.view.includes(`data-signal="${key}"><b>${value}</b>`));
  app.navigate('#/facebook/ad/PIL-VID-01'); assert.match(app.view,/ursprüngliche Video ist lokal derzeit nicht verfügbar/); assert.doesNotMatch(app.view,/<video|<img/);
  app.navigate('#/facebook/ad/UNAPPROVED'); assert.match(app.view,/nicht Teil der freigegebenen/); assert.doesNotMatch(app.view,/selected_ad_ids/);
});
test('ad review uses only the selected period rather than signals from other days', async () => {
  const fixture=withMetrics(), source=fixture.sources.meta;
  source.status='connected'; source.observed_at=new Date().toISOString(); source.complete_test_window=true;
  source.daily=[{...source.daily[0],date:'2026-10-24'}, {...source.daily[0],studio_tests:0,call_requests:0}];
  source.ads_daily=[{...source.ads_daily[0],date:'2026-10-24'}, {...source.ads_daily[0],studio_tests:0,call_requests:0}];
  const app=await renderFixture(fixture,'#/facebook/ad/PIL-PA-01');
  assert.match(app.view,/Erste weiterführende Signale/);
  app.period('latest'); assert.match(app.view,/Weiter beobachten/); assert.doesNotMatch(app.view,/Erste weiterführende Signale/);
});
test('legacy website sources remain unknown; daily visitors are never summed across sources or days', async () => {
  const fixture=structuredClone(original), at=new Date().toISOString(), legacy=await renderFixture(fixture,'#/website');
  assert.match(legacy.view,/Nicht verbunden/); assert.match(legacy.view,/<strong class="metric-value">—<\/strong>/);
  fixture.sources.analytics.sites=[{site:'chatline.app',status:'connected',observed_at:at,daily:[{date:'2026-10-24',visitors:10,pageviews:20},{date:'2026-10-25',visitors:10,pageviews:25}]},{site:'start.chatline.app',status:'error',observed_at:at,daily:[{date:'2026-10-25',visitors:3,pageviews:7}]}];
  const app=await renderFixture(fixture,'#/website'); assert.match(app.view,/<strong class="metric-value">3<\/strong>/); assert.match(app.view,/Abruf fehlgeschlagen/);
  await app.clickSite('chatline.app'); assert.match(app.view,/<strong class="metric-value">10<\/strong>/); assert.match(app.view,/<strong class="metric-value">25<\/strong>/);
  assert.doesNotMatch(app.view,/<strong class="metric-value">(?:20|23|13)<\/strong>/); assert.match(app.view,/mindbody-home.chatline.app/); assert.match(app.view,/UTC-Tag ist noch unvollständig/);
});
test('four product steps distinguish unknown and zero while rates remain open without a cohort contract', async () => {
  const fixture=withMetrics(), app=await renderFixture(fixture,'#/funnel');
  assert.equal((app.view.match(/class="funnel-stage"/g)||[]).length,4);
  for(const label of ['Website / Studio eingegeben','Telefon / Testanruf angefordert','Zahlungsseite / Checkout begonnen','Einrichtung / Testphase begonnen']) assert.ok(app.view.includes(label));
  assert.match(app.view,/funnel-count">0<\/td>/); assert.match(app.view,/funnel-count">—(?:<span|<\/td>)/);
  assert.match(app.view,/Anteile und Conversionraten bleiben offen/); assert.match(app.view,/keine zusammenhängende Nutzergruppe/); assert.doesNotMatch(app.view,/>[\d,.]+ %<\/td>|E-Mail|Emaileingabe|Zahlung bestätigt/);
  fixture.sources.meta.daily[0].call_requests=5; const excessive=await renderFixture(fixture,'#/funnel'); assert.doesNotMatch(excessive.view,/>250 %<\/td>/);
});
test('tracking preserves independent source failures, old labels, counts and timestamps safely', async () => {
  const fixture=structuredClone(original), before=structuredClone(fixture.sources.website_events);
  fixture.sources.website_events.status='error'; fixture.sources.website_events.source_code='meta_dataset_stats'; fixture.sources.website_events.observed_at=new Date().toISOString(); fixture.sources.website_events.error='secret private payload';
  const app=await renderFixture(fixture,'#/tracking'); assert.match(app.view,/Abruf fehlgeschlagen/); assert.match(app.view,/Dataset-API/); assert.doesNotMatch(app.view,/secret private payload|Historischer Events-Manager/);
  assert.match(app.view,/Google Search Console/); assert.match(app.view,/keine verifizierte Verbindung/); assert.match(app.view,/Lead-Signale/); assert.doesNotMatch(app.view,/Studio-Test angelegt|Testphase aktiviert/);
  assert.equal(fixture.sources.meta.observed_at,original.sources.meta.observed_at); assert.deepEqual(fixture.sources.website_events.events,before.events);
});
test('scoped historic links and undecided review criteria do not imply automated ad control', async () => {
  const app=await renderFixture(original,'#/tracking/links'); assert.equal((app.view.match(/data-copy=/g)||[]).length,13); assert.match(app.view,/Stand 23.10.2026/); assert.match(app.view,/muss unabhängig im tatsächlichen Ablauf geprüft/);
  await app.copy('PIL-PA-01'); assert.equal(app.clipboard.length,1); assert.ok(app.clipboard[0].startsWith(CREATIVE_CATALOG[0].targetUrl)); await app.copy('UNAPPROVED'); assert.equal(app.clipboard.length,1);
  app.navigate('#/tracking/criteria'); assert.match(app.view,/keine automatische Stopregel/); assert.match(app.view,/noch gemeinsam festzulegen/); assert.doesNotMatch(app.view,/2 €|25 Klicks|Gewinner|progress/);
});
test('display strings are escaped; failed or older reads never redates or replaces newer source data', async () => {
  const fixture=withMetrics(); fixture.ads[0].name='<img src=x onerror=alert(1)>'; const app=await renderFixture(fixture,'#/facebook');
  assert.match(app.view,/&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(app.view,/<img src=x/);
  const at=fixture.sources.meta.observed_at; await app.reload(fixture,{status:'snapshot'},true); assert.match(app.node('#transport-notice').textContent,/bisherigen Datenstand/); assert.equal(fixture.sources.meta.observed_at,at);
  const older=structuredClone(fixture); older.collected_at='2026-10-22T00:00:00Z'; older.sources.meta.daily[0].spend=99; await app.reload(older,{status:'historical_fallback'}); app.navigate('#/overview');
  assert.match(app.view,/8 €/); assert.doesNotMatch(app.view,/99 €/); assert.match(app.node('#transport-notice').textContent,/ursprünglichen Zeitpunkte/);
  assert.ok(app.requests.every(([url,opts])=>url==='/api/data'&&opts.cache==='no-store'));
});
test('external assets retain strict self-only CSP and the tested helper is exactly the shipped helper', async () => {
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8')), policy=config.headers[0].headers.find(h=>h.key==='Content-Security-Policy').value;
  assert.match(html,/src="\/assets\/pulse.js"/); assert.match(html,/href="\/assets\/pulse.css"/); assert.doesNotMatch(html,/<style|style=|<script[^>]*>[\s\S]+?<\/script>|on(?:click|change)=/i);
  assert.match(policy,/script-src 'self'; style-src 'self'; connect-src 'self'/); assert.doesNotMatch(policy,/unsafe-inline|unsafe-eval|sha256/); assert.match(policy,/frame-ancestors 'none'/);
  assert.equal(await readFile(new URL('../public/assets/model.js',import.meta.url),'utf8'),await readFile(new URL('./model.mjs',import.meta.url),'utf8'));
});
