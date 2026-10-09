// FAMILY_DNS / CF_FAMILY_DNS precedence. CF_FAMILY_DNS is the original name
// and must keep enabling the (multi-provider) Family DoH filter.
// Runs against dist/: `npm run build && npm test`. No network.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isFamilyDnsEnabled, isFamilyDnsLocalProxyConfigured } = await import(
  pathToFileURL(path.join(root, 'dist', 'cfProxyWorker.js')).href
);

const KEYS = ['FAMILY_DNS', 'CF_FAMILY_DNS', 'CF_WORKER_PROXY'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const cases = [
  // [FAMILY_DNS, CF_FAMILY_DNS, expected, description]
  [undefined, undefined, false, 'neither set'],
  ['1', undefined, true, 'FAMILY_DNS=1'],
  ['true', undefined, true, 'FAMILY_DNS=true'],
  ['0', undefined, false, 'FAMILY_DNS=0'],
  ['', undefined, false, 'FAMILY_DNS blank'],
  ['   ', undefined, false, 'FAMILY_DNS whitespace'],
  [undefined, '1', true, 'legacy CF_FAMILY_DNS=1 still enables the filter'],
  [undefined, 'yes', true, 'legacy CF_FAMILY_DNS=yes'],
  [undefined, '0', false, 'legacy CF_FAMILY_DNS=0'],
  [undefined, '', false, 'legacy CF_FAMILY_DNS blank'],
  ['0', '1', false, 'FAMILY_DNS=0 overrides legacy CF_FAMILY_DNS=1'],
  ['1', '0', true, 'FAMILY_DNS=1 wins over legacy CF_FAMILY_DNS=0'],
  ['', '1', true, 'blank FAMILY_DNS falls back to legacy CF_FAMILY_DNS=1'],
];

describe('isFamilyDnsEnabled', () => {
  for (const [familyDns, legacy, expected, name] of cases) {
    test(name, () => {
      if (familyDns !== undefined) process.env.FAMILY_DNS = familyDns;
      if (legacy !== undefined) process.env.CF_FAMILY_DNS = legacy;
      assert.equal(isFamilyDnsEnabled(), expected);
    });
  }
});

describe('legacy CF_FAMILY_DNS gets multi-provider failover', () => {
  // Wireformat answer with one A record (93.184.216.34) for A queries.
  const answerFor = url => {
    const query = Buffer.from(new URL(url).searchParams.get('dns'), 'base64url');
    const qtype = query.readUInt16BE(query.length - 4);
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2);
    const parts = [header, query.subarray(12)];
    if (qtype === 1) {
      header.writeUInt16BE(1, 6);
      const a = Buffer.alloc(16);
      a.writeUInt16BE(0xc00c, 0);
      a.writeUInt16BE(1, 2);
      a.writeUInt16BE(1, 4);
      a.writeUInt32BE(60, 6);
      a.writeUInt16BE(4, 10);
      Buffer.from([93, 184, 216, 34]).copy(a, 12);
      parts.push(a);
    }
    return new Response(Buffer.concat(parts), { status: 200 });
  };

  test('Cloudflare down: resolves via the next provider', async () => {
    const { resolveViaFamilyDoH, clearDohCache } = await import(
      pathToFileURL(path.join(root, 'dist', 'cfProxyWorker.js')).href
    );
    process.env.CF_FAMILY_DNS = '1';
    assert.equal(isFamilyDnsEnabled(), true);
    const realFetch = globalThis.fetch;
    const hosts = [];
    globalThis.fetch = async url => {
      const host = new URL(url).hostname;
      hosts.push(host);
      if (host === 'family.cloudflare-dns.com') throw new Error('simulated outage');
      return answerFor(url);
    };
    clearDohCache();
    try {
      assert.equal(await resolveViaFamilyDoH('legacy-failover.example'), '93.184.216.34');
      assert.equal(hosts[0], 'family.cloudflare-dns.com');
      assert.equal(hosts[1], 'freedns.controld.com');
    } finally {
      globalThis.fetch = realFetch;
      clearDohCache();
    }
  });
});

describe('local Family DNS proxy is started for the legacy variable', () => {
  test('CF_FAMILY_DNS=1 alone configures the local proxy', () => {
    process.env.CF_FAMILY_DNS = '1';
    assert.equal(isFamilyDnsLocalProxyConfigured(), true);
  });

  test('CF_WORKER_PROXY still takes precedence over the local proxy', () => {
    process.env.CF_FAMILY_DNS = '1';
    process.env.CF_WORKER_PROXY = 'wss://worker.example';
    assert.equal(isFamilyDnsLocalProxyConfigured(), false);
    assert.equal(isFamilyDnsEnabled(), true, 'filter still applies on the Worker path');
  });
});
