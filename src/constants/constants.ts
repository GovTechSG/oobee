import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { globSync } from 'glob';
import which from 'which';
import os from 'os';
import { spawnSync, execSync } from 'child_process';
import { Browser, BrowserContext, chromium } from 'playwright';
import * as Sentry from '@sentry/node';
import { PlaywrightCrawler } from 'crawlee';
import { consoleLogger, silentLogger } from '../logs.js';
import { PageInfo } from '../mergeAxeResults.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const maxRequestsPerCrawl = 100;

export const blackListedFileExtensions = [
  'css',
  'js',
  'txt',
  'mp3',
  'mp4',
  'jpg',
  'jpeg',
  'png',
  'svg',
  'gif',
  'woff',
  'zip',
  'webp',
  'json',
  'xml',
];

export const getIntermediateScreenshotsPath = (datasetsPath: string): string =>
  `${datasetsPath}/screenshots`;
export const destinationPath = (storagePath: string): string => `${storagePath}/screenshots`;

/**  Get the path to Default Profile in the Chrome Data Directory
 * as per https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md
 * @returns path to Default Profile in the Chrome Data Directory
 */
export const getDefaultChromeDataDir = (): string => {
  try {
    let defaultChromeDataDir = null;
    if (os.platform() === 'win32') {
      defaultChromeDataDir = path.join(
        os.homedir(),
        'AppData',
        'Local',
        'Google',
        'Chrome',
        'User Data',
      );
    } else if (os.platform() === 'darwin') {
      defaultChromeDataDir = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Google',
        'Chrome',
      );
    }

    if (defaultChromeDataDir && fs.existsSync(defaultChromeDataDir)) {
      return defaultChromeDataDir;
    }
    return null;
  } catch (error) {
    console.error(`Error in getDefaultChromeDataDir(): ${error}`);
  }
};

/**
 * Get the path to Default Profile in the Edge Data Directory
 * @returns path to Default Profile in the Edge Data Directory
 */
export const getDefaultEdgeDataDir = (): string => {
  try {
    let defaultEdgeDataDir = null;
    if (os.platform() === 'win32') {
      defaultEdgeDataDir = path.join(
        os.homedir(),
        'AppData',
        'Local',
        'Microsoft',
        'Edge',
        'User Data',
      );
    } else if (os.platform() === 'darwin') {
      defaultEdgeDataDir = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Microsoft Edge',
      );
    }

    if (defaultEdgeDataDir && fs.existsSync(defaultEdgeDataDir)) {
      return defaultEdgeDataDir;
    }
    return null;
  } catch (error) {
    console.error(`Error in getDefaultEdgeDataDir(): ${error}`);
  }
};

export const getDefaultChromiumDataDir = () => {
  try {
    let defaultChromiumDataDir = null;

    if (os.platform() === 'win32') {
      defaultChromiumDataDir = path.join(os.homedir(), 'AppData', 'Local', 'Chromium', 'User Data');
    } else if (os.platform() === 'darwin') {
      defaultChromiumDataDir = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Chromium',
      );
    } else {
      defaultChromiumDataDir = path.join(process.cwd(), 'Chromium Support');

      try {
        fs.mkdirSync(defaultChromiumDataDir, { recursive: true }); // Use { recursive: true } to create parent directories if they don't exist
      } catch {
        defaultChromiumDataDir = '/tmp';
      }

      consoleLogger.info(`Using Chromium support directory at ${defaultChromiumDataDir}`);
    }

    if (defaultChromiumDataDir && fs.existsSync(defaultChromiumDataDir)) {
      return defaultChromiumDataDir;
    }
    return null;
  } catch (error) {
    consoleLogger.error(`Error in getDefaultChromiumDataDir(): ${error}`);
  }
};

export function removeQuarantineFlag(searchPattern: string, allowedRoot = process.cwd()) {
  if (os.platform() !== 'darwin') return;

  const matches = globSync(searchPattern, {
    absolute: true,
    nodir: true,
    dot: true,
    follow: false, // don't follow symlinks
  });

  const root = path.resolve(allowedRoot);

  for (const p of matches) {
    const resolved = path.resolve(p);

    // Ensure the file is under the allowed root (containment check)
    if (!resolved.startsWith(root + path.sep)) continue;

    // lstat: skip if not a regular file or if it's a symlink
    let st: fs.Stats;
    try {
      st = fs.lstatSync(resolved);
    } catch {
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink()) continue;

    // basic filename sanity: no control chars
    const base = path.basename(resolved);
    if (/[\x00-\x1F]/.test(base)) continue;

    // Use absolute binary path and terminate options with "--"
    const proc = spawnSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', '--', resolved], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    // Optional: inspect errors (common benign case is "No such xattr")
    if (proc.status !== 0) {
      const err = proc.stderr?.toString() || '';
      // swallow benign errors; otherwise log if you have a logger
      if (!/No such xattr/i.test(err)) {
        // console.warn(`xattr failed for ${resolved}: ${err.trim()}`);
      }
    }
  }
}

export const getExecutablePath = function (dir: string, file: string): string {
  let execPaths = globSync(`${dir}/${file}`, { absolute: true, nodir: true });

  if (execPaths.length === 0) {
    const execInPATH = which.sync(file, { nothrow: true });

    if (execInPATH) {
      return fs.realpathSync(execInPATH);
    }
    const splitPath =
      os.platform() === 'win32' ? process.env.PATH.split(';') : process.env.PATH.split(':');

    for (const path in splitPath) {
      execPaths = globSync(`${path}/${file}`, { absolute: true, nodir: true });
      if (execPaths.length !== 0) return fs.realpathSync(execPaths[0]);
    }
    return null;
  }
  removeQuarantineFlag(execPaths[0]);
  return execPaths[0];
};

/**
 * Matches the pattern user:password@domain.com
 */
export const basicAuthRegex = /^.*\/\/.*:.*@.*$/i;

// for crawlers
export const axeScript = path.join(dirname, '../../node_modules/axe-core/axe.min.js');
export class UrlsCrawled {
  siteName: string;
  toScan: string[] = [];
  scanned: PageInfo[] = [];
  invalid: PageInfo[] = [];
  scannedRedirects: { fromUrl: string; toUrl: string }[] = [];
  notScannedRedirects: { fromUrl: string; toUrl: string }[] = [];
  outOfDomain: PageInfo[] = [];
  blacklisted: PageInfo[] = [];
  error: PageInfo[] = [];
  exceededRequests: PageInfo[] = [];
  forbidden: PageInfo[] = [];
  userExcluded: PageInfo[] = [];
  everything: string[] = [];

  constructor(urlsCrawled?: Partial<UrlsCrawled>) {
    if (urlsCrawled) {
      Object.assign(this, urlsCrawled);
    }
  }
}

const urlsCrawledObj = new UrlsCrawled();

/* eslint-disable no-unused-vars */
export enum ScannerTypes {
  SITEMAP = 'Sitemap',
  WEBSITE = 'Website',
  CUSTOM = 'Custom',
  INTELLIGENT = 'Intelligent',
  LOCALFILE = 'LocalFile',
}
/* eslint-enable no-unused-vars */

export enum FileTypes {
  All = 'all',
  PdfOnly = 'pdf-only',
  HtmlOnly = 'html-only',
}

