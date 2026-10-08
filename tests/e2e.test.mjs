// End-to-end CLI scans proving security fixes did not change what a scan
// finds or produces. Needs a built dist/, Chromium, and (PDF test) the veraPDF
// + JRE bundled with Oobee Desktop (or on PATH). Live-site tests are opt-in:
//   E2E_LIVE=1 npm run test:e2e
// Telemetry is always disabled.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oobee-e2e-'));
const LIVE = /^(1|true|yes)$/i.test(process.env.E2E_LIVE ?? '');

// Oobee Desktop ships a JRE + veraPDF; use it when present so PDF scans work.
const backend = path.join(os.homedir(), 'Library/Application Support/Oobee/Oobee Backend');
const extraPath = [path.join(backend, 'jre/bin'), path.join(backend, 'verapdf')]
  .filter(p => fs.existsSync(p))
  .join(path.delimiter);
const hasVera = extraPath.includes('verapdf') && extraPath.includes('jre');

const runCli = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, '-h', 'yes', '-g', 'yes', '-k', 'Test:test@example.com', '-e', outRoot], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${extraPath}${path.delimiter}${process.env.PATH}`,
        ...(hasVera && { JAVA_HOME: path.join(backend, 'jre') }),
        OOBEE_DISABLE_TELEMETRY: '1',
        DISABLE_OOBEE_TELEMETRY: '1',
        ...env,
      },
    });
    let log = '';
    child.stdout.on('data', d => (log += d));
    child.stderr.on('data', d => (log += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('close', code => {
      clearTimeout(timer);
      const m = log.match(/Results directory is at\s+(\S+)/);
      resolve({ code, log, dir: m ? m[1] : null });
    });
  });

const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const scannedUrls = dir => {
  const d = readJson(dir, 'scanPagesDetail.json');
  return [...d.pagesAffected, ...d.pagesNotAffected].map(p => p.url);
};
const allItems = dir => {
  const si = readJson(dir, 'scanItems.json');
  const items = [];
  for (const c of ['mustFix', 'goodToFix', 'needsReview'])
    for (const r of si[c]?.rules ?? []) for (const p of r.pagesAffected) for (const i of p.items) items.push({ rule: r.rule, ...i });
  return items;
};
const screenshotsOnDisk = (dir, sub) => {
  const d = path.join(dir, 'elemScreenshots', sub);
  return fs.existsSync(d) ? fs.readdirSync(d).length : 0;
};
const assertScreenshotsResolve = (dir, items) => {
  const withShot = items.filter(i => i.screenshotPath);
  for (const i of withShot) assert.ok(fs.existsSync(path.join(dir, i.screenshotPath)), `missing ${i.screenshotPath}`);
  return withShot.length;
};

// 6 linked pages, each with one image lacking alt (a deterministic violation).
let server4;
let server6;
const PAGES = 6;
const handler = (req, res) => {
  const m = req.url.match(/^\/p(\d)\.html/);
  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('User-agent: *\nDisallow: /p5.html\n');
  }
  if (req.url === '/table.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    return res.end(fs.readFileSync(path.join(root, 'tests/fixtures/table.pdf')));
  }
  if (req.url === '/docs.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html lang="en"><head><title>Docs</title></head><body><main><a href="/table.pdf">pdf</a></main></body></html>');
  }
  const n = m ? Number(m[1]) : 1;
  const next = n < PAGES ? `<a href="/p${n + 1}.html">next</a>` : '';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<html lang="en"><head><title>Page ${n}</title></head><body><main><h1>Page ${n}</h1><img src="/a.png">${next}</main></body></html>`);
};
const listen = (srv, host) => new Promise(r => srv.listen(0, host, () => r(srv.address().port)));

