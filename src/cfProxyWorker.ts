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

// Bypass IP ranges are maintained on the worker side (single source of truth)
// and fetched lazily via `?bypass-ips=1`. Hosts resolving to any of these are
// connected directly rather than tunneled through the worker.
let bypassRangesPromise: Promise<string[]> | null = null;

async function fetchBypassRanges(workerUrl: string, authToken?: string): Promise<string[]> {
  const httpUrl = new URL(workerUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'));
  httpUrl.searchParams.set('bypass-ips', '1');
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = authToken;
  const res = await fetch(httpUrl.toString(), { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('response is not an array');
  return data.filter((x): x is string => typeof x === 'string');
}

function getBypassRanges(workerUrl: string, authToken?: string): Promise<string[]> {
  if (!bypassRangesPromise) {
    bypassRangesPromise = fetchBypassRanges(workerUrl, authToken)
      .then((ranges) => {
        consoleLogger.info(`[cfProxyWorker] Loaded ${ranges.length} bypass IP range(s) from worker`);
        return ranges;
      })
      .catch((err) => {
        consoleLogger.warn(
          `[cfProxyWorker] Failed to fetch bypass IP ranges from worker: ${(err as Error).message}`,
        );
        bypassRangesPromise = null; // allow retry on next connection
        return [];
      });
  }
  return bypassRangesPromise;
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

function ipToBytes(ip: string): number[] | null {
  if (ip.includes('.')) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return parts;
  }
  if (ip.includes(':')) {
    // Minimal IPv6 parse (supports :: compression).
    const [head, tail] = ip.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    const groups = [...headParts, ...Array(missing).fill('0'), ...tailParts];
    const bytes = [];
    for (const g of groups) {
      const n = parseInt(g || '0', 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
      bytes.push(n >> 8, n & 0xff);
    }
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

// -----------------------------------------------------------------------------
// Force-tunnel allowlist.
// -----------------------------------------------------------------------------
// The worker's bypass-IP list (?bypass-ips=1) short-circuits the tunnel for
// hosts resolving into it — with BYPASS_CLOUDFLARE=true that includes every
// CF-fronted target. But the worker also has its own INCLUDE_PROXY_FOR_UPSTREAM
// allowlist that only takes effect if the request actually reaches the worker.
// Hostnames listed here escape the bypass check on the client side so they
// reach the worker and can be routed through the upstream proxy.
//
// Configured via CF_WORKER_PROXY_FORCE_TUNNEL_HOSTS as a comma/semicolon
// separated glob list. Patterns support '*' wildcards.

let forceTunnelRegexesCache: RegExp[] | null = null;
function getForceTunnelRegexes(): RegExp[] {
  if (forceTunnelRegexesCache !== null) return forceTunnelRegexesCache;
  const raw = process.env.CF_WORKER_PROXY_FORCE_TUNNEL_HOSTS?.trim();
  if (!raw) {
    forceTunnelRegexesCache = [];
    return forceTunnelRegexesCache;
  }
  forceTunnelRegexesCache = raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(
      (pattern) =>
        new RegExp(
          '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
          'i',
        ),
    );
  return forceTunnelRegexesCache;
}

function shouldForceTunnel(hostname: string): boolean {
  const regexes = getForceTunnelRegexes();
  if (regexes.length === 0) return false;
  return regexes.some((re) => re.test(hostname));
}

// -----------------------------------------------------------------------------
// Cloudflare Family DoH egress filtering.
// -----------------------------------------------------------------------------
// Chrome's DoH policy is disabled whenever a proxy is configured, so the
// enterprise policy pointing at family.cloudflare-dns.com does nothing once the
// SOCKS tunnel is in play. To keep the family filter effective we resolve
// hostnames here (before the tunnel handoff) and refuse the connection if
// Family DNS returned the sentinel blocked address.
//
// Enable with env var CF_FAMILY_DNS=1. When enabled alongside CF_WORKER_PROXY,
// the resolved IP is also what we hand to the worker instead of the original
// hostname, so the worker's connect() doesn't re-resolve via Cloudflare's
// default (non-filtered) resolver. TLS SNI still terminates end-to-end at the
// browser, so the target sees the original hostname on the wire.
//
// CF_FAMILY_DNS is also honoured standalone: if it is set but CF_WORKER_PROXY
// is not, oobee starts a local SOCKS5 proxy that resolves via Family DoH and
// forwards directly (no WebSocket tunnel). See startFamilyDnsLocalProxy().

const FAMILY_DOH_ENDPOINT = 'https://family.cloudflare-dns.com/dns-query';
const DOH_CACHE_TTL_MS = 60 * 1000;
const FAMILY_BLOCKED_V4 = '0.0.0.0';
const FAMILY_BLOCKED_V6 = '::';

interface DohCacheEntry {
  ip: string | null; // null = lookup failed; sentinel = family-blocked
  expiresAt: number;
}
const dohCache = new Map<string, DohCacheEntry>();

function isFamilyDnsEnabled(): boolean {
  const v = process.env.CF_FAMILY_DNS?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

async function queryDoh(hostname: string, type: 'A' | 'AAAA'): Promise<string | null> {
  const url = `${FAMILY_DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    if (!Array.isArray(data.Answer)) return null;
    const wantedType = type === 'A' ? 1 : 28;
    for (const ans of data.Answer) {
      if (ans && ans.type === wantedType && typeof ans.data === 'string') return ans.data;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveViaFamilyDoH(hostname: string): Promise<string | null> {
  const now = Date.now();
  const cached = dohCache.get(hostname);
  if (cached && cached.expiresAt > now) return cached.ip;

  let ip: string | null = null;
  const a = await queryDoh(hostname, 'A');
  if (a && a !== FAMILY_BLOCKED_V4) {
    ip = a;
  } else if (a === FAMILY_BLOCKED_V4) {
    ip = FAMILY_BLOCKED_V4;
  } else {
    const aaaa = await queryDoh(hostname, 'AAAA');
    if (aaaa) ip = aaaa; // includes '::' (blocked) — caller distinguishes
  }

  dohCache.set(hostname, { ip, expiresAt: now + DOH_CACHE_TTL_MS });
  return ip;
}

async function resolveHostname(
  hostname: string,
  bypassRanges: string[],
): Promise<{ ip: string; bypass: boolean; blocked: boolean } | null> {
  // The SOCKS5 client may have already resolved DNS locally and passed an IP
  // literal (atyp 0x01/0x04). Skip DNS in that case and check the list directly.
  if (isIpLiteral(hostname)) {
    return { ip: hostname, bypass: ipInRanges(hostname, bypassRanges), blocked: false };
  }

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
      return { ip, bypass: true, blocked: false };
    }
    return { ip, bypass: false, blocked: false };
  }

  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      if (ipInRanges(addr, bypassRanges)) {
        consoleLogger.info(`[cfProxyWorker] Bypass IP matched ${addr} for ${hostname}`);
        return { ip: addr, bypass: true, blocked: false };
      }
    }
    if (addresses.length > 0) {
      return { ip: addresses[0], bypass: false, blocked: false };
    }
  } catch (e) {
    // IPv4 failed, try IPv6
    try {
      const addresses = await dns.resolve6(hostname);
      for (const addr of addresses) {
        if (ipInRanges(addr, bypassRanges)) {
          consoleLogger.info(`[cfProxyWorker] Bypass IPv6 matched ${addr} for ${hostname}`);
          return { ip: addr, bypass: true, blocked: false };
        }
      }
      if (addresses.length > 0) {
        return { ip: addresses[0], bypass: false, blocked: false };
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

  // Force-tunnel allowlist: skip bypass/DoH checks so the hostname reaches
  // the worker where INCLUDE_PROXY_FOR_UPSTREAM can route it via the upstream
  // proxy. Worker handles resolution and any blocking on its side.
  if (!isIpLiteral(hostname) && shouldForceTunnel(hostname)) {
    consoleLogger.info(`[cfProxyWorker] Force-tunnel match for ${hostname} — sending to Worker`);
  } else {
    // Resolve hostname and check whether it falls in the worker-provided bypass list
    const bypassRanges = await getBypassRanges(workerUrl, authToken);
    const resolution = await resolveHostname(hostname, bypassRanges);
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

    // Bypass listed ranges - transparently forward TCP connection using Node's net module
    if (resolution.bypass) {
      consoleLogger.info(`[cfProxyWorker] Bypassing Worker for ${hostname} (${resolution.ip}) - connecting directly`);
      directForward(clientSocket, resolution.ip, port, hostname);
      return;
    }
  }

  const wsHeaders = authToken ? { Authorization: authToken } : undefined;
  const ws = new WebSocket(wsUrl, { headers: wsHeaders });
  ws.binaryType = 'arraybuffer';

  let ready = false;
  const preBuffer: Buffer[] = [];

  // Always send the original hostname so the worker can apply its own
  // hostname-based routing (INCLUDE_PROXY_FOR_UPSTREAM globs). The worker's
  // connect() will re-resolve via Cloudflare's internal resolver — same
  // Cloudflare infra as Family DoH, no cross-provider leak. Client-side
  // Family DoH blocking (SOCKS 0x02) is what enforces the filter.
  ws.on('open', () => {
    ws.send(JSON.stringify({ hostname, port }));
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

  // Warm the bypass-ranges cache so the first connection doesn't pay the fetch latency.
  void getBypassRanges(workerUrl, authToken);

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
// Local Family DoH SOCKS5 proxy (used when CF_FAMILY_DNS=1 but CF_WORKER_PROXY
// is unset). Resolves every hostname via Cloudflare Family DoH and forwards
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
  if (isIpLiteral(hostname)) {
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
  directForward(clientSocket, ip, port, hostname);
}

let cachedFamilyLocal: CfProxyWorker | null = null;

/**
 * Start (or return the existing) local SOCKS5 proxy that enforces Cloudflare
 * Family DoH filtering with direct TCP egress. Only starts when CF_FAMILY_DNS
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
