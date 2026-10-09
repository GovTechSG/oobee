// cfProxyWorker.ts
// Local SOCKS5 proxy that tunnels each connection to a Cloudflare Worker over a
// WebSocket. The worker opens the outbound TCP socket via cloudflare:sockets;
// the browser performs its own TLS end-to-end with the real target, so no MITM
// and no local cert are needed.
//
// Activated only when the CF_WORKER_PROXY env variable is set (worker URL,
// e.g. https://something-user-123.workers.dev). Optional
// CF_WORKER_PROXY_AUTH_TOKEN is sent as the Authorization header on the
// WebSocket upgrade. Optional CF_WORKER_PROXY_PORT overrides the local bind
// port (default 8877).

import net from 'net';
import dns from 'dns/promises';
import { spawnSync } from 'child_process';
import { URL } from 'url';
import WebSocket from 'ws';
import { consoleLogger } from './logs.js';
import { parseBooleanValue } from './envUtils.js';

const PORT_HUNT_MAX_ATTEMPTS = 20;

// Sync probe used at module init to pick a free local port before net.Server
// binds. Node has no sync socket API, so we shell out to lsof (POSIX) or
// netstat (Windows). Async EADDRINUSE from server.listen() still acts as a
// safety net for the TOCTOU window between probe and bind.
function isPortInUse(port: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-an', '-p', 'tcp'], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
      });
      if (out.error || out.status !== 0 || !out.stdout) return false;
      return new RegExp(`[:.]${port}\\s+.*LISTENING`, 'i').test(out.stdout);
    }
    const out = spawnSync('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    return out.status === 0 && !!(out.stdout && out.stdout.trim());
  } catch {
    return false;
  }
}

function findFreePort(startPort: number, maxAttempts: number = PORT_HUNT_MAX_ATTEMPTS): number {
  for (let i = 0; i < maxAttempts; i++) {
    const p = startPort + i;
    if (!isPortInUse(p)) return p;
  }
  throw new Error(
    `[cfProxyWorker] No free local port found in range ${startPort}-${startPort + maxAttempts - 1}`,
  );
}

// Worker-side runtime config: bypass IP ranges + upstream-proxy hostname
// allowlist. Both are maintained on the worker side as the single source of
// truth and fetched lazily via `?bypass-ips=1`. The response shape is
// `{ bypassRanges, upstreamHosts }`; a legacy array response (older worker
// deploys) is treated as `{ bypassRanges: [...], upstreamHosts: [] }`.
interface WorkerConfig {
  bypassRanges: string[];
  upstreamHosts: string[];
}
let workerConfigPromise: Promise<WorkerConfig> | null = null;

async function fetchWorkerConfig(workerUrl: string, authToken?: string): Promise<WorkerConfig> {
  const httpUrl = new URL(workerUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'));
  httpUrl.searchParams.set('bypass-ips', '1');
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = authToken;
  const res = await fetch(httpUrl.toString(), { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data)) {
    return {
      bypassRanges: data.filter((x): x is string => typeof x === 'string'),
      upstreamHosts: [],
    };
  }
  if (data && typeof data === 'object') {
    const obj = data as { bypassRanges?: unknown; upstreamHosts?: unknown };
    const bypassRanges = Array.isArray(obj.bypassRanges)
      ? obj.bypassRanges.filter((x): x is string => typeof x === 'string')
      : [];
    const upstreamHosts = Array.isArray(obj.upstreamHosts)
      ? obj.upstreamHosts.filter((x): x is string => typeof x === 'string')
      : [];
    return { bypassRanges, upstreamHosts };
  }
  throw new Error('unexpected response shape');
}

function getWorkerConfig(workerUrl: string, authToken?: string): Promise<WorkerConfig> {
  if (!workerConfigPromise) {
    workerConfigPromise = fetchWorkerConfig(workerUrl, authToken)
      .then((cfg) => {
        consoleLogger.info(
          `[cfProxyWorker] Loaded worker config: ${cfg.bypassRanges.length} bypass range(s), ${cfg.upstreamHosts.length} force-tunnel host pattern(s)`,
        );
        return cfg;
      })
      .catch((err) => {
        consoleLogger.warn(
          `[cfProxyWorker] Failed to fetch worker config: ${(err as Error).message}`,
        );
        workerConfigPromise = null; // allow retry on next connection
        return { bypassRanges: [], upstreamHosts: [] };
      });
  }
  return workerConfigPromise;
}

function cidrMatch(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const ipBytes = ipToBytes(ip);
  const rangeBytes = ipToBytes(range);
  if (!ipBytes || !rangeBytes || ipBytes.length !== rangeBytes.length) return false;
  const fullBytes = bits >> 3;
  const remBits = bits & 7;
  for (let i = 0; i < fullBytes; i++) if (ipBytes[i] !== rangeBytes[i]) return false;
  if (remBits === 0) return true;
  const mask = 0xff << (8 - remBits) & 0xff;
  return (ipBytes[fullBytes] & mask) === (rangeBytes[fullBytes] & mask);
}

// Strict decimal octets only. Number('0177') is 177 but glibc inet_aton /
// getaddrinfo read it as octal 127, so a lenient parse lets `0177.0.0.1` pass
// the internal-range check and then connect to loopback (asgard-0010).
const CANONICAL_OCTET = /^(0|[1-9]\d{0,2})$/;

function parseDottedQuad(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4 || !parts.every((p) => CANONICAL_OCTET.test(p))) return null;
  const bytes = parts.map(Number);
  return bytes.some((n) => n > 255) ? null : bytes;
}

// Hosts made only of decimal/octal/hex numeric labels (`0177.0.0.1`,
// `0x7f.1`, `2130706433`) are not real DNS names (no TLD is all-numeric),
// yet the OS resolver would still turn them into IPs. Refuse them outright
// rather than let them fall through to DNS and dodge the literal guard.
const NUMERIC_HOST = /^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+)){0,3}\.?$/i;

function isNonCanonicalNumericHost(s: string): boolean {
  return NUMERIC_HOST.test(s) && parseDottedQuad(s) === null;
}