export function getEnumKey<E extends Record<string, string>>(
  enumObj: E,
  value: string,
): keyof E | undefined {
  return (Object.keys(enumObj) as Array<keyof E>).find(k => enumObj[k] === value);
}

export const guiInfoStatusTypes = {
  SCANNED: 'scanned',
  SKIPPED: 'skipped',
  COMPLETED: 'completed',
  ERROR: 'error',
  DUPLICATE: 'duplicate',
};

let launchOptionsArgs: string[] = [];

// Check if running in docker container
if (fs.existsSync('/.dockerenv')) {
  launchOptionsArgs = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'];
}

export const impactOrder = {
  minor: 0,
  moderate: 1,
  serious: 2,
  critical: 3,
};

/**
 * Suppresses the "Setting the NODE_TLS_REJECT_UNAUTHORIZED
 * environment variable to '0' is insecure" warning,
 * then disables TLS validation globally.
 */
export function suppressTlsRejectWarning(): void {
  // Monkey-patch process.emitWarning
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...args: any[]) => {
    const msg = typeof warning === 'string' ? warning : warning.message;
    if (msg.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
      // swallow only that one warning
      return;
    }
    // forward everything else
    originalEmitWarning.call(process, warning, ...args);
  };

  // Now turn off cert validation
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

suppressTlsRejectWarning();

export const sentryConfig = {
  dsn:
    process.env.OOBEE_SENTRY_DSN ||
    'https://3b8c7ee46b06f33815a1301b6713ebc3@o4509047624761344.ingest.us.sentry.io/4509327783559168',
  tracesSampleRate: 1.0, // Capture 100% of transactions for performance monitoring
  profilesSampleRate: 1.0, // Capture 100% of profiles
};

// Function to set Sentry user ID from userData.txt
export const setSentryUser = (userId: string) => {
  if (userId) {
    Sentry.setUser({ id: userId });
  }
};

// Legacy code start - Google Sheets submission
export const formDataFields = {
  formUrl: `https://docs.google.com/forms/d/e/1FAIpQLSem5C8fyNs5TiU5Vv2Y63-SH7CHN86f-LEPxeN_1u_ldUbgUA/formResponse`, // prod
  entryUrlField: 'entry.1562345227',
  redirectUrlField: 'entry.473072563',
  scanTypeField: 'entry.1148680657',
  emailField: 'entry.52161304',
  nameField: 'entry.1787318910',
  resultsField: 'entry.904051439',
  numberOfPagesScannedField: 'entry.238043773',
  additionalPageDataField: 'entry.2090887881',
  metadataField: 'entry.1027769131',
};
// Legacy code end - Google Sheets submission

export const sitemapPaths = [
  '/sitemap.xml',
  '/sitemap/sitemap.xml',
  '/sitemap-index.xml',
  '/sitemap_index.xml',
  '/sitemapindex.xml',
  '/sitemap/index.xml',
  '/sitemap1.xml',
  '/sitemap/',
  '/post-sitemap',
  '/page-sitemap',
  '/sitemap.txt',
  '/sitemap.php',
  '/sitemap.xml.bz2',
  '/sitemap.xml.xz',
  '/sitemap_index.xml.bz2',
  '/sitemap_index.xml.xz',
];

// Remember to update getWcagPassPercentage() in src/utils/utils.ts if you change this
const wcagLinks = {
  'WCAG 1.1.1': 'https://www.w3.org/TR/WCAG22/#non-text-content',
  'WCAG 1.2.2': 'https://www.w3.org/TR/WCAG22/#captions-prerecorded',
  'WCAG 1.3.1': 'https://www.w3.org/TR/WCAG22/#info-and-relationships',
  // 'WCAG 1.3.4': 'https://www.w3.org/TR/WCAG22/#orientation', - TODO: review for veraPDF
  'WCAG 1.3.5': 'https://www.w3.org/TR/WCAG22/#identify-input-purpose',
  'WCAG 1.4.1': 'https://www.w3.org/TR/WCAG22/#use-of-color',
  'WCAG 1.4.2': 'https://www.w3.org/TR/WCAG22/#audio-control',
  'WCAG 1.4.3': 'https://www.w3.org/TR/WCAG22/#contrast-minimum',
  'WCAG 1.4.4': 'https://www.w3.org/TR/WCAG22/#resize-text',
  'WCAG 1.4.6': 'https://www.w3.org/TR/WCAG22/#contrast-enhanced', // AAA
  // 'WCAG 1.4.10': 'https://www.w3.org/TR/WCAG22/#reflow', - TODO: review for veraPDF
  'WCAG 1.4.12': 'https://www.w3.org/TR/WCAG22/#text-spacing',
  'WCAG 2.1.1': 'https://www.w3.org/TR/WCAG22/#keyboard',
  'WCAG 2.1.3': 'https://www.w3.org/WAI/WCAG22/Understanding/keyboard-no-exception.html', // AAA
  'WCAG 2.2.1': 'https://www.w3.org/TR/WCAG22/#timing-adjustable',
  'WCAG 2.2.2': 'https://www.w3.org/TR/WCAG22/#pause-stop-hide',
  'WCAG 2.2.4': 'https://www.w3.org/TR/WCAG22/#interruptions', // AAA
  'WCAG 2.4.1': 'https://www.w3.org/TR/WCAG22/#bypass-blocks',
  'WCAG 2.4.2': 'https://www.w3.org/TR/WCAG22/#page-titled',
  'WCAG 2.4.4': 'https://www.w3.org/TR/WCAG22/#link-purpose-in-context',
  'WCAG 2.4.9': 'https://www.w3.org/TR/WCAG22/#link-purpose-link-only', // AAA
  'WCAG 2.5.8': 'https://www.w3.org/TR/WCAG22/#target-size-minimum',
  'WCAG 3.1.1': 'https://www.w3.org/TR/WCAG22/#language-of-page',
  'WCAG 3.1.2': 'https://www.w3.org/TR/WCAG22/#language-of-parts',
  'WCAG 3.1.5': 'https://www.w3.org/TR/WCAG22/#reading-level', // AAA
  'WCAG 3.2.5': 'https://www.w3.org/TR/WCAG22/#change-on-request', // AAA
  'WCAG 3.3.2': 'https://www.w3.org/TR/WCAG22/#labels-or-instructions',
  'WCAG 4.1.2': 'https://www.w3.org/TR/WCAG22/#name-role-value',
};

const wcagCriteriaLabels = {
  'WCAG 1.1.1': 'A',
  'WCAG 1.2.2': 'A',
  'WCAG 1.3.1': 'A',
  'WCAG 1.3.5': 'AA',
  'WCAG 1.4.1': 'A',
  'WCAG 1.4.2': 'A',
  'WCAG 1.4.3': 'AA',
  'WCAG 1.4.4': 'AA',
  'WCAG 1.4.6': 'AAA',
  'WCAG 1.4.12': 'AA',
  'WCAG 2.1.1': 'A',
  'WCAG 2.1.3': 'AAA',
  'WCAG 2.2.1': 'A',
  'WCAG 2.2.2': 'A',
  'WCAG 2.2.4': 'AAA',
  'WCAG 2.4.1': 'A',
  'WCAG 2.4.2': 'A',
  'WCAG 2.4.4': 'A',
  'WCAG 2.4.9': 'AAA',
  'WCAG 2.5.8': 'AA',
  'WCAG 3.1.1': 'A',
  'WCAG 3.1.2': 'AA',
  'WCAG 3.1.5': 'AAA',
  'WCAG 3.2.5': 'AAA',
  'WCAG 3.3.2': 'A',
  'WCAG 4.1.2': 'A',
};

