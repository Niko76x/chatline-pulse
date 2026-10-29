import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRefreshHandler, DISPATCH_URL, maxDuration } from '../api/refresh.js';

const secret = 'FIXTURE_REFRESH_SECRET_ONLY_0123456789';
const token = 'github_pat_FIXTURE_WORKFLOW_ONLY_0123456789';
const enabled = { VERCEL_ENV: 'production', PULSE_EXTERNAL_REFRESH_ENABLED: 'true', CRON_SECRET: secret, PULSE_WORKFLOW_DISPATCH_TOKEN: token };
const clock = new Date('2026-10-29T12:30:00.000Z');
function response() {
  return { headers: {}, statusCode: null, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
}
async function call({ env = enabled, req = {}, fetcher = async () => ({ status: 204 }) } = {}) {
  const res = response(), calls = [];
  await createRefreshHandler({ env, now: () => clock, fetcher: async (...args) => { calls.push(args); return fetcher(...args); } })({
    method: 'GET', query: {}, headers: { authorization: `Bearer ${secret}` }, ...req,
  }, res);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.doesNotMatch(JSON.stringify(res), new RegExp(`${secret}|${token}`));
  return { res, calls };
}

test('default/preview deployments and missing configuration fail before any dispatch', async () => {
  for (const env of [{}, { ...enabled, VERCEL_ENV: 'preview' }, { ...enabled, VERCEL_ENV: 'development' },
    { ...enabled, PULSE_EXTERNAL_REFRESH_ENABLED: undefined }, { ...enabled, CRON_SECRET: undefined },
    { ...enabled, CRON_SECRET: 'short' }, { ...enabled, PULSE_WORKFLOW_DISPATCH_TOKEN: undefined },
    { ...enabled, PULSE_WORKFLOW_DISPATCH_TOKEN: `${token}\r\nPRIVATE_HEADER: value` }]) {
    const { res, calls } = await call({ env });
    assert.equal(res.statusCode, 503); assert.equal(calls.length, 0);
    assert.ok(['REFRESH_DISABLED', 'REFRESH_NOT_CONFIGURED'].includes(res.body.error));
  }
});

test('missing, malformed, array and wrong authorization cannot trigger a workflow', async () => {
  for (const headers of [{}, { authorization: null }, { authorization: [`Bearer ${secret}`] },
    { authorization: `Basic ${secret}` }, { authorization: `Bearer ${secret} ` },
    { authorization: `Bearer ${secret.slice(0,-1)}X` }, { authorization: 'Bearer short' },
    { authorization: `Bearer ${secret}\nX-Other: private` }]) {
    const { res, calls } = await call({ req: { headers } });
    assert.equal(res.statusCode, 401); assert.equal(calls.length, 0);
    assert.deepEqual(res.body, { error: 'UNAUTHORIZED' });
  }
});

test('only authenticated GET/POST with no selectable parameters is accepted', async () => {
  for (const method of ['DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS', undefined]) {
    const { res, calls } = await call({ req: { method } });
    assert.equal(res.statusCode, 405); assert.equal(res.headers.Allow, 'GET, POST'); assert.equal(calls.length, 0);
  }
  for (const req of [{ query: { account: 'PRIVATE_ACCOUNT' } }, { query: { url: 'https://private.invalid' } },
    { query: [] }, { query: 'private' }, { body: { ref: 'other' } }, { body: { inputs: {} } },
    { body: 'PRIVATE_PAYLOAD' }, { body: [] }]) {
    const { res, calls } = await call({ req });
    assert.equal(res.statusCode, 400); assert.equal(calls.length, 0);
    assert.doesNotMatch(JSON.stringify(res), /PRIVATE|private.invalid|other/);
  }
});

test('exactly one fixed-repository/main dispatch; caller receives queued rather than a false refresh', async () => {
  assert.equal(maxDuration, 10);
  for (const req of [{ method: 'GET' }, { method: 'POST', body: {} },
    { method: 'GET', headers: { authorization: `bearer ${secret}` } }]) {
    const { res, calls } = await call({ req });
    assert.equal(calls.length, 1);
    const [url, options] = calls[0];
    assert.equal(url, 'https://api.github.com/repos/Niko76x/chatline-pulse/actions/workflows/pulse-refresh.yml/dispatches');
    assert.equal(url, DISPATCH_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(options.body), { ref: 'main' });
    assert.equal(JSON.stringify(options).includes(secret), false);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.body, { status: 'queued', queued_at: clock.toISOString(), data_refreshed: false });
  }
});

test('upstream refusals, redirects and exceptions expose no token/body/header or invented success; no retries', async () => {
  for (const status of [200, 201, 301, 400, 401, 403, 404, 422, 429, 500, 503]) {
    let parsed = false;
    const { res, calls } = await call({ fetcher: async () => ({ status, json: async () => { parsed = true; throw Error(token); } }) });
    assert.equal(parsed, false); assert.equal(calls.length, 1); assert.equal(res.statusCode, 503);
    assert.equal(Object.hasOwn(res.body, 'queued_at'), false);
    assert.equal(res.body.error, [401,403].includes(status) ? 'DISPATCH_ACCESS_REQUIRED'
      : status === 429 ? 'DISPATCH_RATE_LIMITED' : 'DISPATCH_FAILED');
  }
  const { res, calls } = await call({ fetcher: async () => { throw Error(`PRIVATE_RESPONSE ${token}`); } });
  assert.equal(calls.length, 1); assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'DISPATCH_UNAVAILABLE' });
});

test('adapter does not add a Vercel cron, a new data publisher, or any Meta credential dependency', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(Object.hasOwn(config, 'crons'), false);
  const source = await readFile(new URL('../api/refresh.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /META_REPORTING_ACCESS_TOKEN|META_CAPI_ACCESS_TOKEN|VERCEL_ANALYTICS_|GITHUB_TOKEN|writeFile|console\./);
});
