import { TRAFFIC, TRAFFIC_ADS, CRM, CRM_ADS, LOOKALIKE, LOOKALIKE_ADS } from '../public/assets/campaigns.js';
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
async function renderFixture(snapshot = structuredClone(original), hash = '#/overview', catalog = CREATIVE_CATALOG) {
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
    TRAFFIC, TRAFFIC_ADS, CRM, CRM_ADS, LOOKALIKE, LOOKALIKE_ADS, freshness, summarize, reviewAd, analyticsView, CREATIVE_CATALOG: catalog, reportedCount, navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    fetch: async (url, options) => { requests.push([url,options]); assert.equal(url, '/api/data'); if (fail) throw Error('test failure'); return { ok:true, json:async () => ({snapshot:incoming,transport}) }; } };
  await vm.runInNewContext(`(async () => { ${client}\n })()`, context, { timeout:1500 });
  return { node, nav, clipboard, requests, get view() { return node('#view').innerHTML; },
    navigate(hash) { location.hash = hash; win.hashchange(); },
    input(id,value) { events.input({target:{id,value}}); }, select(id,value) { events.change({target:{id,value}}); },
    period(value) { node('#period').listeners.change({target:{value}}); },
    clickSite(site) { return events.click({target:{closest:s => s === '[data-site]' ? {dataset:{site}} : null}}); },
    copy(code) { return events.click({target:{closest:s => s === '[data-copy]' ? {dataset:{copy:code}} : null}}); },
    clickCampaign(campaign) { return events.click({target:{closest:s => s === '[data-campaign]' ? {dataset:{campaign}} : null}}); },
    async reload(next = snapshot, nextTransport = {status:'snapshot'}, shouldFail = false) { incoming = next; transport = nextTransport; fail = shouldFail; await node('#reload').listeners.click(); } };
}
function withMetrics() {
  const fixture = structuredClone(original), row = {date:'2026-10-25',spend:8,impressions:100,reach:80,link_clicks:5,landing_page_views:4,studio_tests:2,call_requests:1,checkouts:0,trials:null};
  fixture.sources.meta.daily = [row]; fixture.sources.meta.ads_daily = [{...row,code:'PIL-PA-01'}]; return fixture;
}
function diySource(overrides={}) {
  const at=new Date().toISOString();
  return {source_code:'vercel_diy_events_production',site:'start.chatline.app',campaign:'120274644271350555',timezone:'UTC',collection_started_at:'2026-10-26T02:30:39Z',status:'awaiting_events',observed_at:at,attempted_at:at,period:{from:'2026-10-26',to:'2026-10-26'},daily:[],error:null,...overrides};
}
function auditSource(overrides={}) {
  const at=new Date().toISOString(), checks=['scope_validated','destination_present','format_supported','landing_keys_in_url_tags_absent','https_domain','root_path','skin','ref','no_fragment','unique_query_keys','effective_utm_contract'],tags=['utm_source','utm_medium','utm_campaign','utm_content','campaign_id','adset_id','ad_id'];
  return {source_code:'meta_ad_destination_checks',status:'connected',observed_at:at,attempted_at:at,error:null,complete:true,checked_count:13,request_count:13,ads:CREATIVE_CATALOG.map(row=>({ad_id:row.adId,code:row.code,status:'valid',checked_at:at,attempted_at:at,checks:Object.fromEntries(checks.map(key=>[key,true])),tag_checks:Object.fromEntries(tags.map(key=>[key,true])),extra_keys:[],unrecognized_extra_key_count:0,error:null})),...overrides};
}
test('optional sources absent keeps the Meta funnel usable and the link template historical', async () => {
  const app=await renderFixture(withMetrics(),'#/funnel/diy');
  assert.match(app.view,/Meta-Zuordnung/); assert.match(app.view,/Eigener DIY-Ablauf noch nicht verbunden/);
  assert.equal(app.node('#period-wrap').hidden,true); assert.doesNotMatch(app.view,/data-diy-count=/);
  app.navigate('#/funnel/meta'); assert.match(app.view,/Meta-Zuordnung/); assert.equal(app.node('#period-wrap').hidden,false);
  app.navigate('#/tracking/links'); assert.match(app.view,/Stand 23.10.2026/); assert.match(app.view,/aktueller Link-Audit ist noch nicht verbunden/);
  assert.match(app.view,/Anzeigen-\/UTM-Vorlage kopieren/); assert.match(app.view,/Meta ersetzt \{\{…\}\} beim Ausspielen/);
});
test('awaiting DIY access is distinct from conversion zero and uses its own UTC period', async () => {
  const fixture=withMetrics(); fixture.sources.diy_funnel=diySource();
  const app=await renderFixture(fixture,'#/funnel');
  assert.equal(app.node('#period-wrap').hidden,true); assert.match(app.view,/Eigener DIY-Ablauf/); assert.match(app.view,/Zugang geprüft · wartet auf Signale/);
  assert.equal((app.view.match(/data-diy-count="[^"]+">—<\/td>/g)||[]).length,4);
  assert.doesNotMatch(app.view,/data-diy-count="[^"]+">0/); assert.match(app.view,/kein Nachweis für 0 Studio-Tests/);
  assert.match(app.view,/Erfassung ab 26\. Okt\., 02:30 UTC/); assert.match(app.view,/laufende UTC-Tag ist unvollständig/);
  assert.doesNotMatch(app.view,/Facebook-Kontotage|Europe\/Berlin/);
  app.navigate('#/funnel/meta'); assert.equal(app.node('#period-wrap').hidden,false); assert.match(app.view,/Meta ordnet diese Aktionen/); assert.doesNotMatch(app.view,/data-diy-count=/);
});
test('hypothetical later DIY signals are separate additive events with ad-day row coverage and no rate', async () => {
  const fixture=withMetrics(); fixture.sources.diy_funnel=diySource({status:'connected',daily:[
    {date:'2026-10-26',code:'PIL-PA-01',studio_started:2,call_requested:1,checkout_started:0,dashboard_activated:1},
    {date:'2026-10-26',code:'PIL-SA-02',studio_started:null,call_requested:0,checkout_started:null,dashboard_activated:null},
  ]});
  const before=structuredClone(fixture),app=await renderFixture(fixture,'#/funnel/diy');
  assert.match(app.view,/data-diy-count="studio_started">Mind. 2/); assert.match(app.view,/1 von 2 gemeldeten Anzeigen-\/Tageszeilen/);
  assert.match(app.view,/data-diy-count="checkout_started">—/); assert.match(app.view,/data-diy-count="dashboard_activated">Mind. 1/);
  assert.doesNotMatch(app.view,/1 von 2 gemeldeten Tagen|>[\d,.]+ %<\/td>/);
  assert.match(app.view,/kein Beleg für Seitenbesuch oder Zahlung/i); assert.match(app.view,/Kein Nachweis eines geführten Gesprächs/);
  app.navigate('#/overview'); assert.match(app.view,/Nächster Beleg · Nachweis offen/); assert.equal((app.view.match(/class="metric(?: highlight)?"/g)||[]).length,4);
  assert.deepEqual(fixture,before);
});
test('DIY ad details replace the five Meta signal row without filtering by the Meta period', async () => {
  const fixture=withMetrics(); fixture.sources.diy_funnel=diySource({status:'connected',daily:[{date:'2026-10-26',code:'PIL-PA-01',studio_started:2,call_requested:1,checkout_started:0,dashboard_activated:1},{date:'2026-10-26',code:'PIL-SA-02',studio_started:99,call_requested:99,checkout_started:99,dashboard_activated:99}]});
  const app=await renderFixture(fixture,'#/facebook/ad/PIL-PA-01');
  assert.equal((app.view.match(/data-diy-signal=/g)||[]).length,4); assert.doesNotMatch(app.view,/data-signal=/);
  assert.match(app.view,/data-diy-signal="studio_started"><b>2<\/b>/); assert.doesNotMatch(app.view,/>99</);
  assert.match(app.view,/<b>CPM<\/b> 80 €/); assert.match(app.view,/von den Meta-Kennzahlen oben getrennt/);
  assert.equal(app.node('#period-wrap').hidden,false); app.period('latest'); assert.match(app.view,/data-diy-signal="studio_started"><b>2<\/b>/);
});
test('DIY error preserves its previous values and clock while marking failure, even if the clock is fresh', async () => {
  const fixture=withMetrics(), source=diySource({status:'error',error:'DIY_PERMISSION_REQUIRED',daily:[{date:'2026-10-26',code:'PIL-PA-01',studio_started:1,call_requested:null,checkout_started:null,dashboard_activated:null}]}); fixture.sources.diy_funnel=source;
  const app=await renderFixture(fixture,'#/funnel/diy'); assert.match(app.view,/Abruf fehlgeschlagen/); assert.match(app.view,/Letzte bekannte Werte bleiben sichtbar/); assert.match(app.view,/data-diy-count="studio_started">1/);
  assert.doesNotMatch(app.view,/Aktuell abgerufen/); assert.equal(source.observed_at,fixture.sources.diy_funnel.observed_at);
  app.navigate('#/tracking'); assert.match(app.view,/Eigener DIY-Ablauf/); assert.match(app.view,/Versuch:/);
});
test('live link audit distinguishes verified core, unverified extra values and historical template copy', async () => {
  const fixture=withMetrics(), source=auditSource(); source.ads[0].status='core_verified_extra_review'; source.ads[0].extra_keys=[{key:'utm_id',category:'optional_utm'},{key:'hsa_acc',category:'crm_tracking'}]; fixture.sources.link_audit=source;
  const app=await renderFixture(fixture,'#/tracking/links');
  assert.equal((app.view.match(/Kernlink &amp; UTM geprüft/g)||[]).length,13); assert.match(app.view,/13 von 13 Anzeigen/);
  assert.match(app.view,/utm_id, hsa_acc/); assert.match(app.view,/Die Werte wurden nicht geprüft/);
  assert.match(app.view,/bestätigten Kernlink nicht automatisch ungültig/); assert.doesNotMatch(app.view,/UTM kaputt|UNEXPECTED_URL_TAG_KEYS/);
  assert.match(app.view,/hinterlegte Anzeigen-\/UTM-Vorlage vom 23.10/); await app.copy('PIL-PA-01'); assert.match(app.clipboard[0],/\{\{ad.id\}\}/); assert.match(app.node('#copy-status').textContent,/Meta ersetzt \{\{…\}\}/);
});
test('partial link audit uses per-ad last-check clocks and never turns retained checks into a new success', async () => {
  const fixture=withMetrics(), old='2026-10-25T08:00:00.000Z', source=auditSource({status:'partial',complete:false,checked_count:12,error:'LINK_AUDIT_PARTIAL_FAILURE'}); source.ads[0].status='read_error'; source.ads[0].checked_at=old; source.ads[0].error='META_PERMISSION_REQUIRED'; fixture.sources.link_audit=source;
  const app=await renderFixture(fixture,'#/tracking/links'); assert.match(app.view,/Teilweise abgerufen/); assert.match(app.view,/12 von 13 Anzeigen/); assert.match(app.view,/Abruf fehlgeschlagen/); assert.match(app.view,/25\. Okt\., 09:00/); assert.match(app.view,/Neuer Versuch:/);
  const first=app.view.match(/<tbody>(<tr>[\s\S]*?<\/tr>)/)[1]; assert.doesNotMatch(first,/Kernlink &amp; UTM geprüft/);
});
test('audit configuration failures show safe check names; arbitrary URLs, values, errors and parameter names never render', async () => {
  const fixture=withMetrics(),source=auditSource(); const row=source.ads[0]; row.status='needs_review'; row.error='PRIVATE_ERROR'; row.checks.skin=false; row.raw_url='https://private.example/PRIVATE_RAW'; row.extra_keys=[{key:'PRIVATE_PARAMETER',category:'PRIVATE_CATEGORY'},{key:'hsa_cam',category:'crm_tracking',value:'PRIVATE_VALUE'}]; row.unrecognized_extra_key_count=1; fixture.sources.link_audit=source;
  const app=await renderFixture(fixture,'#/tracking/links'); assert.match(app.view,/Konfiguration prüfen/); assert.match(app.view,/Pilates-Skin/); assert.match(app.view,/Weitere nicht zugeordnete Parameter: 1/); assert.match(app.view,/hsa_cam/); assert.doesNotMatch(app.view,/PRIVATE_/);
});
test('stale awaiting and pending audit states do not become fresh because the page was opened', async () => {
  const fixture=withMetrics(); fixture.sources.diy_funnel=diySource({observed_at:'2026-10-26T02:31:00.000Z'});
  const app=await renderFixture(fixture,'#/funnel/diy'); assert.match(app.view,/Wartet auf Signale · veraltet/); assert.match(app.view,/Letzter belegter Stand/); assert.doesNotMatch(app.view,/Aktuell abgerufen|Zugang geprüft · wartet/);
  fixture.sources.link_audit=auditSource({status:'pending',observed_at:null,attempted_at:null,checked_count:0,request_count:0,complete:false});
  fixture.sources.link_audit.ads.forEach(row=>{row.status='pending';row.checked_at=null;row.attempted_at=null;row.checks=Object.fromEntries(Object.keys(row.checks).map(key=>[key,null]));row.tag_checks=Object.fromEntries(Object.keys(row.tag_checks).map(key=>[key,null]));row.unrecognized_extra_key_count=null;});
  await app.reload(fixture); app.navigate('#/tracking/links'); assert.match(app.view,/Prüfung ausstehend/); assert.doesNotMatch(app.view,/Kernlink &amp; UTM geprüft|Aktuell abgerufen/);
});
test('overview has four KPIs, real source status and no invented business targets', async () => {
  const app = await renderFixture();
  assert.equal((app.view.match(/class="metric(?: highlight)?"/g)||[]).length,4);
  assert.deepEqual([...app.view.matchAll(/class="metric-label">([^<]+)</g)].map(item=>item[1]),['Ausgaben','Linkklicks','Zielseitenaufrufe','Lead-Signale']);
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
  assert.match(app.view,/class="metric-label">Lead-Signale<\/span><strong class="metric-value">Mind. 1<\/strong>/);
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
test('gallery preserves twelve original images and the recovered original video by their approved hashes', async () => {
  const app = await renderFixture(original,'#/facebook/creatives');
  assert.equal((app.view.match(/class="creative-card"/g)||[]).length,13); assert.equal((app.view.match(/<img /g)||[]).length,12);
  assert.match(app.view,/freigegebenen Motive und Texte vom 22.10./); assert.match(app.view,/Originalvideo · 58 Sekunden/); assert.doesNotMatch(app.view,/Originaldatei derzeit nicht verknüpft/);
  assert.match(app.view,/https:\/\/claude.ai\/artifact\/QDK36dCNCCbttM9zscGHx8/); assert.doesNotMatch(app.view,/<video|localStorage|contenteditable/);
  assert.equal(CREATIVE_CATALOG.length,13);
  for (const item of CREATIVE_CATALOG) {
    assert.equal(new URL(item.targetUrl).hostname,'start.chatline.app'); assert.equal(new URL(item.targetUrl).searchParams.get('skin'),'pilates');
    assert.match(item.urlParameters,/ad_id=\{\{ad.id\}\}/);
    if(item.asset) { const bytes=await readFile(new URL('../public'+item.asset,import.meta.url)); assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256.toLowerCase()); }
    else assert.fail('Every approved creative now has its original local asset');
  }
  const video=CREATIVE_CATALOG.find(row=>row.code==='PIL-VID-01');
  assert.equal(video.asset,'/creatives/PIL-VID-01.mp4');
  assert.equal(video.sha256,'e3244cc428b55a6173d853649e39676885b0dd6890ed5ea9b73e0dae3faf7f99');
});
test('details map fixed copy and exact Meta ID to five distinct downstream signals', async () => {
  const app = await renderFixture(withMetrics(),'#/facebook/ad/PIL-PA-01'), item=CREATIVE_CATALOG[0];
  assert.ok(app.view.includes(item.primary)); assert.ok(app.view.includes(`act=2128240694419507&amp;selected_ad_ids=${item.adId}`));
  assert.match(app.view,/<b>CPM<\/b> 80 € je 1.000 Impressionen/);
  assert.match(app.view,/<b>CPC<\/b> 1,6 € je Linkklick/);
  assert.match(app.view,/<b>CTR<\/b> 5 % Linkklickrate/);
  for(const [key,value] of [['landing_page_views','4'],['studio_tests','2'],['call_requests','1'],['checkouts','0'],['trials','—']]) assert.ok(app.view.includes(`data-signal="${key}"><b>${value}</b>`));
  app.navigate('#/facebook/ad/PIL-VID-01'); assert.match(app.view,/<video[^>]*src="\/creatives\/PIL-VID-01\.mp4"[^>]*controls playsinline preload="metadata"/); assert.doesNotMatch(app.view,/autoplay|<img|Originaldatei derzeit nicht verknüpft/);
  app.navigate('#/facebook/ad/UNAPPROVED'); assert.match(app.view,/nicht Teil der freigegebenen/); assert.doesNotMatch(app.view,/selected_ad_ids/);
});
test('missing media fallback is shown only when the selected creative has no linked asset', async () => {
  const catalog=structuredClone(CREATIVE_CATALOG); catalog.find(row=>row.code==='PIL-VID-01').asset=null;
  const app=await renderFixture(original,'#/facebook/ad/PIL-VID-01',catalog);
  assert.match(app.view,/Originaldatei derzeit nicht verknüpft/); assert.doesNotMatch(app.view,/<video/);
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
  for(const label of ['Meta-Lead-Signal','Telefon / Testanruf angefordert','Zahlungsseite / Checkout begonnen','Einrichtung / Testphase begonnen']) assert.ok(app.view.includes(label));
  assert.match(app.view,/funnel-count">0<\/td>/); assert.match(app.view,/funnel-count">—(?:<span|<\/td>)/);
  assert.match(app.view,/Die Schritte zählen nicht zwangsläufig dieselben Studios; daher keine Conversionrate/); assert.doesNotMatch(app.view,/Anteil \/ Rate/); assert.doesNotMatch(app.view,/>[\d,.]+ %<\/td>|E-Mail|Emaileingabe|Zahlung bestätigt/);
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
  app.navigate('#/tracking/criteria'); assert.match(app.view,/keine festen Abschaltgrenzen/); assert.match(app.view,/noch gemeinsam festzulegen/);
  assert.match(app.view,/seit Beginn desselben Teststands/); assert.match(app.view,/Link-CPC = Gesamtausgaben geteilt durch Linkklicks/); assert.match(app.view,/nicht alle Klicks und kein Tagesreset/);
  assert.match(app.view,/Top-Spender ist kein Gewinner/); assert.match(app.view,/CPM allein entscheidet nicht/); assert.match(app.view,/Tracking und Landingpage prüfen/); assert.match(app.view,/Zeit vor einer neuen Messung sind keine Null/); assert.match(app.view,/Die Entscheidung bleibt menschlich/);
  assert.doesNotMatch(app.view,/2 €|5 €|10 €|25 Klicks|progress/);
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
  // GitHub uploads may preserve CRLF; compare source content without checkout-specific line endings.
  assert.equal((await readFile(new URL('../public/assets/model.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n'),(await readFile(new URL('./model.mjs',import.meta.url),'utf8')).replace(/\r\n/g,'\n'));
});

test('campaign selector separates five traffic ads, metrics, exact IDs and their own tracking sources', async()=>{
 const snapshot=structuredClone(original), at=new Date().toISOString();
 snapshot.sources.meta_traffic={campaign:TRAFFIC.campaign,adset:TRAFFIC.adset,status:'connected',observed_at:at,attempted_at:at,timezone:'Europe/Berlin',period:{from:'2026-10-22',to:'2026-10-27'},complete_test_window:true,daily:[{date:'2026-10-27',spend:35,impressions:1000,link_clicks:200,landing_page_views:100,studio_tests:null}],ads_daily:TRAFFIC_ADS.map(ad=>({date:'2026-10-27',code:ad.code,spend:7,link_clicks:40,impressions:200})),statuses:TRAFFIC_ADS.map(ad=>({code:ad.code,status:'ACTIVE',delivery:'ACTIVE'}))};
 const app=await renderFixture(snapshot,'#/overview');
 assert.match(app.view,/Ursprünglicher Pilates-Test/);assert.match(app.view,/Traffic · Deutschland/);
 app.select('campaign','traffic');assert.match(app.view,/Traffic getrennt prüfen/);assert.match(app.view,/35 €/);
 app.navigate('#/facebook');assert.equal((app.view.match(/<tr><td><a class="table-name"/g)||[]).length,5);assert.match(app.view,/PIL-LM-01/);
 app.navigate('#/facebook/ad/PIL-PA-01');assert.match(app.view,/120275454337290555/);assert.doesNotMatch(app.view,/selected_ad_ids=120275421779180555/);
 app.navigate('#/funnel/diy');assert.match(app.view,/noch nicht verbunden/);assert.doesNotMatch(app.view,/data-diy-count=/);
 app.navigate('#/tracking/links');assert.equal((app.view.match(/data-copy=/g)||[]).length,5);await app.copy('PIL-PA-01');assert.match(app.clipboard.at(-1),/120275454337280555-pil-pa-01/);assert.match(app.clipboard.at(-1),/pilates_de_inhaber_linkklicks_20261024/);assert.doesNotMatch(app.clipboard.at(-1),/120275421779190555/);
 app.select('campaign','original');app.navigate('#/facebook');assert.equal((app.view.match(/<tr><td><a class="table-name"/g)||[]).length,13);
});

test('Traffic DIY and PA-01 details use separate aggregates even when both campaigns share a creative code', async()=>{
 const fixture=withMetrics(), row={date:'2026-10-26',code:'PIL-PA-01',studio_started:99,call_requested:99,checkout_started:99,dashboard_activated:99};
 fixture.sources.diy_funnel=diySource({status:'connected',daily:[row]});
 fixture.sources.diy_funnel_traffic=diySource({campaign:TRAFFIC.campaign,status:'connected',daily:[{...row,studio_started:2,call_requested:null,checkout_started:null,dashboard_activated:null}]});
 const before=structuredClone(fixture), app=await renderFixture(fixture,'#/funnel/diy');
 assert.match(app.view,/data-diy-count="studio_started">99/);
 app.select('campaign','traffic');
 assert.match(app.view,/data-diy-count="studio_started">2/); assert.doesNotMatch(app.view,/data-diy-count="[^"]+">99/);
 assert.match(app.view,/data-diy-count="call_requested">—/); assert.match(app.view,/Technische Projektgrenze/);
 assert.match(app.view,/kein Nachweis, dass diese Kampagne seitdem vollständig instrumentiert war/);
 app.navigate('#/facebook/ad/PIL-PA-01'); assert.match(app.view,/data-diy-signal="studio_started"><b>2<\/b>/); assert.doesNotMatch(app.view,/data-diy-signal="[^"]+"><b>99/);
 app.select('campaign','original'); assert.match(app.view,/data-diy-signal="studio_started"><b>99<\/b>/);
 assert.deepEqual(fixture,before);
});

test('Traffic link view uses only its five exact identities and preserves its own failed check time', async()=>{
 const fixture=withMetrics(), at=new Date().toISOString(), old='2026-10-25T08:00:00.000Z';
 fixture.sources.link_audit=auditSource();
 fixture.sources.link_audit_traffic=auditSource({checked_count:5,request_count:5,ads:TRAFFIC_ADS.map(ad=>({...auditSource().ads[0],ad_id:ad.ad_id,code:ad.code,checked_at:at,attempted_at:at}))});
 const app=await renderFixture(fixture,'#/tracking/links'); app.select('campaign','traffic');
 assert.match(app.view,/5 von 5 Anzeigen/); assert.equal((app.view.match(/Kernlink &amp; UTM geprüft/g)||[]).length,5);
 await app.copy('PIL-PA-01'); const url=new URL(app.clipboard.at(-1));
 assert.equal(url.searchParams.get('ref'),`meta-pilates-de-${TRAFFIC.adset}-pil-pa-01`);
 assert.equal(url.searchParams.getAll('ref').length,1); assert.equal(url.searchParams.get('skin'),'pilates');
 assert.equal(url.searchParams.get('utm_campaign'),'pilates_de_inhaber_linkklicks_20261024');
 assert.equal(url.searchParams.get('ad_id'),'{{ad.id}}');
 const count=app.clipboard.length; await app.copy('PIL-PR-01'); assert.equal(app.clipboard.length,count);
 const source=fixture.sources.link_audit_traffic; source.status='partial'; source.complete=false; source.checked_count=4; source.error='LINK_AUDIT_PARTIAL_FAILURE';
 source.ads[0].status='read_error'; source.ads[0].checked_at=old; source.ads[0].error='META_PERMISSION_REQUIRED';
 await app.reload(fixture); assert.match(app.view,/4 von 5 Anzeigen/); assert.match(app.view,/25\. Okt\., 09:00/);
 const first=app.view.match(/<tbody>(<tr>[\s\S]*?<\/tr>)/)[1]; assert.match(first,/Abruf fehlgeschlagen/); assert.doesNotMatch(first,/Kernlink &amp; UTM geprüft/);
 app.select('campaign','original'); assert.match(app.view,/13 von 13 Anzeigen/);
});

test('historical login errors describe the failed attempt without asserting a current profile lockout', async()=>{
 const fixture=withMetrics(); fixture.sources.search_console=gscFixture(); fixture.sources.search_console.status='error'; fixture.sources.search_console.error='GSC_LOGIN_REQUIRED';
 fixture.sources.website_events.status='error'; fixture.sources.website_events.error='META_LOGIN_REQUIRED'; fixture.sources.website_events.source_code='events_manager_ui';
 const app=await renderFixture(fixture,'#/tracking');
 assert.match(app.view,/letzte Search-Console-Abruf meldete eine fehlende Anmeldung/);
 assert.match(app.view,/letzte Meta-Abruf meldete eine fehlende Anmeldung/);
 assert.match(app.view,/aktuelle Zugriff ist damit nicht neu geprüft/);
 assert.match(app.view,/Letzter bestätigter Events-Manager-Stand; neuer Abruf fehlgeschlagen/);
 assert.doesNotMatch(app.view,/Search Console muss erneut angemeldet werden|Der lesende Meta-Zugang muss erneuert werden|Aus Events Manager gelesen · Eingänge/);
});

test('all four finite campaign selectors are visible and registry presence never claims CRM/LAL publication',async()=>{
 assert.match(html,/option value="crm"/); assert.match(html,/option value="lookalike"/);
 const app=await renderFixture(withMetrics(),'#/funnel/diy');
 for(const key of ['crm','lookalike']){
  await app.clickCampaign(key); assert.match(app.view,/Registry allein bestätigt keine Veröffentlichung oder Auslieferung/);
  assert.match(app.view,/Eigener DIY-Ablauf noch nicht verbunden/); assert.doesNotMatch(app.view,/data-diy-count=/);
  app.navigate('#/facebook'); assert.equal((app.view.match(/<tr><td><a class="table-name"/g)||[]).length,3); app.navigate('#/funnel/diy');
 }
 await app.clickCampaign('120275503974760555'); app.navigate('#/facebook'); assert.equal((app.view.match(/<tr><td><a class="table-name"/g)||[]).length,13);
});

test('new-cohort Meta fields remain unknown and do not reuse original spend, delivery, media or lead signals',async()=>{
 const snapshot=withMetrics(),app=await renderFixture(snapshot,'#/facebook/ad/VID-01');
 for(const key of ['crm','lookalike']){
  app.navigate('#/facebook/ad/VID-01');
  app.select('campaign',key);
  assert.match(app.view,/Meta-Leistungsdaten und Auslieferungsstatus sind noch nicht bestätigt/);
  assert.match(app.view,/class="metric-label">Ausgaben<\/span><strong class="metric-value">—/);
  assert.match(app.view,/data-signal="studio_tests"><b>—<\/b>/); assert.doesNotMatch(app.view,/data-signal="studio_tests"><b>2<\/b>|8 €|PIL-VID-01\.mp4/);
  assert.match(app.view,/Geprüfter Trackingvertrag · keine Live-Fassung/);
  assert.match(app.view,/Medien und Texte sind hier nicht hinterlegt/);
  app.navigate('#/facebook/creatives'); assert.equal((app.view.match(/Trackingvertrag · Medien nicht hinterlegt/g)||[]).length,3); assert.doesNotMatch(app.view,/Freigegebene Fassung 22\.10\.|Freigegeben am 22\.10\./);
 }
});

test('CRM and LAL VID-01 DIY views keep their own aggregate count, unknown steps and independent UTC clock',async()=>{
 const fixture=withMetrics(),row={date:'2026-10-26',code:'VID-01',studio_started:2,call_requested:null,checkout_started:0,dashboard_activated:null};
 fixture.sources.diy_funnel=diySource({status:'connected',daily:[{...row,code:'PIL-PA-01',studio_started:99}]});
 fixture.sources.diy_funnel_crm=diySource({campaign:CRM.campaign,status:'connected',observed_at:'2026-10-28T09:01:00.000Z',daily:[row]});
 fixture.sources.diy_funnel_lookalike=diySource({campaign:LOOKALIKE.campaign,status:'connected',observed_at:'2026-10-28T09:02:00.000Z',daily:[{...row,studio_started:11}]});
 const before=structuredClone(fixture),app=await renderFixture(fixture,'#/funnel/diy');
 app.select('campaign','crm'); assert.match(app.view,/data-diy-count="studio_started">2/); assert.match(app.view,/09:01 UTC/); assert.match(app.view,/data-diy-count="call_requested">—/); assert.match(app.view,/data-diy-count="checkout_started">0/);
 app.select('campaign','lookalike'); assert.match(app.view,/data-diy-count="studio_started">11/); assert.match(app.view,/09:02 UTC/); assert.doesNotMatch(app.view,/data-diy-count="studio_started">2/);
 app.navigate('#/facebook/ad/VID-01'); assert.match(app.view,/data-diy-signal="studio_started"><b>11<\/b>/);
 app.select('campaign','crm'); assert.match(app.view,/data-diy-signal="studio_started"><b>2<\/b>/); assert.deepEqual(fixture,before);
});

test('all six cohort copy links use unique skin/ref/IDs, literal content prefixes and the selected fixed adset',async()=>{
 const app=await renderFixture(withMetrics(),'#/tracking/links');
 for(const [key,scope,ads,prefix,utm] of [['crm',CRM,CRM_ADS,'crm-direct','chatline_crm_direct_20261027'],['lookalike',LOOKALIKE,LOOKALIKE_ADS,'crm-lookalike','chatline_crm_lookalike_20261027']]){
  app.select('campaign',key); assert.equal((app.view.match(/data-copy=/g)||[]).length,3); assert.match(app.view,/Noch kein aktueller Link-Abruf für diese Cohort/);
  for(const ad of ads){
   await app.copy(ad.code);const url=new URL(app.clipboard.at(-1));
   for(const param of ['skin','ref','campaign_id','adset_id','ad_id','utm_source','utm_medium','utm_campaign','utm_content'])assert.equal(url.searchParams.getAll(param).length,1);
   assert.equal(url.searchParams.get('skin'),'pilates'); assert.equal(url.searchParams.get('ref'),`meta-${prefix}-${scope.adset}-${ad.code.toLowerCase()}`);
   assert.equal(url.searchParams.get('campaign_id'),'{{campaign.id}}'); assert.equal(url.searchParams.get('adset_id'),'{{adset.id}}'); assert.equal(url.searchParams.get('ad_id'),'{{ad.id}}');
   assert.equal(url.searchParams.get('utm_source'),'{{site_source_name}}');assert.equal(url.searchParams.get('utm_medium'),'paid_social');assert.equal(url.searchParams.get('utm_campaign'),utm);
   assert.equal(url.searchParams.get('utm_content'),`${prefix}-${ad.code.toLowerCase()}`);assert(!app.clipboard.at(-1).includes('120275503974780555'));
  }
  const count=app.clipboard.length; await app.copy('PIL-VID-01');assert.equal(app.clipboard.length,count);
 }
});

test('three-ad link completeness and failed check clocks stay separate from the other cohort and original thirteen',async()=>{
 const fixture=withMetrics(), at=new Date().toISOString(), old='2026-10-25T08:00:00.000Z';
 fixture.sources.link_audit=auditSource();
 for(const [key,ads] of [['crm',CRM_ADS],['lookalike',LOOKALIKE_ADS]])fixture.sources[`link_audit_${key}`]=auditSource({checked_count:3,request_count:3,ads:ads.map(ad=>({...auditSource().ads[0],ad_id:ad.ad_id,code:ad.code,checked_at:at,attempted_at:at}))});
 const failed=fixture.sources.link_audit_crm;failed.status='partial';failed.complete=false;failed.checked_count=2;failed.error='LINK_AUDIT_PARTIAL_FAILURE';failed.ads[0].status='read_error';failed.ads[0].checked_at=old;failed.ads[0].error='META_PERMISSION_REQUIRED';
 const app=await renderFixture(fixture,'#/tracking/links');app.select('campaign','crm');assert.match(app.view,/2 von 3 Anzeigen/);assert.match(app.view,/25\. Okt\., 09:00/);
 const first=app.view.match(/<tbody>(<tr>[\s\S]*?<\/tr>)/)[1];assert.match(first,/Abruf fehlgeschlagen/);assert.doesNotMatch(first,/Kernlink &amp; UTM geprüft/);
 app.select('campaign','lookalike');assert.match(app.view,/3 von 3 Anzeigen/);assert.equal((app.view.match(/Kernlink &amp; UTM geprüft/g)||[]).length,3);assert.doesNotMatch(app.view,/25\. Okt\., 09:00/);
 app.select('campaign','original');assert.match(app.view,/13 von 13 Anzeigen/);
});

test('new-cohort awaiting/error sources render unknowns and retained observations without zero conversions or a fresh success',async()=>{
 const fixture=withMetrics();fixture.sources.diy_funnel_crm=diySource({campaign:CRM.campaign});
 fixture.sources.diy_funnel_lookalike=diySource({campaign:LOOKALIKE.campaign,status:'error',error:'DIY_PERMISSION_REQUIRED',observed_at:'2026-10-27T08:00:00.000Z',daily:[{date:'2026-10-26',code:'VID-01',studio_started:3,call_requested:null,checkout_started:null,dashboard_activated:null}]});
 const app=await renderFixture(fixture,'#/funnel/diy');app.select('campaign','crm');assert.equal((app.view.match(/data-diy-count="[^"]+">—<\/td>/g)||[]).length,4);assert.doesNotMatch(app.view,/data-diy-count="[^"]+">0/);
 app.select('campaign','lookalike');assert.match(app.view,/Abruf fehlgeschlagen/);assert.match(app.view,/27\. Okt\., 08:00 UTC/);assert.match(app.view,/data-diy-count="studio_started">3/);assert.doesNotMatch(app.view,/Aktuell abgerufen/);
 app.navigate('#/tracking');assert.match(app.view,/Eigener DIY-Ablauf · CRM/);assert.match(app.view,/Eigener DIY-Ablauf · Lookalike/);assert.match(app.view,/Anzeigenlinks · CRM/);assert.match(app.view,/Anzeigenlinks · Lookalike/);
});

function performanceSource(scope,ads,spend,budget){
 const at=new Date().toISOString(),row={date:'2026-10-28',spend,impressions:100,reach:80,link_clicks:4,landing_page_views:null,studio_tests:null,call_requests:null,checkouts:null,trials:null};
 return {campaign:scope.campaign,adset:scope.adset,status:'connected',error:null,observed_at:at,attempted_at:at,timezone:'Europe/Berlin',period:{from:'2026-10-28',to:'2026-10-28'},complete_test_window:false,budget_daily:budget,delivery:'ACTIVE',attribution:'Meta · conversion date',daily:[row],ads_daily:[{...row,code:'VID-01'}],statuses:ads.map(ad=>({code:ad.code,status:'ACTIVE',delivery:'IN_PROCESS'}))};
}
test('CRM and LAL show separate measured performance, source times and selected budgets without adding legacy configuration budgets',async()=>{
 const snapshot=withMetrics();snapshot.sources.meta.delivery='PAUSED';snapshot.sources.meta.budget_daily=200;
 snapshot.sources.meta_crm=performanceSource(CRM,CRM_ADS,0.8,2);snapshot.sources.meta_lookalike=performanceSource(LOOKALIKE,LOOKALIKE_ADS,1.1,13);
 const app=await renderFixture(snapshot,'#/overview');app.select('campaign','crm');
 assert.match(app.view,/class="metric-label">Ausgaben<\/span><strong class="metric-value">0,8 €/);assert.match(app.view,/<strong>2 €<\/strong><span>gemeldetes Ø-Tagesbudget/);assert.doesNotMatch(app.view,/<strong>200 €<\/strong>|Gesamtbudget.*220|Meta-Leistungsdaten und Auslieferungsstatus sind noch nicht bestätigt/);
 assert.match(app.view,/Quellenstand/);app.navigate('#/facebook/ad/VID-01');assert.match(app.view,/class="metric-label">Ausgaben<\/span><strong class="metric-value">0,8 €/);assert.match(app.view,/selected_ad_ids=120275505908750555/);
 app.select('campaign','lookalike');assert.match(app.view,/class="metric-label">Ausgaben<\/span><strong class="metric-value">1,1 €/);assert.match(app.view,/selected_ad_ids=120275504052480555/);
 app.navigate('#/overview');assert.match(app.view,/<strong>13 €<\/strong><span>gemeldetes Ø-Tagesbudget/);app.navigate('#/tracking');assert.match(app.view,/Facebook · CRM/);assert.match(app.view,/Facebook · Lookalike/);
});
test('empty and failed new Meta sources render unknown days or retained old observations, without false zeros or publication inference',async()=>{
 const snapshot=withMetrics(),source=performanceSource(CRM,CRM_ADS,0.8,2);source.daily=[];source.ads_daily=[];snapshot.sources.meta_crm=source;
 const app=await renderFixture(snapshot,'#/overview');app.select('campaign','crm');assert.match(app.view,/class="metric-label">Ausgaben<\/span><strong class="metric-value">—/);assert.match(app.view,/Fehlende Tageszeilen bleiben unbekannt, nicht 0/);assert.equal(app.node('#period option[value="all"]').disabled,true);
 const old='2026-10-28T08:00:00.000Z';source.status='error';source.error='META_LOGIN_REQUIRED';source.observed_at=old;source.daily=performanceSource(CRM,CRM_ADS,0.8,2).daily;await app.reload(snapshot);
 assert.match(app.view,/letzte Meta-Abruf ist fehlgeschlagen/);assert.match(app.view,/frühere Werte und Zeitpunkte bleiben erhalten/);assert.match(app.view,/class="metric-label">Ausgaben<\/span><strong class="metric-value">0,8 €/);assert.match(app.view,/28\. Okt\., 09:00/);assert.doesNotMatch(app.view,/Aktuell abgerufen/);
});
test('effective-ref audit labels are truthful while legacy failed placement checks keep their historical wording',async()=>{
 const fixture=withMetrics(),at=new Date().toISOString();
 const source=auditSource({checked_count:3,request_count:3,ads:CRM_ADS.map(ad=>({...auditSource().ads[0],ad_id:ad.ad_id,code:ad.code,checked_at:at,attempted_at:at}))});
 for(const row of source.ads){delete row.checks.landing_keys_in_url_tags_absent;row.checks.landing_parameter_locations_valid=true;}
 fixture.sources.link_audit_crm=source;const app=await renderFixture(fixture,'#/tracking/links');app.select('campaign','crm');assert.equal((app.view.match(/Kernlink &amp; UTM geprüft/g)||[]).length,3);
 const row=source.ads[0];row.status='needs_review';row.error='DESTINATION_CONFIG_REVIEW_REQUIRED';row.checks.landing_parameter_locations_valid=false;await app.reload(fixture);assert.match(app.view,/Offen: Effektive Parameteraufteilung/);
 delete row.checks.landing_parameter_locations_valid;row.checks.landing_keys_in_url_tags_absent=false;row.checks.ref=false;await app.reload(fixture);assert.match(app.view,/Offen: Anzeigenreferenz, Zielparameter|Offen: Zielparameter, Anzeigenreferenz/);assert.doesNotMatch(app.view,/Offen: Effektive Parameteraufteilung/);
});

import {validateSnapshot, mergeAnalytics, ANALYTICS_PROJECTS} from '../api/data.js';
function gscFixture() {
 return {source_code:'gsc_web_ui_csv',method:'csv',site:'chatline.app',label:'chatline.app + start.chatline.app',status:'connected',observed_at:'2026-10-27T17:46:00.599Z',attempted_at:'2026-10-27T17:46:00.599Z',error:null,timezone:'America/Los_Angeles',period:{from:'2026-10-22',to:'2026-10-26'},daily:[10,7,3,6,5].map((impressions,index)=>({date:'2026-10-'+(22+index),clicks:0,impressions})),note:'26.10. vorläufig; 27.10. nicht als abgeschlossener Nulltag übernommen.'};
}
test('GSC permits only the two approved hosts, PT calendar days and nullable aggregate counts',()=>{
 const snapshot=structuredClone(original);snapshot.sources.search_console=gscFixture();validateSnapshot(snapshot);
 const mutations=[s=>s.site='other.invalid',s=>s.label='other.invalid',s=>s.timezone='Europe/Berlin',s=>s.daily[1].date=s.daily[0].date,s=>s.daily[0].clicks=-1,s=>s.daily[0].impressions=1.5,s=>s.daily[0].ref='private-page',s=>s.daily.pop(),s=>s.period.to='2026-02-30',s=>s.observed_at='invalid'];
 for(const mutate of mutations){const bad=structuredClone(snapshot);mutate(bad.sources.search_console);assert.throws(()=>validateSnapshot(bad),/SNAPSHOT/);}
 snapshot.sources.search_console.daily[0].clicks=null;validateSnapshot(snapshot);
});
test('independent analytics refresh preserves the manual GSC counts and source clock exactly',()=>{
 const snapshot=structuredClone(original);snapshot.sources.search_console=gscFixture();const at='2026-10-27T18:00:00.000Z';
 const next=mergeAnalytics(snapshot,ANALYTICS_PROJECTS.map(p=>({site:p.site,label:p.label,status:'connected',observed_at:at,attempted_at:at,error:null,timezone:'UTC',daily:[]})),{now:new Date(at)});
 assert.deepEqual(next.sources.search_console,snapshot.sources.search_console);
});
test('GSC UI separates combined organic counts, PT period, preliminary days and failed source reads',async()=>{
 const snapshot=structuredClone(original);snapshot.sources.search_console=gscFixture();const app=await renderFixture(snapshot,'#/website');
 assert.match(app.view,/Organische Suche · beide Hosts/);assert.match(app.view,/Gemeldete Suchklicks<\/span><strong class="metric-value">0/);assert.match(app.view,/31/);assert.match(app.view,/Pacific Time/);assert.match(app.view,/26. Okt. 2026/);assert.match(app.view,/jüngsten GSC-Werte sind vorläufig/);assert.doesNotMatch(app.view,/Suchklicks und Suchimpressionen sind noch nicht verfügbar/);
 app.select('campaign','traffic');assert.match(app.view,/kein kampagnen- oder hostbezogener Besuchernachweis/i);
 snapshot.sources.search_console.status='error';snapshot.sources.search_console.daily[0].clicks=null;await app.reload(snapshot);assert.match(app.view,/neue Abruf ist fehlgeschlagen/);assert.match(app.view,/Gemeldete Suchklicks<\/span><strong class="metric-value">—/);
 app.navigate('#/tracking');assert.match(app.view,/Google · organische Suche/);assert.match(app.view,/GSC-Messtage: Pacific Time/);
});