function ipToBytes(ip: string): number[] | null {
  // Pure IPv4 dotted-quad (no colons anywhere).
  if (ip.includes('.') && !ip.includes(':')) {
    return parseDottedQuad(ip);
  }
  if (ip.includes(':')) {
    // IPv4-mapped / IPv4-compatible form: the last hextet may be written as
    // a dotted-quad, e.g. `::ffff:127.0.0.1` or `::ffff:192.168.0.0`. Peel
    // that trailing quad off before the hextet parse so the four octets
    // become the last four bytes (matching the wire format). Without this
    // the whole INTERNAL_IP_RANGES table (and any user-provided IPv4-mapped
    // literal in that form) fails to parse and the SSRF guard silently
    // permits internal targets — the exact bug asgard flagged.
    let trailingV4Bytes: number[] | null = null;
    let ipNoV4 = ip;
    const lastColon = ip.lastIndexOf(':');
    const afterLastColon = ip.slice(lastColon + 1);
    if (afterLastColon.includes('.')) {
      trailingV4Bytes = parseDottedQuad(afterLastColon);
      if (!trailingV4Bytes) return null;
      ipNoV4 = ip.slice(0, lastColon);
    }
    // Minimal IPv6 parse (supports :: compression). Two synthetic hextets
    // stand in for the dotted-quad tail so `missing` accounts for it.
    const trailingGroups = trailingV4Bytes ? 2 : 0;
    const [head, tail] = ipNoV4.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const missing = 8 - headParts.length - tailParts.length - trailingGroups;
    if (missing < 0) return null;
    const groups = [...headParts, ...Array(missing).fill('0'), ...tailParts];
    const bytes = [];
    for (const g of groups) {
      const n = parseInt(g || '0', 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
      bytes.push(n >> 8, n & 0xff);
    }
    if (trailingV4Bytes) bytes.push(...trailingV4Bytes);
    if (bytes.length !== 16) return null;
    return bytes;
  }
  return null;
}

function ipInRanges(ip: string, ranges: string[]): boolean {
  for (const cidr of ranges) {
    if (cidr.includes('/') ? cidrMatch(ip, cidr) : ip === cidr) return true;
  }
  return false;
}

function isIpLiteral(s: string): boolean {
  return ipToBytes(s) !== null;
}

// Loopback, private, link-local, and cloud-metadata ranges. A SOCKS5 caller
// that gave us an IP literal skipped DNS resolution entirely, so Family DoH
// filtering never gets a chance to reject internal targets. Match on the
// literal before opening a direct TCP forward.
const INTERNAL_IP_RANGES: string[] = [
  '127.0.0.0/8',        // IPv4 loopback
  '10.0.0.0/8',         // RFC1918
  '172.16.0.0/12',      // RFC1918
  '192.168.0.0/16',     // RFC1918
  '169.254.0.0/16',     // link-local + AWS/GCP/Azure metadata (169.254.169.254)
  '100.64.0.0/10',      // CGNAT
  '0.0.0.0/8',          // this-network
  '192.0.0.0/24',       // IETF protocol assignments + Oracle Cloud legacy metadata (192.0.0.192)
  '::/128',             // IPv6 unspecified — routes to loopback on common OS stacks (asgard-0011)
  '::1/128',            // IPv6 loopback
  'fc00::/7',           // IPv6 ULA
  'fe80::/10',          // IPv6 link-local
  '::ffff:127.0.0.0/104', // IPv4-mapped loopback
  '::ffff:10.0.0.0/104',
  '::ffff:169.254.0.0/112',
  '::ffff:192.168.0.0/112',
  '::ffff:192.0.0.0/120', // IPv4-mapped Oracle Cloud legacy metadata block
];

// asgard-0011: some IPv6 encodings embed an IPv4 destination that our IPv4
// CIDR table would refuse if it appeared bare — but the CIDR table matches
// exact byte-length, so a 16-byte IPv6 literal can never match a 4-byte IPv4
// range. Normalise before matching: for the IPv4-mapped prefix (::ffff:0:0/96)
// and the NAT64 well-known prefix (64:ff9b::/96), extract the embedded IPv4
// and re-check it against the IPv4 half of INTERNAL_IP_RANGES.
function isInternalIp(ip: string): boolean {
  const bytes = ipToBytes(ip);
  if (bytes === null) return false;
  if (ipInRanges(ip, INTERNAL_IP_RANGES)) return true;

  if (bytes.length === 16) {
    const isMapped =
      bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    const isNat64 =
      bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
      bytes.slice(4, 12).every((b) => b === 0);
    // asgard-0010: deprecated IPv4-compatible IPv6 (::a.b.c.d, RFC 4291
    // §2.5.5.1): high 96 bits zero but *without* the ::ffff mapped-address
    // marker in bytes[10..11]. Still normalise the embedded IPv4 and refuse
    // if it lands in an internal range, closing the allowlist gap on
    // network stacks that continue to route these legacy addresses.
    const isCompat = bytes.slice(0, 12).every((b) => b === 0);
    if (isMapped || isNat64 || isCompat) {
      const embedded = bytes.slice(12).join('.');
      if (ipInRanges(embedded, INTERNAL_IP_RANGES)) return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// Force-tunnel allowlist.
// -----------------------------------------------------------------------------
// The worker's bypass-IP list (?bypass-ips=1) short-circuits the tunnel for
// hosts resolving into it — with BYPASS_CLOUDFLARE=true that includes every
// CF-fronted target. But the worker also has its own INCLUDE_PROXY_FOR_UPSTREAM
// allowlist that only takes effect if the request actually reaches the worker.
// Hostnames matched here escape the client-side bypass check so they reach the
// worker and can be routed through the upstream proxy.
//
// Source of truth: the worker publishes its INCLUDE_PROXY_FOR_UPSTREAM list in
// the `?bypass-ips=1` response (`upstreamHosts`). CF_WORKER_PROXY_FORCE_TUNNEL_HOSTS
// remains as an optional override (comma/semicolon separated glob list) — set
// it to bypass the worker-supplied list for testing or emergencies.

function compileGlobs(patterns: string[]): RegExp[] {
  return patterns
    .map((s) => s.trim())
    .filter(Boolean)
    .map(
      (pattern) =>
        new RegExp(
          '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
          'i',
        ),
    );
}

let forceTunnelOverrideCache: RegExp[] | null | undefined;
function getForceTunnelOverride(): RegExp[] | null {
  if (forceTunnelOverrideCache !== undefined) return forceTunnelOverrideCache;
  const raw = process.env.CF_WORKER_PROXY_FORCE_TUNNEL_HOSTS?.trim();
  if (!raw) {
    forceTunnelOverrideCache = null;
    return null;
  }
  forceTunnelOverrideCache = compileGlobs(raw.split(/[,;]/));
  return forceTunnelOverrideCache;
}

function shouldForceTunnel(hostname: string, upstreamHosts: string[]): boolean {
  const override = getForceTunnelOverride();
  const regexes = override ?? compileGlobs(upstreamHosts);
  if (regexes.length === 0) return false;
  return regexes.some((re) => re.test(hostname));
}

// -----------------------------------------------------------------------------
// Family DoH egress filtering.
// -----------------------------------------------------------------------------
// Chrome's DoH policy is disabled whenever a proxy is configured, so an
// enterprise policy pointing at a family resolver does nothing once the SOCKS
// tunnel is in play. To keep the family filter effective we resolve hostnames
// here (before the tunnel handoff) and refuse the connection if Family DNS
// returned the sentinel blocked address.
//
// Enable with env var FAMILY_DNS=1. When enabled alongside CF_WORKER_PROXY,
// the resolved IP is also what we hand to the worker instead of the original
// hostname, so the worker's connect() doesn't re-resolve via Cloudflare's
// default (non-filtered) resolver. TLS SNI still terminates end-to-end at the
// browser, so the target sees the original hostname on the wire.
//
// FAMILY_DNS is also honoured standalone: if it is set but CF_WORKER_PROXY
// is not, oobee starts a local SOCKS5 proxy that resolves via Family DoH and
// forwards directly (no WebSocket tunnel). See startFamilyDnsLocalProxy().

// All endpoints speak RFC 8484 wireformat (application/dns-message). Only
// Cloudflare also offers the JSON API, so wireformat is the one protocol the
// whole provider list has in common.
const DOH_CONTENT_TYPE = 'application/dns-message';
const DOH_QUERY_TIMEOUT_MS = 5000;
const DOH_MAX_RESPONSE_BYTES = 4096;
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;
const DNS_CLASS_IN = 1;

const DOH_CACHE_TTL_MS = 60 * 1000;
// Short TTL for the "every provider was unreachable" case, so a transient blip
// does not pin a hostname to failure for a full minute, while still absorbing
// the burst of connections Chromium opens for a single page.
const DOH_UNREACHABLE_CACHE_TTL_MS = 5 * 1000;
const FAMILY_BLOCKED_V4 = '0.0.0.0';
const FAMILY_BLOCKED_V6 = '::';

interface FamilyDohProvider {
  name: string;
  endpoint: string;
  // Addresses this provider returns to mean "filtered". Most null-route to the
  // canonical 0.0.0.0 / ::, but AdGuard answers adult-content blocks with the
  // IP of its own block page, so a bare sentinel check would fail open and let
  // the scan connect to that page as if it were the real site.
  blockedAddresses?: readonly string[];
}

// Tried in order; each is a failover for when the ones before it are
// unreachable. A single family resolver is a single point of failure — an
// outage at the primary takes every scan down with ERR_NAME_NOT_RESOLVED,
// because Chromium has no system-DNS fallback once name resolution is
// delegated to the proxy.
const FAMILY_DOH_PROVIDERS: readonly FamilyDohProvider[] = [
  { name: 'cloudflare', endpoint: 'https://family.cloudflare-dns.com/dns-query' },
  { name: 'controld', endpoint: 'https://freedns.controld.com/family' },
  {
    name: 'adguard',
    endpoint: 'https://family.adguard-dns.com/dns-query',
    blockedAddresses: ['94.140.14.35', '94.140.14.36'],
  },
];

// Either the endpoint answered (ip may be null for NXDOMAIN / no address
// record) or it did not answer at all. Only the latter is worth failing over
// on: a provider that says "no such name" has given a real answer, and asking
// the next one cannot turn a nonexistent hostname into a real one.
type DohLookup = { answered: true; ip: string | null } | { answered: false };

const DOH_NO_ANSWER: DohLookup = { answered: false };

interface DohCacheEntry {
  ip: string | null; // null = lookup failed; sentinel = family-blocked
  expiresAt: number;
}

// asgard-0009: the cache key is the SOCKS5 CONNECT hostname, which a scanned
// page controls (e.g. thousands of random subdomains). Bound the cache so it
// can't grow for the lifetime of the process:
//  - expired entries are dropped on read, and swept when the cache is full;
//  - a hard cap evicts the least recently used entry (Map keeps insertion
//    order, and hits are re-inserted so they move to the end).
// 4096 entries is far more than a scan's real working set within the 60s TTL.
export const DOH_CACHE_MAX_ENTRIES = 4096;

export class BoundedTtlCache<V extends { expiresAt: number }> {
  private readonly map = new Map<string, V>();

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    if (entry.expiresAt <= now) return undefined;
    this.map.set(key, entry); // mark as most recently used
    return entry;
  }

  set(key: string, entry: V, now: number = Date.now()): void {
    this.map.delete(key);
    if (this.map.size >= this.maxEntries) {
      for (const [k, v] of this.map) {
        if (v.expiresAt <= now) this.map.delete(k);
      }
      while (this.map.size >= this.maxEntries) {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) break;
        this.map.delete(oldest);
      }
    }
    this.map.set(key, entry);
  }

  clear(): void {
    this.map.clear();
  }
}

const dohCache = new BoundedTtlCache<DohCacheEntry>(DOH_CACHE_MAX_ENTRIES);

// Test hooks: observe and reset the module-level cache.
export const getDohCacheSize = (): number => dohCache.size;
export const clearDohCache = (): void => dohCache.clear();

// Backwards compatibility: CF_FAMILY_DNS was the original name. It is still
// honoured, and gets the same multi-provider failover as FAMILY_DNS. If both
// are set, FAMILY_DNS wins (so FAMILY_DNS=0 can switch off a legacy
// CF_FAMILY_DNS=1 inherited from an older image or wrapper).
let legacyFamilyDnsWarned = false;

export function isFamilyDnsEnabled(): boolean {
  // A blank / whitespace-only value counts as unset, so FAMILY_DNS="" disables
  // the filter rather than tripping a bare presence check.
  const raw = process.env.FAMILY_DNS;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return parseBooleanValue(raw) ?? false;
  }
  const legacy = process.env.CF_FAMILY_DNS;
  if (typeof legacy !== 'string' || legacy.trim() === '') return false;
  const enabled = parseBooleanValue(legacy) ?? false;
  if (enabled && !legacyFamilyDnsWarned) {
    legacyFamilyDnsWarned = true;
    consoleLogger.info(
      '[familyDns] CF_FAMILY_DNS is deprecated; use FAMILY_DNS instead. Multi-provider failover is applied either way.',
    );
  }
  return enabled;
}

let includeProxyPatternsCache: RegExp[] | null | undefined;
function getIncludeProxyPatterns(): RegExp[] | null {
  if (includeProxyPatternsCache !== undefined) return includeProxyPatternsCache;
  const raw = process.env.INCLUDE_PROXY?.trim();
  if (!raw) {
    includeProxyPatternsCache = null;
    return null;
  }
  includeProxyPatternsCache = compileGlobs(raw.split(/[,;]/));
  return includeProxyPatternsCache;
}

function isIncludedForUpstream(hostname: string): boolean | null {
  const patterns = getIncludeProxyPatterns();
  if (!patterns || patterns.length === 0) return null;
  return patterns.some((re) => re.test(hostname));
}

/**
 * Encode a single-question DNS query in RFC 1035 wireformat.
 * Returns null for anything that isn't a plain resolvable hostname — the name
 * arrives from an untrusted SOCKS5 request, so it is validated at this boundary
 * rather than trusted into the encoder.
 */
function encodeDnsQuery(hostname: string, type: number): Buffer | null {
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.?$/.test(hostname)) {
    return null;
  }
  const labels = hostname.replace(/\.$/, '').split('.');
  if (labels.length === 0) return null;

  const header = Buffer.alloc(12);
  // Transaction ID stays 0: over HTTPS the request/response pairing already
  // binds the answer to the question, and a fixed ID keeps GET URLs cacheable.
  header.writeUInt16BE(0x0100, 2); // RD (recursion desired)
  header.writeUInt16BE(1, 4); // QDCOUNT
  const parts: Buffer[] = [header];

  for (const label of labels) {
    const encoded = Buffer.from(label, 'ascii');
    if (encoded.length === 0 || encoded.length > 63) return null;
    parts.push(Buffer.from([encoded.length]), encoded);
  }
  parts.push(Buffer.from([0])); // root label

  const question = Buffer.alloc(4);
  question.writeUInt16BE(type, 0);
  question.writeUInt16BE(DNS_CLASS_IN, 2);
  parts.push(question);

  const message = Buffer.concat(parts);
  return message.length > 512 ? null : message;
}

