import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TRAFFIC, TRAFFIC_AD_IDS } from '../public/assets/campaigns.js';
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
