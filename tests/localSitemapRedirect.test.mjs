// Real browser/crawler regression tests. All fixture responses are intercepted;
// optional live coverage: OOBEE_REDIRECT_TEST_URLS='["https://proxy.example/path"]'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proxy = 'https://proxy.example.test/page';
const destination = 'https://site.example.test/page';

// Each crawl gets a fresh process: Crawlee caches its dataset and queue globally.
const worker = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  import dns from 'node:dns/promises';
  import { chromium } from 'playwright';
  const config = JSON.parse(process.env.OOBEE_REDIRECT_CASE);
  const load = p => import(pathToFileURL(path.resolve('dist', p)).href);
  if (!config.live) {
    const lookup = dns.lookup;
    dns.lookup = (host, options) => host.endsWith('.test')
      ? Promise.resolve([{ address: '93.184.216.34', family: 4 }])
      : lookup(host, options);
    const launch = chromium.launchPersistentContext.bind(chromium);
    chromium.launchPersistentContext = async (...args) => {
      const context = await launch(...args);
      await context.route('**/*', route => {
        const url = route.request().url();
        if (config.remote && url === config.sitemap) return route.fulfill({
          contentType: config.extension === 'txt' ? 'text/plain' : 'application/xml',
          body: config.sitemapBody,
        });
        if (url === config.url) return route.fulfill({
          contentType: 'text/html',
          body: '<script>location.replace(' + JSON.stringify(config.destination) + ')</script>',
        });
        if (url === config.destination) return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html lang="en"><title>Redirect destination</title><main><h1>Destination</h1><img src="data:image/png;base64,AA=="></main></html>',
        });
        return route.abort();
      });
      return context;
    };
  }
  const { default: constants, FileTypes } = await load('constants/constants.js');
  const { crawlLocalFile } = await load('crawlers/crawlLocalFile.js');
  const { default: crawlSitemap } = await load('crawlers/crawlSitemap.js');
  const { default: crawlDomain } = await load('crawlers/crawlDomain.js');
  const crawl = config.domain ? crawlDomain : config.sitemapDefaults || config.remote ? crawlSitemap : crawlLocalFile;
  constants.exportDirectory = path.join(config.dir, 'results');
  process.env.CRAWLEE_STORAGE_DIR = constants.exportDirectory;
  const { urlsCrawled } = await crawl({
    ...(config.domain ? { url: config.url, safeMode: true } : config.sitemapDefaults || config.remote
      ? { sitemapUrl: config.sitemap, crawledFromLocalFile: !config.remote }
      : { url: config.sitemap }),
    randomToken: 'redirect-test', host: '',
    viewportSettings: { playwrightDeviceDetailsObject: { viewport: { width: 1280, height: 720 } } },
    maxRequestsPerCrawl: 10, browser: process.env.OOBEE_REDIRECT_TEST_BROWSER || 'chromium',
    userDataDirectory: path.join(config.dir, 'profile'), specifiedMaxConcurrency: 1,
    fileTypes: FileTypes.HtmlOnly, blacklistedPatterns: [],
    includeScreenshots: false, extraHTTPHeaders: {},
    ...(config.strategy && { strategy: config.strategy }),
  });
  fs.writeFileSync(path.join(config.dir, 'outcome.json'), JSON.stringify(urlsCrawled));
  // Crawlee's shared local proxy keeps the worker alive after run() resolves.
  process.exit(0);
