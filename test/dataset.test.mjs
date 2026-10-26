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
test('dataset labels do not turn all Lead events into new studios or provisioning into a payment', () => {
  const events = normalizeDatasetStats([bucket([{ event: 'Lead', count: 2 }, { event: 'StartTrial', count: 1 }])], { start, end: now });
  const lead = events.find(e => e.key === 'Lead'), trial = events.find(e => e.key === 'StartTrial');
  assert.equal(lead.label, 'Lead-Signale');
  assert.match(lead.meaning, /im DIY: Studio-Test gestartet/);
  assert.equal(trial.label, 'Testphase begonnen');
  assert.match(trial.meaning, /Einrichtung läuft oder ist aktiv/);
  assert.match(trial.meaning, /Keine bestätigte Zahlung/);
});
test('dataset reader requests only the approved aggregate edge and explicit bounded period', async () => {
  const source = await collectDatasetStats(async (path, params) => {
    assert.equal(path, `${SCOPE.dataset}/stats`);
    assert.equal(params.aggregation, 'event_total_counts');
    assert.equal(params.start_time, String(start.getTime() / 1000));
    assert.equal(params.end_time, String(now.getTime() / 1000));
    assert.match(params.start_time, /^\d+$/);
    assert.match(params.end_time, /^\d+$/);
    assert.equal(params.fields, 'aggregation,start_time,data');
    return [bucket([{ event: 'PageView', count: '4' }, { value: 'Lead', count: 0 }, { event: 'Unknown private event', count: 99 }])];
  }, { enabled: true, now });
  assert.equal(source.dataset, SCOPE.dataset);
  assert.equal(source.events.find(e => e.key === 'PageView').count, 4);
  assert.equal(source.events.find(e => e.key === 'Lead').count, 0);
  assert.equal(source.events.find(e => e.key === 'CompleteRegistration').count, null);
  assert.equal(JSON.stringify(source).includes('Unknown private'), false);
});
test('Unix request seconds stay in the current UTC day across the Berlin DST boundary', async () => {
  for (const current of ['2026-10-25T00:30:00.999Z', '2026-10-25T02:30:00.999Z', '2026-10-26T00:00:00.001Z']) {
    const observed = new Date(current);
    const midnight = new Date(`${current.slice(0, 10)}T00:00:00.000Z`);
    const wireEnd = new Date(Math.floor(observed.getTime() / 1000) * 1000);
    const source = await collectDatasetStats(async (path, params) => {
      assert.equal(path, `${SCOPE.dataset}/stats`);
      assert.equal(params.start_time, String(midnight.getTime() / 1000));
      assert.equal(params.end_time, String(wireEnd.getTime() / 1000));
      return [{ aggregation: 'event_total_counts', start_time: midnight.toISOString(), data: [{ value: 'Lead', count: 0 }] }];
    }, { enabled: true, now: observed });
    assert.equal(source.observed_at, current);
    assert.equal(source.period.from, current.slice(0, 10));
    assert.equal(source.period.to, current.slice(0, 10));
    assert.ok(source.note.includes(wireEnd.toISOString()));
  }
});
test('response datetimes require explicit timezone and a valid calendar; Unix request format is not guessed as response format', () => {
  const normalize = time => normalizeDatasetStats([{ ...bucket([{ value: 'Lead', count: 1 }]), start_time: time }], { start, end: now });
  for (const valid of ['2026-10-25T00:00:00Z', '2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00+0100', '2026-10-25T01:00:00+01:00']) {
    assert.equal(normalize(valid).find(row => row.key === 'Lead').count, 1);
  }
  for (const invalid of [start.getTime() / 1000, String(start.getTime() / 1000), start.getTime(), String(start.getTime()),
    '2026-10-25', '2026-10-25T00:00:00', 'October 25 2026', '2026-10-25T00:00:00+2460', '2026-10-25T24:00:00Z']) {
    assert.throws(() => normalize(invalid), /DATASET_INVALID_PERIOD/);
  }
  assert.throws(() => normalizeDatasetStats([{ ...bucket([]), start_time: '2026-02-30T00:00:00Z' }], {
    start: new Date('2026-03-02T00:00:00Z'), end: new Date('2026-03-02T12:00:00Z'),
  }), /DATASET_INVALID_PERIOD/);
  assert.throws(() => normalizeDatasetStats([bucket([])], { start: new Date('invalid'), end: now }), /DATASET_INVALID_PERIOD/);
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