function formatIpv4(rdata: Buffer): string {
  return Array.from(rdata).join('.');
}

function formatIpv6(rdata: Buffer): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(rdata.readUInt16BE(i));

  // Collapse the longest zero run (RFC 5952 §4.2). This is what canonicalises
  // an all-zero answer to '::' — the exact string FAMILY_BLOCKED_V6 compares
  // against, so a blocked AAAA must not be emitted as '0:0:0:0:0:0:0:0'.
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === 0) {
      if (runStart === -1) runStart = i;
      runLen++;
      if (runLen > bestLen) {
        bestStart = runStart;
        bestLen = runLen;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }

  const hex = groups.map(group => group.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/**
 * Extract the first A / AAAA address from a wireformat DNS response.
 * Every read is bounds-checked: the buffer is attacker-influenced (a scanned
 * page picks the hostname, and a hostile resolver could return a malformed
 * message), so a truncated or lying length field must not read out of range.
 */
function decodeDnsAnswer(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if ((buf.readUInt16BE(2) & 0x0f) !== 0) return null; // non-zero RCODE

  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  let offset = 12;

  const skipName = (): boolean => {
    // A legal name is at most 255 bytes, so the label walk is hard-bounded to
    // stop a crafted response from looping here.
    for (let guard = 0; guard <= 128; guard++) {
      if (offset >= buf.length) return false;
      const len = buf[offset];
      if (len === 0) {
        offset += 1;
        return true;
      }
      if ((len & 0xc0) === 0xc0) {
        offset += 2; // compression pointer terminates the name
        return offset <= buf.length;
      }
      if (len > 63) return false;
      offset += 1 + len;
    }
    return false;
  };

  for (let i = 0; i < qdCount; i++) {
    if (!skipName()) return null;
    offset += 4; // QTYPE + QCLASS
    if (offset > buf.length) return null;
  }

  for (let i = 0; i < anCount; i++) {
    if (!skipName()) return null;
    if (offset + 10 > buf.length) return null;
    const type = buf.readUInt16BE(offset);
    const rdLength = buf.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdLength > buf.length) return null;
    const rdata = buf.subarray(offset, offset + rdLength);
    offset += rdLength;
    if (type === DNS_TYPE_A && rdLength === 4) return formatIpv4(rdata);
    if (type === DNS_TYPE_AAAA && rdLength === 16) return formatIpv6(rdata);
    // Anything else (CNAME, SOA, ...) — keep walking to the address record.
  }
  return null;
}

async function queryDoh(
  endpoint: string,
  hostname: string,
  type: 'A' | 'AAAA',
): Promise<DohLookup> {
  const query = encodeDnsQuery(hostname, type === 'A' ? DNS_TYPE_A : DNS_TYPE_AAAA);
  // A malformed hostname is not the endpoint's fault, so report it as answered
  // to stop the caller from walking every provider for a name none can encode.
  if (!query) return { answered: true, ip: null };

  const url = `${endpoint}?dns=${query.toString('base64url').replace(/=+$/, '')}`;
  try {
    // Without a timeout an unresponsive resolver hangs the lookup instead of
    // failing over — which is the whole point of having a provider list.
    const res = await fetch(url, {
      headers: { Accept: DOH_CONTENT_TYPE },
      signal: AbortSignal.timeout(DOH_QUERY_TIMEOUT_MS),
    });
    if (!res.ok) return DOH_NO_ANSWER;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > DOH_MAX_RESPONSE_BYTES) return DOH_NO_ANSWER;
    const decoded = decodeDnsAnswer(body);
    // decodeDnsAnswer returns null for both NXDOMAIN and "no address record".
    // Both are real answers, so neither should trigger failover.
    return { answered: true, ip: decoded };
  } catch {
    return DOH_NO_ANSWER;
  }
}

