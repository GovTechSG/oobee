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
import { minimatch } from 'minimatch';
import { globSync, GlobOptionsWithFileTypesFalse } from 'glob';
import { LaunchOptions, Locator, Page, devices, webkit } from 'playwright';
import printMessage from 'print-message';
import constants, {
  getDefaultChromeDataDir,
  getDefaultEdgeDataDir,
  getDefaultChromiumDataDir,
  proxy,
  // Legacy code start - Google Sheets submission
  formDataFields,
  // Legacy code end - Google Sheets submission
  ScannerTypes,
  BrowserTypes,
} from './constants.js';
import { silentLogger } from '../logs.js';
import { isUrlPdf } from '../crawlers/commonCrawlerFunc.js';
import { randomThreeDigitNumberString } from '../utils.js';
import { Answers, Data } from '../index.js';
import { DeviceDescriptor } from '../types/types.js';

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
    throw new Error(`Please ensure path provided exists: ${absolutePath}`);
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
  protocols: ['http', 'https'],
  require_protocol: true,
  require_tld: false,
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

// Refer to NPM validator's special characters under sanitizers for escape()
const blackListCharacters = '\\<>&\'"';

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
  if (validator.isURL(sanitizeUrl, urlOptions)) {
    return { isValid: true, url: sanitizeUrl };
  }
  return { isValid: false, url: sanitizeUrl };
};

const requestToUrl = async (
  url: string,
  isCustomFlow: boolean,
  extraHTTPHeaders: Record<string, string>,
) => {
  // User-Agent is modified to emulate a browser to handle cases where some sites ban non browser agents, resulting in a 403 error
  const res = new RES();
  const parsedUrl = new URL(url);
  await axios
    .get(parsedUrl.href, {
      headers: {
        ...extraHTTPHeaders,
        'User-Agent': devices['Desktop Chrome HiDPI'].userAgent,
        Host: parsedUrl.host,
      },
      auth: {
        username: decodeURIComponent(parsedUrl.username),
        password: decodeURIComponent(parsedUrl.password),
      },
      httpsAgent,
      timeout: 5000,
    })
    .then(async response => {
      let redirectUrl = response.request.res.responseUrl;
      redirectUrl = new URL(redirectUrl).href;
      res.status = constants.urlCheckStatuses.success.code;
      let data;
      if (typeof response.data === 'string' || response.data instanceof String) {
        data = response.data;
      } else if (typeof response.data === 'object' && response.data !== null) {
        try {
          data = JSON.stringify(response.data);
        } catch (error) {
          console.log('Error converting object to JSON:', error);
        }
      } else {
        console.log('Unsupported data type:', typeof response.data);
      }
      const modifiedHTML = data.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');

      const metaRefreshMatch =
        /<meta\s+http-equiv="refresh"\s+content="(?:\d+;)?\s*url=(?:'([^']*)'|"([^"]*)"|([^>]*))"/i.exec(
          modifiedHTML,
        );

      const hasMetaRefresh = metaRefreshMatch && metaRefreshMatch.length > 1;

      if (redirectUrl != null && (hasMetaRefresh || !isCustomFlow)) {
        res.url = redirectUrl;
      } else {
        res.url = url;
      }

      if (hasMetaRefresh) {
        let urlOrRelativePath;

        for (let i = 1; i < metaRefreshMatch.length; i++) {
          if (metaRefreshMatch[i] !== undefined && metaRefreshMatch[i] !== null) {
            urlOrRelativePath = metaRefreshMatch[i];
            break; // Stop the loop once the first non-null value is found
          }
        }

        if (urlOrRelativePath.includes('URL=')) {
          res.url = urlOrRelativePath.split('URL=').pop();
        } else {
          const pathname = res.url.substring(0, res.url.lastIndexOf('/'));
          res.url = new URL(urlOrRelativePath, pathname).toString();
        }
      }

      res.content = response.data;
    })
    .catch(async error => {
      if (error.code === 'ECONNABORTED' || error.code === 'ERR_FR_TOO_MANY_REDIRECTS') {
        res.status = constants.urlCheckStatuses.axiosTimeout.code;
      } else if (error.response) {
        if (error.response.status === 401) {
          // enters here if URL is protected by basic auth
          res.status = constants.urlCheckStatuses.unauthorised.code;
        } else {
          // enters here if server responds with a status other than 2xx
          // the scan should still proceed even if error codes are received, so that accessibility scans for error pages can be done too
          res.status = constants.urlCheckStatuses.success.code;
        }
        res.url = url;
        res.content = error.response.data;
        return res;
      } else if (error.request) {
        // enters here if URL cannot be accessed
        res.status = constants.urlCheckStatuses.cannotBeResolved.code;
      } else {
        res.status = constants.urlCheckStatuses.systemError.code;
      }
      silentLogger.error(error);
    });
  return res;
};

