import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { trackingContract } from '../lib/tracking-contracts.mjs';
import { collectDiyFunnel, mergeDiyFunnel, validateDiyFunnelSource } from '../lib/diy-funnel.mjs';
import { collectLinkAudit, mergeLinkAudit, validateLinkAudit } from '../lib/link-audit.js';
import { expectedTags, inspectAdDestination } from '../scripts/meta-destination-preflight.mjs';
import { validateSnapshot, mergeAnalytics, refreshSources, canSkipCollection, ANALYTICS_PROJECTS } from '../api/data.js';

const traffic = trackingContract('traffic'), originalContract = trackingContract();
const contracts = {original:originalContract,traffic,crm:trackingContract('crm'),lookalike:trackingContract('lookalike')};
const trafficIds = Object.keys(traffic.ads), originalIds = Object.keys(originalContract.ads);
const now = new Date('2026-10-28T09:07:00.000Z'), slot = '2026-10-28T09:00:00.000Z';
const later = new Date('2026-10-28T09:37:00.000Z');
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
const reply = value => ({ ok: true, status: 200, json: async () => value });
function destination(id, contract = traffic) {
  const campaignKey = Object.keys(contracts).find(key=>contracts[key]===contract);
  const url = `https://start.chatline.app/?skin=pilates&ref=${contract.refPrefix}${contract.ads[id].toLowerCase()}`;
  const tags = new URLSearchParams(Object.fromEntries(Object.entries(expectedTags(id, { campaignKey })).map(([key,values]) => [key,values[0]])));
  return { id, account_id: contract.account, campaign_id: contract.campaign, adset_id: contract.adset,
    creative: { object_story_spec: { link_data: { link: url } }, url_tags: tags.toString() } };
}
function eventReply(url, { positive = false, wrong = false } = {}) {
  const params = url.searchParams, filter = params.get('filter');
  const contract = Object.values(contracts).find(contract=>filter.includes(contract.campaign));
  const id = wrong ? originalIds[0] : Object.keys(contract.ads)[0];
  return reply({ version: 1, query: { since: Number(params.get('since')), until: Number(params.get('until')), filter,
    groupBy: ['eventData/ad_id'], limit: 32 },
    data: positive && filter.includes("eventName eq 'diy_studio_started'") ? [{ eventData: id, count: contract === traffic ? 7 : 2, visitors: 1 }] : [] });
}
function completedCore() {
  return mergeAnalytics(original, ANALYTICS_PROJECTS.map(project => ({ site: project.site, label: project.label,
    status: 'connected', observed_at: now.toISOString(), attempted_at: now.toISOString(), error: null, timezone: 'UTC', daily: [] })), { now, slot });
}

test('tracking selectors are closed to original13, Traffic5 and the six explicitly authorized cohort IDs', () => {
  assert.equal(originalIds.length,13); assert.equal(trafficIds.length,5);
  assert.equal(traffic.ads[trafficIds[0]],originalContract.ads[originalIds[0]]);
  assert.equal(Object.keys(contracts.crm.ads).length,3); assert.equal(Object.keys(contracts.lookalike.ads).length,3);
  for(const key of ['120275503974760555',{},null,'other-account'])
    assert.throws(()=>trackingContract(key),/SCOPE_NOT_ALLOWED/);
  for(const id of ['120275505908750555','120275504866300555','120275504866310555','120275504052480555','120275504962450555','120275504945410555','120275503974780555']) {
    assert.equal(expectedTags(id),null); assert.equal(expectedTags(id,{campaignKey:'traffic'}),null);
    assert.throws(()=>inspectAdDestination({id},id,{campaignKey:'traffic'}),/SCOPE/);
  }
  assert(Object.isFrozen(traffic)); assert(Object.isFrozen(traffic.ads));
});

test('Traffic metadata audit performs exactly five fixed GETs and completes only those five', async () => {
  const reads=[];
  const result=await collectLinkAudit({ campaignKey:'traffic', enabled:true, token:'fixture', version:'v26.0', now,
    fetcher:async(url,init)=>{ const id=url.pathname.split('/').at(-1); assert(trafficIds.includes(id)); assert.equal(init.method,'GET');
      assert.equal(url.origin,'https://graph.facebook.com'); assert.equal(init.redirect,'error'); reads.push(id); return reply(destination(id)); } });
  assert.deepEqual(reads,trafficIds);
  const source=mergeLinkAudit(null,result,{campaignKey:'traffic'});
  assert.equal(source.checked_count,5); assert.equal(source.complete,true); assert.equal(source.status,'connected');
  validateLinkAudit(source,{campaignKey:'traffic'}); assert.throws(()=>validateLinkAudit(source),/INVALID_LINK/);
  const snapshot=structuredClone(original); snapshot.sources.link_audit_traffic=source; validateSnapshot(snapshot);
  snapshot.sources.link_audit=source; assert.throws(()=>validateSnapshot(snapshot),/INVALID_LINK/);
});

