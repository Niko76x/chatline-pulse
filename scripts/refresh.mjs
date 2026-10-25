import { SCOPE, validateSnapshot, canSkipCollection, assertConfiguredSources, refreshSources, createAnalyticsDiagnosticFetcher } from '../api/data.js';
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
const metaEnabled = process.env.META_REPORTING_ENABLED === 'true';
const datasetEnabled = process.env.META_DATASET_STATS_ENABLED === 'true';
const sourceOptions = { now, slot, metaEnabled, datasetEnabled,
  metaOptions: { token: process.env.META_REPORTING_ACCESS_TOKEN, version: process.env.META_GRAPH_VERSION },
  analyticsOptions: { fetcher: createAnalyticsDiagnosticFetcher({ enabled: process.env.ANALYTICS_DIAGNOSTICS_ENABLED === 'true' }), tokens: {
    'chatline.app': process.env.VERCEL_ANALYTICS_CHATLINE_WEBSITE_TOKEN,
    'start.chatline.app': process.env.VERCEL_ANALYTICS_LIMITLESS_TOKEN,
  } },
};
// Fail before any snapshot store read/write when no enabled source can authenticate.
assertConfiguredSources(sourceOptions);
let old, previousSha;
if (publish) {
  const stored = await github(`contents/data.json?ref=${SCOPE.dataBranch}`);
  if (stored) {
    previousSha = stored.sha;
    old = validateSnapshot(JSON.parse(Buffer.from(stored.content, 'base64').toString('utf8')));
  }
}
old ||= validateSnapshot(JSON.parse(await readFile(new URL('../public/data/fallback.json', import.meta.url), 'utf8')));
if (canSkipCollection(old, { slot, now, metaEnabled, datasetEnabled })) { process.stdout.write('Already published successfully for this slot.\n'); process.exit(0); }
const { snapshot: next, success } = await refreshSources(old, sourceOptions);
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
