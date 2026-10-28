import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TRAFFIC, TRAFFIC_AD_IDS } from '../public/assets/campaigns.js';
import { CRM, CRM_AD_IDS, LOOKALIKE, LOOKALIKE_AD_IDS } from '../public/assets/campaigns.js';
import { createMetaReader } from '../api/data.js';
import { SCOPE, collectAds, normalizeInsight, validateSnapshot, refreshSources } from '../api/data.js';
const old = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-27T12:00:00Z');
const row = {account_id:TRAFFIC.account,campaign_id:TRAFFIC.campaign,adset_id:TRAFFIC.adset,ad_id:Object.keys(TRAFFIC_AD_IDS)[0],date_start:'2026-10-27',date_stop:'2026-10-27',spend:'5',impressions:'100',reach:'80',inline_link_clicks:'10'};
function source() { return {campaign:TRAFFIC.campaign,adset:TRAFFIC.adset,timezone:'Europe/Berlin',status:'connected',observed_at:now.toISOString(),attempted_at:now.toISOString(),daily:[normalizeInsight(row,false,TRAFFIC,TRAFFIC_AD_IDS)],ads_daily:[normalizeInsight(row,true,TRAFFIC,TRAFFIC_AD_IDS)],statuses:Object.values(TRAFFIC_AD_IDS).map(code=>({code,status:'ACTIVE',delivery:'ACTIVE'}))}; }
test('traffic identity cannot be passed off as original or moved across campaigns',()=>{
 assert.throws(()=>normalizeInsight(row,true),/SCOPE_MISMATCH/);
 assert.equal(normalizeInsight(row,true,TRAFFIC,TRAFFIC_AD_IDS).code,'PIL-PA-01');
 for (const override of [{account_id:'111'},{campaign_id:SCOPE.campaign},{adset_id:SCOPE.adset},{ad_id:'120275421779180555'}]) assert.throws(()=>normalizeInsight({...row,...override},true,TRAFFIC,TRAFFIC_AD_IDS),/SCOPE_MISMATCH/);
 const snapshot=structuredClone(old);snapshot.sources.meta_traffic=source();validateSnapshot(snapshot);
 snapshot.sources.meta_traffic.campaign=SCOPE.campaign;assert.throws(()=>validateSnapshot(snapshot),/SCOPE_MISMATCH/);
});
test('traffic collector reads only its own fixed campaign and adset and permits link-click optimization without a promoted pixel',async()=>{
 const calls=[];
 const result=await collectAds(async(path,params)=>{
  calls.push(path);
  if(path.startsWith('act_'))return {id:TRAFFIC.account,currency:'EUR',timezone_name:'Europe/Berlin'};
  if(path===TRAFFIC.adset)return {id:TRAFFIC.adset,account_id:TRAFFIC.account,campaign_id:TRAFFIC.campaign,effective_status:'ACTIVE'};
  if(path===TRAFFIC.campaign)return {id:TRAFFIC.campaign,account_id:TRAFFIC.account,daily_budget:'3000'};
  if(path.endsWith('/ads'))return Object.entries(TRAFFIC_AD_IDS).map(([id])=>({id,account_id:TRAFFIC.account,campaign_id:TRAFFIC.campaign,adset_id:TRAFFIC.adset,status:'ACTIVE',effective_status:'ACTIVE'}));
  assert.equal(path,`${TRAFFIC.adset}/insights`);return [row];
 },now,TRAFFIC);
 assert.equal(result.campaign,TRAFFIC.campaign);assert.equal(result.statuses.length,5);assert.equal(result.daily[0].studio_tests,null);
 assert.equal(calls.some(p=>p.includes(SCOPE.adset)),false);
});
test('traffic failure preserves traffic observations and original data when source collection is disabled for the original CSV',async()=>{
 const snapshot=structuredClone(old);snapshot.sources.meta_traffic=source();
 const before=structuredClone(snapshot.sources.meta_traffic);
 const result=await refreshSources(snapshot,{now,metaEnabled:true,metaOptions:{token:'fixture',version:'v99.0',fetcher:async()=>({ok:false,status:403,json:async()=>({error:{code:190}})})}});
 assert.equal(result.success,false);assert.equal(result.snapshot.sources.meta_traffic.status,'error');
 assert.equal(result.snapshot.sources.meta_traffic.observed_at,before.observed_at);assert.deepEqual(result.snapshot.sources.meta_traffic.daily,before.daily);
});

