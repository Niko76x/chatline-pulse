import { TRAFFIC, TRAFFIC_AD_IDS } from '../public/assets/campaigns.js';

const ORIGINAL_ADS = Object.freeze({
  '120275421779180555': 'PIL-PA-01', '120275422266100555': 'PIL-PA-02',
  '120275421929330555': 'PIL-PA-03', '120275422266130555': 'PIL-PA-04',
  '120275421929340555': 'PIL-PR-01', '120275422266170555': 'PIL-PR-02',
  '120275422266160555': 'PIL-PR-03', '120275422266150555': 'PIL-PR-04',
  '120275422266110555': 'PIL-SA-01', '120275422266120555': 'PIL-SA-02',
  '120275422266140555': 'PIL-SA-03', '120275421929310555': 'PIL-SA-04',
  '120275421929320555': 'PIL-VID-01',
});
const ORIGINAL = Object.freeze({ account: '2128240694419507', dataset: '1727278251668513',
  campaign: '120274644271350555', adset: '120275421779190555',
  utmCampaign: 'pilates_dach_selftest_20261022', refPrefix: 'meta-pilates-de-120275421779190555-', ads: ORIGINAL_ADS });
const TRAFFIC_CONTRACT = Object.freeze({ ...TRAFFIC,
  utmCampaign: 'pilates_de_inhaber_linkklicks_20261024', refPrefix: 'meta-pilates-de-120275454337280555-', ads: TRAFFIC_AD_IDS });

// Closed registry. Runtime input selects only a known key, never supplies IDs,
// account/project paths or a campaign definition. CRM drafts are not imported.
export function trackingContract(key = 'original') {
  if (key === 'original') return ORIGINAL;
  if (key === 'traffic') return TRAFFIC_CONTRACT;
  throw new Error('TRACKING_SCOPE_NOT_ALLOWED');
}
