// asgard-0002: scanCustomFlow entry-URL guard. Runs against dist/:
// `npm run build && npm test`.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { assertSafeCustomFlowUrl } = await import(pathToFileURL(path.join(root, 'dist', 'crawlers', 'scanCustomFlow.js')).href);

const allowed = url => assert.doesNotReject(assertSafeCustomFlowUrl(url));
const refused = url => assert.rejects(assertSafeCustomFlowUrl(url));

let saved;
beforeEach(() => {
  saved = process.env.OOBEE_SSRF_PROTECTION;
  delete process.env.OOBEE_SSRF_PROTECTION;
});
afterEach(() => {
  if (saved === undefined) delete process.env.OOBEE_SSRF_PROTECTION;
  else process.env.OOBEE_SSRF_PROTECTION = saved;
});

describe('default (OOBEE_SSRF_PROTECTION off): operator workflows keep working', () => {
  for (const url of [
    'http://93.184.216.34/', // plain http, non-https entry URL
    'https://93.184.216.34/',
    'http://localhost:3000/',
    'http://127.0.0.1:8080/',
    'http://10.0.0.5/',
    'http://192.168.1.20/intranet/',
    'file:///tmp/site/index.html',
    'file://localhost/tmp/site/index.html',
    'C:\\site\\index.html',
  ]) {
    test(`allows ${url}`, () => allowed(url));
  }
});

describe('always refused, regardless of env vars', () => {
  for (const url of [
    'data:text/html,<h1>x</h1>',
    'javascript:alert(1)',
    'blob:https://93.184.216.34/uuid',
    'ftp://93.184.216.34/',
    'gopher://93.184.216.34/',
    'view-source:https://93.184.216.34/',
    'file://attacker/share/index.html',
    'http://169.254.169.254/latest/meta-data/',
    'not a url',
  ]) {
    test(`refuses ${url}`, () => refused(url));
  }
});

describe('OOBEE_SSRF_PROTECTION=1: public http(s) only', () => {
  beforeEach(() => {
    process.env.OOBEE_SSRF_PROTECTION = '1';
  });
  test('allows public http (non-https)', () => allowed('http://93.184.216.34/'));
  test('allows public https', () => allowed('https://93.184.216.34/'));
  for (const url of [
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://192.168.1.20/',
    'file:///tmp/site/index.html',
    'C:\\site\\index.html',
  ]) {
    test(`refuses ${url}`, () => refused(url));
  }
});
