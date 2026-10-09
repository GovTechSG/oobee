// Security regression guard for the asgard-0001..0011 fixes.
//
// Static checks over src/: each fix must stay in place, and the unsafe pattern
// it removed must not come back anywhere else in a similar form. Behaviour is
// covered by the per-finding test files; this file catches the case where new
// code reintroduces the pattern somewhere those tests don't look.
//
// When a check fails, don't just update the allowlist: read the message, and
// only allowlist after confirming the new code applies the same guard.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');

const walk = dir =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
    return /\.ts$/.test(e.name) ? [p] : [];
  });
const rel = p => path.relative(root, p).split(path.sep).join('/');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
// Drops whole-line comments so a pattern named in an explanatory comment
// doesn't count as a use.
const code = text =>
  text
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
const SOURCES = walk(SRC).map(p => ({ file: rel(p), text: code(fs.readFileSync(p, 'utf8')) }));
const count = (text, re) => (text.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) || []).length;
const grepAll = re => SOURCES.filter(s => re.test(s.text)).map(s => s.file);

describe('outbound requests (asgard-0001, 0004, 0009)', () => {
  // Every place Node makes a network request. A new one must apply the same
  // egress checks as the existing ones before it is added here.
  const SINKS = {
    'src/crawlers/pdfScanFunc.ts': 1, // httpClient.stream, guarded by createPdfEgressGuards
    'src/constants/common.ts': 1, // axios.post to the fixed telemetry form URL
    'src/cfProxyWorker.ts': 2, // Worker config + Family DoH, fixed endpoints
    'src/generateOobeeClientScanner.ts': 1, // build-time Sentry CDN hash
    // Not a Node request: browser code inside the generated report.html,
    // calling the operator-configured PROXY_API_BASE_URL.
    'src/mergeAxeResults.ts': 1,
  };
  const SINK_RE = /\bfetch\(|\baxios\.(get|post|put|request)\(|\bhttpClient\.(stream|sendRequest)\(|\bsendRequest\(|\bhttpsRequest\(|\bhttps?\.(get|request)\(|\bgotScraping\(|\bgot\(/;

  test('no new network call sites without review', () => {
    const found = {};
    for (const s of SOURCES) {
      const n = count(s.text, SINK_RE);
      if (n) found[s.file] = n;
    }
    assert.deepEqual(
      found,
      SINKS,
      'A network call site was added or removed. If it takes a URL from scanned content, ' +
        'apply the internal/metadata egress checks (see createPdfEgressGuards / isRefusedRedirectTarget), then update SINKS.',
    );
  });

  test('PDF download keeps DNS, redirect and peer-address checks', () => {
    const t = read('src/crawlers/pdfScanFunc.ts');
    for (const needle of ['dnsLookup: egress.dnsLookup', 'followRedirect: egress.followRedirect', 'egress.assertUrlAllowed(url)', 'isRefusedPdfEgressAddress(response.ip']) {
      assert.ok(t.includes(needle), `pdfScanFunc.ts lost: ${needle}`);
    }
  });

  test('every handlePdfDownload call passes entryIsInternal', () => {
    for (const s of SOURCES) {
      const calls = s.text.split('handlePdfDownload(').slice(1);
      if (s.file === 'src/crawlers/pdfScanFunc.ts') continue;
      for (const c of calls) {
        const args = c.slice(0, c.indexOf(');'));
        assert.match(args, /entryIsInternal/, `${s.file}: handlePdfDownload() without entryIsInternal`);
      }
    }
  });

  test('connectivity-check redirect guard stays in place', () => {
    assert.match(read('src/cli.ts'), /isRefusedRedirectTarget\(data\.entryUrl, res\.url\)/);
    const common = read('src/constants/common.ts');
    assert.match(common, /isRefusedRedirectTarget\(url, finalUrl\)/);
    assert.match(common, /isRefusedServerAddrForEntry\(url, serverAddr\.ipAddress\)/);
  });
});

describe('scanCustomFlow entry URL (asgard-0002)', () => {
  test('scheme allowlist and local-file check run before the opt-in block', () => {
    const t = code(read('src/crawlers/scanCustomFlow.ts'));
    const allow = t.indexOf('ALWAYS_ALLOWED_CUSTOM_FLOW_SCHEMES.has(');
    const remoteFile = t.indexOf("parsedEntryUrl.protocol === 'file:'");
    const optIn = t.indexOf('if (!isSsrfProtectionEnabled()) return;');
    assert.ok(allow > 0 && remoteFile > 0 && optIn > 0, 'scanCustomFlow.ts lost a guard');
    assert.ok(allow < optIn && remoteFile < optIn, 'always-on checks must run before the OOBEE_SSRF_PROTECTION early return');
    assert.match(t, /await assertSafeCustomFlowUrl\(options\.url\)/);
  });
});

describe('archive extraction (asgard-0003)', () => {
  test('no shelling out to an archive tool', () => {
    const re = /\b(execFileSync|execSync|execFile|exec|spawnSync|spawn)\(\s*['"`](unzip|tar|7z|7za|bsdtar|gunzip)['"`]/;
    assert.deepEqual(grepAll(re), [], 'use extractZipBufferSafely() instead of an external extractor');
  });

  test('Safe Browsing zip is read once and extracted with containment', () => {
    const t = code(read('src/safeBrowsingProfile.ts'));
    assert.match(t, /readVerifiedPrePopulatedZip\(zipPath\)/);
    assert.match(t, /await extractZipBufferSafely\(zipData, stagingDir\)/);
    assert.match(t, /flag: 'wx'/);
    assert.match(t, /lstatSync\(from\)\.isFile\(\)/, 'copyDirectory must not follow symlinks');
    assert.doesNotMatch(t, /\bverifyPrePopulatedZip\(/, 'separate check-then-extract helper is back');
  });
});

describe('unbounded work on page-controlled input (asgard-0005, 0006, 0011)', () => {
  test('readability grading only happens behind a length cap', () => {
    const graders = grepAll(/\btextReadability\.\w+\(/).sort();
    assert.deepEqual(graders, ['src/crawlers/custom/extractAndGradeText.ts', 'src/crawlers/custom/gradeReadability.ts']);
    assert.match(code(read('src/crawlers/custom/gradeReadability.ts')), /joinWithinLimit\(sentences, MAX_READABILITY_TEXT_CHARS\)/);
    assert.match(code(read('src/crawlers/custom/extractAndGradeText.ts')), /\.slice\(0, MAX_TEXT_CHARS\)/);
    assert.match(code(read('src/crawlers/custom/extractText.ts')), /totalChars \+ trimmedSentence\.length > maxChars/);
  });

  test('no loop bounded by a parsed, unchecked number', () => {
    // e.g. for (let i = parseInt(start); i <= parseInt(end); i++) from asgard-0006
    assert.deepEqual(grepAll(/for \(let \w+ = (parseInt|parseFloat|Number)\(/), []);
    assert.deepEqual(grepAll(/<=? ?(parseInt|parseFloat|Number)\([^)]*\)[^;]*;\s*\w+\+\+/), []);
  });

  test('PDF location page span stays capped', () => {
    const t = code(read('src/screenshotFunc/pdfScreenshotFunc.ts'));
    assert.match(t, /endPage - startPage > MAX_PDF_LOCATION_PAGE_SPAN/);
  });

  test('page capture stays bounded', () => {
    const t = code(read('src/crawlers/pageCapture.ts'));
    assert.doesNotMatch(t, /querySelectorAll\('\*'\)/, 'enumerate with the capped TreeWalker');
    assert.doesNotMatch(t, /Array\.from\(parent\.children\)\.filter/, 'quadratic sibling scan is back');
    assert.equal(count(t, /await page\.content\(\)/), 1, 'page.content() only inside readBoundedDom');
    assert.equal(count(t, /readBoundedDom\(page\)/), 2, 'desktop + mobile DOM saves');
    assert.match(t, /results\.length >= maxElements/);
    assert.match(t, /approxChars \+ size > maxChars/);
  });
});

describe('third-party script integrity (asgard-0007)', () => {
  test('generator fails closed and the loader never injects without a pin', () => {
    const t = read('src/generateOobeeClientScanner.ts');
    assert.match(t, /Refusing to emit a bundle without an SRI pin/);
    assert.match(t, /process\.exit\(1\);/);
    assert.match(t, /if \(!_oobeeSentrySdkSri\) \{\s*reject\(/);
    assert.doesNotMatch(t, /if \(_oobeeSentrySdkSri\) \{/, 'integrity is optional again');
  });

  test('committed client bundle is pinned', () => {
    const bundle = path.join(root, 'oobee-client-scanner.js');
    if (!fs.existsSync(bundle)) return;
    assert.match(fs.readFileSync(bundle, 'utf8'), /_oobeeSentrySdkSri\s*=\s*"sha(256|384|512)-/);
  });

  test('no other script injected from a CDN without integrity', () => {
    const offenders = SOURCES.filter(
      s => /\.src\s*=\s*['"`]https?:\/\//.test(s.text) && !/\.integrity\s*=/.test(s.text),
    ).map(s => s.file);
    assert.deepEqual(offenders, []);
  });
});

describe('module-level caches (asgard-0009)', () => {
  // Module-level collections live for the whole process. Constant lookup
  // sets are fine; anything filled at runtime from page/network input must be
  // size-bounded or cleared per scan.
  const REVIEWED = {
    'src/crawlers/pageCapture.ts:captureEntries': 'cleared per scan by resetCaptureEntries()',
    // Keys are WCAG criterion IDs matching /wcag[0-9]{3,4}/ from axe rule
    // metadata (~90 possible), so size is bounded. Note: never cleared, so
    // counts accumulate across scans in a long-lived process (telemetry only).
    'src/mergeAxeResults.ts:wcagOccurrencesMap': 'bounded key set (WCAG criteria)',
  };

  test('no new unbounded module-level Map/Set', () => {
    const found = [];
    for (const s of SOURCES) {
      for (const line of s.text.split('\n')) {
        const m = line.match(/^(?:export )?(?:const|let) (\w+)\s*(?::[^=]+)?=\s*new (Map|Set|WeakMap|WeakSet)\b(.*)$/);
        if (!m) continue;
        const [, name, kind, rest] = m;
        if (kind.startsWith('Weak')) continue;
        if (kind === 'Set' && /^\(\s*\[/.test(rest)) continue; // constant literal set
        const key = `${s.file}:${name}`;
        if (!REVIEWED[key]) found.push(key);
      }
    }
    assert.deepEqual(found, [], 'Use BoundedTtlCache (cfProxyWorker.ts) or clear it per scan, then add to REVIEWED');
  });

  test('DoH cache stays bounded', () => {
    assert.match(code(read('src/cfProxyWorker.ts')), /const dohCache = new BoundedTtlCache</);
  });

  test('captureEntries is still cleared per scan', () => {
    assert.match(code(read('src/combine.ts')), /resetCaptureEntries\(\)/);
  });
});
