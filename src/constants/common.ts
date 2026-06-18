/* eslint-disable consistent-return */
/* eslint-disable no-console */
/* eslint-disable camelcase */
/* eslint-disable no-use-before-define */
import validator from 'validator';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import * as cheerio from 'cheerio';
import crawlee, { EnqueueStrategy, Request } from 'crawlee';
import { parseString } from 'xml2js';
import fs from 'fs';
import path from 'path';
import url, { fileURLToPath, pathToFileURL } from 'url';
import safe from 'safe-regex';
import * as https from 'https';
import os from 'os';
import mime from 'mime';
import { minimatch } from 'minimatch';
import { globSync, GlobOptionsWithFileTypesFalse } from 'glob';
import { LaunchOptions, Locator, Page, devices, webkit } from 'playwright';
import printMessage from 'print-message';
import constants, {
  getDefaultChromeDataDir,
  getDefaultEdgeDataDir,
  getDefaultChromiumDataDir,
  // Legacy code start - Google Sheets submission
  formDataFields,
  // Legacy code end - Google Sheets submission
  ScannerTypes,
  BrowserTypes,
  FileTypes,
  getEnumKey,
} from './constants.js';
import { consoleLogger } from '../logs.js';
import { isUrlPdf } from '../crawlers/commonCrawlerFunc.js';
import { cleanUpAndExit, isFollowStrategy, randomThreeDigitNumberString, register } from '../utils.js';
import { Answers, Data } from '../index.js';
import { DeviceDescriptor } from '../types/types.js';
import { getProxyInfo, proxyInfoToResolution, ProxySettings } from '../proxyService.js';

// validateDirPath validates a provided directory path
// returns null if no error
export const validateDirPath = (dirPath: string): string => {
  if (typeof dirPath !== 'string') {
    return 'Please provide string value of directory path.';
  }

  try {
    fs.accessSync(dirPath);
    if (!fs.statSync(dirPath).isDirectory()) {
      return 'Please provide a directory path.';
    }

    return null;
  } catch {
    return 'Please ensure path provided exists.';
  }
};

export class RES {
  status: number;
  httpStatus?: number;
  url: string;
  content: string;
  constructor(res?: Partial<RES>) {
    if (res) {
      Object.assign(this, res);
    }
  }
}

export const validateCustomFlowLabel = (customFlowLabel: string) => {
  const containsReserveWithDot = constants.reserveFileNameKeywords.some(char =>
    customFlowLabel.toLowerCase().includes(`${char.toLowerCase()}.`),
  );
  const containsForbiddenCharacters = constants.forbiddenCharactersInDirPath.some(char =>
    customFlowLabel.includes(char),
  );
  const exceedsMaxLength = customFlowLabel.length > 80;

  if (containsForbiddenCharacters) {
    const displayForbiddenCharacters = constants.forbiddenCharactersInDirPath
      .toString()
      .replaceAll(',', ' , ');
    return {
      isValid: false,
      errorMessage: `Invalid label. Cannot contain ${displayForbiddenCharacters}`,
    };
  }
  if (exceedsMaxLength) {
    return { isValid: false, errorMessage: `Invalid label. Cannot exceed 80 characters.` };
  }
  if (containsReserveWithDot) {
    const displayReserveKeywords = constants.reserveFileNameKeywords
      .toString()
      .replaceAll(',', ' , ');
    return {
      isValid: false,
      errorMessage: `Invalid label. Cannot have '.' appended to ${displayReserveKeywords} as they are reserved keywords.`,
    };
  }
  return { isValid: true };
};

// validateFilePath validates a provided file path
// returns null if no error
export const validateFilePath = (filePath: string, cliDir: string) => {
  if (typeof filePath !== 'string') {
    throw new Error('Please provide string value of file path.');
  }

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cliDir, filePath);
  try {
    fs.accessSync(absolutePath);
    if (!fs.statSync(absolutePath).isFile()) {
      throw new Error('Please provide a file path.');
    }

    if (path.extname(absolutePath) !== '.txt') {
      throw new Error('Please provide a file with txt extension.');
    }

    return absolutePath;
  } catch {
    throw new Error(`Please ensure path provided exists and writable: ${absolutePath}`);
  }
};

export const getBlackListedPatterns = (
  blacklistedPatternsFilename: string | null,
): string[] | null => {
  let exclusionsFile = null;
  if (blacklistedPatternsFilename) {
    exclusionsFile = blacklistedPatternsFilename;
  } else if (fs.existsSync('exclusions.txt')) {
    exclusionsFile = 'exclusions.txt';
  }

  if (!exclusionsFile) {
    return null;
  }

  const rawPatterns = fs.readFileSync(exclusionsFile).toString();
  const blacklistedPatterns = rawPatterns
    .split('\n')
    .map(p => p.trim())
    .filter(p => p !== '');

  const unsafe = blacklistedPatterns.filter(pattern => !safe(pattern));
  if (unsafe.length > 0) {
    const unsafeExpressionsError = `Unsafe expressions detected: ${unsafe} Please revise ${exclusionsFile}`;
    throw new Error(unsafeExpressionsError);
  }

  return blacklistedPatterns;
};

export const isBlacklistedFileExtensions = (url: string, blacklistedFileExtensions: string[]) => {
  const urlExtension = url.split('.').pop();
  return blacklistedFileExtensions.includes(urlExtension);
};

const document = new JSDOM('').window;

const httpsAgent = new https.Agent({
  // Run in environments with custom certificates
  rejectUnauthorized: false,
  keepAlive: true,
});

export const messageOptions = {
  border: false,
  marginTop: 2,
  marginBottom: 2,
};

const urlOptions = {
  // http and https for normal scans, file for local file scan
  protocols: ['http', 'https', 'file'],
  require_protocol: true,
  require_tld: false,
  require_host: false,
  // being explicit; fragments/queries are fine for local files
  allow_fragments: true,
  allow_query_components: true,
};

const queryCheck = (s: string) => document.createDocumentFragment().querySelector(s);
export const isSelectorValid = (selector: string): boolean => {
  try {
    queryCheck(selector);
  } catch {
    return false;
  }
  return true;
};

// Don't sanitise for now as we have changed the logic for URL validation / local file scan
// Only use this when we find characters to validate against
const blackListCharacters = '';

export const validateXML = (content: string): { isValid: boolean; parsedContent: string } => {
  let isValid: boolean;
  let parsedContent: string;
  parseString(content, (_err, result) => {
    if (result) {
      isValid = true;
      parsedContent = result;
    } else {
      isValid = false;
    }
  });
  return { isValid, parsedContent };
};

export const validateTXT = (content: string): { isValid: boolean } => {
  // Strip HTML tags first — browsers wrap .txt files in HTML when fetched via Playwright
  const plainText = content.replace(/<[^>]+>/g, '\n');
  const lines = plainText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  // Allow http, https and relative paths (starting with /) for txt sitemaps, as some sitemaps use relative paths and some txt sitemaps are fetched as HTML by Playwright
  const urlPattern = /^(https?:\/\/|\/)[^\s]+$/i;
  return { isValid: lines.some(line => urlPattern.test(line)) };
};

export const isSkippedUrl = (pageUrl: string, whitelistedDomains: string[]) => {
  const matched =
    whitelistedDomains.filter(p => {
      const pattern = p.replace(/[\n\r]+/g, '');

      // is url
      if (pattern.startsWith('http') && pattern === pageUrl) {
        return true;
      }

      // is regex (default)
      return new RegExp(pattern).test(pageUrl);
    }).length > 0;

  return matched;
};