export async function resolveViaFamilyDoH(hostname: string): Promise<string | null> {
  const now = Date.now();
  const cached = dohCache.get(hostname, now);
  if (cached) return cached.ip;

  let ip: string | null = null;
  let anyProviderAnswered = false;

  for (const provider of FAMILY_DOH_PROVIDERS) {
    const { endpoint, blockedAddresses } = provider;
    // Normalise a provider-specific block address to the canonical sentinel so
    // every caller keeps comparing against FAMILY_BLOCKED_V4 / _V6.
    const normalise = (address: string): string =>
      blockedAddresses?.includes(address) ? FAMILY_BLOCKED_V4 : address;

    const a = await queryDoh(endpoint, hostname, 'A');
    if (!a.answered) {
      consoleLogger.info(
        `[familyDns] ${provider.name} did not answer for ${hostname}; trying next provider`,
      );
      continue;
    }
    anyProviderAnswered = true;

    if (a.ip) {
      // A sentinel is a successful filtered answer, not a failure. Stop here so
      // the next provider — whose blocklist differs — cannot weaken the verdict.
      ip = normalise(a.ip);
      break;
    }

    const aaaa = await queryDoh(endpoint, hostname, 'AAAA');
    if (!aaaa.answered) {
      consoleLogger.info(
        `[familyDns] ${provider.name} did not answer AAAA for ${hostname}; trying next provider`,
      );
      continue;
    }
    if (aaaa.ip) {
      ip = normalise(aaaa.ip); // may be '::' (blocked) — caller distinguishes
      break;
    }

    // The provider answered both queries with no address: the name does not
    // resolve. Another provider cannot change that, so stop and fail closed.
    break;
  }

  dohCache.set(
    hostname,
    {
      ip,
      expiresAt: now + (anyProviderAnswered ? DOH_CACHE_TTL_MS : DOH_UNREACHABLE_CACHE_TTL_MS),
    },
    now,
  );
  return ip;
}

