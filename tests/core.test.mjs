// Core helper tests (formerly the jest suites). Runs
// against dist/: `npm run build && npm test`.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yargs from 'yargs';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = p => pathToFileURL(path.join(root, 'dist', p)).href;
const utils = await import(dist('utils.js'));
const { filterAxeResults } = await import(dist('crawlers/commonCrawlerFunc.js'));
const { getLinksFromSitemap } = await import(dist('constants/common.js'));
const sample = await import(dist('constants/sampleData.js'));
const { cliOptions } = await import(dist('constants/cliFunctions.js'));

describe('CLI crawl strategy', () => {
  for (const scanner of ['website', 'localfile', 'sitemap', 'intelligent', 'custom']) {
    for (const strategy of [undefined, 'same-domain', 'same-hostname']) {
      test(`${scanner}: ${strategy || 'default'}`, () => {
        const args = ['-c', scanner, '-u', 'https://example.test/'];
        if (strategy) args.push('-s', strategy);
        const options = yargs(args).options(cliOptions).parseSync();
        assert.equal(options.strategy, strategy || 'same-domain');
      });
    }
  }
  test('remote sitemap: explicit ignore is preserved', () => {
    const options = yargs(['-c', 'sitemap', '-u', 'https://example.test/sitemap.xml', '-s', 'ignore'])
      .options(cliOptions).parseSync();
    assert.equal(options.strategy, 'ignore');
  });
});

