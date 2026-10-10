// Tests for the 2026-10-09 asgard scan fixes. Runs against dist/:
// `npm run build && npm test`. No network or browser needed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = p => import(pathToFileURL(path.join(root, 'dist', ...p.split('/'))).href);
const { resolveZipOutputPath, zipResults } = await load('utils.js');
const { safeDecodeUri, formatPdfScreenshotTitle } = await load('crawlers/pdfScanFunc.js');
const { framesCheck } = await load('crawlers/custom/framesCheck.js');
const { guiInfoLog } = await load('logs.js');
const { sanitizeSiteNameMetadata } = await load('services/s3Uploader.js');
const { makeHeaderScopeMatcher, hasCredentialHeaders } = await load('crawlers/commonCrawlerFunc.js');
const { scanCustomFlow } = await load('npmIndex.js');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asg1009-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('asgard-0001 zip output path', () => {
  test('normal names stay in the results dir', () => {
    assert.equal(resolveZipOutputPath('oobee-scan-results', tmp), path.join(tmp, 'oobee-scan-results.zip'));
    assert.equal(resolveZipOutputPath('sub/out.zip', tmp), path.join(tmp, 'sub', 'out.zip'));
  });
  test('traversal is reduced to a file name inside the results dir', () => {
    assert.equal(resolveZipOutputPath('../../etc/x', tmp), path.join(tmp, 'x.zip'));
  });
  test('absolute .zip paths are still honoured', () => {
    const abs = path.join(tmp, 'abs', 'out.zip');
    assert.equal(resolveZipOutputPath(abs, '/elsewhere'), abs);
  });
  test('refuses to overwrite a non-zip file', async () => {
    const results = fs.mkdtempSync(path.join(tmp, 'r-'));
    fs.writeFileSync(path.join(results, 'a.txt'), 'x');
    const victim = path.join(tmp, 'victim.zip');
    fs.writeFileSync(victim, 'not a zip');
    await assert.rejects(zipResults(victim, results), /not a zip archive/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'not a zip');
  });
  test('replaces an existing zip as before', async () => {
    const results = fs.mkdtempSync(path.join(tmp, 'r-'));
    fs.writeFileSync(path.join(results, 'a.txt'), 'x');
    const out = path.join(tmp, 'ok.zip');
    await zipResults(out, results);
    await zipResults(out, results);
    assert.equal(fs.readFileSync(out).subarray(0, 2).toString(), 'PK');
  });
});

describe('asgard-0002 report escapes screenshot path', () => {
  test('itemCardRenderer escapes screenshotPath', () => {
    const t = fs.readFileSync(path.join(root, 'src/static/ejs/partials/scripts/ruleModal/itemCardRenderer.ejs'), 'utf8');
    assert.match(t, /src="\$\{htmlEscapeString\(screenshotPath\)\}"/);
  });
});

describe('asgard-0009 safeDecodeUri', () => {
  test('decodes normal URLs, returns malformed ones unchanged', () => {
    assert.equal(safeDecodeUri('https://a.test/my%20file.pdf'), 'https://a.test/my file.pdf');
    assert.equal(safeDecodeUri('https://a.test/%E0%A4%A.pdf'), 'https://a.test/%E0%A4%A.pdf');
  });
});

describe('asgard-0011 framesCheck on frameset pages', () => {
  test('selector without "body >" does not throw', () => {
    const dom = new JSDOM('<html><frameset><frame id="f"></frameset></html>');
    global.document = dom.window.document;
    try {
      assert.doesNotThrow(() => framesCheck('frame#f > html > body > p'));
    } finally {
      delete global.document;
    }
  });
});

