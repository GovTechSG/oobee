import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { Page, devices } from 'playwright';
import { getStoragePath } from '../utils.js';

const MOBILE_VIEWPORT_WIDTH = devices['iPhone 11'].viewport.width;
const MOBILE_VIEWPORT_HEIGHT = devices['iPhone 11'].viewport.height;

export interface PageCaptureEntry {
  url: string;
  hash: string;
  desktopDom?: string;
  mobileDom?: string;
  desktopScreenshot?: string;
  mobileScreenshot?: string;
  desktopComputedStyles?: string;
  mobileComputedStyles?: string;
  errors: string[];
}

const captureEntries: Map<string, PageCaptureEntry> = new Map();

export function getUrlHash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 7);
}

function getTruncatedPath(url: string): string {
  try {
    const parsed = new URL(url);
    let pathStr = parsed.pathname + (parsed.search || '');
    pathStr = pathStr.replace(/^\//, '').replace(/\//g, '_').replace(/[^a-zA-Z0-9\-_.]/g, '_');
    if (pathStr.length > 80) {
      pathStr = pathStr.slice(0, 80);
    }
    return pathStr || 'index';
  } catch {
    return 'unknown';
  }
}

function getPageDomsDir(randomToken: string): string {
  const storagePath = getStoragePath(randomToken);
  return path.join(storagePath, 'pageDOMs');
}

async function getUniqueFilePath(dir: string, baseName: string, ext: string): Promise<string> {
  let candidate = path.join(dir, `${baseName}${ext}`);
  if (!await fs.pathExists(candidate)) return candidate;

  let counter = 2;
  while (await fs.pathExists(candidate)) {
    candidate = path.join(dir, `${baseName}-${counter}${ext}`);
    counter++;
  }
  return candidate;
}

function getRelativeName(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, '/');
}

export function isSaveDomEnabled(): boolean {
  return process.env.OOBEE_SAVE_DOM === '1' || process.env.OOBEE_SAVE_DOM === 'true';
}

export function isSavePageScreenshotEnabled(): boolean {
  return (
    process.env.OOBEE_SAVE_PAGE_SCREENSHOT === '1' ||
    process.env.OOBEE_SAVE_PAGE_SCREENSHOT === 'true'
  );
}

export function isSaveComputedStylesEnabled(): boolean {
  return (
    process.env.OOBEE_SAVE_COMPUTED_STYLES === '1' ||
    process.env.OOBEE_SAVE_COMPUTED_STYLES === 'true'
  );
}

export function isPageCaptureEnabled(): boolean {
  return (
    isSaveDomEnabled() || isSavePageScreenshotEnabled() || isSaveComputedStylesEnabled()
  );
}

// Curated list of CSS properties that matter for accessibility triage —
// colour contrast, focus visibility, sizing/spacing, text handling. A full
// getComputedStyle dump per element runs to ~500 properties; this cuts it
// to ~20 without losing the ones LLM-based analysis actually reasons about.
// Order chosen roughly by usefulness for downstream tooling.
const CAPTURED_CSS_PROPERTIES: string[] = [
  'color',
  'background-color',
  'background-image',
  'opacity',
  'font-size',
  'font-weight',
  'font-family',
  'font-style',
  'line-height',
  'text-decoration',
  'text-transform',
  'outline-color',
  'outline-style',
  'outline-width',
  'outline-offset',
  'border-color',
  'border-style',
  'border-width',
  'visibility',
  'display',
  'pointer-events',
  'cursor',
];

// Elements that never contribute to visible page state — no point capturing
// their computed styles. Skipping these keeps the output file size in check.
const SKIPPED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'META',
  'LINK',
  'HEAD',
  'TITLE',
  'NOSCRIPT',
  'TEMPLATE',
  'BASE',
]);

/**
 * Runs inside the page context to enumerate every visible element, compute a
 * stable CSS selector for it (id-anchored where possible, otherwise the
 * nth-of-type chain axe-core itself uses), and record a curated subset of
 * its getComputedStyle output.
 *
 * Kept as a single self-contained function because Playwright's page.evaluate
 * serialises the arg — no imports or outer bindings survive.
 */
