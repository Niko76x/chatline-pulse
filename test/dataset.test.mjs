import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectDatasetStats, normalizeDatasetStats, mergeDatasetStats } from '../api/data.js';
import { SCOPE } from '../api/data.js';
const now = new Date('2026-10-25T18:00:00.000Z');
const start = new Date('2026-10-25T00:00:00.000Z');
const bucket = data => ({ aggregation: 'event_total_counts', start_time: start.toISOString(), data });
const original = JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8'));

test('dataset statistics are disabled by default and make no request', async () => {
  let calls = 0;
  assert.equal(await collectDatasetStats(async () => { calls++; }, { now }), null);
  assert.equal(calls, 0);
});
test('dataset reader requests only the approved aggregate edge and explicit bounded period', async () => {
  const source = await collectDatasetStats(async (path, params) => {
    assert.equal(path, `${SCOPE.dataset}/stats`);
    assert.equal(params.aggregation, 'event_total_counts');
    assert.equal(params.start_time, start.toISOString());
    assert.equal(params.end_time, now.toISOString());
    assert.equal(params.fields, 'aggregation,start_time,data');
    return [bucket([{ event: 'PageView', count: '4' }, { value: 'Lead', count: 0 }, { event: 'Unknown private event', count: 99 }])];
  }, { enabled: true, now });
  assert.equal(source.dataset, SCOPE.dataset);
  assert.equal(source.events.find(e => e.key === 'PageView').count, 4);
  assert.equal(source.events.find(e => e.key === 'Lead').count, 0);
  assert.equal(source.events.find(e => e.key === 'CompleteRegistration').count, null);
  assert.equal(JSON.stringify(source).includes('Unknown private'), false);
});
test('empty stats, malformed counts, duplicate events and duplicate buckets are not converted into success', () => {
  const normalize = rows => normalizeDatasetStats(rows, { start, end: now });
  assert.throws(() => normalize([]), /DATASET_NO_STATS/);
  assert.throws(() => normalize([bucket([{ event: 'PageView', count: null }])]), /DATASET_INVALID_RESPONSE/);
  assert.throws(() => normalize([bucket([{ event: 'PageView', count: -1 }])]), /DATASET_INVALID_RESPONSE/);
  assert.throws(() => normalize([bucket([{ event: 'PageView', count: 1 }, { value: 'PageView', count: 2 }])]), /DATASET_DUPLICATE_EVENT/);
  assert.throws(() => normalize([bucket([]), bucket([])]), /DATASET_INVALID_PERIOD/);
  assert.throws(() => normalize([{ ...bucket([]), aggregation: 'url' }]), /DATASET_INVALID_RESPONSE/);
  assert.throws(() => normalize([{ ...bucket([]), start_time: '2026-10-26T00:00:00Z' }]), /DATASET_INVALID_PERIOD/);
});
test('an event absent from a reported bucket stays unknown rather than adding an assumed zero', () => {
  const output = normalizeDatasetStats([
    bucket([{ event: 'PageView', count: 5 }]),
    { ...bucket([{ event: 'Lead', count: 1 }]), start_time: '2026-10-25T01:00:00.000Z' },
  ], { start, end: now });
  assert.equal(output.find(e => e.key === 'PageView').count, null);
  assert.equal(output.find(e => e.key === 'Lead').count, null);
});
test('failure of dataset statistics preserves its observation time and the successful ad source', () => {
  const after = mergeDatasetStats(original, null, { now, error: 'META_PERMISSION_REQUIRED' });
  assert.equal(after.sources.website_events.observed_at, original.sources.website_events.observed_at);
  assert.deepEqual(after.sources.website_events.events, original.sources.website_events.events);
  assert.deepEqual(after.sources.meta, original.sources.meta);
  assert.equal(after.collected_at, original.collected_at);
  assert.equal(after.sources.website_events.status, 'error');
});
test('a successful dataset result cannot replace another dataset or stamp the ad source as fresh', async () => {
  const result = await collectDatasetStats(async () => [bucket([{ event: 'PageView', count: 5 }])], { enabled: true, now });
  assert.throws(() => mergeDatasetStats(original, { ...result, dataset: 'other' }, { now }), /DATASET_MISMATCH/);
  const after = mergeDatasetStats(original, result, { now });
  assert.equal(after.sources.website_events.observed_at, now.toISOString());
  assert.equal(after.sources.website_events.status, 'connected');
  assert.deepEqual(after.sources.meta, original.sources.meta);
});
