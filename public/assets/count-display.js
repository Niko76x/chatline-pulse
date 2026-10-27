// Presentation only: never substitute a lower bound into strict totals or rates.
const ADDITIVE_COUNTS = new Set(['clicks', 'impressions', 'link_clicks', 'landing_page_views', 'studio_tests', 'call_requests', 'checkouts', 'trials', 'studio_started', 'call_requested', 'checkout_started', 'dashboard_activated']);

export function reportedCount(rows, key) {
  const totalDays = Array.isArray(rows) ? rows.length : 0;
  const unknown = { value: null, minimum: false, partial: totalDays > 0, known_days: 0, reported_days: totalDays };
  if (!ADDITIVE_COUNTS.has(key) || !totalDays) return unknown;
  const known = rows.filter(row => Number.isSafeInteger(row?.[key]) && row[key] >= 0);
  const value = known.reduce((sum, row) => sum + row[key], 0);
  if (!Number.isSafeInteger(value)) return unknown;
  const partial = known.length !== totalDays;
  return { value: partial && value === 0 ? null : value, minimum: partial && value > 0, partial, known_days: known.length, reported_days: totalDays };
}
