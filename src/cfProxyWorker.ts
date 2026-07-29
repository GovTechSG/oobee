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
import { URL } from 'url';
import WebSocket from 'ws';
import { consoleLogger } from './logs.js';

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

async function handleSocks5(
  clientSocket: net.Socket,
  wsUrl: string,
  authToken: string | undefined,
): Promise<void> {
  clientSocket.on('error', () => {
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
  });

  let hostname: string;
  let port: number;
  try {
    // Greeting
    const greet = await readExact(clientSocket, 2);
    if (greet[0] !== 0x05) return void clientSocket.destroy();
    await readExact(clientSocket, greet[1]); // discard methods
    clientSocket.write(Buffer.from([0x05, 0x00])); // NO AUTH

    // Request
    const head = await readExact(clientSocket, 4);
    if (head[0] !== 0x05) return void clientSocket.destroy();
    if (head[1] !== 0x01) {
      clientSocket.write(socksReply(0x07)); // command not supported
      clientSocket.end();
      return;
    }
    const atyp = head[3];
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
      return;
    }
    port = (await readExact(clientSocket, 2)).readUInt16BE(0);
  } catch {
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  const wsHeaders = authToken ? { Authorization: authToken } : undefined;
  const ws = new WebSocket(wsUrl, { headers: wsHeaders });
  ws.binaryType = 'arraybuffer';

  let ready = false;
  const preBuffer: Buffer[] = [];

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
  const port = parseInt(process.env.CF_WORKER_PROXY_PORT || '8877', 10);
  const wsUrl = buildWsUrl(workerUrl);

  const server = net.createServer(socket => {
    handleSocks5(socket, wsUrl, authToken).catch(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  });

  server.on('error', err => {
    consoleLogger.error(
      `[cfProxyWorker] SOCKS5 server error: ${(err as Error).message}`,
    );
  });

  server.listen(port, '127.0.0.1', () => {
    consoleLogger.info(
      `[cfProxyWorker] SOCKS5 tunnel listening on 127.0.0.1:${port} -> ${wsUrl}`,
    );
  });

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