async function captureComputedStyles(
  page: Page,
): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    ({ props, skipped }) => {
      const skippedSet = new Set(skipped);

      function selectorFor(el: Element): string {
        if (el === document.documentElement) return 'html';
        if (el === document.body) return 'html > body';
        if (el instanceof HTMLElement && el.id) {
          return `#${CSS.escape(el.id)}`;
        }
        const parts: string[] = [];
        let cur: Element | null = el;
        while (cur && cur !== document.documentElement) {
          const tag = cur.tagName.toLowerCase();
          const parent: Element | null = cur.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          let idx = 1;
          let sib: Element | null = cur.previousElementSibling;
          while (sib) {
            if (sib.tagName === cur.tagName) idx++;
            sib = sib.previousElementSibling;
          }
          const siblingsOfSameTag = Array.from(parent.children).filter(
            c => c.tagName === cur!.tagName,
          ).length;
          parts.unshift(siblingsOfSameTag > 1 ? `${tag}:nth-of-type(${idx})` : tag);
          if (parent instanceof HTMLElement && parent.id) {
            parts.unshift(`#${CSS.escape(parent.id)}`);
            return parts.join(' > ');
          }
          cur = parent;
        }
        parts.unshift('html');
        return parts.join(' > ');
      }

      const results: Array<Record<string, unknown>> = [];
      const all = document.querySelectorAll('*');
      for (const el of Array.from(all)) {
        if (skippedSet.has(el.tagName)) continue;
        const cs = window.getComputedStyle(el);
        const styles: Record<string, string> = {};
        for (const prop of props) styles[prop] = cs.getPropertyValue(prop);
        const outer = el.outerHTML || '';
        const record: Record<string, unknown> = {
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          styles,
          outerHtmlPrefix: outer.length > 200 ? outer.slice(0, 200) : outer,
        };
        if (el instanceof HTMLElement && el.id) record.id = el.id;
        if (el.classList.length > 0) record.classes = Array.from(el.classList);
        results.push(record);
      }
      return results;
    },
    { props: CAPTURED_CSS_PROPERTIES, skipped: Array.from(SKIPPED_TAGS) },
  );
}

