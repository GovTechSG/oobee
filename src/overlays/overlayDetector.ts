import type { Page } from 'playwright';
import { overlayVendors } from './overlayVendors.js';
import { consoleLogger } from '../logs.js';

export interface OverlayDetection {
  vendor: string;
  detectedBy: ('dom' | 'global' | 'network-blocking')[];
  details: string[];
}

/**
 * Detect overlays that are present in the DOM or window globals of the current page.
 *
 * Intended for:
 *  - Annotating scan results (e.g. in Oobee's per-page JSON output).
 *  - Debugging whether an overlay would have been active.
 */
export async function detectOverlaysInDom(page: Page): Promise<OverlayDetection[]> {
  const detections: OverlayDetection[] = [];
  const pageUrl = page.url();

  consoleLogger.info(`[overlay-detector] 🔍 Starting overlay detection on: ${pageUrl}`);

  // DOM-based detection
  consoleLogger.info('[overlay-detector] Checking DOM for overlay signatures...');
  const domResults = await page.evaluate(
    vendors => {
      const results: { vendor: string; signatures: string[] }[] = [];

      vendors.forEach((v: { name: string; domSignatures: string[] }) => {
        const matched: string[] = [];
        v.domSignatures.forEach((sel: string) => {
          try {
            if (document.querySelector(sel)) {
              matched.push(sel);
            }
          } catch {
            // ignore invalid selectors
          }
        });
        if (matched.length > 0) {
          results.push({ vendor: v.name, signatures: matched });
        }
      });

      return results;
    },
    overlayVendors.map(v => ({ name: v.name, domSignatures: v.domSignatures })),
  );

  domResults.forEach(r => {
    consoleLogger.info(
      `[overlay-detector] 🎯 DOM detection: Found ${r.vendor} via selectors: ${r.signatures.join(', ')}`,
    );
    detections.push({
      vendor: r.vendor,
      detectedBy: ['dom'],
      details: r.signatures,
    });
  });

  if (domResults.length === 0) {
    consoleLogger.info('[overlay-detector] ✓ No overlays detected in DOM');
  }

  // Global object detection
  consoleLogger.info('[overlay-detector] Checking window globals for overlay objects...');
  const globalResults = await page.evaluate(
    vendors => {
      const found: { vendor: string; globals: string[] }[] = [];
      vendors.forEach((v: { name: string; globalObjects: string[] }) => {
        const matched: string[] = [];
        v.globalObjects.forEach((g: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = window as any;
          if (typeof w[g] !== 'undefined') {
            matched.push(g);
          }
        });
        if (matched.length > 0) {
          found.push({ vendor: v.name, globals: matched });
        }
      });
      return found;
    },
    overlayVendors.map(v => ({ name: v.name, globalObjects: v.globalObjects })),
  );

  globalResults.forEach(r => {
    const existing = detections.find(d => d.vendor === r.vendor);
    if (existing) {
      consoleLogger.info(
        `[overlay-detector] 🎯 Global detection: ${r.vendor} also found via globals: ${r.globals.join(', ')}`,
      );
      if (!existing.detectedBy.includes('global')) {
        existing.detectedBy.push('global');
      }
      existing.details.push(...r.globals);
    } else {
      consoleLogger.info(
        `[overlay-detector] 🎯 Global detection: Found ${r.vendor} via globals: ${r.globals.join(', ')}`,
      );
      detections.push({
        vendor: r.vendor,
        detectedBy: ['global'],
        details: r.globals,
      });
    }
  });

  if (globalResults.length === 0) {
    consoleLogger.info('[overlay-detector] ✓ No overlays detected in window globals');
  }

  // Final summary
  if (detections.length > 0) {
    const vendorNames = detections.map(d => d.vendor).join(', ');
    consoleLogger.info(
      `[overlay-detector] 📊 SUMMARY: Detected ${detections.length} overlay vendor(s): ${vendorNames}`,
    );
  } else {
    consoleLogger.info(
      '[overlay-detector] ✅ SUMMARY: No accessibility overlays detected on this page',
    );
  }

  return detections;
}
