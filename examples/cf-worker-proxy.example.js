// SOCKS-over-WebSocket tunnel worker.
//
// Client opens a WebSocket to this worker, sends `{"hostname":..,"port":..}`
// as the first message, then the worker opens a raw TCP socket to that host
// via cloudflare:sockets and pipes bytes bidirectionally over the WS. The
// browser (or any SOCKS client) speaks its own TLS end-to-end with the
// target — no MITM, no certs on this side.
//
// Deploy notes:
//   - Requires compatibility_flags = ["nodejs_compat"] and a recent
//     compatibility_date so cloudflare:sockets is available.
//   - Set AUTH_TOKEN below (or via env binding) to gate access. Empty = open.

const AUTH_TOKEN = '';

// -----------------------------------------------------------------------------
// Feature toggles.
// -----------------------------------------------------------------------------

// When true, `?bypass-ips` includes Cloudflare's live IP ranges (v4+v6),
// telling the oobee client to connect DIRECT for hosts resolving to CF.
// When false, only PRIVATE_RANGES + EXTRA_BYPASS_RANGES are returned and
// CF-fronted targets go through this worker like everything else.
const BYPASS_CLOUDFLARE = true;

// When true, this worker does not open TCP directly to the target. It opens
// a TCP (or TLS) socket to the UPSTREAM_PROXY endpoint below, issues an
// HTTP CONNECT with Basic auth, and tunnels bytes end-to-end. The browser's
// TLS still terminates at the real target — the upstream proxy only sees
// the target hostname, not the request contents.
//
// Use this to give the worker a stable, non-Cloudflare egress IP via a
// third-party proxy service (residential/ISP/datacenter).
const USE_UPSTREAM_PROXY = false;

// -----------------------------------------------------------------------------
// Upstream forward proxy config (only used when USE_UPSTREAM_PROXY = true).
// Fill in and redeploy. Do not commit real credentials — prefer
// `wrangler secret put` and read via env bindings.
// -----------------------------------------------------------------------------
const UPSTREAM_PROXY = {
  HOST: '',        // e.g. 'gate.smartproxy.com' or 'proxy.mycorp.com'
  PORT: 0,         // e.g. 7000 for HTTP proxy, 443 for HTTPS proxy
  TLS: false,      // true = HTTPS proxy (TLS to the proxy itself); false = plain HTTP CONNECT
  USERNAME: '',    // basic auth username (empty for no auth)
  PASSWORD: '',    // basic auth password
};

// Filter for which target hostnames/IPs should route via the upstream proxy
// (only consulted when USE_UPSTREAM_PROXY = true). Anything not matched here
// falls back to a direct connect() from the worker.
//
// Supported entry forms:
//   '*'                         — match everything (default)
//   'example.com'               — exact hostname / IP literal (case-insensitive)
//   '*.example.com'             — glob with wildcard (matches sub.example.com,
//                                 a.b.example.com, etc.)
//   '203.0.113.0/24'            — CIDR (matched only when the target is an IP
//                                 literal, i.e. the SOCKS client resolved DNS
//                                 locally and sent atyp=0x01/0x04)
//   '2001:db8::/32'             — IPv6 CIDR
const INCLUDE_PROXY_FOR_UPSTREAM = ['*'];

// Inbound IP allowlist. Each entry is either a bare IPv4/IPv6 address or a
// CIDR block. '0.0.0.0' is a magic entry meaning "allow all" — replace with
// your actual client IPs to lock the worker down. Examples:
//   ['203.0.113.42']                  // single IPv4
//   ['203.0.113.0/24', '2001:db8::/32'] // CIDR ranges (v4 + v6)
//   ['0.0.0.0']                       // open to the internet (default)
const ALLOWED_IPS = ['0.0.0.0'];

// Hostnames resolving to any of these ranges should skip the worker tunnel and
// connect directly from the local SOCKS proxy. The oobee client fetches the
// combined list via `?bypass-ips=1`.
//
// Cloudflare's own edge IP ranges are fetched live from cloudflare.com so the
// worker tracks CF's current POPs without a redeploy. If the fetch fails and
// no cached value is available, the CF portion is omitted (the caller still
// gets private ranges + user extras).
const PRIVATE_RANGES = [
  // --- Local / Private Network (RFC 1918) ---
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
];