describe('utils', () => {
  for (const lvl of ['critical', 'serious', 'moderate', 'minor', 'none']) {
    test(`setThresholdLimits(${lvl})`, () => {
      utils.setThresholdLimits(lvl);
      assert.equal(process.env.WARN_LEVEL, lvl);
    });
  }

  test('getHost', () => {
    assert.equal(utils.getHost('https://www.bbc.com/news'), 'www.bbc.com');
    assert.equal(utils.getHost('https://fontawesome.com/sessions/sign-in'), 'fontawesome.com');
    assert.equal(utils.getHost('https://www.crowdtask.gov.sg:443'), 'www.crowdtask.gov.sg');
    assert.equal(utils.getHost('http://localhost:5000/about/me'), 'localhost:5000');
    assert.equal(utils.getHost('http://[::1]:8080/'), '[::1]:8080');
  });

  test('getCurrentDate is YYYY-M-D of today', () => {
    const d = new Date();
    assert.equal(utils.getCurrentDate(), `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
  });

  test('getStoragePath rejects unsafe tokens', () => {
    for (const bad of ['', '../x', 'a/b', 'a\\b']) assert.throws(() => utils.getStoragePath(bad), /unsafe randomToken/);
  });

  test('setHeadlessMode', () => {
    utils.setHeadlessMode('chrome', true);
    assert.equal(process.env.CRAWLEE_HEADLESS, '1');
    utils.setHeadlessMode('chrome', false);
    assert.equal(process.env.CRAWLEE_HEADLESS, '0');
  });

  test('isFollowStrategy', () => {
    const f = utils.isFollowStrategy;
    assert.equal(f('https://a.example.com/x', 'https://b.example.com/', 'same-domain'), true);
    assert.equal(f('https://a.example.com/x', 'https://b.example.com/', 'same-hostname'), false);
    assert.equal(f('https://www.example.com/x', 'https://example.com/', 'same-hostname'), true);
    assert.equal(f('http://[::1]:8080/p2', 'http://[::1]:8080/p1', 'same-domain'), true);
    assert.equal(f('http://[::2]:8080/p2', 'http://[::1]:8080/p1', 'same-domain'), false);
    assert.equal(f('https://other.org/', 'https://example.com/', 'all'), true);
  });
});

describe('filterAxeResults', () => {
  const node = (html, impact = 'serious') => ({ html, target: ['/html/body/img'], impact, failureSummary: 'Fix any of the following:\n  thing' });
  const results = {
    url: 'http://test.com/api/path',
    violations: [
      { id: 'image-alt', help: 'h1', helpUrl: 'u1', tags: ['wcag2a', 'wcag111'], nodes: [node('<img a>'), node('<img b>')] },
      { id: 'region', help: 'h2', helpUrl: 'u2', tags: ['best-practice'], nodes: [node('<div>', 'moderate')] },
      { id: 'frame-tested', help: 'x', helpUrl: 'x', tags: ['best-practice'], nodes: [node('<iframe>')] },
    ],
    incomplete: [{ id: 'color-contrast', help: 'h3', helpUrl: 'u3', tags: ['wcag2aa'], nodes: [node('<p>')] }],
    passes: [{ id: 'html-has-lang', help: 'h4', helpUrl: 'u4', impact: null, tags: ['wcag2a'], nodes: [{ html: '<html>', target: ['html'] }] }],
  };
  const r = filterAxeResults(results, 'Title');

  test('categorises by WCAG level', () => {
    assert.equal(r.url, results.url);
    assert.equal(r.pageTitle, 'Title');
    assert.deepEqual(Object.keys(r.mustFix.rules), ['image-alt']);
    assert.deepEqual(Object.keys(r.goodToFix.rules), ['region']);
    assert.deepEqual(Object.keys(r.needsReview.rules), ['color-contrast']);
    assert.deepEqual(Object.keys(r.passed.rules), ['html-has-lang']);
  });

  test('counts items and skips frame-tested', () => {
    assert.equal(r.mustFix.totalItems, 2);
    assert.equal(r.goodToFix.totalItems, 1);
    assert.equal(r.totalItems, 5);
    assert.deepEqual(r.mustFix.rules['image-alt'].items.map(i => i.html), ['<img a>', '<img b>']);
  });

  test('needsReview drops the "Fix any" header line', () => {
    assert.equal(r.needsReview.rules['color-contrast'].items[0].message, 'thing');
  });

  test('escapes </script> in item html', () => {
    const x = filterAxeResults({ ...results, violations: [{ ...results.violations[0], nodes: [node('<b></script></b>')] }] }, 't');
    assert.equal(x.mustFix.rules['image-alt'].items[0].html, '<b>&lt;/script></b>');
  });
});

describe('getLinksFromSitemap (local files, no browser)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oobee-sitemap-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const mixedHosts = ['https://proxy.example.test/page', 'https://site.example.test/page', 'https://unrelated.test/page'];
  for (const strategy of [undefined, 'same-domain', 'same-hostname', 'all']) {
    test(`local sitemap keeps every listed host with ${strategy || 'default'} strategy`, async () => {
      const p = path.join(tmp, `scope-${strategy || 'default'}.txt`);
      fs.writeFileSync(p, mixedHosts.join('\n'));
      // Mirrors crawlSitemap for local files: no entry URL, so userUrl falls back to the file path.
      const reqs = await getLinksFromSitemap(p, 100, 'chromium', '', '', false, {}, strategy);
      assert.deepEqual(reqs.map(r => r.url).sort(), [...mixedHosts].sort());
    });

    test(`local sitemap index descends into every child with ${strategy || 'default'} strategy`, async () => {
      const dir = fs.mkdtempSync(path.join(tmp, 'index-'));
      const children = mixedHosts.map((url, i) => {
        const child = path.join(dir, `child-${i}.xml`);
        fs.writeFileSync(child, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url}</loc></url></urlset>`);
        return child;
      });
      const index = path.join(dir, 'sitemap-index.xml');
      fs.writeFileSync(index, `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children.map(c => `<sitemap><loc>${c}</loc></sitemap>`).join('')}</sitemapindex>`);
      const reqs = await getLinksFromSitemap(index, 100, 'chromium', '', '', false, {}, strategy);
      assert.deepEqual(reqs.map(r => r.url).sort(), [...mixedHosts].sort());
    });
  }
  // RSS/Atom take only <item>/<entry> links: channel image, feed self-link and
  // enclosures are not pages, so they are intentionally not scanned.
  const cases = [
    ['sitemap.xml', 'XML <loc> only, not namespaces or comments', sample.sampleXmlSitemap, sample.sampleXmlSitemapLinks],
    ['rssfeed.xml', 'RSS <item><link>, duplicates once', sample.sampleRssFeed, ['http://www.feedforall.com', 'http://www.feedforall.com/feedforall-partners.htm']],
    ['atomfeed.xml', 'Atom <entry> first <link href>', sample.sampleAtomFeed, ['http://example.org/2005/04/02/atom']],
    ['sitemap.txt', 'plain txt', sample.sampleTxtSitemap, sample.sampleTxtSitemapLinks],
    ['weird.xml', 'non-standard XML', sample.sampleNonStandardXmlSitemap, sample.sampleNonStandardXmlSitemapLinks],
  ];
  for (const [file, name, body, want] of cases) {
    test(name, async () => {
      const p = path.join(tmp, file);
      fs.writeFileSync(p, body);
      const reqs = await getLinksFromSitemap(p, 100, 'chrome', '', p, false, {});
      assert.deepEqual(reqs.map(r => r.url).sort(), [...new Set(want)].sort());
    });
  }
});
