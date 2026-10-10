// Unit tests for address classification, text extraction, scanHTML and the
// report UI. Run against dist/ (what ships): `npm run build && npm run test:unit`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = p => pathToFileURL(path.join(root, 'dist', p)).href;
const common = await import(dist('constants/common.js'));
const { extractText } = await import(dist('crawlers/custom/extractText.js'));
const { scanHTML, scanCustomFlow } = await import(dist('npmIndex.js'));

describe('address classification', () => {
  // Public must stay public and every intranet range must stay "internal" (not
  // refused) — users scan intranet / VPN / Tailscale sites.
  const cases = [
    ['169.254.169.254', 'metadata'],
    ['169.254.10.1', 'metadata'],
    ['100.100.100.200', 'metadata'], // Alibaba IMDS
    ['192.0.0.192', 'metadata'], // Oracle IMDS
    ['0.0.0.0', 'metadata'],
    ['fe80::1', 'metadata'],
    ['fd00:ec2::254', 'metadata'], // AWS IMDS v6
    ['[fd00:ec2::254]', 'metadata'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['127.0.0.1', 'internal'],
    ['::1', 'internal'],
    ['10.1.2.3', 'internal'],
    ['172.16.0.2', 'internal'],
    ['192.168.1.65', 'internal'],
    ['100.64.0.1', 'internal'], // Tailscale CGNAT
    ['fd7a:115c:a1e0::1', 'internal'], // Tailscale ULA
    ['fd00:ec2::253', 'internal'], // near-miss of AWS IMDS stays ULA
    ['8.8.8.8', 'public'],
    ['3.165.75.93', 'public'],
    ['2606:4700::6812:1713', 'public'],
    ['2600:9000:271a:d400:d:3ac3:9f80:93a1', 'public'],
  ];
  for (const [ip, want] of cases) {
    test(`${ip} -> ${want}`, () => assert.equal(common.classifyServerAddress(ip), want));
  }

  const urlCases = [
    ['http://169.254.169.254/latest/meta-data/', true],
    ['http://[fd00:ec2::254]/', true],
    ['http://[fe80::1]:8080/', true],
    ['http://[::ffff:169.254.169.254]/', true],
    ['http://100.100.100.200/', true],
    ['http://127.0.0.1:8080/', false],
    ['http://localhost/', false],
    ['http://[::1]/', false],
    ['http://192.168.0.10/', false],
    ['http://100.64.1.1/', false],
    ['http://[fd7a:115c:a1e0::1]/', false],
    ['file:///tmp/a.html', false],
    ['not a url', false],
  ];
  for (const [u, want] of urlCases) {
    test(`isLinkLocalOrMetadataUrl(${u}) = ${want}`, async () =>
      assert.equal(await common.isLinkLocalOrMetadataUrl(u), want));
  }

  test('internal URL detection still treats intranet as internal (not refused)', async () => {
    assert.equal(await common.isInternalOrLoopbackUrl('http://[::1]:8931/'), true);
    assert.equal(await common.isInternalOrLoopbackUrl('http://100.64.0.1/'), true);
    assert.equal(await common.isInternalOrLoopbackUrl('http://8.8.8.8/'), false);
  });
});

// Reference sentence splitter: extractText must produce exactly this output.
const referenceSentences = paragraphs => {
  const out = [];
  for (const raw of paragraphs) {
    const m = raw.trim().match(/[^.!?]*[.!?]+/g);
    if (m) for (const s of m) if (s.trim()) out.push(s.trim());
  }
  return out;
};

const runExtractText = (fn, paragraphs) => {
  const dom = new JSDOM(`<body>${paragraphs.map(() => '<p></p>').join('')}</body>`, { runScripts: 'outside-only' });
  const ps = dom.window.document.querySelectorAll('p');
  // jsdom has no layout, so innerText is undefined; alias it to textContent.
  ps.forEach((p, i) => {
    p.textContent = paragraphs[i];
    Object.defineProperty(p, 'innerText', { get: () => p.textContent });
  });
  // extractText is serialised via toString() by integrators; run it the same way.
  return JSON.parse(JSON.stringify(dom.window.eval(`(${fn.toString()})()`)));
};

describe('extractText sentence splitting', () => {
  test('matches the reference splitter on mixed and random inputs', () => {
    const samples = [
      ['Hello world. How are you? Fine!', 'trailing fragment without stop', 'No terminator at all'],
      ['A... B?! C', 'Mr. Smith went. Then left', '  spaced.  out .  '],
      ['', '.', '!!!', 'x.y.z'],
    ];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 300; n++) {
      samples.push(
        Array.from({ length: 3 }, () =>
          Array.from({ length: Math.floor(rnd() * 60) }, () => 'ab .!? \n'[Math.floor(rnd() * 8)]).join(''),
        ),
      );
    }
    for (const s of samples) assert.deepEqual(runExtractText(extractText, s), referenceSentences(s));
  });

  test('punctuation-free 200k paragraph completes in linear time', () => {
    const big = 'a'.repeat(200_000);
    const t0 = performance.now();
    const out = runExtractText(extractText, [`Real sentence. ${big}`]);
    const ms = performance.now() - t0;
    assert.deepEqual(out, ['Real sentence.']);
    assert.ok(ms < 2000, `took ${ms}ms`);
  });

  test('no length cap: long real sentences are kept whole', () => {
    const long = `${'word '.repeat(5000)}end.`;
    assert.deepEqual(runExtractText(extractText, [long]), [long.trim()]);
  });

  test('splits on . ! ? and keeps runs of terminators with their sentence', () => {
    assert.deepEqual(runExtractText(extractText, ['One. Two! Three? Four?! Five...']), [
      'One.', 'Two!', 'Three?', 'Four?!', 'Five...',
    ]);
  });

  test('drops trailing text without a terminator and empty paragraphs', () => {
    assert.deepEqual(runExtractText(extractText, ['Kept. dropped tail', '', '   ', 'No stop']), ['Kept.']);
  });

  test('preserves paragraph order across elements', () => {
    assert.deepEqual(runExtractText(extractText, ['B first.', 'A second.']), ['B first.', 'A second.']);
  });
});