test('same creative code never admits original identities or cross-campaign tuples to Traffic', () => {
  assert.throws(()=>inspectAdDestination(destination(originalIds[0],originalContract),originalIds[0],{campaignKey:'traffic'}),/SCOPE/);
  const body=destination(trafficIds[0]); body.campaign_id=originalContract.campaign;
  assert.equal(inspectAdDestination(body,trafficIds[0],{campaignKey:'traffic'}).scope_validated,false);
  const wrongRef=destination(trafficIds[0]); wrongRef.creative.object_story_spec.link_data.link=`https://start.chatline.app/?skin=pilates&ref=${originalContract.refPrefix}pil-pa-01`;
  assert.equal(inspectAdDestination(wrongRef,trafficIds[0],{campaignKey:'traffic'}).status,'needs_review');
});

test('Traffic DIY reads its own scoped aggregates and rejects original IDs instead of merging codes', async () => {
  const source=await collectDiyFunnel({campaignKey:'traffic',token:'fixture',now,fetcher:async url=>eventReply(url,{positive:true})});
  assert.equal(source.campaign,traffic.campaign); assert.equal(source.daily.length,2);
  assert(source.daily.every(row=>row.code==='PIL-PA-01'&&row.studio_started===7&&row.call_requested===null));
  validateDiyFunnelSource(source,{campaignKey:'traffic'}); assert.throws(()=>validateDiyFunnelSource(source),/SOURCE_INVALID/);
  await assert.rejects(collectDiyFunnel({campaignKey:'traffic',token:'fixture',now,fetcher:async url=>eventReply(url,{positive:true,wrong:true})}),/SCOPE|RESPONSE/);
});

test('empty Traffic is awaiting_events without zero rows; 403 preserves earlier counts and observed time', async () => {
  const empty=await collectDiyFunnel({campaignKey:'traffic',token:'fixture',now,fetcher:async url=>eventReply(url)});
  assert.equal(empty.status,'awaiting_events'); assert.deepEqual(empty.daily,[]);
  const positive=await collectDiyFunnel({campaignKey:'traffic',token:'fixture',now,fetcher:async url=>eventReply(url,{positive:true})});
  await assert.rejects(collectDiyFunnel({campaignKey:'traffic',token:'fixture',now:later,fetcher:async()=>({ok:false,status:403})}),/DIY_PERMISSION_REQUIRED/);
  const failed=mergeDiyFunnel(positive,null,{campaignKey:'traffic',now:later,error:'DIY_PERMISSION_REQUIRED'});
  assert.equal(failed.observed_at,positive.observed_at); assert.equal(failed.attempted_at,later.toISOString());
  assert.deepEqual(failed.daily,positive.daily); assert.equal(failed.status,'error');
});

test('Traffic link failures retain each previous check time and never copy original observations', async () => {
  const positive=mergeLinkAudit(null,await collectLinkAudit({campaignKey:'traffic',enabled:true,token:'fixture',now,fetcher:async url=>reply(destination(url.pathname.split('/').at(-1)))}),{campaignKey:'traffic'});
  const readErrors=await collectLinkAudit({campaignKey:'traffic',enabled:true,token:'fixture',now:later,fetcher:async()=>({ok:false,status:403,json:async()=>({error:{code:200}})})});
  const failed=mergeLinkAudit(positive,readErrors,{campaignKey:'traffic'});
  assert.equal(failed.observed_at,positive.observed_at); assert.equal(failed.checked_count,0); assert.equal(failed.complete,false);
  assert(failed.ads.every(row=>row.checked_at===now.toISOString()&&row.attempted_at===later.toISOString()&&row.status==='read_error'));
});

