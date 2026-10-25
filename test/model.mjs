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
export function summarize(rows) {
  const result = Object.fromEntries(['spend', 'impressions', 'link_clicks', 'landing_page_views', 'studio_tests', 'call_requests', 'checkouts', 'trials'].map(k => [k, total(rows, k)]));
  // Reach cannot be summed across days without double-counting people.
  result.reach = rows.length === 1 ? rows[0].reach : null;
  result.cpc = ratio(result.spend, result.link_clicks);
  result.ctr = ratio(result.link_clicks, result.impressions, 100);
  result.cpm = ratio(result.spend, result.impressions, 1000);
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
  if (config.enabled && metrics.link_clicks >= config.funnel_review_clicks && metrics.studio_tests === 0) return { state: 'review', title: 'Studio-Test-Funnel prüfen', text: 'Klicks sind da, aber keine zugerechneten Studio-Tests. Tracking, Zielgruppe und Seite prüfen; eine B2B-Grenze ist noch nicht validiert.' };
  if (metrics.studio_tests > 0 || metrics.call_requests > 0) return { state: 'signal', title: 'Erste weiterführende Signale', text: 'Meta ordnet der Anzeige Aktionen zu. Das sind weder bestätigte zahlende Studios noch bereits ein bewiesener Gewinner.' };
  return { state: 'untested', title: 'Weiter beobachten', text: 'Noch keine belastbare Entscheidung. Kleine Stichproben und die Datenverzögerung berücksichtigen.' };
}
