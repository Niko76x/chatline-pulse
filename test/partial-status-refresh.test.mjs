import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SCOPE, AD_IDS, collectAds, refreshSources, validateSnapshot} from '../api/data.js';
import {TRAFFIC, TRAFFIC_AD_IDS, CRM, CRM_AD_IDS, LOOKALIKE, LOOKALIKE_AD_IDS} from '../public/assets/campaigns.js';

const now=new Date('2026-10-30T16:10:00.000Z');
const slot='2026-10-30T16:00:00.000Z';
const contracts=[{scope:SCOPE,ids:AD_IDS,key:'meta'},{scope:TRAFFIC,ids:TRAFFIC_AD_IDS,key:'meta_traffic'},
  {scope:CRM,ids:CRM_AD_IDS,key:'meta_crm'},{scope:LOOKALIKE,ids:LOOKALIKE_AD_IDS,key:'meta_lookalike'}];
const original=JSON.parse(await readFile(new URL('../public/data/fallback.json',import.meta.url),'utf8'));
const analyticsOptions={tokens:{'chatline.app':'fixture-main','start.chatline.app':'fixture-start'},fetcher:async url=>({ok:true,status:200,json:async()=>({version:1,query:{since:url.searchParams.get('since'),until:url.searchParams.get('until'),groupBy:['day'],filter:"environment eq 'production'"},data:[]})})};

function reader({missingKey,duplicateKey,foreignKey,invalidDateKey}={}){
  return async(path,params)=>{
    if(path===`act_${SCOPE.account}`) return {id:SCOPE.account,currency:'EUR',timezone_name:'Europe/Berlin'};
    const c=contracts.find(({scope:s})=>[s.campaign,s.adset,`${s.adset}/ads`,`${s.adset}/insights`].includes(path));
    assert(c,`Unexpected path ${path}`);
    const {scope:s,ids,key}=c;
    if(path===s.campaign) return {id:s.campaign,account_id:s.account,daily_budget:'2000',effective_status:'ACTIVE'};
    if(path===s.adset) return {id:s.adset,account_id:s.account,campaign_id:s.campaign,promoted_object:{pixel_id:s.dataset},effective_status:'ACTIVE'};
    if(path.endsWith('/ads')){
      const rows=Object.keys(ids).map(id=>({id,account_id:s.account,campaign_id:s.campaign,adset_id:s.adset,status:'ACTIVE',effective_status:'ACTIVE'}));
      if(key===missingKey) rows.shift();
      if(key===duplicateKey) rows.push({...rows[0]});
      if(key===foreignKey) rows[0].id='11111111';
      return rows;
    }
    // A missing metadata row still has real historical performance.
    const date=key===invalidDateKey?'2026-10-99':'2026-10-30';
    return [{account_id:s.account,campaign_id:s.campaign,adset_id:s.adset,
      ...(params.level==='ad'?{ad_id:Object.keys(ids)[0]}:{}),date_start:date,date_stop:date,
      spend:'10',impressions:'100',reach:'80',inline_link_clicks:'5'}];
  };
}

test('omitted known status preserves insights and is explicitly unknown for every reviewed cohort',async()=>{
  for(const {scope,ids,key} of contracts){
    const result=await collectAds(reader({missingKey:key}),now,scope);
    assert.equal(result.ads_daily[0].spend,10);
    assert.equal(result.statuses.length,Object.keys(ids).length);
    assert.deepEqual(result.statuses.find(row=>row.code===Object.values(ids)[0]),
      {code:Object.values(ids)[0],status:'UNKNOWN',delivery:'UNKNOWN'});
    assert(result.statuses.filter(row=>row.status==='ACTIVE').length===Object.keys(ids).length-1);
  }
});

test('duplicate and foreign status rows are rejected instead of being silently filtered',async()=>{
  for(const {scope,key} of contracts){
    await assert.rejects(collectAds(reader({duplicateKey:key}),now,scope),/META_INVALID_RESPONSE/);
    await assert.rejects(collectAds(reader({foreignKey:key}),now,scope),/SCOPE_MISMATCH/);
  }
});

const metaOptions=options=>({token:'fixture',version:'v99.0',fetcher:async(url)=>{
  const params=Object.fromEntries(url.searchParams);
  const body=await reader(options)(url.pathname.replace(/^\/v99\.0\//,''),params);
  return {ok:true,status:200,json:async()=>Array.isArray(body)?{data:body}:body};
}});

test('a partial status response no longer aborts the whole snapshot refresh',async()=>{
  const result=await refreshSources(original,{now,slot,metaEnabled:true,analyticsOptions,metaOptions:metaOptions({missingKey:'meta_traffic'})});
  assert.equal(result.success,true,JSON.stringify(Object.fromEntries(contracts.map(({key})=>[key,result.snapshot.sources[key]?.error]))));
  for(const {key} of contracts) assert.equal(result.snapshot.sources[key].observed_at,now.toISOString());
  assert.equal(result.snapshot.sources.meta_traffic.statuses.find(row=>row.code==='PIL-PA-01').delivery,'UNKNOWN');
  validateSnapshot(result.snapshot);
});

test('a malformed cohort preserves its previous data while other campaigns publish fresh observations',async()=>{
  const previous=structuredClone(original);
  const first=await refreshSources(previous,{now,slot,metaEnabled:true,analyticsOptions,metaOptions:metaOptions({})});
  const later=new Date('2026-10-30T16:40:00.000Z');
  const result=await refreshSources(first.snapshot,{now:later,slot:'2026-10-30T16:30:00.000Z',metaEnabled:true,analyticsOptions,
    metaOptions:metaOptions({invalidDateKey:'meta_crm'})});
  assert.equal(result.success,false);
  assert.equal(result.snapshot.sources.meta_crm.status,'error');
  assert.equal(result.snapshot.sources.meta_crm.observed_at,now.toISOString());
  assert.equal(result.snapshot.sources.meta_crm.attempted_at,later.toISOString());
  assert.deepEqual(result.snapshot.sources.meta_crm.daily,first.snapshot.sources.meta_crm.daily);
  for(const key of ['meta','meta_traffic','meta_lookalike']) assert.equal(result.snapshot.sources[key].observed_at,later.toISOString());
  validateSnapshot(result.snapshot);
});