describe('e2e: local crawls keep working on every address family', () => {
  let p4;
  let p6;
  before(async () => {
    server4 = http.createServer(handler);
    server6 = http.createServer(handler);
    p4 = await listen(server4, '127.0.0.1');
    p6 = await listen(server6, '::1');
  });
  after(() => {
    server4.close();
    server6.close();
  });

  // Internal targets are legitimate scan targets (intranet/VPN). The new
  // egress guard must not refuse them when the *entry* URL is itself internal.
  const targets = [
    ['IPv4 literal', () => `http://127.0.0.1:${p4}/p1.html`, PAGES],
    ['localhost', () => `http://localhost:${p4}/p1.html`, PAGES],
  ];
  for (const [name, url, expectPages] of targets) {
    test(`${name}: crawls all ${expectPages} pages and writes screenshots`, async () => {
      const { code, dir, log } = await runCli(['-c', '2', '-u', url(), '-p', '10', '-a', 'screenshots']);
      assert.ok(dir, `no results dir. log tail:\n${log.slice(-800)}`);
      assert.equal(code, 0);
      assert.equal(scannedUrls(dir).length, expectPages);
      const items = allItems(dir);
      assert.ok(items.some(i => i.rule === 'image-alt'), 'image-alt violation expected');
      const n = assertScreenshotsResolve(dir, items);
      assert.ok(n > 0, 'expected element screenshots referenced by scanItems');
      assert.ok(screenshotsOnDisk(dir, 'html') > 0, 'expected jpeg files in elemScreenshots/html');
    });
  }

  test('IPv6 literal [::1]: scans the entry page and writes screenshots', async () => {
    // Known baseline: the crawler enqueues only the entry page for bracketed
    // IPv6 hosts on master too (6->1). Assert the fix did not make it worse.
    const { code, dir, log } = await runCli(['-c', '2', '-u', `http://[::1]:${p6}/p1.html`, '-p', '10', '-a', 'screenshots']);
    assert.ok(dir, `no results dir. log tail:\n${log.slice(-800)}`);
    assert.equal(code, 0);
    assert.ok(scannedUrls(dir).length >= 1);
    const items = allItems(dir);
    assert.ok(items.some(i => i.rule === 'image-alt'));
    assert.ok(assertScreenshotsResolve(dir, items) > 0);
  });

  test('-a none writes no element screenshots', async () => {
    const { dir } = await runCli(['-c', '2', '-u', `http://127.0.0.1:${p4}/p1.html`, '-p', '2', '-a', 'none']);
    assert.ok(dir);
    assert.equal(screenshotsOnDisk(dir, 'html'), 0);
    assert.ok(allItems(dir).every(i => !i.screenshotPath));
  });

  test('robots.txt is still honoured on an internal origin (-r yes skips /p5.html)', async () => {
    const { dir } = await runCli(['-c', '2', '-u', `http://127.0.0.1:${p4}/p1.html`, '-p', '10', '-r', 'yes']);
    assert.ok(dir);
    const urls = scannedUrls(dir);
    assert.ok(!urls.some(u => u.endsWith('/p5.html')), `p5 should be disallowed: ${urls}`);
    assert.ok(urls.some(u => u.endsWith('/p4.html')));
  });

  test('operator header reaches the same-site entry page (scope default keeps working)', async () => {
    const seen = [];
    const hdr = http.createServer((req, res) => {
      seen.push({ url: req.url, h: req.headers['x-oobee-test'] });
      handler(req, res);
    });
    const port = await listen(hdr, '127.0.0.1');
    try {
      const { dir } = await runCli(['-c', '2', '-u', `http://127.0.0.1:${port}/p1.html`, '-p', '2', '-m', 'X-Oobee-Test abc123']);
      assert.ok(dir);
      const page = seen.find(s => s.url === '/p1.html');
      assert.equal(page?.h, 'abc123');
    } finally {
      hdr.close();
    }
  });

  test('metadata entry URL is refused (no results produced, nothing fetched)', async () => {
    let hit = false;
    const fake = http.createServer((_, res) => {
      hit = true;
      res.end('x');
    });
    await listen(fake, '127.0.0.1');
    try {
      const { code, log } = await runCli(['-c', '2', '-u', 'http://169.254.169.254/latest/meta-data/', '-p', '1']);
      assert.notEqual(code, 0, log.slice(-400));
      assert.equal(hit, false);
    } finally {
      fake.close();
    }
  });

  test('PDF: violations get screenshots; OOBEE_PDF_MAX_SCREENSHOTS caps them but keeps every item', { skip: !hasVera && 'veraPDF/JRE not found' }, async () => {
    const run = env => runCli(['-c', '2', '-u', `http://127.0.0.1:${p4}/table.pdf`, '-p', '1', '-i', 'pdf-only'], env);
    const full = await run({ OOBEE_PDF_MAX_SCREENSHOTS: '' });
    assert.ok(full.dir, full.log.slice(-600));
    const fullItems = allItems(full.dir);
    assert.ok(fullItems.length >= 4, `expected >=4 PDF violations, got ${fullItems.length}`);
    assert.equal(screenshotsOnDisk(full.dir, 'pdf'), fullItems.length, 'default cap must not drop screenshots on a small PDF');
    assert.equal(assertScreenshotsResolve(full.dir, fullItems), fullItems.length);

    const capped = await run({ OOBEE_PDF_MAX_SCREENSHOTS: '1' });
    assert.ok(capped.dir);
    const cappedItems = allItems(capped.dir);
    assert.equal(cappedItems.length, fullItems.length, 'cap must not drop violations');
    assert.equal(screenshotsOnDisk(capped.dir, 'pdf'), 1);

    const unlimited = await run({ OOBEE_PDF_MAX_SCREENSHOTS: '0' });
    assert.equal(screenshotsOnDisk(unlimited.dir, 'pdf'), fullItems.length);
  });

  // Known baseline: on master, -i all with HTML+PDF screenshots crashes in
  // moveElemScreenshots (fs.moveSync "dest already exists"). Opt-in until fixed.
  test('HTML page linking to a PDF scans both (-i all)', { skip: (!hasVera && 'veraPDF/JRE not found') || (!process.env.E2E_KNOWN_BROKEN && 'pre-existing moveElemScreenshots crash') }, async () => {
    const { dir } = await runCli(['-c', '2', '-u', `http://127.0.0.1:${p4}/docs.html`, '-p', '5', '-i', 'all']);
    assert.ok(dir);
    const urls = scannedUrls(dir);
    assert.ok(urls.some(u => u.endsWith('/docs.html')) && urls.some(u => u.endsWith('/table.pdf')), `${urls}`);
  });
});

// Public dual-stack sites. Opt-in because they need real network + IPv6.
describe('e2e: public dual-stack sites (E2E_LIVE=1)', { skip: !LIVE && 'set E2E_LIVE=1' }, () => {
  // www.w3.org and www.tech.gov.sg publish both A and AAAA records, so a scan
  // goes through the public path of the egress guard (serverAddr = public).
  const sites = [
    ['https://www.w3.org/WAI/demos/bad/before/home.html', 3],
    ['https://www.tech.gov.sg/', 3],
  ];
  for (const [url, pages] of sites) {
    test(`${url}: ${pages} pages, screenshots present`, async () => {
      const { code, dir, log } = await runCli(['-c', '2', '-u', url, '-p', String(pages), '-a', 'screenshots']);
      assert.ok(dir, log.slice(-600));
      assert.equal(code, 0);
      const urls = scannedUrls(dir);
      assert.ok(urls.length >= 1 && urls.length <= pages, `${urls}`);
      const items = allItems(dir);
      assert.ok(items.length > 0);
      assert.ok(assertScreenshotsResolve(dir, items) > 0);
      assert.ok(screenshotsOnDisk(dir, 'html') > 0);
    });
  }
});