export const getFileSitemap = (filePath: string): string | null => {
  if (filePath.startsWith('file:///')) {
    if (os.platform() === 'win32') {
      filePath = filePath.match(/^file:\/\/\/([A-Z]:\/[^?#]+)/)?.[1];
    } else {
      filePath = filePath.match(/^file:\/\/(\/[^?#]+)/)?.[1];
    }
  }

  filePath = convertToFilePath(filePath);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const file = fs.readFileSync(filePath, 'utf8');
  const isLocalFileScan = isSitemapContent(file);
  return isLocalFileScan || file !== undefined ? filePath : null;
};

export const getUrlMessage = (scanner: ScannerTypes): string => {
  switch (scanner) {
    case ScannerTypes.WEBSITE:
    case ScannerTypes.CUSTOM:
    case ScannerTypes.INTELLIGENT:
      return 'Please enter URL of website: ';
    case ScannerTypes.SITEMAP:
      return 'Please enter URL or file path to sitemap, or drag and drop a sitemap file here: ';
    case ScannerTypes.LOCALFILE:
      return 'Please enter file path: ';
    default:
      return 'Invalid option';
  }
};

export const isInputValid = (inputString: string): boolean => {
  if (!validator.isEmpty(inputString)) {
    const removeBlackListCharacters = validator.escape(inputString);

    if (validator.isAscii(removeBlackListCharacters)) {
      return true;
    }
  }

  return false;
};

export const sanitizeUrlInput = (url: string): { isValid: boolean; url: string } => {
  // Sanitize that there is no blacklist characters
  const sanitizeUrl = validator.blacklist(url, blackListCharacters);
  if (url.toLowerCase().startsWith('file://') || validator.isURL(sanitizeUrl, urlOptions)) {
    return { isValid: true, url: sanitizeUrl };
  }
  return { isValid: false, url: sanitizeUrl };
};

const isAllowedContentType = (ct: string): boolean => {
  const c = (ct || '').toLowerCase();
  return (
    c.startsWith('text/html') || // html
    c.startsWith('application/xhtml+xml') || // xhtml
    c.startsWith('text/plain') || // txt
    c.startsWith('application/xml') || // xml
    c.startsWith('text/xml') || // xml (alt)
    c.startsWith('application/pdf') // pdf
  );
};

const checkUrlConnectivityWithBrowser = async (
  url: string,
  browserToRun: string,
  clonedDataDir: string,
  playwrightDeviceDetailsObject: DeviceDescriptor,
  extraHTTPHeaders: Record<string, string>,
) => {
  const res = new RES();

  const data = sanitizeUrlInput(url);
  if (!data.isValid) {
    res.status = constants.urlCheckStatuses.invalidUrl.code;
    return res;
  }

  // STEP 1: For local file scans
  let contentType = '';
  const protocol = new URL(url).protocol;

  if (protocol !== 'http:' && protocol !== 'https:') {
    try {
      const filePath = fileURLToPath(url);
      const stat = fs.statSync(filePath);

      if (!stat.isFile()) {
        res.status = constants.urlCheckStatuses.notALocalFile.code;
        return res;
      }

      const statusCode = 200;
      contentType = mime.getType(filePath) || 'application/octet-stream';

      if (!isAllowedContentType(contentType)) {
        res.status = constants.urlCheckStatuses.notASupportedDocument.code;
        return res;
      }

      // Short-circuit for pdfs
      if (contentType.includes('pdf')) {
        res.status = constants.urlCheckStatuses.success.code;
        res.httpStatus = statusCode;
        res.url = url;
        res.content = '%PDF-'; // Avoid putting the binary in memory
        return res;
      }
    } catch (e) {
      consoleLogger.info(`Local file check failed: ${e.message}`);
      res.status = constants.urlCheckStatuses.systemError.code;
      return res;
    }
  }

  // Ensure Accept header for non-html content fallback — use a local copy to avoid
  // mutating the caller's extraHTTPHeaders object (which is later checked by crawlers
  // to decide whether to enable preNavigationHooks header rewriting).
  const localHeaders = { ...extraHTTPHeaders };
  localHeaders.Accept ||= 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  await initModifiedUserAgent(browserToRun, playwrightDeviceDetailsObject, clonedDataDir);

  let browserContext;
  let browserInstance;

  const rawDevice = (playwrightDeviceDetailsObject || {}) as Record<string, unknown>;
  const {
    viewport,
    isMobile,
    hasTouch,
    userAgent: deviceUserAgent,
    ...restDevice
  } = rawDevice;

  const launchOptions = getPlaywrightLaunchOptions(browserToRun);
  
  const { Authorization, ...nonAuthHeaders } = localHeaders || {};
  let httpCredentials = undefined;
  if (Authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(Authorization.slice(6), 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    if (colonIdx > 0) {
      httpCredentials = { username: decoded.slice(0, colonIdx), password: decoded.slice(colonIdx + 1) };
    }
  }

  const contextOptions: Record<string, unknown> = {
    ...restDevice,
    ...(Object.keys(nonAuthHeaders).length > 0 && { extraHTTPHeaders: nonAuthHeaders }),
    ...(httpCredentials && { httpCredentials }),
    ignoreHTTPSErrors: true,
    ...(process.env.OOBEE_DISABLE_BROWSER_DOWNLOAD && { acceptDownloads: false }),
  };

  // Keep UA emulation explicitly.
  contextOptions.userAgent = process.env.OOBEE_USER_AGENT || (deviceUserAgent as string | undefined);

  try {
    const launchPersistent = async () => {
      browserContext = await constants.launcher.launchPersistentContext(clonedDataDir, {
        ...launchOptions,
        ...contextOptions,
      });
      register(browserContext);
    };

    const launchEphemeral = async () => {
      browserInstance = await constants.launcher.launch(launchOptions);
      register(browserInstance as unknown as { close: () => Promise<void> });
      browserContext = await browserInstance.newContext(contextOptions);
    };

    if (process.env.CRAWLEE_HEADLESS === '1') {
      try {
        await launchPersistent();
      } catch (error) {
        // Fallback to ephemeral context if persistent context fails (e.g. protocol errors)
        // More prone to falling back here when running localFile scans
        consoleLogger.warn(`Persistent context launch failed, retrying with ephemeral context: ${error.message}`);
        await launchEphemeral();
      }
    } else {
      await launchEphemeral();
    }
  } catch (err) {
    printMessage([`Unable to launch browser\n${err}`], messageOptions);
    res.status = constants.urlCheckStatuses.browserError.code;
    return res;
  }

  try {
    // Only enable generic Authorization header routing interception broadly if 
    // a non-Basic Bearer auth string is heavily relied upon, thereby bypassing 
    // performance warnings inside the check checkUrl phase for typical public scans
    if (Object.keys(localHeaders).length > 0) {
      if (Authorization && !httpCredentials) {
        const entryOrigin = new URL(url).origin;
        await browserContext.route('**/*', async (route: any, request: any) => {
          try {
            if (new URL(request.url()).origin === entryOrigin) {
              await route.continue({ headers: { ...request.headers(), Authorization } });
            } else {
              await route.continue();
            }
          } catch {
            await route.continue();
          }
        });
      }
    }

    const page = await browserContext.newPage();

    // Block native Chrome download UI
    try {
      const cdp = await browserContext.newCDPSession(page as any);
      await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' });
    } catch (e) {
      consoleLogger.info(`Unable to set download deny: ${(e as Error).message}`);
    }

    // STEP 2: Navigate (follows server-side redirects)
    page.once('download', () => {
      res.status = constants.urlCheckStatuses.notASupportedDocument.code;
      return res;
    });
    
    // OPTIMIZATION: Wait for 'domcontentloaded' only
    const response = await page.goto(url, {
      timeout: 15000,
      waitUntil: 'domcontentloaded', // enough to get status + allow potential client redirects to kick in
    });

    if (!response) throw new Error('No response from navigation');

    // Wait briefly for JS/meta-refresh redirects to settle before reading the final URL.
    // Server-side redirects are already reflected after goto(), but client-side redirects
    // (e.g. domain.tld -> www.domain.tld via JS or meta-refresh) need extra time.
    try {
      await Promise.race([
        page.waitForURL(currentUrl => currentUrl !== url, { timeout: 5000 }),
        new Promise(resolve => setTimeout(resolve, 1000)), // minimum settle time
      ]);
    } catch {
      // No redirect happened within the window — that's fine, continue with current URL
    }

    // Re-read page.url() AFTER potential client-side redirects have resolved
    const finalUrl = page.url();
    const finalStatus = response.status();
    const headers = response.headers();
    contentType = headers['content-type'] || '';

    if (!isAllowedContentType(contentType)) {
      res.status = constants.urlCheckStatuses.notASupportedDocument.code;
      return res;
    }

    res.httpStatus = finalStatus;
    res.url = finalUrl;

    if (finalStatus === 401) {
      res.status = constants.urlCheckStatuses.unauthorised.code;
    } else if (finalStatus >= 200 && finalStatus < 400) {
      res.status = constants.urlCheckStatuses.success.code;
    } else if (finalStatus === 405 || finalStatus === 501) {
      // Some origins 405/501 but the browser-rendered page is still reachable after client redirects.
      // As a last resort, consider DOM presence as success if we actually have a document.
      const hasDOM = await page.evaluate(() => !!document && !!document.documentElement);
      res.status = hasDOM
        ? constants.urlCheckStatuses.success.code
        : constants.urlCheckStatuses.systemError.code;
    } else {
      res.status = constants.urlCheckStatuses.systemError.code;
    }

    // Content handling
    if (contentType.includes('pdf') || contentType.includes('octet-stream')) {
      res.content = '%PDF-'; // avoid binary in memory / download
    } else {
      try {
        // Try to get a stable DOM; don't fail the check if it times out
        // Note: Since we used 'domcontentloaded' in goto, this is fast, but kept for safety/stability
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      } catch {}
      res.content = await page.content();
    }
  } catch (error) {
    if (error.message.includes('net::ERR_INVALID_AUTH_CREDENTIALS')) {
      res.status = constants.urlCheckStatuses.unauthorised.code;
    } else if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
      res.status = constants.urlCheckStatuses.cannotBeResolved.code;
    } else if (error.message.includes('net::ERR_CONNECTION_REFUSED')) {
      res.status = constants.urlCheckStatuses.connectionRefused.code;
    } else if (error.message.includes('net::ERR_TIMED_OUT')) {
      res.status = constants.urlCheckStatuses.timedOut.code;
    } else if (error.message.includes('net::ERR_SSL_PROTOCOL_ERROR')) {
      res.status = constants.urlCheckStatuses.sslProtocolError.code;
    } else {
      consoleLogger.error(error);
      res.status = constants.urlCheckStatuses.systemError.code;
    }
  } finally {
    await browserContext?.close();
    if (browserInstance) {
      await browserInstance.close();
    }
  }

  return res;
};

export const isPdfContent = (content: Buffer | string): boolean => {
  let header: string;
  if (Buffer.isBuffer(content)) {
    header = content.toString('utf8', 0, 5);
  } else {
    header = content.substring(0, 5);
  }
  return header === '%PDF-';
};

export const isSitemapContent = (content: string) => {
  const { isValid } = validateXML(content);
  if (isValid) {
    return true;
  }

  const regexForHtml = new RegExp('<(?:!doctype html|html|head|body)+?>', 'gmi');
  const regexForXmlSitemap = new RegExp('<(?:urlset|sitemapindex|feed|rss)+?.*>', 'gmi');
  if (content.match(regexForHtml) && content.match(regexForXmlSitemap)) {
    // is an XML sitemap wrapped in a HTML document
    return true;
  }
  const { isValid: isTxtSitemap } = validateTXT(content);
  if (isTxtSitemap) {
    // treat this as a txt sitemap (plain text or browser-wrapped with HTML)
    return true;
  }
  // is HTML webpage
  return false;
};

export const checkUrl = async (
  scanner: ScannerTypes,
  url: string,
  browser: string,
  clonedDataDir: string,
  playwrightDeviceDetailsObject: DeviceDescriptor,
  extraHTTPHeaders: Record<string, string>,
  fileTypes: FileTypes,
) => {
  let urlToCheck = url;

  if (scanner === ScannerTypes.LOCALFILE) {
    if (!isFilePath(url)) {
      const res = new RES();
      res.status = constants.urlCheckStatuses.notALocalFile.code;
      return res;
    }

    if (!url.toLowerCase().startsWith('file://')) {
      urlToCheck = pathToFileURL(path.resolve(url)).toString();
    }
  }

  const res = await checkUrlConnectivityWithBrowser(
    urlToCheck,
    browser,
    clonedDataDir,
    playwrightDeviceDetailsObject,
    extraHTTPHeaders,
  );

  // If response is 200 (meaning no other code was set earlier)
  if (res.status === constants.urlCheckStatuses.success.code) {
    // Check if document is pdf type
    const isPdf = isPdfContent(res.content);

    // Check if only HTML document is allowed to be scanned
    if (fileTypes === FileTypes.HtmlOnly && isPdf) {
      res.status = constants.urlCheckStatuses.notASupportedDocument.code;

      // Check if only PDF document is allowed to be scanned
    } else if (fileTypes === FileTypes.PdfOnly && !isPdf) {
      res.status = constants.urlCheckStatuses.notAPdf.code;

      // Check if sitemap is expected
    } else if (scanner === ScannerTypes.SITEMAP) {
      const isSitemap = isSitemapContent(res.content);

      if (!isSitemap) {
        res.status = constants.urlCheckStatuses.notASitemap.code;
      }
    }

    // else proceed as normal
  }

  return res;
};

const isEmptyObject = (obj: object): boolean => !Object.keys(obj).length;

export const parseHeaders = (header?: string): Record<string, string> => {
  // parse HTTP headers from string
  if (!header) return {};
  const headerValues = header.split(', ');
  const allHeaders: Record<string, string> = {};
  headerValues.map((headerValue: string) => {
    const headerValuePair = headerValue.split(/ (.*)/s);
    if (headerValuePair.length < 2) {
      printMessage(
        [
          `Invalid value for authorisation request header. Please provide valid keywords in the format: "<header> <value>". For multiple authentication headers, please provide the keywords in the format:  "<header> <value>, <header2> <value2>, ..." .`,
        ],
        messageOptions,
      );
      cleanUpAndExit(1);
    }
    allHeaders[headerValuePair[0]] = headerValuePair[1]; // {"header": "value", "header2": "value2", ...}
  });
  return allHeaders;
};

export const prepareData = async (argv: Answers): Promise<Data> => {
  if (isEmptyObject(argv)) {
    throw Error('No inputs should be provided');
  }
  let {
    scanner,
    headless,
    url,
    deviceChosen,
    customDevice,
    viewportWidth,
    maxpages,
    strategy,
    isLocalFileScan = argv.scanner === ScannerTypes.LOCALFILE,
    browserToRun,
    nameEmail,
    customFlowLabel,
    specifiedMaxConcurrency,
    fileTypes,
    blacklistedPatternsFilename,
    additional,
    metadata,
    followRobots,
    header,
    safeMode,
    exportDirectory,
    zip,
    ruleset,
    generateJsonFiles,
    scanDuration,
    finalUrl,
  } = argv;

  const extraHTTPHeaders = parseHeaders(header);

  // Set default username and password for basic auth
  let username = '';
  let password = '';

  // If a file path is provided
  if (isFilePath(url)) {
    // Set is as local file scan if not already so
    isLocalFileScan = true;

    // Convert to absolute path
    url = path.resolve(url);

    // Convert to file:// URL
    url = convertPathToLocalFile(url);
  } else {
    // Check URL for basic auth embedded and move it to extraHTTPHeaders
    const temp = new URL(url);
    username = temp.username;
    password = temp.password;

    if (username !== '' || password !== '') {
      extraHTTPHeaders.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    temp.username = '';
    temp.password = '';
    url = temp.toString();
  }

  // Keep browser-resolved URL (if provided by pre-check flow) as canonical entry URL.
  // For local file paths, keep using the normalized `url` value below.
  const resolvedEntryUrl = finalUrl && !isFilePath(finalUrl) ? finalUrl : url;

  // construct filename for scan results
  const [date, time] = new Date().toLocaleString('sv').replaceAll(/-|:/g, '').split(' ');
  const domain = isLocalFileScan ? path.basename(url) : new URL(url).hostname;

  const sanitisedLabel = customFlowLabel ? `_${customFlowLabel.replaceAll(' ', '_')}` : '';
  let resultFilename: string;
  const randomThreeDigitNumber = randomThreeDigitNumberString();
  resultFilename = `${date}_${time}${sanitisedLabel}_${domain}_${randomThreeDigitNumber}`;

  // Set exported directory
  if (exportDirectory) {
    constants.exportDirectory = path.join(exportDirectory, resultFilename);
  }

  // Creating the playwrightDeviceDetailObject
  deviceChosen =
    customDevice === 'Desktop' || customDevice === 'Mobile' ? customDevice : deviceChosen;

  const playwrightDeviceDetailsObject = getPlaywrightDeviceDetailsObject(
    deviceChosen,
    customDevice,
    viewportWidth,
  );

  const { browserToRun: resolvedBrowser, clonedBrowserDataDir } = getBrowserToRun(
    resultFilename,
    browserToRun,
    true,
  );
  browserToRun = resolvedBrowser;

  const resolvedUserDataDirectory = getClonedProfilesWithRandomToken(browserToRun, resultFilename);

  if (followRobots) {
    constants.robotsTxtUrls = {};
    await getUrlsFromRobotsTxt(url, browserToRun, resolvedUserDataDirectory, extraHTTPHeaders);
  }

  constants.userDataDirectory = resolvedUserDataDirectory;
  constants.randomToken = resultFilename;

  return {
    type: scanner,
    url,
    entryUrl: resolvedEntryUrl,
    isHeadless: headless,
    deviceChosen,
    customDevice,
    viewportWidth,
    playwrightDeviceDetailsObject,
    maxRequestsPerCrawl: maxpages || constants.maxRequestsPerCrawl,
    strategy:
      strategy === 'same-hostname' ? EnqueueStrategy.SameHostname
      : strategy === 'ignore' ? EnqueueStrategy.All
      : EnqueueStrategy.SameDomain,
    isLocalFileScan,
    browser: browserToRun,
    nameEmail,
    customFlowLabel,
    specifiedMaxConcurrency,
    randomToken: resultFilename,
    fileTypes: FileTypes[getEnumKey(FileTypes, fileTypes) as keyof typeof FileTypes],
    blacklistedPatternsFilename,
    includeScreenshots: !(additional === 'none'),
    metadata,
    followRobots,
    extraHTTPHeaders,
    safeMode,
    userDataDirectory: resolvedUserDataDirectory,
    zip,
    ruleset,
    generateJsonFiles,
    scanDuration,
  };
};

export const getUrlsFromRobotsTxt = async (
  url: string,
  browserToRun: string,
  userDataDirectory: string,
  extraHTTPHeaders: Record<string, string>,
): Promise<void> => {
  if (!constants.robotsTxtUrls) return;

  const domain = new URL(url).origin;
  if (constants.robotsTxtUrls[domain]) return;
  const robotsUrl = domain.concat('/robots.txt');

  let robotsTxt: string;
  try {
    robotsTxt = await getRobotsTxtViaPlaywright(
      robotsUrl,
      browserToRun,
      userDataDirectory,
      extraHTTPHeaders,
    );
    consoleLogger.info(`Fetched robots.txt from ${robotsUrl}`);
  } catch (e) {
    // if robots.txt is not found, do nothing
    consoleLogger.info(`Unable to fetch robots.txt from ${robotsUrl}`);
  }

  if (!robotsTxt) {
    constants.robotsTxtUrls[domain] = {};
    return;
  }

  const lines = robotsTxt.split(/\r?\n/);
  let shouldCapture = false;
  const disallowedUrls = [];
  const allowedUrls = [];

  // Returns 1–2 minimatch glob patterns for a single robots.txt path pattern.
  // Two patterns are returned for bare paths (no trailing wildcard) so that
  // both the exact URL and all child paths are blocked, matching robots.txt
  // prefix semantics.
  const sanitisePattern = (pattern: string): string[] => {
    const directoryRegex = /^\/(?:[^?#/]+\/)*[^?#]*$/;
    const subdirWildcardRegex = /\/\*\//g;
    const filePathRegex = /^\/(?:[^\/]+\/)*[^\/]+\.[a-zA-Z0-9]{1,6}$/;

    if (subdirWildcardRegex.test(pattern)) {
      pattern = pattern.replace(subdirWildcardRegex, '/**/');
    }

    // Query-string patterns (e.g. /faq?faqItem= or /faq/?faq&faqItem=):
    // '?' is the query separator in robots.txt but a single-char wildcard in
    // minimatch. Escape it to a literal match and append '*' so any query
    // value after the stated prefix is also blocked.
    if (pattern.includes('?')) {
      return [domain + pattern.replace('?', '\\?') + '*'];
    }

    if (pattern.match(directoryRegex) && !pattern.match(filePathRegex)) {
      if (pattern.endsWith('*')) {
        // e.g. /ebook/* → /ebook/** (already covers all children)
        return [domain + pattern.concat('*')];
      } else {
        // Bare path (e.g. /subscription/unsubscribe): robots.txt blocks the
        // exact URL *and* every descendant. minimatch's '/**' glob does not
        // match the bare path itself (no trailing slash), so we emit both the
        // exact-path pattern and a children glob.
        const base = domain + pattern;
        const children = domain + (pattern.endsWith('/') ? pattern : pattern + '/') + '**';
        return [base, children];
      }
    }
    return [domain + pattern];
  };

  for (const line of lines) {
    if (line.toLowerCase().startsWith('user-agent: *')) {
      shouldCapture = true;
    } else if (line.toLowerCase().startsWith('user-agent:') && shouldCapture) {
      break;
    } else if (shouldCapture && line.toLowerCase().startsWith('disallow:')) {
      let disallowed = line.substring('disallow: '.length).trim();
      if (disallowed) {
        disallowedUrls.push(...sanitisePattern(disallowed));
      }
    } else if (shouldCapture && line.toLowerCase().startsWith('allow:')) {
      let allowed = line.substring('allow: '.length).trim();
      if (allowed) {
        allowedUrls.push(...sanitisePattern(allowed));
      }
    }
  }
  constants.robotsTxtUrls[domain] = { disallowedUrls, allowedUrls };
};

const getRobotsTxtViaPlaywright = async (
  robotsUrl: string,
  browser: string,
  userDataDirectory: string,
  extraHTTPHeaders: Record<string, string>,
): Promise<string> => {
  let robotsDataDir = '';
  let browserContext;
  let browserInstance;

  // Bug in Chrome which causes browser pool crash when userDataDirectory is set in non-headless mode
  if (process.env.CRAWLEE_HEADLESS === '1') {
    // Create robots own user data directory else SingletonLock: File exists (17) with crawlDomain or crawlSitemap's own browser
    robotsDataDir = path.join(userDataDirectory, 'robots');
    if (!fs.existsSync(robotsDataDir)) {
      fs.mkdirSync(robotsDataDir, { recursive: true });
    }
  }

  try {
    if (process.env.CRAWLEE_HEADLESS === '1') {
      browserContext = await constants.launcher.launchPersistentContext(robotsDataDir, {
        ...getPlaywrightLaunchOptions(browser),
        ...(extraHTTPHeaders && { extraHTTPHeaders }),
        ...(process.env.OOBEE_USER_AGENT && { userAgent: process.env.OOBEE_USER_AGENT }),
      });
      register(browserContext);
    } else {
      // In headful mode, avoid launchPersistentContext with custom user data dir to prevent "Browser window not found"
      const launchOptions = getPlaywrightLaunchOptions(browser);
      browserInstance = await constants.launcher.launch(launchOptions);
      register(browserInstance as unknown as { close: () => Promise<void> });

      browserContext = await browserInstance.newContext({
        ...(extraHTTPHeaders && { extraHTTPHeaders }),
        ...(process.env.OOBEE_USER_AGENT && { userAgent: process.env.OOBEE_USER_AGENT }),
      });
    }

    const page = await browserContext.newPage();

    await page.goto(robotsUrl, { waitUntil: 'networkidle', timeout: 30000 });
    const robotsTxt: string | null = await page.evaluate(() => document.body.textContent);
    return robotsTxt;
  } catch (e) {
    consoleLogger.error(`Error fetching robots.txt: ${(e as Error).message}`);
    throw e;
  } finally {
    await browserContext?.close();
    if (browserInstance) {
      await browserInstance.close();
    }
  }
};

export const getSitemapsFromRobotsTxt = async (
  url: string,
  browser: string,
  userDataDirectory: string,
  extraHTTPHeaders: Record<string, string>,
): Promise<string[]> => {
  const domain = new URL(url).origin;
  const robotsUrl = domain.concat('/robots.txt');

  let robotsTxt: string;
  try {
    robotsTxt = await getRobotsTxtViaPlaywright(robotsUrl, browser, userDataDirectory, extraHTTPHeaders);
  } catch (e) {
    consoleLogger.info(`Unable to fetch robots.txt from ${robotsUrl} for sitemap discovery`);
    return [];
  }

  if (!robotsTxt) return [];

  const sitemaps: string[] = [];
  const lines = robotsTxt.split(/\r?\n/);
  for (const line of lines) {
    if (line.toLowerCase().startsWith('sitemap:')) {
      const sitemapUrl = line.substring('sitemap:'.length).trim();
      if (sitemapUrl) {
        sitemaps.push(sitemapUrl);
      }
    }
  }
  return sitemaps;
};

export const isDisallowedInRobotsTxt = (url: string): boolean => {
  if (!constants.robotsTxtUrls) return;

  const domain = new URL(url).origin;
  if (constants.robotsTxtUrls[domain]) {
    const { disallowedUrls, allowedUrls } = constants.robotsTxtUrls[domain];

    const isDisallowed =
      disallowedUrls.filter((disallowedUrl: string) => {
        const disallowed = minimatch(url, disallowedUrl);
        return disallowed;
      }).length > 0;

    const isAllowed =
      allowedUrls.filter((allowedUrl: string) => {
        const allowed = minimatch(url, allowedUrl);
        return allowed;
      }).length > 0;

    return isDisallowed && !isAllowed;
  }
  return false;
};

export const getLinksFromSitemap = async (
  sitemapUrl: string,
  _maxLinksCount: number,
  browser: string,
  userDataDirectory: string,
  userUrlInput: string,
  isIntelligent: boolean,
  extraHTTPHeaders: Record<string, string>,
  strategy: EnqueueStrategy = EnqueueStrategy.All,
  userUrl: string = userUrlInput,
) => {
  const scannedSitemaps = new Set<string>();
  const sitemapLinkCounts: Record<string, number> = {};
  const allUrls = new Set<string>(); // all discovered URLs (lightweight strings)
  const isImageSitemapUrl = (candidateUrl: string) =>
    /(^|\/)image-sitemap(?:-index)?(?:-\d+)?\.xml(?:$|[?#])/i.test(candidateUrl);

  const addToUrlList = (url: string) => {
    if (!url) return;
    if (isDisallowedInRobotsTxt(url)) return;
    if (!isFilePath(userUrl) && !isFollowStrategy(url, userUrl, strategy)) return;

    url = convertPathToLocalFile(url);
    allUrls.add(url);
  };

  const calculateCloseness = (sitemapUrl: string) => {
    // Remove 'http://', 'https://', and 'www.' prefixes from the URLs
    const normalizedSitemapUrl = sitemapUrl.replace(/^(https?:\/\/)?(www\.)?/, '');
    const normalizedUserUrlInput = userUrlInput
      .replace(/^(https?:\/\/)?(www\.)?/, '')
      .replace(/\/$/, ''); // Remove trailing slash also

    if (normalizedSitemapUrl == normalizedUserUrlInput) {
      return 2;
    }
    if (normalizedSitemapUrl.startsWith(normalizedUserUrlInput)) {
      return 1;
    }
    return 0;
  };
  const processXmlSitemap = async (
    $: cheerio.CheerioAPI,
    sitemapType: number,
    linkSelector: string,
    dateSelector: string,
    sectionSelector: string,
  ) => {
    const urlList: { url: string; lastModifiedDate: Date }[] = [];
    // Iterate through each URL element in the sitemap, collect url and modified date
    $(sectionSelector).each((_index, urlElement) => {
      let url;
      if (sitemapType === constants.xmlSitemapTypes.atom) {
        url = $(urlElement).find(linkSelector).prop('href');
      } else {
        url = $(urlElement).find(linkSelector).text();
      }
      const lastModified = $(urlElement).find(dateSelector).text();
      const lastModifiedDate = lastModified ? new Date(lastModified) : null;

      urlList.push({ url, lastModifiedDate });
    });
    if (isIntelligent) {
      // Sort by closeness to userUrlInput in descending order
      urlList.sort((a, b) => {
        const closenessA = calculateCloseness(a.url);
        const closenessB = calculateCloseness(b.url);
        if (closenessA !== closenessB) {
          return closenessB - closenessA;
        }

        // If closeness is the same, sort by last modified date in descending order
        return (b.lastModifiedDate?.getTime() || 0) - (a.lastModifiedDate?.getTime() || 0);
      });
    }

    // Add all URLs to the discovered list (limit applied later at return time)
    for (const { url } of urlList) {
      addToUrlList(url);
    }
  };

  const processNonStandardSitemap = (data: string) => {
    const urlsFromData = crawlee
      .extractUrls({ string: data, urlRegExp: new RegExp('^(http|https):/{2}.+$', 'gmi') });
    urlsFromData.forEach(url => {
      addToUrlList(url);
    });
  };

  let finalUserDataDirectory = userDataDirectory;
  if (userDataDirectory === null || userDataDirectory === undefined) {
    finalUserDataDirectory = '';
  }

  const fetchUrls = async (url: string, extraHTTPHeaders: Record<string, string>) => {
    let data;
    let sitemapType;

    if (isImageSitemapUrl(url)) {
      consoleLogger.info(`Skipping image sitemap: ${url}`);
      return;
    }

    if (scannedSitemaps.has(url)) {
      // Skip processing if the sitemap has already been scanned
      return;
    }

    scannedSitemaps.add(url);

    // Convert file if its not local file path
    url = convertLocalFileToPath(url);

    // Check whether its a file path or a URL
    if (isFilePath(url)) {
      if (!fs.existsSync(url)) {
        return;
      }
    } else if (isValidHttpUrl(url)) {
      // Do nothing, url is valid
    } else {
      printMessage([`Invalid Url/Filepath: ${url}`], messageOptions);
      return;
    }

    const getDataUsingPlaywright = async () => {
      let browserContext;
      let browserInstance;

      try {
        if (process.env.CRAWLEE_HEADLESS === '1') {
          browserContext = await constants.launcher.launchPersistentContext(
            finalUserDataDirectory,
            {
              ...getPlaywrightLaunchOptions(browser),
              // Not necessary to parse http_credentials as I am parsing it directly in URL
              // Bug in Chrome which causes browser pool crash when userDataDirectory is set in non-headless mode
              ...(process.env.CRAWLEE_HEADLESS === '1' && { userDataDir: userDataDirectory }),
              ...(extraHTTPHeaders && { extraHTTPHeaders }),
              ...(process.env.OOBEE_USER_AGENT && { userAgent: process.env.OOBEE_USER_AGENT }),
            },
          );

          register(browserContext);
        } else {
          // In headful mode, avoid launchPersistentContext with custom user data dir to prevent "Browser window not found"
          const launchOptions = getPlaywrightLaunchOptions(browser);
          browserInstance = await constants.launcher.launch(launchOptions);
          register(browserInstance as unknown as { close: () => Promise<void> });

          browserContext = await browserInstance.newContext({
            ...(extraHTTPHeaders && { extraHTTPHeaders }),
            ...(process.env.OOBEE_USER_AGENT && { userAgent: process.env.OOBEE_USER_AGENT }),
          });
        }

        const page = await browserContext.newPage();

        // Use 'domcontentloaded' instead of 'networkidle' — sitemap XMLs with
        // XSL stylesheet references (e.g. <?xml-stylesheet ...?>) cause the browser
        // to fetch and apply the stylesheet, which may load additional resources
        // (fonts, CSS, images) that prevent 'networkidle' from ever being reached.
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Prefer the raw response body — this gives us the original XML before
        // the browser applies any XSL transformation (which would turn the XML
        // into rendered HTML, losing the sitemap structure).
        if (response) {
          try {
            data = await response.text();
          } catch {
            // response.text() can fail if the body was already consumed or
            // if a redirect occurred; fall through to DOM extraction below.
          }
        }

        if (!data) {
          if ((await page.locator('body').count()) > 0) {
            data = await page.locator('body').innerText();
          } else {
          const urlSet = page.locator('urlset');
          const sitemapIndex = page.locator('sitemapindex');
          const rss = page.locator('rss');
          const feed = page.locator('feed');
          const isRoot = async (locator: Locator) => (await locator.count()) > 0;

          if (await isRoot(urlSet)) {
            data = await urlSet.evaluate(elem => elem.outerHTML);
          } else if (await isRoot(sitemapIndex)) {
            data = await sitemapIndex.evaluate(elem => elem.outerHTML);
          } else if (await isRoot(rss)) {
            data = await rss.evaluate(elem => elem.outerHTML);
          } else if (await isRoot(feed)) {
            data = await feed.evaluate(elem => elem.outerHTML);
            }
          }
        }
      } finally {
        await browserContext?.close();
        if (browserInstance) {
          await browserInstance.close();
        }
      }
    };

    if (validator.isURL(url, urlOptions)) {
      if (isUrlPdf(url)) {
        addToUrlList(url);
        return;
      }

      await getDataUsingPlaywright();
    } else {
      url = convertLocalFileToPath(url);
      data = fs.readFileSync(url, 'utf8');
    }

    const $ = cheerio.load(data, { xml: true });
    const countBefore = allUrls.size;

    // This case is when the document is not an XML format document
    if ($(':root').length === 0) {
      processNonStandardSitemap(data);

      const linksFromThisSitemap = allUrls.size - countBefore;
      if (linksFromThisSitemap > 0) {
        sitemapLinkCounts[url] = (sitemapLinkCounts[url] || 0) + linksFromThisSitemap;
      }
      return;
    }

    // Root element
    const root = $(':root')[0];
    const hasImageNamespace = Object.values(root?.attribs ?? {}).some(
      attribVal => typeof attribVal === 'string' && attribVal.toLowerCase().includes('sitemap-image'),
    );

    if (hasImageNamespace) {
      consoleLogger.info(`Skipping image sitemap: ${url}`);
      return;
    }

    const rootName = root?.name?.toLowerCase().split(':').pop() ?? '';
    const hasXmlSitemapIndexTag = /<\s*(?:[a-z0-9_-]+:)?sitemapindex\b/i.test(data);
    const hasXmlUrlsetTag = /<\s*(?:[a-z0-9_-]+:)?urlset\b/i.test(data);

    if (rootName === 'urlset') {
      sitemapType = constants.xmlSitemapTypes.xml;
    } else if (rootName === 'sitemapindex') {
      sitemapType = constants.xmlSitemapTypes.xmlIndex;
    } else if (rootName === 'rss') {
      sitemapType = constants.xmlSitemapTypes.rss;
    } else if (rootName === 'feed') {
      sitemapType = constants.xmlSitemapTypes.atom;
    } else if (hasXmlSitemapIndexTag) {
      sitemapType = constants.xmlSitemapTypes.xmlIndex;
    } else if (hasXmlUrlsetTag) {
      sitemapType = constants.xmlSitemapTypes.xml;
    } else {
      sitemapType = constants.xmlSitemapTypes.unknown;
    }

    switch (sitemapType) {
      case constants.xmlSitemapTypes.xmlIndex:
        consoleLogger.info(`This is a XML format sitemap index: ${url}`);
        for (const childSitemapUrl of $('loc')) {
          const childSitemapUrlText = $(childSitemapUrl).text().trim();
          if (!childSitemapUrlText) {
            continue;
          }

          const childSitemapPath = childSitemapUrlText.split(/[?#]/)[0].toLowerCase();
          if (childSitemapPath.endsWith('.xml') || childSitemapPath.endsWith('.txt')) {
            if (isImageSitemapUrl(childSitemapUrlText)) {
              consoleLogger.info(`Skipping image sitemap: ${childSitemapUrlText}`);
              continue;
            }
            await fetchUrls(childSitemapUrlText, extraHTTPHeaders); // Recursive call for nested sitemaps
          } else {
            addToUrlList(childSitemapUrlText); // Add regular URLs to the list
          }
        }
        break;
      case constants.xmlSitemapTypes.xml:
        consoleLogger.info(`This is a XML format sitemap: ${url}`);
        await processXmlSitemap($, sitemapType, 'loc', 'lastmod', 'url');
        break;
      case constants.xmlSitemapTypes.rss:
        consoleLogger.info(`This is a RSS format sitemap: ${url}`);
        await processXmlSitemap($, sitemapType, 'link', 'pubDate', 'item');
        break;
      case constants.xmlSitemapTypes.atom:
        consoleLogger.info(`This is a Atom format sitemap: ${url}`);
        await processXmlSitemap($, sitemapType, 'link', 'published', 'entry');
        break;
      default:
        consoleLogger.info(`This is an unrecognised XML sitemap format: ${url}`);
        processNonStandardSitemap(data);
    }

    const linksFromThisSitemap = allUrls.size - countBefore;
    if (linksFromThisSitemap > 0) {
      sitemapLinkCounts[url] = (sitemapLinkCounts[url] || 0) + linksFromThisSitemap;
    }
  };

  try {
    await fetchUrls(sitemapUrl, extraHTTPHeaders);
  } catch (e) {
    consoleLogger.error(e);
  }

  // Build Request objects for all discovered URLs; the crawler itself enforces
  // maxRequestsPerCrawl by counting only successfully scanned pages.
  const requestList: Request[] = [];
  for (const url of allUrls) {
    try {
      const request = new Request({ url });
      if (isUrlPdf(url)) {
        request.skipNavigation = true;
      }
      requestList.push(request);
    } catch (e) {
      consoleLogger.info(`Error creating request for ${url}: ${e}`);
    }
  }

  const totalLinksDiscovered = allUrls.size;
  const fetchedSitemaps = Object.entries(sitemapLinkCounts).map(([url, fetchedLinks]) => ({
    url,
    fetchedLinks,
  }));

  const prev = constants.sitemapFetchedLinks;
  constants.sitemapFetchedLinks = {
    totalLinksFetchedFromSitemaps: (prev?.totalLinksFetchedFromSitemaps ?? 0) + totalLinksDiscovered,
    fetchedSitemaps: [...(prev?.fetchedSitemaps ?? []), ...fetchedSitemaps],
  };

  if (totalLinksDiscovered > 0) {
    const breakdown = fetchedSitemaps
      .map(({ url, fetchedLinks }) => `${url} (${fetchedLinks})`)
      .join(', ');
    consoleLogger.info(
      `There are a total of ${totalLinksDiscovered} links found across ${breakdown}.`,
    );
  }

  return requestList;
};

export const validEmail = (email: string) => {
  const emailRegex = /^.+@.+\..+$/u;

  return emailRegex.test(email);
};

// For new user flow.
export const validName = (name: string) => {
  // Allow only printable characters from any language
  const regex = /^[\p{L}\p{N}\s'".,()\[\]{}!?:؛،؟…]+$/u;

  // Check if the length is between 2 and 32000 characters
  if (name.length < 2 || name.length > 32000) {
    // Handle invalid name length
    return false;
  }

  if (!regex.test(name)) {
    // Handle invalid name format
    return false;
  }

  // Include a check for specific characters to sanitize injection patterns
  const preventInjectionRegex = /[<>'"\\/;|&!$*{}()\[\]\r\n\t]/;
  if (preventInjectionRegex.test(name)) {
    // Handle potential injection attempts
    return false;
  }

  return true;
};

/**
 * Check for browser available to run scan and clone data directory of the browser if needed.
 * @param preferredBrowser string of user's preferred browser
 * @param isCli boolean flag to indicate if function is called from cli
 * @returns object consisting of browser to run and cloned data directory
 */
export const getBrowserToRun = (
  randomToken: string,
  preferredBrowser?: BrowserTypes,
  isCli = false,
): { browserToRun: BrowserTypes; clonedBrowserDataDir: string } => {
  const platform = os.platform();

  // Prioritise Chrome on Windows and Mac platforms if user does not specify a browser
  if (!preferredBrowser && (os.platform() === 'win32' || os.platform() === 'darwin')) {
    preferredBrowser = BrowserTypes.CHROME;
  } else {
    printMessage([`Preferred browser ${preferredBrowser}`], messageOptions);
  }

  if (preferredBrowser === BrowserTypes.CHROME) {
    const chromeData = getChromeData(randomToken);
    if (chromeData) return chromeData;

    if (platform === 'darwin') {
      // mac user who specified -b chrome but does not have chrome
      if (isCli) printMessage(['Unable to use Chrome, falling back to webkit...'], messageOptions);

      constants.launcher = webkit;
      return { browserToRun: null, clonedBrowserDataDir: '' };
    }
    if (platform === 'win32') {
      if (isCli)
        printMessage(['Unable to use Chrome, falling back to Edge browser...'], messageOptions);

      const edgeData = getEdgeData(randomToken);
      if (edgeData) return edgeData;

      if (isCli)
        printMessage(['Unable to use both Chrome and Edge. Please try again.'], messageOptions);
      process.exit(constants.urlCheckStatuses.browserError.code);
    }

    if (isCli) {
      printMessage(['Unable to use Chrome, falling back to Chromium browser...'], messageOptions);
    }
  } else if (preferredBrowser === BrowserTypes.EDGE) {
    const edgeData = getEdgeData(randomToken);
    if (edgeData) return edgeData;

    if (isCli)
      printMessage(['Unable to use Edge, falling back to Chrome browser...'], messageOptions);
    const chromeData = getChromeData(randomToken);
    if (chromeData) return chromeData;

    if (platform === 'darwin') {
      //  mac user who specified -b edge but does not have edge or chrome
      if (isCli)
        printMessage(
          ['Unable to use both Edge and Chrome, falling back to webkit...'],
          messageOptions,
        );

      constants.launcher = webkit;
      return { browserToRun: null, clonedBrowserDataDir: '' };
    }
    if (platform === 'win32') {
      if (isCli)
        printMessage(['Unable to use both Edge and Chrome. Please try again.'], messageOptions);
      process.exit(constants.urlCheckStatuses.browserError.code);
    } else {
      // linux and other OS
      if (isCli)
        printMessage(
          ['Unable to use both Edge and Chrome, falling back to Chromium browser...'],
          messageOptions,
        );
    }
  }

  // defaults to chromium
  return {
    browserToRun: BrowserTypes.CHROMIUM,
    clonedBrowserDataDir: cloneChromiumProfiles(randomToken),
  };
};

/**
 * Cloning a second time with random token for parallel browser sessions
 * Also to mitigate against known bug where cookies are
 * overridden after each browser session - i.e. logs user out
 * after checkingUrl and unable to utilise same cookie for scan
 * */
export const getClonedProfilesWithRandomToken = (browser: string, randomToken: string): string => {
  if (browser === BrowserTypes.CHROME) {
    return cloneChromeProfiles(randomToken);
  }
  if (browser === BrowserTypes.EDGE) {
    return cloneEdgeProfiles(randomToken);
  }
  return cloneChromiumProfiles(randomToken);
};

export const getChromeData = (randomToken: string) => {
  const browserDataDir = getDefaultChromeDataDir();
  const clonedBrowserDataDir = cloneChromeProfiles(randomToken);
  if (browserDataDir && clonedBrowserDataDir) {
    const browserToRun = BrowserTypes.CHROME;
    return { browserToRun, clonedBrowserDataDir };
  }
  return null;
};

export const getEdgeData = (randomToken: string) => {
  const browserDataDir = getDefaultEdgeDataDir();
  const clonedBrowserDataDir = cloneEdgeProfiles(randomToken);
  if (browserDataDir && clonedBrowserDataDir) {
    const browserToRun = BrowserTypes.EDGE;
    return { browserToRun, clonedBrowserDataDir };
  }
};

/**
 * Clone the Chrome profile cookie files to the destination directory
 * @param {*} options glob options object
 * @param {*} destDir destination directory
 * @returns boolean indicating whether the operation was successful
 */
// Helper to copy a file with retry logic for transient EBUSY errors
const copyFileWithRetry = (src: string, dest: string, maxRetries: number = 3): boolean => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.copyFileSync(src, dest);
      if (attempt > 1) {
        consoleLogger.info(`File copy succeeded on attempt ${attempt}: ${dest}`);
      }
      return true;
    } catch (err: any) {
      if (err.code === 'EBUSY' && attempt < maxRetries) {
        // Transient lock — wait and retry
        const delayMs = Math.min(100 * Math.pow(2, attempt - 1), 1000); // Exponential backoff: 100ms, 200ms, 400ms, capped at 1s
        consoleLogger.warn(
          `File copy attempt ${attempt}/${maxRetries} failed with EBUSY. Retrying after ${delayMs}ms: ${dest}`,
        );
        // Synchronous sleep via busy-wait (not ideal but avoids promise complications in sync context)
        const endTime = Date.now() + delayMs;
        while (Date.now() < endTime) {
          // Busy wait
        }
        continue; // Retry
      }
      // Non-transient error or max retries reached
      return false;
    }
  }
  return false;
};

const cloneChromeProfileCookieFiles = (options: GlobOptionsWithFileTypesFalse, destDir: string) => {
  let profileCookiesDir;
  // Cookies file per profile is located in .../User Data/<profile name>/Network/Cookies for windows
  // and ../Chrome/<profile name>/Cookies for mac
  let profileNamesRegex: RegExp;
  if (os.platform() === 'win32') {
    profileCookiesDir = globSync('**/Network/Cookies', {
      ...options,
      ignore: ['oobee*/**'],
    });
    profileNamesRegex = /User Data\\(.*?)\\Network/;
  } else if (os.platform() === 'darwin') {
    // maxDepth 2 to avoid copying cookies from the oobee directory if it exists
    profileCookiesDir = globSync('**/Cookies', {
      ...options,
      ignore: 'oobee*/**',
    });
    profileNamesRegex = /Chrome\/(.*?)\/Cookies/;
  }

  if (profileCookiesDir.length > 0) {
    let success = true;
    profileCookiesDir.forEach(dir => {
      const profileName = dir.match(profileNamesRegex)[1];
      if (profileName) {
        let destProfileDir = path.join(destDir, profileName);
        if (os.platform() === 'win32') {
          destProfileDir = path.join(destProfileDir, 'Network');
        }
        // Recursive true to create all parent directories (e.g. PbProfile/Default/Cookies)
        if (!fs.existsSync(destProfileDir)) {
          fs.mkdirSync(destProfileDir, { recursive: true });
          if (!fs.existsSync(destProfileDir)) {
            fs.mkdirSync(destProfileDir, { recursive: true });
          }
        }

        // Prevents duplicate cookies file if the cookies already exist
        if (!fs.existsSync(path.join(destProfileDir, 'Cookies'))) {
          const destCookiesPath = path.join(destProfileDir, 'Cookies');
          if (!copyFileWithRetry(dir, destCookiesPath)) {
            consoleLogger.error(`Failed to copy Chrome profile cookies for ${profileName} after retries.`);
            success = false;
          }
        }
      }
    });
    return success;
  }

  consoleLogger.warn('Unable to find Chrome profile cookies file in the system.');
  printMessage(['Unable to find Chrome profile cookies file in the system.'], messageOptions);
  return false;
};

const cloneEdgeProfileCookieFiles = (options: GlobOptionsWithFileTypesFalse, destDir: string) => {
  let profileCookiesDir;
  // Cookies file per profile is located in .../User Data/<profile name>/Network/Cookies for windows
  // and ../Chrome/<profile name>/Cookies for mac
  let profileNamesRegex: RegExp;
  // Ignores the cloned oobee directory if exists
  if (os.platform() === 'win32') {
    profileCookiesDir = globSync('**/Network/Cookies', {
      ...options,
      ignore: 'oobee*/**',
    });
    profileNamesRegex = /User Data\\(.*?)\\Network/;
  } else if (os.platform() === 'darwin') {
    // Ignores copying cookies from the oobee directory if it exists
    profileCookiesDir = globSync('**/Cookies', {
      ...options,
      ignore: 'oobee*/**',
    });
    profileNamesRegex = /Microsoft Edge\/(.*?)\/Cookies/;
  }

  if (profileCookiesDir.length > 0) {
    let success = true;
    profileCookiesDir.forEach(dir => {
      const profileName = dir.match(profileNamesRegex)[1];
      if (profileName) {
        let destProfileDir = path.join(destDir, profileName);
        if (os.platform() === 'win32') {
          destProfileDir = path.join(destProfileDir, 'Network');
        }
        // Recursive true to create all parent directories (e.g. PbProfile/Default/Cookies)
        if (!fs.existsSync(destProfileDir)) {
          fs.mkdirSync(destProfileDir, { recursive: true });
          if (!fs.existsSync(destProfileDir)) {
            fs.mkdirSync(destProfileDir, { recursive: true });
          }
        }

        // Prevents duplicate cookies file if the cookies already exist
        if (!fs.existsSync(path.join(destProfileDir, 'Cookies'))) {
          const destCookiesPath = path.join(destProfileDir, 'Cookies');
          if (!copyFileWithRetry(dir, destCookiesPath)) {
            consoleLogger.error(`Failed to copy Edge profile cookies for ${profileName} after retries.`);
            success = false;
          }
        }
      }
    });
    return success;
  }
  consoleLogger.warn('Unable to find Edge profile cookies file in the system.');
  printMessage(['Unable to find Edge profile cookies file in the system.'], messageOptions);
  return false;
};

/**
 * Both Edge and Chrome Local State files are located in the .../User Data directory
 * @param {*} options - glob options object
 * @param {string} destDir - destination directory
 * @returns boolean indicating whether the operation was successful
 */
const cloneLocalStateFile = (options: GlobOptionsWithFileTypesFalse, destDir: string) => {
  const localState = globSync('**/*Local State', {
    ...options,
    maxDepth: 1,
  });
  const profileNamesRegex = /([^/\\]+)[/\\]Local State$/;

  if (localState.length > 0) {
    let success = true;

    localState.forEach(dir => {
      const profileName = dir.match(profileNamesRegex)[1];
      const destPath = path.join(destDir, 'Local State');
      if (!copyFileWithRetry(dir, destPath)) {
        consoleLogger.error(`Failed to copy Local State file for ${profileName} after retries.`);
        success = false;
      }
    });
    return success;
  }
  consoleLogger.warn('Unable to find local state file in the system.');
  printMessage(['Unable to find local state file in the system.'], messageOptions);
  return false;
};

/**
 * Checks if the Chrome data directory exists and creates a clone
 * of all profile within the oobee directory located in the
 * .../User Data directory for Windows and
 * .../Chrome directory for Mac.
 * @param {string} randomToken - random token to append to the cloned directory
 * @returns {string} cloned data directory, null if any of the sub files failed to copy
 */
export const cloneChromeProfiles = (randomToken: string): string => {
  const baseDir = getDefaultChromeDataDir();

  if (!baseDir) {
    return;
  }

  let destDir;

  destDir = path.join(baseDir, `oobee-${randomToken}`);

  if (fs.existsSync(destDir)) {
    // Don't delete since it will be handled at the end of the scan
    // deleteClonedChromeProfiles(randomToken);
    // Assume it cloned and don't re-clone
  } else {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const baseOptions = {
      cwd: baseDir,
      recursive: true,
      absolute: true,
      nodir: true,
    };
    const cloneLocalStateFileSuccess = cloneLocalStateFile(baseOptions, destDir);
    if (cloneChromeProfileCookieFiles(baseOptions, destDir) && cloneLocalStateFileSuccess) {
      return destDir;
    }

    consoleLogger.error('Failed to clone Chrome profiles. You may be logged out of your accounts.');

    // Fall back to a clean profile directory to avoid launch failures from partial clones.
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(destDir, { recursive: true });
      consoleLogger.warn('Using an empty cloned Chrome profile directory due to clone failure.');
    } catch (cleanupError) {
      consoleLogger.error(
        `Unable to reset cloned Chrome profile directory ${destDir}: ${cleanupError}`,
      );
    }
  }
  // For future reference, return a null instead to halt the scan
  return destDir;
};

export const cloneChromiumProfiles = (randomToken: string): string => {
  const baseDir = getDefaultChromiumDataDir();

  if (!baseDir) {
    return;
  }

  let destDir: string;

  destDir = path.join(baseDir, `oobee-${randomToken}`);

  if (fs.existsSync(destDir)) {
    // Don't delete since it will be handled at the end of the scan
    // deleteClonedChromiumProfiles(randomToken);
    // Assume it cloned and don't re-clone
  } else {
    fs.mkdirSync(destDir, { recursive: true });
  }

  return destDir;
};

/**
 * Checks if the Edge data directory exists and creates a clone
 * of all profile within the oobee directory located in the
 * .../User Data directory for Windows and
 * .../Microsoft Edge directory for Mac.
 * @param {string} randomToken - random token to append to the cloned directory
 * @returns {string} cloned data directory, null if any of the sub files failed to copy
 */
export const cloneEdgeProfiles = (randomToken: string): string => {
  const baseDir = getDefaultEdgeDataDir();

  if (!baseDir) {
    return;
  }

  let destDir;

  destDir = path.join(baseDir, `oobee-${randomToken}`);

  if (fs.existsSync(destDir)) {
    // Don't delete since it will be handled at the end of the scan
    // deleteClonedEdgeProfiles(randomToken);
    // Assume it cloned and don't re-clone
  } else {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const baseOptions = {
      cwd: baseDir,
      recursive: true,
      absolute: true,
      nodir: true,
    };

    const cloneLocalStateFileSuccess = cloneLocalStateFile(baseOptions, destDir);
    if (cloneEdgeProfileCookieFiles(baseOptions, destDir) && cloneLocalStateFileSuccess) {
      return destDir;
    }

    consoleLogger.error('Failed to clone Edge profiles. You may be logged out of your accounts.');

    // Fall back to a clean profile directory to avoid launch failures from partial clones.
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(destDir, { recursive: true });
      consoleLogger.warn('Using an empty cloned Edge profile directory due to clone failure.');
    } catch (cleanupError) {
      consoleLogger.error(`Unable to reset cloned Edge profile directory ${destDir}: ${cleanupError}`);
    }
  }

  // For future reference, return a null instead to halt the scan
  return destDir;
};

export const deleteClonedProfiles = (browser: string, randomToken: string): void => {
  if (browser === BrowserTypes.CHROME) {
    deleteClonedChromeProfiles(randomToken);
  } else if (browser === BrowserTypes.EDGE) {
    deleteClonedEdgeProfiles(randomToken);
  } else if (browser === BrowserTypes.CHROMIUM) {
    deleteClonedChromiumProfiles(randomToken);
  }
};

/**
 * Deletes all the cloned oobee directories in the Chrome data directory
 * @returns null
 */
export const deleteClonedChromeProfiles = (randomToken?: string): void => {
  const baseDir = getDefaultChromeDataDir();

  if (!baseDir) {
    return;
  }
  let destDir: string[];
  if (randomToken) {
    // Also match _pool* directories created by browser pool re-launches
    destDir = globSync(`oobee-${randomToken}*`, {
      cwd: baseDir,
      absolute: true,
    });
    if (destDir.length === 0) {
      destDir = [`${baseDir}/oobee-${randomToken}`];
    }
  } else {
    // Find all the oobee directories in the Chrome data directory
    destDir = globSync('**/oobee*', {
      cwd: baseDir,
      absolute: true,
    });
  }

  if (destDir.length > 0) {
    destDir.forEach(dir => {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true });
        } catch (err) {
          consoleLogger.error(
            `CHROME Unable to delete ${dir} folder in the Chrome data directory. ${err}`,
          );
        }
      }
    });
    return;
  }

  consoleLogger.warn('Unable to find oobee directory in the Chrome data directory.');
  console.warn('Unable to find oobee directory in the Chrome data directory.');
};

/**
 * Deletes all the cloned oobee directories in the Edge data directory
 * @returns null
 */
export const deleteClonedEdgeProfiles = (randomToken?: string): void => {
  const baseDir = getDefaultEdgeDataDir();

  if (!baseDir) {
    console.warn(`Unable to find Edge data directory in the system.`);
    return;
  }
  let destDir: string[];
  if (randomToken) {
    // Also match _pool* directories created by browser pool re-launches
    destDir = globSync(`oobee-${randomToken}*`, {
      cwd: baseDir,
      absolute: true,
    });
    if (destDir.length === 0) {
      destDir = [`${baseDir}/oobee-${randomToken}`];
    }
  } else {
    // Find all the oobee directories in the Edge data directory
    destDir = globSync('**/oobee*', {
      cwd: baseDir,
      absolute: true,
    });
  }

  if (destDir.length > 0) {
    destDir.forEach(dir => {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true });
        } catch (err) {
          consoleLogger.error(
            `EDGE Unable to delete ${dir} folder in the Chrome data directory. ${err}`,
          );
        }
      }
    });
  }
};

export const deleteClonedChromiumProfiles = (randomToken?: string): void => {
  const baseDir = getDefaultChromiumDataDir();

  if (!baseDir) {
    return;
  }
  let destDir: string[];
  if (randomToken) {
    destDir = [`${baseDir}/oobee-${randomToken}`];
  } else {
    // Find all the oobee directories in the Chrome data directory
    destDir = globSync('**/oobee*', {
      cwd: baseDir,
      absolute: true,
    });
  }

  if (destDir.length > 0) {
    destDir.forEach(dir => {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true });
        } catch (err) {
          consoleLogger.error(
            `CHROMIUM Unable to delete ${dir} folder in the Chromium data directory. ${err}`,
          );
        }
      }
    });
    return;
  }

  consoleLogger.warn('Unable to find oobee directory in Chromium support directory');
  console.warn('Unable to find oobee directory in Chromium support directory');
};