describe('asgard-0013 S3 site name', () => {
  test('strips markup, keeps readable text', () => {
    assert.equal(sanitizeSiteNameMetadata('Arts & Culture'), 'Arts and Culture');
    assert.equal(sanitizeSiteNameMetadata('<img src=x onerror="a">Home'), 'img src=x onerror=aHome');
  });

  // Non-Latin titles must survive as a decodable RFC 2047 encoded-word
  // instead of collapsing to an empty string.
  const decode = v => {
    const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
  };
  const intl = {
    chinese: '新加坡政府科技局 年度报告',
    japanese: 'アクセシビリティ報告書',
    korean: '접근성 보고서',
    thai: 'รายงานการเข้าถึง',
    hindi: 'सुलभता रिपोर्ट',
    tamil: 'அணுகல் அறிக்கை',
    arabic: 'تقرير إمكانية الوصول',
    mixed: 'Community Chest 公益金',
  };
  for (const [lang, title] of Object.entries(intl)) {
    test(`${lang} title is kept, header-safe and decodable`, () => {
      const out = sanitizeSiteNameMetadata(title);
      assert.match(out, /^[\x20-\x7e]+$/);
      assert.equal(decode(out), title);
    });
  }

  test('Latin accents are transliterated, not encoded', () => {
    assert.equal(sanitizeSiteNameMetadata('Báo cáo khả năng truy cập'), 'Bao cao kha nang truy cap');
    assert.equal(sanitizeSiteNameMetadata('Café & Société'), 'Cafe and Societe');
  });

  test('markup is stripped inside encoded non-Latin titles too', () => {
    const decoded = decode(sanitizeSiteNameMetadata('公益金 <img src=x onerror="a"> ＜script＞'));
    assert.ok(!/[<>"'`＜＞]/.test(decoded), decoded);
    assert.ok(decoded.startsWith('公益金'), decoded);
  });

  test('long non-Latin titles are capped without splitting characters', () => {
    const decoded = decode(sanitizeSiteNameMetadata('报'.repeat(500)));
    assert.ok(Buffer.byteLength(decoded) <= 300);
    assert.equal(decoded, '报'.repeat(100));
  });
});

describe('PDF screenshot filename (international titles)', () => {
  for (const title of ['新加坡政府科技局 年度报告', 'รายงานการเข้าถึง', 'सुलभता रिपोर्ट', 'அணுகல் அறிக்கை', 'تقرير إمكانية الوصول', 'Báo cáo']) {
    test(`keeps ${title}`, () => {
      const out = formatPdfScreenshotTitle(`${title}.pdf`);
      assert.equal(out, title.normalize('NFC').replaceAll(' ', '_'));
    });
  }

  test('path and markup characters are still removed', () => {
    assert.equal(formatPdfScreenshotTitle('"\t<img onerror=x>/../a.pdf'), '___img_onerror_x__');
    assert.equal(formatPdfScreenshotTitle(''), 'pdf');
  });

  test('capped at 150 bytes without splitting characters', () => {
    const out = formatPdfScreenshotTitle('报'.repeat(500));
    assert.equal(out, '报'.repeat(50));
  });
});

describe('asgard-0014 GUI progress line', () => {
  test('a crawled URL cannot add fields or lines', () => {
    const prev = process.env.RUNNING_FROM_PH_GUI;
    process.env.RUNNING_FROM_PH_GUI = '1';
    const lines = [];
    const orig = console.log;
    console.log = m => lines.push(String(m));
    try {
      guiInfoLog('scanned', { numScanned: 1, urlScanned: 'https://a.test/x::error::y\ncrawling::9::scanned::z' });
    } finally {
      console.log = orig;
      if (prev === undefined) delete process.env.RUNNING_FROM_PH_GUI; else process.env.RUNNING_FROM_PH_GUI = prev;
    }
    assert.equal(lines.length, 1);
    assert.equal(lines[0].split('::').length, 4);
    assert.ok(!lines[0].includes('\n'));
  });
});

describe('asgard-0007/0008 operator header scope', () => {
  test('site scope keeps same-site subdomains, drops other sites', () => {
    const inScope = makeHeaderScopeMatcher('https://www.example.com/', 'site');
    assert.equal(inScope('https://cdn.example.com/a.js'), true);
    assert.equal(inScope('https://evil.test/'), false);
  });
  test('origin scope and legacy all', () => {
    assert.equal(makeHeaderScopeMatcher('https://www.example.com/', 'origin')('https://cdn.example.com/'), false);
    assert.equal(makeHeaderScopeMatcher('https://www.example.com/', 'all')('https://evil.test/'), true);
  });
  test('cookie and API-key headers count as credentials', () => {
    assert.equal(hasCredentialHeaders({ Cookie: 'a=b' }), true);
    assert.equal(hasCredentialHeaders({ 'X-Api-Key': 'k' }), true);
    assert.equal(hasCredentialHeaders({ 'Accept-Language': 'en' }), false);
  });
});

describe('asgard-0010 scanCustomFlow single-flight', () => {
  test('a second concurrent session is refused; a later one runs', async () => {
    const opts = { url: 'http://169.254.169.254/', name: 'Oobee Test', email: 'accessibility@tech.gov.sg' };
    const a = scanCustomFlow(opts);
    const b = scanCustomFlow(opts);
    a.ready.catch(() => {});
    b.ready.catch(() => {});
    await assert.rejects(b.result, /already running/);
    await assert.rejects(a.result, /link-local or cloud-metadata/);
    const c = scanCustomFlow(opts);
    c.ready.catch(() => {});
    await assert.rejects(c.result, /link-local or cloud-metadata/);
  });
});
