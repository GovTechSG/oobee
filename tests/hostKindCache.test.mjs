// One DNS lookup per host per page must give the same egress decisions as the
// previous two-lookup checks. Runs against dist/: `npm run build && npm test`.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  classifyUrlHost,
  makeHostKindCache,
  isRefusedHostKind,
  isLinkLocalOrMetadataUrl,
  isInternalOrLoopbackUrl,
  isRefusedRedirectTarget,
} = await import(pathToFileURL(path.join(root, 'dist', 'constants', 'common.js')).href);

let saved;
beforeEach(() => {
  saved = process.env.OOBEE_ALLOW_INTERNAL_TARGETS;
  delete process.env.OOBEE_ALLOW_INTERNAL_TARGETS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.OOBEE_ALLOW_INTERNAL_TARGETS;
  else process.env.OOBEE_ALLOW_INTERNAL_TARGETS = saved;
});

// IP literals and localhost only, so no case depends on real DNS.
const URLS = [
  'http://93.184.216.34/',
  'https://[2606:4700::1]/',
  'http://127.0.0.1:8080/',
  'http://localhost:3000/',
  'http://app.localhost/',
  'http://10.0.0.5/',
  'http://172.16.1.1/',
  'http://192.168.0.10/',
  'http://100.64.1.1/',
  'http://[::1]/',
  'http://[fd00::1]/',
  'http://169.254.169.254/latest/meta-data/',
  'http://100.100.100.200/',
  'http://[fe80::1]/',
  'file:///tmp/a.html',
  'about:blank',
  'not a url',
];

describe('classifyUrlHost matches the old two-lookup checks', () => {
  for (const url of URLS) {
    test(url, async () => {
      const kind = await classifyUrlHost(url);
      let protocol = '';
      try { protocol = new URL(url).protocol; } catch { /* invalid */ }
      if (protocol !== 'http:' && protocol !== 'https:') {
        assert.equal(kind, 'skip');
        return;
      }
      const meta = await isLinkLocalOrMetadataUrl(url);
      const internal = await isInternalOrLoopbackUrl(url);
      const expected = meta ? 'metadata' : internal ? 'internal' : 'public';
      assert.equal(kind, expected);
    });
  }

  test('OOBEE_ALLOW_INTERNAL_TARGETS: private ranges public, loopback/metadata unchanged', async () => {
    process.env.OOBEE_ALLOW_INTERNAL_TARGETS = '1';
    assert.equal(await classifyUrlHost('http://192.168.0.10/'), 'public');
    assert.equal(await classifyUrlHost('http://127.0.0.1/'), 'internal');
    assert.equal(await classifyUrlHost('http://169.254.169.254/'), 'metadata');
  });
});

describe('isRefusedHostKind decisions', () => {
  test('public entry', () => {
    assert.equal(isRefusedHostKind('public', false), false);
    assert.equal(isRefusedHostKind('internal', false), true);
    assert.equal(isRefusedHostKind('metadata', false), true);
    assert.equal(isRefusedHostKind('skip', false), false);
  });
  test('internal entry', () => {
    assert.equal(isRefusedHostKind('internal', true), false);
    assert.equal(isRefusedHostKind('metadata', true), true);
  });
});

describe('isRefusedRedirectTarget unchanged', () => {
  test('public entry refuses internal and metadata, allows public', async () => {
    assert.equal(await isRefusedRedirectTarget('http://93.184.216.34/', 'http://127.0.0.1/'), true);
    assert.equal(await isRefusedRedirectTarget('http://93.184.216.34/', 'http://169.254.169.254/'), true);
    assert.equal(await isRefusedRedirectTarget('http://93.184.216.34/', 'https://93.184.216.35/'), false);
  });
  test('internal entry allows internal, still refuses metadata', async () => {
    assert.equal(await isRefusedRedirectTarget('http://localhost:3000/', 'http://127.0.0.1:3000/'), false);
    assert.equal(await isRefusedRedirectTarget('http://localhost:3000/', 'http://169.254.169.254/'), true);
  });
});

describe('makeHostKindCache', () => {
  test('one classification per host within a page', async () => {
    const kindOf = makeHostKindCache();
    const a = kindOf('http://127.0.0.1/a');
    const b = kindOf('http://127.0.0.1/b?x=1');
    assert.equal(a, b, 'same host reuses the same lookup');
    assert.notEqual(kindOf('http://10.0.0.5/'), a, 'different host gets its own lookup');
    assert.equal(await a, 'internal');
  });
  test('separate pages never share results', () => {
    const page1 = makeHostKindCache();
    const page2 = makeHostKindCache();
    assert.notEqual(page1('http://127.0.0.1/'), page2('http://127.0.0.1/'));
  });
  test('non-http(s) and invalid URLs are skipped without a lookup', async () => {
    const kindOf = makeHostKindCache();
    assert.equal(await kindOf('file:///etc/passwd'), 'skip');
    assert.equal(await kindOf('not a url'), 'skip');
  });
});
