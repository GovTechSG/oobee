import { Request, RequestList, Dataset } from 'crawlee';
import fs from 'fs';
import path from 'path';
import { createCrawleeSubFolders, runAxeScript, isUrlPdf } from './commonCrawlerFunc.js';
import constants, {
  guiInfoStatusTypes,
  basicAuthRegex,
  UrlsCrawled,
  STATUS_CODE_METADATA,
} from '../constants/constants.js';
import { ViewportSettingsClass } from '../combine.js';
import {
  getPlaywrightLaunchOptions,
  isFilePath,
  convertLocalFileToPath,
  convertPathToLocalFile,
} from '../constants/common.js';
import { runPdfScan, mapPdfScanResults, doPdfScreenshots } from './pdfScanFunc.js';
import { guiInfoLog } from '../logs.js';
import crawlSitemap from './crawlSitemap.js';
import { getPdfStoragePath, getStoragePath, register } from '../utils.js';

export const crawlLocalFile = async ({
  url,
  randomToken,
  host,
  viewportSettings,
  maxRequestsPerCrawl,
  browser,
  userDataDirectory,
  specifiedMaxConcurrency,
  fileTypes,
  blacklistedPatterns,
  includeScreenshots,
  extraHTTPHeaders,
  scanDuration = 0,
  fromCrawlIntelligentSitemap = false,
  userUrlInputFromIntelligent = null,
  datasetFromIntelligent = null,
  urlsCrawledFromIntelligent = null,
}: {
  url: string;
  randomToken: string;
  host: string;
  viewportSettings: ViewportSettingsClass;
  maxRequestsPerCrawl: number;
  browser: string;
  userDataDirectory: string;
  specifiedMaxConcurrency: number;
  fileTypes: string;
  blacklistedPatterns: string[];
  includeScreenshots: boolean;
  extraHTTPHeaders: Record<string, string>;
  scanDuration?: number;
  fromCrawlIntelligentSitemap?: boolean;
  userUrlInputFromIntelligent?: string | null;
  datasetFromIntelligent?: Dataset | null;
  urlsCrawledFromIntelligent?: UrlsCrawled | null;
}) => {
  let dataset: any;
  let urlsCrawled: UrlsCrawled;
  let linksFromSitemap = [];
  let sitemapUrl: string; 

  // Boolean to omit axe scan for basic auth URL
  let isBasicAuth: boolean;
  let basicAuthPage: number = 0;
  let finalLinks: Request[] = [];
  const { playwrightDeviceDetailsObject } = viewportSettings;

  if (fromCrawlIntelligentSitemap) {
    dataset = datasetFromIntelligent;
    urlsCrawled = urlsCrawledFromIntelligent;
  } else {
    ({ dataset } = await createCrawleeSubFolders(randomToken));
    urlsCrawled = { ...constants.urlsCrawledObj };

  }

  // Checks if its in the right file format, and change it before placing into linksFromSitemap
  url = convertLocalFileToPath(url);

  // Check if the sitemapUrl is a local file and if it exists
  if (!fs.existsSync(url) && !isFilePath(url)) {
    // Convert to an absolute path
    let normalizedPath = path.resolve(url);

    // Normalize the path to handle different path separators
    normalizedPath = path.normalize(normalizedPath);

    // Check if the normalized path exists
    if (!fs.existsSync(normalizedPath)) {
      return;
    }

    // At this point, normalizedPath is a valid and existing file path
    url = normalizedPath;
  }

  // XML Files
  if (!(url.match(/\.xml$/i) || url.match(/\.txt$/i))) {
    linksFromSitemap = [new Request({ url: url })];
    // Non XML file
  } else {
    sitemapUrl = url;
    // Put it to crawlSitemap function to handle xml files
    const updatedUrlsCrawled = await crawlSitemap({
      sitemapUrl,
      randomToken,
      host,
      viewportSettings,
      maxRequestsPerCrawl,
      browser,
      userDataDirectory,
      specifiedMaxConcurrency,
      fileTypes,
      blacklistedPatterns,
      includeScreenshots,
      extraHTTPHeaders,
      scanDuration,
      fromCrawlIntelligentSitemap,
      userUrlInputFromIntelligent,
      datasetFromIntelligent,
      urlsCrawledFromIntelligent,
      crawledFromLocalFile: true,
    });

    urlsCrawled = { ...urlsCrawled, ...updatedUrlsCrawled };
    return urlsCrawled;
  }

  const uuidToPdfMapping: Record<string, string> = {}; // key and value of string type

  finalLinks = [...finalLinks, ...linksFromSitemap];

  await RequestList.open({
    sources: finalLinks,
  });

  const request = linksFromSitemap[0];

  let shouldAbort = false;

  if (!isUrlPdf(url)) {
    const effectiveUserDataDirectory = process.env.CRAWLEE_HEADLESS === '1'
      ? userDataDirectory
      : '';

    const browserContext = await constants.launcher.launchPersistentContext(effectiveUserDataDirectory, {
      headless: process.env.CRAWLEE_HEADLESS === '1',
      ...getPlaywrightLaunchOptions(browser),
      ...playwrightDeviceDetailsObject,
      ...(process.env.OOBEE_DISABLE_BROWSER_DOWNLOAD && { acceptDownloads: false }),
    });

    register(browserContext);

    const timeoutId = scanDuration > 0
    ? setTimeout(() => {
        console.log(`Crawl duration of ${scanDuration}s exceeded. Aborting local file scan.`);
        shouldAbort = true;
      }, scanDuration * 1000)
    : null;

    const page = await browserContext.newPage();
    url = convertPathToLocalFile(url);
    await page.goto(url);

    if (shouldAbort) {
      console.warn('Scan aborted due to timeout before page scan.');
      await dataset.pushData({ scanned: [], scannedRedirects: [] });
      await browserContext.close().catch(() => {});
      return urlsCrawled;
    }

    const results = await runAxeScript({ includeScreenshots, page, randomToken });

    const actualUrl = page.url() || request.loadedUrl || url;

    guiInfoLog(guiInfoStatusTypes.SCANNED, {
      numScanned: urlsCrawled.scanned.length,
      urlScanned: url,
    });

    urlsCrawled.scanned.push({
      url: url,
      pageTitle: results.pageTitle,
      actualUrl: actualUrl, // i.e. actualUrl
    });

    urlsCrawled.scannedRedirects.push({
      fromUrl: url,
      toUrl: actualUrl, // i.e. actualUrl
    });

    results.url = url;
    results.actualUrl = actualUrl;

    await dataset.pushData(results);
  } else {

    const pdfFileName = path.basename(url);
    const destinationFilePath: string = path.join(getPdfStoragePath(randomToken), pdfFileName);
    fs.copyFileSync(url, destinationFilePath);
    uuidToPdfMapping[pdfFileName] = url;

    urlsCrawled.scanned.push({
      url: url,
      pageTitle: pdfFileName,
      actualUrl: url,
    });

    await runPdfScan(randomToken);
    // transform result format
    const pdfResults = await mapPdfScanResults(randomToken, uuidToPdfMapping);

    // get screenshots from pdf docs
    if (includeScreenshots) {
      await Promise.all(pdfResults.map(result => doPdfScreenshots(randomToken, result)));
    }

    // push results for each pdf document to key value store
    await Promise.all(pdfResults.map(result => dataset.pushData(result)));
  }

  return urlsCrawled;
};
export default crawlLocalFile;