describe('scanHTML', () => {
  const html = '<html><body><img src="a.png"><button></button><p>some padding text to exceed fifty bytes</p></body></html>';
  const cfg = { name: 'Oobee Test', email: 'accessibility@tech.gov.sg' };
  const withEnv = async (env, fn) => {
    const prev = {};
    for (const k of Object.keys(env)) {
      prev[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(prev)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  };

  test('normal HTML still scans with defaults and finds violations', async () => {
    const res = await withEnv({ OOBEE_SCANHTML_MAX_BYTES: undefined }, () => scanHTML(html, cfg));
    const rules = Object.keys(res.mustFix?.rules ?? {}).concat(Object.keys(res.goodToFix?.rules ?? {}));
    assert.ok(rules.includes('image-alt'), `rules: ${rules}`);
  });

  test('a 1 MB page is well within the default bound', async () => {
    const big = `<html><body>${`<p>${'filler text '.repeat(100_000)}</p>`}<img src="x"></body></html>`;
    assert.ok(Buffer.byteLength(big) > 1_000_000);
    await withEnv({ OOBEE_SCANHTML_MAX_BYTES: undefined }, () => scanHTML(big, cfg));
  });

  test('oversize input is rejected with a clear error', async () => {
    await withEnv({ OOBEE_SCANHTML_MAX_BYTES: '50' }, () =>
      assert.rejects(scanHTML(html, cfg), /OOBEE_SCANHTML_MAX_BYTES/),
    );
  });

  test('"0" means unlimited', async () => {
    await withEnv({ OOBEE_SCANHTML_MAX_BYTES: '0' }, () => scanHTML(html, cfg));
  });

  test('array input reports the offending index', async () => {
    await withEnv({ OOBEE_SCANHTML_MAX_BYTES: '50' }, () =>
      assert.rejects(scanHTML(['<p>ok</p>', html], cfg), /htmlContent\[1\]/),
    );
  });

  test('invalid limit values fall back to the default', async () => {
    for (const v of ['abc', '-5', ' ']) await withEnv({ OOBEE_SCANHTML_MAX_BYTES: v }, () => scanHTML(html, cfg));
  });

  test('accessible HTML has no must-fix image-alt issue', async () => {
    const ok = '<html lang="en"><head><title>t</title></head><body><main><img src="a.png" alt="logo"></main></body></html>';
    const res = await scanHTML(ok, cfg);
    assert.ok(!('image-alt' in (res.mustFix?.rules ?? {})));
  });

  test('array input scans every document', async () => {
    const res = await scanHTML([html, html], cfg);
    assert.equal(res.mustFix.rules['image-alt'].totalItems, 2);
  });

  test('OOBEE_SCANHTML_AXE_TIMEOUT_MS aborts a slow axe run', async () => {
    const heavy = `<html><body>${'<div><img src="x"><a href="#"></a></div>'.repeat(4000)}</body></html>`;
    await withEnv({ OOBEE_SCANHTML_AXE_TIMEOUT_MS: '1' }, () =>
      assert.rejects(scanHTML(heavy, cfg), /OOBEE_SCANHTML_AXE_TIMEOUT_MS/),
    );
  });
});

describe('Gen AI error rendering', () => {
  const ejs = fs.readFileSync(path.join(root, 'src/static/ejs/partials/scripts/ruleModal/utilities.ejs'), 'utf8');

  test('error message no longer reaches innerHTML', () => {
    // only the empty-string reset may remain
    const assigns = [...ejs.matchAll(/errorContainer\.innerHTML\s*=\s*([^;]*);/g)].map(m => m[1].trim());
    assert.deepEqual(assigns, ["''"]);
    assert.match(ejs, /errorDiv\.textContent = errorMessage/);
    assert.match(ejs, /errorDiv\.className = 'generateAiError'/);
  });

  test('hostile API error is shown as literal text with the same styling hook', () => {
    const dom = new JSDOM('<div id="c"></div>');
    const { document } = dom.window;
    const errorContainer = document.getElementById('c');
    const errorMessage = 'Failed to generate fix suggestion: <img src=x onerror=alert(1)>';
    // Same statements as utilities.ejs.
    const errorDiv = document.createElement('div');
    errorDiv.className = 'generateAiError';
    errorDiv.textContent = errorMessage;
    errorContainer.replaceChildren(errorDiv);
    assert.equal(errorContainer.querySelector('img'), null);
    assert.equal(errorContainer.querySelector('.generateAiError').textContent, errorMessage);
  });
});

describe('Gen AI suggest-fix sanitizer', () => {
  // Load the real sanitizer from the template rather than a copy, so the test
  // fails if the shipped code regresses.
  const ejs = fs.readFileSync(path.join(root, 'src/static/ejs/partials/scripts/ruleModal/utilities.ejs'), 'utf8');
  const start = ejs.indexOf('const RESOURCE_ATTRS');
  const end = ejs.indexOf('// Helper function to extract element context');
  const sanitize = new Function(`${ejs.slice(start, end)}; return sanitizeElementForContext;`)();
  const run = html => {
    const doc = new JSDOM(`<body>${html}</body>`).window.document;
    return sanitize(doc.body.firstElementChild);
  };

  test('quoted and unquoted external url() are replaced with valid CSS', () => {
    for (const style of [
      "color:red;background:url('https://evil.example/a.png')",
      'color:red;background:url("https://evil.example/a.png")',
      'color:red;background:url(https://evil.example/a.png)',
      "color:red;background:url( '//evil.example/a.png' )",
    ]) {
      const el = run(`<div style="${style.replace(/"/g, '&quot;')}">x</div>`);
      const out = el.getAttribute('style');
      assert.ok(!/evil\.example/.test(out), out);
      assert.ok(!/url\(/i.test(out), out);
      assert.match(out, /color:\s*red/);
      assert.match(out, /background:\s*none/);
    }
  });

  test('every element is cleaned, not just alternate ones', () => {
    const el = run(
      `<div>${'<span style="background:url(https://evil.example/x.png)">a</span>'.repeat(5)}</div>`,
    );
    for (const span of el.querySelectorAll('span')) {
      assert.ok(!/evil\.example/.test(span.getAttribute('style')), span.outerHTML);
    }
  });

  test('a quoted URL containing ")" is removed whole', () => {
    const el = run(`<div style="background:url('https://evil.example/a).png');color:blue">x</div>`);
    const out = el.getAttribute('style');
    assert.ok(!/evil\.example/.test(out), out);
    assert.match(out, /color:\s*blue/);
  });

  test('local styles and same-document refs are left alone', () => {
    const el = run('<a href="#top" style="color:green;background:url(data:image/png;base64,AA==)">x</a>');
    assert.equal(el.getAttribute('href'), '#top');
    assert.match(el.getAttribute('style'), /data:image\/png/);
  });

  test('external src, <style> and handlers are stripped', () => {
    const el = run('<div onclick="x()"><img src="https://evil.example/b.gif"><style>body{color:red}</style></div>');
    assert.equal(el.getAttribute('onclick'), null);
    assert.equal(el.querySelector('img').getAttribute('src'), null);
    assert.equal(el.querySelector('style'), null);
  });
});

describe('scanCustomFlow entry URL', () => {
  test('metadata entry URL is refused before any browser launches', async () => {
    const session = scanCustomFlow({
      url: 'http://169.254.169.254/latest/meta-data/',
      name: 'Oobee Test',
      email: 'accessibility@tech.gov.sg',
    });
    session.ready.catch(() => {});
    await assert.rejects(session.result, /link-local or cloud-metadata/);
  });
});