export async function capturePageData(
  page: Page,
  url: string,
  randomToken: string,
): Promise<void> {
  if (!isPageCaptureEnabled()) return;

  const hash = getUrlHash(url);
  const truncatedPath = getTruncatedPath(url);
  const fileName = `${hash}-${truncatedPath}`;
  const pageDomsDir = getPageDomsDir(randomToken);

  const desktopDomDir = path.join(pageDomsDir, 'desktopPageDOMs');
  const mobileDomDir = path.join(pageDomsDir, 'mobilePageDOMs');
  const desktopScreenshotDir = path.join(pageDomsDir, 'desktopPageScreenshots');
  const mobileScreenshotDir = path.join(pageDomsDir, 'mobilePageScreenshots');
  const desktopComputedStylesDir = path.join(pageDomsDir, 'desktopPageComputedStyles');
  const mobileComputedStylesDir = path.join(pageDomsDir, 'mobilePageComputedStyles');

  const entry: PageCaptureEntry = {
    url,
    hash,
    errors: [],
  };

  if (isSaveDomEnabled()) {
    try {
      await fs.ensureDir(desktopDomDir);
      const domContent = await page.content();
      const domFilePath = await getUniqueFilePath(desktopDomDir, fileName, '.html');
      await fs.writeFile(domFilePath, domContent, 'utf-8');
      entry.desktopDom = `pageDOMs/desktopPageDOMs/${getRelativeName(domFilePath, desktopDomDir)}`;
    } catch (err) {
      entry.errors.push(
        `Desktop DOM save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (isSavePageScreenshotEnabled()) {
    try {
      await fs.ensureDir(desktopScreenshotDir);
      const desktopPath = await getUniqueFilePath(desktopScreenshotDir, fileName, '.png');
      await page.screenshot({ path: desktopPath, fullPage: true });
      entry.desktopScreenshot = `pageDOMs/desktopPageScreenshots/${getRelativeName(desktopPath, desktopScreenshotDir)}`;
    } catch (err) {
      entry.errors.push(
        `Desktop screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (isSaveComputedStylesEnabled()) {
    try {
      await fs.ensureDir(desktopComputedStylesDir);
      const stylesPath = await getUniqueFilePath(desktopComputedStylesDir, fileName, '.json');
      const elements = await captureComputedStyles(page);
      const payload = {
        url,
        viewport: 'desktop',
        capturedAt: new Date().toISOString(),
        properties: CAPTURED_CSS_PROPERTIES,
        elements,
      };
      await fs.writeFile(stylesPath, JSON.stringify(payload), 'utf-8');
      entry.desktopComputedStyles = `pageDOMs/desktopPageComputedStyles/${getRelativeName(stylesPath, desktopComputedStylesDir)}`;
    } catch (err) {
      entry.errors.push(
        `Desktop computed styles save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const currentViewport = page.viewportSize();
  try {
    await page.setViewportSize({
      width: MOBILE_VIEWPORT_WIDTH,
      height: MOBILE_VIEWPORT_HEIGHT,
    });
    await page.waitForTimeout(500);

    if (isSaveDomEnabled()) {
      try {
        await fs.ensureDir(mobileDomDir);
        const domContent = await page.content();
        const domFilePath = await getUniqueFilePath(mobileDomDir, fileName, '.html');
        await fs.writeFile(domFilePath, domContent, 'utf-8');
        entry.mobileDom = `pageDOMs/mobilePageDOMs/${getRelativeName(domFilePath, mobileDomDir)}`;
      } catch (err) {
        entry.errors.push(
          `Mobile DOM save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (isSavePageScreenshotEnabled()) {
      try {
        await fs.ensureDir(mobileScreenshotDir);
        const mobilePath = await getUniqueFilePath(mobileScreenshotDir, fileName, '.png');
        await page.screenshot({ path: mobilePath, fullPage: true });
        entry.mobileScreenshot = `pageDOMs/mobilePageScreenshots/${getRelativeName(mobilePath, mobileScreenshotDir)}`;
      } catch (err) {
        entry.errors.push(
          `Mobile screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (isSaveComputedStylesEnabled()) {
      try {
        await fs.ensureDir(mobileComputedStylesDir);
        const stylesPath = await getUniqueFilePath(mobileComputedStylesDir, fileName, '.json');
        const elements = await captureComputedStyles(page);
        const payload = {
          url,
          viewport: 'mobile',
          capturedAt: new Date().toISOString(),
          properties: CAPTURED_CSS_PROPERTIES,
          elements,
        };
        await fs.writeFile(stylesPath, JSON.stringify(payload), 'utf-8');
        entry.mobileComputedStyles = `pageDOMs/mobilePageComputedStyles/${getRelativeName(stylesPath, mobileComputedStylesDir)}`;
      } catch (err) {
        entry.errors.push(
          `Mobile computed styles save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    entry.errors.push(
      `Mobile viewport switch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (currentViewport) {
      try {
        await page.setViewportSize(currentViewport);
      } catch (err) {
        entry.errors.push(
          `Viewport restore failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  captureEntries.set(url, entry);
}

export async function writeManifest(randomToken: string): Promise<void> {
  if (!isPageCaptureEnabled()) return;
  if (captureEntries.size === 0) return;

  const pageDomsDir = getPageDomsDir(randomToken);
  await fs.ensureDir(pageDomsDir);

  const manifest = {
    generatedAt: new Date().toISOString(),
    pages: Array.from(captureEntries.values()).map(entry => ({
      url: entry.url,
      hash: entry.hash,
      ...(entry.desktopDom && { desktopDom: entry.desktopDom }),
      ...(entry.mobileDom && { mobileDom: entry.mobileDom }),
      ...(entry.desktopScreenshot && { desktopScreenshot: entry.desktopScreenshot }),
      ...(entry.mobileScreenshot && { mobileScreenshot: entry.mobileScreenshot }),
      ...(entry.desktopComputedStyles && { desktopComputedStyles: entry.desktopComputedStyles }),
      ...(entry.mobileComputedStyles && { mobileComputedStyles: entry.mobileComputedStyles }),
      errors: entry.errors,
    })),
  };

  const manifestPath = path.join(pageDomsDir, 'domManifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

export function resetCaptureEntries(): void {
  captureEntries.clear();
}
