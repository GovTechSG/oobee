import crawlee, { EnqueueStrategy, LaunchContext, Request, RequestList, Dataset } from 'crawlee';
import { CrawlRateController } from './crawlRateController.js';
import fs from 'fs';
import * as path from 'path';
import fsp from 'fs/promises';
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
  FileTypes,
} from '../constants/constants.js';
import {
  getLinksFromSitemap,
  getPlaywrightLaunchOptions,
  isSkippedUrl,
  waitForPageLoaded,
  isFilePath,
} from '../constants/common.js';
import { areLinksEqual, isFollowStrategy, isWhitelistedContentType, normUrl, register } from '../utils.js';
import {
  handlePdfDownload,
  runPdfScan,
  mapPdfScanResults,
  doPdfScreenshots,
} from './pdfScanFunc.js';
import { consoleLogger, guiInfoLog } from '../logs.js';
import { ViewportSettingsClass } from '../combine.js';

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
  strategy = EnqueueStrategy.All,
  userUrl = '',
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
  fileTypes: FileTypes;
  blacklistedPatterns: string[];
  includeScreenshots: boolean;
  extraHTTPHeaders: Record<string, string>;
  strategy?: EnqueueStrategy;
  userUrl?: string;
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
  let durationExceeded = false;
  let isAbortingScan = false;
  const rateController = new CrawlRateController(
    maxRequestsPerCrawl,
    specifiedMaxConcurrency || constants.maxConcurrency,
  );

  if (fromCrawlIntelligentSitemap) {
    dataset = datasetFromIntelligent;
    urlsCrawled = urlsCrawledFromIntelligent;
  } else {
    ({ dataset } = await createCrawleeSubFolders(randomToken));
    urlsCrawled = { ...constants.urlsCrawledObj };
  }

  if (!crawledFromLocalFile && isFilePath(sitemapUrl)) {
    console.log('Local file crawling not supported for sitemap. Please provide a valid URL.');
    return;
  }

  const linksFromSitemap = await getLinksFromSitemap(
    sitemapUrl,
    maxRequestsPerCrawl,
    browser,
    userDataDirectory,
    userUrlInputFromIntelligent,
    fromCrawlIntelligentSitemap,
    extraHTTPHeaders,
    strategy,
    userUrl || sitemapUrl,
  );

  sitemapUrl = encodeURI(sitemapUrl);

  const pdfDownloads: Promise<void>[] = [];
  const uuidToPdfMapping: Record<string, string> = {};
  const isScanHtml = [FileTypes.All, FileTypes.HtmlOnly].includes(fileTypes as FileTypes);
  const isScanPdfs = [FileTypes.All, FileTypes.PdfOnly].includes(fileTypes as FileTypes);
  const { playwrightDeviceDetailsObject } = viewportSettings;
  const { maxConcurrency } = constants;

  const requestList = await RequestList.open({
    sources: linksFromSitemap,
  });

  const crawler = register(
    new crawlee.PlaywrightCrawler({
      launchContext: {
        launcher: constants.launcher,
        launchOptions: getPlaywrightLaunchOptions(browser),
        userDataDir: userDataDirectory,
      },
      retryOnBlocked: true,
      browserPoolOptions: {
        useFingerprints: false,
        preLaunchHooks: [
          async (_pageId, launchContext) => {
            await fsp.mkdir(userDataDirectory, { recursive: true });

            // eslint-disable-next-line no-param-reassign
            launchContext.launchOptions = {
              ...launchContext.launchOptions,
              ignoreHTTPSErrors: true,
              ...playwrightDeviceDetailsObject,
              ...(process.env.OOBEE_USER_AGENT && { userAgent: process.env.OOBEE_USER_AGENT }),
              ...(process.env.OOBEE_DISABLE_BROWSER_DOWNLOAD && { acceptDownloads: false }),
            };
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
                const MAX_MUTATIONS = 500; // stop if things never quiet down
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

          preNavigationHooks(extraHTTPHeaders);
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
            httpStatusCode: 1,
          });

          return;
        }

        try {
          await waitForPageLoaded(page, 10000);

          const actualUrl = page.url() || request.loadedUrl || request.url;

          const hasExceededDuration =
            scanDuration > 0 && Date.now() - crawlStartTime > scanDuration * 1000;

          if (!rateController.claimSlot() || hasExceededDuration) {
            isAbortingScan = true;
            if (hasExceededDuration) {
              console.log(`Crawl duration of ${scanDuration}s exceeded. Aborting sitemap crawl.`);
              durationExceeded = true;
            }
            crawler.autoscaledPool.abort();
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
              httpStatusCode: 1,
            });

            return;
          }

          const contentType = response?.headers?.()['content-type'] || '';
          const status = response ? response.status() : 0;

          if (isScanHtml && status < 300 && isWhitelistedContentType(contentType)) {
            const isRedirected = !areLinksEqual(page.url(), request.url);
            const isLoadedUrlInCrawledUrls = urlsCrawled.scanned.some(
              item => normUrl(item.actualUrl || item.url) === normUrl(page.url()),
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

            if (isRedirected && !isFollowStrategy(actualUrl, request.url, 'same-hostname')) {
              urlsCrawled.notScannedRedirects.push({
                fromUrl: request.url,
                toUrl: actualUrl,
              });
              guiInfoLog(guiInfoStatusTypes.SKIPPED, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
              });
              return;
            }

            const results = await runAxeScript({ includeScreenshots, page, randomToken });

            // Detect JS redirects that fire during/after axe scan.
            // Listen for navigation, then give a brief window for pending redirects to complete.
            try {
              let navigatedToUrl: string | null = null;
              const onFrameNavigated = (frame: any) => {
                if (frame === page.mainFrame()) {
                  navigatedToUrl = frame.url();
                }
              };
              page.on('framenavigated', onFrameNavigated);
              await page.waitForTimeout(1000);
              page.off('framenavigated', onFrameNavigated);

              const postScanUrl = navigatedToUrl || page.url();
              if (postScanUrl && postScanUrl !== 'about:blank' && !isFollowStrategy(postScanUrl, request.url, 'same-hostname')) {
                urlsCrawled.notScannedRedirects.push({
                  fromUrl: request.url,
                  toUrl: postScanUrl,
                });
                guiInfoLog(guiInfoStatusTypes.SKIPPED, {
                  numScanned: urlsCrawled.scanned.length,
                  urlScanned: request.url,
                });
                return;
              }
            } catch (_) {
              // Page/context was destroyed during navigation — handled by outer catch
            }

            guiInfoLog(guiInfoStatusTypes.SCANNED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });

            urlsCrawled.scanned.push({
              url: request.url,
              pageTitle: results.pageTitle,
              actualUrl, // i.e. actualUrl
            });
            rateController.onSuccess(crawler.autoscaledPool);

            urlsCrawled.scannedRedirects.push({
              fromUrl: request.url,
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
        } catch (e) {
          // Do not push to urlsCrawled.error here — Crawlee will retry the request
          // (up to maxRequestRetries, default 3). If all retries are exhausted,
          // failedRequestHandler will record the error. Pushing here causes
          // duplicates and false positives for URLs that succeed on retry.
        }
      },
      failedRequestHandler: async ({ request, response, error }) => {
        if (isAbortingScan) {
          return;
        }

        const status = response?.status();
        if (rateController.onFailure(status, crawler.autoscaledPool)) {
          consoleLogger.info(
            `Aborting crawl: consecutive HTTP failures threshold reached (site may be rate-limiting). Successfully scanned ${urlsCrawled.scanned.length} pages.`,
          );
          isAbortingScan = true;
          crawler.autoscaledPool?.abort();
          return;
        }

        guiInfoLog(guiInfoStatusTypes.ERROR, {
          numScanned: urlsCrawled.scanned.length,
          urlScanned: request.url,
        });

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
          scaleUpStepRatio: 0.99, // Scale up faster
          scaleDownStepRatio: 0.1, // Scale down slower
        },
      }),
    }),
  );

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
    if (includeScreenshots) {
      await Promise.all(
        pdfResults.map(async result => await doPdfScreenshots(randomToken, result)),
      );
    }

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

  return { urlsCrawled, durationExceeded };
};

export default crawlSitemap;