const urlCheckStatuses = {
  success: { code: 0 },
  invalidUrl: { code: 11, message: 'Invalid URL. Please check and try again.' },
  cannotBeResolved: {
    code: 12,
    message: 'URL cannot be accessed. Please verify whether the website exists.',
  },
  errorStatusReceived: {
    // unused for now
    code: 13,
    message: 'Provided URL cannot be accessed. Server responded with code ', // append it with the response code received,
  },
  systemError: { code: 14, message: 'Something went wrong when verifying the URL. Please try again in a few minutes. If this issue persists, please contact the Oobee team.'},
  notASitemap: { code: 15, message: 'Invalid sitemap URL format. Please enter a valid sitemap URL ending with .XML or .TXT e.g. https://www.example.com/sitemap.xml.' },
  unauthorised: { code: 16, message: 'Login required. Please enter your credentials and try again.' },
  // browserError means engine could not find a browser to run the scan
  browserError: {
    code: 17,
    message: 'Incompatible browser. Please ensure you are using Chrome or Edge browser.',
  },
  sslProtocolError: {
    code: 18,
    message:
      'SSL certificate  error. Please check the SSL configuration of your website and try again.',
  },
  notALocalFile: {
    code: 19,
    message: 'Uploaded file format is incorrect. Please upload a HTML, PDF, XML or TXT file.',
  },
  notAPdf: { code: 20, message: 'URL/file format is incorrect. Please upload a PDF file.' },
  notASupportedDocument: {
    code: 21,
    message: 'Uploaded file format is incorrect. Please upload a HTML, PDF, XML or TXT file.',
  },
  connectionRefused: {
    code: 22,
    message:
      'Connection refused. Please try again in a few minutes. If this issue persists, please contact the Oobee team.',
  },
  timedOut: {
    code: 23,
    message:
      'Request timed out. Please try again in a few minutes. If this issue persists, please contact the Oobee team.',
  },
};

/* eslint-disable no-unused-vars */
export enum BrowserTypes {
  CHROMIUM = 'chromium',
  CHROME = 'chrome',
  EDGE = 'msedge',
}
/* eslint-enable no-unused-vars */

const xmlSitemapTypes = {
  xml: 0,
  xmlIndex: 1,
  rss: 2,
  atom: 3,
  unknown: 4,
};

const forbiddenCharactersInDirPath = ['<', '>', ':', '"', '\\', '/', '|', '?', '*'];

const reserveFileNameKeywords = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
];

export const a11yRuleShortDescriptionMap = {
  'aria-meter-name': 'Meter elements need accessible labels',
  'aria-progressbar-name': 'Progress bars need accessible labels',
  'image-alt': 'Meaningful images need text descriptions',
  'input-image-alt': 'Image buttons need action labels',
  'object-alt': 'Embedded objects need identifying labels',
  'oobee-confusing-alt-text': 'Replace vague image descriptions with meaningful text',
  'role-img-alt': 'Elements marked as images need text descriptions',
  'svg-img-alt': 'Vector graphics marked as images need text descriptions',
  'video-caption': 'Videos need captions with transcript tracks',
  'aria-required-children': 'ARIA roles must contain their required child elements',
  'aria-required-parent': 'ARIA roles must be contained within their required parent elements',
  'definition-list': 'Glossaries must use proper term and definition structure',
  dlitem: 'Term and definition elements must be contained in definition lists',
  list: 'Bullet and numbered lists must only contain list items as direct children',
  listitem: 'List items must be placed inside a list container',
  'td-headers-attr': 'Table headers must clearly identify their relationship to cells',
  'th-has-data-cells': 'Table headers must be connected to their data cells',
  'autocomplete-valid': 'Form fields must use valid autocomplete attributes',
  'link-in-text-block': 'Links must be visually distinct beyond color alone',
  'avoid-inline-spacing': 'Page layouts must allow users to adjust text spacing',
  'no-autoplay-audio': 'Pages must not auto-play audio or must allow control',
  'color-contrast': 'Text and background colors must meet minimum contrast requirements',
  'color-contrast-enhanced': 'Text and background colors must meet enhanced contrast requirements',
  'frame-focusable-content':
    'Frames and iframes with interactive content must be keyboard accessible',
  'server-side-image-map': 'Replace server-side image maps with client-side image maps',
  'scrollable-region-focusable': 'Elements within scrollable regions must be keyboard accessible',
  'oobee-accessible-label': 'Clickable elements must have accessible labels',
  'meta-refresh': 'Pages must not use timed automatic refresh',
  blink: 'Blinking elements must not be used',
  marquee: 'Marquee animated elements must not be used',
  'meta-refresh-no-exceptions': 'Pages must not use automatic timed refresh',
  bypass: 'Pages must provide a way to bypass repeated blocks',
  'document-title': 'Every page must have a descriptive title',
  'link-name': 'Links must have descriptive accessible labels',
  'area-alt': 'Clickable areas in image maps must have labels',
  'identical-links-same-purpose':
    'Links with identical text must have accessible labels describing their purpose',
  'target-size': 'Clickable elements must be large enough or have sufficient spacing',
  'html-has-lang': 'Every page must declare its language',
  'html-lang-valid': 'Page language declaration must use valid language codes',
  'html-xml-lang-mismatch': 'Make different page language settings match',
  'valid-lang': 'Elements in different languages must use valid language codes',
  'oobee-grading-text-contents': 'Page content must use clear, plain language',
  'form-field-multiple-labels': 'Form fields must have only one label element',
  'aria-allowed-attr': 'ARIA attributes must be used with appropriate roles',
  'aria-braille-equivalent': 'Braille abbreviated labels must have full text equivalents',
  'aria-command-name': 'Elements that use ARIA labels must have an accessible name.',
  'aria-conditional-attr': 'ARIA attributes must not create conflicting or indeterminate states',
  'aria-deprecated-role': 'Remove outdated accessibility (ARIA) roles',
  'aria-hidden-body': 'The page body must not be hidden from screen readers',
  'aria-hidden-focus': 'Hidden elements must not contain keyboard-focusable content',
  'aria-input-field-name': 'Custom input fields must have accessible labels',
  'aria-prohibited-attr': 'Remove ARIA attributes not allowed on these elements',
  'aria-required-attr': 'Add required ARIA attributes for accessibility roles',
  'aria-roles': 'Elements must use valid, supported accessibility roles',
  'aria-toggle-field-name':
    'Toggle switches, checkboxes and radio buttons must have descriptive labels',
  'aria-tooltip-name': 'Tooltips must have accessible names',
  'aria-valid-attr': 'ARIA attributes must use correct syntax and valid names',
  'aria-valid-attr-value': 'ARIA attributes must use valid values',
  'button-name': 'Buttons must have descriptive text or labels',
  'duplicate-id-aria': 'Element IDs must be unique on the page',
  'frame-title': 'Frames and iframes must have descriptive titles',
  'frame-title-unique': 'Each frame must have a unique, descriptive title',
  'input-button-name': 'Input buttons must have descriptive text or values',
  label: 'Form fields must have associated labels',
  'nested-interactive': 'Interactive elements must not be nested inside each other',
  'select-name': 'Selected dropdowns must have associated labels',
  accesskeys: 'Custom keyboard shortcuts must be unique',
  'aria-dialog-name': 'Dialog popups must have descriptive titles',
  'aria-text': 'Text elements must not contain focusable content',
  'aria-treeitem-name': 'Tree view items must have accessible names',
  'empty-heading': 'Headings must contain descriptive text and not be hidden',
  'empty-table-header': 'Table headers must contain descriptive text',
  'frame-tested': 'Frames and iframes must be tested for accessibility',
  'heading-order': 'Heading levels must follow logical order',
  'image-redundant-alt': 'Image descriptions must not repeat surrounding text',
  'label-title-only': 'Form fields should have visible labels',
  'landmark-banner-is-top-level':
    "Header region or banner elements must be at the page's top level",
  'landmark-complementary-is-top-level':
    "Sidebar/complementary region must be at the page's top level",
  'landmark-contentinfo-is-top-level': "Footer region must be at the page's top level",
  'landmark-main-is-top-level': "Main content region must be at the page's top level",
  'landmark-no-duplicate-banner': 'Pages must have only one header region',
  'landmark-no-duplicate-contentinfo': 'Pages must have only one footer region',
  'landmark-no-duplicate-main': 'Pages must have only one main content region',
  'landmark-one-main': 'Every page must have a main content region',
  'landmark-unique': 'Page landmarks must be unique or clearly distinguished',
  'meta-viewport-large': 'Pages must allow zoom and scaling',
  'page-has-heading-one': 'Every page must have one main H1 heading',
  'presentation-role-conflict': 'Decorative elements must not be interactive or focusable',
  region: 'All page content must be within marked landmarks or regions',
  'scope-attr-valid': 'Table header scope attributes must be correct',
  'skip-link': 'Skip links must have valid, reachable targets',
  tabindex: 'Elements must not have positive tabindex values',
  'table-duplicate-name': 'Table caption and summary must not be identical',
  'meta-viewport': 'Pages must allow zoom and text scaling',
  'aria-allowed-role': 'Elements must use appropriate roles matching their actual behavior',
};