export const getPlaywrightDeviceDetailsObject = (
  deviceChosen: string,
  customDevice: string,
  viewportWidth: number,
): DeviceDescriptor => {
  let playwrightDeviceDetailsObject = devices['Desktop Chrome']; // default to Desktop Chrome

  if (deviceChosen === 'Mobile' || customDevice === 'iPhone 11') {
    playwrightDeviceDetailsObject = devices['iPhone 11'];
  } else if (customDevice === 'Samsung Galaxy S9+') {
    playwrightDeviceDetailsObject = devices['Galaxy S9+'];
  } else if (viewportWidth) {
    playwrightDeviceDetailsObject = {
      viewport: { width: viewportWidth, height: 720 },
      isMobile: false,
      hasTouch: false,
      userAgent: devices['Desktop Chrome'].userAgent,
      deviceScaleFactor: 1,
      defaultBrowserType: 'chromium',
    };
  } else if (customDevice) {
    playwrightDeviceDetailsObject = devices[customDevice.replace(/_/g, ' ')];
  }
  return playwrightDeviceDetailsObject;
};

export const getScreenToScan = (
  deviceChosen: string,
  customDevice: string,
  viewportWidth: number,
): string => {
  if (deviceChosen) {
    return deviceChosen;
  }
  if (customDevice) {
    return customDevice;
  }
  if (viewportWidth) {
    return `CustomWidth_${viewportWidth}px`;
  }
  return 'Desktop';
};

