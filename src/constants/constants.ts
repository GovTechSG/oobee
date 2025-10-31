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
  'aria-meter-name': 'All elements must have clear text to describe it',
  'aria-progressbar-name': 'Add labels to progress bars',
  'image-alt': 'Add alt text to images',
  'input-image-alt': 'Add alt text to image buttons',
  'object-alt': 'Add alt text to embedded content',
  'oobee-confusing-alt-text': 'Rewrite unhelpful image alt text',
  'role-img-alt': 'Add alt text to icon images',
  'svg-img-alt': 'Add alt text to vector images',
  'video-caption': 'Add captions to videos',
  'aria-required-children': 'Add the required child elements for every accessibility (ARIA) role',
  'aria-required-parent': 'Add the required parent for every accessibility (ARIA) role',
  'definition-list': 'Group terms and definitions correctly',
  dlitem: 'Put terms and definitions in lists',
  list: 'Put list items inside lists',
  listitem: 'Place list items inside a list',
  'td-headers-attr': 'Reference headers within the same table',
  'th-has-data-cells': 'Connect table headers to cells',
  'autocomplete-valid': 'Use correct autocomplete values',
  'link-in-text-block': 'Make links look different from text beyond using color',
  'avoid-inline-spacing': 'Allow custom text spacing',
  'no-autoplay-audio': 'Disable auto-playing audio',
  'color-contrast': 'Increase contrast for readability',
  'color-contrast-enhanced': 'Increase contrast for AAA readability',
  'frame-focusable-content': 'Let users tab into frames',
  'server-side-image-map': 'Replace server-side image maps',
  'scrollable-region-focusable': 'Make scrollable regions keyboard friendly',
  'oobee-accessible-label': 'Label clickable custom elements',
  'meta-refresh': 'Avoid timed refresh under 20 hours',
  blink: 'Remove blinking text',
  marquee: 'Remove scrolling text',
  'meta-refresh-no-exceptions': 'Avoid timed refreshes',
  bypass: 'Add a skip to content link',
  'document-title': 'Add a page title',
  'link-name': 'Add descriptive text to links',
  'area-alt': 'Add labels to clickable image areas',
  'identical-links-same-purpose': 'Match link text to its purpose',
  'target-size': 'All touch targets must have sufficient space',
  'html-has-lang': 'Set page language (lang)',
  'html-lang-valid': 'Fix invalid language',
  'html-xml-lang-mismatch': 'Make page language settings match',
  'valid-lang': 'Use valid language',
  'oobee-grading-text-contents': 'Write clear, plain text',
  'form-field-multiple-labels': 'Keep one label per field',
  'aria-allowed-attr': 'Remove inaccessible elements',
  'aria-braille-equivalent': 'Add non-braille equivalent setting',
  'aria-command-name': 'Add text to interactive commands',
  'aria-conditional-attr': 'Use accessibility (ARIA) attributes for every element',
  'aria-deprecated-role': 'Remove outdated accessibility (ARIA) attributes',
  'aria-hidden-body': 'Remove hidden elements from page body',
  'aria-hidden-focus': "Don't hide elements that require keyboard focus",
  'aria-input-field-name': 'Add labels to custom inputs',
  'aria-prohibited-attr': 'Remove attributes not allowed here',
  'aria-required-attr': 'Add the required accessibility (ARIA) attributes',
  'aria-roles': 'Every accessibility (ARIA) role is a valid element',
  'aria-toggle-field-name': 'Add labels to toggle switches',
  'aria-tooltip-name': 'Add labels to tooltips',
  'aria-valid-attr': 'Use valid attribute names',
  'aria-valid-attr-value': 'Use valid attribute values',
  'button-name': 'Add text to buttons',
  'duplicate-id-aria': 'Make referenced IDs unique',
  'frame-title': 'Add a title to frames',
  'frame-title-unique': 'Give each frame a unique title',
  'input-button-name': 'Add text to input buttons',
  label: 'Label each form field',
  'nested-interactive': 'Avoid nested interactive controls',
  'select-name': 'Name the select dropdown',
  accesskeys: 'Use unique keyboard shortcuts',
  'aria-allowed-role': 'Use the correct element type',
  'aria-dialog-name': 'Add titles to dialog popups',
  'aria-text': "Don't focus decorative text",
  'aria-treeitem-name': 'Label items in expandable lists',
  'empty-heading': 'Remove empty headings',
  'empty-table-header': 'Add text to table headers',
  'frame-tested': 'Test frames with accessibility tools',
  'heading-order': 'Fix heading level order',
  'image-redundant-alt': "Don't repeat image alt as text",
  'label-title-only': 'Show a visible label for fields',
  'landmark-banner-is-top-level': 'Keep header outside other regions',
  'landmark-complementary-is-top-level': 'Keep sidebar outside other regions',
  'landmark-contentinfo-is-top-level': 'Keep footer outside other regions',
  'landmark-main-is-top-level': 'Keep main region top-level',
  'landmark-no-duplicate-banner': 'Use one header region',
  'landmark-no-duplicate-contentinfo': 'Use one footer region',
  'landmark-no-duplicate-main': 'Use one main region',
  'landmark-one-main': 'Add one main content region',
  'landmark-unique': 'Differentiate page regions',
  'meta-viewport-large': 'Allow pinch-to-zoom',
  'page-has-heading-one': 'Add one H1 heading',
  'presentation-role-conflict': 'Avoid focus on decorative elements',
  region: 'Wrap page content in regions',
  'scope-attr-valid': 'Use correct scope on headers',
  'skip-link': 'Ensure skip link target exists',
  tabindex: 'Remove positive tabindex values',
  'table-duplicate-name': 'Avoid duplicate table summary/caption',
  'meta-viewport': 'Allow zooming and scaling of pages',
};