export const a11yRuleLongDescriptionMap = {
  'aria-meter-name':
    'Meters are visual indicators that show measurements (like how much storage is used) and need text labels. This helps people using screen readers understand what the meter is tracking.',
  'aria-progressbar-name':
    "Progress bars are visual indicators showing completion status and need clear labels describing what's being loaded or processed. This helps people using screen readers know what progress they're watching.",
  'image-alt':
    'Meaningful images (photos, charts, diagrams and other visuals) that communicate important information need text descriptions (called "alt text"). This helps people using screen readers understand what the image shows instead of just hearing/reading out as "image".',
  'input-image-alt':
    'When a button uses only an image instead of text, that image needs a label that describes the button\'s action (called an "accessible name"). e.g., a delete button with a trash can icon should be labeled "Delete" not just "trash can". This helps people using screen readers know what action the button performs.',
  'object-alt':
    'Embedded content, such as PDFs, videos, interactive maps, or other objects need a label that identifies what it is (called an "accessible name"). This helps people using screen readers understand what the object is and what it does. e.g., "View the 2024 annual report (PDF)" or "Video: Company overview (3 minutes)."',
  'oobee-confusing-alt-text':
    'Images that already have alt text (text descriptions for images) but use vague words like "image" "photo", need to be rewritten with actual descriptions of what the image shows. e.g., instead of alt text that says "photo," it should describe what the photo shows: "Team members at the 2024 conference".',
  'role-img-alt':
    'When design elements are marked with image role (a technical way to treat elements as images), they need text descriptions (called "accessible names"). This helps people using screen readers understand what each element represents. e.g., an icon marked as an image needs a description like "Settings icon" not just "image".',
  'svg-img-alt':
    'Vector graphics (scalable graphics created with code called SVGs), that are marked with image role (treated as images) need text descriptions (called "accessible names"). This helps people using screen readers understand what the graphic represents. e.g., an SVG logo should be labeled "Company logo".',
  'video-caption':
    'Videos need captions that show what people are saying and important sounds (captions provided through <track> elements in HTML). This helps people who are deaf or hard of hearing understand video content. Captions should be synchronized with the video and readable.',
  'aria-required-children':
    'Certain accessibility roles (ARIA roles, attributes that tell screen readers what type of element something is) require specific child elements nested inside them to work correctly. e.g., a menu role should contain "menu item" elements inside it. Without the proper child elements, screen readers cannot interpret the structure and the control won\'t work as intended.',
  'aria-required-parent':
    'Certain accessibility roles (ARIA roles, attributes that tell screen readers what type of element something is) require specific parent elements to contain them. e.g., a tab element should be inside a "tab list" parent. When a role is outside its required parent, screen readers cannot understand the relationship and structure, breaking the functionality.',
  'definition-list':
    'Glossaries and FAQs that pair terms with definitions must use proper structure (called a definition list). This means only term and definition elements should be direct children—no other content mixed in directly. This helps screen readers announce which definitions belong to which terms.',
  dlitem:
    'Terms and their definitions must always be grouped inside a definition list (a special structure for glossaries and FAQs). When they appear outside this structure, screen readers cannot understand they are related.',
  list: "When you create a bullet list or numbered list, only list item elements should be immediate children of the list container. This structure helps screen readers announce the list properly and count items correctly. (Note: list items themselves can contain other content like paragraphs, links, or formatting—that's allowed.)",
  listitem:
    'List item elements should only exist inside a list container (bullet list or numbered list). When list items appear outside a list container, screen readers cannot understand they are part of a list, breaking the list structure.',
  'td-headers-attr':
    'Table headers must clearly identify their purpose in relation to the cells they describe, whether they are column headers or row headers. e.g, a column header might be "Revenue" and a row header might be "Q1". Without clear header relationships, screen readers cannot help users understand what data they\'re reading.',
  'th-has-data-cells':
    'Table headers must be correctly labeled and connected to the data cells they describe. This relationship helps screen reader users understand which header applies to which data cell.',
  'autocomplete-valid':
    'Form fields need correct autocomplete attributes (coded hints that tell browsers what type of information goes in each field). When autocomplete attributes follow the specification, browsers can prefill information correctly. This helps people with cognitive disabilities and slow typists.',
  'link-in-text-block':
    'Links must look different from regular text in ways other than just color (like underlining or special styling). This helps people with color blindness and low vision identify which text is clickable.',
  'avoid-inline-spacing':
    "Users should be able to adjust text spacing in their browser settings (spacing is measured in units like ems, not percentages). When CSS styles don't have fixed line-spacing values, users with low vision can increase spacing to read comfortably. This helps people who need wider spacing to read without losing content.",
  'no-autoplay-audio':
    'Pages with audio or video must not auto-play sound when the page loads, unless the sound is very brief (3 seconds or less). Audio that auto-plays longer than 3 seconds must have clear pause/stop controls. This helps people with hearing aids, those who use multiple tabs, and those who need to focus on reading.',
  'color-contrast':
    'Text and background colors need enough contrast ratio (AA level—the baseline accessibility requirement) to be readable. This helps people with low vision see text clearly and read without strain.',
  'color-contrast-enhanced':
    'For enhanced accessibility, text and background colors should meet AAA level contrast (higher than the baseline AA requirement). This provides very high contrast and helps people with low vision see text with minimal strain.',
  'frame-focusable-content':
    'Frames and iframes that contain interactive content need to be accessible via keyboard. When users navigate using Tab, they should be able to reach and interact with content inside the frame. This helps people who navigate only with keyboards.',
  'server-side-image-map':
    "Image maps that use server-side clicking (where the server determines what was clicked based on coordinates) don't work with keyboard navigation. Replace them with client-side image maps (HTML-based maps) so everyone can use them via keyboard or any input method.",
  'scrollable-region-focusable':
    "Scrollable sections that contain interactive elements need to be accessible by keyboard and screen reader. Users should be able to scroll using the keyboard or a screen reader to reach/read all contents inside the scrollable regions. This helps people who can't use a mouse or those using screen readers.",
  'oobee-accessible-label':
    'Clickable elements (buttons, links, etc) need clear, accessible labels that describe what will happen when clicked. This helps screen reader users understand the purpose of each clickable element.',
  'meta-refresh':
    'Pages should not automatically refresh using timed refresh (meta refresh with delays under 20 hours). Automatic page refreshes interrupt users while reading and frustrate those trying to focus on content. If refresh is necessary, users should control it with a button or link.',
  blink:
    'Blinking or flashing text should not be used. This helps people with motion sensitivity, seizure disorders, and those who find flashing content distracting or disorienting.',
  marquee:
    'Scrolling or animated text (marquee elements) should not be used. Moving text is difficult to read and causes problems for people with attention disorders, motion sensitivities, or those with low vision. Content should be static or controlled by the user.',
  'meta-refresh-no-exceptions':
    'Pages must not automatically refresh using meta refresh or similar timed mechanisms. Automatic page refreshes interrupt users reading or using the page, and especially frustrate people with attention disabilities or those trying to focus. If page updates are needed, users should have control.',
  bypass:
    'Pages must provide a way for users to bypass repeated content blocks (e.g. navbars, sidebars, main, headings, footers). One common way to do this is through skip links. However, pages must also have a main landmark (a marked main content area) so screen readers and keyboard users can jump directly to the primary content. This helps users navigate pages more efficiently.',
  'document-title':
    "Every page needs a unique, descriptive title that appears in the browser tab and is read first by screen readers. The title should help users understand what page they're on. This is especially important for people using screen readers who rely on the page title to understand context.",
  'link-name':
    "Links need clear, descriptive text or labels that explain where the link goes or what it does. This helps screen reader users understand the link's purpose without reading surrounding context. Links should have an accessible name (either visible text or a programmatic label).",
  'area-alt':
    'Image maps (images where different clickable regions have different links or actions) must have text labels for each clickable area (called alt text on area elements). Each clickable region should have a descriptive label explaining where it links or what happens when clicked. This helps screen reader users understand what each area does without relying on the image.',
  'identical-links-same-purpose':
    'When links use the same text but go to different destinations, they need additional accessible labels (like aria-label attributes) to distinguish them. This helps screen reader users understand the purpose of each link when they see the same text repeated.',
  'target-size':
    'Clickable elements (buttons, links, form fields, etc) need to be at least 24 pixels in size or have adequate spacing between them. This helps people with mobility issues and those using mobile devices to accurately tap or click without missing or accidentally clicking the wrong element.',
  'html-has-lang':
    'Every page (and any frames or iframes within it) must declare its primary language using a language attribute (lang). This helps screen readers pronounce text with the correct accent and pronunciation, and helps translation tools work correctly.',
  'html-lang-valid':
    'The language declared on the page must use a valid ISO language code (like "en" for English, "fr" for French). Invalid or nonstandard language codes prevent screen readers and translation tools from working correctly.',
  'html-xml-lang-mismatch':
    'Language declarations using different formats (HTML and XML) need to match. If they disagree (e.g., lang="en" and xml:lang="fr" on the same element), screen readers and translation tools become confused about the content language.',
  'valid-lang':
    'When parts of a page use different languages (like a Spanish quote in an English article), those elements must be tagged with valid language codes. Invalid language codes prevent screen readers from switching to the correct pronunciation for that language.',
  'oobee-grading-text-contents':
    'Text on the page should be clear and use simple language. This helps people with cognitive disabilities and non-native speakers understand content. Avoid jargon, long complex sentences, and unclear references.',
  'form-field-multiple-labels':
    "Form fields should only have one label element associated with them. Multiple label elements cause screen readers to announce conflicting information and confuse users about the field's purpose.",
  'aria-allowed-attr':
    "ARIA attributes (accessibility attributes) must be used correctly with elements that support them. Using unsupported ARIA attributes on elements creates conflicting or incorrect screen reader announcements. This prevents users from understanding the element's purpose.",
  'aria-braille-equivalent':
    'When braille-specific abbreviated text is used as a label (like using aria-label="vol" for "volume"), a full text equivalent must also be provided. This ensures non-braille screen reader users and braille display users both understand the label correctly.',
  'aria-command-name':
    'Interactive command elements like role="button", role="link", must have clear, accessible labels. Labels can be visible text, aria-label attributes, or title attributes. Without labels, screen reader users don\'t know what each command does or where links go.',
  'aria-conditional-attr':
    'When ARIA attributes (accessibility attributes) are used on an element, they should not conflict with what the element actually does. Conflicting attributes create confusion about what the element is or what will happen when clicked. e.g., a checkbox is not checked but is aria-checked=true, conflicts for screen reader vs visual readers.',
  'aria-deprecated-role':
    'Some accessibility roles (ARIA roles—code attributes that tell screen readers what type of element something is) are outdated and no longer recommended. Using current, supported roles ensures screen readers announce elements correctly. Outdated roles may cause screen readers to announce elements incorrectly or not at all.',
  'aria-hidden-body':
    'The main page content (the body element) cannot be marked as hidden from screen readers (using aria-hidden="true"). Hiding the page body makes the entire page inaccessible to screen reader users. This is a critical error that breaks accessibility completely.',
  'aria-hidden-focus':
    'Elements marked as hidden from screen readers (aria-hidden="true") should not contain interactive elements like buttons, links, or form fields that can receive keyboard focus. If hidden content is focusable, keyboard users can tab into it but won\'t hear what it is, becoming confused or stuck.',
  'aria-input-field-name':
    "Custom input fields (created with code to look like text boxes, dropdowns etc) must have accessible labels that describe what information should be entered. Without labels, screen reader users don't know what to type.",
  'aria-prohibited-attr':
    "Certain ARIA attributes (accessibility attributes) are only allowed on specific element types. Using prohibited attributes on the wrong elements causes screen readers to become confused about the element's behavior. This creates conflicting or ignored announcements.",
  'aria-required-attr':
    "Certain accessibility roles require specific attributes to work correctly. e.g., a slider role needs aria-valuemin, aria-valuemax, and aria-valuenow to function properly. Without required attributes, screen readers cannot announce the element's current state or allow users to interact with it correctly.",
  'aria-roles':
    'Elements must use valid ARIA roles from the official list. Invalid, misspelled, or unsupported role names confuse screen readers and prevent them from announcing elements correctly. This causes screen reader users to misunderstand what elements do.',
  'aria-toggle-field-name':
    'Toggle switches and custom checkbox / radio button controls need clear labels that describe what is being toggled. e.g., a toggle should be labeled "Dark mode", not just "Toggle". This helps screen reader users understand what will change when they activate it.',
  'aria-tooltip-name':
    "Tooltips must have clear, accessible names. The name should describe what happens when the associated control is activated. This helps screen reader users understand a button's purpose before clicking.",
  'aria-valid-attr':
    'ARIA attributes must be spelled correctly and use valid, documented names. Misspelled or unsupported attribute names are ignored by screen readers, causing missing or incorrect announcements. e.g., "aria-labell" (misspelled) won\'t work; it must be "aria-label".',
  'aria-valid-attr-value':
    'ARIA attributes need valid values from the official specification. Using invalid values (like misspelled or unsupported values) prevents screen readers from interpreting the attribute correctly. e.g., aria-pressed must use "true" or "false", not "yes" or "no".',
  'button-name':
    "Every button must have descriptive text that explains what happens when clicked. This can be visible text inside the button, or a programmatic label (like aria-label or title attribute). Without clear text, screen reader users don't know what the button does.",
  'duplicate-id-aria':
    'Every HTML ID on a page must be unique. When the same ID is used multiple times, it breaks connections between labels and form fields, and confuses accessibility tools. For example, if two form fields both have id="email", a label pointing to one won\'t work correctly.',
  'frame-title':
    'Every frame or iframe (embedded content like maps, videos, widgets etc) must have a descriptive title attribute. The title helps screen reader users understand what content is in the frame before entering it.',
  'frame-title-unique':
    'When a page has multiple frames or iframes, each must have a unique title. If multiple frames share the same title, screen reader users cannot distinguish between them. e.g., a page with two maps needs titles like "Store locations map" and "Service area map"—not both "Map".',
  'input-button-name':
    'Buttons created using HTML input elements (like <input type="button">) must have descriptive text. This can be the value attribute for submit/button types, or alt text for image buttons. Screen reader users need to know what the button does.',
  label:
    "Every form field (text input, checkbox etc) needs a label that describes what information should be entered. Labels can be visible text associated with the field, or programmatic labels (aria-label). Without labels, screen reader users don't know what the field is for.",
  'nested-interactive':
    'Buttons, links, and other interactive elements should not be nested inside one another. e.g., a link should not contain a button, and a button should not contain a link. Nested interactive elements confuse screen readers about which element is clickable and create unexpected keyboard behavior.',
  'select-name':
    "Selected dropdowns (HTML <select> elements) must have labels that describe what choice the dropdown controls. Without labels, screen reader users don't know what selections they're making. Labels can be visible text or programmatic labels.",
  accesskeys:
    'Custom keyboard shortcuts (accesskey attributes) must be unique across the page. Duplicate or conflicting access keys cause unexpected behavior when users try to use them. Additionally, access keys should not conflict with browser (like Ctrl+S), screen reader, or system shortcuts.',
  'aria-dialog-name':
    'Dialog boxes and modal popups must have accessible names (titles) that describe their purpose. When a dialog opens, screen reader users should hear what the dialog is for. This can be visible text at the top of the dialog or an aria-label attribute.',
  'aria-text':
    'Elements marked with role="text" (indicating non-interactive text) should not contain interactive elements like buttons, links, or form fields. If elements marked as role="text" contains focusable elements, keyboard and screen reader users become confused about what they can interact with when they tab through the page.',
  'aria-treeitem-name':
    'Items in tree structures (e.g., navigation tree) or expandable lists (e.g., file explorer) must have clear, accessible names that describe each item. Without names, screen reader users cannot distinguish between different tree items or understand what each represents.',
  'empty-heading':
    'Headings must not be empty or marked hidden. Every heading should have text that describes the section it introduces. Empty headings confuse screen reader users and break the document structure.',
  'empty-table-header':
    'Table header cells (<th> elements) must contain text that describes the column or row. Empty headers make tables unreadable for screen reader users who cannot see the visual layout to infer what each column represents.',
  'frame-tested':
    'All frames and iframes on a page should be tested with accessibility scanning tools (Oobee) to ensure embedded content is accessible. Testing tools need access to frame content to identify issues. Without testing frames, accessibility problems inside them may be missed.',
  'heading-order':
    "Headings must follow a logical, hierarchical order: H1 (page title), then H2 (main sections), then H3 (subsections), etc. Headings should increase by only one level at a time. e.g., you shouldn't jump from H1 directly to H3. This helps screen reader users understand the page structure and navigate it correctly.",
  'image-redundant-alt':
    "When an image's alt text repeats text already visible on the page, screen reader users hear the same information twice—once as text, once as alt text. Alt text should provide new or clarifying information, not duplicate existing text. If an image is purely decorative or just illustrates text already present, its alt can be empty.",
  'label-title-only':
    'Form fields need visible text labels next to them, not just hidden labels or tooltips that only appear on hover. Visible labels help all users (screen reader users and sighted users) understand what to enter. Placeholders and hidden labels are not sufficient.',
  'landmark-banner-is-top-level':
    'The header/banner landmark (the main page header with site title and navigation) should be at the top level of the page, not nested inside the main content area or other landmarks. When headers are nested, keyboard users cannot easily skip to the main content and cannot navigate page structure correctly.',
  'landmark-complementary-is-top-level':
    'The sidebar or complementary content landmark (supporting content like related links or sidebars) should be at the top level of the page, not nested inside the main content. When sidebars are nested, keyboard and screen reader users cannot easily navigate to them and may not realize they exist.',
  'landmark-contentinfo-is-top-level':
    'The footer or contentinfo landmark (page footer with copyright, links, contact info) should be at the top level of the page, not nested inside the main content. When footers are nested, keyboard users cannot easily navigate to them and must scroll through all content to find footer information.',
  'landmark-main-is-top-level':
    'The main content landmark should be at the top level of the page, directly accessible. When main content is nested inside other landmarks or regions, keyboard users must navigate through unnecessary layers to reach the primary page content.',
  'landmark-no-duplicate-banner':
    "A page should have only one main header/banner landmark. When multiple headers exist, screen reader and keyboard users become confused about page structure. They don't know which header is the main one or why there are duplicates.",
  'landmark-no-duplicate-contentinfo':
    "A page should have only one main footer/contentinfo landmark. Multiple footers confuse screen reader and keyboard users about page structure. They don't know which footer is the main one or why duplicates exist.",
  'landmark-no-duplicate-main':
    'A page should have only one main content landmark. When multiple main regions are marked, screen reader and keyboard users become confused about where the primary content actually is. They don\'t know which region is the "real" main content.',
  'landmark-one-main':
    "Every page needs one designated main content landmark (a marked region containing the page's primary content). This helps screen reader and keyboard users navigate directly to the most important content without having to skip through navigation, sidebars, or headers.",
  'landmark-unique':
    'When a page has multiple landmarks of the same type (like two sidebars), each should have a unique label or title. This helps screen reader and keyboard users distinguish between them. e.g., instead of two unlabeled "navigation" regions, they should be labeled "Left sidebar" and "Right sidebar".',
  'meta-viewport-large':
    'Pages must allow users to zoom in and scale content. When zoom is blocked, people with low vision cannot enlarge text and controls to read them comfortably. The viewport meta tag should allow scaling and not restrict maximum zoom.',
  'page-has-heading-one':
    'Every page should have one or more H1 heading that serves as the main topic. The H1 helps screen reader users quickly understand what the page is about and provides a structural anchor for the document.',
  'presentation-role-conflict':
    'Elements marked with role="presentation" or role="none" (which tells assistive technology to ignore them as they\'re decorative) should not be focusable or have interactive behavior. If an element is marked as decorative but is also focusable or interactive, there\'s a conflict—keyboard users can tab to it but won\'t understand what it is.',
  region:
    "Every piece of content on a page should be within a marked landmark or region (like header, main, footer, sidebar, or navigation). Orphaned content that's not inside any landmark can be missed by screen reader users. Marking content into regions helps keyboard users skip between sections and understand page organization.",
  'scope-attr-valid':
    'Table headers should have scope attributes that correctly identify whether they\'re column headers (scope="col") or row headers (scope="row"). The scope attribute tells screen readers which header applies to which cells. Incorrect scope values confuse screen readers about cell relationships.',
  'skip-link':
    'Skip links should be the first focusable element on a page (appear when you press Tab). When clicked, they should jump directly to the main content—which means the target (the element it points to) must exist and be reachable. Without a valid target, the skip link is broken and useless.',
  tabindex:
    'The tabindex attribute should never have positive values (like tabindex="1"). Positive tabindex values override the natural page order and cause keyboard navigation to become confusing and chaotic—jumping around the page unpredictably.',
  'table-duplicate-name':
    'Tables should not have both a caption and a summary that say exactly the same thing. This causes screen reader users to hear the same information announced twice. The caption should briefly describe the table, and any summary should add additional context or explanation—not repeat the caption word-for-word.',
  'meta-viewport':
    'Pages must allow users to zoom in and scale text using their browser or pinch-to-zoom on mobile devices. Disabling zoom locks people with low vision out of being able to enlarge content to read them comfortably. The viewport meta tag should allow scaling and not restrict maximum zoom.',
  'aria-allowed-role': `Buttons, links, and interactive elements should behave the way they're marked. e.g., if something looks and acts like a button (performs an action), it should be labeled as a button. If it goes to a different page, it should be labeled as a link. When the label doesn't match the actual behavior, screen reader users get confused about what will happen when they click. When possible, use real buttons (<button>) and real links (<a>) instead of creating fake buttons or links from plain text and code.`,
};

