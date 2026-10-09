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
// to ~30 without losing the ones LLM-based analysis actually reasons about.
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
  // Box model — needed to explain a target-size (WCAG 2.5.8) or spacing
  // verdict. The `rect` below settles whether an element meets the 24×24
  // threshold; these say which declaration to change to fix it. `margin-*`
  // / `max-*` / `position` are deliberately omitted — the rect makes them
  // redundant for the verdict and they are not free at ~300 elements/page.
  'box-sizing',
  'height',
  'width',
  'min-height',
  'min-width',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
];

// Pseudo-element styles are invisible to a plain getComputedStyle on the host,
// so a contrast or target-size finding against placeholder text, a list marker,
// an icon drawn with ::before, or a range slider's thumb cannot be triaged
// without capturing them separately.
//
// Every entry carries an eligibility gate, and the gate is not optional:
// getComputedStyle(el, pseudo) never returns null for a pseudo the host cannot
// render — Chrome silently returns the host's own inherited styles. Verified in
// Chromium 1228 that `input[type=text]::file-selector-button` and `div::marker`
// both report the host's `color`, so an ungated read would record an input's
// text colour as its placeholder colour: worse than recording nothing.
//
// `requiresAuthoredRule` covers the pseudos that render on almost any element
// and so admit no useful eligibility test (::first-line/::first-letter,
// scrollbars). For those the gate is whether a stylesheet actually declares a
// rule for the pseudo. Comparing the pseudo's computed style against the host's
// looks like a cheaper test but does not work: properties such as `background`
// and `border` do not inherit into ::first-line, and a pseudo's `width`
// resolves to `auto` where the host's resolves to used pixels, so every pseudo
// on every element reads as "different" and nothing gets filtered.
//
// Not capturable here: pseudos that take an argument (`::highlight()`,
// `::part()`, `::slotted()`) cannot be enumerated, `::view-transition-*` only
// exist mid-transition, and pseudo-CLASSES (`:focus-visible`, `:hover`) are
// rejected by getComputedStyle — forcing those needs a CDP round trip per
// element, which is out of proportion to a whole-page capture.
interface PseudoRule {
  pseudo: string;
  // Uppercase tagName whitelist. Omitted = applies to any element.
  hostTags?: string[];
  // Checked only for INPUT hosts, so ::placeholder can also allow TEXTAREA.
  inputTypes?: string[];
  requiresPlaceholder?: boolean;
  requiresListItem?: boolean;
  requiresContent?: boolean;
  requiresScrollable?: boolean;
  requiresBlockText?: boolean;
  requiresAuthoredRule?: boolean;
}

const CAPTURED_PSEUDO_RULES: PseudoRule[] = [
  // Generated content: icon fonts, decorative glyphs, CSS-drawn focus rings.
  { pseudo: '::before', requiresContent: true },
  { pseudo: '::after', requiresContent: true },

  // Form controls whose visible text/affordance lives in the shadow tree.
  {
    pseudo: '::placeholder',
    hostTags: ['INPUT', 'TEXTAREA'],
    inputTypes: ['text', 'search', 'url', 'tel', 'email', 'password', 'number'],
    requiresPlaceholder: true,
  },
  { pseudo: '::file-selector-button', hostTags: ['INPUT'], inputTypes: ['file'] },
  { pseudo: '::marker', requiresListItem: true },

  // Typographic pseudos — a drop cap or styled first line can fail contrast on
  // its own while the rest of the paragraph passes.
  { pseudo: '::first-line', requiresBlockText: true, requiresAuthoredRule: true },
  { pseudo: '::first-letter', requiresBlockText: true, requiresAuthoredRule: true },

  // Dialog/disclosure internals.
  { pseudo: '::backdrop', hostTags: ['DIALOG'] },
  { pseudo: '::details-content', hostTags: ['DETAILS'] },

  // Caption text for media — contrast here is a common 1.4.3 failure.
  { pseudo: '::cue', hostTags: ['VIDEO', 'AUDIO'] },

  // Native control internals that are themselves tap targets (WCAG 2.5.8) or
  // carry their own colours independent of the host.
  { pseudo: '::-webkit-search-cancel-button', hostTags: ['INPUT'], inputTypes: ['search'] },
  {
    pseudo: '::-webkit-calendar-picker-indicator',
    hostTags: ['INPUT'],
    inputTypes: ['date', 'datetime-local', 'month', 'time', 'week'],
  },
  { pseudo: '::-webkit-slider-thumb', hostTags: ['INPUT'], inputTypes: ['range'] },
  { pseudo: '::-webkit-slider-runnable-track', hostTags: ['INPUT'], inputTypes: ['range'] },
  { pseudo: '::-webkit-inner-spin-button', hostTags: ['INPUT'], inputTypes: ['number'] },
  { pseudo: '::-webkit-color-swatch', hostTags: ['INPUT'], inputTypes: ['color'] },
  { pseudo: '::-webkit-progress-bar', hostTags: ['PROGRESS'] },
  { pseudo: '::-webkit-progress-value', hostTags: ['PROGRESS'] },
  { pseudo: '::-webkit-meter-bar', hostTags: ['METER'] },
  { pseudo: '::-webkit-meter-optimum-value', hostTags: ['METER'] },
  { pseudo: '::-webkit-meter-suboptimum-value', hostTags: ['METER'] },
  { pseudo: '::-webkit-meter-even-less-good-value', hostTags: ['METER'] },

  // Custom scrollbars: both a contrast surface and a tap target.
  { pseudo: '::-webkit-scrollbar', requiresScrollable: true, requiresAuthoredRule: true },
  { pseudo: '::-webkit-scrollbar-thumb', requiresScrollable: true, requiresAuthoredRule: true },
  { pseudo: '::-webkit-scrollbar-track', requiresScrollable: true, requiresAuthoredRule: true },
];

