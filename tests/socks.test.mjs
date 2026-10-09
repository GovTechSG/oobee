// The local Family-DNS SOCKS5 proxy must refuse non-canonical
// IPv4 spellings (octal/hex/integer) and internal literals, while passing
// public literals (v4 and v6) through to a direct connection.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';
process.env.CF_FAMILY_DNS = '1';
delete process.env.CF_WORKER_PROXY;
process.env.CF_WORKER_PROXY_PORT = '18877';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startFamilyDnsLocalProxy } = await import(pathToFileURL(path.join(root, 'dist', 'cfProxyWorker.js')).href);

const listen = (host) =>
  new Promise((resolve) => {
    const s = net.createServer((c) => c.end('hello'));
    s.listen(0, host, () => resolve(s));
  });

// Performs a SOCKS5 CONNECT and returns the reply code (0x00 ok, 0x02 refused).
const socksConnect = (proxyPort, atyp, addrBytes, port) =>
  new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    let stage = 0;
    sock.on('error', reject);
    sock.on('data', (d) => {
      if (stage === 0) {
        stage = 1;
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, atyp]), addrBytes, Buffer.from([port >> 8, port & 255])]));
      } else if (stage === 1) {
        stage = 2;
        resolve({ rep: d[1], sock });
      }
    });
    sock.write(Buffer.from([5, 1, 0]));
  });

const domain = (name) => Buffer.concat([Buffer.from([name.length]), Buffer.from(name)]);

describe('Family DNS SOCKS5 proxy', () => {
  let proxy;
  let v4Server;
  let v6Server;
  before(async () => {
    proxy = startFamilyDnsLocalProxy();
    assert.ok(proxy, 'proxy should start with CF_FAMILY_DNS=1');
    await new Promise((r) => setTimeout(r, 300));
    v4Server = await listen('127.0.0.1');
    v6Server = await listen('::1');
  });
  after(async () => {
    v4Server.close();
    v6Server.close();
    // Pending forwards to unrouted test addresses would keep close() waiting.
    proxy.stop();
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
  });

  // Every spelling of loopback/internal that glibc would resolve to a private
  // address must be refused (0x02), never forwarded and never sent to DNS.
  const refused = [
    '0177.0.0.1', // octal 127.0.0.1
    '0x7f.0.0.1', // hex
    '0x7f000001', // hex integer
    '2130706433', // decimal integer
    '127.1', // short form
    '010.0.0.1', // octal 8.0.0.1 / leading zero
    '169.254.169.254',
    '10.0.0.5',
  ];
  for (const host of refused) {
    test(`refuses ${host}`, async () => {
      const { rep, sock } = await socksConnect(proxy.port, 3, domain(host), 80);
      sock.destroy();
      assert.equal(rep, 0x02);
    });
  }

  test('refuses internal IPv4 sent as atyp=1 (127.0.0.1)', async () => {
    const { rep, sock } = await socksConnect(proxy.port, 1, Buffer.from([127, 0, 0, 1]), v4Server.address().port);
    sock.destroy();
    assert.equal(rep, 0x02);
  });

  test('refuses internal IPv6 sent as atyp=4 (::1)', async () => {
    const b = Buffer.alloc(16);
    b[15] = 1;
    const { rep, sock } = await socksConnect(proxy.port, 4, b, v6Server.address().port);
    sock.destroy();
    assert.equal(rep, 0x02);
  });

  test('refuses v4-mapped metadata ::ffff:169.254.169.254', async () => {
    const b = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 169, 254, 169, 254]);
    const { rep, sock } = await socksConnect(proxy.port, 4, b, 80);
    sock.destroy();
    assert.equal(rep, 0x02);
  });

  // 192.0.2.0/24 and 2001:db8::/32 are public documentation ranges, so the
  // guard must pass them to a direct connect. The guard refuses synchronously;
  // a forwarded connect to an unrouted address just hangs (or fails with
  // 0x04/0x05). So: no reply within the window, or a non-0x02 reply, = passed.
  const passthrough = [
    ['192.0.2.1 (atyp 3)', 3, domain('192.0.2.1')],
    ['192.0.2.1 (atyp 1)', 1, Buffer.from([192, 0, 2, 1])],
    ['2001:db8::1 (atyp 4)', 4, Buffer.from([0x20, 0x01, 0x0d, 0xb8, ...Array(11).fill(0), 1])],
  ];
  for (const [name, atyp, addr] of passthrough) {
    test(`does not refuse public literal ${name}`, async () => {
      const outcome = await new Promise((resolve, reject) => {
        const sock = net.connect(proxy.port, '127.0.0.1');
        const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
        const t = setTimeout(() => done('forwarding'), 1500);
        let stage = 0;
        sock.on('error', reject);
        sock.on('data', (d) => {
          if (stage++ === 0) sock.write(Buffer.concat([Buffer.from([5, 1, 0, atyp]), addr, Buffer.from([0, 9])]));
          else done(d[1]);
        });
        sock.write(Buffer.from([5, 1, 0]));
      });
      assert.notEqual(outcome, 0x02);
    });
  }

  test('refuses deprecated IPv4-compatible ::127.0.0.1', async () => {
    const b = Buffer.from([...Array(12).fill(0), 127, 0, 0, 1]);
    const { rep, sock } = await socksConnect(proxy.port, 4, b, 80);
    sock.destroy();
    assert.equal(rep, 0x02);
  });

  test('rejects unsupported BIND command with 0x07', async () => {
    const rep = await new Promise((resolve, reject) => {
      const sock = net.connect(proxy.port, '127.0.0.1');
      let stage = 0;
      sock.on('error', reject);
      sock.on('data', (d) => {
        if (stage++ === 0) sock.write(Buffer.from([5, 2, 0, 1, 192, 0, 2, 1, 0, 80]));
        else { sock.destroy(); resolve(d[1]); }
      });
      sock.write(Buffer.from([5, 1, 0]));
    });
    assert.equal(rep, 0x07);
  });
});
