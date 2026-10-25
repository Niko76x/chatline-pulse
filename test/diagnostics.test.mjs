import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_PROJECTS } from '../api/data.js';
import { createAnalyticsDiagnosticFetcher } from '../api/data.js';
const privateValue = 'NEVER_LOG_THIS_PRIVATE_VALUE';
const url = site => 'https://api.vercel.com/v1/query/web-analytics/visits/aggregate?projectId=' + ANALYTICS_PROJECTS.find(p => p.site === site).projectId;
test('diagnostics are disabled by default and return the original fetcher without logging', async () => {
  const logs=[];const response=new Response('{}');const fetcher=async()=>response;
  const wrapped=createAnalyticsDiagnosticFetcher({fetcher,logger:line=>logs.push(line)});
  assert.equal(wrapped,fetcher);assert.equal(await wrapped(url('chatline.app')),response);assert.deepEqual(logs,[]);
});
test('enabled diagnostics keep the original response unread and log only safe aggregate structure', async () => {
  const logs=[];
  const payload={version:'1',query:{since:'2026-10-22',until:'2026-10-26T00:00:00.000Z',groupBy:['day',privateValue],filter:"environment eq 'production'",requestPath:privateValue},data:[{
    timestamp:'2026-10-25T00:00:00Z',pageviews:7,visitors:3,
    metrics:{pageviews:privateValue,count:4,userId:privateValue},userId:privateValue,visitorId:privateValue,referrerHostname:privateValue,requestPath:privateValue,
  }],error:{code:'bad_request',message:privateValue},[privateValue]:privateValue};
  const response=new Response(JSON.stringify(payload),{status:200,headers:{'X-Private-Header':privateValue}});
  const wrapped=createAnalyticsDiagnosticFetcher({enabled:true,fetcher:async(input,options)=>{assert.equal(options.headers.Authorization,'Bearer '+privateValue);return response;},logger:line=>logs.push(line)});
  const result=await wrapped(url('chatline.app')+'&private='+privateValue,{headers:{Authorization:'Bearer '+privateValue}});
  assert.equal(result,response);assert.equal(result.bodyUsed,false);assert.equal(logs.length,1);
  const text=logs[0];
  for(const forbidden of [privateValue,'Authorization','Bearer','https://','userId','visitorId','referrerHostname','requestPath','X-Private-Header','message'])assert.equal(text.includes(forbidden),false,forbidden+' must not appear');
  const safe=JSON.parse(text.slice('PULSE_ANALYTICS_DIAGNOSTIC '.length));
  assert.equal(safe.project,'chatline-website');assert.equal(safe.http_status,200);assert.equal(safe.version.value,'1');
  assert.equal(safe.query.until.utc,'2026-10-26T00:00:00.000Z');assert.deepEqual(safe.query.group_by.values,['day']);
  assert.equal(safe.data.sample[0].fields.pageviews.number,7);assert.equal(safe.data.sample[0].fields.metrics.fields.pageviews.type,'string');
  assert.deepEqual(await result.json(),payload);
});
test('HTTP failure diagnostics expose only the status and a whitelisted static error code', async () => {
  for(const [code,expected]of[['project_not_found','project_not_found'],[privateValue,undefined]]){
    const logs=[],response=new Response(JSON.stringify({error:{code,message:privateValue}}),{status:404});
    const wrapped=createAnalyticsDiagnosticFetcher({enabled:true,fetcher:async()=>response,logger:line=>logs.push(line)});
    assert.equal(await wrapped(url('start.chatline.app')),response);
    const safe=JSON.parse(logs[0].slice('PULSE_ANALYTICS_DIAGNOSTIC '.length));
    assert.equal(safe.project,'limitless');assert.equal(safe.http_status,404);assert.equal(safe.error_code,expected);assert.equal(logs[0].includes(privateValue),false);
  }
});
test('non-JSON responses and logger failures cannot consume, replace or change the original response', async () => {
  const logs=[],response=new Response(privateValue,{status:400});
  const wrapped=createAnalyticsDiagnosticFetcher({enabled:true,fetcher:async()=>response,logger:line=>logs.push(line)});
  assert.equal(await wrapped(url('start.chatline.app')),response);assert.equal(response.bodyUsed,false);assert.equal(logs[0].includes(privateValue),false);
  const failing=createAnalyticsDiagnosticFetcher({enabled:true,fetcher:async()=>response,logger:()=>{throw new Error(privateValue);}});
  assert.equal(await failing(url('start.chatline.app')),response);assert.equal(await response.text(),privateValue);
});
test('unknown requests generate no diagnostics and samples/field names stay bounded', async () => {
  const logs=[];
  const payload={version:1,query:{since:privateValue,until:privateValue,groupBy:[privateValue]},data:Array.from({length:50},()=>({pageviews:1,visitors:1,[privateValue]:privateValue}))};
  const wrapped=createAnalyticsDiagnosticFetcher({enabled:true,fetcher:async()=>new Response(JSON.stringify(payload)),logger:line=>logs.push(line)});
  await wrapped('https://other.invalid/'+privateValue);assert.equal(logs.length,0);
  await wrapped(url('chatline.app'));const safe=JSON.parse(logs[0].slice('PULSE_ANALYTICS_DIAGNOSTIC '.length));
  assert.equal(safe.data.length,50);assert.equal(safe.data.sample.length,2);assert.ok(safe.root_keys.length<=20);assert.ok(safe.data.sample.every(row=>row.keys.length<=20));assert.equal(logs[0].includes(privateValue),false);
});
test('nested aggregate metric structure is visible without copying arbitrary text values', async () => {
  const logs=[],payload={version:1,query:{since:'2026-10-22',until:'2026-10-26',groupBy:['day']},data:{pageviews:[{timestamp:'2026-10-25T00:00:00Z',value:4,name:privateValue}],metrics:{visitors:{value:2,name:'visitors',key:privateValue}}}};
  const wrapped=createAnalyticsDiagnosticFetcher({enabled:true,fetcher:async()=>new Response(JSON.stringify(payload)),logger:line=>logs.push(line)});
  await wrapped(url('chatline.app'));const safe=JSON.parse(logs[0].slice('PULSE_ANALYTICS_DIAGNOSTIC '.length));
  assert.equal(safe.data.fields.pageviews.type,'array');assert.equal(safe.data.fields.pageviews.sample[0].fields.value.number,4);
  assert.equal(safe.data.fields.metrics.fields.visitors.fields.value.number,2);assert.equal(logs[0].includes(privateValue),false);
});
