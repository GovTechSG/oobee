// asgard-0009: the Family DoH cache must stay bounded.
// Runs against dist/: `npm run build && npm test`. No network: fetch is stubbed.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  BoundedTtlCache,
  DOH_CACHE_MAX_ENTRIES,
  resolveViaFamilyDoH,
  getDohCacheSize,
  clearDohCache,
} = await import(pathToFileURL(path.join(root, 'dist', 'cfProxyWorker.js')).href);

describe('BoundedTtlCache', () => {
  test('returns fresh entries and drops expired ones on read', () => {
    const c = new BoundedTtlCache(10);
    c.set('a', { v: 1, expiresAt: 100 }, 0);
    assert.equal(c.get('a', 50).v, 1);
    assert.equal(c.get('a', 100), undefined);
    assert.equal(c.size, 0);
  });

  test('never exceeds the cap; evicts least recently used', () => {
    const c = new BoundedTtlCache(3);
    for (const k of ['a', 'b', 'c']) c.set(k, { expiresAt: 1000 }, 0);
    c.get('a', 1); // a becomes most recently used
    c.set('d', { expiresAt: 1000 }, 2);
    assert.equal(c.size, 3);
    assert.equal(c.get('b', 3), undefined, 'oldest unused entry evicted');
    assert.ok(c.get('a', 3) && c.get('c', 3) && c.get('d', 3));
  });

  test('sweeps expired entries before evicting live ones', () => {
    const c = new BoundedTtlCache(3);
    c.set('live', { expiresAt: 1000 }, 0);
    c.set('old1', { expiresAt: 10 }, 0);
    c.set('old2', { expiresAt: 10 }, 0);
    c.set('new', { expiresAt: 1000 }, 50);
    assert.equal(c.size, 2);
    assert.ok(c.get('live', 51), 'live entry kept');
  });

  test('re-setting an existing key does not grow the cache', () => {
    const c = new BoundedTtlCache(2);
    c.set('a', { expiresAt: 1000 }, 0);
    c.set('a', { expiresAt: 2000 }, 1);
    assert.equal(c.size, 1);
  });
});

describe('resolveViaFamilyDoH cache', () => {
  let realFetch;
  let queries;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    queries = 0;
    // Answers in RFC 8484 wireformat (application/dns-message): echoes the
    // question and adds one A record for A queries, no answer for AAAA.
    globalThis.fetch = async (url) => {
      queries += 1;
      const query = Buffer.from(new URL(url).searchParams.get('dns'), 'base64url');
      const qtype = query.readUInt16BE(query.length - 4);
      const header = Buffer.from(query.subarray(0, 12));
      header.writeUInt16BE(0x8180, 2); // QR + RD + RA, RCODE 0
      const parts = [header, query.subarray(12)];
      if (qtype === 1) {
        header.writeUInt16BE(1, 6); // ANCOUNT
        const answer = Buffer.alloc(16);
        answer.writeUInt16BE(0xc00c, 0); // pointer to the question name
        answer.writeUInt16BE(1, 2); // TYPE A
        answer.writeUInt16BE(1, 4); // CLASS IN
        answer.writeUInt32BE(60, 6); // TTL
        answer.writeUInt16BE(4, 10); // RDLENGTH
        Buffer.from([93, 184, 216, 34]).copy(answer, 12);
        parts.push(answer);
      }
      return new Response(Buffer.concat(parts), {
        status: 200,
        headers: { 'content-type': 'application/dns-message' },
      });
    };
    clearDohCache();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearDohCache();
  });

  test('cap is 4096 entries', () => {
    assert.equal(DOH_CACHE_MAX_ENTRIES, 4096);
  });

  test('repeat lookups are served from cache (behaviour unchanged)', async () => {
    assert.equal(await resolveViaFamilyDoH('example.com'), '93.184.216.34');
    assert.equal(await resolveViaFamilyDoH('example.com'), '93.184.216.34');
    assert.equal(queries, 1);
  });

  test('many distinct attacker hostnames cannot grow the cache past the cap', async () => {
    const total = DOH_CACHE_MAX_ENTRIES + 1000;
    for (let i = 0; i < total; i += 1) {
      await resolveViaFamilyDoH(`r${i}.evil.example`);
    }
    assert.equal(getDohCacheSize(), DOH_CACHE_MAX_ENTRIES);
  });
});
