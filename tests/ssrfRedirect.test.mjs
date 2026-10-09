// asgard-0001: connectivity-check redirects must not pivot a public entry URL
// onto internal/loopback/metadata addresses, while operator-chosen internal
// entry URLs must keep working. Runs against dist/: `npm run build && npm test`.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isRefusedRedirectTarget, isRefusedServerAddrForEntry } = await import(pathToFileURL(path.join(root, 'dist', 'constants', 'common.js')).href);

// IP literals only, so no case depends on DNS resolution.
const PUBLIC_ENTRY = 'http://93.184.216.34/';

let savedAllowInternal;
beforeEach(() => {
  savedAllowInternal = process.env.OOBEE_ALLOW_INTERNAL_TARGETS;
  delete process.env.OOBEE_ALLOW_INTERNAL_TARGETS;
});
afterEach(() => {
  if (savedAllowInternal === undefined) delete process.env.OOBEE_ALLOW_INTERNAL_TARGETS;
  else process.env.OOBEE_ALLOW_INTERNAL_TARGETS = savedAllowInternal;
});

describe('isRefusedRedirectTarget: public entry URL', () => {
  for (const target of [
    'http://127.0.0.1/admin',
    'http://localhost:8080/',
    'http://10.0.0.5/',
    'http://172.16.1.1/',
    'http://192.168.0.10/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    test(`refuses redirect to ${target}`, async () => {
      assert.equal(await isRefusedRedirectTarget(PUBLIC_ENTRY, target), true);
    });
  }

  test('allows redirect to another public address', async () => {
    assert.equal(await isRefusedRedirectTarget(PUBLIC_ENTRY, 'https://93.184.216.35/home'), false);
  });

  test('allows a non-redirect (same URL)', async () => {
    assert.equal(await isRefusedRedirectTarget(PUBLIC_ENTRY, PUBLIC_ENTRY), false);
  });

  test('ignores non-http(s) targets', async () => {
    assert.equal(await isRefusedRedirectTarget(PUBLIC_ENTRY, 'about:blank'), false);
    assert.equal(await isRefusedRedirectTarget(PUBLIC_ENTRY, 'chrome-error://chromewebdata/'), false);
  });

  test('OOBEE_ALLOW_INTERNAL_TARGETS lifts private ranges but not loopback/metadata', async () => {
    process.env.OOBEE_ALLOW_INTERNAL_TARGETS = '1';
    assert.equal(await isRefusedRedirectTarget(PUBLIC_ENTRY, 'http://192.168.0.10/'), false);
    assert.equal(await isRefusedRedirectTarget(PUBLIC_ENTRY, 'http://127.0.0.1/'), true);
    assert.equal(await isRefusedRedirectTarget(PUBLIC_ENTRY, 'http://169.254.169.254/'), true);
  });
});

describe('isRefusedRedirectTarget: operator-chosen internal entry URL', () => {
  const cases = [
    ['http://localhost:3000/', 'http://localhost:3000/login'],
    ['http://localhost:3000/', 'http://127.0.0.1:3000/'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080/dashboard'],
    ['http://192.168.1.20/', 'http://192.168.1.20/intranet/'],
    ['http://10.0.0.5/', 'http://10.0.0.6/'],
    ['http://[::1]:5173/', 'http://[::1]:5173/app'],
  ];
  for (const [entry, target] of cases) {
    test(`allows ${entry} -> ${target}`, async () => {
      assert.equal(await isRefusedRedirectTarget(entry, target), false);
    });
  }

  test('allows internal entry redirecting out to a public host', async () => {
    assert.equal(await isRefusedRedirectTarget('http://192.168.1.20/', PUBLIC_ENTRY), false);
  });

  test('still refuses cloud metadata even from an internal entry', async () => {
    assert.equal(
      await isRefusedRedirectTarget('http://localhost:3000/', 'http://169.254.169.254/'),
      true,
    );
    assert.equal(
      await isRefusedRedirectTarget('http://10.0.0.5/', 'http://100.100.100.200/'),
      true,
    );
  });
});

describe('isRefusedServerAddrForEntry (DNS-rebinding backstop)', () => {
  test('public entry connected to loopback/private IP is refused', async () => {
    assert.equal(await isRefusedServerAddrForEntry(PUBLIC_ENTRY, '127.0.0.1'), true);
    assert.equal(await isRefusedServerAddrForEntry(PUBLIC_ENTRY, '192.168.0.10'), true);
    assert.equal(await isRefusedServerAddrForEntry(PUBLIC_ENTRY, '[::1]'), true);
  });

  test('public entry connected to public IP is allowed', async () => {
    assert.equal(await isRefusedServerAddrForEntry(PUBLIC_ENTRY, '93.184.216.34'), false);
  });

  test('internal entry connected to internal IP is allowed', async () => {
    assert.equal(await isRefusedServerAddrForEntry('http://localhost:3000/', '127.0.0.1'), false);
    assert.equal(await isRefusedServerAddrForEntry('http://192.168.1.20/', '192.168.1.20'), false);
  });

  test('metadata IP is refused for any entry', async () => {
    assert.equal(await isRefusedServerAddrForEntry('http://localhost/', '169.254.169.254'), true);
    assert.equal(await isRefusedServerAddrForEntry(PUBLIC_ENTRY, '169.254.169.254'), true);
  });
});
