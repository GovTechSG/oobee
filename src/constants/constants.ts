import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs-extra';
import { globSync } from 'glob';
import which from 'which';
import os from 'os';
import { spawnSync } from 'child_process';
import { Browser, BrowserContext, chromium } from 'playwright';
import { PlaywrightCrawler } from 'crawlee';
import { consoleLogger, silentLogger } from '../logs.js';
import { PageInfo } from '../types.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const require = createRequire(import.meta.url);

const maxRequestsPerCrawl = 100;

export { PageInfo };

import crawlConfig from '../crawl-config.json' with { type: 'json' };

export const blackListedFileExtensions = crawlConfig.blockExtensions.map(ext => ext.replace(/^\./, ''));

export const getIntermediateScreenshotsPath = (datasetsPath: string): string =>
  `${datasetsPath}/screenshots`;
export const destinationPath = (storagePath: string): string => `${storagePath}/screenshots`;

export const getDefaultChromeDataDir = (): string => {
  try {
    let defaultChromeDataDir = null;
    if (os.platform() === 'win32') {
      defaultChromeDataDir = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    } else if (os.platform() === 'darwin') {
      defaultChromeDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    }
    if (defaultChromeDataDir && fs.existsSync(defaultChromeDataDir)) {
      return defaultChromeDataDir;
    }
    return null;
  } catch (error) {
    console.error(`Error in getDefaultChromeDataDir(): ${error}`);
  }
};

