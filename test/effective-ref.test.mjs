import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {trackingContract} from '../lib/tracking-contracts.mjs';
import {inspectAdDestination,expectedTags} from '../scripts/meta-destination-preflight.mjs';
import {collectLinkAudit,mergeLinkAudit,validateLinkAudit} from '../lib/link-audit.js';
import {validateSnapshot} from '../api/data.js';
const snapshot=JSON.parse(await readFile(new URL('../public/data/fallback.json',import.meta.url),'utf8'));
const at=new Date('2026-10-28T13:23:09.272Z'),later=new Date('2026-10-28T14:07:00.000Z');
const reply=value=>({ok:true,status:200,json:async()=>value});
function fixture(key,id,placement='macro'){
 const contract=trackingContract(key),code=contract.ads[id].toLowerCase(),ref=`${contract.refPrefix}${code}`;
 const params=new URLSearchParams(Object.fromEntries(Object.entries(expectedTags(id,{campaignKey:key})).map(([k,v])=>[k,v[0]])));
 let link='https://start.chatline.app/?skin=pilates';
 if(placement==='base')link+='&ref='+ref;else params.set('ref',placement==='literal'?ref:`${contract.refPrefix.replace(contract.adset,'{{adset.id}}')}${code}`);
 return {id,account_id:contract.account,campaign_id:contract.campaign,adset_id:contract.adset,creative:{object_story_spec:{video_data:{call_to_action:{value:{link}}}},url_tags:params.toString()}};
}
const link=body=>body.creative.object_story_spec.video_data.call_to_action.value;
function changeTags(body,mutate){const p=new URLSearchParams(body.creative.url_tags);mutate(p);body.creative.url_tags=p.toString();return body;}
for(const key of ['crm','lookalike'])for(const [id,code] of Object.entries(trackingContract(key).ads))test(`saved Meta ${key} ${code} accepts its single own-adset ref macro in URL tags`,()=>{
 const result=inspectAdDestination(fixture(key,id),id,{campaignKey:key});assert.equal(result.status,'destination_validated');assert.deepEqual(result.failures,[]);
 assert(result.destinations.every(row=>row.checks.ref&&row.checks.landing_parameter_locations_valid&&row.checks.unique_query_keys&&row.checks.effective_utm_contract));
});
test('CRM/LAL accept exactly one literal own ref in either website URL or tags',()=>{
 for(const key of ['crm','lookalike']){const id=Object.keys(trackingContract(key).ads)[0];for(const placement of ['base','literal'])assert.equal(inspectAdDestination(fixture(key,id,placement),id,{campaignKey:key}).status,'destination_validated');}
});
test('duplicate or conflicting refs across either field never pass the effective URL contract',()=>{
 for(const key of ['crm','lookalike']){const c=trackingContract(key),id=Object.keys(c.ads)[0];
  for(const mutate of [b=>link(b).link+='&ref='+c.refPrefix+'vid-01',b=>changeTags(b,p=>p.append('ref',p.get('ref'))),b=>link(b).link+='&ref=other']){
   const body=fixture(key,id);mutate(body);const r=inspectAdDestination(body,id,{campaignKey:key});assert.equal(r.status,'needs_review');assert(r.destinations.every(d=>!d.checks.ref&&!d.checks.unique_query_keys));
  }
 }
});
test('unknown macros, wrong namespaces/adsets and nonliteral video-code macros remain rejected',()=>{
 for(const key of ['crm','lookalike']){const c=trackingContract(key),id=Object.keys(c.ads)[0];
  for(const ref of ['meta-crm-direct-{{unknown}}-vid-01',c.refPrefix.replace(c.adset,'{{campaign.id}}')+'vid-01',c.refPrefix.replace(c.adset,'111')+'vid-01',c.refPrefix+'{{ad.id}}',c.refPrefix.replace(c.adset,'{{adset.id}}')+'vid-01-{{unknown}}',(key==='crm'?trackingContract('lookalike'):trackingContract('crm')).refPrefix+'vid-01']){
   const body=changeTags(fixture(key,id),p=>p.set('ref',ref));const r=inspectAdDestination(body,id,{campaignKey:key});assert.equal(r.status,'needs_review');assert(r.destinations.every(d=>!d.checks.ref));
  }
 }
});
test('a valid ref never masks mismatched metadata or campaign/adset/ad/content tuples',()=>{
 const key='crm',c=trackingContract(key),id=Object.keys(c.ads)[0];
 for(const patch of [{account_id:'111'},{campaign_id:trackingContract('lookalike').campaign},{adset_id:trackingContract('lookalike').adset}]){const body={...fixture(key,id),...patch};assert.equal(inspectAdDestination(body,id,{campaignKey:key}).scope_validated,false);}
 for(const [field,value] of [['adset_id',trackingContract('lookalike').adset],['campaign_id','{{unknown}}'],['ad_id',Object.keys(c.ads)[1]],['utm_content','crm-direct-vid-02']]){
  const r=inspectAdDestination(changeTags(fixture(key,id),p=>p.set(field,value)),id,{campaignKey:key});assert.equal(r.status,'needs_review');assert(r.destinations.every(d=>!d.checks.effective_utm_contract));
 }
});
test('skin, studio, website and other unapproved landing tags cannot be appended by the scoped ref exception',()=>{
 const key='crm',id=Object.keys(trackingContract(key).ads)[0];
 for(const field of ['skin','studio','website','url','preview']){const r=inspectAdDestination(changeTags(fixture(key,id),p=>p.set(field,field==='skin'?'pilates':'unapproved')),id,{campaignKey:key});assert.equal(r.status,'needs_review');assert(r.failures.includes('LANDING_KEYS_IN_URL_TAGS'));assert(r.destinations.every(d=>!d.checks.landing_parameter_locations_valid));}
});
test('destination overrides, unsafe origins, paths and fragments remain blocked',()=>{
 const key='lookalike',id=Object.keys(trackingContract(key).ads)[0];
 const override=fixture(key,id);override.creative.asset_feed_spec={link_urls:[{website_url:'https://other.invalid/'}]};assert(inspectAdDestination(override,id,{campaignKey:key}).failures.includes('UNSUPPORTED_DESTINATION_FORMAT'));
 for(const destination of ['https://other.invalid/?skin=pilates','http://start.chatline.app/?skin=pilates','https://start.chatline.app/other?skin=pilates','https://start.chatline.app/?skin=pilates#other']){const body=fixture(key,id);link(body).link=destination;assert.equal(inspectAdDestination(body,id,{campaignKey:key}).status,'needs_review');}
});
test('all original13 and Traffic5 retain the earlier literal-website-ref rule',()=>{
 for(const key of ['original','traffic'])for(const id of Object.keys(trackingContract(key).ads)){
  assert.equal(inspectAdDestination(fixture(key,id,'base'),id,{campaignKey:key}).status,'destination_validated');
  const r=inspectAdDestination(fixture(key,id),id,{campaignKey:key});assert.equal(r.status,'needs_review');assert(r.failures.includes('LANDING_KEYS_IN_URL_TAGS'));
 }
});
test('new cohort snapshots use a truthful placement check while old needs_review snapshots remain valid and unchanged',async()=>{
 for(const key of ['crm','lookalike']){const c=trackingContract(key),read=await collectLinkAudit({campaignKey:key,enabled:true,token:'fixture',now:at,fetcher:async url=>reply(fixture(key,url.pathname.split('/').at(-1)))});
  const current=mergeLinkAudit(null,read,{campaignKey:key});assert.equal(current.checked_count,3);assert(current.ads.every(row=>row.status==='valid'&&row.checks.landing_parameter_locations_valid===true&&!Object.hasOwn(row.checks,'landing_keys_in_url_tags_absent')));
  const data=structuredClone(snapshot);data.sources[`link_audit_${key}`]=current;validateSnapshot(data);
  const old=structuredClone(current);for(const row of old.ads){delete row.checks.landing_parameter_locations_valid;row.checks.landing_keys_in_url_tags_absent=false;row.checks.ref=false;row.status='needs_review';row.error='DESTINATION_CONFIG_REVIEW_REQUIRED';}
  const before=structuredClone(old);validateLinkAudit(old,{campaignKey:key});data.sources[`link_audit_${key}`]=old;validateSnapshot(data);assert.deepEqual(old,before);
  const failure=await collectLinkAudit({campaignKey:key,enabled:true,token:'fixture',now:later,fetcher:async()=>({ok:false,status:403,json:async()=>({error:{code:200}})})});
  const kept=mergeLinkAudit(old,failure,{campaignKey:key});assert.equal(kept.observed_at,old.observed_at);assert(kept.ads.every(row=>row.checked_at===at.toISOString()&&row.checks.landing_keys_in_url_tags_absent===false&&!Object.hasOwn(row.checks,'landing_parameter_locations_valid')));
 }
});