// User-supplied extra bypass ranges. Any IP or CIDR added here is merged into
// the list served via `?bypass-ips=1` alongside the Cloudflare + private
// ranges. Use for corporate CDN edges, on-prem hosts, or anything else that
// should skip the worker tunnel. Bogon examples left in place for reference —
// replace with your own or empty the array.
const EXTRA_BYPASS_RANGES = [
  // '192.0.2.0/24',        // TEST-NET-1 (bogon example)
  // '198.51.100.0/24',     // TEST-NET-2 (bogon example)
  // '203.0.113.0/24',      // TEST-NET-3 (bogon example)
  // '2001:db8::/32',       // IPv6 documentation (bogon example)
];

const CF_IPS_V4_URL = 'https://www.cloudflare.com/ips-v4';
const CF_IPS_V6_URL = 'https://www.cloudflare.com/ips-v6';
const CF_IPS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// In-isolate cache. Cloudflare recycles isolates freely, so this is a
// best-effort cache; every new isolate warms it once on first request.
let cfRangesCache = null; // { ranges: string[], expiresAt: number }

function parseCidrList(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

async function fetchCloudflareRanges() {
  const now = Date.now();
  if (cfRangesCache && cfRangesCache.expiresAt > now) return cfRangesCache.ranges;
  try {
    const [v4Res, v6Res] = await Promise.all([
      fetch(CF_IPS_V4_URL, { cf: { cacheEverything: true, cacheTtl: 3600 } }),
      fetch(CF_IPS_V6_URL, { cf: { cacheEverything: true, cacheTtl: 3600 } }),
    ]);
    if (!v4Res.ok || !v6Res.ok) throw new Error(`HTTP ${v4Res.status}/${v6Res.status}`);
    const [v4Text, v6Text] = await Promise.all([v4Res.text(), v6Res.text()]);
    const ranges = [...parseCidrList(v4Text), ...parseCidrList(v6Text)];
    if (ranges.length === 0) throw new Error('empty CIDR list from cloudflare.com');
    cfRangesCache = { ranges, expiresAt: now + CF_IPS_TTL_MS };
    return ranges;
  } catch (err) {
    // Serve stale cache if we have one; otherwise CF ranges are omitted from
    // this response (private + extras still returned by the caller).
    if (cfRangesCache) return cfRangesCache.ranges;
    console.warn(`[cf-worker-proxy] Live CF IP fetch failed: ${err && err.message}. Omitting CF ranges from bypass list.`);
    return [];
  }
}

import { connect } from 'cloudflare:sockets';

// Decide whether a given target hostname/IP should be routed via the upstream
// proxy per INCLUDE_PROXY_FOR_UPSTREAM. Only called when USE_UPSTREAM_PROXY.
function shouldRouteViaUpstream(hostname) {
  const targetIsIp = ipToBytes(hostname) !== null;
  for (const raw of INCLUDE_PROXY_FOR_UPSTREAM) {
    if (typeof raw !== 'string' || !raw) continue;
    const pattern = raw.trim();
    if (pattern === '*') return true;

    // CIDR — only meaningful when the SOCKS client sent an IP literal.
    if (pattern.includes('/')) {
      const base = pattern.split('/')[0];
      if (ipToBytes(base) && targetIsIp && cidrMatch(hostname, pattern)) return true;
      continue;
    }

    // Glob (with '*')
    if (pattern.includes('*')) {
      const re = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
        'i',
      );
      if (re.test(hostname)) return true;
      continue;
    }

    // Exact match (case-insensitive)
    if (pattern.toLowerCase() === hostname.toLowerCase()) return true;
  }
  return false;
}

