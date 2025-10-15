import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { globSync } from 'glob';
import which from 'which';
import os from 'os';
import { spawnSync, execSync } from 'child_process';
import { Browser, BrowserContext, chromium } from 'playwright';
import * as Sentry from '@sentry/node';
import { consoleLogger, silentLogger } from '../logs.js';
import { PageInfo } from '../mergeAxeResults.js';
import { PlaywrightCrawler } from 'crawlee';

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
  'xml'
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

export function getEnumKey<E extends Record<string, string>>(enumObj: E, value: string): keyof E | undefined {
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
  dsn: process.env.OOBEE_SENTRY_DSN || "https://3b8c7ee46b06f33815a1301b6713ebc3@o4509047624761344.ingest.us.sentry.io/4509327783559168",
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

const urlCheckStatuses = {
  success: { code: 0 },
  invalidUrl: { code: 11, message: 'Invalid URL. Please check and try again.' },
  cannotBeResolved: { code: 12, message: 'URL cannot be accessed. Please verify whether the website exists.' },
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
    message:
      'Incompatible browser. Please ensure you are using Chrome or Edge browser.',
  },
  sslProtocolError: { code: 18, message: 'SSL certificate  error. Please check the SSL configuration of your website and try again.' },
  notALocalFile: { code: 19, message: 'Uploaded file format is incorrect. Please upload a HTML, PDF, XML or TXT file.' },
  notAPdf: { code: 20, message: 'URL/file format is incorrect. Please upload a PDF file.' },
  notASupportedDocument: { code: 21, message: 'Uploaded file format is incorrect. Please upload a HTML, PDF, XML or TXT file.' },
  connectionRefused: { code: 22, message: 'Connection refused. Please try again in a few minutes. If this issue persists, please contact the Oobee team.' },
  timedOut: { code: 23, message: 'Request timed out. Please try again in a few minutes. If this issue persists, please contact the Oobee team.' },
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
export const STATUS_CODE_METADATA: Record<number,string> = {
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
  "#",
  "mailto:",
  "tel:",
  "sms:",
  "skype:",
  "zoommtg:",
  "msteams:",
  "whatsapp:",
  "slack:",
  "viber:",
  "tg:",
  "line:",
  "meet:",
  "facetime:",
  "imessage:",
  "discord:",
  "sgnl:",
  "webex:",
  "intent:",
  "ms-outlook:",
  "ms-onedrive:",
  "ms-word:",
  "ms-excel:",
  "ms-powerpoint:",
  "ms-office:",
  "onenote:",
  "vs:",
  "chrome-extension:",
  "chrome-search:",
  "chrome:",
  "chrome-untrusted:",
  "devtools:",
  "isolated-app:"
];

export const disallowedSelectorPatterns = disallowedListOfPatterns
  .map(pattern => `a[href^="${pattern}"]`)
  .join(',')
  .replace(/\s+/g, '');