export const getDefaultEdgeDataDir = (): string => {
  try {
    let defaultEdgeDataDir = null;
    if (os.platform() === 'win32') {
      defaultEdgeDataDir = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data');
    } else if (os.platform() === 'darwin') {
      defaultEdgeDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge');
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
      defaultChromiumDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Chromium');
    } else {
      defaultChromiumDataDir = path.join(process.cwd(), 'Chromium Support');
      try {
        fs.mkdirSync(defaultChromiumDataDir, { recursive: true });
      } catch {
        defaultChromiumDataDir = '/tmp';
      }
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
  const matches = globSync(searchPattern, { absolute: true, nodir: true, dot: true, follow: false });
  const root = path.resolve(allowedRoot);
  for (const p of matches) {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(root + path.sep)) continue;
    let st: fs.Stats;
    try { st = fs.lstatSync(resolved); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    const base = path.basename(resolved);
    if (/[\x00-\x1F]/.test(base)) continue;
    spawnSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', '--', resolved], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
}

export const getExecutablePath = function (dir: string, file: string): string {
  let execPaths = globSync(`${dir}/${file}`, { absolute: true, nodir: true });
  if (execPaths.length === 0) {
    const execInPATH = which.sync(file, { nothrow: true });
    if (execInPATH) return fs.realpathSync(execInPATH);
    const splitPath = os.platform() === 'win32' ? process.env.PATH.split(';') : process.env.PATH.split(':');
    for (const p of splitPath) {
      execPaths = globSync(`${p}/${file}`, { absolute: true, nodir: true });
      if (execPaths.length !== 0) return fs.realpathSync(execPaths[0]);
    }
    return null;
  }
  removeQuarantineFlag(execPaths[0]);
  return execPaths[0];
};

export const basicAuthRegex = /^.*\/\/.*:.*@.*$/i;

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

export enum ScannerTypes {
  SITEMAP = 'Sitemap',
  WEBSITE = 'Website',
  CUSTOM = 'Custom',
  INTELLIGENT = 'Intelligent',
  LOCALFILE = 'LocalFile',
}

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
if (fs.existsSync('/.dockerenv')) {
  launchOptionsArgs = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'];
}

export const sitemapPaths = [
  '/sitemap.xml', '/sitemap/sitemap.xml', '/sitemap-index.xml', '/sitemap_index.xml',
  '/sitemapindex.xml', '/sitemap/index.xml', '/sitemap1.xml', '/sitemap/', '/post-sitemap',
  '/page-sitemap', '/sitemap.txt', '/sitemap.php', '/sitemap.xml.bz2', '/sitemap.xml.xz',
  '/sitemap_index.xml.bz2', '/sitemap_index.xml.xz',
];

export const STATUS_CODE_METADATA: Record<number, string> = {
  0: 'Page Excluded',
  1: 'Not A Supported Document',
  2: 'Web Crawler Errored',
  599: 'Uncommon Response Status Code Received',
  200: 'Unable to scan page due to access restrictions or compatibility issues',
  300: '300 - Multiple Choices', 301: '301 - Moved Permanently', 302: '302 - Found',
  303: '303 - See Other', 304: '304 - Not Modified', 307: '307 - Temporary Redirect',
  308: '308 - Permanent Redirect', 400: '400 - Bad Request', 401: '401 - Unauthorized',
  403: '403 - Forbidden', 404: '404 - Not Found', 405: '405 - Method Not Allowed',
  408: '408 - Request Timeout', 429: '429 - Too Many Requests',
  500: '500 - Internal Server Error', 502: '502 - Bad Gateway',
  503: '503 - Service Unavailable', 504: '504 - Gateway Timeout',
};

export const disallowedListOfPatterns = [
  '#', 'mailto:', 'tel:', 'sms:', 'skype:', 'zoommtg:', 'msteams:', 'whatsapp:',
  'slack:', 'viber:', 'tg:', 'line:', 'meet:', 'facetime:', 'imessage:', 'discord:',
  'sgnl:', 'webex:', 'intent:', 'ms-outlook:', 'ms-onedrive:', 'ms-word:', 'ms-excel:',
  'ms-powerpoint:', 'ms-office:', 'onenote:', 'vs:', 'chrome-extension:', 'chrome-search:',
];

export const disallowedSelectorPatterns = [
  '[href^="mailto:"]', '[href^="tel:"]', '[href^="#"]',
];

export const cssQuerySelectors = [
  ':not(a):is([role="link"]',
  'button[onclick])',
  'a:not([href])',
  '[role="button"]:not(a[href])',
];

export enum BrowserTypes {
  CHROMIUM = 'chromium',
  CHROME = 'chrome',
  EDGE = 'msedge',
}

export enum RuleFlags {
  DEFAULT = 'default',
  DISABLE_OOBEE = 'disable-oobee',
  ENABLE_WCAG_AAA = 'enable-wcag-aaa',
}

const xmlSitemapTypes = {
  xml: 0, xmlIndex: 1, rss: 2, atom: 3, unknown: 4,
};

const forbiddenCharactersInDirPath = ['<', '>', ':', '"', '\\', '/', '|', '?', '*'];

const urlCheckStatuses = {
  success: { code: 0 },
  invalidUrl: { code: 11, message: 'Invalid URL.' },
  cannotBeResolved: { code: 12, message: 'URL cannot be accessed.' },
  errorStatusReceived: { code: 13, message: 'Error status received.' },
  systemError: { code: 14, message: 'System error.' },
  notASitemap: { code: 15, message: 'Invalid sitemap URL format.' },
  unauthorised: { code: 16, message: 'Login required.' },
  browserError: { code: 17, message: 'Incompatible browser.' },
  sslProtocolError: { code: 18, message: 'SSL certificate error.' },
  notALocalFile: { code: 19, message: 'Invalid file format.' },
  notAPdf: { code: 20, message: 'Not a PDF file.' },
  notASupportedDocument: { code: 21, message: 'Unsupported file format.' },
  connectionRefused: { code: 22, message: 'Connection refused.' },
  timedOut: { code: 23, message: 'Request timed out.' },
};

const reserveFileNameKeywords = [
  'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5',
  'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4',
  'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

export default {
  exportDirectory: undefined as string | undefined,
  maxRequestsPerCrawl,
  maxConcurrency: 25,
  urlsCrawledObj,
  launchOptionsArgs,
  xmlSitemapTypes,
  urlCheckStatuses,
  reserveFileNameKeywords,
  launcher: chromium,
  forbiddenCharactersInDirPath,
  robotsTxtUrls: null as Record<string, { disallowedUrls?: string[]; allowedUrls?: string[] }> | null,
  userDataDirectory: null as string | null,
  randomToken: null as string | null,
  resources: {
    crawlers: new Set<PlaywrightCrawler>(),
    browserContexts: new Set<BrowserContext>(),
    browsers: new Set<Browser>(),
  },
};

export const rootPath = dirname;