const checkUrlConnectivityWithBrowser = async (
  url: string,
  browserToRun: string,
  clonedDataDir: string,
  playwrightDeviceDetailsObject: DeviceDescriptor,
  isCustomFlow: boolean,
  extraHTTPHeaders: Record<string, string>,
) => {
  const res = new RES();

  let viewport = null;
  let userAgent = null;

  if (Object.keys(playwrightDeviceDetailsObject).length > 0) {
    if ('viewport' in playwrightDeviceDetailsObject) {
      viewport = playwrightDeviceDetailsObject.viewport;
    }

    if ('userAgent' in playwrightDeviceDetailsObject) {
      userAgent = playwrightDeviceDetailsObject.userAgent;
    }
  }

  // Validate the connectivity of URL if the string format is url format
  const data = sanitizeUrlInput(url);

  if (data.isValid) {
    let browserContext;

    try {
      // Temporary browserContextLaunchOptions to force headless mode during connectivity check
      // If a user selects cli options h=no, the connectivity check should still proceed in headless
      const launchOptions = getPlaywrightLaunchOptions(browserToRun);
      const browserContextLaunchOptions = {
        ...launchOptions,
        args: [...launchOptions.args, '--headless=new'],
      };

      browserContext = await constants.launcher.launchPersistentContext(clonedDataDir, {
        ...browserContextLaunchOptions,
        ...(viewport && { viewport }),
        ...(userAgent && { userAgent }),
        ...(extraHTTPHeaders && { extraHTTPHeaders }),
      });
    } catch (err) {
      printMessage([`Unable to launch browser\n${err}`], messageOptions);
      res.status = constants.urlCheckStatuses.browserError.code;
      return res;
    }

    // const context = await browser.newContext();
    const page = await browserContext.newPage();

    // method will not throw an error when any valid HTTP status code is returned by the remote server, including 404 "Not Found" and 500 "Internal Server Error".
    // navigation to about:blank or navigation to the same URL with a different hash, which would succeed and return null.
    try {
      // playwright headless mode does not support navigation to pdf document
      if (isUrlPdf(url)) {
        // make http request to url to check
        return await requestToUrl(url, false, extraHTTPHeaders);
      }

      const response = await page.goto(url, {
        timeout: 30000,
        ...(proxy && { waitUntil: 'commit' }),
      });

      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        silentLogger.info('Unable to detect networkidle');
      }

      // This response state doesn't seem to work with the new headless=new flag
      if (response.status() === 401) {
        res.status = constants.urlCheckStatuses.unauthorised.code;
      } else {
        res.status = constants.urlCheckStatuses.success.code;
      }

      // set redirect link or final url
      if (isCustomFlow) {
        res.url = url;
      } else {
        res.url = page.url();
      }

      res.content = await page.content();

      const contentType = response?.headers?.()['content-type'] || '';
      if (contentType.includes('xml')) {
        const responseFromUrl = await requestToUrl(res.url, true, extraHTTPHeaders);

        res.content = responseFromUrl.content;
      }
    } catch (error) {
      // But this does work with the headless=new flag
      if (error.message.includes('net::ERR_INVALID_AUTH_CREDENTIALS')) {
        res.status = constants.urlCheckStatuses.unauthorised.code;
      } else {
        // enters here if input is not a URL or not using http/https protocols
        res.status = constants.urlCheckStatuses.systemError.code;
      }
    } finally {
      await browserContext.close();
    }
  } else {
    // enters here if input is not a URL or not using http/https protocols
    res.status = constants.urlCheckStatuses.invalidUrl.code;
  }

  return res;
};