async function resolveHostname(
  hostname: string,
  bypassRanges: string[],
): Promise<{ ip: string; bypass: boolean; blocked: boolean } | null> {
  // The SOCKS5 client may have already resolved DNS locally and passed an IP
  // literal (atyp 0x01/0x04). Skip DNS in that case and check the list directly.
  //
  // Setting ``blocked: isInternalIp(hostname)`` here (instead of a hard-coded
  // ``false``) plugs the SSRF gap in the caller: a scanned page that hands the
  // proxy ``169.254.169.254`` or ``127.0.0.1`` via SOCKS would otherwise be
  // direct-forwarded on the bypass and INCLUDE_PROXY branches, letting the
  // driven browser reach cloud-metadata / loopback services. handleSocks5
  // already treats ``blocked`` as a refusal (0x02) so both branches inherit
  // the guard the sibling handleSocks5FamilyLocal already applies.
  if (isNonCanonicalNumericHost(hostname)) {
    return { ip: hostname, bypass: false, blocked: true };
  }
  if (isIpLiteral(hostname)) {
    return {
      ip: hostname,
      bypass: ipInRanges(hostname, bypassRanges),
      blocked: isInternalIp(hostname),
    };
  }

  // Wraps a DNS-resolved address in the same block-if-internal contract as
  // the IP-literal path. Handles the DNS-rebinding case where a hostile
  // hostname resolves into internal / metadata address space.
  const wrapResolved = (
    ip: string,
    bypass: boolean,
  ): { ip: string; bypass: boolean; blocked: boolean } => {
    if (isInternalIp(ip)) {
      consoleLogger.info(
        `[cfProxyWorker] Refusing ${hostname}: resolved to internal ${ip}`,
      );
      return { ip, bypass: false, blocked: true };
    }
    return { ip, bypass, blocked: false };
  };

  if (isFamilyDnsEnabled()) {
    const ip = await resolveViaFamilyDoH(hostname);
    if (ip === FAMILY_BLOCKED_V4 || ip === FAMILY_BLOCKED_V6) {
      consoleLogger.info(`[cfProxyWorker] Family DNS blocked ${hostname} (${ip})`);
      return { ip, bypass: false, blocked: true };
    }
    if (!ip) {
      consoleLogger.warn(`[cfProxyWorker] Family DoH resolution failed for ${hostname}`);
      return null;
    }
    if (ipInRanges(ip, bypassRanges)) {
      consoleLogger.info(`[cfProxyWorker] Bypass IP matched ${ip} for ${hostname}`);
      return wrapResolved(ip, true);
    }
    return wrapResolved(ip, false);
  }

  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      if (ipInRanges(addr, bypassRanges)) {
        consoleLogger.info(`[cfProxyWorker] Bypass IP matched ${addr} for ${hostname}`);
        return wrapResolved(addr, true);
      }
    }
    if (addresses.length > 0) {
      return wrapResolved(addresses[0], false);
    }
  } catch (e) {
    // IPv4 failed, try IPv6
    try {
      const addresses = await dns.resolve6(hostname);
      for (const addr of addresses) {
        if (ipInRanges(addr, bypassRanges)) {
          consoleLogger.info(`[cfProxyWorker] Bypass IPv6 matched ${addr} for ${hostname}`);
          return wrapResolved(addr, true);
        }
      }
      if (addresses.length > 0) {
        return wrapResolved(addresses[0], false);
      }
    } catch (err) {
      consoleLogger.warn(`[cfProxyWorker] DNS resolution failed for ${hostname}: ${(err as Error).message}`);
    }
  }
  return null;
}

