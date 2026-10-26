// A bounded manual Ads Manager export is a source observation, not an API read.
export const CSV_METHOD = 'csv';
export const CSV_REPORTING_BASIS = 'ads_manager_export';
export const CSV_ATTRIBUTION_SETTING = '7-day click, 1-day view, or 1-day engaged-view';
export const CSV_MAX_PROTECTION_MS = 24 * 60 * 60 * 1000;
const UPDATE_KEYS = new Set(['edition_label', 'exported_at', 'imported_at', 'valid_until', 'attribution_setting', 'reporting_basis', 'timezone']);
const fail = () => { throw new Error('SNAPSHOT_CSV_META_INVALID'); };
function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function validEdition(value) {
  if (typeof value !== 'string' || value.length > 80) return false;
  const m = value.match(/^Tagesupdate (\d{2})\.(\d{2})\.(\d{4}), (\d{2}):(\d{2})$/);
  if (!m || Number(m[4]) > 23 || Number(m[5]) > 59) return false;
  const day = `${m[3]}-${m[2]}-${m[1]}`;
  const time = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
}
export function validateCsvMetaSource(source) {
  if (source?.method === undefined && source?.manual_update === undefined) return source;
  if (source?.method !== CSV_METHOD) fail();
  const update = source.manual_update;
  if (!update || typeof update !== 'object' || Array.isArray(update) ||
      Object.keys(update).length !== UPDATE_KEYS.size || Object.keys(update).some(key => !UPDATE_KEYS.has(key)) ||
      !validEdition(update.edition_label) || !validTimestamp(update.exported_at) || !validTimestamp(update.imported_at) || !validTimestamp(update.valid_until) ||
      update.attribution_setting !== CSV_ATTRIBUTION_SETTING || update.reporting_basis !== CSV_REPORTING_BASIS ||
      update.timezone !== 'Europe/Berlin' || source.timezone !== update.timezone) fail();
  const exported = Date.parse(update.exported_at), imported = Date.parse(update.imported_at), expiry = Date.parse(update.valid_until);
  // Neither a stale export nor an indefinite hold can be disguised as today's refresh.
  if (exported > imported || imported - exported > CSV_MAX_PROTECTION_MS || expiry <= imported || expiry - imported > CSV_MAX_PROTECTION_MS) fail();
  return source;
}
export function csvMetaIsProtected(source, now = new Date()) {
  validateCsvMetaSource(source);
  if (source?.method !== CSV_METHOD || !(now instanceof Date) || !Number.isFinite(now.getTime())) return false;
  const current = now.getTime();
  return Date.parse(source.manual_update.imported_at) <= current && current < Date.parse(source.manual_update.valid_until);
}