test('refresh gates isolate all four campaign slots and never re-read original13 to fill missing Traffic sources', async () => {
  const previous=completedCore(), reads={events:0,metadata:0};
  const options={now,slot,diyFunnelEnabled:true,linkAuditEnabled:true,
    analyticsOptions:{tokens:{'start.chatline.app':'fixture'},fetcher:async(url,init)=>{assert.equal(init.method,'GET'); reads.events++;return eventReply(url,{positive:true});}},
    metaOptions:{token:'fixture',version:'v26.0',fetcher:async(url,init)=>{assert.equal(init.method,'GET');reads.metadata++;const id=url.pathname.split('/').at(-1);return reply(destination(id,Object.values(contracts).find(contract=>Object.hasOwn(contract.ads,id))));}}};
  const first=await refreshSources(previous,options);
  assert.equal(reads.events,32); assert.equal(reads.metadata,24); assert.equal(first.success,true);
  assert(first.snapshot.sources.diy_funnel.daily.every(row=>row.studio_started===2));
  assert(first.snapshot.sources.diy_funnel_traffic.daily.every(row=>row.studio_started===7));
  assert.equal(canSkipCollection(first.snapshot,{...options,analyticsProjects:[]}),true);
  const missing=structuredClone(first.snapshot); delete missing.sources.diy_funnel_traffic; delete missing.sources.link_audit_traffic;
  assert.equal(canSkipCollection(missing,{...options,analyticsProjects:[]}),false);
  const next=await refreshSources(missing,options);
  assert.equal(reads.events,40); assert.equal(reads.metadata,29);
  assert.deepEqual(next.snapshot.sources.diy_funnel,first.snapshot.sources.diy_funnel);
  assert.deepEqual(next.snapshot.sources.link_audit,first.snapshot.sources.link_audit);
});

test('core slot freshness uses the Traffic observation time, not equality with the original observation', () => {
  const snapshot=completedCore(); snapshot.sources.meta={...snapshot.sources.meta,status:'connected',observed_at:'2026-10-28T09:01:00.000Z'};
  snapshot.sources.meta_traffic={status:'connected',observed_at:'2026-10-28T09:02:00.000Z'};
  snapshot.sources.meta_crm={status:'connected',observed_at:'2026-10-28T09:03:00.000Z'};
  snapshot.sources.meta_lookalike={status:'connected',observed_at:'2026-10-28T09:04:00.000Z'};
  assert.equal(canSkipCollection(snapshot,{slot,now,metaEnabled:true,analyticsProjects:[]}),true);
  snapshot.sources.meta_traffic.observed_at='2026-10-28T08:59:59.000Z';
  assert.equal(canSkipCollection(snapshot,{slot,now,metaEnabled:true,analyticsProjects:[]}),false);
});

function videoDestination(id,contract) {
  const body=destination(id,contract), link=body.creative.object_story_spec.link_data.link;
  body.creative.object_story_spec={video_data:{call_to_action:{value:{link}}}};
  return body;
}

test('CRM and lookalike register only the final three IDs each, without the superseded CRM01 or wildcard selectors',()=>{
  assert.deepEqual(Object.keys(contracts.crm.ads),['120275505908750555','120275504866300555','120275504866310555']);
  assert.deepEqual(Object.keys(contracts.lookalike.ads),['120275504052480555','120275504962450555','120275504945410555']);
  for(const key of ['crm','lookalike']){
    assert.equal(contracts[key].account,'2128240694419507'); assert.equal(contracts[key].dataset,'1727278251668513');
    assert.equal(expectedTags('120275503974780555',{campaignKey:key}),null);
    assert.throws(()=>inspectAdDestination({id:'120275503974780555'},'120275503974780555',{campaignKey:key}),/SCOPE/);
  }
  for(const key of ['crm-other','lookalike-2','120275504052470555',{campaign:'120275503974760555'}]) assert.throws(()=>trackingContract(key),/SCOPE/);
});

test('each new video cohort completes exactly three scoped metadata GETs with its own ref and content prefix',async()=>{
  for(const key of ['crm','lookalike']){
    const contract=contracts[key],reads=[];
    const result=await collectLinkAudit({campaignKey:key,enabled:true,token:'fixture',now,fetcher:async(url,init)=>{
      const id=url.pathname.split('/').at(-1); assert.equal(init.method,'GET'); assert.equal(url.origin,'https://graph.facebook.com');
      assert(Object.hasOwn(contract.ads,id)); reads.push(id); return reply(videoDestination(id,contract));
    }});
    const source=mergeLinkAudit(null,result,{campaignKey:key});
    assert.deepEqual(reads,Object.keys(contract.ads)); assert.equal(source.checked_count,3); assert.equal(source.request_count,3); assert.equal(source.complete,true);
    assert(source.ads.every(row=>row.status==='valid'&&row.code.startsWith('VID-')));
    assert.equal(expectedTags(reads[0],{campaignKey:key}).utm_content[0],`${key==='crm'?'crm-direct-':'crm-lookalike-'}vid-01`);
    assert.throws(()=>validateLinkAudit(source,{campaignKey:key==='crm'?'lookalike':'crm'}),/INVALID_LINK/);
  }
});