export const disabilityBadgesMap = {
  'aria-meter-name': ['Visual'],
  'aria-progressbar-name': ['Visual'],
  'image-alt': ['Visual'],
  'input-image-alt': ['Visual'],
  'object-alt': ['Visual'],
  'oobee-confusing-alt-text': ['Visual', 'Learning'],
  'role-img-alt': ['Visual'],
  'svg-img-alt': ['Visual'],
  'video-caption': ['Hearing'],
  'aria-required-children': ['Visual'],
  'aria-required-parent': ['Visual'],
  'definition-list': ['Visual'],
  dlitem: ['Visual'],
  list: ['Visual'],
  listitem: ['Visual'],
  'td-headers-attr': ['Visual'],
  'th-has-data-cells': ['Visual'],
  'autocomplete-valid': ['Learning'],
  'link-in-text-block': ['Visual', 'Learning'],
  'avoid-inline-spacing': ['Visual', 'Learning'],
  'no-autoplay-audio': ['Hearing', 'Learning'],
  'color-contrast': ['Visual'],
  'color-contrast-enhanced': ['Visual'],
  'frame-focusable-content': ['Motor', 'Visual'],
  'server-side-image-map': ['Motor', 'Visual'],
  'scrollable-region-focusable': ['Motor', 'Visual'],
  'oobee-accessible-label': ['Motor', 'Visual'],
  'meta-refresh': ['Learning'],
  blink: ['Learning', 'Visual'],
  marquee: ['Learning', 'Visual'],
  'meta-refresh-no-exceptions': ['Learning'],
  bypass: ['Visual', 'Learning'],
  'document-title': ['Visual', 'Learning'],
  'link-name': ['Visual', 'Learning'],
  'area-alt': ['Visual', 'Learning'],
  'identical-links-same-purpose': ['Motor'],
  'target-size': ['Learning'],
  'html-has-lang': ['Learning'],
  'html-lang-valid': ['Learning'],
  'html-xml-lang-mismatch': ['Learning'],
  'valid-lang': ['Learning'],
  'oobee-grading-text-contents': ['Learning', 'Visual'],
  'form-field-multiple-labels': ['Visual'],
  'aria-allowed-attr': ['Visual'],
  'aria-braille-equivalent': ['Visual'],
  'aria-command-name': ['Visual'],
  'aria-conditional-attr': ['Visual'],
  'aria-deprecated-role': ['Visual'],
  'aria-hidden-body': ['Visual', 'Motor'],
  'aria-hidden-focus': ['Visual'],
  'aria-input-field-name': ['Visual'],
  'aria-prohibited-attr': ['Visual'],
  'aria-required-attr': ['Visual'],
  'aria-roles': ['Visual'],
  'aria-toggle-field-name': ['Visual'],
  'aria-tooltip-name': ['Visual'],
  'aria-valid-attr': ['Visual'],
  'aria-valid-attr-value': ['Visual'],
  'button-name': ['Visual'],
  'duplicate-id-aria': ['Visual'],
  'frame-title': ['Visual'],
  'frame-title-unique': ['Visual'],
  'input-button-name': ['Visual'],
  label: ['Motor', 'Learning', 'Visual'],
  'nested-interactive': ['Visual'],
  'select-name': ['Visual'],
  accesskeys: ['Motor', 'Learning'],
  'aria-allowed-role': ['Visual'],
  'aria-dialog-name': ['Visual', 'Learning'],
  'aria-text': ['Visual'],
  'aria-treeitem-name': ['Visual'],
  'empty-heading': ['Visual', 'Learning'],
  'empty-table-header': ['Visual'],
  'frame-tested': ['Visual'],
  'heading-order': ['Visual', 'Learning'],
  'image-redundant-alt': ['Visual'],
  'label-title-only': ['Visual'],
  'landmark-banner-is-top-level': ['Visual'],
  'landmark-complementary-is-top-level': ['Visual'],
  'landmark-contentinfo-is-top-level': ['Visual'],
  'landmark-main-is-top-level': ['Visual'],
  'landmark-no-duplicate-banner': ['Visual'],
  'landmark-no-duplicate-contentinfo': ['Visual'],
  'landmark-no-duplicate-main': ['Visual'],
  'landmark-one-main': ['Visual'],
  'landmark-unique': ['Visual'],
  'meta-viewport-large': ['Learning', 'Visual'],
  'page-has-heading-one': ['Visual', 'Learning'],
  'presentation-role-conflict': ['Visual'],
  region: ['Visual'],
  'scope-attr-valid': ['Visual'],
  'skip-link': ['Motor', 'Learning', 'Visual'],
  tabindex: ['Motor'],
  'meta-viewport': ['Visual'],
};