export const submitFormViaPlaywright = async (
  browserToRun: string,
  userDataDirectory: string,
  finalUrl: string,
) => {
  const browserContext = await constants.launcher.launchPersistentContext(userDataDirectory, {
    ...getPlaywrightLaunchOptions(browserToRun),
  });

  register(browserContext);

  const page = await browserContext.newPage();

  try {
    await page.goto(finalUrl, {
      timeout: 30000,
      waitUntil: 'commit',
    });

    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      consoleLogger.info('Unable to detect networkidle');
    }
  } catch (error) {
    consoleLogger.error(error);
  } finally {
    await browserContext.close();
  }
};

export const submitForm = async (
  browserToRun: string,
  userDataDirectory: string,
  scannedUrl: string,
  entryUrl: string,
  scanType: string,
  email: string,
  name: string,
  scanResultsJson: string,
  numberOfPagesScanned: number,
  numberOfRedirectsScanned: number,
  numberOfPagesNotScanned: number,
  metadata: string,
) => {
  // Legacy code start - Google Sheets submission
  const additionalPageDataJson = JSON.stringify({
    redirectsScanned: numberOfRedirectsScanned,
    pagesNotScanned: numberOfPagesNotScanned,
  });

  let finalUrl =
    `${formDataFields.formUrl}?` +
    `${formDataFields.entryUrlField}=${entryUrl}&` +
    `${formDataFields.scanTypeField}=${scanType}&` +
    `${formDataFields.emailField}=${email}&` +
    `${formDataFields.nameField}=${name}&` +
    `${formDataFields.resultsField}=${encodeURIComponent(scanResultsJson)}&` +
    `${formDataFields.numberOfPagesScannedField}=${numberOfPagesScanned}&` +
    `${formDataFields.additionalPageDataField}=${encodeURIComponent(additionalPageDataJson)}&` +
    `${formDataFields.metadataField}=${encodeURIComponent(metadata)}`;

  if (scannedUrl !== entryUrl) {
    finalUrl += `&${formDataFields.redirectUrlField}=${scannedUrl}`;
  }

  try {
    await axios.get(finalUrl, { timeout: 2000 });
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      if (browserToRun || constants.launcher === webkit) {
        await submitFormViaPlaywright(browserToRun, userDataDirectory, finalUrl);
      }
    }
  }
};
// Legacy code end - Google Sheets submission

