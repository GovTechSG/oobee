import type { BrowserContext, Page } from 'playwright';
import { getAllOverlayUrlPatterns, overlayVendors } from './overlayVendors.js';
import { consoleLogger } from '../logs.js';
import type { OverlayDetection } from './overlayDetector.js';

/**
 * Utility: very simple glob matcher for patterns like **://host/** and *.
 * This is not used by Playwright routing (Playwright has its own matcher),
 * but we reuse it for diagnostics.
 */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  // Escape regex special chars except * which we treat as a wildcard
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(url);
}

/**
 * Attach network-level blocking of known overlay scripts to a Playwright BrowserContext.
 *
 * This should be called immediately after creating the BrowserContext and before
 * navigating to any pages.
 *
 * Returns a function that can be called to get the list of blocked overlays.
 */
export function attachOverlayNeutralization(context: BrowserContext): () => OverlayDetection[] {
  const patterns = getAllOverlayUrlPatterns();
  const blockedOverlays = new Set<string>();

  patterns.forEach(pattern => {
    context.route(pattern, route => {
      const url = route.request().url();

      // Identify which vendor this URL belongs to
      const vendor = overlayVendors.find(v => v.urlPatterns.some(p => urlMatchesPattern(url, p)));

      if (vendor) {
        blockedOverlays.add(vendor.name);
        consoleLogger.info(`[overlay-neutralizer] 🚫 Blocking ${vendor.name} overlay: ${url}`);
      } else {
        consoleLogger.info(`[overlay-neutralizer] Blocking overlay resource: ${url}`);
      }

      return route.abort();
    });
  });

  // Optional diagnostics: log potential overlay requests
  context.on('request', req => {
    const url = req.url();
    if (patterns.some(p => urlMatchesPattern(url, p))) {
      consoleLogger.info(`[overlay-neutralizer] Overlay request detected: ${url}`);
    }
  });

  // Return a function that provides the list of blocked overlays
  return () => {
    return Array.from(blockedOverlays).map(vendorName => ({
      vendor: vendorName,
      detectedBy: ['network-blocking'],
      details: [`Blocked at network level before script could load`],
    }));
  };
}

/**
 * Fallback DOM scrubber.
 *
 * Use this only when you cannot block scripts at the network level.
 * This is intentionally conservative: it removes obvious widget DOM roots,
 * relaxes aria-hidden on containers that wrap main content, and restores
 * body scrolling if disabled.
 */
export async function scrubOverlaysOnPage(page: Page): Promise<void> {
  consoleLogger.info('[overlay-neutralizer] 🧹 Starting DOM scrubbing for overlay elements...');

  const scrubbingResult = await page.evaluate(() => {
    const results = {
      removedElements: 0,
      fixedAriaHidden: 0,
      restoredScrolling: false,
      removedSelectors: [] as string[],
    };

    try {
      const vendorSignatures = [
        '#userwayAccessibilityIcon',
        '.userway',
        '.uwy',
        '[data-userway-widget]',
        'script#a11yWidgetSrc',
        '#acsb-widget',
        '.acsb-widget',
        'iframe#acsb-iframe',
        '#ew_widget',
        '.ew-accessibility-menu',
        '[data-equalweb]',
        '#ae-toolbar',
        '.ae-toolbar',
        '#monsido_tooltip_wrapper',
        '.monsido-toolbar',
      ];

      vendorSignatures.forEach(sel => {
        try {
          const elements = document.querySelectorAll(sel);
          if (elements.length > 0) {
            results.removedSelectors.push(sel);
            results.removedElements += elements.length;
          }
          elements.forEach(node => {
            node.remove();
          });
        } catch {
          // ignore selector errors
        }
      });

      document.querySelectorAll('[aria-hidden="true"]').forEach(node => {
        try {
          if (node.querySelector && node.querySelector('main, #main, #content, [role=main]')) {
            node.removeAttribute('aria-hidden');
            results.fixedAriaHidden += 1;
          }
        } catch {
          // ignore
        }
      });

      // Restore scrolling if an overlay has locked it
      if (document.body && document.body.style && document.body.style.overflow === 'hidden') {
        document.body.style.overflow = '';
        results.restoredScrolling = true;
      }
    } catch {
      // fail-safe: never break the page if scrubber fails
    }

    return results;
  });

  if (scrubbingResult.removedElements > 0) {
    consoleLogger.info(
      `[overlay-neutralizer] 🗑️  Removed ${scrubbingResult.removedElements} overlay element(s): ${scrubbingResult.removedSelectors.join(', ')}`,
    );
  } else {
    consoleLogger.info('[overlay-neutralizer] ✓ No overlay DOM elements found to remove');
  }

  if (scrubbingResult.fixedAriaHidden > 0) {
    consoleLogger.info(
      `[overlay-neutralizer] 🔓 Fixed aria-hidden on ${scrubbingResult.fixedAriaHidden} main content container(s)`,
    );
  }

  if (scrubbingResult.restoredScrolling) {
    consoleLogger.info('[overlay-neutralizer] 📜 Restored body scrolling');
  }

  consoleLogger.info('[overlay-neutralizer] ✅ DOM scrubbing complete');

  await page.addScriptTag({
    content: `
      (function() {
        try {
          var vendorSignatures = [
            // UserWay
            "#userwayAccessibilityIcon",
            ".userway",
            ".uwy",
            "[data-userway-widget]",
            "script#a11yWidgetSrc",
            // accessiBe
            "#acsb-widget",
            ".acsb-widget",
            "iframe#acsb-iframe",
            // EqualWeb
            "#ew_widget",
            ".ew-accessibility-menu",
            "[data-equalweb]",
            // AudioEye
            "#ae-toolbar",
            ".ae-toolbar",
            // Monsido
            "#monsido_tooltip_wrapper",
            ".monsido-toolbar"
          ];

          vendorSignatures.forEach(function(sel) {
            try {
              document.querySelectorAll(sel).forEach(function(node) {
                node.remove();
              });
            } catch (e) {
              // ignore selector errors
            }
          });

          // Relax aria-hidden on containers that obviously wrap main content
          document.querySelectorAll('[aria-hidden="true"]').forEach(function(node) {
            try {
              if (node.querySelector && node.querySelector("main, #main, #content, [role=main]")) {
                node.removeAttribute("aria-hidden");
              }
            } catch (e) {
              // ignore
            }
          });

          // Restore scrolling if an overlay has locked it
          if (document.body && document.body.style && document.body.style.overflow === "hidden") {
            document.body.style.overflow = "";
          }
        } catch (e) {
          // fail-safe: never break the page if scrubber fails
          console.warn("[overlay-neutralizer] scrubOverlaysOnPage script error", e);
        }
      })();
    `,
  });
}