export interface CfProxyWorker {
  server: string; // e.g. socks5://127.0.0.1:8877
  port: number;
  stop: () => Promise<void>;
}

let cached: CfProxyWorker | null = null;

function buildWsUrl(workerUrl: string): string {
  const workerHttp = new URL(
    workerUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'),
  );
  const scheme = workerHttp.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${workerHttp.host}${workerHttp.pathname}${workerHttp.search}`;
}

function socksReply(rep: number): Buffer {
  // VER=5, REP, RSV=0, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function readExact(socket: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      socket.off('readable', onReadable);
      socket.off('end', onEnd);
      socket.off('error', onErr);
    };
    const onReadable = () => {
      let chunk: Buffer | null;
      while (total < n && (chunk = socket.read(n - total) as Buffer | null)) {
        chunks.push(chunk);
        total += chunk.length;
      }
      if (total >= n) {
        cleanup();
        resolve(Buffer.concat(chunks));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('EOF'));
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    socket.on('readable', onReadable);
    socket.on('end', onEnd);
    socket.on('error', onErr);
    onReadable();
  });
}

// Read the SOCKS5 greeting + CONNECT request from `clientSocket`. On success
// returns { hostname, port }; on any protocol error or unsupported command it
// writes the appropriate SOCKS reply, ends/destroys the socket, and returns
// null. Only CONNECT (0x01) is supported; ATYPs 0x01/0x03/0x04 are accepted.
async function readSocks5Request(
  clientSocket: net.Socket,
): Promise<{ hostname: string; port: number } | null> {
  try {
    const greet = await readExact(clientSocket, 2);
    if (greet[0] !== 0x05) {
      clientSocket.destroy();
      return null;
    }
    await readExact(clientSocket, greet[1]); // discard methods
    clientSocket.write(Buffer.from([0x05, 0x00])); // NO AUTH

    const head = await readExact(clientSocket, 4);
    if (head[0] !== 0x05) {
      clientSocket.destroy();
      return null;
    }
    if (head[1] !== 0x01) {
      clientSocket.write(socksReply(0x07)); // command not supported
      clientSocket.end();
      return null;
    }
    const atyp = head[3];
    let hostname: string;
    if (atyp === 0x01) {
      hostname = Array.from(await readExact(clientSocket, 4)).join('.');
    } else if (atyp === 0x03) {
      const l = (await readExact(clientSocket, 1))[0];
      hostname = (await readExact(clientSocket, l)).toString('utf8');
    } else if (atyp === 0x04) {
      const b = await readExact(clientSocket, 16);
      const parts: string[] = [];
      for (let i = 0; i < 8; i++) parts.push(b.readUInt16BE(i * 2).toString(16));
      hostname = parts.join(':');
    } else {
      clientSocket.write(socksReply(0x08));
      clientSocket.end();
      return null;
    }
    const port = (await readExact(clientSocket, 2)).readUInt16BE(0);
    return { hostname, port };
  } catch {
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return null;
  }
}

// Direct TCP forward: open a socket to `ip:port` and bidirectionally pipe
// bytes to `clientSocket`. Writes the SOCKS success reply once connected and
// wires up error/close propagation both ways. `label` is used for logging
// only (typically the original hostname so log lines stay meaningful).
function directForward(
  clientSocket: net.Socket,
  ip: string,
  port: number,
  label: string,
): void {
  const directSocket = net.createConnection({ host: ip, port }, () => {
    try {
      clientSocket.write(socksReply(0x00));
      clientSocket.resume();
      directSocket.pipe(clientSocket);
      clientSocket.pipe(directSocket);
    } catch {
      directSocket.destroy();
    }
  });

  directSocket.on('error', (err) => {
    consoleLogger.debug(`[cfProxyWorker] Direct connection failed for ${label}: ${err.message}`);
    if (directSocket.connecting) {
      try { clientSocket.write(socksReply(0x05)); } catch {} // connection refused
    }
    try { clientSocket.end(); } catch {}
  });
  directSocket.on('close', () => {
    try { clientSocket.end(); } catch {}
  });
  clientSocket.on('close', () => {
    try { directSocket.destroy(); } catch {}
  });
  clientSocket.on('error', () => {
    try { directSocket.destroy(); } catch {}
  });
}

async function handleSocks5(
  clientSocket: net.Socket,
  wsUrl: string,
  workerUrl: string,
  authToken: string | undefined,
): Promise<void> {
  clientSocket.on('error', () => {
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
  });

  const req = await readSocks5Request(clientSocket);
  if (!req) return;
  const { hostname, port } = req;

  const workerCfg = await getWorkerConfig(workerUrl, authToken);

  // Pin the address that the worker connects to. When the client resolved and
  // validated the hostname above, we forward that exact IP to the worker so
  // its cloudflare:sockets connect() does not re-resolve the untrusted hostname
  // (a second resolution would allow DNS-rebinding an attacker-controlled name
  // from a passing public IP into an internal / metadata address between the
  // client's check and the worker's connect — CWE-350/CWE-367). For the
  // force-tunnel path we intentionally have no pinned IP: those hosts must
  // reach the worker's INCLUDE_PROXY_FOR_UPSTREAM logic (which routes by
  // hostname to an upstream proxy) and are additionally subject to the worker
  // ACLs, so no client-side IP is meaningful.
  let pinnedIp: string | undefined;

  // Force-tunnel allowlist: skip bypass/DoH checks so the hostname reaches
  // the worker where INCLUDE_PROXY_FOR_UPSTREAM can route it via the upstream
  // proxy. Worker handles resolution and any blocking on its side.
  if (!isIpLiteral(hostname) && shouldForceTunnel(hostname, workerCfg.upstreamHosts)) {
    // asgard-0016 (2026-10-09 scan): this branch skips resolveHostname(), so
    // the local internal/metadata refusal never ran. Resolve locally and
    // refuse if any answer is internal. A local lookup failure is not a
    // refusal: upstream-routed hosts may only resolve on the Worker side.
    let localAddrs: string[] = [];
    try {
      localAddrs = (await dns.lookup(hostname, { all: true })).map(a => a.address);
    } catch {
      localAddrs = [];
    }
    if (localAddrs.some(a => isInternalIp(a))) {
      consoleLogger.warn(`[cfProxyWorker] Refusing force-tunnel to ${hostname} — resolves to an internal address`);
      clientSocket.write(socksReply(0x02)); // connection not allowed by ruleset
      clientSocket.end();
      return;
    }
    consoleLogger.info(`[cfProxyWorker] Force-tunnel match for ${hostname} — sending to Worker`);
  } else {
    const resolution = await resolveHostname(hostname, workerCfg.bypassRanges);
    if (!resolution) {
      consoleLogger.warn(`[cfProxyWorker] Failed to resolve hostname: ${hostname}`);
      clientSocket.write(socksReply(0x04)); // host unreachable
      clientSocket.end();
      return;
    }
    if (resolution.blocked) {
      consoleLogger.info(`[cfProxyWorker] Refusing SOCKS connect to ${hostname} — blocked by Family DNS`);
      clientSocket.write(socksReply(0x02)); // connection not allowed by ruleset
      clientSocket.end();
      return;
    }

    pinnedIp = resolution.ip;

    // Bypass listed ranges - transparently forward TCP connection using Node's net module
    if (resolution.bypass) {
      consoleLogger.info(`[cfProxyWorker] Bypassing Worker for ${hostname} (${resolution.ip}) - connecting directly`);
      directForward(clientSocket, resolution.ip, port, hostname);
      return;
    }

    // INCLUDE_PROXY: when set, only listed hostnames go via the Worker upstream.
    // Non-listed hosts still get Family DNS filtering above (universally) and
    // are then forwarded directly without the worker tunnel.
    const included = isIncludedForUpstream(hostname);
    if (included === false) {
      consoleLogger.info(`[cfProxyWorker] ${hostname} not in INCLUDE_PROXY - forwarding directly`);
      directForward(clientSocket, resolution.ip, port, hostname);
      return;
    }
  }

  const wsHeaders = authToken ? { Authorization: authToken } : undefined;
  const ws = new WebSocket(wsUrl, { headers: wsHeaders });
  ws.binaryType = 'arraybuffer';

  let ready = false;
  const preBuffer: Buffer[] = [];

  // Send the original hostname (for the worker's INCLUDE_PROXY_FOR_UPSTREAM
  // routing decision) alongside the client-validated pinned IP. Compatible
  // workers connect() to `ip` when present, avoiding a second DNS resolution;
  // legacy workers that ignore `ip` fall back to hostname-based connect().
  ws.on('open', () => {
    ws.send(JSON.stringify({ hostname, port, ip: pinnedIp }));
  });

  ws.on('message', (data: WebSocket.RawData) => {
    if (!ready) {
      let msg: { type?: string } | null;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        msg = null;
      }
      if (msg && msg.type === 'ready') {
        ready = true;
        clientSocket.write(socksReply(0x00));
        for (const chunk of preBuffer) ws.send(chunk);
        preBuffer.length = 0;
      } else {
        try {
          clientSocket.write(socksReply(0x01));
        } catch {
          /* ignore */
        }
        try {
          clientSocket.end();
        } catch {
          /* ignore */
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(String(data));
    clientSocket.write(buf);
  });

  ws.on('close', () => {
    try {
      clientSocket.end();
    } catch {
      /* ignore */
    }
  });
  ws.on('error', () => {
    if (!ready) {
      try {
        clientSocket.write(socksReply(0x05)); // connection refused
      } catch {
        /* ignore */
      }
    }
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
  });

  clientSocket.on('data', (chunk: Buffer) => {
    if (ready && ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    } else {
      preBuffer.push(chunk);
    }
  });
  clientSocket.on('close', () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

/**
 * Start (or return the existing) local SOCKS5 tunnel to the Cloudflare Worker.
 * Returns null when CF_WORKER_PROXY is not set.
 */
export function startCfProxyWorker(): CfProxyWorker | null {
  const workerUrl = process.env.CF_WORKER_PROXY?.trim();
  if (!workerUrl) return null;
  if (cached) return cached;

  const authToken = process.env.CF_WORKER_PROXY_AUTH_TOKEN?.trim() || undefined;
  const requestedPort = parseInt(process.env.CF_WORKER_PROXY_PORT || '8877', 10);
  const port = findFreePort(requestedPort);
  if (port !== requestedPort) {
    consoleLogger.info(
      `[cfProxyWorker] Port ${requestedPort} in use; falling back to ${port}`,
    );
  }
  const wsUrl = buildWsUrl(workerUrl);

  // Warm the worker-config cache so the first connection doesn't pay the fetch latency.
  void getWorkerConfig(workerUrl, authToken);

  const server = net.createServer(socket => {
    handleSocks5(socket, wsUrl, workerUrl, authToken).catch(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  });

  // Async retry loop: the sync probe above narrows the TOCTOU window but does
  // not eliminate it. If bind still fails with EADDRINUSE, walk up ports.
  let listenAttempts = 0;
  const onBindError = (err: NodeJS.ErrnoException): void => {
    const p = cached?.port ?? port;
    if (err.code === 'EADDRINUSE' && listenAttempts < PORT_HUNT_MAX_ATTEMPTS) {
      consoleLogger.warn(
        `[cfProxyWorker] Port ${p} raced (EADDRINUSE); retrying on ${p + 1}`,
      );
      if (cached) {
        cached.port = p + 1;
        cached.server = `socks5://127.0.0.1:${p + 1}`;
      }
      attemptListen(p + 1);
      return;
    }
    consoleLogger.error(`[cfProxyWorker] SOCKS5 server error: ${err.message}`);
  };
  const attemptListen = (p: number): void => {
    listenAttempts++;
    server.once('error', onBindError);
    server.listen(p, '127.0.0.1', () => {
      server.off('error', onBindError);
      server.on('error', (err: Error) => {
        consoleLogger.error(`[cfProxyWorker] SOCKS5 server error: ${err.message}`);
      });
      consoleLogger.info(
        `[cfProxyWorker] SOCKS5 tunnel listening on 127.0.0.1:${p} -> ${wsUrl}`,
      );
    });
  };
  attemptListen(port);

  cached = {
    server: `socks5://127.0.0.1:${port}`,
    port,
    stop: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        cached = null;
      }),
  };
  return cached;
}