`;

async function crawl(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oobee-redirect-'));
  try {
    const sitemap = config.remote ? `https://proxy.example.test/sitemap.${config.extension || 'xml'}`
      : path.join(dir, `sitemap.${config.extension || 'xml'}`);
    const sitemapBody = config.extension === 'txt' ? config.url
      : `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${config.url.replaceAll('&', '&amp;')}</loc></url></urlset>`;
    if (!config.remote) fs.writeFileSync(sitemap, sitemapBody);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--use-system-ca', '--input-type=module', '-e', worker], {
        cwd: root,
        env: {
          ...process.env, OOBEE_DISABLE_TELEMETRY: '1', CRAWLEE_HEADLESS: '1',
          OOBEE_LOGS_PATH: dir, OOBEE_VERBOSE: '1', CRAWLEE_LOG_LEVEL: 'ERROR',
          OOBEE_REDIRECT_CASE: JSON.stringify({ ...config, dir, sitemap, sitemapBody }),
        },
      });
      let log = '';
      child.stdout.on('data', d => { log += d; });
      child.stderr.on('data', d => { log += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, log }); });
    });
    assert.equal(result.code, 0, result.log);
    assert.ok(fs.existsSync(path.join(dir, 'outcome.json')), result.log + fs.readdirSync(dir)
      .filter(f => f.endsWith('.txt')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'));
    return JSON.parse(fs.readFileSync(path.join(dir, 'outcome.json'), 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const extension of ['xml', 'txt']) {
  test(`local ${extension} sitemap follows a sibling-host redirect with same-domain`, async () => {
    const result = await crawl({ url: proxy, destination, extension, strategy: 'same-domain' });
    assert.equal(result.scanned.length, 1, JSON.stringify(result));
    assert.equal(result.scanned[0].url, proxy);
    assert.equal(result.scanned[0].actualUrl, destination);
    assert.equal(result.scanned[0].pageTitle, 'Redirect destination');
  });

  test(`local ${extension} sitemap follows a sibling-host redirect by default`, async () => {
    const result = await crawl({ url: proxy, destination, extension });
    assert.equal(result.scanned.length, 1, JSON.stringify(result));
    assert.equal(result.scanned[0].actualUrl, destination);
    assert.deepEqual(result.notScannedRedirects, []);
  });
}

for (const sitemapDefaults of [false, true]) {
  test(`${sitemapDefaults ? 'shared' : 'local'} sitemap: same-hostname excludes a sibling-host redirect`, async () => {
    const result = await crawl({ url: proxy, destination, sitemapDefaults, strategy: 'same-hostname' });
    assert.equal(result.scanned.length, 0);
    assert.deepEqual(result.notScannedRedirects, [{ fromUrl: proxy, toUrl: destination }]);
    assert.ok(result.userExcluded.some(p => p.url === proxy && p.actualUrl === destination));
  });

  test(`${sitemapDefaults ? 'shared' : 'local'} sitemap: default excludes a redirect to another parent domain`, async () => {
    const target = 'https://unrelated.test/page';
    const result = await crawl({ url: proxy, destination: target, sitemapDefaults });
    assert.equal(result.scanned.length, 0);
    assert.deepEqual(result.notScannedRedirects, [{ fromUrl: proxy, toUrl: target }]);
  });
}

test('same-domain still excludes a redirect to another parent domain', async () => {
  const target = 'https://unrelated.test/page';
  const result = await crawl({ url: proxy, destination: target, strategy: 'same-domain' });
  assert.equal(result.scanned.length, 0);
  assert.deepEqual(result.notScannedRedirects, [{ fromUrl: proxy, toUrl: target }]);
});

test('shared sitemap crawler follows a sibling-host redirect by default', async () => {
  const result = await crawl({ url: proxy, destination, sitemapDefaults: true });
  assert.equal(result.scanned.length, 1, JSON.stringify(result));
  assert.equal(result.scanned[0].actualUrl, destination);
  assert.deepEqual(result.notScannedRedirects, []);
});

test('shared sitemap crawler: explicit all permits an unrelated-domain redirect', async () => {
  const target = 'https://unrelated.test/page';
  const result = await crawl({ url: proxy, destination: target, sitemapDefaults: true, strategy: 'all' });
  assert.equal(result.scanned.length, 1, JSON.stringify(result));
  assert.equal(result.scanned[0].actualUrl, target);
});

for (const strategy of [undefined, 'same-hostname', 'all']) {
  test(`remote sitemap: ${strategy || 'default'} controls redirects`, async () => {
    const target = strategy === 'all' ? 'https://unrelated.test/page' : destination;
    const result = await crawl({ url: proxy, destination: target, remote: true, strategy });
    if (strategy === 'same-hostname') {
      assert.equal(result.scanned.length, 0);
      assert.deepEqual(result.notScannedRedirects, [{ fromUrl: proxy, toUrl: target }]);
    } else {
      assert.equal(result.scanned.length, 1, JSON.stringify(result));
      assert.equal(result.scanned[0].actualUrl, target);
    }
  });
}

for (const strategy of [undefined, 'same-hostname']) {
  test(`website crawl: ${strategy || 'default'} controls sibling-host redirects`, async () => {
    const result = await crawl({ url: proxy, destination, domain: true, strategy });
    if (strategy === 'same-hostname') {
      assert.equal(result.scanned.length, 0);
      assert.ok(result.notScannedRedirects.some(p => p.toUrl === destination));
    } else {
      assert.ok(result.scanned.some(p => p.url === proxy && p.actualUrl === destination), JSON.stringify(result));
      assert.deepEqual(result.notScannedRedirects, []);
    }
  });
}

const liveUrls = JSON.parse(process.env.OOBEE_REDIRECT_TEST_URLS || '[]');
test('live proxy URLs follow sibling-host redirects', { skip: !liveUrls.length }, async () => {
  for (const url of liveUrls) {
    const result = await crawl({ url, live: true });
    assert.equal(result.scanned.length, 1, JSON.stringify(result));
    assert.notEqual(new URL(result.scanned[0].actualUrl).hostname, new URL(url).hostname);
    const strict = await crawl({ url, live: true, strategy: 'same-hostname' });
    assert.equal(strict.scanned.length, 0);
    assert.ok(strict.notScannedRedirects.some(p => p.fromUrl === url));
  }
});