export const isSitemapContent = (content: string) => {
  const { isValid } = validateXML(content);
  if (isValid) {
    return true;
  }

  const regexForHtml = new RegExp('<(?:!doctype html|html|head|body)+?>', 'gmi');
  const regexForXmlSitemap = new RegExp('<(?:urlset|feed|rss)+?.*>', 'gmi');
  const regexForUrl = new RegExp('^.*(http|https):/{2}.*$', 'gmi');

  if (content.match(regexForHtml) && content.match(regexForXmlSitemap)) {
    // is an XML sitemap wrapped in a HTML document
    return true;
  }
  if (!content.match(regexForHtml) && content.match(regexForUrl)) {
    // treat this as a txt sitemap where all URLs will be extracted for crawling
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
  isCustomFlow: boolean,
  extraHTTPHeaders: Record<string, string>,
) => {
  const res = await checkUrlConnectivityWithBrowser(
    url,
    browser,
    clonedDataDir,
    playwrightDeviceDetailsObject,
    isCustomFlow,
    extraHTTPHeaders,
  );

  if (
    res.status === constants.urlCheckStatuses.success.code &&
    (scanner === ScannerTypes.SITEMAP || scanner === ScannerTypes.LOCALFILE)
  ) {
    const isSitemap = isSitemapContent(res.content);

    if (!isSitemap && scanner === ScannerTypes.LOCALFILE) {
      res.status = constants.urlCheckStatuses.notALocalFile.code;
    } else if (!isSitemap) {
      res.status = constants.urlCheckStatuses.notASitemap.code;
    }
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
      process.exit(1);
    }
    allHeaders[headerValuePair[0]] = headerValuePair[1]; // {"header": "value", "header2": "value2", ...}
  });
  return allHeaders;
};

export const prepareData = async (argv: Answers): Promise<Data> => {
  if (isEmptyObject(argv)) {
    throw Error('No inputs should be provided');
  }
  const {
    scanner,
    headless,
    url,
    deviceChosen,
    customDevice,
    viewportWidth,
    playwrightDeviceDetailsObject,
    maxpages,
    strategy,
    isLocalFileScan,
    finalUrl,
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
    zip,
    ruleset,
    generateJsonFiles,
  } = argv;

  // construct filename for scan results
  const [date, time] = new Date().toLocaleString('sv').replaceAll(/-|:/g, '').split(' ');
  const domain = argv.isLocalFileScan ? path.basename(argv.url) : new URL(argv.url).hostname;
  const sanitisedLabel = customFlowLabel ? `_${customFlowLabel.replaceAll(' ', '_')}` : '';
  let resultFilename: string;
  const randomThreeDigitNumber = randomThreeDigitNumberString();
  if (process.env.OOBEE_VERBOSE) {
    resultFilename = `${date}_${time}${sanitisedLabel}_${domain}_${randomThreeDigitNumber}`;
  } else {
    resultFilename = `${date}_${time}${sanitisedLabel}_${domain}`;
  }

  if (followRobots) {
    constants.robotsTxtUrls = {};
    await getUrlsFromRobotsTxt(url, browserToRun);
  }

  return {
    type: scanner,
    url: finalUrl,
    entryUrl: url,
    isHeadless: headless,
    deviceChosen,
    customDevice,
    viewportWidth,
    playwrightDeviceDetailsObject,
    maxRequestsPerCrawl: maxpages || constants.maxRequestsPerCrawl,
    strategy:
      strategy === 'same-hostname' ? EnqueueStrategy.SameHostname : EnqueueStrategy.SameDomain,
    isLocalFileScan,
    browser: browserToRun,
    nameEmail,
    customFlowLabel,
    specifiedMaxConcurrency,
    randomToken: resultFilename,
    fileTypes,
    blacklistedPatternsFilename,
    includeScreenshots: !(additional === 'none'),
    metadata,
    followRobots,
    extraHTTPHeaders: parseHeaders(header),
    safeMode,
    zip,
    ruleset,
    generateJsonFiles,
  };
};

