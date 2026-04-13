/**
 * generateOobeeClientScanner.ts
 *
 * Standalone script that generates oobee-client-scanner.js — a self-contained
 * browser bundle that runs axe-core + oobee custom checks, returns results in
 * the same JSON format as npmIndex's processAndSubmitResults, and reports
 * telemetry to Sentry using the official Sentry JavaScript browser SDK.
 *
 * Usage (after `npm run build`):
 *   node dist/generateOobeeClientScanner.js [output-path]
 *
 * Default output: ./oobee-client-scanner.js (relative to cwd)
 *
 * Environment variables read at generation time:
 *   OOBEE_SENTRY_DSN  — Sentry DSN to embed in the bundle (falls back to the
 *                        default DSN in constants.ts if not set)
 *
 * Then in your HTML:
 *   <script src="oobee-client-scanner.js"></script>
 *   <script>
 *     window.oobee.scan({
 *       userInfo:       { email: 'you@example.com', name: 'Your Name' },
 *       // scanMode:    [string]  choices: "default" | "disable-oobee" | "enable-wcag-aaa" | "disable-oobee,enable-wcag-aaa"
 *       disableOobee:   false,   // true → skip oobee custom checks
 *       enableWcagAaa:  true,   // true → also run WCAG AAA rules
 *       elementsToScan: [],      // [] = full page; or CSS selectors / DOM nodes
 *     }).then(results => console.log(results));
 *
 *     // Scroll to an element by CSS selector (item.xpath from scan results):
 *     window.oobee.scrollToElement(item.xpath);
 *   </script>
 */

import { writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import axe from 'axe-core';
import {
  a11yRuleShortDescriptionMap,
  a11yRuleLongDescriptionMap,
  a11yRuleStepByStepGuide,
  sentryConfig,
  wcagCriteriaLabels,
  formatWcagId,
} from './constants/constants.js';
import { getOobeeFunctionsScript } from './npmIndex.js';
import { getVersion } from './utils.js';

const _require  = createRequire(import.meta.url);
const _filename = fileURLToPath(import.meta.url);
const _dirname  = path.dirname(_filename);

// ---------------------------------------------------------------------------
// Sentry config — DSN is read from process.env at generation time
// ---------------------------------------------------------------------------
const SENTRY_DSN: string     = sentryConfig.dsn;               // already resolves OOBEE_SENTRY_DSN || default
const APP_VERSION: string    = getVersion();
const SENTRY_NODE_VERSION: string = (() => {
  try {
    return _require('@sentry/node/package.json').version as string;
  } catch {
    return '9.47.1';   // safe fallback matching currently installed version
  }
})();

// ---------------------------------------------------------------------------
// WCAG conformance helpers — formatWcagId and wcagCriteriaLabels are exported
// from constants.ts; embedded here so the browser bundle has the same logic.
// ---------------------------------------------------------------------------
const wcagConformanceScript = `
  // Format a numeric WCAG criterion tag (mirrors formatWcagId in constants.ts).
  // e.g. wcag143 → "WCAG 1.4.3",  wcag1412 → "WCAG 1.4.12"
  var _oobeeFormatWcagId = ${formatWcagId.toString()};

  // Criteria → level map (mirrors wcagCriteriaLabels in constants.ts).
  var _oobeeWcagCriteriaLabels = ${JSON.stringify(wcagCriteriaLabels, null, 2)};

  /**
   * Given an axe-core conformance array (e.g. ["wcag2a","wcag111","wcag143"]),
   * returns the formatted criteria labels and the resolved level string —
   * mirrors the logic used in ruleOffcanvas.ejs / AllIssues.ejs.
   *
   * Returns: { criteria: string[], level: string|null }
   *   criteria — e.g. ["WCAG 1.1.1", "WCAG 1.4.3"]
   *   level    — e.g. "A", "AA", "AAA", or null if none found
   */
  function _oobeeFormatConformance(conformance) {
    var wcagTags = (conformance || []).filter(function(c) { return c.startsWith('wcag'); });
    var criteria = [];
    var level = null;
    wcagTags.forEach(function(tag) {
      var formatted = _oobeeFormatWcagId(tag);
      if (_oobeeWcagCriteriaLabels[formatted]) {
        criteria.push(formatted);
        if (!level) level = _oobeeWcagCriteriaLabels[formatted];
      }
    });
    return { criteria: criteria, level: level };
  }
`;

// ---------------------------------------------------------------------------
// filterAxeResults — browser-compatible (mirrors commonCrawlerFunc.ts)
// ---------------------------------------------------------------------------
const filterAxeResultsScript = `
  function _oobeeTruncateHtml(html, maxBytes, suffix) {
    maxBytes = maxBytes !== undefined ? maxBytes : 1024;
    suffix   = suffix   !== undefined ? suffix   : '\\u2026'; // '…'
    var encoder = new TextEncoder();
    if (encoder.encode(html).length <= maxBytes) return html;
    var left = 0, right = html.length, result = '';
    while (left <= right) {
      var mid = Math.floor((left + right) / 2);
      var truncated = html.slice(0, mid) + suffix;
      var bytes = encoder.encode(truncated).length;
      if (bytes <= maxBytes) { result = truncated; left = mid + 1; }
      else { right = mid - 1; }
    }
    return result;
  }

  function _oobeeFilterAxeResults(axeResults, pageTitle) {
    var violations = axeResults.violations || [];
    var passes     = axeResults.passes     || [];
    var incomplete = axeResults.incomplete || [];
    var url        = axeResults.url        || (typeof window !== 'undefined' ? window.location.href : '');

    var totalItems  = 0;
    var mustFix     = { totalItems: 0, rules: {} };
    var goodToFix   = { totalItems: 0, rules: {} };
    var needsReview = { totalItems: 0, rules: {} };
    var passed      = { totalItems: 0, rules: {} };

    var wcagLevelRegex = /^wcag\\d+a+$/;

    function processItem(item, displayNeedsReview) {
      var rule        = item.id;
      var description = item.help;
      var helpUrl     = item.helpUrl;
      var tags        = item.tags  || [];
      var nodes       = item.nodes || [];

      if (rule === 'frame-tested') return;

      var conformance = tags.filter(function(t) {
        return t.startsWith('wcag') || t === 'best-practice';
      });

      if (conformance[0] !== 'best-practice' && !wcagLevelRegex.test(conformance[0])) {
        conformance.sort(function(a, b) {
          if (wcagLevelRegex.test(a) && !wcagLevelRegex.test(b)) return -1;
          if (!wcagLevelRegex.test(a) &&  wcagLevelRegex.test(b)) return  1;
          return 0;
        });
      }

      var hasWcagA  = conformance.some(function(t) { return /^wcag\\d*a$/.test(t);  });
      var hasWcagAA = conformance.some(function(t) { return /^wcag\\d*aa$/.test(t); });

      var category = displayNeedsReview      ? needsReview
                   : (hasWcagA || hasWcagAA) ? mustFix
                   : goodToFix;

      nodes.forEach(function(node) {
        var html           = node.html || '';
        var failureSummary = node.failureSummary || '';
        var target         = node.target         || [];
        var axeImpact      = node.impact;

        if (!(rule in category.rules)) {
          category.rules[rule] = {
            rule: rule, description: description, axeImpact: axeImpact,
            helpUrl: helpUrl, conformance: conformance, totalItems: 0, items: [],
          };
        }

        var message = displayNeedsReview
          ? failureSummary.slice(failureSummary.indexOf('\\n') + 1).trim()
          : failureSummary;

        var finalHtml = html;
        if (html.includes('<\\/script>')) {
          finalHtml = html.replaceAll('<\\/script>', '&lt;/script>');
        }
        finalHtml = _oobeeTruncateHtml(finalHtml);

        var xpath = (target.length === 1 && typeof target[0] === 'string') ? target[0] : undefined;

        category.rules[rule].items.push({
          html: finalHtml, message: message, xpath: xpath,
          displayNeedsReview: displayNeedsReview || undefined,
        });
        category.rules[rule].totalItems += 1;
        category.totalItems             += 1;
        totalItems                      += 1;
      });
    }

    violations.forEach(function(item) { processItem(item, false); });
    incomplete.forEach(function(item) { processItem(item, true);  });

    passes.forEach(function(item) {
      var rule        = item.id;
      var description = item.help;
      var axeImpact   = item.impact;
      var helpUrl     = item.helpUrl;
      var tags        = item.tags  || [];
      var nodes       = item.nodes || [];

      if (rule === 'frame-tested') return;

      var conformance = tags.filter(function(t) {
        return t.startsWith('wcag') || t === 'best-practice';
      });

      nodes.forEach(function(node) {
        if (!(rule in passed.rules)) {
          passed.rules[rule] = {
            rule: rule, description: description, axeImpact: axeImpact,
            helpUrl: helpUrl, conformance: conformance, totalItems: 0, items: [],
          };
        }
        var passedXpath = (node.target && node.target.length === 1 && typeof node.target[0] === 'string')
          ? node.target[0] : undefined;
        passed.rules[rule].items.push({
          html: _oobeeTruncateHtml(node.html || ''), screenshotPath: '',
          message: '', xpath: passedXpath,
        });
        passed.totalItems             += 1;
        passed.rules[rule].totalItems += 1;
        totalItems                    += 1;
      });
    });

    return {
      url: url, pageTitle: pageTitle, totalItems: totalItems,
      mustFix: mustFix, goodToFix: goodToFix, needsReview: needsReview, passed: passed,
    };
  }
`;

// ---------------------------------------------------------------------------
// Sentry telemetry — uses the official Sentry JavaScript browser SDK loaded
// from CDN (same major version as the installed @sentry/node build).
// DSN and app version are baked in at generation time.
// ---------------------------------------------------------------------------
const sentryTelemetryScript = (dsn: string, appVersion: string, sentryVersion: string) => `
  var _oobeeSentryDsn          = ${JSON.stringify(dsn)};
  var _oobeeAppVersion         = ${JSON.stringify(appVersion)};
  var _oobeeSentryVersion      = ${JSON.stringify(sentryVersion)};
  var _oobeeSentryInitialized  = false;
  var _oobeeSentryLoadPromise  = null;

  /**
   * Lazily load the Sentry JavaScript browser SDK from CDN and return the
   * global Sentry object.  Subsequent calls reuse the same promise.
   */
  function _oobeeLoadSentry() {
    if (_oobeeSentryLoadPromise) return _oobeeSentryLoadPromise;

    _oobeeSentryLoadPromise = new Promise(function(resolve, reject) {
      // Already present (e.g. host page loaded Sentry itself)
      if (window.Sentry && typeof window.Sentry.init === 'function') {
        resolve(window.Sentry);
        return;
      }
      var script = document.createElement('script');
      script.src = 'https://browser.sentry-cdn.com/' + _oobeeSentryVersion + '/bundle.min.js';
      script.crossOrigin = 'anonymous';
      script.onload = function() {
        if (window.Sentry && typeof window.Sentry.init === 'function') {
          resolve(window.Sentry);
        } else {
          reject(new Error('[oobee] Sentry SDK loaded but window.Sentry not found'));
        }
      };
      script.onerror = function() {
        reject(new Error('[oobee] Failed to load Sentry browser SDK from CDN'));
      };
      document.head.appendChild(script);
    });

    return _oobeeSentryLoadPromise;
  }

  /**
   * Build WCAG occurrence map and per-criterion level map from scan results.
   * Mirrors the logic in npmIndex.ts processAndSubmitResults.
   */
  function _oobeeBuildWcagData(results) {
    var wcagOccurrencesMap = {};  // { wcag111: 3, wcag412: 1, ... }
    var criterionLevel     = {};  // { wcag111: 'a', wcag143: 'aa', ... }
    var criterionRegex     = /^wcag[0-9]{3,4}$/;

    ['mustFix', 'goodToFix', 'needsReview'].forEach(function(cat) {
      var catData = results[cat];
      if (!catData || !catData.rules) return;

      Object.values(catData.rules).forEach(function(rule) {
        if (!rule.conformance) return;

        // Derive level from conformance level-tags (wcag2a / wcag2aa / wcag2aaa)
        var level = '';
        var criteria = [];
        rule.conformance.forEach(function(c) {
          if      (/^wcag\\d+aaa$/.test(c)) { if (!level) level = 'aaa'; }
          else if (/^wcag\\d+aa$/.test(c))  { if (!level) level = 'aa';  }
          else if (/^wcag\\d+a$/.test(c))   { if (!level) level = 'a';   }
          else if (criterionRegex.test(c))  { criteria.push(c); }
        });

        criteria.forEach(function(c) {
          // Keep the most severe level seen for a criterion
          var existing = criterionLevel[c];
          if (!existing || level === 'aaa' ||
              (level === 'aa' && existing === 'a') ||
              (level === 'a'  && !existing)) {
            criterionLevel[c] = level;
          }
        });

        // Only count violations for the occurrence map (mustFix + goodToFix)
        if (cat === 'mustFix' || cat === 'goodToFix') {
          criteria.forEach(function(c) {
            wcagOccurrencesMap[c] = (wcagOccurrencesMap[c] || 0) + rule.totalItems;
          });
        }
      });
    });

    return { wcagOccurrencesMap: wcagOccurrencesMap, criterionLevel: criterionLevel };
  }

  /**
   * Send an "Accessibility Scan Page" event to Sentry using the official
   * Sentry JavaScript browser SDK API:
   *   Sentry.init / Sentry.setUser / Sentry.captureEvent / Sentry.flush
   *
   * @param {object} results   - Full oobee scan result from window.oobee.scan()
   * @param {object} userInfo  - { email, name } provided by the implementer
   */
  async function _oobeeSendSentryTelemetry(results, userInfo) {
    if (!_oobeeSentryDsn) return;

    try {
      var Sentry = await _oobeeLoadSentry();

      // Initialise once per page load
      if (!_oobeeSentryInitialized) {
        Sentry.init({
          dsn:                _oobeeSentryDsn,
          tracesSampleRate:   1.0,
        });
        _oobeeSentryInitialized = true;
      }

      // ── User context ────────────────────────────────────────────────────
      Sentry.setUser({
        email:    (userInfo && userInfo.email) || undefined,
        username: (userInfo && userInfo.name)  || undefined,
      });

      // ── WCAG breakdown tags ─────────────────────────────────────────────
      var wcagData = _oobeeBuildWcagData(results);
      var wcagOccurrencesMap = wcagData.wcagOccurrencesMap;
      var criterionLevel     = wcagData.criterionLevel;

      var tags                 = {};
      var wcagCriteriaBreakdown = {};

      // Format: wcag111a_Occurrences  (mirrors sentryTelemetry.ts formatWcagTag)
      Object.keys(wcagOccurrencesMap).forEach(function(wcagId) {
        var level        = criterionLevel[wcagId] || '';
        var formattedTag = wcagId + level + '_Occurrences';
        tags[formattedTag]                  = String(wcagOccurrencesMap[wcagId]);
        wcagCriteriaBreakdown[formattedTag] = { count: wcagOccurrencesMap[wcagId] };
      });

      // ── Category counts & occurrences ───────────────────────────────────
      var mustFixRules     = results.mustFix     ? Object.keys(results.mustFix.rules)     : [];
      var goodToFixRules   = results.goodToFix   ? Object.keys(results.goodToFix.rules)   : [];
      var needsReviewRules = results.needsReview ? Object.keys(results.needsReview.rules) : [];

      tags['version']                      = _oobeeAppVersion;
      tags['WCAG-MustFix-Count']           = String(mustFixRules.length);
      tags['WCAG-GoodToFix-Count']         = String(goodToFixRules.length);
      tags['WCAG-NeedsReview-Count']       = String(needsReviewRules.length);
      tags['WCAG-MustFix-Occurrences']     = String(results.mustFix     ? results.mustFix.totalItems     : 0);
      tags['WCAG-GoodToFix-Occurrences']   = String(results.goodToFix   ? results.goodToFix.totalItems   : 0);
      tags['WCAG-NeedsReview-Occurrences'] = String(results.needsReview ? results.needsReview.totalItems : 0);
      tags['Pages-Scanned-Count']          = '1';

      // ── Capture event ───────────────────────────────────────────────────
      Sentry.captureEvent({
        message: 'Accessibility Scan Page',
        level:   'info',
        tags: Object.assign({}, tags, {
          event_type: 'accessibility_scan',
          scanType:   'browser',
          browser:    'browser',
          entryUrl:   window.location.href,
        }),
        extra: {
          wcagBreakdown: wcagCriteriaBreakdown,
          reportCounts: {
            mustFix:     { issues: mustFixRules.length,     occurrences: results.mustFix     ? results.mustFix.totalItems     : 0 },
            goodToFix:   { issues: goodToFixRules.length,   occurrences: results.goodToFix   ? results.goodToFix.totalItems   : 0 },
            needsReview: { issues: needsReviewRules.length, occurrences: results.needsReview ? results.needsReview.totalItems : 0 },
          },
        },
      });

      await Sentry.flush(2000);

    } catch (err) {
      // Telemetry failures must never break the caller
      console.error('[oobee-client-scanner] Sentry telemetry error:', err);
    }
  }
`;

// ---------------------------------------------------------------------------
// scan API — enriches results and fires Sentry telemetry
// ---------------------------------------------------------------------------
const scanApiScript = (
  shortDescMap:  Record<string, string>,
  longDescMap:   Record<string, string>,
  stepByStepMap: Record<string, { check: string; fix: string; review: string; learn: string }>,
) => `
  var _oobeeShortDescMap    = ${JSON.stringify(shortDescMap)};
  var _oobeeLongDescMap     = ${JSON.stringify(longDescMap)};
  var _oobeeStepByStepGuide = ${JSON.stringify(stepByStepMap)};

  /**
   * window.oobee.scan(options?) — scan the current page for accessibility issues.
   *
   * @param {object}  [options]
   * @param {boolean} [options.disableOobee=false]   Disable oobee custom checks.
   * @param {boolean} [options.enableWcagAaa=false]  Include WCAG 2 AAA rules.
   * @param {Array}   [options.elementsToScan=[]]    CSS selectors / DOM nodes to
   *                                                  scope the scan; [] = full page.
   * @param {object}  [options.userInfo]             Implementer-supplied identity.
   * @param {string}  [options.userInfo.email]       User e-mail for Sentry telemetry.
   * @param {string}  [options.userInfo.name]        User name  for Sentry telemetry.
   *
   * @returns {Promise<object>} Oobee scan result (same shape as npmIndex JSON output).
   */
  window.oobee = {
    scan: async function(options) {
      var opts           = options || {};
      var disableOobee   = opts.disableOobee  !== undefined ? !!opts.disableOobee  : false;
      var enableWcagAaa  = opts.enableWcagAaa !== undefined ? !!opts.enableWcagAaa : false;
      var elementsToScan = opts.elementsToScan || [];
      var userInfo       = opts.userInfo       || {};

      // Update window globals read by runA11yScan
      window.disableOobee  = disableOobee;
      window.enableWcagAaa = enableWcagAaa;

      // Run axe-core + oobee custom checks
      var scanResult = await window.runA11yScan(elementsToScan, '');

      // Convert raw axe results into oobee category structure
      var filtered = _oobeeFilterAxeResults(scanResult.axeScanResults, scanResult.pageTitle);

      // Enrich rules with oobee knowledge-base descriptions
      ['mustFix', 'goodToFix', 'needsReview'].forEach(function(category) {
        var cat = filtered[category];
        if (!cat || !cat.rules) return;
        Object.keys(cat.rules).forEach(function(ruleId) {
          var rule = cat.rules[ruleId];
          rule.shortDescription = _oobeeShortDescMap[ruleId];
          rule.longDescription  = _oobeeLongDescMap[ruleId];
          rule.stepByStepGuide  = _oobeeStepByStepGuide[ruleId];
        });
      });

      // Fire-and-forget Sentry telemetry (errors are caught internally)
      _oobeeSendSentryTelemetry(filtered, userInfo);

      return filtered;
    },

    /**
     * Format a raw conformance tag array into criteria labels + level.
     * Mirrors ruleOffcanvas.ejs / AllIssues.ejs logic (single source of truth
     * via formatWcagId + wcagCriteriaLabels exported from constants.ts).
     *
     * @param {string[]} conformance  e.g. ["wcag2a","wcag111","wcag143"]
     * @returns {{ criteria: string[], level: string|null }}
     *   e.g. { criteria: ["WCAG 1.1.1","WCAG 1.4.3"], level: "A" }
     */
    formatConformance: _oobeeFormatConformance,

    /**
     * Scroll the element matching the given CSS selector into view and briefly
     * highlight it with an outline flash.  The selector comes from item.xpath
     * in the scan results (axe-core stores CSS selectors there).
     *
     * @param {string} selector  CSS selector, e.g. "button:nth-child(2)"
     */
    scrollToElement: function(selector) {
      if (!selector) return;
      var el;
      try { el = document.querySelector(selector); } catch (e) { return; }
      if (!el) return;

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Brief outline flash so the element is easy to spot
      var prev = el.style.outline;
      el.style.outline = '3px solid #fd7e14';
      setTimeout(function() { el.style.outline = prev; }, 1800);
    },
  };

  console.log(
    '[oobee-client-scanner] Ready. Call window.oobee.scan() to scan this page.'
  );
`;

// ---------------------------------------------------------------------------
// Assemble the full client bundle
// ---------------------------------------------------------------------------
function generateClientBundle(): string {
  const axeSource      = axe.source;
  const oobeeFunctions = getOobeeFunctionsScript(false, false);

  return `/**
 * oobee-client-scanner.js — auto-generated by generateOobeeClientScanner.ts
 * DO NOT EDIT MANUALLY. Re-generate with: node dist/generateOobeeClientScanner.js
 *
 * Embedded at generation time:
 *   App version : ${APP_VERSION}
 *   Sentry DSN  : (from OOBEE_SENTRY_DSN env var or constants.ts default)
 *   Sentry SDK  : @sentry/browser ${SENTRY_NODE_VERSION} (loaded from CDN at runtime)
 *
 * Usage:
 *   <script src="oobee-client-scanner.js"></script>
 *   <script>
 *     window.oobee.scan({
 *       userInfo:       { email: 'you@example.com', name: 'Your Name' },
 *       // scanMode:    [string]  choices: "default" | "disable-oobee" | "enable-wcag-aaa" | "disable-oobee,enable-wcag-aaa"
 *       //                        "default"                  — axe-core + oobee custom checks, WCAG A/AA only
 *       //                        "disable-oobee"            — axe-core only, no oobee custom checks
 *       //                        "enable-wcag-aaa"          — axe-core + oobee + WCAG AAA rules
 *       //                        "disable-oobee,enable-wcag-aaa" — axe-core + WCAG AAA, no oobee checks
 *       disableOobee:   false,   // true  → same as "disable-oobee"
 *       enableWcagAaa:  true,   // true  → same as "enable-wcag-aaa"
 *       elementsToScan: [],      // [] = full page; or pass CSS selectors / DOM nodes
 *     }).then(results => console.log(JSON.stringify(results, null, 2)));
 *   </script>
 */
(function () {
  'use strict';

  // ── axe-core ──────────────────────────────────────────────────────────────
  ${axeSource}

  // ── Oobee helper functions + getAxeConfiguration + runA11yScan ───────────
  ${oobeeFunctions}

  // ── filterAxeResults (browser-compatible) ─────────────────────────────────
  ${filterAxeResultsScript}

  // ── WCAG conformance helpers (formatWcagId + wcagCriteriaLabels from constants.ts) ──
  ${wcagConformanceScript}

  // ── Sentry browser telemetry (Sentry JS SDK, loaded from CDN) ────────────
  ${sentryTelemetryScript(SENTRY_DSN, APP_VERSION, SENTRY_NODE_VERSION)}

  // ── Description maps + window.oobee API ───────────────────────────────────
  ${scanApiScript(a11yRuleShortDescriptionMap, a11yRuleLongDescriptionMap, a11yRuleStepByStepGuide)}
})();
`;
}

// ---------------------------------------------------------------------------
// Write output file
// ---------------------------------------------------------------------------
const outputArg  = process.argv[2];
const outputPath = outputArg
  ? path.resolve(outputArg)
  : path.resolve(process.cwd(), 'oobee-client-scanner.js');

writeFileSync(outputPath, generateClientBundle(), 'utf-8');
console.log(`Generated: ${outputPath}`);
console.log(`  App version  : ${APP_VERSION}`);
console.log(`  Sentry DSN   : ${SENTRY_DSN.slice(0, 40)}…`);
console.log(`  Sentry SDK   : @sentry/browser ${SENTRY_NODE_VERSION} (CDN)`);
