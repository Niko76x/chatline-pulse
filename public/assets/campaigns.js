// Reviewed identities only. Identical creative codes in different campaigns
// must never share performance, delivery or DIY-attribution rows.
export const TRAFFIC = Object.freeze({
  account: '2128240694419507', dataset: '1727278251668513',
  campaign: '120275454337270555', adset: '120275454337280555',
  name: 'Traffic · Deutschland / Pilates',
  objective: 'OUTCOME_TRAFFIC',
});
export const TRAFFIC_AD_IDS = Object.freeze({
  '120275454337290555': 'PIL-PA-01',
  '120275471298970555': 'PIL-PA-04',
  '120275471298980555': 'PIL-LM-01',
  '120275471298990555': 'PIL-SA-02',
  '120275471299000555': 'PIL-VID-01',
});
export const TRAFFIC_ADS = Object.freeze(Object.entries(TRAFFIC_AD_IDS).map(([ad_id, code]) => Object.freeze({
  ad_id, code,
  name: ({'PIL-PA-01':'Unterbrechung im Unterricht','PIL-PA-04':'Studiofragen nach Feierabend','PIL-LM-01':'Assistent in 4 Minuten','PIL-SA-02':'Fragen vor dem ersten Kurs klären','PIL-VID-01':'Kundenstimmen + Studio-Test'})[code],
  angle: 'Veröffentlichte Traffic-Anzeige', stage: 'Nicht neu geprüft',
  format: code === 'PIL-VID-01' ? 'video' : 'image',
})));

// Exact, separately authorized cohorts. Presence in this reporting registry
// proves neither publication nor delivery; Meta status is never inferred here.
export const CRM = Object.freeze({ account: '2128240694419507', dataset: '1727278251668513',
  campaign: '120275503974760555', adset: '120275503974770555', name: 'CRM · bekannte Kontakte', objective: 'OUTCOME_LEADS' });
export const LOOKALIKE = Object.freeze({ account: '2128240694419507', dataset: '1727278251668513',
  campaign: '120275504052470555', adset: '120275504052490555', name: 'Lookalike · ähnliche Zielgruppe', objective: 'OUTCOME_LEADS' });
export const CRM_AD_IDS = Object.freeze({ '120275505908750555': 'VID-01', '120275504866300555': 'VID-02', '120275504866310555': 'VID-03' });
export const LOOKALIKE_AD_IDS = Object.freeze({ '120275504052480555': 'VID-01', '120275504962450555': 'VID-02', '120275504945410555': 'VID-03' });
const cohortAds = ids => Object.freeze(Object.entries(ids).map(([ad_id, code]) => Object.freeze({
  ad_id, code, name: `Video ${code.slice(-2)}`, angle: 'Nicht neu geprüft', stage: 'Nicht neu geprüft', format: 'video',
})));
export const CRM_ADS = cohortAds(CRM_AD_IDS);
export const LOOKALIKE_ADS = cohortAds(LOOKALIKE_AD_IDS);
