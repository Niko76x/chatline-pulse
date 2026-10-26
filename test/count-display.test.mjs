import test from 'node:test';
import assert from 'node:assert/strict';
import { reportedCount } from '../public/assets/count-display.js';
import { summarize } from '../public/assets/model.js';

test('positive known subsets are lower bounds with reported-day coverage, not totals', () => {
  const rows=[{landing_page_views:2},{landing_page_views:null},{landing_page_views:1},{landing_page_views:undefined}];
  const before=structuredClone(rows);
  assert.deepEqual(reportedCount(rows,'landing_page_views'),{value:3,minimum:true,partial:true,known_days:2,reported_days:4});
  assert.equal(summarize(rows).landing_page_views,null);
  assert.deepEqual(rows,before);
});
test('zero plus unknown, all unknown and absent rows never become a measured zero', () => {
  for(const rows of [[{studio_tests:0},{studio_tests:null}],[{studio_tests:null}],[{}],[]]) {
    const result=reportedCount(rows,'studio_tests'); assert.equal(result.value,null); assert.equal(result.minimum,false);
  }
});
test('complete measurements retain exact zero or counts, with no lower-bound label', () => {
  assert.deepEqual(reportedCount([{studio_tests:0},{studio_tests:0}],'studio_tests'),{value:0,minimum:false,partial:false,known_days:2,reported_days:2});
  assert.equal(reportedCount([{link_clicks:2},{link_clicks:3}],'link_clicks').value,5);
  assert.equal(reportedCount([{call_requests:1}],'call_requests').minimum,false);
});
test('the display helper cannot add reach, unique visitors, money or computed rates', () => {
  for(const key of ['reach','visitors','spend','cpc','cpm','ctr','cost_per_test']) assert.equal(reportedCount([{[key]:3},{[key]:null}],key).value,null);
});
test('malformed, negative and unsafe counts are unknown rather than coerced into observations', () => {
  for(const value of ['2',-1,NaN,Infinity,1.5]) {
    const result=reportedCount([{checkouts:2},{checkouts:value}],'checkouts'); assert.equal(result.value,2); assert.equal(result.minimum,true); assert.equal(result.known_days,1);
  }
  assert.equal(reportedCount([{trials:Number.MAX_SAFE_INTEGER},{trials:1}],'trials').value,null);
});