export function isCfProxyWorkerConfigured(): boolean {
  return !!process.env.CF_WORKER_PROXY?.trim();
}

// -----------------------------------------------------------------------------
// Local Family DoH SOCKS5 proxy (used when FAMILY_DNS=1 but CF_WORKER_PROXY
// is unset). Resolves every hostname via Family DoH and forwards
// directly with net.createConnection — no WebSocket, no worker. Blocked names
// return SOCKS reply 0x02 (ruleset denial) just like the worker path.
// -----------------------------------------------------------------------------

async function handleSocks5FamilyLocal(clientSocket: net.Socket): Promise<void> {
  clientSocket.on('error', () => {
    try { clientSocket.destroy(); } catch { /* ignore */ }
  });

  const req = await readSocks5Request(clientSocket);
  if (!req) return;
  const { hostname, port } = req;

  // IP literals bypass DoH — Family filtering only applies to name lookups.
  // Block any literal that points at internal / metadata addresses before
  // opening the direct TCP forward, otherwise a scanned page could pivot the
  // driven browser onto 169.254.169.254 or 127.0.0.1 via a SOCKS request.
  if (isNonCanonicalNumericHost(hostname)) {
    consoleLogger.info(`[familyDnsProxy] Refusing SOCKS connect to non-canonical numeric host ${hostname}`);
    try { clientSocket.write(socksReply(0x02)); } catch { /* ignore */ }
    clientSocket.end();
    return;
  }
  if (isIpLiteral(hostname)) {
    if (isInternalIp(hostname)) {
      consoleLogger.info(`[familyDnsProxy] Refusing SOCKS connect to internal IP literal ${hostname}`);
      try { clientSocket.write(socksReply(0x02)); } catch { /* ignore */ }
      clientSocket.end();
      return;
    }
    directForward(clientSocket, hostname, port, hostname);
    return;
  }

  const ip = await resolveViaFamilyDoH(hostname);
  if (ip === FAMILY_BLOCKED_V4 || ip === FAMILY_BLOCKED_V6) {
    consoleLogger.info(`[familyDnsProxy] Refusing SOCKS connect to ${hostname} — blocked by Family DNS`);
    try { clientSocket.write(socksReply(0x02)); } catch { /* ignore */ }
    clientSocket.end();
    return;
  }
  if (!ip) {
    consoleLogger.warn(`[familyDnsProxy] Family DoH resolution failed for ${hostname}`);
    try { clientSocket.write(socksReply(0x04)); } catch { /* ignore */ }
    clientSocket.end();
    return;
  }
  // Also block DNS-rebinding / metadata-lookalike names that resolve into
  // internal address space after DoH — the DoH resolver upstream would
  // dutifully return the internal answer.
  if (isInternalIp(ip)) {
    consoleLogger.info(`[familyDnsProxy] Refusing SOCKS connect: ${hostname} resolved to internal ${ip}`);
    try { clientSocket.write(socksReply(0x02)); } catch { /* ignore */ }
    clientSocket.end();
    return;
  }
  directForward(clientSocket, ip, port, hostname);
}