export async function initModifiedUserAgent(
  browser?: string,
  _playwrightDeviceDetailsObject?: object,
  _userDataDirectory?: string,
) {
  // UA bootstrap must not use persistent context / user-data-dir.
  const launchOptions = getPlaywrightLaunchOptions(browser);

  const browserInstance = await constants.launcher.launch(launchOptions);
  register(browserInstance as unknown as { close: () => Promise<void> });

  try {
    const context = await browserInstance.newContext();
    const page = await context.newPage();
    const defaultUA = await page.evaluate(() => navigator.userAgent);
    await context.close();

    const modifiedUA = defaultUA.includes('HeadlessChrome')
      ? defaultUA.replace('HeadlessChrome', 'Chrome')
      : defaultUA;

    // Do not mutate global CLI args with --user-agent=
    process.env.OOBEE_USER_AGENT = modifiedUA;
  } finally {
    await browserInstance.close();
  }
}

const cacheProxyInfo = getProxyInfo();

/**
 * @param {string} browser browser name ("chrome" or "edge", null for chromium, the default Playwright browser)
 * @returns playwright launch options object. For more details: https://playwright.dev/docs/api/class-browsertype#browser-type-launch
 */
export const getPlaywrightLaunchOptions = (browser?: string): LaunchOptions => {
  const channel = browser || undefined;

  const resolution = proxyInfoToResolution(cacheProxyInfo);
  const shouldIgnoreMuteAudio =
    process.env.OOBEE_PLAYWRIGHT_IGNORE_DEFAULT_ARGS === '--mute-audio';

  // Start with your base args and sanitise
  const finalArgs = [...constants.launchOptionsArgs].filter(
    arg =>
      !arg.startsWith('--headless') &&
      !arg.startsWith('--user-agent=') &&
      arg !== '--mute-audio' &&
      !(browser === BrowserTypes.CHROME && arg === '--edge-skip-compat-layer-relaunch'),
  );

  // Headless flags (unchanged)
  if (process.env.CRAWLEE_HEADLESS === '1') {
    if (!finalArgs.includes('--mute-audio')) finalArgs.push('--mute-audio');
  }

  // Map resolution to Playwright options
  let proxyOpt: ProxySettings | undefined;
  switch (resolution.kind) {
    case 'manual':
      proxyOpt = resolution.settings;
      break;
    case 'pac': {
      finalArgs.push(`--proxy-pac-url=${resolution.pacUrl}`);
      if (resolution.bypass) finalArgs.push(`--proxy-bypass-list=${resolution.bypass}`);
      break;
    }
    case 'none':
      // nothing
      break;
  }

  const options: LaunchOptions = {
    ignoreDefaultArgs: shouldIgnoreMuteAudio
      ? ['--use-mock-keychain', '--mute-audio']
      : ['--use-mock-keychain'],
    args: finalArgs,
    headless: process.env.CRAWLEE_HEADLESS === '1',
    ...(channel && { channel }),
    ...(proxyOpt ? { proxy: proxyOpt } : {}),
  };

  // SlowMo for debugging, can be set via env variable OOBEE_SLOWMO to avoid adding it as a CLI argument and causing confusion for users who don't need it
  if (!options.slowMo && process.env.OOBEE_SLOWMO && Number(process.env.OOBEE_SLOWMO) >= 1) {
    options.slowMo = Number(process.env.OOBEE_SLOWMO);
    consoleLogger.info(`Enabled browser slowMo with value: ${process.env.OOBEE_SLOWMO}ms`);
  }

  return options;
};

