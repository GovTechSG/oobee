/**
 * generateOobeeClientScanner.ts
 *
 * Standalone script that generates oobee-client-scanner.js — a self-contained
 * browser bundle that runs axe-core + oobee custom checks and returns results
 * in the same JSON format as npmIndex's processAndSubmitResults.
 *
 * Usage (after `npm run build`):
 *   node dist/generateOobeeClientScanner.js [output-path]
 *
 * Default output: ./oobee-client-scanner.js (relative to cwd)
 *
 * Then in your HTML:
 *   <script src="oobee-client-scanner.js"></script>
 *   <script>
 *     window.oobee.scan().then(results => console.log(results));
 *   </script>
 */

import { writeFileSync } from 'fs';
import path from 'path';
import axe from 'axe-core';
import {
  a11yRuleShortDescriptionMap,
  a11yRuleLongDescriptionMap,
  a11yRuleStepByStepGuide,
} from './constants/constants.js';
import { getOobeeFunctionsScript } from './npmIndex.js';

// ---------------------------------------------------------------------------
// filterAxeResults — browser-compatible version (mirrors commonCrawlerFunc.ts)
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

    var totalItems = 0;
    var mustFix    = { totalItems: 0, rules: {} };
    var goodToFix  = { totalItems: 0, rules: {} };
    var needsReview= { totalItems: 0, rules: {} };
    var passed     = { totalItems: 0, rules: {} };

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

      // Ensure wcag level tags come first (mirrors TS sort logic)
      if (conformance[0] !== 'best-practice' && !wcagLevelRegex.test(conformance[0])) {
        conformance.sort(function(a, b) {
          if (wcagLevelRegex.test(a) && !wcagLevelRegex.test(b)) return -1;
          if (!wcagLevelRegex.test(a) &&  wcagLevelRegex.test(b)) return  1;
          return 0;
        });
      }

      var hasWcagA  = conformance.some(function(t) { return /^wcag\\d*a$/.test(t);  });
      var hasWcagAA = conformance.some(function(t) { return /^wcag\\d*aa$/.test(t); });

      var category = displayNeedsReview    ? needsReview
                   : (hasWcagA || hasWcagAA) ? mustFix
                   : goodToFix;

      nodes.forEach(function(node) {
        var html           = node.html || '';
        var failureSummary = node.failureSummary || '';
        var target         = node.target         || [];
        var axeImpact      = node.impact;

        if (!(rule in category.rules)) {
          category.rules[rule] = {
            rule:        rule,
            description: description,
            axeImpact:   axeImpact,
            helpUrl:     helpUrl,
            conformance: conformance,
            totalItems:  0,
            items:       [],
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
          html:               finalHtml,
          message:            message,
          xpath:              xpath,
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
            rule:        rule,
            description: description,
            axeImpact:   axeImpact,
            helpUrl:     helpUrl,
            conformance: conformance,
            totalItems:  0,
            items:       [],
          };
        }
        var passedXpath = (node.target && node.target.length === 1 && typeof node.target[0] === 'string')
          ? node.target[0] : undefined;
        passed.rules[rule].items.push({
          html:           _oobeeTruncateHtml(node.html || ''),
          screenshotPath: '',
          message:        '',
          xpath:          passedXpath,
        });
        passed.totalItems              += 1;
        passed.rules[rule].totalItems  += 1;
        totalItems                     += 1;
      });
    });

    return {
      url:         url,
      pageTitle:   pageTitle,
      totalItems:  totalItems,
      mustFix:     mustFix,
      goodToFix:   goodToFix,
      needsReview: needsReview,
      passed:      passed,
    };
  }
`;

// ---------------------------------------------------------------------------
// scan API — sets window globals then calls runA11yScan + filterAxeResults
// ---------------------------------------------------------------------------
const scanApiScript = (
  shortDescMap: Record<string, string>,
  longDescMap: Record<string, string>,
  stepByStepMap: Record<string, { check: string; fix: string; review: string; learn: string }>,
) => `
  var _oobeeShortDescMap    = ${JSON.stringify(shortDescMap)};
  var _oobeeLongDescMap     = ${JSON.stringify(longDescMap)};
  var _oobeeStepByStepGuide = ${JSON.stringify(stepByStepMap)};

  /**
   * window.oobee.scan(options?) — scan the current page for accessibility issues.
   *
   * @param {object}   [options]
   * @param {boolean}  [options.disableOobee=false]   - Disable oobee custom checks.
   * @param {boolean}  [options.enableWcagAaa=false]  - Include WCAG 2 AAA rules.
   * @param {Array}    [options.elementsToScan=[]]    - CSS selectors / DOM nodes to scope
   *                                                    the scan; empty = full page.
   * @returns {Promise<object>} Oobee scan result (same shape as npmIndex JSON output).
   */
  window.oobee = {
    scan: async function(options) {
      var opts          = options || {};
      var disableOobee  = opts.disableOobee  !== undefined ? !!opts.disableOobee  : false;
      var enableWcagAaa = opts.enableWcagAaa !== undefined ? !!opts.enableWcagAaa : false;
      var elementsToScan = opts.elementsToScan || [];

      // Update window globals that runA11yScan reads
      window.disableOobee  = disableOobee;
      window.enableWcagAaa = enableWcagAaa;

      // Run axe + oobee custom checks
      var scanResult = await window.runA11yScan(elementsToScan, '');

      // Convert raw axe results into oobee category format
      var filtered = _oobeeFilterAxeResults(scanResult.axeScanResults, scanResult.pageTitle);

      // Enrich each rule with oobee knowledge-base descriptions
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

      return filtered;
    },
  };

  console.log(
    '[oobee-client-scanner] Ready. Call window.oobee.scan() to scan this page for accessibility issues.'
  );
`;

// ---------------------------------------------------------------------------
// Assemble full client bundle
// ---------------------------------------------------------------------------
function generateClientBundle(): string {
  const axeSource       = axe.source;
  // defaults: disableOobee=false, enableWcagAaa=false — overridden at scan() call time
  const oobeeFunctions  = getOobeeFunctionsScript(false, false);

  return `/**
 * oobee-client-scanner.js — auto-generated by generateOobeeClientScanner.ts
 * DO NOT EDIT MANUALLY. Re-generate with: node dist/generateOobeeClientScanner.js
 *
 * Usage:
 *   <script src="oobee-client-scanner.js"></script>
 *   <script>
 *     window.oobee.scan().then(results => console.log(JSON.stringify(results, null, 2)));
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