// Highlight pseudos. WCAG 1.4.3 applies to selected text, and an author who
// overrides ::selection can easily drop it below 4.5:1 — but these apply to
// every element and in practice are authored once globally, so capturing them
// per element is 300x redundant (measured: 71% of the output file). Captured
// once against html and body instead.
const DOCUMENT_PSEUDO_ELEMENTS: string[] = [
  '::selection',
  '::target-text',
  '::spelling-error',
  '::grammar-error',
];

const CAPTURED_PSEUDO_ELEMENTS: string[] = [
  ...CAPTURED_PSEUDO_RULES.map(r => r.pseudo),
  ...DOCUMENT_PSEUDO_ELEMENTS,
];

// A pseudo-element has no getBoundingClientRect, so unlike a real element its
// computed width/height is the only geometry available — which is why the box
// model is captured here too, for the slider-thumb / scrollbar tap targets.
const CAPTURED_PSEUDO_CSS_PROPERTIES: string[] = [
  'content',
  'color',
  'background-color',
  'background-image',
  'opacity',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'text-decoration',
  'visibility',
  'display',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'min-height',
  'border-color',
  'border-style',
  'border-width',
  'outline-color',
  'outline-style',
  'outline-width',
];

// `display` values that can host ::first-line / ::first-letter. Flex and grid
// containers are excluded: they have no first formatted line.
const BLOCK_TEXT_DISPLAYS: string[] = [
  'block',
  'list-item',
  'inline-block',
  'table-cell',
  'table-caption',
  'flow-root',
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

interface ComputedStylesCapture {
  elements: Array<Record<string, unknown>>;
  documentPseudoStyles: Record<string, Record<string, Record<string, string>>>;
  authoredPseudoElements: string[];
  unreadableStylesheets: number;
  // asgard-0011: set when the element or size cap stopped the capture early.
  truncated: string | null;
}

/**
 * Runs inside the page context to enumerate every visible element, compute a
 * stable CSS selector for it (id-anchored where possible, otherwise the
 * nth-of-type chain axe-core itself uses), and record a curated subset of
 * its getComputedStyle output.
 *
 * Kept as a single self-contained function because Playwright's page.evaluate
 * serialises the arg — no imports or outer bindings survive.
 */
export async function captureComputedStyles(page: Page): Promise<ComputedStylesCapture> {
  return page.evaluate(
    ({
      props,
      skipped,
      pseudoRules,
      pseudoProps,
      docPseudos,
      blockTextDisplays,
      maxElements,
      maxChars,
    }) => {
      const skippedSet = new Set(skipped);
      const blockTextDisplaySet = new Set(blockTextDisplays);

      const round1 = (n: number): number => Math.round(n * 10) / 10;

      // A background-image can be a multi-kilobyte data URI; at ~300 elements a
      // page that uses them would dominate the output file.
      const clip = (v: string): string => (v.length > 200 ? `${v.slice(0, 200)}...` : v);

      // Every selector text in the document, for the requiresAuthoredRule gate.
      // Cross-origin stylesheets throw on .cssRules; those are skipped, so the
      // gate can only under-report, never invent an authored rule.
      const selectorTexts: string[] = [];
      const collectSelectors = (rules: CSSRuleList): void => {
        for (const rule of Array.from(rules)) {
          const asStyle = rule as CSSStyleRule;
          if (typeof asStyle.selectorText === 'string') selectorTexts.push(asStyle.selectorText);
          const nested = (rule as CSSGroupingRule).cssRules;
          if (nested) collectSelectors(nested);
        }
      };
      let readableStylesheets = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          if (sheet.cssRules) {
            collectSelectors(sheet.cssRules);
            readableStylesheets += 1;
          }
        } catch {
          // Cross-origin stylesheet — unreadable by design.
        }
      }
      const allSelectors = selectorTexts.join('\n');
      // Match the single-colon spelling: it is a substring of the double-colon
      // form, so `:first-letter` catches both `::first-letter` and the legacy
      // `:first-letter`, while the leading colon keeps a class name like
      // `.selection-box` from registering as an authored `::selection` rule.
      const authoredPseudos = new Set(
        docPseudos
          .concat(pseudoRules.filter(r => r.requiresAuthoredRule).map(r => r.pseudo))
          .filter(pseudo => allSelectors.includes(pseudo.replace(/^::/, ':'))),
      );

      function canRenderPseudo(
        el: Element,
        rule: typeof pseudoRules[number],
        cs: CSSStyleDeclaration,
        pcs: CSSStyleDeclaration,
      ): boolean {
        if (rule.requiresAuthoredRule && !authoredPseudos.has(rule.pseudo)) return false;
        if (rule.hostTags && !rule.hostTags.includes(el.tagName)) return false;
        if (rule.inputTypes && el instanceof HTMLInputElement) {
          if (!rule.inputTypes.includes(el.type)) return false;
        }
        if (rule.requiresPlaceholder) {
          const placeholder = el.getAttribute('placeholder');
          if (!placeholder) return false;
        }
        if (rule.requiresListItem && !cs.getPropertyValue('display').includes('list-item')) {
          return false;
        }
        if (rule.requiresContent) {
          const content = pcs.getPropertyValue('content');
          if (content === 'none' || content === 'normal' || content === '') return false;
        }
        if (
          rule.requiresScrollable &&
          el.scrollHeight <= el.clientHeight &&
          el.scrollWidth <= el.clientWidth
        ) {
          return false;
        }
        if (rule.requiresBlockText) {
          if (!blockTextDisplaySet.has(cs.getPropertyValue('display'))) return false;
          const hasDirectText = Array.from(el.childNodes).some(
            n => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim() !== '',
          );
          if (!hasDirectText) return false;
        }
        return true;
      }

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
        // Document-relative, not viewport-relative: getBoundingClientRect is
        // measured from the current scroll position, so raw x/y would shift
        // between captures of the same page and quietly break any spacing or
        // overlap reasoning downstream. Always emitted, so a 0x0 rect from
        // `display: none` stays distinguishable from "not captured".
        const box = el.getBoundingClientRect();
        const record: Record<string, unknown> = {
          selector,
          tag: el.tagName.toLowerCase(),
          styles,
          rect: {
            x: round1(box.left + window.scrollX),
            y: round1(box.top + window.scrollY),
            w: round1(box.width),
            h: round1(box.height),
          },
          outerHtmlPrefix,
        };
        // +40 approximates the serialised rect.
        size += selector.length + outerHtmlPrefix.length + 40;
        if (el instanceof HTMLElement && el.id) {
          record.id = el.id;
          size += el.id.length;
        }
        if (el.classList.length > 0) {
          const classes = Array.from(el.classList);
          record.classes = classes;
          for (const c of classes) size += c.length + 3;
        }

        const pseudoStyles: Record<string, Record<string, string>> = {};
        for (const rule of pseudoRules) {
          let pcs: CSSStyleDeclaration | null = null;
          try {
            pcs = window.getComputedStyle(el, rule.pseudo);
          } catch {
            // Pseudo unknown to this browser build.
            continue;
          }
          if (!pcs) continue;
          if (!canRenderPseudo(el, rule, cs, pcs)) continue;
          const entry: Record<string, string> = {};
          for (const prop of pseudoProps) {
            const value = clip(pcs.getPropertyValue(prop));
            entry[prop] = value;
            size += prop.length + value.length;
          }
          pseudoStyles[rule.pseudo] = entry;
        }
        if (Object.keys(pseudoStyles).length > 0) record.pseudoStyles = pseudoStyles;

        // asgard-0011: pseudo-styles count toward the size cap too.
        if (approxChars + size > maxChars) {
          truncated = 'maxBytes';
          break;
        }
        approxChars += size;
        results.push(record);
      }

      // Highlight pseudos, once per document root rather than per element.
      // Only when a stylesheet declares them: for an unstyled ::selection
      // getComputedStyle reports the inherited colour and a transparent
      // background, which is not what the browser paints — it uses a system
      // highlight colour it does not expose. Recording that would read as a
      // real selection colour and invite a wrong contrast verdict.
      const documentPseudoStyles: Record<
        string,
        Record<string, Record<string, string>>
      > = {};
      for (const [host, el] of [
        ['html', document.documentElement],
        ['body', document.body],
      ] as Array<[string, Element | null]>) {
        if (!el) continue;
        const forHost: Record<string, Record<string, string>> = {};
        for (const pseudo of docPseudos) {
          if (!authoredPseudos.has(pseudo)) continue;
          let pcs: CSSStyleDeclaration | null = null;
          try {
            pcs = window.getComputedStyle(el, pseudo);
          } catch {
            continue;
          }
          if (!pcs) continue;
          const entry: Record<string, string> = {};
          for (const prop of pseudoProps) entry[prop] = clip(pcs.getPropertyValue(prop));
          forHost[pseudo] = entry;
        }
        if (Object.keys(forHost).length > 0) documentPseudoStyles[host] = forHost;
      }

      return {
        elements: results,
        documentPseudoStyles,
        authoredPseudoElements: Array.from(authoredPseudos),
        unreadableStylesheets: document.styleSheets.length - readableStylesheets,
        truncated,
      };
    },
    {
      props: CAPTURED_CSS_PROPERTIES,
      skipped: Array.from(SKIPPED_TAGS),
      pseudoRules: CAPTURED_PSEUDO_RULES,
      pseudoProps: CAPTURED_PSEUDO_CSS_PROPERTIES,
      docPseudos: DOCUMENT_PSEUDO_ELEMENTS,
      blockTextDisplays: BLOCK_TEXT_DISPLAYS,
      maxElements: getCaptureMaxElements(),
      maxChars: getCaptureMaxStylesBytes(),
    },
  );
}

