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
// connect directly from the local SOCKS proxy. Kept here (single source of
// truth) so the oobee client can fetch this list via `?bypass-ips=1`.
let BYPASS_IP_RANGES = [
  // --- Cloudflare IPv4 ---
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  // --- Cloudflare IPv6 ---
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
  // --- Local / Private Network (RFC 1918) ---
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
];

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
    if (AUTH_TOKEN && request.headers.get('Authorization') !== AUTH_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    if (url.searchParams.has('bypass-ips')) {
      return new Response(JSON.stringify(BYPASS_IP_RANGES), {
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