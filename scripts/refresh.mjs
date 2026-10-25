import { SCOPE, createMetaReader, collectAds, collectWebAnalytics, collectDatasetStats, mergeMeta, mergeAnalytics, mergeDatasetStats, validateSnapshot, canSkipCollection } from '../api/data.js';
import { readFile, writeFile } from 'node:fs/promises';

const publish = process.argv.includes('--publish');
const now = new Date();
// UTC bucket makes retries idempotent. Actions concurrency serializes publications.
const slot = new Date(Math.floor(now.getTime() / 1800000) * 1800000).toISOString();
const token = process.env.GITHUB_TOKEN;
const headers = { Authorization: `Bearer ${token || ''}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${SCOPE.repository}/${path}`, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (response.status === 404 && options.method === undefined) return null;
  if (!response.ok) throw new Error('SNAPSHOT_STORE_FAILED');
  return response.json();
}
if (publish && (process.env.PULSE_SYNC_ENABLED !== 'true' || process.env.GITHUB_REPOSITORY !== SCOPE.repository || !token)) throw new Error('PUBLISH_NOT_CONFIGURED');
let old, previousSha;
if (publish) {
  const stored = await github(`contents/data.json?ref=${SCOPE.dataBranch}`);
  if (stored) {
    previousSha = stored.sha;
    old = validateSnapshot(JSON.parse(Buffer.from(stored.content, 'base64').toString('utf8')));
  }
}
old ||= validateSnapshot(JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8')));
const datasetEnabled = process.env.META_DATASET_STATS_ENABLED === 'true';
if (canSkipCollection(old, { slot, now, datasetEnabled })) { process.stdout.write('Already published successfully for this slot.\n'); process.exit(0); }
let next, metaReader, success = false;
try {
  metaReader = createMetaReader({ token: process.env.META_REPORTING_ACCESS_TOKEN, version: process.env.META_GRAPH_VERSION });
  next = mergeMeta(old, await collectAds(metaReader, now), { now, slot });
  success = true;
} catch (e) {
  next = mergeMeta(old, null, { now, slot, error: e.code || e.message });
}
// Analytics is independent. A Meta auth failure must not block a configured website source.
const analyticsResults = await collectWebAnalytics({ token: process.env.VERCEL_ANALYTICS_ACCESS_TOKEN, now });
next = mergeAnalytics(next, analyticsResults, { now, slot });
success = success && !analyticsResults.some(s => s.status === 'error');
try {
  if (datasetEnabled && !metaReader) throw new Error('META_NOT_CONFIGURED');
  const datasetResult = await collectDatasetStats(metaReader, { enabled: datasetEnabled, now });
  next = mergeDatasetStats(next, datasetResult, { now });
} catch (error) {
  next = mergeDatasetStats(next, null, { now, error: error.code || error.message });
  success = false;
}
if (publish) {
  // Branch creation is an explicit setup task. Never create it implicitly from the worker.
  const branch = await github(`git/ref/heads/${SCOPE.dataBranch}`);
  if (!branch) throw new Error('DATA_BRANCH_NOT_PREPARED');
  await github('contents/data.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    message: `ChatLine aggregate ${slot}`, branch: SCOPE.dataBranch, ...(previousSha ? { sha: previousSha } : {}),
    content: Buffer.from(JSON.stringify(next, null, 2) + '\n').toString('base64'),
  }) });
} else {
  await writeFile(new URL('../preview-result.json', import.meta.url), JSON.stringify(next, null, 2) + '\n');
}
process.stdout.write(success ? 'ChatLine aggregate collected.\n' : 'Source read failed; previous observation times preserved.\n');
if (!success) process.exitCode = 1;