test('daily budget uses campaign budget first, otherwise the scoped adset, never an invented zero',async()=>{
 for(const [campaignBudget,adsetBudget,expected] of [[undefined,'2000',20],['0','2000',20],['3000','2000',30],[undefined,undefined,null]]){
  const result=await collectAds(async(path,params)=>{
   if(path.startsWith('act_'))return {id:TRAFFIC.account,currency:'EUR',timezone_name:'Europe/Berlin'};
   if(path===TRAFFIC.adset){assert.match(params.fields,/daily_budget/);return {id:TRAFFIC.adset,account_id:TRAFFIC.account,campaign_id:TRAFFIC.campaign,effective_status:'ACTIVE',daily_budget:adsetBudget};}
   if(path===TRAFFIC.campaign)return {id:TRAFFIC.campaign,account_id:TRAFFIC.account,daily_budget:campaignBudget};
   if(path.endsWith('/ads'))return Object.keys(TRAFFIC_AD_IDS).map(id=>({id,account_id:TRAFFIC.account,campaign_id:TRAFFIC.campaign,adset_id:TRAFFIC.adset,status:'ACTIVE',effective_status:'ACTIVE'}));
   assert.equal(path,TRAFFIC.adset+'/insights');return [row];
  },now,TRAFFIC);assert.equal(result.budget_daily,expected);
 }
});

const launchNow=new Date('2026-10-28T13:07:00.000Z'),launchSlot='2026-10-28T13:00:00.000Z';
const cohorts=[[CRM,CRM_AD_IDS,'meta_crm'],[LOOKALIKE,LOOKALIKE_AD_IDS,'meta_lookalike']];
function newRow(scope,ids){return {...row,account_id:scope.account,campaign_id:scope.campaign,adset_id:scope.adset,ad_id:Object.keys(ids)[0],date_start:'2026-10-28',date_stop:'2026-10-28',spend:scope===CRM?'0.8':'1.1'};}
function newSource(scope,ids){return {campaign:scope.campaign,adset:scope.adset,timezone:'Europe/Berlin',status:'connected',observed_at:launchNow.toISOString(),attempted_at:launchNow.toISOString(),period:{from:'2026-10-28',to:'2026-10-28'},complete_test_window:false,delivery:'ACTIVE',budget_daily:scope===CRM?2:13,daily:[normalizeInsight(newRow(scope,ids),false,scope,ids)],ads_daily:[normalizeInsight(newRow(scope,ids),true,scope,ids)],statuses:Object.values(ids).map(code=>({code,status:'ACTIVE',delivery:'IN_PROCESS'}))};}
function protect(source){return {...source,method:'csv',manual_update:{edition_label:'Tagesupdate 28.10.2026, 13:00',exported_at:'2026-10-28T12:00:00.000Z',imported_at:'2026-10-28T12:01:00.000Z',valid_until:'2026-10-28T23:00:00.000Z',attribution_setting:'7-day click or 1-day view',reporting_basis:'ads_manager_export',timezone:'Europe/Berlin'}};}
function protectedLegacy(){const snapshot=structuredClone(old);snapshot.sources.meta=protect({...snapshot.sources.meta,timezone:'Europe/Berlin'});snapshot.sources.meta_traffic=protect({...newSource(TRAFFIC,TRAFFIC_AD_IDS)});return snapshot;}
function cohortRead(calls,{empty=false,wrongPixel=false,unknown=false}={}){return async(path,params)=>{
 calls.push(path);if(path.startsWith('act_'))return {id:CRM.account,currency:'EUR',timezone_name:'Europe/Berlin'};
 const scope=cohorts.map(c=>c[0]).find(c=>path===c.campaign||path===c.adset||path.startsWith(c.adset+'/'));assert(scope,'No legacy or foreign reads');
 const ids=scope===CRM?CRM_AD_IDS:LOOKALIKE_AD_IDS;
 if(path===scope.adset)return {id:scope.adset,account_id:scope.account,campaign_id:scope.campaign,effective_status:'ACTIVE',daily_budget:scope===CRM?'200':'1300',promoted_object:{pixel_id:wrongPixel?'111':CRM.dataset}};
 if(path===scope.campaign)return {id:scope.campaign,account_id:scope.account,effective_status:'ACTIVE'};
 if(path.endsWith('/ads'))return Object.keys(ids).map(id=>({id:unknown?'120275503974780555':id,account_id:scope.account,campaign_id:scope.campaign,adset_id:scope.adset,status:'ACTIVE',effective_status:'IN_PROCESS'}));
 assert.equal(params.time_range.since,'2026-10-28');assert.equal(params.time_range.until,'2026-10-28');return empty?[]:[newRow(scope,ids)];
};}
function graphFetcher(read){return async url=>({ok:true,json:async()=>{const path=url.pathname.split('/').slice(2).join('/'),params=Object.fromEntries(url.searchParams);if(params.time_range)params.time_range=JSON.parse(params.time_range);const value=await read(path,params);return Array.isArray(value)?{data:value}:value;}});}
const analyticsReady={tokens:{'chatline.app':'fixture','start.chatline.app':'fixture'},fetcher:async url=>({ok:true,json:async()=>({version:1,query:{since:url.searchParams.get('since'),until:url.searchParams.get('until'),groupBy:['day'],filter:"environment eq 'production'"},data:[]})})};