export default {
  cliZipFileName: 'oobee-scan-results.zip',
  exportDirectory: undefined,
  maxRequestsPerCrawl,
  maxConcurrency: 25,
  urlsCrawledObj,
  impactOrder,
  launchOptionsArgs,
  xmlSitemapTypes,
  urlCheckStatuses,
  launcher: chromium,
  pdfScanResultFileName: 'pdf-scan-results.json',
  forbiddenCharactersInDirPath,
  reserveFileNameKeywords,
  wcagLinks,
  wcagCriteriaLabels,
  a11yRuleShortDescriptionMap,
  disabilityBadgesMap,
  robotsTxtUrls: null,
  userDataDirectory: null, // This will be set later in the code
  randomToken: null, // This will be set later in the code
  // Track all active Crawlee / Playwright resources for cleanup
  resources: {
    crawlers: new Set<PlaywrightCrawler>(),
    browserContexts: new Set<BrowserContext>(),
    browsers: new Set<Browser>(),
  },
};

export const rootPath = dirname;
export const wcagWebPage = 'https://www.w3.org/TR/WCAG22/';
const latestAxeVersion = '4.9';
export const axeVersion = latestAxeVersion;
export const axeWebPage = `https://dequeuniversity.com/rules/axe/${latestAxeVersion}/`;