test('shared VID-01 never permits a CRM/LAL mixed tuple, copied ref prefix, duplicate parameter or unresolved wrong macro',()=>{
  const crmId=Object.keys(contracts.crm.ads)[0],lalId=Object.keys(contracts.lookalike.ads)[0];
  const wrongTuple=videoDestination(crmId,contracts.crm); wrongTuple.adset_id=contracts.lookalike.adset;
  assert.equal(inspectAdDestination(wrongTuple,crmId,{campaignKey:'crm'}).scope_validated,false);
  const wrongRef=videoDestination(crmId,contracts.crm); wrongRef.creative.object_story_spec.video_data.call_to_action.value.link=`https://start.chatline.app/?skin=pilates&ref=${contracts.lookalike.refPrefix}vid-01`;
  assert.equal(inspectAdDestination(wrongRef,crmId,{campaignKey:'crm'}).status,'needs_review');
  const duplicate=videoDestination(lalId,contracts.lookalike); duplicate.creative.object_story_spec.video_data.call_to_action.value.link+='&ref=other';
  assert.equal(inspectAdDestination(duplicate,lalId,{campaignKey:'lookalike'}).status,'needs_review');
  const content=videoDestination(lalId,contracts.lookalike); content.creative.url_tags=content.creative.url_tags.replace('crm-lookalike-vid-01','crm-direct-vid-01');
  assert.equal(inspectAdDestination(content,lalId,{campaignKey:'lookalike'}).status,'needs_review');
  assert.throws(()=>inspectAdDestination(videoDestination(lalId,contracts.lookalike),lalId,{campaignKey:'crm'}),/SCOPE/);
});

test('same VID-01 aggregate rows remain separate by cohort with nullable omitted steps and no Meta backfill',async()=>{
  const sources={};
  for(const key of ['crm','lookalike']) sources[key]=await collectDiyFunnel({campaignKey:key,token:'fixture',now,fetcher:async url=>{
    const response=eventReply(url,{positive:true}),body=await response.json(); if(body.data.length)body.data[0].count=key==='crm'?3:11; return reply(body);
  }});
  assert(sources.crm.daily.every(row=>row.code==='VID-01'&&row.studio_started===3&&row.call_requested===null));
  assert(sources.lookalike.daily.every(row=>row.code==='VID-01'&&row.studio_started===11&&row.call_requested===null));
  const snapshot=structuredClone(original); snapshot.sources.diy_funnel_crm=sources.crm; snapshot.sources.diy_funnel_lookalike=sources.lookalike;
  validateSnapshot(snapshot); assert.deepEqual(snapshot.sources.meta,original.sources.meta); assert.equal(Object.hasOwn(snapshot.sources,'meta_crm'),false);
});

test('empty new-cohort reads stay awaiting_events and sparse confirmed zeros do not turn other steps into zeros',async()=>{
  for(const key of ['crm','lookalike']){
    const empty=await collectDiyFunnel({campaignKey:key,token:'fixture',now,fetcher:async url=>eventReply(url)});
    assert.equal(empty.status,'awaiting_events'); assert.deepEqual(empty.daily,[]);
    const sparse=await collectDiyFunnel({campaignKey:key,token:'fixture',now,fetcher:async url=>{
      const r=eventReply(url,{positive:true}),body=await r.json(); if(body.data.length){body.data[0].count=0;body.data[0].visitors=0;} return reply(body);
    }});
    assert(sparse.daily.every(row=>row.studio_started===0&&row.call_requested===null&&row.checkout_started===null&&row.dashboard_activated===null));
  }
});

