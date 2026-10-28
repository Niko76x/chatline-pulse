import { TRAFFIC, TRAFFIC_ADS } from './campaigns.js';
import { freshness, summarize, analyticsView, reviewAd } from './model.js';
import { CREATIVE_CATALOG } from './creative-catalog.js';
import { reportedCount } from './count-display.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const num = (value, decimals = 0) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : new Intl.NumberFormat('de-DE', { maximumFractionDigits: decimals }).format(value);
const money = value => value === null || value === undefined ? '—' : `${num(value, 2)} €`;
const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`)) : '—';
const time = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Noch kein Abruf';
const routes = {
  overview: ['DER TEST IM BLICK', 'Übersicht', 'Was der aktuelle Pilates-Test bewirkt.'],
  facebook: ['ANZEIGEN & TESTIDEEN', 'Facebook', 'Welche Anzeige liefert welche Signale?'],
  website: ['BESUCHE & SEITENAUFRUFE', 'Website', 'Wie viele Menschen die Website pro Tag erreichen.'],
  funnel: ['VON DER WEBSITE ZUM STUDIO-TEST', 'Funnel', 'Wo die nächsten Schritte stattfinden – und wo Messwerte fehlen.'],
  tracking: ['VERBINDUNGEN & NACHVOLLZIEHBARKEIT', 'Tracking', 'Datenstand, Anzeigenlinks und offene Prüfkriterien.'],
};
let data = null, transport = {}, loadFailed = false;
const state = { campaign: 'original', period: null, search: '', stage: 'all', delivery: 'all', sort: 'code', site: 'start.chatline.app', trackingTab: 'sources' };
function isTraffic() { return state.campaign === 'traffic'; }
function metaSource() { return isTraffic() ? data.sources.meta_traffic || { status: 'not_connected', observed_at: null, attempted_at: null, daily: [], ads_daily: [], statuses: [] } : data.sources.meta; }
function campaignAds() { return isTraffic() ? TRAFFIC_ADS : data.ads; }
function diySource() { return data.sources[isTraffic() ? 'diy_funnel_traffic' : 'diy_funnel']; }
function linkSource() { return data.sources[isTraffic() ? 'link_audit_traffic' : 'link_audit']; }
function linkCatalog() {
  return isTraffic() ? TRAFFIC_ADS.map(ad => ({ code: ad.code, adId: ad.ad_id,
    targetUrl: `https://start.chatline.app/?skin=pilates&ref=meta-pilates-de-${TRAFFIC.adset}-${ad.code.toLowerCase()}`,
    urlParameters: `campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign=pilates_de_inhaber_linkklicks_20261024&utm_content=${ad.code.toLowerCase()}` })) : CREATIVE_CATALOG;
}
function campaignNotice() { return isTraffic() ? `<div class="callout"><b>Traffic getrennt prüfen</b>Fünf Anzeigen mit eigenem DIY- und Link-Prüfstand. Ein gültiger Abruf beweist keine vollständige Start-Instrumentierung oder CAPI-Zustellung.${metaSource().complete_test_window === false ? ' Der Meta-Zeitraum ist nur teilweise belegt; fehlende Tage sind keine Null.' : ''}</div>` : ''; }
function campaignCards() {
  return '<div class="grid-two">' + [['original','Ursprünglicher Pilates-Test',data.sources.meta],['traffic',TRAFFIC.name,data.sources.meta_traffic]].map(([key,label,source]) => {
    const rows = (source?.daily || []).filter(r => state.period === 'all' || r.date === source?.period?.to), metrics = summarize(rows);
    return `<section class="panel"><h2>${esc(label)}</h2>${badge(source)}<p class="panel-note">${key === 'traffic' ? 'Traffic · Linkklicks' : 'Ursprünglicher Test · Registrierungssignale'} · ${source?.period ? esc(date(source.period.from) + ' – ' + date(source.period.to)) : 'Zeitraum offen'}</p><p><b>${money(metrics.spend)}</b> · ${countValue(rows,'link_clicks')} Linkklicks · ${countValue(rows,'landing_page_views')} Zielseitenaufrufe</p><p class="panel-note">${sourceClock(source)}</p><button class="button small" data-campaign="${key}">Kampagne ansehen</button></section>`;
  }).join('') + '</div><p class="table-foot">Getrennte Kampagnen und Anzeigen. Reichweite wird weder über Tage noch über Kampagnen addiert. Der laufende Tag ist unvollständig.</p>';
}
function route() {
  const parts = String(location.hash || '#/overview').replace(/^#\/?/, '').split('/');
  const page = routes[parts[0]] ? parts[0] : 'overview';
  return { page, tab: parts[1], code: parts[1] === 'ad' ? parts[2] : null };
}
function sourceStatus(source) {
  if (!source || source.status === 'not_connected') return { label: 'Nicht verbunden', tone: '' };
  if (source.status === 'error') return { label: 'Abruf fehlgeschlagen', tone: 'error' };
  if (source.method === 'csv') return { label: 'Manueller CSV-Stand', tone: 'warn' };
  if (source.status === 'pending') return { label: 'Prüfung ausstehend', tone: '' };
  if (source.status === 'partial') return { label: 'Teilweise abgerufen', tone: 'warn' };
  if (source.status === 'historical') return { label: 'Historischer Stand', tone: 'warn' };
  const fresh = freshness(source.observed_at);
  if (source.status === 'awaiting_events') return { label: fresh.state === 'fresh' ? 'Zugang geprüft · wartet auf Signale' : `Wartet auf Signale · ${fresh.label.toLowerCase()}`, tone: 'warn' };
  return { label: fresh.state === 'fresh' ? 'Aktuell abgerufen' : fresh.label, tone: fresh.state === 'fresh' ? 'good' : 'warn' };
}
const badge = source => { const status = sourceStatus(source); return `<span class="pill ${status.tone}">${esc(status.label)}</span>`; };
function range() {
  const source = metaSource(), all = source.daily || [], dates = all.map(row => row.date).sort();
  const latest = dates.at(-1) || source.period?.to;
  const rows = state.period === 'all' && source.complete_test_window ? all : all.filter(row => row.date === latest);
  const selected = rows.map(row => row.date).sort();
  return { rows, from: selected[0] || source.period?.from, to: selected.at(-1) || source.period?.to };
}
function periodLabel() { const current = range(); return current.from === current.to ? date(current.to) : `${date(current.from)} – ${date(current.to)}`; }
function selectedAdRows(code) { const current = range(); return (metaSource().ads_daily || []).filter(row => row.code === code && row.date >= current.from && row.date <= current.to); }
function adMetrics(code) { return summarize(selectedAdRows(code)); }
function adRows() {
  const statuses = new Map((metaSource().statuses || []).map(row => [row.code, row]));
  return campaignAds().map(ad => ({ ...ad, status: statuses.get(ad.code), metrics: adMetrics(ad.code), countRows: selectedAdRows(ad.code) }));
}
function stageLabel(stage) { return ({ 'Problem-aware': 'Problembewusst', 'Solution-aware': 'Lösungsbewusst', 'Product-aware': 'Produktbewusst' })[stage] || stage; }
function deliveryLabel(status) { return status?.status === 'ACTIVE' ? 'Eingeschaltet' : status?.status === 'PAUSED' ? 'Ausgeschaltet' : 'Status offen'; }
function metaDeliverySummary(source) {
  const parent = source?.delivery === 'PAUSED' ? 'Adset ausgeschaltet' : source?.delivery === 'ACTIVE' ? 'Adset eingeschaltet' : 'Adsetstatus offen';
  const individual = source?.statuses?.length === campaignAds().length && source.statuses.every(row => ['ACTIVE','PAUSED'].includes(row.status)) ? `${source.statuses.filter(row => row.status === 'ACTIVE').length} Anzeigen einzeln eingeschaltet` : 'Einzelstatus unvollständig';
  return `${parent} · ${individual}`;
}
function sourceClock(source) {
  if (source?.method !== 'csv') return esc(time(source?.observed_at));
  const update = source.manual_update || {};
  const exported = update.exported_at || source.observed_at;
  const expired = update.valid_until && Date.parse(update.valid_until) <= Date.now();
  const csvTime = value => value && Number.isFinite(Date.parse(value)) ? `${time(value)} Berlin` : 'Zeitpunkt nicht belegt';
  return `${update.edition_label ? `<b>${esc(update.edition_label)}</b>` : ''}<span class="code">CSV-Export: ${esc(csvTime(exported))}</span>${update.imported_at ? `<span class="code">Importiert: ${esc(csvTime(update.imported_at))}</span>` : ''}${expired ? '<span class="code">Tagesausgabe abgelaufen · Quellenstand prüfen</span>' : ''}`;
}
function sourceLine(source, extra = '') { if (!extra && source === metaSource()) extra = metaDeliverySummary(source); return `<div class="statusline"><div class="statusline-left">${badge(source)}<span>${source?.method === 'csv' ? sourceClock(source) : `Stand: ${sourceClock(source)}`}${extra ? ` · ${esc(extra)}` : ''}</span></div><a class="text-link" href="#/tracking">Quelle ansehen ↗</a></div>`; }
function kpi(label, value, note, highlight = false) { return `<article class="metric${highlight ? ' highlight' : ''}"><span class="metric-label">${esc(label)}</span><strong class="metric-value">${esc(value)}</strong><span class="metric-note">${esc(note)}</span></article>`; }
function countValue(rows, key) { const count = reportedCount(rows, key); return count.minimum ? `Mind. ${num(count.value)}` : num(count.value); }
function countCoverage(rows, key) { const count = reportedCount(rows, key); return count.partial && count.known_days > 0 ? `${count.known_days} von ${count.reported_days} gemeldeten Tagen mit Messwert` : ''; }
function countCell(rows, key) { const coverage = countCoverage(rows, key); return `${countValue(rows, key)}${coverage ? `<span class="code">${esc(coverage)}</span>` : ''}`; }
function metricCards(metrics, rows) {
  const testNote = `Meta-Lead-Signale · kein Kunden-Nachweis${metrics.cost_per_test === null ? '' : ` · ${money(metrics.cost_per_test)} je Lead-Signal`}`;
  const note = (text, key) => [text, countCoverage(rows, key)].filter(Boolean).join(' · ');
  return `<div class="kpis">${kpi('Ausgaben', money(metrics.spend), 'Von Meta gemeldeter Betrag', true)}${kpi('Linkklicks', countValue(rows, 'link_clicks'), note(`${countValue(rows, 'impressions')} Impressionen`, 'link_clicks'))}${kpi('Zielseitenaufrufe', countValue(rows, 'landing_page_views'), note('Von Meta gemeldete Seitenaufrufe', 'landing_page_views'))}${kpi('Lead-Signale', countValue(rows, 'studio_tests'), note(testNote, 'studio_tests'))}</div>`;
}
function chart(rows, key, formatter = num, label = 'Tagesverlauf') {
  if (!rows.length) return '<div class="empty-state">Für diesen Bereich liegt noch kein bestätigter Tagesverlauf vor.</div>';
  const ordered = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  const width = 640, height = 185, gap = Math.min(26, 200 / ordered.length), col = width / ordered.length;
  const max = Math.max(1, ...ordered.map(row => Number.isFinite(row[key]) ? row[key] : 0));
  return `<svg class="trend" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}"><line class="chart-line" x1="0" y1="147" x2="640" y2="147"/>${ordered.map((row, index) => {
    const known = row[key] !== null && row[key] !== undefined && Number.isFinite(row[key]);
    const barHeight = known ? row[key] / max * 110 : 0, x = col * index + gap / 2;
    return `<text class="chart-value" x="${x + (col - gap) / 2}" y="${known ? 137 - barHeight : 137}" text-anchor="middle">${esc(formatter(row[key]))}</text>${known ? `<rect class="chart-bar" x="${x}" y="${147 - barHeight}" width="${Math.max(2, col - gap)}" height="${barHeight}" rx="4"/>` : ''}<text class="chart-text" x="${x + (col - gap) / 2}" y="170" text-anchor="middle">${esc(date(row.date).replace(/ 20\d\d$/, ''))}</text>`;
  }).join('')}</svg>`;
}
function overview() {
  const source = metaSource(), metrics = summarize(range().rows);
  const deliverySummary = metaDeliverySummary(source);
  const goals = data.goals.filter(goal => goal.id !== 'report_interval' && goal.target !== null);
  const status = sourceStatus(source);
  const next = source.status !== 'connected' || freshness(source.observed_at).state !== 'fresh'
    ? ['Zuerst den Datenstand prüfen', 'Die sichtbaren Facebook-Werte behalten ihren ursprünglichen Stand. Aktuelle Website-Zahlen stehen auf der eigenen Website-Seite.', '#/tracking', 'Tracking öffnen']
    : metrics.link_clicks > 0 && metrics.studio_tests === null
      ? ['Den Übergang zum Studio-Test prüfen', 'Klicks sind gemeldet. Für die nächste Entscheidung brauchen wir die nachfolgenden Funnel-Signale.', '#/funnel', 'Funnel ansehen']
      : ['Testideen gemeinsam vergleichen', 'Auslieferung, Kosten und stärkere Signale zusammen lesen. Eine wenig ausgespielte Anzeige ist noch kein verlorener Test.', '#/facebook', 'Facebook ansehen'];
  return `${sourceLine(source, deliverySummary)}${metricCards(metrics, range().rows)}<div class="grid-two"><section class="panel"><div class="panel-head"><div><h2>Ausgaben im Verlauf</h2><p>${esc(periodLabel())} · Facebook-Kontotage</p></div><span class="pill">${esc(status.label)}</span></div>${chart(range().rows, 'spend', money, 'Gemeldete Ausgaben pro Tag')}<p class="panel-note">${source.complete_test_window ? 'Zeitraum seit Testbeginn verfügbar.' : 'Der vorhandene Einzelstand ersetzt noch keine vollständige Testhistorie.'}</p></section><section class="panel tinted"><span class="eyebrow">WAS JETZT WICHTIG IST</span><h2>${esc(next[0])}</h2><p class="panel-note">${esc(next[1])}</p><ul class="action-list"><li><b>Facebook und Website getrennt lesen</b><span>Klicks, Besucher und Produkt-Schritte zählen unterschiedliche Dinge.</span></li><li><b>Aus einem Signal wird noch kein Kunde</b><span>Zahlende Standorte sind nicht unabhängig angebunden.</span></li></ul><a class="text-link" href="${next[2]}">${next[3]} →</a></section></div><section class="goal-summary"><div><h2>Ziele & Leitplanken</h2><p>${goals.length ? 'Nur ausdrücklich hinterlegte Zielwerte.' : 'Kunden-, Lead- und CAC-Ziele sind noch nicht gemeinsam festgelegt.'}</p><p class="panel-note"><b>Nächster Beleg · Nachweis offen</b><br>Ein Studio durchläuft den DIY-Einstieg eigenständig bis zum Dashboard.</p></div><div class="goal-values"><div><strong>${money(source.budget_daily)}</strong><span>gemeldetes Ø-Tagesbudget</span></div>${goals.slice(0, 2).map(goal => `<div><strong>${esc(num(goal.target))} ${esc(goal.unit)}</strong><span>${esc(goal.label)}</span></div>`).join('')}</div></section>`;
}
function facebookTabs(tab = 'performance') { return `<div class="section-tabs"><a href="#/facebook" ${tab === 'performance' ? 'aria-current="page"' : ''}>Performance</a><a href="#/facebook/creatives" ${tab === 'creatives' ? 'aria-current="page"' : ''}>Creatives & Texte</a></div>`; }
function visibleAds() {
  let rows = adRows().filter(ad => (!state.search || `${ad.code} ${ad.name} ${ad.angle} ${ad.stage}`.toLowerCase().includes(state.search.toLowerCase())) && (state.stage === 'all' || ad.stage === state.stage) && (state.delivery === 'all' || ad.status?.status === state.delivery));
  rows.sort((a, b) => state.sort === 'code' ? a.code.localeCompare(b.code) : (b.metrics[state.sort] ?? -1) - (a.metrics[state.sort] ?? -1) || a.code.localeCompare(b.code));
  return rows;
}
function creativeMedia(creative, ad, detail = false) {
  if (!creative?.asset && ad.format === 'image') return '<div class="creative-missing"><b>Bild-Anzeige</b><small>Motiv derzeit nicht verknüpft</small></div>';
  if (!creative?.asset) return '<div class="creative-missing"><span class="play-symbol">▷</span><b>Video-Anzeige</b><small>Originaldatei derzeit nicht verknüpft</small></div>';
  if (creative.format === 'video') return detail
    ? `<video class="creative-video" src="${esc(creative.asset)}" controls playsinline preload="metadata" aria-label="Originalvideo ${esc(ad.code)}"><a href="${esc(creative.asset)}">Originalvideo öffnen</a></video>`
    : '<div class="creative-missing creative-video-thumb"><span class="play-symbol">▷</span><b>Video-Anzeige</b><small>Originalvideo · 58 Sekunden</small></div>';
  return `<img class="creative-image" src="${esc(creative.asset)}" alt="${esc(ad.code + ' · ' + ad.name)}" width="1080" height="1350"${detail ? '' : ' loading="lazy"'}>`;
}
function facebookResults(tab) {
  const rows = visibleAds();
  const count = `<p class="table-foot">${rows.length} von ${campaignAds().length} Anzeigen · ${esc(periodLabel())}. „—“ bedeutet unbekannt, nicht 0.</p>`;
  if (!rows.length) return '<div class="empty-state">Keine Anzeige passt zu diesen Filtern.</div>';
  if (tab === 'creatives') return `${count}<div class="creative-grid">${rows.map(ad => { const creative = CREATIVE_CATALOG.find(row => row.code === ad.code); return `<a class="creative-card" href="#/facebook/ad/${encodeURIComponent(ad.code)}">${creativeMedia(creative, ad)}<div class="creative-body"><span class="pill soft">${esc(stageLabel(ad.stage))}</span><h3>${esc(ad.name)}</h3><p>${esc(ad.angle)}</p><span class="code">${esc(ad.code)} · Freigegebene Fassung 22.10.</span></div></a>`; }).join('')}</div>`;
  return `<div class="table-wrap" tabindex="0" aria-label="Facebook-Anzeigen, horizontal scrollbar"><table class="fb-table"><thead><tr><th>Anzeige</th><th>Angle & Awareness</th><th>Status</th><th class="numeric">Ausgaben</th><th class="numeric">Klicks</th><th class="numeric">LPV</th><th class="numeric">Lead-Signale</th><th class="numeric">Kosten / Lead</th></tr></thead><tbody>${rows.map(ad => `<tr><td><a class="table-name" href="#/facebook/ad/${encodeURIComponent(ad.code)}">${esc(ad.name)}</a><span class="code">${esc(ad.code)}</span></td><td><div class="table-angle">${esc(ad.angle)}</div><span class="code">${esc(stageLabel(ad.stage))}</span></td><td><span class="pill ${ad.status?.status === 'ACTIVE' ? 'good' : ''}">${esc(deliveryLabel(ad.status))}</span></td><td class="numeric">${money(ad.metrics.spend)}</td><td class="numeric">${countCell(ad.countRows, 'link_clicks')}</td><td class="numeric">${countCell(ad.countRows, 'landing_page_views')}</td><td class="numeric">${countCell(ad.countRows, 'studio_tests')}</td><td class="numeric">${money(ad.metrics.cost_per_test)}</td></tr>`).join('')}</tbody></table></div>${count}<p class="table-foot">LPV = von Meta gemeldete Landingpage-Aufrufe. Lead-Signale sind von Meta zugerechnete Aktionen, auch wiederverwendete Einstiege oder Kontaktformulare. Keine bestätigten Kunden.</p>`;
}
function facebook(tab) {
  const mode = tab === 'creatives' ? 'creatives' : 'performance';
  const stages = [...new Set(campaignAds().map(ad => ad.stage))];
  return `${facebookTabs(mode)}${sourceLine(metaSource())}${mode === 'creatives' ? isTraffic() ? '<div class="callout"><b>Fünf veröffentlichte Traffic-Anzeigen</b>Die Anzeige-IDs und Performance stammen aus dieser Kampagne. Soweit vorhanden, werden historische Creative-Vorlagen gezeigt; eine aktuelle Live-Fassung ist damit nicht belegt.</div>' : '<div class="callout"><b>Gemeinsame Creative-Review</b>12 Originalbilder und eine Video-Anzeige. Hier sind die freigegebenen Motive und Texte vom 22.10. hinterlegt; die aktuelle Live-Fassung wurde nicht neu aus Meta gelesen. <a class="text-link" href="https://claude.ai/artifact/QDK36dCNCCbttM9zscGHx8" target="_blank" rel="noreferrer">Gemeinsam kommentieren ↗</a></div>' : ''}<div class="toolbar"><label class="sr-only" for="creative-search">Anzeigen suchen</label><input id="creative-search" type="search" placeholder="Code, Titel oder Angle suchen …" value="${esc(state.search)}"><label class="sr-only" for="creative-stage">Awareness filtern</label><select id="creative-stage"><option value="all">Alle Awareness-Stufen</option>${stages.map(stage => `<option value="${esc(stage)}" ${stage === state.stage ? 'selected' : ''}>${esc(stageLabel(stage))}</option>`).join('')}</select><label class="sr-only" for="creative-delivery">Status filtern</label><select id="creative-delivery"><option value="all">Alle Status</option><option value="ACTIVE" ${state.delivery === 'ACTIVE' ? 'selected' : ''}>Eingeschaltet</option><option value="PAUSED" ${state.delivery === 'PAUSED' ? 'selected' : ''}>Ausgeschaltet</option></select><label class="sr-only" for="creative-sort">Sortieren</label><select id="creative-sort"><option value="code">Nach Ad-Code</option><option value="spend" ${state.sort === 'spend' ? 'selected' : ''}>Höchste Ausgaben</option><option value="link_clicks" ${state.sort === 'link_clicks' ? 'selected' : ''}>Meiste Linkklicks</option><option value="studio_tests" ${state.sort === 'studio_tests' ? 'selected' : ''}>Meiste Lead-Signale</option></select></div><div id="facebook-results">${facebookResults(mode)}</div>`;
}
const DIY_STEPS = [
  ['studio_started', 'Studio neu angelegt', 'Die API hat eine neue Anlage bestätigt. Wiederverwendete Runs sind hier keine neue Anlage.'],
  ['call_requested', 'Testanruf angefordert', 'Die API hat die Anfrage angenommen. Kein Nachweis eines geführten Gesprächs.'],
  ['checkout_started', 'Checkout-Link erhalten', 'Eine Checkout-URL wurde zurückgegeben. Kein Beleg für Seitenbesuch oder Zahlung.'],
  ['dashboard_activated', 'Dashboard aktiv', 'Das Backend meldet den Status aktiv. Kein unabhängiger Zahlungsnachweis.'],
];
const utcTime = value => value && Number.isFinite(Date.parse(value)) ? `${new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))} UTC` : 'Noch kein bestätigter Zeitpunkt';
function diyPeriod(source) { return source?.period ? `${date(source.period.from)} – ${date(source.period.to)} · UTC` : 'Zeitraum noch nicht bestätigt'; }
function diyRows(source, code) { return (source?.daily || []).filter(row => (!code || row.code === code) && (!source.period || row.date >= source.period.from && row.date <= source.period.to)); }
function diyCoverage(rows, key) { const count = reportedCount(rows, key); return count.partial && count.known_days > 0 ? `${count.known_days} von ${count.reported_days} gemeldeten Anzeigen-/Tageszeilen mit Messwert` : ''; }
function diyCell(rows, key) { const coverage = diyCoverage(rows, key); return `${countValue(rows, key)}${coverage ? `<span class="code">${esc(coverage)}</span>` : ''}`; }
function diySourceLine(source) { return `<div class="statusline"><div class="statusline-left">${badge(source)}<span>Stand: ${esc(utcTime(source.observed_at))} · ${esc(diyPeriod(source))}</span></div><a class="text-link" href="#/tracking">Quelle ansehen ↗</a></div>`; }
function funnelMode(tab) { return tab === 'diy' || diySource() && tab !== 'meta' ? 'diy' : 'meta'; }
function funnelTabs(mode) { return `<div class="section-tabs"><a href="#/funnel/diy" ${mode === 'diy' ? 'aria-current="page"' : ''}>Eigener DIY-Ablauf</a><a href="#/funnel/meta" ${mode === 'meta' ? 'aria-current="page"' : ''}>Meta-Zuordnung</a></div>`; }
function diyNotice(source) {
  if (source.status === 'error') return `<div class="callout"><b>Letzte bekannte Werte bleiben sichtbar.</b>Der aktuelle Abruf ist fehlgeschlagen. Werte und erfolgreicher Quellenstand behalten ihren ursprünglichen Zeitpunkt. Letzter Versuch: ${esc(utcTime(source.attempted_at))}.</div>`;
  if (source.status === 'awaiting_events') return `<div class="callout"><b>${freshness(source.observed_at).state === 'fresh' ? 'Zugang geprüft · wartet auf Signale' : 'Letzter belegter Stand: wartet auf Signale'}</b>Die begrenzten Abfragen waren gültig, lieferten aber noch keine Ereigniszeilen. Das ist kein Nachweis für 0 Studio-Tests und noch keine Bestätigung eines tatsächlichen DIY-Ereignisses.</div>`;
  return '<p class="table-foot">Einwilligungsabhängige Ereignisse aus dem DIY-Einstieg. Keine eindeutigen Menschen oder Meta-Zuordnungen. Die Schritte können verschiedene Studios betreffen.</p>';
}
function diyDetail(source, code) {
  const rows = diyRows(source, code);
  return `<div class="panel-head"><div><h2>Eigener DIY-Ablauf</h2><p>${esc(diyPeriod(source))}</p></div>${badge(source)}</div><div class="signals diy-signals">${DIY_STEPS.map(([key, label]) => `<div class="signal" data-diy-signal="${key}"><b>${countValue(rows, key)}</b><small>${esc(label)}</small>${diyCoverage(rows, key) ? `<small>${esc(diyCoverage(rows, key))}</small>` : ''}</div>`).join('')}</div>${diyNotice(source)}<p class="table-foot">Quellenstand: ${esc(utcTime(source.observed_at))}. Die vier Ereignisse sind von den Meta-Kennzahlen oben getrennt. <a class="text-link" href="#/funnel/diy">Bedeutung der Schritte →</a> · <a class="text-link" href="#/funnel/meta">Meta-Zuordnung ansehen →</a></p>`;
}
function diyFunnel(source) {
  const rows = diyRows(source);
  return `${diySourceLine(source)}${diyNotice(source)}<div class="table-wrap" tabindex="0" aria-label="Vier eigene DIY-Ereignisse"><table class="funnel-table"><thead><tr><th>Schritt</th><th class="numeric">Gemeldete Ereignisse</th></tr></thead><tbody>${DIY_STEPS.map(([key, label, meaning], index) => `<tr><td><div class="funnel-stage"><span class="stage-no">${index + 1}</span><div><b>${esc(label)}</b><small>${esc(meaning)}</small></div></div></td><td class="numeric funnel-count" data-diy-count="${key}">${diyCell(rows, key)}</td></tr>`).join('')}</tbody></table></div><p class="table-foot">Positive Teilmengen stehen als „Mind.“ mit Abdeckung der gemeldeten Anzeigen-/Tageszeilen. Fehlende Werte sind unbekannt. Die Schritte zählen nicht zwangsläufig dieselben Studios; daher keine Conversionrate.</p><p class="table-foot">${isTraffic() ? 'Technische Projektgrenze ab ' : 'Erfassung ab '}${esc(utcTime(source.collection_started_at))}.${isTraffic() ? ' Das ist kein Nachweis, dass diese Kampagne seitdem vollständig instrumentiert war.' : ''} Der laufende UTC-Tag ist unvollständig; frühere Meta-Zahlen werden nicht nachträglich zu DIY-Ereignissen. Der eigenständige Weg bis zum Dashboard bleibt als Meilenstein offen.</p>`;
}
function funnel(tab) {
  const mode = funnelMode(tab);
  return `${funnelTabs(mode)}${mode === 'diy' ? diySource() ? diyFunnel(diySource()) : '<div class="callout"><b>Eigener DIY-Ablauf noch nicht verbunden</b>Für die ausgewählte Kampagne liegt noch kein geprüfter Abruf vor. Fehlende Werte sind unbekannt.</div>' : `${!diySource() ? '<p class="table-foot">Der eigene DIY-Ablauf ist noch nicht verbunden. Hier sehen Sie die getrennte Meta-Zuordnung.</p>' : '<p class="table-foot">Meta ordnet diese Aktionen dem Anzeigenkontakt zu. Diese Werte werden nicht mit den eigenen DIY-Ereignissen addiert.</p>'}${metaFunnel()}`}`;
}
const signalLabels = [['landing_page_views', 'Landingpage-Aufrufe'], ['studio_tests', 'Lead-Signale'], ['call_requests', 'Testanruf angefordert'], ['checkouts', 'Checkout begonnen'], ['trials', 'Testphase begonnen']];
function adDetail(code) {
  const ad = adRows().find(row => row.code === code), creative = CREATIVE_CATALOG.find(row => row.code === code);
  if (!ad) return '<div class="empty-state">Diese Anzeige ist nicht Teil der freigegebenen Testbibliothek. <a href="#/facebook">Zur Übersicht</a></div>';
  const review = reviewAd(ad.metrics, metaSource(), { enabled: false });
  $('#page-title').textContent = ad.name;
  $('#page-description').textContent = `${ad.code} · ${deliveryLabel(ad.status)}`;
  const manager = (ad.ad_id || creative?.adId) ? `https://adsmanager.facebook.com/adsmanager/manage/ads?act=2128240694419507&selected_ad_ids=${encodeURIComponent(ad.ad_id || creative.adId)}` : null;
  return `<div class="detail-top"><a class="text-link" href="#/facebook">← Alle Anzeigen</a>${manager ? `<a class="button secondary" href="${esc(manager)}" target="_blank" rel="noreferrer">Im Ads Manager ↗</a>` : ''}</div>${sourceLine(metaSource())}<div class="detail-grid"><div class="detail-media">${creativeMedia(creative, ad, true)}</div><section class="panel"><dl class="detail-metadata"><div><dt>Getesteter Angle</dt><dd>${esc(ad.angle)}</dd></div><div><dt>Awareness-Stufe</dt><dd>${esc(stageLabel(ad.stage))}</dd></div><div><dt>Format</dt><dd>${esc(ad.format)}</dd></div><div><dt>Creative-Fassung</dt><dd>Freigegeben am 22.10.2026</dd></div></dl><div class="copy-box"><h3>Primary Text</h3><p>${esc(creative?.primary || 'Nicht hinterlegt')}</p></div><div class="copy-box"><h3>Headline</h3><p>${esc(creative?.headline || 'Nicht hinterlegt')}</p></div><p class="panel-note">Historisch freigegebener Text; keine Behauptung einer neu geprüften Live-Fassung.</p><a class="text-link" href="https://claude.ai/artifact/QDK36dCNCCbttM9zscGHx8" target="_blank" rel="noreferrer">Feedback gemeinsam im Review-Artifact ↗</a></section></div>${metricCards(ad.metrics, ad.countRows)}<div class="traffic-context" aria-label="Traffic-Kennzahlen"><span><b>CPM</b> ${money(ad.metrics.cpm)} je 1.000 Impressionen</span><span><b>CPC</b> ${money(ad.metrics.cpc)} je Linkklick</span><span><b>CTR</b> ${ad.metrics.ctr === null ? '—' : `${num(ad.metrics.ctr, 2)} %`} Linkklickrate</span></div>${diySource() ? diyDetail(diySource(), code) : `<div class="signals">${signalLabels.map(([key, label]) => `<div class="signal" data-signal="${key}"><b>${countValue(ad.countRows, key)}</b><small>${esc(label)}</small>${countCoverage(ad.countRows, key) ? `<small>${esc(countCoverage(ad.countRows, key))}</small>` : ''}</div>`).join('')}</div>`}<section class="panel"><h2>${esc(review.title)}</h2><p class="panel-note">${esc(review.text)} Es bestehen noch keine verbindlichen Abschaltgrenzen. Zeitraum: ${esc(periodLabel())}.</p><a class="text-link" href="#/tracking/criteria">Prüfkriterien ansehen →</a></section>`;
}
function organicSearch() {
  const source = data.sources.search_console;
  const connected = source?.source_code === 'gsc_web_ui_csv' && source.daily?.length;
  if (!connected) return '<section class="panel website-panel"><h2>Organische Suche · Google</h2><p class="panel-note">Suchklicks und Suchimpressionen sind noch nicht verfügbar. Fehlende Suchdaten bleiben unbekannt; sie werden nicht aus Website-Besuchen oder Meta-Klicks abgeleitet.</p></section>';
  const rows = source.daily;
  return `<section class="panel website-panel"><h2>Organische Suche · beide Hosts</h2><p class="panel-note">Google Websuche · chatline.app und start.chatline.app gemeinsam. Kein kampagnen- oder hostbezogener Besuchernachweis.</p>${sourceLine(source)}<p class="panel-note">Gemeldeter Datenzeitraum: ${esc(date(source.period.from))} – ${esc(date(source.period.to))} · Pacific Time (PT).</p>${source.status === 'error' ? '<p class="notice">Der neue Abruf ist fehlgeschlagen. Werte und Quellenzeitpunkt bleiben auf dem letzten bestätigten Stand.</p>' : ''}<div class="kpis website-kpis">${kpi('Gemeldete Suchklicks', countValue(rows, 'clicks'), 'Google-Suchklicks, keine Website-Besucher')}${kpi('Gemeldete Suchimpressionen', countValue(rows, 'impressions'), 'Einblendungen in Google-Suchergebnissen')}</div><details class="details"><summary>Tageswerte und Grenzen</summary><div class="table-wrap"><table><thead><tr><th>Tag (PT)</th><th>Suchklicks</th><th>Suchimpressionen</th></tr></thead><tbody>${rows.map(row => '<tr><td>' + esc(date(row.date)) + '</td><td>' + num(row.clicks) + '</td><td>' + num(row.impressions) + '</td></tr>').join('')}</tbody></table></div><p class="panel-note">${esc(source.note)}</p></details><p class="panel-note">Die jüngsten GSC-Werte sind vorläufig. Eine gemeldete Null ist kein abgeschlossener Tages- oder Kundennachweis. Manueller UI-Export; keine automatische GSC-API-Verbindung.</p><a class="text-link" href="https://support.google.com/webmasters/answer/17011259?hl=de" target="_blank" rel="noreferrer">Google: Datenzeitraum und Zeitzone ↗</a></section>`;
}
function website() {
  const view = analyticsView(data.sources.analytics, state.site);
  const source = data.sources.analytics?.sites?.find(row => row.site === state.site);
  return `<div class="website-switch" role="group" aria-label="Website-Bereich"><button data-site="chatline.app" class="${state.site === 'chatline.app' ? 'selected' : ''}">Hauptseiten</button><button data-site="start.chatline.app" class="${state.site === 'start.chatline.app' ? 'selected' : ''}">DIY-Einstieg</button></div>${sourceLine(source)}<div class="kpis website-kpis">${kpi('Besucher an diesem Tag', num(view.visitors), date(view.latest_date), true)}${kpi('Seitenaufrufe an diesem Tag', num(view.pageviews), 'Mehrere Aufrufe pro Besucher möglich')}</div><section class="panel website-panel"><div class="panel-head"><div><h2>Besucher im Zeitverlauf</h2><p>Je gemeldetem UTC-Tag · keine Summe eindeutiger Wochenbesucher</p></div></div>${chart(view.days, 'visitors', num, 'Website-Besucher pro UTC-Tag')}<p class="panel-note">${state.site === 'chatline.app' ? 'Alle Live-Domains der Hauptseiten, darunter chatline.app und mindbody-home.chatline.app.' : 'Alle Live-Domains des DIY-Bereichs, darunter start.chatline.app und limitless-ashy-eight.vercel.app.'} Der laufende UTC-Tag ist noch unvollständig.</p></section><div class="callout"><b>${view.state === 'error' ? 'Letzte bekannte Werte bleiben sichtbar' : view.state === 'not_connected' ? 'Dieser Bereich ist noch nicht verbunden' : 'Besucher sind keine Meta-Klicks'}</b>${view.state === 'error' ? 'Der letzte Abruf ist fehlgeschlagen. Die sichtbaren Zahlen behalten ihren ursprünglichen Datenstand.' : view.state === 'not_connected' ? 'Es werden keine Besucher geschätzt. Einen fehlenden Wert zeigen wir als „—“.' : 'Website-Besuche umfassen unterschiedliche Zugänge und unterliegen Einwilligung sowie Browserfiltern. Sie dürfen nicht mit Klicks oder Dataset-Signalen addiert werden.'}</div>${organicSearch()}`;
}
function metaFunnel() {
  const steps = [['studio_tests', 'Meta-Lead-Signal', 'Kann einen Studio-Test, einen wiederverwendeten Einstieg oder ein Kontaktformular betreffen. Kein Kunden-Nachweis.'], ['call_requests', 'Telefon / Testanruf angefordert', 'Eine Nummer wurde für den Test angenommen; Gespräch nicht als beantwortet bestätigt.'], ['checkouts', 'Zahlungsseite / Checkout begonnen', 'Checkout-Link wurde erstellt; Öffnung und Zahlung sind nicht separat bestätigt.'], ['trials', 'Einrichtung / Testphase begonnen', 'Einrichtung läuft oder ist aktiv; keine unabhängig bestätigte Zahlung.']];
  return `${sourceLine(metaSource())}<div class="traffic-context"><b>Traffic davor</b><span>${countValue(range().rows, 'link_clicks')} Linkklicks</span><span>→</span><span>${countValue(range().rows, 'landing_page_views')} gemeldete Landingpage-Aufrufe</span></div><div class="table-wrap" tabindex="0" aria-label="Vier Schritte des Studio-Test-Funnels"><table class="funnel-table"><thead><tr><th>Schritt</th><th class="numeric">Gemeldete Signale</th></tr></thead><tbody>${steps.map(([key, label, meaning], index) => `<tr><td><div class="funnel-stage"><span class="stage-no">${index + 1}</span><div><b>${esc(label)}</b><small>${esc(meaning)}</small></div></div></td><td class="numeric funnel-count">${countCell(range().rows, key)}</td></tr>`).join('')}</tbody></table></div><p class="table-foot">Die Schritte zählen nicht zwangsläufig dieselben Studios; daher keine Conversionrate.</p><section class="panel"><h2>Was hier noch nicht als Erfolg belegt ist</h2><p class="panel-note">Qualifizierte Leads, angenommene Gespräche und tatsächlich zahlende Standorte sind nicht unabhängig angeschlossen. Eine begonnene Einrichtung ersetzt diesen Nachweis nicht.</p><details class="details"><summary>Quelle und Zeitbezug</summary><p>${esc(metaSource().attribution)} · Kontozeitzone: ${esc(metaSource().timezone)}. Zeitraum: ${esc(periodLabel())}. Website-Besucher werden auf ihrer eigenen Seite nach UTC-Tagen gezeigt.</p></details></section>`;
}
const errorText = { META_NOT_CONFIGURED: 'Die Reporting-Verbindung ist noch nicht eingerichtet.', META_LOGIN_REQUIRED: 'Der lesende Meta-Zugang muss erneuert werden.', META_PERMISSION_REQUIRED: 'Die nötigen Leserechte fehlen.', ACCOUNT_CONFIG_MISMATCH: 'Konto, Währung oder Zeitzone stimmen nicht mit dem freigegebenen Umfang überein.', SCOPE_MISMATCH: 'Unerwartete Konten oder Anzeigen wurden vorsorglich verworfen.', DATASET_MISMATCH: 'Das gelesene Dataset stimmt nicht mit dem freigegebenen Dataset überein.', META_RATE_LIMITED: 'Meta hat den Abruf vorübergehend begrenzt.' };
Object.assign(errorText, { DIY_NOT_CONFIGURED: 'Der begrenzte DIY-Lesezugang ist nicht eingerichtet.', DIY_LOGIN_REQUIRED: 'Der letzte DIY-Abruf meldete eine fehlende Anmeldung; der aktuelle Zugriff ist damit nicht neu geprüft.', DIY_PERMISSION_REQUIRED: 'Der letzte DIY-Abruf meldete fehlende Leserechte.', META_LOGIN_REQUIRED: 'Der letzte Meta-Abruf meldete eine fehlende Anmeldung; der aktuelle Zugriff ist damit nicht neu geprüft.', GSC_LOGIN_REQUIRED: 'Der letzte Search-Console-Abruf meldete eine fehlende Anmeldung; ein neuer Quellenstand fehlt.', ANALYTICS_LOGIN_REQUIRED: 'Der letzte Analytics-Abruf meldete eine fehlende Anmeldung; frühere Werte behalten ihren Datenstand.' });
const AUDIT_CHECK_NAMES = { scope_validated: 'Anzeigenzuordnung', destination_present: 'Ziel vorhanden', format_supported: 'Anzeigenformat', landing_keys_in_url_tags_absent: 'Zielparameter', https_domain: 'Ziel-Domain', root_path: 'Einstiegsseite', skin: 'Pilates-Skin', ref: 'Anzeigenreferenz', no_fragment: 'URL-Aufbau', unique_query_keys: 'Eindeutige Parameter', effective_utm_contract: 'UTM-Zuordnung' };
const AUDIT_EXTRA_KEYS = new Set(['utm_id', 'hsa_acc', 'hsa_cam', 'hsa_grp', 'hsa_ad', 'hsa_src', 'hsa_net', 'hsa_ver']);
function auditResult(row) {
  if (!row || row.status === 'pending') return '<span class="pill">Prüfung ausstehend</span>';
  const label = row.status === 'read_error' ? 'Abruf fehlgeschlagen' : row.status === 'needs_review' ? 'Konfiguration prüfen' : 'Kernlink & UTM geprüft';
  const tone = row.status === 'read_error' ? 'error' : row.status === 'needs_review' ? 'warn' : 'good';
  const extras = (row.extra_keys || []).filter(item => AUDIT_EXTRA_KEYS.has(item.key));
  const failures = Object.entries(row.checks || {}).filter(([key, value]) => value === false && Object.hasOwn(AUDIT_CHECK_NAMES, key)).map(([key]) => AUDIT_CHECK_NAMES[key]);
  return `<span class="pill ${tone}">${esc(label)}</span><span class="code">Letzte Prüfung: ${esc(time(row.checked_at))}</span>${row.status === 'read_error' ? `<span class="code">Neuer Versuch: ${esc(time(row.attempted_at))}. Frühere Prüfdaten bleiben erhalten.</span>` : ''}${failures.length ? `<p class="source-description">Offen: ${esc(failures.join(', '))}.</p>` : ''}${extras.length ? `<details class="audit-extra"><summary>Zusatzparameter separat prüfen</summary><p>Erkannte Namen: ${esc(extras.map(item => item.key).join(', '))}. Die Werte wurden nicht geprüft. CRM-Zusätze machen einen bestätigten Kernlink nicht automatisch ungültig.</p></details>` : ''}${row.unrecognized_extra_key_count > 0 ? `<p class="source-description">Weitere nicht zugeordnete Parameter: ${num(row.unrecognized_extra_key_count)}. Namen und Werte werden nicht angezeigt.</p>` : ''}`;
}
function trackingLinks(tabs) {
  const source = linkSource();
  const templateNote = isTraffic() ? 'Die Kopierfunktion liefert die hinterlegte Traffic-Vertragsvorlage vom 27.10.' : 'Die Kopierfunktion liefert die hinterlegte Anzeigen-/UTM-Vorlage vom 23.10.';
  const heading = source ? `<div class="statusline"><div class="statusline-left">${badge(source)}<span>Durchlauf: ${esc(time(source.attempted_at))} · ${num(source.checked_count)} von ${campaignAds().length} Anzeigen im letzten Durchlauf geprüft</span></div></div>${['partial', 'error'].includes(source.status) ? `<p class="table-foot">Letzter vollständiger Prüfdurchlauf: ${esc(time(source.observed_at))}. Die Prüfzeiten der einzelnen Anzeigen stehen unten.</p>` : ''}<div class="callout"><b>Link-Prüfstand pro Anzeige</b>Kernlink und UTM-Zuordnung sind getrennt von zusätzlichen Trackingparametern bewertet. Die Prüfung liest Anzeigenkonfigurationen; sie beweist keinen Klick, keine Weitergabe im DIY-Prozess und keinen CAPI-Empfang.</div>` : isTraffic() ? '<div class="callout"><b>Traffic-Vertragsvorlagen · Stand 27.10.2026</b>Noch kein geprüfter Traffic-Link-Abruf. Die Vorlagen sind kein neuer Live-Read und beweisen keinen tatsächlichen Klick oder CAPI-Empfang.</div>' : '<div class="callout"><b>Hinterlegte Anzeigenlinks · Stand 23.10.2026</b>Ein aktueller Link-Audit ist noch nicht verbunden. Die Vorlagen sind kein neuer Live-Read aus Meta; die Weitergabe im DIY-Prozess muss unabhängig im tatsächlichen Ablauf geprüft werden.</div>';
  return `${tabs}${heading}<p class="table-foot">${esc(templateNote)} Meta ersetzt {{…}} beim Ausspielen. Die Vorlage ist von der aktuellen Prüfung getrennt.</p><div class="table-wrap"><table class="links-table"><thead><tr><th>Anzeige</th><th>Aktueller Prüfstand</th><th>Hinterlegte Vorlage</th></tr></thead><tbody>${linkCatalog().map(item => { const row = source?.ads?.find(record => record.code === item.code && record.ad_id === item.adId); return `<tr><td><a class="table-name" href="#/facebook/ad/${encodeURIComponent(item.code)}">${esc(item.code)}</a></td><td>${auditResult(row)}</td><td><button class="button small" data-copy="${esc(item.code)}">Anzeigen-/UTM-Vorlage kopieren</button><details class="audit-extra"><summary>Vorlage ansehen</summary><code class="link-code">${esc(item.targetUrl)}&amp;${esc(item.urlParameters)}</code></details></td></tr>`; }).join('')}</tbody></table></div><p id="copy-status" class="table-foot" role="status"></p>`;
}
function tracking(tab) {
  const mode = ['links', 'criteria'].includes(tab) ? tab : 'sources';
  const tabs = `<div class="section-tabs"><a href="#/tracking" ${mode === 'sources' ? 'aria-current="page"' : ''}>Quellen & Datenstand</a><a href="#/tracking/links" ${mode === 'links' ? 'aria-current="page"' : ''}>Anzeigenlinks</a><a href="#/tracking/criteria" ${mode === 'criteria' ? 'aria-current="page"' : ''}>Prüfkriterien</a></div>`;
  if (mode === 'links') return trackingLinks(tabs);
  if (mode === 'criteria') return `${tabs}<div class="callout"><b>Prüfen, bevor wir entscheiden.</b>Diese Leselogik gibt keine festen Abschaltgrenzen vor und ändert keine Anzeigen oder Budgets.</div><div class="settings-grid"><section class="panel"><h2>So prüfen wir denselben Test</h2><ol class="plain-list"><li><b>Daten zuerst:</b> Quelle, Zeitraum und Anzeigenstand bestätigen. Historische Lücken und Zeit vor einer neuen Messung sind keine Null.</li><li><b>Kumuliert vergleichen:</b> Ausgaben und Linkklicks seit Beginn desselben Teststands. Link-CPC = Gesamtausgaben geteilt durch Linkklicks; nicht alle Klicks und kein Tagesreset.</li><li><b>Auslieferung einordnen:</b> Wenig Daten bleiben offen. Der Top-Spender ist kein Gewinner; CPM allein entscheidet nicht.</li><li><b>Den weiteren Weg prüfen:</b> Linkklicks, Zielseitenaufrufe und eigener DIY-Ablauf getrennt lesen. Erst Tracking und Landingpage prüfen, dann stärkere Signale einbeziehen.</li></ol></section><section class="panel"><h2>Die Entscheidung bleibt menschlich</h2><p class="panel-note">Motiv, Betreiberansprache, Landingpage und weiterführende Ergebnisse gemeinsam beurteilen. Keine automatische Pause wegen weniger Daten oder fehlender Ereignisse.</p><ul class="plain-list"><li>Was zählt als qualifizierter Studio-Test?</li><li>Welche Zielkosten sind wirtschaftlich tragbar?</li><li>Welche Datenmenge trägt eine gemeinsame Entscheidung?</li></ul><p class="panel-note">Verbindliche Grenzwerte sind noch gemeinsam festzulegen. Die Seite liefert Prüfhinweise, keine automatische Anzeigensteuerung.</p></section></div>`;
  const definitions = [['Facebook · ursprüngliches Pilates-Adset', data.sources.meta, 'Ausgaben, Klicks und von Meta zugerechnete Aktionen.'], ['Website · Hauptseiten', data.sources.analytics?.sites?.find(item => item.site === 'chatline.app'), 'Tägliche Besucher und Seitenaufrufe des Hauptseiten-Bereichs.'], ['Website · DIY-Einstieg', data.sources.analytics?.sites?.find(item => item.site === 'start.chatline.app'), 'Tägliche Besucher und Seitenaufrufe des DIY-Bereichs.'], ['Dataset · Ereignissignale', data.sources.website_events, 'Gemeldete Gesamtsignale; keine eindeutigen Besucher oder Adset-Attribution.']];
  definitions.splice(1, 0, ['Facebook · Traffic-Kampagne', data.sources.meta_traffic, 'Eigene Ausgaben, Anzeigen und Meta-Zuordnung der Traffic-Kampagne.'], ['Eigener DIY-Ablauf · ursprüngliche Kampagne', data.sources.diy_funnel, 'Einwilligungsabhängige Ereignisse der ursprünglichen 13 Ads.'], ['Eigener DIY-Ablauf · Traffic-Kampagne', data.sources.diy_funnel_traffic, 'Getrennte Ereignisse der fünf Traffic-Ads; Abrufstatus ist kein Nachweis vollständiger Instrumentierung.'], ['Anzeigenlinks · ursprünglich', data.sources.link_audit, 'Kernlink-/UTM-Prüfung der 13 ursprünglichen Ads.'], ['Anzeigenlinks · Traffic', data.sources.link_audit_traffic, 'Eigener Prüfstand für fünf Traffic-Ads; keine Übernahme alter Prüfzeiten.']);
  definitions.push(['Google · organische Suche', data.sources.search_console, 'Websuche für chatline.app + start.chatline.app, Pacific-Time-Tage. Eigener manueller Exportstand.']);
  const events = data.sources.website_events;
  return `${tabs}<p class="table-foot">Abrufzeiten: Berlin · DIY-Messtage: UTC · GSC-Messtage: Pacific Time. Der eigene DIY-Reiter kennzeichnet auch seine Abrufzeiten ausdrücklich als UTC.</p><div class="table-wrap"><table class="source-table"><thead><tr><th>Quelle</th><th>Status</th><th>Quellenstand</th><th>Zeitraum</th></tr></thead><tbody>${definitions.map(([label, source, meaning]) => `<tr><td><span class="source-title">${esc(label)}</span><p class="source-description">${esc(meaning)}${source?.method === 'csv' ? (source.source_code === 'gsc_web_ui_csv' ? ' Aus manuellem Search-Console-CSV-Export übernommen. ' : ' Aus manuellem Meta-CSV-Export übernommen. ') + esc(source.note || '') : source?.note ? ' ' + esc(source.note) : ''}${source?.error ? ' ' + esc(errorText[source.error] || 'Der letzte Abruf ist fehlgeschlagen; frühere Werte bleiben erhalten.') : ''}</p></td><td>${badge(source)}</td><td>${sourceClock(source)}${['error', 'partial'].includes(source?.status) ? `<span class="code">Versuch: ${esc(time(source.attempted_at))}</span>` : ''}</td><td>${source?.period ? esc(date(source.period.from) + ' – ' + date(source.period.to)) : '—'}</td></tr>`).join('')}</tbody></table></div><div class="settings-grid"><section class="panel">${metaSource().method === 'csv' ? '<h2>Manueller Facebook-Stand</h2><p class="panel-note">Die Facebook-Werte stammen aus einem manuellen Meta-CSV-Export. Das Tagesupdate benennt die Ausgabe; Export und Import zeigen die tatsächlichen Zeitpunkte. Für andere Quellen gelten deren eigene Stände. Geplante lokale Prüfungen: 09:00 und 18:00 Europe/Berlin. Rechner und angemeldetes Chrome-Profil müssen verfügbar sein.</p>' : '<h2>Lokale zweimal tägliche Pflege</h2><p class="panel-note">Vorgesehene Prüfung: täglich 09:00 und 18:00 Europe/Berlin auf diesem Rechner. Anbieter und geplante Läufe können verzögert sein. Maßgeblich ist immer der erfolgreiche Quellenstand oben, nicht wann diese Seite neu geladen wurde.</p>'}<p class="panel-note">Die Ansicht liest alle fünf Minuten den gespeicherten Stand neu. „Aktualisieren“ startet keinen neuen Meta-Abruf.</p></section><section class="panel"><h2>Google Search Console</h2><p class="panel-note">${data.sources.search_console?.status === 'connected' ? 'Verifizierter manueller GSC-Export. Suchklicks und Suchimpressionen stehen auf der Website-Seite mit eigenem Zeitraum; die jüngsten Tage sind vorläufig. Keine automatische API-Verbindung.' : 'Noch keine verifizierte Verbindung. Suchklicks und Suchimpressionen werden hier nicht geschätzt.'}</p><p class="panel-note">Roadmap und alte Website-Baustellen erscheinen erst als eigene Inhalte, wenn sie automatisch aktuell gehalten werden können.</p></section></div><details class="panel"><summary class="small-text">Dataset-Signale und technischer Prüfstand</summary>${sourceLine(events)}<p class="panel-note">${events.source_code === 'events_manager_ui' ? (events.status === 'error' ? 'Letzter bestätigter Events-Manager-Stand; neuer Abruf fehlgeschlagen. ' : 'Aus Events Manager gelesen · Eingänge vor Verarbeitung, keine eindeutigen Besucher. ') + esc(events.note || '') : events.source_code === 'meta_dataset_stats' ? 'Dataset-API · begrenzter UTC-Tag bis zum erfolgreichen Abruf.' : 'Historischer Events-Manager-Beleg; kein neuer bestätigter API-Read.'} Dataset-Zahlen nicht zu Anzeigenaktionen oder Website-Besuchern addieren.</p><div class="table-wrap"><table><thead><tr><th>Ereignis</th><th class="numeric">Signale</th></tr></thead><tbody>${(events.events || []).map(item => `<tr><td>${esc(({ Lead: 'Lead-Signale', StartTrial: 'Testphase begonnen' })[item.key] || item.label)}</td><td class="numeric">${num(item.count)}<span class="code">${esc(item.connection_method || '')} ${item.last_received ? '· zuletzt ' + esc(item.last_received) : ''}</span></td></tr>`).join('')}</tbody></table></div><p class="panel-note">${esc(events.diagnostics || '')} ${esc(events.deduplication || '')}</p><p class="panel-note">Letzte dokumentierte CAPI-Prüfung: ${esc(time(data.verification?.checked_at))}. ${esc(data.verification?.capi || '')} Ein neuer positiver Empfangstest ist dadurch nicht belegt.</p><p class="panel-note">Freigegebener Umfang: Konto ${esc(data.scope.account)}, Adsets ${esc(data.scope.adset)} und ${esc(TRAFFIC.adset)}, Dataset ${esc(data.scope.dataset)}. Nur aggregierte Daten.</p></details>`;
}
function renderFacebookResults() { const element = $('#facebook-results'); if (element) element.innerHTML = facebookResults(route().tab === 'creatives' ? 'creatives' : 'performance'); }
function render() {
  if (!data) return;
  const current = route(), [kicker, title, description] = routes[current.page];
  $('#page-kicker').textContent = kicker; $('#page-title').textContent = title; $('#page-description').textContent = description;
  document.title = `ChatLine Pulse · ${title}`;
  document.querySelectorAll('[data-page]').forEach(link => { if (link.dataset.page === current.page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#period-wrap').hidden = !(['overview', 'facebook'].includes(current.page) || current.page === 'funnel' && funnelMode(current.tab) === 'meta');
  $('#campaign').value = state.campaign;
  $('#period').value = state.period;
  const allOption = $('#period option[value="all"]'); if (allOption) allOption.disabled = !metaSource().complete_test_window;
  $('#period-label').textContent = periodLabel();
  $('#view').innerHTML = (current.page === 'overview' ? campaignCards() : '') + campaignNotice() + (current.page === 'overview' ? overview() : current.page === 'facebook' ? current.code ? adDetail(current.code) : facebook(current.tab) : current.page === 'website' ? website() : current.page === 'funnel' ? funnel(current.tab) : tracking(current.tab));
  const notice = $('#transport-notice');
  notice.hidden = !loadFailed && transport.status !== 'historical_fallback';
  notice.textContent = loadFailed ? 'Der gespeicherte Stand konnte nicht aktualisiert werden. Vorhandene Werte behalten ihren bisherigen Datenstand.' : 'Die aktuelle Datenablage ist nicht erreichbar. Der letzte verfügbare Quellenstand bleibt sichtbar; seine ursprünglichen Zeitpunkte gelten weiterhin.';
}
async function load() {
  $('#reload').disabled = true;
  try {
    const response = await fetch('/api/data', { cache: 'no-store' });
    if (!response.ok) throw Error('UNAVAILABLE');
    const result = await response.json();
    if (!result.snapshot?.sources?.meta || !Array.isArray(result.snapshot.ads)) throw Error('INVALID');
    if (!data || Date.parse(result.snapshot.collected_at) >= Date.parse(data.collected_at)) data = result.snapshot;
    transport = result.transport || {}; loadFailed = false;
    if (state.period === null) state.period = metaSource().complete_test_window ? 'all' : 'latest';
    render();
  } catch { loadFailed = true; if (data) render(); else { $('#transport-notice').hidden = false; $('#transport-notice').textContent = 'Die Daten sind gerade nicht erreichbar. Es werden keine Werte geschätzt.'; $('#view').innerHTML = '<div class="empty-state">Noch kein verlässlicher Stand verfügbar. Bitte später erneut laden.</div>'; } }
  finally { $('#reload').disabled = false; }
}
$('#reload').addEventListener('click', load);
$('#period').addEventListener('change', event => { state.period = event.target.value; render(); });
window.addEventListener('hashchange', render);
document.addEventListener('input', event => { if (event.target.id === 'creative-search') { state.search = event.target.value; renderFacebookResults(); } });
document.addEventListener('change', event => { if (event.target.id === 'campaign') { state.campaign = event.target.value === 'traffic' ? 'traffic' : 'original'; state.search = ''; state.stage = 'all'; state.delivery = 'all'; render(); return; } const key = { 'creative-stage': 'stage', 'creative-delivery': 'delivery', 'creative-sort': 'sort' }[event.target.id]; if (key) { state[key] = event.target.value; renderFacebookResults(); } });
document.addEventListener('click', async event => {
  const campaign = event.target.closest('[data-campaign]'); if (campaign) { state.campaign = campaign.dataset.campaign === 'traffic' ? 'traffic' : 'original'; state.search = ''; state.stage = 'all'; state.delivery = 'all'; render(); return; }
  const site = event.target.closest('[data-site]'); if (site) { state.site = site.dataset.site === 'chatline.app' ? 'chatline.app' : 'start.chatline.app'; render(); }
  const copy = event.target.closest('[data-copy]'); if (copy) {
    const record = linkCatalog().find(item => item.code === copy.dataset.copy);
    if (record) try { await navigator.clipboard.writeText(`${record.targetUrl}&${record.urlParameters}`); $('#copy-status').textContent = 'Anzeigen-/UTM-Vorlage kopiert. Meta ersetzt {{…}} beim Ausspielen.'; } catch { $('#copy-status').textContent = 'Kopieren nicht verfügbar. Der vollständige Link steht in der Tabelle.'; }
  }
});
await load();
setInterval(load, 5 * 60 * 1000);