export const saflyIconSelector = `#__safly_icon`;
export const cssQuerySelectors = [
  ':not(a):is([role="link"]',
  'button[onclick])',
  'a:not([href])',
  '[role="button"]:not(a[href])', // Add this line to select elements with role="button" where it is not <a> with href
];

export enum RuleFlags {
  DEFAULT = 'default',
  DISABLE_OOBEE = 'disable-oobee',
  ENABLE_WCAG_AAA = 'enable-wcag-aaa',
}

// Note: Not all status codes will appear as Crawler will handle it as best effort first. E.g. try to handle redirect
export const STATUS_CODE_METADATA: Record<number, string> = {
  // Custom Codes for Oobee's use
  0: 'Page Excluded',
  1: 'Not A Supported Document',
  2: 'Web Crawler Errored',

  // 599 is set because Crawlee returns response status 100, 102, 103 as 599
  599: 'Uncommon Response Status Code Received',

  // This is Status OK but thrown when the crawler cannot scan the page
  200: 'Oobee was not able to scan the page due to access restrictions or compatibility issues',

  // 1xx - Informational
  100: '100 - Continue',
  101: '101 - Switching Protocols',
  102: '102 - Processing',
  103: '103 - Early Hints',

  // 2xx - Browser Doesn't Support
  204: '204 - No Content',
  205: '205 - Reset Content',

  // 3xx - Redirection
  300: '300 - Multiple Choices',
  301: '301 - Moved Permanently',
  302: '302 - Found',
  303: '303 - See Other',
  304: '304 - Not Modified',
  305: '305 - Use Proxy',
  307: '307 - Temporary Redirect',
  308: '308 - Permanent Redirect',

  // 4xx - Client Error
  400: '400 - Bad Request',
  401: '401 - Unauthorized',
  402: '402 - Payment Required',
  403: '403 - Forbidden',
  404: '404 - Not Found',
  405: '405 - Method Not Allowed',
  406: '406 - Not Acceptable',
  407: '407 - Proxy Authentication Required',
  408: '408 - Request Timeout',
  409: '409 - Conflict',
  410: '410 - Gone',
  411: '411 - Length Required',
  412: '412 - Precondition Failed',
  413: '413 - Payload Too Large',
  414: '414 - URI Too Long',
  415: '415 - Unsupported Media Type',
  416: '416 - Range Not Satisfiable',
  417: '417 - Expectation Failed',
  418: "418 - I'm a teapot",
  421: '421 - Misdirected Request',
  422: '422 - Unprocessable Content',
  423: '423 - Locked',
  424: '424 - Failed Dependency',
  425: '425 - Too Early',
  426: '426 - Upgrade Required',
  428: '428 - Precondition Required',
  429: '429 - Too Many Requests',
  431: '431 - Request Header Fields Too Large',
  451: '451 - Unavailable For Legal Reasons',

  // 5xx - Server Error
  500: '500 - Internal Server Error',
  501: '501 - Not Implemented',
  502: '502 - Bad Gateway',
  503: '503 - Service Unavailable',
  504: '504 - Gateway Timeout',
  505: '505 - HTTP Version Not Supported',
  506: '506 - Variant Also Negotiates',
  507: '507 - Insufficient Storage',
  508: '508 - Loop Detected',
  510: '510 - Not Extended',
  511: '511 - Network Authentication Required',
};

