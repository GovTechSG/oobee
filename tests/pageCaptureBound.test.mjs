// asgard-0011: page capture must be bounded in element count, size and time.
// Runs against dist/: `npm run build && npm test`. Needs a Playwright Chromium;
// skipped when none is installed (e.g. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { captureComputedStyles, readBoundedDom } = await import(
  pathToFileURL(path.join(root, 'dist', 'crawlers', 'pageCapture.js')).href
);
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright');

let browser = null;
let page = null;
let skip = false;
before(async () => {
  try {
    browser = await chromium.launch();
    page = await browser.newPage();
  } catch {
    skip = 'no Playwright Chromium available';
  }
});
after(async () => {
  if (browser) await browser.close();
});

const ENV_KEYS = ['OOBEE_CAPTURE_MAX_ELEMENTS', 'OOBEE_CAPTURE_MAX_STYLES_BYTES', 'OOBEE_CAPTURE_MAX_DOM_BYTES'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const NORMAL_PAGE = `<!doctype html><html lang="en"><head><title>t</title><style>p{color:red}</style></head>
<body><header id="h"><nav class="a b"><a href="#">x</a><a>y</a></nav></header>
<main><template><p>t</p></template><section><div><p>a</p><span>b</span><p>c</p><p id="q">d</p></div></section>
<ul>${'<li class="i"><span>s</span></li>'.repeat(20)}</ul><script>1</script></main></body></html>`;

describe('normal pages are captured exactly as before', () => {
  test('selectors match the original algorithm and nothing is truncated', async t => {
    if (skip) return t.skip(skip);
    await page.setContent(NORMAL_PAGE);
    const { elements, truncated } = await captureComputedStyles(page);
    assert.equal(truncated, null);
    const selectors = elements.map(e => e.selector);
    assert.ok(selectors.includes('html'));
    assert.ok(selectors.includes('html > body'));
    assert.ok(selectors.includes('#q'), 'id-anchored selector');
    assert.ok(selectors.includes('#h > nav'), 'parent-id-anchored selector');
    assert.ok(selectors.includes('html > body > main > ul > li:nth-of-type(3) > span'));
    assert.ok(selectors.includes('html > body > main > section > div > p:nth-of-type(2)'));
    assert.ok(!elements.some(e => ['script', 'style', 'title', 'head'].includes(e.tag)), 'skipped tags excluded');
    assert.deepEqual(elements.find(e => e.id === 'q').tag, 'p');
  });

  test('DOM capture returns page.content() unchanged', async t => {
    if (skip) return t.skip(skip);
    await page.setContent(NORMAL_PAGE);
    assert.equal(await readBoundedDom(page), await page.content());
  });
});

describe('oversized pages are bounded', () => {
  test('element cap stops the capture and marks it truncated', async t => {
    if (skip) return t.skip(skip);
    process.env.OOBEE_CAPTURE_MAX_ELEMENTS = '50';
    await page.setContent(`<body>${'<i></i>'.repeat(500)}</body>`);
    const { elements, truncated } = await captureComputedStyles(page);
    assert.equal(elements.length, 50);
    assert.equal(truncated, 'maxElements');
  });

  test('size cap stops the capture and marks it truncated', async t => {
    if (skip) return t.skip(skip);
    process.env.OOBEE_CAPTURE_MAX_STYLES_BYTES = '20000';
    await page.setContent(`<body>${`<p class="${'c'.repeat(150)}">x</p>`.repeat(500)}</body>`);
    const { elements, truncated } = await captureComputedStyles(page);
    assert.equal(truncated, 'maxBytes');
    assert.ok(elements.length > 0 && elements.length < 500);
  });

  test('flat page with many siblings finishes quickly (no quadratic selector cost)', async t => {
    if (skip) return t.skip(skip);
    process.env.OOBEE_CAPTURE_MAX_ELEMENTS = '5000';
    await page.setContent('<body></body>');
    await page.evaluate(() => {
      const f = document.createDocumentFragment();
      for (let i = 0; i < 50000; i += 1) f.appendChild(document.createElement('i'));
      document.body.appendChild(f);
    });
    const t0 = performance.now();
    const { elements, truncated } = await captureComputedStyles(page);
    const ms = performance.now() - t0;
    assert.equal(truncated, 'maxElements');
    assert.equal(elements[10].selector, 'html > body > i:nth-of-type(9)');
    assert.ok(ms < 15000, `took ${Math.round(ms)} ms`);
  });

  test('DOM larger than the byte cap is refused before it is copied', async t => {
    if (skip) return t.skip(skip);
    process.env.OOBEE_CAPTURE_MAX_DOM_BYTES = '1000';
    await page.setContent(`<body>${'<p>hello</p>'.repeat(500)}</body>`);
    await assert.rejects(readBoundedDom(page), /DOM too large/);
  });
});