let cachedFamilyLocal: CfProxyWorker | null = null;

/**
 * Start (or return the existing) local SOCKS5 proxy that enforces Family DoH
 * filtering with direct TCP egress. Only starts when FAMILY_DNS
 * is set AND CF_WORKER_PROXY is not — when both are set, the worker path in
 * startCfProxyWorker() already applies Family DoH pre-resolution.
 */
export function startFamilyDnsLocalProxy(): CfProxyWorker | null {
  if (!isFamilyDnsLocalProxyConfigured()) return null;
  if (cachedFamilyLocal) return cachedFamilyLocal;

  const requestedPort = parseInt(process.env.CF_WORKER_PROXY_PORT || '8877', 10);
  const port = findFreePort(requestedPort);
  if (port !== requestedPort) {
    consoleLogger.info(
      `[familyDnsProxy] Port ${requestedPort} in use; falling back to ${port}`,
    );
  }

  const server = net.createServer((socket) => {
    handleSocks5FamilyLocal(socket).catch(() => {
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });

  let listenAttempts = 0;
  const onBindError = (err: NodeJS.ErrnoException): void => {
    const p = cachedFamilyLocal?.port ?? port;
    if (err.code === 'EADDRINUSE' && listenAttempts < PORT_HUNT_MAX_ATTEMPTS) {
      consoleLogger.warn(
        `[familyDnsProxy] Port ${p} raced (EADDRINUSE); retrying on ${p + 1}`,
      );
      if (cachedFamilyLocal) {
        cachedFamilyLocal.port = p + 1;
        cachedFamilyLocal.server = `socks5://127.0.0.1:${p + 1}`;
      }
      attemptListen(p + 1);
      return;
    }
    consoleLogger.error(`[familyDnsProxy] SOCKS5 server error: ${err.message}`);
  };
  const attemptListen = (p: number): void => {
    listenAttempts++;
    server.once('error', onBindError);
    server.listen(p, '127.0.0.1', () => {
      server.off('error', onBindError);
      server.on('error', (err: Error) => {
        consoleLogger.error(`[familyDnsProxy] SOCKS5 server error: ${err.message}`);
      });
      consoleLogger.info(
        `[familyDnsProxy] SOCKS5 (Family DoH, direct egress) listening on 127.0.0.1:${p}`,
      );
    });
  };
  attemptListen(port);

  cachedFamilyLocal = {
    server: `socks5://127.0.0.1:${port}`,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        cachedFamilyLocal = null;
      }),
  };
  return cachedFamilyLocal;
}

export function isFamilyDnsLocalProxyConfigured(): boolean {
  return isFamilyDnsEnabled() && !process.env.CF_WORKER_PROXY?.trim();
}
