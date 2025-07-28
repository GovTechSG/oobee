import crawlee, { LaunchContext, Request, RequestList, Dataset } from 'crawlee';
import fs from 'fs';
import {
  createCrawleeSubFolders,
  preNavigationHooks,
  runAxeScript,
  isUrlPdf,
} from './commonCrawlerFunc.js';

import constants, {
  STATUS_CODE_METADATA,
  guiInfoStatusTypes,
  UrlsCrawled,
  disallowedListOfPatterns,
} from '../constants/constants.js';
import {
  getLinksFromSitemap,
  getPlaywrightLaunchOptions,
  isSkippedUrl,
  urlWithoutAuth,
  waitForPageLoaded,
  isFilePath,
  initModifiedUserAgent,
} from '../constants/common.js';
import { areLinksEqual, isWhitelistedContentType, isFollowStrategy } from '../utils.js';
import { handlePdfDownload, runPdfScan, mapPdfScanResults } from './pdfScanFunc.js';
import { guiInfoLog } from '../logs.js';
import { ViewportSettingsClass } from '../combine.js';
import * as path from 'path';
import fsp from 'fs/promises';

const crawlSitemap = async ({
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
  scanDuration = 0,
  fromCrawlIntelligentSitemap = false,
  userUrlInputFromIntelligent = null,
  datasetFromIntelligent = null,
  urlsCrawledFromIntelligent = null,
  crawledFromLocalFile = false,
}: {
  sitemapUrl: string;
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
  userUrlInputFromIntelligent?: string;
  datasetFromIntelligent?: Dataset;
  urlsCrawledFromIntelligent?: UrlsCrawled;
  crawledFromLocalFile?: boolean;
}) => {
  const crawlStartTime = Date.now();
  let dataset: crawlee.Dataset;
  let urlsCrawled: UrlsCrawled;

  // Boolean to omit axe scan for basic auth URL
  let isBasicAuth: boolean;
  let basicAuthPage = 0;
  let finalLinks = [];
  let authHeader = '';

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

  let parsedUrl;
  let username = '';
  let password = '';

  if (!crawledFromLocalFile && isFilePath(sitemapUrl)) {
    console.log('Local file crawling not supported for sitemap. Please provide a valid URL.');
    return;
  }

  if (isFilePath(sitemapUrl)) {
    parsedUrl = sitemapUrl;
  } else {
    parsedUrl = new URL(sitemapUrl);
    if (parsedUrl.username !== '' && parsedUrl.password !== '') {
      isBasicAuth = true;
      username = decodeURIComponent(parsedUrl.username);
      password = decodeURIComponent(parsedUrl.password);

      // Create auth header
      authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

      parsedUrl.username = '';
      parsedUrl.password = '';
    }
  }

  const linksFromSitemap = await getLinksFromSitemap(
    sitemapUrl,
    maxRequestsPerCrawl,
    browser,
    userDataDirectory,
    userUrlInputFromIntelligent,
    fromCrawlIntelligentSitemap,
    username,
    password,
    extraHTTPHeaders,
  );
  /**
   * Regex to match http://username:password@hostname.com
   * utilised in scan strategy to ensure subsequent URLs within the same domain are scanned.
   * First time scan with original `url` containing credentials is strictly to authenticate for browser session
   * subsequent URLs are without credentials.
   * basicAuthPage is set to -1 for basic auth URL to ensure it is not counted towards maxRequestsPerCrawl
   */

  sitemapUrl = encodeURI(sitemapUrl);

  if (isBasicAuth) {
    // request to basic auth URL to authenticate for browser session
    finalLinks.push(new Request({ url: sitemapUrl, uniqueKey: `auth:${sitemapUrl}` }));
    const finalUrl = `${sitemapUrl.split('://')[0]}://${sitemapUrl.split('@')[1]}`;

    // obtain base URL without credentials so that subsequent URLs within the same domain can be scanned
    finalLinks.push(new Request({ url: finalUrl }));
    basicAuthPage = -2;
  }

  const pdfDownloads: Promise<void>[] = [];
  const uuidToPdfMapping: Record<string, string> = {};
  const isScanHtml = ['all', 'html-only'].includes(fileTypes);
  const isScanPdfs = ['all', 'pdf-only'].includes(fileTypes);
  const { playwrightDeviceDetailsObject } = viewportSettings;
  const { maxConcurrency } = constants;

  finalLinks = [...finalLinks, ...linksFromSitemap];

  const requestList = await RequestList.open({
    sources: finalLinks,
  });

  await initModifiedUserAgent(browser, playwrightDeviceDetailsObject, userDataDirectory);
  const crawler = new crawlee.PlaywrightCrawler({
    launchContext: {
      launcher: constants.launcher,
      launchOptions: getPlaywrightLaunchOptions(browser),
      // Bug in Chrome which causes browser pool crash when userDataDirectory is set in non-headless mode
      ...(process.env.CRAWLEE_HEADLESS === '1' && { userDataDir: userDataDirectory }),
    },
    retryOnBlocked: true,
    browserPoolOptions: {
      useFingerprints: false,
      preLaunchHooks: [
        async (_pageId, launchContext) => {
          const baseDir = userDataDirectory; // e.g., /Users/young/.../Chrome/oobee-...

          // Ensure base exists
          await fsp.mkdir(baseDir, { recursive: true });

          // Create a unique subdir per browser
          const subProfileDir = path.join(baseDir, `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
          await fsp.mkdir(subProfileDir, { recursive: true });

          // Assign to Crawlee's launcher
          launchContext.userDataDir = subProfileDir;

          // Safely extend launchOptions
          launchContext.launchOptions = {
            ...launchContext.launchOptions,
            ignoreHTTPSErrors: true,
            ...playwrightDeviceDetailsObject,
          };

          // Optionally log for debugging
          // console.log(`[HOOK] Using userDataDir: ${subProfileDir}`);
        },
      ],
    },
    requestList,
    postNavigationHooks: [
      async ({ page }) => {
        try {
          // Wait for a quiet period in the DOM, but with safeguards
          await page.evaluate(() => {
            return new Promise(resolve => {
              let timeout;
              let mutationCount = 0;
              const MAX_MUTATIONS = 250; // stop if things never quiet down
              const OBSERVER_TIMEOUT = 5000; // hard cap on total wait

              const observer = new MutationObserver(() => {
                clearTimeout(timeout);

                mutationCount++;
                if (mutationCount > MAX_MUTATIONS) {
                  observer.disconnect();
                  resolve('Too many mutations, exiting.');
                  return;
                }

                // restart quiet‑period timer
                timeout = setTimeout(() => {
                  observer.disconnect();
                  resolve('DOM stabilized.');
                }, 1000);
              });

              // overall timeout in case the page never settles
              timeout = setTimeout(() => {
                observer.disconnect();
                resolve('Observer timeout reached.');
              }, OBSERVER_TIMEOUT);

              const root = document.documentElement || document.body || document;
              if (!root || typeof observer.observe !== 'function') {
                resolve('No root node to observe.');
              }
            });
          });
        } catch (err) {
          // Handle page navigation errors gracefully
          if (err.message.includes('was destroyed')) {
            return; // Page navigated or closed, no need to handle
          }
          throw err; // Rethrow unknown errors
        }
      },
    ],
    preNavigationHooks: [
      async ({ request, page }, gotoOptions) => {
        const url = request.url.toLowerCase();

        const isNotSupportedDocument = disallowedListOfPatterns.some(pattern =>
          url.startsWith(pattern),
        );

        if (isNotSupportedDocument) {
          request.skipNavigation = true;
          request.userData.isNotSupportedDocument = true;

          // Log for verification (optional, but not required for correctness)
          // console.log(`[SKIP] Not supported: ${request.url}`);

          return;
        }

        // Set headers if basic auth
        if (isBasicAuth) {
          await page.setExtraHTTPHeaders({
            Authorization: authHeader,
            ...extraHTTPHeaders,
          });
        } else {
          preNavigationHooks(extraHTTPHeaders);
        }
      },
    ],
    requestHandlerTimeoutSecs: 90,
    requestHandler: async ({ page, request, response, sendRequest }) => {
      // Log documents that are not supported
      if (request.userData?.isNotSupportedDocument) {
        guiInfoLog(guiInfoStatusTypes.SKIPPED, {
          numScanned: urlsCrawled.scanned.length,
          urlScanned: request.url,
        });
        urlsCrawled.userExcluded.push({
          url: request.url,
          pageTitle: request.url,
          actualUrl: request.url, // because about:blank is not useful
          metadata: STATUS_CODE_METADATA[1],
          httpStatusCode: 0,
        });

        return;
      }

      // Set basic auth header if needed
      if (isBasicAuth) {
        await page.setExtraHTTPHeaders({
          Authorization: authHeader,
        });
        const currentUrl = new URL(request.url);
        currentUrl.username = username;
        currentUrl.password = password;
        request.url = currentUrl.href;
      }

      await waitForPageLoaded(page, 10000);

      const actualUrl = page.url() || request.loadedUrl || request.url;

      const hasExceededDuration =
        scanDuration > 0 && Date.now() - crawlStartTime > scanDuration * 1000;

      if (urlsCrawled.scanned.length >= maxRequestsPerCrawl || hasExceededDuration) {
        if (hasExceededDuration) {
          console.log(`Crawl duration of ${scanDuration}s exceeded. Aborting sitemap crawl.`);
        }
        crawler.autoscaledPool.abort(); // stops new requests
        return;
      }

      if (request.skipNavigation && actualUrl === 'about:blank') {
        if (isScanPdfs) {
          // pushes download promise into pdfDownloads
          const { pdfFileName, url } = handlePdfDownload(
            randomToken,
            pdfDownloads,
            request,
            sendRequest,
            urlsCrawled,
          );

          uuidToPdfMapping[pdfFileName] = url;
          return;
        }

        guiInfoLog(guiInfoStatusTypes.SKIPPED, {
          numScanned: urlsCrawled.scanned.length,
          urlScanned: request.url,
        });
        urlsCrawled.userExcluded.push({
          url: request.url,
          pageTitle: request.url,
          actualUrl: request.url, // because about:blank is not useful
          metadata: STATUS_CODE_METADATA[1],
          httpStatusCode: 0,
        });

        return;
      }

      const contentType = response?.headers?.()['content-type'] || '';
      const status = response ? response.status() : 0;

      if (basicAuthPage < 0) {
        basicAuthPage += 1;
      } else if (isScanHtml && status < 300 && isWhitelistedContentType(contentType)) {
        const isRedirected = !areLinksEqual(page.url(), request.url);
        const isLoadedUrlInCrawledUrls = urlsCrawled.scanned.some(
          item => (item.actualUrl || item.url) === page.url(),
        );

        if (isRedirected && isLoadedUrlInCrawledUrls) {
          urlsCrawled.notScannedRedirects.push({
            fromUrl: request.url,
            toUrl: actualUrl, // i.e. actualUrl
          });
          return;
        }

        // This logic is different from crawlDomain, as it also checks if the pae is redirected before checking if it is excluded using exclusions.txt
        if (isRedirected && blacklistedPatterns && isSkippedUrl(actualUrl, blacklistedPatterns)) {
          urlsCrawled.userExcluded.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl,
            metadata: STATUS_CODE_METADATA[0],
            httpStatusCode: 0,
          });

          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          return;
        }

        const results = await runAxeScript({ includeScreenshots, page, randomToken });

        guiInfoLog(guiInfoStatusTypes.SCANNED, {
          numScanned: urlsCrawled.scanned.length,
          urlScanned: request.url,
        });

        urlsCrawled.scanned.push({
          url: urlWithoutAuth(request.url),
          pageTitle: results.pageTitle,
          actualUrl, // i.e. actualUrl
        });

        urlsCrawled.scannedRedirects.push({
          fromUrl: urlWithoutAuth(request.url),
          toUrl: actualUrl,
        });

        results.url = request.url;
        results.actualUrl = actualUrl;

        await dataset.pushData(results);
      } else {
        guiInfoLog(guiInfoStatusTypes.SKIPPED, {
          numScanned: urlsCrawled.scanned.length,
          urlScanned: request.url,
        });

        if (isScanHtml) {
          // carry through the HTTP status metadata
          const status = response?.status();
          const metadata =
            typeof status === 'number'
              ? STATUS_CODE_METADATA[status] || STATUS_CODE_METADATA[599]
              : STATUS_CODE_METADATA[2];

          urlsCrawled.invalid.push({
            actualUrl,
            url: request.url,
            pageTitle: request.url,
            metadata,
            httpStatusCode: typeof status === 'number' ? status : 0,
          });
        }
      }
    },
    failedRequestHandler: async ({ request, response, error }) => {
      if (isBasicAuth && request.url) {
        request.url = `${request.url.split('://')[0]}://${request.url.split('@')[1]}`;
      }

      // check if scanned pages have reached limit due to multi-instances of handler running
      if (urlsCrawled.scanned.length >= maxRequestsPerCrawl) {
        return;
      }

      guiInfoLog(guiInfoStatusTypes.ERROR, {
        numScanned: urlsCrawled.scanned.length,
        urlScanned: request.url,
      });

      const status = response?.status();
      const metadata =
        typeof status === 'number'
          ? STATUS_CODE_METADATA[status] || STATUS_CODE_METADATA[599]
          : STATUS_CODE_METADATA[2];

      urlsCrawled.error.push({
        url: request.url,
        pageTitle: request.url,
        actualUrl: request.url,
        metadata,
        httpStatusCode: typeof status === 'number' ? status : 0,
      });
      crawlee.log.error(`Failed Request - ${request.url}: ${request.errorMessages}`);
    },
    maxRequestsPerCrawl: Infinity,
    maxConcurrency: specifiedMaxConcurrency || maxConcurrency,
    ...(process.env.OOBEE_FAST_CRAWLER && {
      autoscaledPoolOptions: {
        minConcurrency: specifiedMaxConcurrency ? Math.min(specifiedMaxConcurrency, 10) : 10,
        maxConcurrency: specifiedMaxConcurrency || maxConcurrency,
        desiredConcurrencyRatio: 0.98, // Increase threshold for scaling up
        scaleUpStepRatio: 0.99,        // Scale up faster
        scaleDownStepRatio: 0.1,       // Scale down slower
      },
    }),
  });

  await crawler.run();

  await requestList.isFinished();

  if (pdfDownloads.length > 0) {
    // wait for pdf downloads to complete
    await Promise.all(pdfDownloads);

    // scan and process pdf documents
    await runPdfScan(randomToken);

    // transform result format
    const pdfResults = await mapPdfScanResults(randomToken, uuidToPdfMapping);

    // get screenshots from pdf docs
    // if (includeScreenshots) {
    //   await Promise.all(pdfResults.map(
    //     async result => await doPdfScreenshots(randomToken, result)
    //   ));
    // }

    // push results for each pdf document to key value store
    await Promise.all(pdfResults.map(result => dataset.pushData(result)));
  }

  if (!fromCrawlIntelligentSitemap) {
    guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  }

  if (scanDuration > 0) {
    const elapsed = Math.round((Date.now() - crawlStartTime) / 1000);
    console.log(`Crawl ended after ${elapsed}s (limit: ${scanDuration}s).`);
  }

  return urlsCrawled;
};

export default crawlSitemap;
