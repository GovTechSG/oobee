import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { Page, devices } from 'playwright';
import { getStoragePath } from '../utils.js';
import { parseBooleanValue } from '../envUtils.js';

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
  return parseBooleanValue(process.env.OOBEE_SAVE_DOM) ?? false;
}

export function isSavePageScreenshotEnabled(): boolean {
  return parseBooleanValue(process.env.OOBEE_SAVE_PAGE_SCREENSHOT) ?? false;
}

export function isSaveComputedStylesEnabled(): boolean {
  return parseBooleanValue(process.env.OOBEE_SAVE_COMPUTED_STYLES) ?? false;
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

// asgard-0011: upper bounds on page capture. The captured page is scanned
// content (often third-party), so element count and DOM size are attacker-
// controlled. Defaults are far above real pages, so normal captures are
// unchanged; operators can tune them per deployment.
//  - OOBEE_CAPTURE_MAX_ELEMENTS: computed-style records per viewport.
//  - OOBEE_CAPTURE_MAX_STYLES_BYTES: approximate size of those records.
//  - OOBEE_CAPTURE_MAX_DOM_BYTES: saved DOM HTML per viewport.
// Read at call time so long-lived processes pick up changes.
const positiveIntFromEnv = (name: string, fallback: number): number => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
export const getCaptureMaxElements = (): number =>
  positiveIntFromEnv('OOBEE_CAPTURE_MAX_ELEMENTS', 100_000);
export const getCaptureMaxStylesBytes = (): number =>
  positiveIntFromEnv('OOBEE_CAPTURE_MAX_STYLES_BYTES', 100 * 1024 * 1024);
export const getCaptureMaxDomBytes = (): number =>
  positiveIntFromEnv('OOBEE_CAPTURE_MAX_DOM_BYTES', 100 * 1024 * 1024);

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
export async function captureComputedStyles(
  page: Page,
): Promise<{ elements: Array<Record<string, unknown>>; truncated: string | null }> {
  return page.evaluate(
    ({ props, skipped, maxElements, maxChars }) => {
      const skippedSet = new Set(skipped);

      // asgard-0011: each element's position among same-tag siblings, built in
      // one pass per parent and reused. The previous code walked every earlier
      // sibling and copied every sibling for each element, so a flat page with
      // N siblings cost O(N^2) even with the element cap in place. Produces the
      // same idx/count values (same tagName comparison, same 1-based index).
      const siblingInfo = new WeakMap<Element, Map<Element, { idx: number; count: number }>>();
      function positionOf(cur: Element, parent: Element): { idx: number; count: number } {
        let info = siblingInfo.get(parent);
        if (!info) {
          info = new Map();
          const seen = new Map<string, number>();
          const children = parent.children;
          for (let i = 0; i < children.length; i += 1) {
            const c = children[i];
            const n = (seen.get(c.tagName) || 0) + 1;
            seen.set(c.tagName, n);
            info.set(c, { idx: n, count: 0 });
          }
          for (const [c, v] of info) v.count = seen.get(c.tagName) || 0;
          siblingInfo.set(parent, info);
        }
        return info.get(cur) || { idx: 1, count: 1 };
      }

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
          const { idx, count: siblingsOfSameTag } = positionOf(cur, parent);
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
      let truncated: string | null = null;
      let approxChars = 0;
      // A TreeWalker visits elements in the same document order as
      // querySelectorAll('*') but never materialises a list of every node,
      // so a page with millions of elements costs nothing past the cap.
      const root = document.documentElement;
      const walker = root ? document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT) : null;
      for (
        let node: Node | null = walker ? walker.currentNode : null;
        node;
        node = walker!.nextNode()
      ) {
        const el = node as Element;
        if (skippedSet.has(el.tagName)) continue;
        if (results.length >= maxElements) {
          truncated = 'maxElements';
          break;
        }
        const cs = window.getComputedStyle(el);
        const styles: Record<string, string> = {};
        let size = 64;
        for (const prop of props) {
          const value = cs.getPropertyValue(prop);
          styles[prop] = value;
          size += prop.length + value.length;
        }
        const outer = el.outerHTML || '';
        const selector = selectorFor(el);
        const outerHtmlPrefix = outer.length > 200 ? outer.slice(0, 200) : outer;
        const record: Record<string, unknown> = {
          selector,
          tag: el.tagName.toLowerCase(),
          styles,
          outerHtmlPrefix,
        };
        size += selector.length + outerHtmlPrefix.length;
        if (el instanceof HTMLElement && el.id) {
          record.id = el.id;
          size += el.id.length;
        }
        if (el.classList.length > 0) {
          const classes = Array.from(el.classList);
          record.classes = classes;
          for (const c of classes) size += c.length + 3;
        }
        if (approxChars + size > maxChars) {
          truncated = 'maxBytes';
          break;
        }
        approxChars += size;
        results.push(record);
      }
      return { elements: results, truncated };
    },
    {
      props: CAPTURED_CSS_PROPERTIES,
      skipped: Array.from(SKIPPED_TAGS),
      maxElements: getCaptureMaxElements(),
      maxChars: getCaptureMaxStylesBytes(),
    },
  );
}

// Builds the computed-styles JSON for one viewport. Fields are unchanged for
// normal pages; `truncated` / `truncatedReason` are only added when a cap
// was hit, so consumers can tell a partial capture from a complete one.
async function buildComputedStylesJson(page: Page, url: string, viewport: string): Promise<string> {
  const { elements, truncated } = await captureComputedStyles(page);
  const payload = {
    url,
    viewport,
    capturedAt: new Date().toISOString(),
    properties: CAPTURED_CSS_PROPERTIES,
    elements,
    ...(truncated && { truncated: true, truncatedReason: truncated }),
  };
  return JSON.stringify(payload);
}

// Returns page.content(), or throws (caught by the caller and recorded in the
// manifest's errors, like any other failed save) when the DOM exceeds the
// byte cap. The size is checked in the page first, so an oversized DOM is
// never copied into Node. UTF-8 bytes >= UTF-16 length, so the pre-check
// never skips a DOM that would have fitted.
export async function readBoundedDom(page: Page): Promise<string> {
  const maxBytes = getCaptureMaxDomBytes();
  const approxLength = await page.evaluate(() =>
    document.documentElement ? document.documentElement.outerHTML.length : 0,
  );
  if (approxLength > maxBytes) {
    throw new Error(`DOM too large (${approxLength} chars > ${maxBytes} byte limit); skipped`);
  }
  const content = await page.content();
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > maxBytes) {
    throw new Error(`DOM too large (${bytes} bytes > ${maxBytes} byte limit); skipped`);
  }
  return content;
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
      const domContent = await readBoundedDom(page);
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
      const json = await buildComputedStylesJson(page, url, 'desktop');
      await fs.writeFile(stylesPath, json, 'utf-8');
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
        const domContent = await readBoundedDom(page);
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
        const json = await buildComputedStylesJson(page, url, 'mobile');
        await fs.writeFile(stylesPath, json, 'utf-8');
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
