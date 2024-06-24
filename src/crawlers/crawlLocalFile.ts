import crawlee, { Request, RequestList } from 'crawlee';
import printMessage from 'print-message';
import {
  createCrawleeSubFolders,
  preNavigationHooks,
  runAxeScript,
  failedRequestHandler,
  isUrlPdf,
} from './commonCrawlerFunc.js';
import constants, { guiInfoStatusTypes, basicAuthRegex } from '../constants/constants.js';
import {
  getLinksFromSitemap,
  getPlaywrightLaunchOptions,
  messageOptions,
  isSkippedUrl,
  isFilePath,
  convertLocalFileToPath,
  convertPathToLocalFile,
} from '../constants/common.js';
import { areLinksEqual, isWhitelistedContentType } from '../utils.js';
import { handlePdfDownload, runPdfScan, mapPdfScanResults } from './pdfScanFunc.js';
import fs from 'fs';
import { guiInfoLog } from '../logs.js';
import playwright from 'playwright';
import path from 'path';
import crawlSitemap from './crawlSitemap.js';

const crawlLocalFile = async (
  sitemapUrl: string,
  randomToken: string,
  host: string,
  viewportSettings: any,
  maxRequestsPerCrawl: number,
  browser: string,
  userDataDirectory: string,
  specifiedMaxConcurrency: number,
  fileTypes: string,
  blacklistedPatterns: string[],
  includeScreenshots: boolean,
  extraHTTPHeaders: any,
  fromCrawlIntelligentSitemap: boolean = false, //optional
  userUrlInputFromIntelligent: any = null, //optional
  datasetFromIntelligent: any = null, //optional
  urlsCrawledFromIntelligent: any = null, //optional
) => {
  let dataset: any;
  let urlsCrawled: any;
  let linksFromSitemap = [];

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

    if (!fs.existsSync(randomToken)) {
      fs.mkdirSync(randomToken);
    }
  }

  // Check if the sitemapUrl is a local file and if it exists
  if (!(isFilePath(sitemapUrl)) || !fs.existsSync(sitemapUrl)) {
    return;
  }

  // Checks if its in the right file format, and change it before placing into linksFromSitemap
  convertLocalFileToPath(sitemapUrl);

  // XML Files
  if (!(sitemapUrl.match(/\.xml$/i) || sitemapUrl.match(/\.txt$/i))) {
    linksFromSitemap = [new Request({ url: sitemapUrl })];
  // Non XML file
  } else {
    const username = '';
    const password = '';

    // Put it to crawlSitemap function to handle xml files
    const updatedUrlsCrawled = await crawlSitemap(
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
      (fromCrawlIntelligentSitemap = false), //optional
      (userUrlInputFromIntelligent = null), //optional
      (datasetFromIntelligent = null), //optional
      (urlsCrawledFromIntelligent = null), //optional
      true,
    );
    
    urlsCrawled = { ...urlsCrawled, ...updatedUrlsCrawled };
    return urlsCrawled;
  }

  try {
    sitemapUrl = encodeURI(sitemapUrl);
  } catch (e) {
    console.log(e);
  }

  if (basicAuthRegex.test(sitemapUrl)) {
    isBasicAuth = true;
    // request to basic auth URL to authenticate for browser session
    finalLinks.push(new Request({ url: sitemapUrl, uniqueKey: `auth:${sitemapUrl}` }));
    const finalUrl = `${sitemapUrl.split('://')[0]}://${sitemapUrl.split('@')[1]}`;
    // obtain base URL without credentials so that subsequent URLs within the same domain can be scanned
    finalLinks.push(new Request({ url: finalUrl }));
    basicAuthPage = -2;
  }

  let uuidToPdfMapping: Record<string, string> = {}; //key and value of string type
  const isScanHtml: boolean = ['all', 'html-only'].includes(fileTypes);

  printMessage(['Fetching URLs. This might take some time...'], { border: false });

  finalLinks = [...finalLinks, ...linksFromSitemap];

  const requestList = await RequestList.open({
    sources: finalLinks,
  });

  printMessage(['Fetch URLs completed. Beginning scan'], messageOptions);

  const request = linksFromSitemap[0];
  const pdfFileName = path.basename(request.url);
  const trimmedUrl: string = request.url;
  const destinationFilePath: string = `${randomToken}/${pdfFileName}`;
  const data: Buffer = fs.readFileSync(trimmedUrl);
  fs.writeFileSync(destinationFilePath, data);
  uuidToPdfMapping[pdfFileName] = trimmedUrl;

  if (!isUrlPdf(request.url)) {
    const browserContext = await constants.launcher.launchPersistentContext('', {
      headless: process.env.CRAWLEE_HEADLESS === '1',
      ...getPlaywrightLaunchOptions(browser),
      ...playwrightDeviceDetailsObject,
    });
  
    const page = await browserContext.newPage();
    request.url = convertPathToLocalFile(request.url);
    await page.goto(request.url);
    const results = await runAxeScript(includeScreenshots, page, randomToken, null);
    
    guiInfoLog(guiInfoStatusTypes.SCANNED, {
      numScanned: urlsCrawled.scanned.length,
      urlScanned: request.url,
    });

    urlsCrawled.scanned.push({
      url: request.url,
      pageTitle: results.pageTitle,
      actualUrl: request.loadedUrl, // i.e. actualUrl
    });

    urlsCrawled.scannedRedirects.push({
      fromUrl: request.url,
      toUrl: request.loadedUrl, // i.e. actualUrl
    });

    results.url = request.url;
    // results.actualUrl = request.loadedUrl;

    await dataset.pushData(results);
  } else {
    urlsCrawled.scanned.push({ url: trimmedUrl, pageTitle: pdfFileName });

    await runPdfScan(randomToken);
    // transform result format
    const pdfResults = await mapPdfScanResults(randomToken, uuidToPdfMapping);

    // push results for each pdf document to key value store
    await Promise.all(pdfResults.map(result => dataset.pushData(result)));
  }
  return urlsCrawled;
};
export default crawlLocalFile;