export const getUrlsFromRobotsTxt = async (url: string, browserToRun: string): Promise<void> => {
  if (!constants.robotsTxtUrls) return;

  const domain = new URL(url).origin;
  if (constants.robotsTxtUrls[domain]) return;
  const robotsUrl = domain.concat('/robots.txt');

  let robotsTxt: string;
  try {
    if (proxy) {
      robotsTxt = await getRobotsTxtViaPlaywright(robotsUrl, browserToRun);
    } else {
      robotsTxt = await getRobotsTxtViaAxios(robotsUrl);
    }
  } catch (e) {
    silentLogger.info(e);
  }
  console.log('robotsTxt', robotsTxt);
  if (!robotsTxt) {
    constants.robotsTxtUrls[domain] = {};
    return;
  }

  console.log('Found robots.txt: ', robotsUrl);

  const lines = robotsTxt.split(/\r?\n/);
  let shouldCapture = false;
  const disallowedUrls = [];
  const allowedUrls = [];

  const sanitisePattern = (pattern: string): string => {
    const directoryRegex = /^\/(?:[^?#/]+\/)*[^?#]*$/;
    const subdirWildcardRegex = /\/\*\//g;
    const filePathRegex = /^\/(?:[^\/]+\/)*[^\/]+\.[a-zA-Z0-9]{1,6}$/;

    if (subdirWildcardRegex.test(pattern)) {
      pattern = pattern.replace(subdirWildcardRegex, '/**/');
    }
    if (pattern.match(directoryRegex) && !pattern.match(filePathRegex)) {
      if (pattern.endsWith('*')) {
        pattern = pattern.concat('*');
      } else {
        if (!pattern.endsWith('/')) pattern = pattern.concat('/');
        pattern = pattern.concat('**');
      }
    }
    const final = domain.concat(pattern);
    return final;
  };

  for (const line of lines) {
    if (line.toLowerCase().startsWith('user-agent: *')) {
      shouldCapture = true;
    } else if (line.toLowerCase().startsWith('user-agent:') && shouldCapture) {
      break;
    } else if (shouldCapture && line.toLowerCase().startsWith('disallow:')) {
      let disallowed = line.substring('disallow: '.length).trim();
      if (disallowed) {
        disallowed = sanitisePattern(disallowed);
        disallowedUrls.push(disallowed);
      }
    } else if (shouldCapture && line.toLowerCase().startsWith('allow:')) {
      let allowed = line.substring('allow: '.length).trim();
      if (allowed) {
        allowed = sanitisePattern(allowed);
        allowedUrls.push(allowed);
      }
    }
  }
  constants.robotsTxtUrls[domain] = { disallowedUrls, allowedUrls };
};

const getRobotsTxtViaPlaywright = async (robotsUrl: string, browser: string): Promise<string> => {
  const browserContext = await constants.launcher.launchPersistentContext('', {
    ...getPlaywrightLaunchOptions(browser),
  });

  const page = await browserContext.newPage();
  await page.goto(robotsUrl, { waitUntil: 'networkidle', timeout: 30000 });

  const robotsTxt: string | null = await page.evaluate(() => document.body.textContent);
  return robotsTxt;
};

const getRobotsTxtViaAxios = async (robotsUrl: string): Promise<string> => {
  const instance = axios.create({
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
    }),
  });

  const robotsTxt = (await (await instance.get(robotsUrl, { timeout: 2000 })).data) as string;
  return robotsTxt;
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
  maxLinksCount: number,
  browser: string,
  userDataDirectory: string,
  userUrlInput: string,
  isIntelligent: boolean,
  username: string,
  password: string,
) => {
  const scannedSitemaps = new Set<string>();
  const urls: Record<string, Request> = {}; // dictionary of requests to urls to be scanned

  const isLimitReached = () => Object.keys(urls).length >= maxLinksCount;

  const addToUrlList = (url: string) => {
    if (!url) return;
    if (isDisallowedInRobotsTxt(url)) return;

    // add basic auth credentials to the URL
    username !== '' && password !== ''
      ? (url = addBasicAuthCredentials(url, username, password))
      : url;

    url = convertPathToLocalFile(url);

    let request;
    try {
      request = new Request({ url });
    } catch (e) {
      console.log('Error creating request', e);
    }
    if (isUrlPdf(url)) {
      request.skipNavigation = true;
    }
    urls[url] = request;
  };

  const addBasicAuthCredentials = (url: string, username: string, password: string) => {
    const urlObject = new URL(url);
    urlObject.username = username;
    urlObject.password = password;
    return urlObject.toString();
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

    // Add the sorted URLs to the main URL list
    for (const { url } of urlList.slice(0, maxLinksCount)) {
      addToUrlList(url);
    }
  };

  const processNonStandardSitemap = (data: string) => {
    const urlsFromData = crawlee
      .extractUrls({ string: data, urlRegExp: new RegExp('^(http|https):/{2}.+$', 'gmi') })
      .slice(0, maxLinksCount);
    urlsFromData.forEach(url => {
      addToUrlList(url);
    });
  };

  let finalUserDataDirectory = userDataDirectory;
  if (userDataDirectory === null || userDataDirectory === undefined) {
    finalUserDataDirectory = '';
  }

  const fetchUrls = async (url: string) => {
    let data;
    let sitemapType;
    let isBasicAuth = false;

    let username = '';
    let password = '';

    let parsedUrl;

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
      parsedUrl = url;
    } else if (isValidHttpUrl(url)) {
      parsedUrl = new URL(url);

      if (parsedUrl.username !== '' && parsedUrl.password !== '') {
        isBasicAuth = true;
        username = decodeURIComponent(parsedUrl.username);
        password = decodeURIComponent(parsedUrl.password);
        parsedUrl.username = '';
        parsedUrl.password = '';
      }
    } else {
      printMessage([`Invalid Url/Filepath: ${url}`], messageOptions);
      return;
    }

    const getDataUsingPlaywright = async () => {
      const browserContext = await constants.launcher.launchPersistentContext(
        finalUserDataDirectory,
        {
          ...getPlaywrightLaunchOptions(browser),
          // Not necessary to parse http_credentials as I am parsing it directly in URL
        },
      );

      const page = await browserContext.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      if (constants.launcher === webkit) {
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

      await browserContext.close();
    };

    if (validator.isURL(url, urlOptions)) {
      if (isUrlPdf(url)) {
        addToUrlList(url);
        return;
      }
      if (proxy) {
        await getDataUsingPlaywright();
      } else {
        try {
          const instance = axios.create({
            httpsAgent: new https.Agent({
              rejectUnauthorized: false,
              keepAlive: true,
            }),
            auth: {
              username,
              password,
            },
          });
          try {
            data = await (await instance.get(url, { timeout: 80000 })).data;
          } catch {
            return; // to skip the error
          }
        } catch (error) {
          if (error.code === 'ECONNABORTED') {
            await getDataUsingPlaywright();
          }
        }
      }
    } else {
      url = convertLocalFileToPath(url);
      data = fs.readFileSync(url, 'utf8');
    }
    const $ = cheerio.load(data, { xml: true });

    // This case is when the document is not an XML format document
    if ($(':root').length === 0) {
      processNonStandardSitemap(data);
      return;
    }

    // Root element
    const root = $(':root')[0];

    const { xmlns } = root.attribs;

    const xmlFormatNamespace = '/schemas/sitemap';
    if (root.name === 'urlset' && xmlns.includes(xmlFormatNamespace)) {
      sitemapType = constants.xmlSitemapTypes.xml;
    } else if (root.name === 'sitemapindex' && xmlns.includes(xmlFormatNamespace)) {
      sitemapType = constants.xmlSitemapTypes.xmlIndex;
    } else if (root.name === 'rss') {
      sitemapType = constants.xmlSitemapTypes.rss;
    } else if (root.name === 'feed') {
      sitemapType = constants.xmlSitemapTypes.atom;
    } else {
      sitemapType = constants.xmlSitemapTypes.unknown;
    }

    switch (sitemapType) {
      case constants.xmlSitemapTypes.xmlIndex:
        silentLogger.info(`This is a XML format sitemap index.`);
        for (const childSitemapUrl of $('loc')) {
          const childSitemapUrlText = $(childSitemapUrl).text();
          if (isLimitReached()) {
            break;
          }
          if (childSitemapUrlText.endsWith('.xml') || childSitemapUrlText.endsWith('.txt')) {
            await fetchUrls(childSitemapUrlText); // Recursive call for nested sitemaps
          } else {
            addToUrlList(childSitemapUrlText); // Add regular URLs to the list
          }
        }
        break;
      case constants.xmlSitemapTypes.xml:
        silentLogger.info(`This is a XML format sitemap.`);
        await processXmlSitemap($, sitemapType, 'loc', 'lastmod', 'url');
        break;
      case constants.xmlSitemapTypes.rss:
        silentLogger.info(`This is a RSS format sitemap.`);
        await processXmlSitemap($, sitemapType, 'link', 'pubDate', 'item');
        break;
      case constants.xmlSitemapTypes.atom:
        silentLogger.info(`This is a Atom format sitemap.`);
        await processXmlSitemap($, sitemapType, 'link', 'published', 'entry');
        break;
      default:
        silentLogger.info(`This is an unrecognised XML sitemap format.`);
        processNonStandardSitemap(data);
    }
  };

  try {
    await fetchUrls(sitemapUrl);
  } catch (e) {
    silentLogger.error(e);
  }

  const requestList = Object.values(urls);

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
  preferredBrowser: BrowserTypes,
  isCli = false,
): { browserToRun: BrowserTypes; clonedBrowserDataDir: string } => {
  const platform = os.platform();

  // Prioritise Chrome on Windows and Mac platforms if user does not specify a browser
  if (!preferredBrowser && (os.platform() === 'win32' || os.platform() === 'darwin')) {
    preferredBrowser = BrowserTypes.CHROME;
  }

  printMessage([`Preferred browser ${preferredBrowser}`], messageOptions);

  if (preferredBrowser === BrowserTypes.CHROME) {
    const chromeData = getChromeData();
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

      const edgeData = getEdgeData();
      if (edgeData) return edgeData;

      if (isCli)
        printMessage(['Unable to use both Chrome and Edge. Please try again.'], messageOptions);
      process.exit(constants.urlCheckStatuses.browserError.code);
    }

    if (isCli) {
      printMessage(['Unable to use Chrome, falling back to Chromium browser...'], messageOptions);
    }
  } else if (preferredBrowser === BrowserTypes.EDGE) {
    const edgeData = getEdgeData();
    if (edgeData) return edgeData;

    if (isCli)
      printMessage(['Unable to use Edge, falling back to Chrome browser...'], messageOptions);
    const chromeData = getChromeData();
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
    clonedBrowserDataDir: cloneChromiumProfiles(),
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

export const getChromeData = () => {
  const browserDataDir = getDefaultChromeDataDir();
  const clonedBrowserDataDir = cloneChromeProfiles();
  if (browserDataDir && clonedBrowserDataDir) {
    const browserToRun = BrowserTypes.CHROME;
    return { browserToRun, clonedBrowserDataDir };
  }
  return null;
};

export const getEdgeData = () => {
  const browserDataDir = getDefaultEdgeDataDir();
  const clonedBrowserDataDir = cloneEdgeProfiles();
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
const cloneChromeProfileCookieFiles = (options: GlobOptionsWithFileTypesFalse, destDir: string) => {
  let profileCookiesDir;
  // Cookies file per profile is located in .../User Data/<profile name>/Network/Cookies for windows
  // and ../Chrome/<profile name>/Cookies for mac
  let profileNamesRegex: RegExp;
  if (os.platform() === 'win32') {
    profileCookiesDir = globSync('**/Network/Cookies', {
      ...options,
      ignore: ['oobee/**'],
    });
    profileNamesRegex = /User Data\\(.*?)\\Network/;
  } else if (os.platform() === 'darwin') {
    // maxDepth 2 to avoid copying cookies from the oobee directory if it exists
    profileCookiesDir = globSync('**/Cookies', {
      ...options,
      ignore: 'oobee/**',
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
          try {
            fs.copyFileSync(dir, path.join(destProfileDir, 'Cookies'));
          } catch (err) {
            silentLogger.error(err);
            if (err.code === 'EBUSY') {
              console.log(
                `Unable to copy the file for ${profileName} because it is currently in use.`,
              );
              console.log(
                'Please close any applications that might be using this file and try again.',
              );
            } else {
              console.log(
                `An unexpected error occurred for ${profileName} while copying the file: ${err.message}`,
              );
            }
            // printMessage([err], messageOptions);
            success = false;
          }
        }
      }
    });
    return success;
  }

  silentLogger.warn('Unable to find Chrome profile cookies file in the system.');
  printMessage(['Unable to find Chrome profile cookies file in the system.'], messageOptions);
  return false;
};

