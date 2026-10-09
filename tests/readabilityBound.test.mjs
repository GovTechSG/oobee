// asgard-0005: length bound on gradeReadability / extractText.
// Runs against dist/: `npm run build && npm test`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = p => import(pathToFileURL(path.join(root, 'dist', ...p.split('/'))).href);
const { gradeReadability, MAX_READABILITY_TEXT_CHARS } = await load('crawlers/custom/gradeReadability.js');
const { extractText } = await load('crawlers/custom/extractText.js');

// Hard prose with a Flesch score of ~20: inside (0, 50], so a score string is
// returned. Much harder text scores <= 0, which gradeReadability maps to ''.
const HARD =
  'Developers should test their websites regularly to make sure that information remains accessible to everyone who visits.';

describe('gradeReadability: unchanged for normal input', () => {
  test('empty / non-array input returns empty string', () => {
    assert.equal(gradeReadability([]), '');
    assert.equal(gradeReadability(undefined), '');
  });

  test('fewer than 20 words returns empty string', () => {
    assert.equal(gradeReadability(['Short sentence here.']), '');
  });

  test('hard article-length text is graded the same as before', () => {
    const sentences = Array(500).fill(HARD);
    const score = gradeReadability(sentences);
    assert.notEqual(score, '');
    assert.ok(Number(score) <= 50);
  });

  test('easy text still returns empty string (score > 50)', () => {
    const easy = Array(50).fill('The cat sat on the mat and it was a good day for all of us.');
    assert.equal(gradeReadability(easy), '');
  });
});

describe('gradeReadability: oversized input is bounded', () => {
  test('cap is large (1M chars)', () => {
    assert.equal(MAX_READABILITY_TEXT_CHARS, 1_000_000);
  });

  test('~20M chars of input completes quickly with the same score as the capped prefix', () => {
    const many = Array(Math.ceil(20_000_000 / (HARD.length + 1))).fill(HARD);
    const t0 = performance.now();
    const big = gradeReadability(many);
    const ms = performance.now() - t0;
    const capped = gradeReadability(Array(Math.floor(MAX_READABILITY_TEXT_CHARS / (HARD.length + 1))).fill(HARD));
    assert.equal(big, capped);
    assert.ok(ms < 5000, `took ${Math.round(ms)} ms`);
  });

  test('a single oversized sentence is truncated, not rejected', () => {
    const huge = `${'word '.repeat(400_000)}end.`; // ~2M chars
    assert.doesNotThrow(() => gradeReadability([huge]));
  });
});

describe('extractText: in-page bound', () => {
  const run = html => {
    const dom = new JSDOM(`<body>${html}</body>`);
    // jsdom has no layout, so innerText is undefined; map it to textContent.
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      get() { return this.textContent; },
    });
    global.document = dom.window.document;
    try {
      return extractText();
    } finally {
      delete global.document;
    }
  };

  test('normal page returns every sentence as before', () => {
    const out = run('<p>First one. Second one!</p><p>Third? No terminator here</p>');
    assert.deepEqual(out, ['First one.', 'Second one!', 'Third?']);
  });

  test('huge page output is capped near 1M chars', () => {
    const para = `<p>${'This is a reasonably long sentence for testing purposes. '.repeat(2000)}</p>`;
    const out = run(para.repeat(30)); // ~3.4M chars of text
    const total = out.reduce((n, s) => n + s.length + 1, 0);
    assert.ok(total <= 1_000_001, `total ${total}`);
    assert.ok(total > 900_000, `total ${total}`);
  });

  test('still works when serialised via toString() (as npmIndex injects it)', () => {
    const fn = new Function(`return (${extractText.toString()})`)();
    const dom = new JSDOM('<body><p>Hello there. Bye now.</p></body>');
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      get() { return this.textContent; },
    });
    global.document = dom.window.document;
    try {
      assert.deepEqual(fn(), ['Hello there.', 'Bye now.']);
    } finally {
      delete global.document;
    }
  });
});