export const waitForPageLoaded = async (page: Page, timeout = 10000) => {
  const OBSERVER_TIMEOUT = timeout; // Ensure observer timeout does not exceed the main timeout

  return Promise.race([
    page.waitForLoadState('load'), // Ensure page load completes
    page.waitForLoadState('networkidle'), // Wait for network requests to settle
    new Promise(resolve => setTimeout(resolve, timeout)), // Hard timeout as a fallback
    page.evaluate(OBSERVER_TIMEOUT => {
      return new Promise<string>(resolve => {
        // Skip mutation check for PDFs
        if (document.contentType === 'application/pdf') {
          resolve('Skipping DOM mutation check for PDF.');
          return;
        }

        const root = document.documentElement || document.body;
        if (!(root instanceof Node)) {
          // Not a valid DOM root—treat as loaded
          resolve('No valid root to observe; treating as loaded.');
          return;
        }

        let timeout: NodeJS.Timeout;
        let mutationCount = 0;
        const MAX_MUTATIONS = 500;
        const mutationHash: Record<string, number> = {};

        const observer = new MutationObserver(mutationsList => {
          clearTimeout(timeout);
          mutationCount++;
          if (mutationCount > MAX_MUTATIONS) {
            observer.disconnect();
            resolve('Too many mutations detected, exiting.');
            return;
          }

          for (const mutation of mutationsList) {
            if (mutation.target instanceof Element) {
              for (const attr of Array.from(mutation.target.attributes)) {
                const key = `${mutation.target.nodeName}-${attr.name}`;
                mutationHash[key] = (mutationHash[key] || 0) + 1;
                if (mutationHash[key] >= 10) {
                  observer.disconnect();
                  resolve(`Repeated mutation detected for ${key}, exiting.`);
                  return;
                }
              }
            }
          }

          timeout = setTimeout(() => {
            observer.disconnect();
            resolve('DOM stabilized after mutations.');
          }, 1000);
        });

        // Final timeout to avoid infinite waiting
        timeout = setTimeout(() => {
          observer.disconnect();
          resolve('Observer timeout reached, exiting.');
        }, OBSERVER_TIMEOUT);

        // Only observe if root is a Node
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      });
    }, OBSERVER_TIMEOUT), // Pass OBSERVER_TIMEOUT dynamically to the browser context
  ]);
};

function isValidHttpUrl(urlString: string) {
  const pattern = /^(http|https):\/\/[^ "]+$/;
  return pattern.test(urlString);
}

export const isFilePath = (url: string): boolean => {
  const driveLetterPattern = /^[A-Z]:/i;
  const backslashPattern = /\\/;
  return (
    url.toLowerCase().startsWith('file://') ||
    url.startsWith('/') ||
    driveLetterPattern.test(url) ||
    backslashPattern.test(url) ||
    url.startsWith('./') ||
    url.startsWith('../') ||
    url.startsWith('.\\') ||
    url.startsWith('..\\')
  );
};

export function convertLocalFileToPath(url: string): string {
  if (url.startsWith('file://')) {
    url = fileURLToPath(url);
  }
  return url;
}

export function convertPathToLocalFile(filePath: string): string {
  if (filePath.startsWith('/')) {
    filePath = pathToFileURL(filePath).toString();
  }
  return filePath;
}

export function convertToFilePath(fileUrl: string) {
  // Parse the file URL
  const parsedUrl = url.parse(fileUrl);
  // Decode the URL-encoded path
  const filePath = decodeURIComponent(parsedUrl.path);
  // Return the file path without the 'file://' prefix
  return filePath;
}
