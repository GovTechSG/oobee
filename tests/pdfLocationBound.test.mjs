// asgard-0006: page-range bound in calculateLocation.
// Runs against dist/: `npm run build && npm test`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { calculateLocation, getBboxPage, buildBboxMap, MAX_PDF_LOCATION_PAGE_SPAN } = await import(
  pathToFileURL(path.join(root, 'dist', 'screenshotFunc', 'pdfScreenshotFunc.js')).href
);

const BOX = 'boundingBox[10,20,110,220]';

describe('calculateLocation: normal veraPDF locations unchanged', () => {
  test('single page', () => {
    assert.deepEqual(calculateLocation(`pages[0]/${BOX}`), [
      { page: 1, location: [10, 20, 100, 200] },
    ]);
  });

  test('multi-page span emits bottom / middle / top entries', () => {
    assert.deepEqual(calculateLocation(`pages[2-4]/${BOX}`), [
      { page: 3, location: [10, 220, 100, 'bottom'] },
      { page: 4, location: [10, 0, 100, 'top'] },
      { page: 5, location: [10, 20, 100, 'top'] },
    ]);
  });

  test('span exactly at the cap is still processed', () => {
    const out = calculateLocation(`pages[0-${MAX_PDF_LOCATION_PAGE_SPAN}]/${BOX}`);
    assert.equal(out.length, MAX_PDF_LOCATION_PAGE_SPAN + 1);
  });
});

describe('calculateLocation: hostile page ranges are refused', () => {
  test('cap is 10,000 pages', () => {
    assert.equal(MAX_PDF_LOCATION_PAGE_SPAN, 10_000);
  });

  for (const range of [
    '0-50000000', // the reported OOM case
    `0-${MAX_PDF_LOCATION_PAGE_SPAN + 1}`,
    '5-2', // reversed
    'a-9',
    '0-b',
    '-5-3',
  ]) {
    test(`pages[${range}] returns no entries`, () => {
      const t0 = performance.now();
      assert.deepEqual(calculateLocation(`pages[${range}]/${BOX}`), []);
      assert.ok(performance.now() - t0 < 100);
    });
  }
});

describe('callers handle a refused range', () => {
  const hostile = `pages[0-50000000]/${BOX}`;

  test('getBboxPage (used by getPageFromContext) returns 0, not a crash', () => {
    assert.equal(getBboxPage({ location: hostile }, null), 0);
  });

  test('buildBboxMap (screenshot path) produces no pages', () => {
    assert.deepEqual(buildBboxMap([{ location: hostile }], null), {});
  });

  test('getBboxPage still returns the first page for a normal span', () => {
    assert.equal(getBboxPage({ location: `pages[2-4]/${BOX}` }, null), 3);
  });
});
