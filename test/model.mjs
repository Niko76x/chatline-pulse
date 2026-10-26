export function freshness(observedAt, now = Date.now()) {
  if (!observedAt) return { state: 'missing', label: 'Nicht verbunden', minutes: null };
  const minutes = Math.floor((now - Date.parse(observedAt)) / 60000);
  if (!Number.isFinite(minutes) || minutes < -5) return { state: 'error', label: 'Zeitstempel prüfen', minutes: null };
  return { state: minutes > 45 ? 'stale' : 'fresh', label: minutes > 45 ? 'Veraltet' : 'Aktuell abgerufen', minutes: Math.max(0, minutes) };
}
export function total(rows, key) {
  if (!rows.length || rows.some(r => r[key] === null || r[key] === undefined)) return null;
  return rows.reduce((s, r) => s + r[key], 0);
}
export const ratio = (a, b, multiplier = 1) => a === null || b === null || b <= 0 ? null : a / b * multiplier;
export function analyticsView(source, site, now = Date.now()) {
  const current = source?.sites?.find(s => s.site === site);
  const days = (current?.daily || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const latest = days.at(-1) || null;
  const state = !current || current.status === 'not_connected' ? 'not_connected' : current.status === 'error' ? 'error' : freshness(current.observed_at, now).state;
  // Visitors are meaningful per returned day. Do not add users across days or sites.
  const projectLabel = site === 'chatline.app' ? 'Projekt chatline-website · Produktion inklusive chatline.app + mindbody-home.chatline.app' : 'Projekt limitless · Produktion inklusive start.chatline.app';
  return { site, label: current?.label || projectLabel, state, observed_at: current?.observed_at || null, attempted_at: current?.attempted_at || null,
    error: current?.error || null, period: current?.period || null, days,
    latest_date: latest?.date || null, visitors: latest?.visitors ?? null, pageviews: latest?.pageviews ?? null };
}
export function summarize(rows) {
  const result = Object.fromEntries(['spend', 'impressions', 'link_clicks', 'landing_page_views', 'studio_tests', 'call_requests', 'checkouts', 'trials'].map(k => [k, total(rows, k)]));
  // Reach cannot be summed across days without double-counting people.
  result.reach = rows.length === 1 ? rows[0].reach : null;
  result.cpc = ratio(result.spend, result.link_clicks);
  result.ctr = ratio(result.link_clicks, result.impressions, 100);
  result.cpm = ratio(result.spend, result.impressions, 1000);
  // Retain the snapshot's existing internal key; this is cost per Lead event,
  // not cost per qualified studio or new customer.
  result.cost_per_test = ratio(result.spend, result.studio_tests);
  return result;
}
export function reviewAd(metrics, source, config = {}, now = Date.now()) {
  const fresh = freshness(source.observed_at, now);
  if (fresh.state !== 'fresh' || source.status === 'error') return { state: 'data', title: 'Daten prüfen', text: 'Der letzte belegte Stand ist nicht frisch. Erst die Quelle prüfen, dann die Anzeige beurteilen.' };
  if (!source.complete_test_window) return { state: 'data', title: 'Zeitraum unvollständig', text: 'Für eine kumulierte Prüfung brauchen wir die Daten seit Testbeginn. Ein einzelner Tag ersetzt diesen Zeitraum nicht.' };
  if (metrics.spend === null) return { state: 'untested', title: 'Einzelwerte fehlen', text: 'Ohne Ausgaben und Klicks je Anzeige ist kein Vergleich möglich.' };
  if (metrics.spend === 0) return { state: 'untested', title: 'Noch nicht getestet', text: 'Ohne Auslieferung lässt sich die Anzeige nicht beurteilen.' };
  if (metrics.link_clicks === null) return { state: 'data', title: 'Klickmessung prüfen', text: 'Es gibt Ausgaben, aber keinen gemeldeten Wert für Linkklicks.' };
  if (metrics.link_clicks > 0 && metrics.landing_page_views === null) return { state: 'data', title: 'Übergang zur Website prüfen', text: 'Linkklicks sind gemeldet. Landingpage-Aufrufe fehlen als Messwert; daraus folgt keine Null.' };
  if (config.enabled && metrics.cpc !== null && metrics.spend >= config.cpc_review_start && metrics.cpc > config.cpc_review_above) return { state: 'review', title: 'Traffic gemeinsam prüfen', text: 'Der vorläufige CPC-Prüfpunkt ist erreicht. Ansprache, Motiv, Landingpage und stärkere Signale zusammen ansehen. Keine automatische Abschaltung.' };
  if (config.enabled && metrics.link_clicks >= config.funnel_review_clicks && metrics.studio_tests === 0) return { state: 'review', title: 'Lead-Funnel prüfen', text: 'Klicks sind da, aber keine zugerechneten Lead-Signale. Tracking, Zielgruppe und Seite prüfen; eine B2B-Grenze ist noch nicht validiert.' };
  if (metrics.studio_tests > 0 || metrics.call_requests > 0) return { state: 'signal', title: 'Erste weiterführende Signale', text: 'Meta ordnet der Anzeige Aktionen zu. Das sind weder bestätigte zahlende Studios noch bereits ein bewiesener Gewinner.' };
  return { state: 'untested', title: 'Weiter beobachten', text: 'Noch keine belastbare Entscheidung. Kleine Stichproben und die Datenverzögerung berücksichtigen.' };
}