test('CRM and LAL performance collectors use exact three-ad scopes, launch-day windows and required dataset',async()=>{
 for(const [scope,ids] of cohorts){const calls=[],result=await collectAds(cohortRead(calls),launchNow,scope);assert.equal(result.campaign,scope.campaign);assert.equal(result.statuses.length,3);assert.equal(result.budget_daily,scope===CRM?2:13);assert.equal(result.daily[0].studio_tests,null);assert(calls.every(p=>p===`act_${scope.account}`||p===scope.campaign||p===scope.adset||p.startsWith(scope.adset+'/')));await assert.rejects(collectAds(cohortRead([],{wrongPixel:true}),launchNow,scope),/DATASET_MISMATCH/);}
});
test('CRM/LAL reader rejects foreign paths and scopes, mixed IDs and the retired CRM01',async()=>{
 const read=createMetaReader({token:'fixture',version:'v26.0',fetcher:async()=>{throw Error('No remote call');}});
 await assert.rejects(read('act_111'),/PATH_NOT_ALLOWED/);await assert.rejects(read('120275499484600555/insights'),/PATH_NOT_ALLOWED/);
 for(const [scope,ids] of cohorts){assert.throws(()=>normalizeInsight({...newRow(scope,ids),ad_id:'120275503974780555'},true,scope,ids),/SCOPE/);assert.throws(()=>normalizeInsight({...newRow(scope,ids),account_id:'111'},true,scope,ids),/SCOPE/);await assert.rejects(collectAds(cohortRead([],{unknown:true}),launchNow,scope),/SCOPE|META_RETIRED_AD_ACTIVE/);}
 await assert.rejects(collectAds(cohortRead([]),launchNow,{...CRM}),/SCOPE/);
});
test('empty genuine CRM/LAL insight arrays stay empty, with no manufactured zeros or complete-window claim',async()=>{
 const previous=protectedLegacy(),result=await refreshSources(previous,{now:launchNow,slot:launchSlot,metaEnabled:true,analyticsOptions:analyticsReady,metaOptions:{token:'fixture',version:'v26.0',fetcher:graphFetcher(cohortRead([],{empty:true}))}});
 assert.equal(result.success,true);for(const key of ['meta_crm','meta_lookalike']){assert.deepEqual(result.snapshot.sources[key].daily,[]);assert.deepEqual(result.snapshot.sources[key].ads_daily,[]);assert.equal(result.snapshot.sources[key].complete_test_window,false);assert.equal(result.snapshot.sources[key].observed_at,launchNow.toISOString());}
 assert.deepEqual(result.snapshot.sources.meta,previous.sources.meta);assert.deepEqual(result.snapshot.sources.meta_traffic,previous.sources.meta_traffic);
});
test('CRM/LAL source validators reject swapped tuples, unknown codes, invalid dates, missing metrics and false completeness',()=>{
 const value=protectedLegacy();for(const [scope,ids,key] of cohorts)value.sources[key]=newSource(scope,ids);validateSnapshot(value);
 for(const mutate of [s=>s.sources.meta_crm.adset=LOOKALIKE.adset,s=>s.sources.meta_crm.ads_daily[0].code='PIL-PA-01',s=>s.sources.meta_crm.period.from='2026-10-27',s=>s.sources.meta_crm.daily[0].date='2026-02-30',s=>delete s.sources.meta_crm.daily[0].spend,s=>{s.sources.meta_crm.period.to='2026-10-29';s.sources.meta_crm.complete_test_window=true;},s=>s.sources.meta_crm.daily.push(s.sources.meta_crm.daily[0]),s=>s.sources.meta_crm.email='private@example.invalid']){const bad=structuredClone(value);mutate(bad);assert.throws(()=>validateSnapshot(bad),/SNAPSHOT/);}
});
test('a failed new-cohort read keeps old counts and observation clocks; first failure remains null and empty',async()=>{
 const previous=protectedLegacy();for(const [scope,ids,key] of cohorts)previous.sources[key]=newSource(scope,ids);
 const later=new Date('2026-10-28T14:07:00.000Z'),options={now:later,slot:'2026-10-28T14:00:00.000Z',metaEnabled:true,metaOptions:{token:'fixture',version:'v26.0',fetcher:async()=>({ok:false,status:403,json:async()=>({error:{code:190}})})}};
 const result=await refreshSources(previous,options);assert.equal(result.success,false);
 for(const [, ,key] of cohorts){assert.deepEqual(result.snapshot.sources[key].daily,previous.sources[key].daily);assert.equal(result.snapshot.sources[key].observed_at,previous.sources[key].observed_at);assert.equal(result.snapshot.sources[key].attempted_at,later.toISOString());assert.equal(result.snapshot.sources[key].error,'META_LOGIN_REQUIRED');}
 const first=await refreshSources(protectedLegacy(),options);for(const [, ,key] of cohorts){assert.equal(first.snapshot.sources[key].observed_at,null);assert.equal(first.snapshot.sources[key].period,null);assert.deepEqual(first.snapshot.sources[key].daily,[]);}
});
test('a protected CRM CSV is preserved independently while LAL refreshes through the existing reader',async()=>{
 const previous=protectedLegacy();previous.sources.meta_crm=protect(newSource(CRM,CRM_AD_IDS));const calls=[];
 const result=await refreshSources(previous,{now:launchNow,slot:launchSlot,metaEnabled:true,analyticsOptions:analyticsReady,metaOptions:{token:'fixture',version:'v26.0',fetcher:graphFetcher(cohortRead(calls))}});
 assert.equal(result.success,true);assert.deepEqual(result.snapshot.sources.meta_crm,previous.sources.meta_crm);assert(calls.every(path=>path!==CRM.adset&&path!==CRM.campaign&&!path.startsWith(CRM.adset+'/')));assert.equal(result.snapshot.sources.meta_lookalike.daily[0].spend,1.1);
});
test('same-slot new-cohort reads are not repeated and a missing cohort never reuses another VID-01 source',async()=>{
 const calls=[],options={now:launchNow,slot:launchSlot,metaEnabled:true,analyticsOptions:analyticsReady,metaOptions:{token:'fixture',version:'v26.0',fetcher:graphFetcher(cohortRead(calls))}};
 const first=await refreshSources(protectedLegacy(),options);assert.equal(first.snapshot.sources.meta_crm.daily[0].spend,0.8);assert.equal(first.snapshot.sources.meta_lookalike.daily[0].spend,1.1);
 calls.length=0;await refreshSources(first.snapshot,options);assert.equal(calls.length,0);
 const missing=structuredClone(first.snapshot);delete missing.sources.meta_lookalike;const next=await refreshSources(missing,options);assert.deepEqual(next.snapshot.sources.meta_crm,first.snapshot.sources.meta_crm);assert(calls.every(path=>path!==CRM.adset&&path!==CRM.campaign&&!path.startsWith(CRM.adset+'/')));
});
test('disabled Meta reporting neither queries nor creates CRM/LAL performance sources',async()=>{
 let reads=0;const result=await refreshSources(old,{now:launchNow,metaEnabled:false,analyticsOptions:{tokens:{'start.chatline.app':'fixture'},fetcher:async()=>({ok:true,json:async()=>({version:1,query:{since:'2026-10-22',until:'2026-10-28',groupBy:['day'],filter:"environment eq 'production'"},data:[]})})},metaOptions:{token:'fixture',version:'v26.0',fetcher:async()=>{reads++;throw Error('Forbidden');}}});
 assert.equal(reads,0);assert.equal(Object.hasOwn(result.snapshot.sources,'meta_crm'),false);assert.equal(Object.hasOwn(result.snapshot.sources,'meta_lookalike'),false);
});

