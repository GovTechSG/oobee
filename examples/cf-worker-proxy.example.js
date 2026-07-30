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
      const cfRanges = await fetchCloudflareRanges();
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
      const cfRanges = await fetchCloudflareRanges();
      const combined = [...cfRanges, ...PRIVATE_RANGES, ...EXTRA_BYPASS_RANGES];
      return new Response(JSON.stringify(combined), {
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
        try {
          socket = connect({ hostname, port });
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