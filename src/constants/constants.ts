import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { globSync } from 'glob';
import which from 'which';
import os from 'os';
import { spawnSync, execSync } from 'child_process';
import { chromium } from 'playwright';
import { silentLogger } from '../logs.js';

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

      silentLogger.warn(`Using Chromium support directory at ${defaultChromiumDataDir}`);
    }

    if (defaultChromiumDataDir && fs.existsSync(defaultChromiumDataDir)) {
      return defaultChromiumDataDir;
    }
    return null;
  } catch (error) {
    silentLogger.error(`Error in getDefaultChromiumDataDir(): ${error}`);
  }
};

export const removeQuarantineFlag = function (searchPath: string) {
  if (os.platform() === 'darwin') {
    const execPaths = globSync(searchPath, { absolute: true, nodir: true });
    if (execPaths.length > 0) {
      execPaths.forEach(filePath => spawnSync('xattr', ['-d', 'com.apple.quarantine', filePath]));
    }
  }
};

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
  toScan: string[] = [];
  scanned: { url: string; actualUrl: string; pageTitle: string }[] = [];
  invalid: { url: string; actualUrl: string; pageTitle: string }[] = [];
  scannedRedirects: { fromUrl: string; toUrl: string }[] = [];
  notScannedRedirects: { fromUrl: string; toUrl: string }[] = [];
  outOfDomain: string[] = [];
  blacklisted: { url: string; actualUrl: string; pageTitle: string }[] = [];
  error: { url: string }[] = [];
  exceededRequests: string[] = [];
  forbidden: { url: string; actualUrl: string; pageTitle: string }[] = [];
  userExcluded: { url: string; actualUrl: string; pageTitle: string }[] = [];
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

export const guiInfoStatusTypes = {
  SCANNED: 'scanned',
  SKIPPED: 'skipped',
  COMPLETED: 'completed',
  ERROR: 'error',
  DUPLICATE: 'duplicate',
};

let launchOptionsArgs = [];

// Check if running in docker container
if (fs.existsSync('/.dockerenv')) {
  launchOptionsArgs = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'];
}

export const getProxy = (): { type: string; url: string } | null => {
  if (os.platform() === 'win32') {
    let internetSettings: string[];
    try {
      internetSettings = execSync(
        'Get-ItemProperty -Path "Registry::HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"',
        { shell: 'powershell.exe' },
      )
        .toString()
        .split('\n');
    } catch (e) {
      console.log(e.toString());
      silentLogger.error(e.toString());
    }

    const getSettingValue = (settingName: string) =>
      internetSettings
        .find(s => s.startsWith(settingName))
        // split only once at with ':' as the delimiter
        ?.split(/:(.*)/s)[1]
        ?.trim();

    if (getSettingValue('AutoConfigURL')) {
      return { type: 'autoConfig', url: getSettingValue('AutoConfigURL') };
    }
    if (getSettingValue('ProxyEnable') === '1') {
      return { type: 'manualProxy', url: getSettingValue('ProxyServer') };
    }
    return null;
  }
  // develop for mac
  return null;
};

export const proxy = getProxy();

if (proxy && proxy.type === 'autoConfig') {
  launchOptionsArgs.push(`--proxy-pac-url=${proxy.url}`);
} else if (proxy && proxy.type === 'manualProxy') {
  launchOptionsArgs.push(`--proxy-server=${proxy.url}`);
}

export const impactOrder = {
  minor: 0,
  moderate: 1,
  serious: 2,
  critical: 3,
};

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
  'WCAG 1.3.5': 'https://www.w3.org/TR/WCAG22/#use-of-color',
  'WCAG 1.4.1': 'https://www.w3.org/TR/WCAG22/#use-of-color',
  'WCAG 1.4.2': 'https://www.w3.org/TR/WCAG22/#audio-control',
  'WCAG 1.4.3': 'https://www.w3.org/TR/WCAG22/#contrast-minimum',
  'WCAG 1.4.4': 'https://www.w3.org/TR/WCAG22/#resize-text',
  'WCAG 1.4.6': 'https://www.w3.org/TR/WCAG22/#contrast-enhanced', // AAA
  // 'WCAG 1.4.10': 'https://www.w3.org/TR/WCAG22/#reflow', - TODO: review for veraPDF
  'WCAG 1.4.12': 'https://www.w3.org/TR/WCAG22/#text-spacing',
  'WCAG 2.1.1': 'https://www.w3.org/TR/WCAG22/#pause-stop-hide',
  'WCAG 2.2.1': 'https://www.w3.org/TR/WCAG22/#timing-adjustable',
  'WCAG 2.2.2': 'https://www.w3.org/TR/WCAG22/#pause-stop-hide',
  'WCAG 2.2.4': 'https://www.w3.org/TR/WCAG22/#interruptions', // AAA
  'WCAG 2.4.1': 'https://www.w3.org/TR/WCAG22/#bypass-blocks',
  'WCAG 2.4.2': 'https://www.w3.org/TR/WCAG22/#page-titled',
  'WCAG 2.4.4': 'https://www.w3.org/TR/WCAG22/#link-purpose-in-context',
  'WCAG 2.4.9': 'https://www.w3.org/TR/WCAG22/#link-purpose-link-only', // AAA
  'WCAG 2.5.8': 'https://www.w3.org/TR/WCAG22/#target-size-minimum',
  'WCAG 3.1.1': 'https://www.w3.org/TR/WCAG22/#language-of-page',
  'WCAG 3.1.2': 'https://www.w3.org/TR/WCAG22/#labels-or-instructions',
  'WCAG 3.1.5': 'https://www.w3.org/TR/WCAG22/#reading-level', // AAA
  'WCAG 3.2.5': 'https://www.w3.org/TR/WCAG22/#change-on-request', // AAA
  'WCAG 3.3.2': 'https://www.w3.org/TR/WCAG22/#labels-or-instructions',
  'WCAG 4.1.2': 'https://www.w3.org/TR/WCAG22/#name-role-value',
};

const urlCheckStatuses = {
  success: { code: 0 },
  invalidUrl: { code: 11, message: 'Invalid URL or URL is not using http or https.' },
  cannotBeResolved: {
    code: 12,
    message:
      'Provided URL cannot be accessed. Please verify your internet connectivity and the correctness of the domain.',
  },
  errorStatusReceived: {
    // unused for now
    code: 13,
    message: 'Provided URL cannot be accessed. Server responded with code ', // append it with the response code received,
  },
  systemError: {
    code: 14,
    message: 'Something went wrong when verifying the URL. Please try again later.',
  },
  notASitemap: { code: 15, message: 'Provided URL is not a sitemap.' },
  unauthorised: { code: 16, message: 'Provided URL needs basic authorisation.' },
  browserError: {
    code: 17,
    message:
      'No browser available to run scans. Please ensure you have Chrome or Edge (for Windows only) installed.',
  },
  axiosTimeout: { code: 18, message: 'Axios timeout exceeded. Falling back on browser checks.' },
  notALocalFile: { code: 19, message: 'Provided filepath is not a local html or sitemap file.' },
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
  exportDirectory: `${process.cwd()}`,
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