// Elements that should not be clicked or enqueued
// With reference from https://chromeenterprise.google/policies/url-patterns/
export const disallowedListOfPatterns = [
  '#',
  'mailto:',
  'tel:',
  'sms:',
  'skype:',
  'zoommtg:',
  'msteams:',
  'whatsapp:',
  'slack:',
  'viber:',
  'tg:',
  'line:',
  'meet:',
  'facetime:',
  'imessage:',
  'discord:',
  'sgnl:',
  'webex:',
  'intent:',
  'ms-outlook:',
  'ms-onedrive:',
  'ms-word:',
  'ms-excel:',
  'ms-powerpoint:',
  'ms-office:',
  'onenote:',
  'vs:',
  'chrome-extension:',
  'chrome-search:',
  'chrome:',
  'chrome-untrusted:',
  'devtools:',
  'isolated-app:',
];

export const disallowedSelectorPatterns = disallowedListOfPatterns
  .map(pattern => `a[href^="${pattern}"]`)
  .join(',')
  .replace(/\s+/g, '');

export const WCAGclauses = {
  '1.1.1': 'Provide text alternatives',
  '1.2.2': 'Add captions to videos',
  '1.3.1': 'Use proper headings and lists',
  '1.3.5': 'Clearly label common fields',
  '1.4.1': 'Add cues beyond color',
  '1.4.2': 'Control any autoplay audio',
  '1.4.3': 'Ensure text is easy to read',
  '1.4.4': 'Allow zoom without breaking layout',
  '1.4.6': 'Ensure very high text contrast',
  '1.4.12': 'Let users adjust text spacing',
  '2.1.1': 'Everything works by keyboard',
  '2.1.3': 'Everything works only by keyboard',
  '2.2.1': 'Let users extend time limits',
  '2.2.2': 'Let users stop motion',
  '2.2.4': 'Let users control alerts',
  '2.4.1': 'Add skip navigation',
  '2.4.2': 'Write clear page titles',
  '2.4.4': 'Say where links go',
  '2.4.9': 'Links make sense on their own',
  '2.5.8': 'Buttons must be easy to tap',
  '3.1.1': "Declare the page's language",
  '3.1.2': 'Show when language changes',
  '3.1.5': 'Keep content easy to read',
  '3.2.5': "Don't auto-change settings",
  '3.3.2': 'Label fields and options',
  '4.1.2': 'Make buttons and inputs readable',
};