/**
 * Clone the Chrome profile cookie files to the destination directory
 * @param {*} options glob options object
 * @param {*} destDir destination directory
 * @returns boolean indicating whether the operation was successful
 */
const cloneEdgeProfileCookieFiles = (options: GlobOptionsWithFileTypesFalse, destDir: string) => {
  let profileCookiesDir;
  // Cookies file per profile is located in .../User Data/<profile name>/Network/Cookies for windows
  // and ../Chrome/<profile name>/Cookies for mac
  let profileNamesRegex: RegExp;
  // Ignores the cloned oobee directory if exists
  if (os.platform() === 'win32') {
    profileCookiesDir = globSync('**/Network/Cookies', {
      ...options,
      ignore: 'oobee/**',
    });
    profileNamesRegex = /User Data\\(.*?)\\Network/;
  } else if (os.platform() === 'darwin') {
    // Ignores copying cookies from the oobee directory if it exists
    profileCookiesDir = globSync('**/Cookies', {
      ...options,
      ignore: 'oobee/**',
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
          try {
            fs.copyFileSync(dir, path.join(destProfileDir, 'Cookies'));
          } catch (err) {
            silentLogger.error(err);
            if (err.code === 'EBUSY') {
              console.log(
                `Unable to copy the file for ${profileName} because it is currently in use.`,
              );
              console.log(
                'Please close any applications that might be using this file and try again.',
              );
            } else {
              console.log(`An unexpected error occurred while copying the file: ${err.message}`);
            }
            // printMessage([err], messageOptions);
            success = false;
          }
        }
      }
    });
    return success;
  }
  silentLogger.warn('Unable to find Edge profile cookies file in the system.');
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
      try {
        fs.copyFileSync(dir, path.join(destDir, 'Local State'));
      } catch (err) {
        silentLogger.error(err);
        if (err.code === 'EBUSY') {
          console.log(`Unable to copy the file because it is currently in use.`);
          console.log('Please close any applications that might be using this file and try again.');
        } else {
          console.log(
            `An unexpected error occurred for ${profileName} while copying the file: ${err.message}`,
          );
        }
        printMessage([err], messageOptions);
        success = false;
      }
    });
    return success;
  }
  silentLogger.warn('Unable to find local state file in the system.');
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
export const cloneChromeProfiles = (randomToken?: string): string => {
  const baseDir = getDefaultChromeDataDir();

  if (!baseDir) {
    return;
  }

  let destDir;

  if (randomToken) {
    destDir = path.join(baseDir, `oobee-${randomToken}`);
  } else {
    destDir = path.join(baseDir, 'oobee');
  }

  if (fs.existsSync(destDir)) {
    if (process.env.OOBEE_VERBOSE) {
      deleteClonedChromeProfiles(randomToken);
    } else {
      deleteClonedChromeProfiles();
    }
  }

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

  return null;
};