test('new-cohort 403 failures preserve independent counts, periods and observation times instead of refreshing old success',async()=>{
  for(const key of ['crm','lookalike']){
    const previous=await collectDiyFunnel({campaignKey:key,token:'fixture',now,fetcher:async url=>eventReply(url,{positive:true})});
    await assert.rejects(collectDiyFunnel({campaignKey:key,token:'fixture',now:later,fetcher:async()=>({ok:false,status:403,json:async()=>{throw Error('private');}})}),/DIY_PERMISSION/);
    const failed=mergeDiyFunnel(previous,null,{campaignKey:key,now:later,error:'DIY_PERMISSION_REQUIRED'});
    assert.deepEqual(failed.daily,previous.daily); assert.deepEqual(failed.period,previous.period); assert.equal(failed.observed_at,previous.observed_at); assert.equal(failed.attempted_at,later.toISOString());
    const good=mergeLinkAudit(null,await collectLinkAudit({campaignKey:key,enabled:true,token:'fixture',now,fetcher:async url=>reply(videoDestination(url.pathname.split('/').at(-1),contracts[key]))}),{campaignKey:key});
    const bad=mergeLinkAudit(good,await collectLinkAudit({campaignKey:key,enabled:true,token:'fixture',now:later,fetcher:async()=>({ok:false,status:403,json:async()=>({error:{code:200}})})}),{campaignKey:key});
    assert.equal(bad.observed_at,good.observed_at); assert(bad.ads.every(row=>row.checked_at===now.toISOString()&&row.attempted_at===later.toISOString()));
  }
});

test('source validators reject wrong cohort bindings, swapped three-row audits, PII and unapproved performance sources',async()=>{
  const source=await collectDiyFunnel({campaignKey:'crm',token:'fixture',now,fetcher:async url=>eventReply(url,{positive:true})});
  assert.throws(()=>validateDiyFunnelSource(source,{campaignKey:'lookalike'}),/SOURCE_INVALID/);
  const snapshot=structuredClone(original); snapshot.sources.diy_funnel_lookalike=source; assert.throws(()=>validateSnapshot(snapshot),/SOURCE_INVALID/);
  const audit=mergeLinkAudit(null,await collectLinkAudit({campaignKey:'crm',enabled:true,token:'fixture',now,fetcher:async url=>reply(videoDestination(url.pathname.split('/').at(-1),contracts.crm))}),{campaignKey:'crm'});
  snapshot.sources={...original.sources,link_audit_lookalike:audit}; assert.throws(()=>validateSnapshot(snapshot),/INVALID_LINK/);
  snapshot.sources={...original.sources,diy_funnel_crm:{...source,email:'private@example.invalid'}}; assert.throws(()=>validateSnapshot(snapshot),/SNAPSHOT|DIY/);
  snapshot.sources={...original.sources,meta_crm:{status:'connected',observed_at:now.toISOString(),attempted_at:now.toISOString(),daily:[]}}; assert.throws(()=>validateSnapshot(snapshot),/SNAPSHOT/);
});

test('filling only a missing CRM source reads eight scoped event queries and three fixed ads without overwriting other cohorts',async()=>{
  const reads={events:[],ads:[]};
  const options={now,slot,diyFunnelEnabled:true,linkAuditEnabled:true,analyticsOptions:{tokens:{'start.chatline.app':'fixture'},fetcher:async url=>{reads.events.push(url.searchParams.get('filter'));return eventReply(url,{positive:true});}},
    metaOptions:{token:'fixture',version:'v26.0',fetcher:async url=>{const id=url.pathname.split('/').at(-1);reads.ads.push(id);const contract=Object.values(contracts).find(c=>Object.hasOwn(c.ads,id));return reply(destination(id,contract));}}};
  const first=await refreshSources(completedCore(),options), missing=structuredClone(first.snapshot);
  delete missing.sources.diy_funnel_crm; delete missing.sources.link_audit_crm; reads.events=[]; reads.ads=[];
  assert.equal(canSkipCollection(missing,{...options,analyticsProjects:[]}),false);
  const second=await refreshSources(missing,options);
  assert.equal(reads.events.length,8); assert(reads.events.every(filter=>filter.includes(contracts.crm.campaign))); assert.deepEqual(reads.ads,Object.keys(contracts.crm.ads));
  for(const key of ['meta','analytics','website_events','diy_funnel','link_audit','diy_funnel_traffic','link_audit_traffic','diy_funnel_lookalike','link_audit_lookalike'])assert.deepEqual(second.snapshot.sources[key],first.snapshot.sources[key]);
  assert.equal(canSkipCollection(second.snapshot,{...options,analyticsProjects:[]}),true); assert.equal(Object.hasOwn(second.snapshot.sources,'meta_lookalike'),false);
});
