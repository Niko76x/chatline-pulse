import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { trackingContract } from '../lib/tracking-contracts.mjs';
import { collectDiyFunnel, mergeDiyFunnel, validateDiyFunnelSource } from '../lib/diy-funnel.mjs';
import { collectLinkAudit, mergeLinkAudit, validateLinkAudit } from '../lib/link-audit.js';
import { expectedTags, inspectAdDestination } from '../scripts/meta-destination-preflight.mjs';
import { validateSnapshot, mergeAnalytics, refreshSources, canSkipCollection, ANALYTICS_PROJECTS } from '../api/data.js';

const traffic = trackingContract('traffic'), originalContract = trackingContract();
const trafficIds = Object.keys(traffic.ads), originalIds = Object.keys(originalContract.ads);
const now = new Date('2026-10-28T09:07:00.000Z'), slot = '2026-10-28T09:00:00.000Z';
const later = new Date('2026-10-28T09:37:00.000Z');
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
const reply = value => ({ ok: true, status: 200, json: async () => value });
function destination(id, contract = traffic) {
  const campaignKey = contract === traffic ? 'traffic' : 'original';
  const url = `https://start.chatline.app/?skin=pilates&ref=${contract.refPrefix}${contract.ads[id].toLowerCase()}`;
  const tags = new URLSearchParams(Object.fromEntries(Object.entries(expectedTags(id, { campaignKey })).map(([key,values]) => [key,values[0]])));
  return { id, account_id: contract.account, campaign_id: contract.campaign, adset_id: contract.adset,
    creative: { object_story_spec: { link_data: { link: url } }, url_tags: tags.toString() } };
}
function eventReply(url, { positive = false, wrong = false } = {}) {
  const params = url.searchParams, filter = params.get('filter');
  const contract = filter.includes(traffic.campaign) ? traffic : originalContract;
  const id = wrong ? originalIds[0] : Object.keys(contract.ads)[0];
  return reply({ version: 1, query: { since: Number(params.get('since')), until: Number(params.get('until')), filter,
    groupBy: ['eventData/ad_id'], limit: 32 },
    data: positive && filter.includes("eventName eq 'diy_studio_started'") ? [{ eventData: id, count: contract === traffic ? 7 : 2, visitors: 1 }] : [] });
}
function completedCore() {
  return mergeAnalytics(original, ANALYTICS_PROJECTS.map(project => ({ site: project.site, label: project.label,
    status: 'connected', observed_at: now.toISOString(), attempted_at: now.toISOString(), error: null, timezone: 'UTC', daily: [] })), { now, slot });
}

test('tracking selectors are closed to the exact original13 and traffic5, with CRM drafts inactive', () => {
  assert.equal(originalIds.length,13); assert.equal(trafficIds.length,5);
  assert.equal(traffic.ads[trafficIds[0]],originalContract.ads[originalIds[0]]);
  for(const key of ['crm','lookalike','120275503974760555',{},null,'other-account'])
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

test('refresh gates isolate both campaign slots and never re-read original13 to fill missing Traffic sources', async () => {
  const previous=completedCore(), reads={events:0,metadata:0};
  const options={now,slot,diyFunnelEnabled:true,linkAuditEnabled:true,
    analyticsOptions:{tokens:{'start.chatline.app':'fixture'},fetcher:async(url,init)=>{assert.equal(init.method,'GET'); reads.events++;return eventReply(url,{positive:true});}},
    metaOptions:{token:'fixture',version:'v26.0',fetcher:async(url,init)=>{assert.equal(init.method,'GET');reads.metadata++;const id=url.pathname.split('/').at(-1);return reply(destination(id,trafficIds.includes(id)?traffic:originalContract));}}};
  const first=await refreshSources(previous,options);
  assert.equal(reads.events,16); assert.equal(reads.metadata,18); assert.equal(first.success,true);
  assert(first.snapshot.sources.diy_funnel.daily.every(row=>row.studio_started===2));
  assert(first.snapshot.sources.diy_funnel_traffic.daily.every(row=>row.studio_started===7));
  assert.equal(canSkipCollection(first.snapshot,{...options,analyticsProjects:[]}),true);
  const missing=structuredClone(first.snapshot); delete missing.sources.diy_funnel_traffic; delete missing.sources.link_audit_traffic;
  assert.equal(canSkipCollection(missing,{...options,analyticsProjects:[]}),false);
  const next=await refreshSources(missing,options);
  assert.equal(reads.events,24); assert.equal(reads.metadata,23);
  assert.deepEqual(next.snapshot.sources.diy_funnel,first.snapshot.sources.diy_funnel);
  assert.deepEqual(next.snapshot.sources.link_audit,first.snapshot.sources.link_audit);
});

test('core slot freshness uses the Traffic observation time, not equality with the original observation', () => {
  const snapshot=completedCore(); snapshot.sources.meta={...snapshot.sources.meta,status:'connected',observed_at:'2026-10-28T09:01:00.000Z'};
  snapshot.sources.meta_traffic={status:'connected',observed_at:'2026-10-28T09:02:00.000Z'};
  assert.equal(canSkipCollection(snapshot,{slot,now,metaEnabled:true,analyticsProjects:[]}),true);
  snapshot.sources.meta_traffic.observed_at='2026-10-28T08:59:59.000Z';
  assert.equal(canSkipCollection(snapshot,{slot,now,metaEnabled:true,analyticsProjects:[]}),false);
});