// Open a socket to the target via the configured upstream HTTP/HTTPS forward
// proxy using CONNECT + Basic auth. Returns { socket, leftover } where
// leftover is any bytes read past the CONNECT response terminator (unlikely
// for CONNECT but possible; must be forwarded to the WS client before piping
// begins).
async function connectViaUpstreamProxy(targetHost, targetPort) {
  const socket = connect(
    { hostname: UPSTREAM_PROXY.HOST, port: UPSTREAM_PROXY.PORT },
    UPSTREAM_PROXY.TLS ? { secureTransport: 'on' } : {},
  );

  const authHeader =
    UPSTREAM_PROXY.USERNAME || UPSTREAM_PROXY.PASSWORD
      ? `Proxy-Authorization: Basic ${btoa(`${UPSTREAM_PROXY.USERNAME}:${UPSTREAM_PROXY.PASSWORD}`)}\r\n`
      : '';
  const req =
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${targetHost}:${targetPort}\r\n` +
    authHeader +
    `Proxy-Connection: Keep-Alive\r\n` +
    `\r\n`;

  const writer = socket.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(req));
  } finally {
    writer.releaseLock();
  }

  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  const MAX_HEADER_BYTES = 8192;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('upstream closed before CONNECT response');
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;

      // Find \r\n\r\n (end of headers)
      let idx = -1;
      for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
          idx = i;
          break;
        }
      }
      if (idx !== -1) {
        const head = new TextDecoder().decode(buf.subarray(0, idx));
        const statusLine = head.split('\r\n')[0] || '';
        if (!/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) {
          throw new Error(`upstream CONNECT refused: ${statusLine.slice(0, 120)}`);
        }
        const leftover = buf.subarray(idx + 4);
        return { socket, leftover: leftover.length ? leftover : null };
      }
      if (buf.length > MAX_HEADER_BYTES) throw new Error('CONNECT response too large');
    }
  } finally {
    reader.releaseLock();
  }
}

function ipAllowed(ip) {
  if (!ip) return false;
  if (ALLOWED_IPS.includes('0.0.0.0')) return true;
  for (const entry of ALLOWED_IPS) {
    if (entry === ip) return true;
    if (entry.includes('/') && cidrMatch(ip, entry)) return true;
  }
  return false;
}

function cidrMatch(ip, cidr) {
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

// Build a PAC (Proxy Auto-Config) script for Chromium. Hosts resolving to any
// listed IPv4 range return DIRECT (Chromium uses its native networking stack,
// including HTTP/3 and connection reuse — critical for bot-detection engines
// that fingerprint proxy-triggered behavior). Everything else routes through
// the caller's local SOCKS5 tunnel. IPv6 CIDRs are omitted because Chromium's
// PAC lacks an interoperable IPv6 primitive; IPv6-only hosts fall through to
// SOCKS5 where the server-side bypass logic still handles them.
function buildPacScript(bypassRanges, socksPort) {
  const v4Pairs = [];
  for (const cidr of bypassRanges) {
    if (typeof cidr !== 'string' || !cidr.includes('/') || cidr.includes(':')) continue;
    const [base, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const parts = base.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) continue;
    const maskInt = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const mask = [
      (maskInt >>> 24) & 0xff,
      (maskInt >>> 16) & 0xff,
      (maskInt >>> 8) & 0xff,
      maskInt & 0xff,
    ].join('.');
    v4Pairs.push([base, mask]);
  }
  const rangesLiteral = JSON.stringify(v4Pairs);
  const socks = `SOCKS5 127.0.0.1:${socksPort}`;
  return `function FindProxyForURL(url, host) {
  var ranges = ${rangesLiteral};
  var ip = "";
  try { ip = dnsResolve(host) || ""; } catch (e) { ip = ""; }
  if (ip) {
    for (var i = 0; i < ranges.length; i++) {
      if (isInNet(ip, ranges[i][0], ranges[i][1])) return "DIRECT";
    }
  }
  return ${JSON.stringify(socks)};
}
`;
}

function ipToBytes(ip) {
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

export default {
  async fetch(request) {
    const clientIp = request.headers.get('CF-Connecting-IP');
    if (!ipAllowed(clientIp)) {
      return new Response('Forbidden', { status: 403 });
    }
    const url = new URL(request.url);

    // PAC endpoint. Public (no auth) — Chromium fetches this before proxy
    // config is active and won't attach an Authorization header. Not used by
    // the current oobee client; kept for posterity in case PAC routing is
    // revisited. Uses the same live CF list + fallback as `?bypass-ips`.
    if (url.searchParams.has('pac')) {
      const socksPort = Number(url.searchParams.get('socks-port')) || 8877;
      const cfRanges = BYPASS_CLOUDFLARE ? await fetchCloudflareRanges() : [];
      const combined = [...cfRanges, ...PRIVATE_RANGES, ...EXTRA_BYPASS_RANGES];
      const pac = buildPacScript(combined, socksPort);
      return new Response(pac, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ns-proxy-autoconfig',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (AUTH_TOKEN && request.headers.get('Authorization') !== AUTH_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (url.searchParams.has('bypass-ips')) {
      const cfRanges = BYPASS_CLOUDFLARE ? await fetchCloudflareRanges() : [];
      const bypassRanges = [...cfRanges, ...PRIVATE_RANGES, ...EXTRA_BYPASS_RANGES];
      // Also publish the upstream-proxy hostname allowlist so the client can
      // force-tunnel matching hosts (skip its bypass-IP short-circuit) without
      // hardcoding the list on its side. Only meaningful when the worker is
      // actually routing via an upstream proxy.
      const upstreamHosts = USE_UPSTREAM_PROXY
        ? INCLUDE_PROXY_FOR_UPSTREAM.filter((s) => typeof s === 'string' && s && s !== '*')
        : [];
      return new Response(JSON.stringify({ bypassRanges, upstreamHosts }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response(
        'This worker only speaks SOCKS-over-WebSocket. Upgrade required.',
        { status: 426, headers: { 'Content-Type': 'text/plain' } }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.binaryType = 'arraybuffer';

    // First message from client is the target descriptor.
    server.addEventListener(
      'message',
      async ({ data }) => {
        if (typeof data !== 'string') {
          server.close(1003, 'Expected JSON target descriptor');
          return;
        }

        let hostname, port;
        try {
          const payload = JSON.parse(data);
          hostname = payload.hostname;
          port = Number(payload.port);
        } catch {
          server.close(1003, 'Invalid JSON');
          return;
        }
        if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
          server.close(1008, 'Invalid target');
          return;
        }

        let socket;
        let leftover = null;
        try {
          if (USE_UPSTREAM_PROXY && shouldRouteViaUpstream(hostname)) {
            const res = await connectViaUpstreamProxy(hostname, port);
            socket = res.socket;
            leftover = res.leftover;
          } else {
            socket = connect({ hostname, port });
          }
        } catch (e) {
          server.close(1011, `connect() threw: ${(e && e.message) || 'unknown'}`);
          return;
        }

        // If the underlying TCP connection fails (refused, RST, blocked),
        // socket.closed rejects. Surface the reason to the client so we can
        // tell "target refused" from "our code errored".
        socket.closed.catch((err) => {
          const msg = (err && err.message) || 'closed';
          try { server.close(1011, `upstream: ${msg.slice(0, 100)}`); } catch {}
        });

        // Signal handshake completion so the client can start writing.
        try { server.send(JSON.stringify({ type: 'ready' })); } catch {}

        // If the CONNECT handshake consumed bytes past the header terminator,
        // forward them to the WS client before the tcp->ws pipe starts.
        if (leftover) {
          try {
            server.send(leftover.buffer.slice(leftover.byteOffset, leftover.byteOffset + leftover.byteLength));
          } catch {}
        }

        // WS -> TCP: enqueue every subsequent binary message into a stream
        // piped at socket.writable.
        const wsToTcp = new ReadableStream({
          start(controller) {
            server.addEventListener('message', (event) => {
              const chunk = event.data;
              if (chunk instanceof ArrayBuffer) {
                controller.enqueue(new Uint8Array(chunk));
              }
              // Strings after handshake are ignored — clients send binary.
            });
            server.addEventListener('close', () => {
              try { controller.close(); } catch {}
            });
            server.addEventListener('error', () => {
              try { controller.error(new Error('WebSocket error')); } catch {}
            });
          },
          cancel() {
            try { socket.close(); } catch {}
          },
        });
        wsToTcp.pipeTo(socket.writable).catch((err) => {
          const msg = (err && err.message) || 'client pipe';
          try { server.close(1011, `write: ${msg.slice(0, 100)}`); } catch {}
        });

        // TCP -> WS: forward every read chunk as a binary WebSocket frame.
        socket.readable
          .pipeTo(
            new WritableStream({
              write(chunk) {
                const buf = chunk instanceof ArrayBuffer ? chunk : chunk.buffer.slice(
                  chunk.byteOffset,
                  chunk.byteOffset + chunk.byteLength
                );
                try { server.send(buf); } catch {}
              },
              close() {
                try { server.close(1000, 'Upstream closed'); } catch {}
              },
              abort() {
                try { server.close(1011, 'Upstream aborted'); } catch {}
              },
            })
          )
          .catch((err) => {
            const msg = (err && err.message) || 'read pipe';
            try { server.close(1011, `read: ${msg.slice(0, 100)}`); } catch {}
          });
      },
      { once: true }
    );

    return new Response(null, { status: 101, webSocket: client });
  },
};