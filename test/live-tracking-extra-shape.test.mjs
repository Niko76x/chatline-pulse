import test from 'node:test';import assert from 'node:assert/strict';
import {trackingContract} from '../lib/tracking-contracts.mjs';
import {expectedTags,inspectAdDestination,SCOPED_NON_LANDING_TRACKING_KEYS} from '../scripts/meta-destination-preflight.mjs';
import {LINK_AUDIT_EXTRA_KEYS,collectLinkAudit,mergeLinkAudit} from '../lib/link-audit.js';
// Sanitized live shape observed at 2026-10-28T14:03:11.844Z: exact eight extra
// names are retained; their original values were deliberately not retained.
const liveKeys=['utm_id','hsa_acc','hsa_cam','hsa_grp','hsa_ad','hsa_src','hsa_net','hsa_ver'];
const now=new Date('2026-10-28T14:03:11.844Z');
function body(key,id){const c=trackingContract(key),tags=new URLSearchParams(Object.fromEntries(Object.entries(expectedTags(id,{campaignKey:key})).map(([k,v])=>[k,v[0]])));tags.set('ref',c.refPrefix.replace(c.adset,'{{adset.id}}')+c.ads[id].toLowerCase());for(const field of liveKeys)tags.set(field,'redacted-unvalidated');return{id,account_id:c.account,campaign_id:c.campaign,adset_id:c.adset,creative:{object_story_spec:{video_data:{call_to_action:{value:{link:'https://start.chatline.app/?skin=pilates'}}}},url_tags:tags.toString()}};}
const reply=value=>({ok:true,status:200,json:async()=>value});
test('scoped non-landing exceptions exactly match the already existing sidecar name whitelist',()=>{assert.deepEqual([...SCOPED_NON_LANDING_TRACKING_KEYS].sort(),liveKeys.sort());assert.deepEqual([...SCOPED_NON_LANDING_TRACKING_KEYS].sort(),Object.keys(LINK_AUDIT_EXTRA_KEYS).sort());});
for(const key of ['crm','lookalike'])test(`all three live-shaped ${key} configs pass core ref placement but retain explicit extra-value review`,async()=>{
 const result=await collectLinkAudit({campaignKey:key,enabled:true,token:'fixture',now,fetcher:async url=>reply(body(key,url.pathname.split('/').at(-1)))}),source=mergeLinkAudit(null,result,{campaignKey:key});
 assert.equal(source.checked_count,3);for(const row of source.ads){assert.equal(row.status,'core_verified_extra_review');assert.equal(row.checks.landing_parameter_locations_valid,true);assert.equal(row.checks.ref,true);assert(Object.values(row.checks).every(Boolean));assert(Object.values(row.tag_checks).every(Boolean));assert.equal(row.extra_keys.length,8);assert.equal(row.unrecognized_extra_key_count,0);assert.equal(row.error,null);}
 assert(!JSON.stringify(source).includes('redacted-unvalidated'));
});
test('known tracking extras never excuse landing controls or other unknown extra names',async()=>{
 const key='crm',id=Object.keys(trackingContract(key).ads)[0];for(const field of ['skin','website','studio','url','hsa_unknown','unknown_tracking']){const value=body(key,id),tags=new URLSearchParams(value.creative.url_tags);tags.set(field,'unapproved');value.creative.url_tags=tags.toString();const inspection=inspectAdDestination(value,id,{campaignKey:key});assert(inspection.destinations.every(row=>row.checks.landing_parameter_locations_valid===false));const source=mergeLinkAudit(null,await collectLinkAudit({campaignKey:key,enabled:true,token:'fixture',now,fetcher:async url=>reply(url.pathname.endsWith(id)?value:body(key,url.pathname.split('/').at(-1)))}),{campaignKey:key});assert.equal(source.ads.find(row=>row.ad_id===id).status,'needs_review');}
});
test('extra names never validate wrong ref macros, duplicate refs, wrong core IDs or destination overrides',()=>{
 const key='lookalike',id=Object.keys(trackingContract(key).ads)[0];for(const mutate of [p=>p.set('ref','meta-crm-lookalike-{{unknown}}-vid-01'),p=>p.append('ref',p.get('ref')),p=>p.set('ad_id',Object.keys(trackingContract('crm').ads)[0])]){const value=body(key,id),p=new URLSearchParams(value.creative.url_tags);mutate(p);value.creative.url_tags=p.toString();const inspection=inspectAdDestination(value,id,{campaignKey:key});assert(inspection.destinations.some(row=>!row.checks.ref||!row.checks.effective_utm_contract));}
 const override=body(key,id);override.creative.asset_feed_spec={link_urls:[{website_url:'https://other.invalid'}]};assert(inspectAdDestination(override,id,{campaignKey:key}).failures.includes('UNSUPPORTED_DESTINATION_FORMAT'));
});