// Builds the computed-styles JSON for one viewport. `truncated` /
// `truncatedReason` are only added when a cap was hit (asgard-0011), so
// consumers can tell a partial capture from a complete one.
async function buildComputedStylesJson(
  page: Page,
  url: string,
  viewport: string,
  viewportSize: { width: number; height: number } | null,
): Promise<string> {
  const capture = await captureComputedStyles(page);
  const payload = {
    url,
    viewport,
    viewportSize,
    capturedAt: new Date().toISOString(),
    properties: CAPTURED_CSS_PROPERTIES,
    pseudoProperties: CAPTURED_PSEUDO_CSS_PROPERTIES,
    capturedPseudoElements: CAPTURED_PSEUDO_ELEMENTS,
    authoredPseudoElements: capture.authoredPseudoElements,
    unreadableStylesheets: capture.unreadableStylesheets,
    documentPseudoStyles: capture.documentPseudoStyles,
    elements: capture.elements,
    ...(capture.truncated && { truncated: true, truncatedReason: capture.truncated }),
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

  // Read before the first capture, not after: the "desktop" slot is captured at
  // whatever viewport the scan is configured for, so on a mobile scan it holds
  // narrow-viewport geometry despite the slot name. Recording the real size is
  // what lets downstream tooling cite the viewport a measurement came from
  // instead of assuming the slot label.
  const currentViewport = page.viewportSize();

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
      const json = await buildComputedStylesJson(page, url, 'desktop', currentViewport);
      await fs.writeFile(stylesPath, json, 'utf-8');
      entry.desktopComputedStyles = `pageDOMs/desktopPageComputedStyles/${getRelativeName(stylesPath, desktopComputedStylesDir)}`;
    } catch (err) {
      entry.errors.push(
        `Desktop computed styles save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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
        const json = await buildComputedStylesJson(page, url, 'mobile', {
          width: MOBILE_VIEWPORT_WIDTH,
          height: MOBILE_VIEWPORT_HEIGHT,
        });
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