function readWithRetired({status='PAUSED',effective='PAUSED',parents={},otherId=null,oldInsight=false,totalExtra=false}={}){
 const reader=cohortRead([]);
 return async(path,params)=>{
  const value=await reader(path,params);
  if(path===CRM.adset+'/ads')return [...value,{id:otherId||'120275503974780555',account_id:CRM.account,campaign_id:CRM.campaign,adset_id:CRM.adset,status,effective_status:effective,...parents}];
  if(path===CRM.adset+'/insights'&&params.level==='ad'&&oldInsight)return [...value,{...newRow(CRM,CRM_AD_IDS),ad_id:'120275503974780555',spend:'0.2'}];
  if(path===CRM.adset+'/insights'&&params.level==='adset'&&totalExtra)return value.map(row=>({...row,spend:'1.0'}));
  return value;
 };
}
test('the single documented retired CRM01 is excluded only after verified parents and explicit OFF state',async()=>{
 const source=await collectAds(readWithRetired(),launchNow,CRM);assert.equal(source.statuses.length,3);assert(source.statuses.every(row=>Object.values(CRM_AD_IDS).includes(row.code)));assert.equal(source.daily[0].spend,0.8);
});
test('retired CRM01 with foreign account or parents remains rejected',async()=>{
 for(const parents of [{account_id:'111'},{campaign_id:LOOKALIKE.campaign},{adset_id:LOOKALIKE.adset}])await assert.rejects(collectAds(readWithRetired({parents}),launchNow,CRM),/SCOPE_MISMATCH/);
});
test('an active retired CRM01 or contradictory active effective state remains an explicit reporting error',async()=>{
 for(const state of [{status:'ACTIVE',effective:'ACTIVE'},{status:'PAUSED',effective:'ACTIVE'}])await assert.rejects(collectAds(readWithRetired(state),launchNow,CRM),/META_RETIRED_AD_ACTIVE/);
});
test('the retired-ID exception never admits another unknown paused ad',async()=>{
 await assert.rejects(collectAds(readWithRetired({otherId:'120275503974780999'}),launchNow,CRM),/SCOPE_MISMATCH/);
});
test('retired CRM01 insight rows are never silently included or subtracted from the final three',async()=>{
 await assert.rejects(collectAds(readWithRetired({oldInsight:true}),launchNow,CRM),/META_RETIRED_AD_INSIGHTS/);
});
test('a retired OFF ad cannot conceal extra adset cost beyond the final three reported ads',async()=>{
 await assert.rejects(collectAds(readWithRetired({totalExtra:true}),launchNow,CRM),/META_RETIRED_TOTALS_UNVERIFIED/);
});