export const cloneChromiumProfiles = (randomToken?: string): string => {
  const baseDir = getDefaultChromiumDataDir();

  if (!baseDir) {
    return;
  }

  let destDir: string;

  if (randomToken) {
    destDir = path.join(baseDir, `oobee-${randomToken}`);
  } else {
    destDir = path.join(baseDir, 'oobee');
  }

  if (!fs.existsSync(destDir)) {
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
export const cloneEdgeProfiles = (randomToken?: string): string => {
  const baseDir = getDefaultEdgeDataDir();

  if (!baseDir) {
    return;
  }

  let destDir;

  if (randomToken) {
    destDir = path.join(baseDir, `oobee-${randomToken}`);
  } else {
    destDir = path.join(baseDir, 'oobee');
  }

  if (fs.existsSync(destDir)) {
    if (process.env.OOBEE_VERBOSE) {
      deleteClonedEdgeProfiles(randomToken);
    } else {
      deleteClonedEdgeProfiles();
    }
  }

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

  return null;
};

export const deleteClonedProfiles = (browser: string, randomToken?: string): void => {
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
          silentLogger.error(
            `CHROME Unable to delete ${dir} folder in the Chrome data directory. ${err}`,
          );
        }
      }
    });
    return;
  }

  silentLogger.warn('Unable to find oobee directory in the Chrome data directory.');
  console.warn('Unable to find oobee directory in the Chrome data directory.');
};

