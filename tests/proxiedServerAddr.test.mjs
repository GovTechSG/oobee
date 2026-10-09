// Connected-address checks must work behind a proxy (Crawlee's local proxy,
// FAMILY_DNS / CF Worker SOCKS5) without dropping redirect/rebinding refusal.
// Runs against dist/: `npm run build && npm test`.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getDirectServerAddr, getResponseHopUrls, isRefusedNavigation } = await import(
  pathToFileURL(path.join(root, 'dist', 'constants', 'common.js')).href
);
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright');

// Minimal stand-in for a Playwright Response.
const fakeResponse = (urls, addr) => {
  let req = null;
  for (const u of urls) {
    const prev = req;
    req = { url: () => u, redirectedFrom: () => prev };
  }
  return { url: () => urls[urls.length - 1], request: () => req, serverAddr: async () => addr };
};
const PUBLIC = 'https://93.184.216.34/';

describe('getDirectServerAddr', () => {
  test('trusts the address when the port matches (direct connection)', async () => {
    assert.equal(await getDirectServerAddr(fakeResponse([PUBLIC], { ipAddress: '93.184.216.34', port: 443 })), '93.184.216.34');
  });
  test('ignores a proxy address (FAMILY_DNS SOCKS5 / Crawlee proxy)', async () => {
    assert.equal(await getDirectServerAddr(fakeResponse([PUBLIC], { ipAddress: '127.0.0.1', port: 8877 })), null);
  });
});

describe('isRefusedNavigation', () => {
  test('public page behind a local proxy is allowed', async () => {
    assert.equal(await isRefusedNavigation(PUBLIC, fakeResponse([PUBLIC], { ipAddress: '127.0.0.1', port: 8877 }), PUBLIC), null);
  });
  test('redirect hop to an internal address is refused, even behind a proxy', async () => {
    const r = fakeResponse([PUBLIC, 'http://127.0.0.1/admin', 'https://93.184.216.35/'], { ipAddress: '127.0.0.1', port: 8877 });
    assert.equal(await isRefusedNavigation(PUBLIC, r, 'https://93.184.216.35/'), 'http://127.0.0.1/admin');
  });
  test('metadata hop refused even for an internal entry', async () => {
    const r = fakeResponse(['http://localhost:3000/', 'http://169.254.169.254/'], null);
    assert.ok(await isRefusedNavigation('http://localhost:3000/', r));
  });
  test('direct connection to an internal IP from a public entry is refused', async () => {
    assert.equal(await isRefusedNavigation(PUBLIC, fakeResponse([PUBLIC], { ipAddress: '10.0.0.5', port: 443 })), '10.0.0.5');
  });
  test('internal entry may reach internal addresses', async () => {
    const r = fakeResponse(['http://localhost:3000/'], { ipAddress: '127.0.0.1', port: 3000 });
    assert.equal(await isRefusedNavigation('http://localhost:3000/', r), null);
  });
});

describe('real Chromium redirect chain', () => {
  let srv;
  let port;
  let browser;
  let skip = false;
  before(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/a') { res.writeHead(302, { Location: `http://localhost:${port}/b` }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>t</title>ok');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    port = srv.address().port;
    try { browser = await chromium.launch(); } catch { skip = 'no Playwright Chromium'; }
  });
  after(async () => { if (browser) await browser.close(); srv.close(); });

  test('every hop is visible and a public entry is refused', async t => {
    if (skip) return t.skip(skip);
    const page = await browser.newPage();
    const resp = await page.goto(`http://127.0.0.1:${port}/a`);
    const hops = getResponseHopUrls(resp, page.url());
    assert.deepEqual(hops.sort(), [`http://127.0.0.1:${port}/a`, `http://localhost:${port}/b`].sort());
    assert.ok(await isRefusedNavigation(PUBLIC, resp, page.url()));
    assert.equal(await isRefusedNavigation(`http://127.0.0.1:${port}/`, resp, page.url()), null);
    await page.close();
  });
});
