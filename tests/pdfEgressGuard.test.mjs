// asgard-0004: server-side PDF download egress guard.
// Runs against dist/: `npm run build && npm test`.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createPdfEgressGuards, isRefusedPdfEgressAddress } = await import(
  pathToFileURL(path.join(root, 'dist', 'crawlers', 'pdfScanFunc.js')).href
);
const require = createRequire(path.join(root, 'package.json'));
const { GotScrapingHttpClient } = require('@crawlee/core');

let srv;
let port;
before(async () => {
  srv = http.createServer((req, res) => {
    const redirects = {
      '/to-ip': `http://127.0.0.1:${port}/x.pdf`,
      '/to-metadata': 'http://169.254.169.254/latest/meta-data/x.pdf',
      '/to-localhost': `http://localhost:${port}/x.pdf`,
    };
    if (redirects[req.url]) {
      res.writeHead(302, { Location: redirects[req.url] });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end('%PDF-1.4');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});
after(() => srv.close());

let savedAllow;
beforeEach(() => {
  savedAllow = process.env.OOBEE_ALLOW_INTERNAL_TARGETS;
  delete process.env.OOBEE_ALLOW_INTERNAL_TARGETS;
});
afterEach(() => {
  if (savedAllow === undefined) delete process.env.OOBEE_ALLOW_INTERNAL_TARGETS;
  else process.env.OOBEE_ALLOW_INTERNAL_TARGETS = savedAllow;
});

// Mirrors handlePdfDownload: URL check, guarded stream, peer-address backstop.
const client = new GotScrapingHttpClient();
const fetchWith = async (url, entryIsInternal) => {
  const g = createPdfEgressGuards(entryIsInternal);
  g.assertUrlAllowed(url);
  const r = await client.stream({
    url,
    method: 'GET',
    dnsLookup: g.dnsLookup,
    followRedirect: g.followRedirect,
  });
  r.stream.destroy();
  if (r.ip && isRefusedPdfEgressAddress(r.ip, entryIsInternal)) {
    throw Object.assign(new Error('peer refused'), { code: 'EOOBEE_REFUSED_ADDR' });
  }
  return r;
};
const refused = p =>
  assert.rejects(p, e => e.code === 'EOOBEE_REFUSED_ADDR' || /internal\/metadata/.test(e.message));

describe('isRefusedPdfEgressAddress', () => {
  test('public entry: loopback/private/metadata refused, public allowed', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '::1', '169.254.169.254']) {
      assert.equal(isRefusedPdfEgressAddress(ip, false), true, ip);
    }
    assert.equal(isRefusedPdfEgressAddress('93.184.216.34', false), false);
  });

  test('internal entry: loopback/private allowed, metadata still refused', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '::1']) {
      assert.equal(isRefusedPdfEgressAddress(ip, true), false, ip);
    }
    assert.equal(isRefusedPdfEgressAddress('169.254.169.254', true), true);
    assert.equal(isRefusedPdfEgressAddress('100.100.100.200', true), true);
  });

  test('OOBEE_ALLOW_INTERNAL_TARGETS lifts private ranges only', () => {
    process.env.OOBEE_ALLOW_INTERNAL_TARGETS = '1';
    assert.equal(isRefusedPdfEgressAddress('192.168.1.1', false), false);
    assert.equal(isRefusedPdfEgressAddress('127.0.0.1', false), true);
    assert.equal(isRefusedPdfEgressAddress('169.254.169.254', false), true);
  });
});

describe('public entry URL (attacker-controlled site/sitemap)', () => {
  test('IP-literal loopback PDF URL is refused', () =>
    refused(fetchWith(`http://127.0.0.1:${port}/x.pdf`, false)));
  test('metadata PDF URL is refused', () =>
    refused(fetchWith('http://169.254.169.254/latest/meta-data/role.pdf', false)));
  test('hostname resolving to loopback is refused at DNS', () =>
    refused(fetchWith(`http://localhost:${port}/x.pdf`, false)));
  test('IPv6 loopback literal is refused', () =>
    refused(fetchWith(`http://[::1]:${port}/x.pdf`, false)));
});

describe('internal entry URL (operator scanning localhost/intranet)', () => {
  test('loopback PDF downloads normally', async () => {
    assert.equal((await fetchWith(`http://127.0.0.1:${port}/x.pdf`, true)).statusCode, 200);
  });
  test('localhost hostname PDF downloads normally', async () => {
    assert.equal((await fetchWith(`http://localhost:${port}/x.pdf`, true)).statusCode, 200);
  });
  test('redirect within the internal host is followed', async () => {
    const r = await fetchWith(`http://127.0.0.1:${port}/to-localhost`, true);
    assert.equal(r.statusCode, 200);
    assert.equal(r.redirectUrls.length, 1);
  });
  test('redirect to cloud metadata is refused even for internal entry', () =>
    refused(fetchWith(`http://127.0.0.1:${port}/to-metadata`, true)));
});

describe('redirect hops are re-validated', () => {
  const pub = 'https://93.184.216.34/a.pdf';
  test('internal IP-literal Location is refused', () => {
    const g = createPdfEgressGuards(false);
    for (const location of ['http://127.0.0.1/x.pdf', 'http://169.254.169.254/']) {
      assert.throws(() => g.followRedirect({ url: pub, headers: { location } }), e => e.code === 'EOOBEE_REFUSED_ADDR');
    }
  });
  test('public and relative Location are allowed', () => {
    const g = createPdfEgressGuards(false);
    assert.equal(g.followRedirect({ url: pub, headers: { location: 'https://93.184.216.35/b.pdf' } }), true);
    assert.equal(g.followRedirect({ url: pub, headers: { location: '/b.pdf' } }), true);
  });
  test('non-http(s) Location is refused', () => {
    const g = createPdfEgressGuards(true);
    assert.throws(
      () => g.followRedirect({ url: 'http://127.0.0.1/a.pdf', headers: { location: 'file:///etc/passwd' } }),
      e => e.code === 'EOOBEE_REFUSED_ADDR',
    );
  });
});