/**
 * Deletes all the cloned oobee directories in the Edge data directory
 * @returns null
 */
export const deleteClonedEdgeProfiles = (randomToken?: string): void => {
  if (process.env.OOBEE_VERBOSE) {
    return;
  }
  const baseDir = getDefaultEdgeDataDir();

  if (!baseDir) {
    console.warn(`Unable to find Edge data directory in the system.`);
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
          silentLogger.error(
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
          silentLogger.error(
            `CHROMIUM Unable to delete ${dir} folder in the Chromium data directory. ${err}`,
          );
        }
      }
    });
    return;
  }

  silentLogger.warn('Unable to find oobee directory in Chromium support directory');
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
  const dirName = `clone-${Date.now()}`;
  let clonedDir = null;
  if (proxy && browserToRun === BrowserTypes.EDGE) {
    clonedDir = cloneEdgeProfiles(dirName);
  } else if (proxy && browserToRun === BrowserTypes.CHROME) {
    clonedDir = cloneChromeProfiles(dirName);
  }
  const browserContext = await constants.launcher.launchPersistentContext(
    clonedDir || userDataDirectory,
    {
      ...getPlaywrightLaunchOptions(browserToRun),
    },
  );

  const page = await browserContext.newPage();

  try {
    await page.goto(finalUrl, {
      timeout: 30000,
      ...(proxy && { waitUntil: 'commit' }),
    });

    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      silentLogger.info('Unable to detect networkidle');
    }
  } catch (error) {
    silentLogger.error(error);
  } finally {
    await browserContext.close();
    if (proxy && browserToRun === BrowserTypes.EDGE) {
      if (!process.env.OOBEE_VERBOSE) {
        deleteClonedEdgeProfiles();
      }
    } else if (proxy && browserToRun === BrowserTypes.CHROME) {
      if (!process.env.OOBEE_VERBOSE) {
        deleteClonedChromeProfiles();
      }
    }
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

  if (proxy) {
    await submitFormViaPlaywright(browserToRun, userDataDirectory, finalUrl);
  } else {
    try {
      await axios.get(finalUrl, { timeout: 2000 });
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        if (browserToRun || constants.launcher === webkit) {
          await submitFormViaPlaywright(browserToRun, userDataDirectory, finalUrl);
        }
      }
    }
  }
};
// Legacy code end - Google Sheets submission

