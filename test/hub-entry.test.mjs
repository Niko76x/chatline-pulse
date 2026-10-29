import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/assets/hub-redirect.js', import.meta.url), 'utf8');
const HUB = 'https://chatline-social-dashboard.vercel.app/';

function run(hash) {
  const replaced = [], link = { href: '' };
  vm.runInNewContext(script, { location: { hash, replace: url => replaced.push(url) }, document: { getElementById: () => link } });
  return { target: replaced[0], link: link.href };
}

test('old Pulse entry has no roadmap, no second navigation and no Pulse dashboard client', () => {
  assert.doesNotMatch(html, /roadmap/i);
  assert.doesNotMatch(html, /<nav|section-tabs|pulse\.js|<select/i);
  assert.match(html, /http-equiv="refresh" content="2; url=https:\/\/chatline-social-dashboard\.vercel\.app\/#\/anzeigen"/);
});

test('old bookmarks land on the matching hub page', () => {
  assert.equal(run('').target, HUB + '#/anzeigen');
  assert.equal(run('#/overview').target, HUB + '#/');
  assert.equal(run('#/facebook').target, HUB + '#/anzeigen');
  assert.equal(run('#/website').target, HUB + '#/website');
  assert.equal(run('#/funnel/diy').target, HUB + '#/website');
  assert.equal(run('#/tracking').target, HUB + '#/quellen');
  assert.equal(run('#/__proto__').target, HUB + '#/anzeigen');
  assert.equal(run('#/facebook').link, HUB + '#/anzeigen');
});

test('API routes stay untouched at their existing addresses', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.redirects, undefined);
  assert.equal(config.rewrites, undefined);
  await readFile(new URL('../api/data.js', import.meta.url));
  await readFile(new URL('../api/refresh.js', import.meta.url));
});