export const a11yRuleLongDescriptionMap = {
  'aria-meter-name':
    'Meters that show measurements (like storage usage) need text labels. This helps people using screen readers understand what the meter is tracking.',
  'aria-progressbar-name':
    "Progress bars need clear labels describing what's being loaded or processed. This helps people using screen readers know what progress they're watching.",
  'image-alt':
    "Images need short text descriptions that explain what they show. This helps people using screen readers understand the image instead of just hearing 'image'.",
  'input-image-alt':
    'Image buttons (buttons that use images instead of text) need text descriptions. This helps people using screen readers know what the button does.',
  'object-alt':
    'Embedded content like PDFs or videos need text descriptions. This helps people using screen readers understand what the embedded content is.',
  'oobee-confusing-alt-text':
    "Image descriptions using vague words like 'image', 'photo', or 'graphic' are unhelpful. Replace them with actual descriptions of what the image shows.",
  'role-img-alt':
    'When icons or graphics are marked as images, they need text descriptions. This helps people using screen readers understand what each icon represents.',
  'svg-img-alt':
    'Vector graphics (SVGs) marked as images need text descriptions. This helps people using screen readers understand what the graphic represents.',
  'video-caption':
    'Videos need captions that show what people are saying and important sounds. This helps people with hearing loss understand video content.',
  'aria-required-children':
    'Certain special HTML elements require specific child elements to work correctly. Fix this structural issue so screen readers can interpret the content properly.',
  'aria-required-parent':
    'Certain special HTML elements must be placed inside specific parent elements. Fix this structural issue so the content makes sense to screen readers.',
  'definition-list':
    'Glossary-style lists (terms paired with definitions) need proper list structure. This helps screen readers announce the relationships between terms and their meanings.',
  dlitem:
    'Terms and definitions need to be grouped in proper list elements. This helps screen readers understand that definitions belong to specific terms.',
  list: 'Bullet or numbered items need to be marked as proper lists. This helps screen readers announce list structure and item count to users.',
  listitem:
    'List items need to be placed inside list elements. This helps screen readers recognize the list structure and count items correctly.',
  'td-headers-attr':
    'Table cells need to link to their correct header cells. This helps screen reader users navigate tables and understand what each number means.',
  'th-has-data-cells':
    'Table headers need to link to the data cells they describe. This helps screen reader users understand which headers apply to which cells.',
  'autocomplete-valid':
    'Form fields need correct autocomplete hints so browsers can prefill information correctly. This helps people with cognitive disabilities and slow typists.',
  'link-in-text-block':
    'Links must look different from regular text in ways other than just color. This helps people with color blindness and low vision identify clickable links.',
  'avoid-inline-spacing':
    'Text spacing should be adjustable through browser settings. This helps people with low vision who need wider spacing to read comfortably.',
  'no-autoplay-audio':
    "Audio or video shouldn't automatically play sound when the page loads. This helps people with hearing aids and those who need to focus on reading.",
  'color-contrast':
    'Text and background colors need enough contrast to be readable. This helps people with low vision see text clearly.',
  'color-contrast-enhanced':
    'For better accessibility, text and background colors should have very high contrast. This helps people with low vision see text clearly.',
  'frame-focusable-content':
    'Iframes containing interactive content need keyboard access. This helps people who navigate only with keyboards.',
  'server-side-image-map':
    "Image maps using server-side clicking don't work with keyboards. Replace them with HTML-based image maps so everyone can use them.",
  'scrollable-region-focusable':
    "Scrollable sections need keyboard access so users can scroll with the keyboard. This helps people who can't use a mouse.",
  'oobee-accessible-label':
    'Clickable elements need clear labels or text. This helps screen reader users understand what will happen when they click.',
  'meta-refresh':
    "Pages shouldn't automatically refresh unless absolutely necessary, and if they do, users must have time to prepare or stop it. Automatic refreshes interrupt reading and frustrate users.",
  blink:
    "Blinking or flashing content shouldn't be used. This helps people with motion sensitivity avoid discomfort.",
  marquee:
    "Scrolling text (marquee) shouldn't be used. This makes content hard to read and causes problems for people with attention or motion sensitivities.",
  'meta-refresh-no-exceptions':
    "The page shouldn't automatically refresh. This prevents frustration for all users and especially helps those with reading or attention disabilities.",
  bypass:
    'Pages need a skip link so users can jump past repeated content like navigation. This helps keyboard users move through pages quickly.',
  'document-title':
    "Every page needs a descriptive title. This helps people understand what page they're on, especially those using screen readers.",
  'link-name':
    'Links need clear, descriptive text. This helps screen reader users understand where links go without reading surrounding text.',
  'area-alt':
    'Clickable regions in image maps need text descriptions. This helps screen reader users understand what each region does without relying on the image.',
  'identical-links-same-purpose':
    'Links with the same text should go to the same page. This prevents confusion about where similar-looking links go.',
  'target-size':
    'Clickable elements need to be large enough to tap easily. This helps people with mobility issues and those using mobile devices.',
  'html-has-lang':
    'The page must declare its language. This helps screen readers pronounce text correctly and helps translation tools work better.',
  'html-lang-valid':
    'The language declaration must be valid and accurate. This ensures screen readers and translation tools can work properly.',
  'html-xml-lang-mismatch':
    'Language declarations using different formats need to match. This prevents confusion for screen readers and translation tools.',
  'valid-lang':
    'Parts of the page in different languages need correct language tags. This helps screen readers pronounce text in the right language.',
  'oobee-grading-text-contents':
    'Page text should be clear and use simple language. This helps people with cognitive disabilities and non-native speakers understand content.',
  'form-field-multiple-labels':
    "Form fields shouldn't have multiple label elements. This prevents screen readers from announcing conflicting information.",
  'aria-allowed-attr':
    'ARIA attributes need to be used with appropriate roles. This prevents conflicting or incorrect screen reader announcements.',
  'aria-braille-equivalent':
    'Text marked for braille needs a standard text equivalent. This ensures screen readers can read it correctly.',
  'aria-command-name':
    'Buttons, links, and menu items need text labels. This helps screen readers announce what they do.',
  'aria-conditional-attr':
    'ARIA attributes need to follow the rules for their roles. Using them incorrectly can confuse screen readers.',
  'aria-deprecated-role':
    "Some ARIA roles are outdated and shouldn't be used. Update to current ARIA roles to ensure compatibility.",
  'aria-hidden-body':
    "The main page content can't be hidden from screen readers. This would make the entire page inaccessible.",
  'aria-hidden-focus':
    "Elements hidden from screen readers shouldn't be focusable. This prevents keyboard users from getting stuck on hidden content.",
  'aria-input-field-name':
    'Input fields need labels or descriptions. This helps screen reader users understand what information to enter.',
  'aria-prohibited-attr':
    "Certain ARIA attributes can't be used with specific roles. Remove prohibited attributes to prevent screen reader confusion.",
  'aria-required-attr':
    'Certain roles require specific ARIA attributes to work. Add missing attributes so screen readers get complete information.',
  'aria-roles':
    'ARIA roles must be valid. Invalid roles confuse screen readers and prevent assistive technology from working.',
  'aria-toggle-field-name':
    'Toggle fields need labels. This helps screen reader users understand what can be toggled.',
  'aria-tooltip-name':
    'Tooltips need descriptive text. This helps screen reader users understand what the tooltip says.',
  'aria-valid-attr':
    "ARIA attributes must be spelled correctly. Misspelled attributes won't work and screen readers will ignore them.",
  'aria-valid-attr-value':
    'ARIA attributes need valid values. Using invalid values prevents screen readers from interpreting them correctly.',
  'button-name':
    'Buttons need clear, descriptive text. This helps screen reader users understand what the button does.',
  'duplicate-id-aria':
    'HTML IDs must be unique across the page. Duplicate IDs break connections between labels and form fields.',
  'frame-title':
    "Iframes need descriptive titles. This helps screen reader users understand what's inside each iframe.",
  'frame-title-unique':
    'Each iframe needs a unique title. This helps screen reader users distinguish between multiple iframes.',
  'input-button-name':
    'Buttons made from input fields need descriptive text. This helps screen reader users know what action the button performs.',
  label:
    'Every form field needs a label. This helps screen reader users understand what information each field wants.',
  'nested-interactive':
    "Buttons, links, and other interactive elements shouldn't be nested inside each other. This confuses both screen readers and keyboard users about what's clickable.",
  'select-name':
    "Select dropdowns need labels. This helps screen reader users know what choice they're making.",
  accesskeys: 'Access keys must be unique. Duplicate access keys cause unexpected behavior.',
  'aria-allowed-role':
    'ARIA roles need to match what the element actually does. This prevents screen readers from announcing incorrect information.',
  'aria-dialog-name':
    'Dialog boxes need labels. This helps screen readers announce what dialog has opened.',
  'aria-text':
    "Elements with role='text' shouldn't have interactive children. This prevents keyboard users from getting confused about what can be interacted with.",
  'aria-treeitem-name':
    'Items in tree structures need labels. This helps screen readers announce each item.',
  'empty-heading':
    'Headings need text content. Empty headings are confusing for screen reader users.',
  'empty-table-header':
    'Table header cells need text. Empty headers confuse screen reader users about what columns mean.',
  'frame-tested':
    'Iframes must contain the testing script for accessibility checking. This ensures all content gets properly analyzed.',
  'heading-order':
    'Headings must follow a logical order (H1, then H2, then H3, etc.). This helps screen readers navigate page structure correctly.',
  'image-redundant-alt':
    "Image alt text shouldn't repeat text already visible on the page. This prevents screen reader users from hearing information twice.",
  'label-title-only':
    'Form fields need visible labels, not just hidden ones or tooltips. This helps all users understand what each field is for.',
  'landmark-banner-is-top-level':
    'Headers should be at the top level, not nested inside other regions. This helps keyboard users navigate page structure.',
  'landmark-complementary-is-top-level':
    'Sidebars should be at the top level, not nested inside other regions. This helps keyboard users navigate to sidebars easily.',
  'landmark-contentinfo-is-top-level':
    'Footers should be at the top level, not nested inside other regions. This helps keyboard users access footer content.',
  'landmark-main-is-top-level':
    'Main content regions should be at the top level, not nested inside other regions. This helps keyboard users navigate pages quickly.',
  'landmark-no-duplicate-banner':
    'Pages should have only one header region. Multiple headers confuse screen reader users about page structure.',
  'landmark-no-duplicate-contentinfo':
    'Pages should have only one footer region. Multiple footers confuse screen reader users.',
  'landmark-no-duplicate-main':
    'Pages should have only one main content region. Multiple main regions confuse screen reader users.',
  'landmark-one-main':
    'Pages need a main content region. This helps screen readers navigate to the most important content.',
  'landmark-unique':
    'Each page region should have a unique label. This helps keyboard users and screen reader users distinguish between similar regions.',
  'meta-viewport-large':
    'Pages must allow pinch-to-zoom on mobile devices. This helps people with low vision see content clearly.',
  'page-has-heading-one':
    'Pages need one main H1 heading. This helps screen reader users find the page title and understand page structure.',
  'presentation-role-conflict':
    "Elements marked as decorative shouldn't be focusable or have global ARIA attributes. This prevents keyboard users from getting confused.",
  region:
    'All page content should be in marked regions (header, main, footer, sidebar). This helps keyboard users navigate page sections efficiently.',
  'scope-attr-valid':
    'Table header scope attributes must be correct. This helps screen readers match headers to data cells accurately.',
  'skip-link':
    'Skip links need working targets. This helps keyboard users jump directly to main content.',
  tabindex:
    "Elements shouldn't have positive tabindex values. This prevents keyboard navigation from becoming confusing and broken.",
  'table-duplicate-name':
    "Table captions and summaries shouldn't repeat the same text. This avoids confusion for screen reader users.",
  'meta-viewport':
    'Pages must allow users to zoom and scale the text. This helps people with low vision read content by making it larger.',
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