export async function initModifiedUserAgent(
  browser?: string,
  playwrightDeviceDetailsObject?: object,
) {
  const isHeadless = process.env.CRAWLEE_HEADLESS === '1';

  // If headless mode is enabled, ensure the headless flag is set.
  if (isHeadless && !constants.launchOptionsArgs.includes('--headless=new')) {
    constants.launchOptionsArgs.push('--headless=new');
  }

  // Build the launch options using your production settings.
  // headless is forced to false as in your persistent context, and we merge in getPlaywrightLaunchOptions and device details.
  const launchOptions = {
    headless: false,
    ...getPlaywrightLaunchOptions(browser),
    ...playwrightDeviceDetailsObject,
  };

  // Launch a temporary persistent context with an empty userDataDir to mimic your production browser setup.
  const browserContext = await constants.launcher.launchPersistentContext('', launchOptions);
  const page = await browserContext.newPage();

  // Retrieve the default user agent.
  const defaultUA = await page.evaluate(() => navigator.userAgent);
  await browserContext.close();

  // Modify the UA:
  // Replace "HeadlessChrome" with "Chrome" if present.
  const modifiedUA = defaultUA.includes('HeadlessChrome')
    ? defaultUA.replace('HeadlessChrome', 'Chrome')
    : defaultUA;

  // Push the modified UA flag into your global launch options.
  constants.launchOptionsArgs.push(`--user-agent=${modifiedUA}`);
  // Optionally log the modified UA.
  // console.log('Modified User Agent:', modifiedUA);
}

/**
 * @param {string} browser browser name ("chrome" or "edge", null for chromium, the default Playwright browser)
 * @returns playwright launch options object. For more details: https://playwright.dev/docs/api/class-browsertype#browser-type-launch
 */
export const getPlaywrightLaunchOptions = (browser?: string): LaunchOptions => {
  let channel: string;
  if (browser) {
    channel = browser;
  }

  // Set new headless mode as Chrome 132 does not support headless=old
  if (process.env.CRAWLEE_HEADLESS === '1') constants.launchOptionsArgs.push('--headless=new');

  const options: LaunchOptions = {
    // Drop the --use-mock-keychain flag to allow MacOS devices
    // to use the cloned cookies.
    ignoreDefaultArgs: ['--use-mock-keychain', '--headless'],
    // necessary from Chrome 132 to use our own headless=new flag
    args: constants.launchOptionsArgs,
    headless: false,
    ...(channel && { channel }), // Having no channel is equivalent to "chromium"
  };

  // Necessary as Chrome 132 does not support headless=old
  options.headless = false;

  if (proxy) {
    options.slowMo = 1000; // To ensure server-side rendered proxy page is loaded
  } else if (browser === BrowserTypes.EDGE && os.platform() === 'win32') {
    // edge should be in non-headless mode
    options.headless = false;
  }
  return options;
};

export const urlWithoutAuth = (url: string): string => {
  const parsedUrl = new URL(url);
  parsedUrl.username = '';
  parsedUrl.password = '';
  return parsedUrl.toString();
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
        const MAX_MUTATIONS = 250;
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
          subtree:   true,
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
    url.startsWith('file://') ||
    url.startsWith('/') ||
    driveLetterPattern.test(url) ||
    backslashPattern.test(url)
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
