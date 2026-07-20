import crawlee, { EnqueueStrategy, LaunchContext, Request, RequestList, Dataset } from 'crawlee';
import { CrawlRateController } from './crawlRateController.js';
import fs from 'fs';
import {
  createCrawleeSubFolders,
  getPreLaunchHook,
  getPostPageCloseHook,
  preNavigationHooks,
  runAxeScript,
  isUrlPdf,
  splitAuthHeaders,
} from './commonCrawlerFunc.js';

import constants, {
  STATUS_CODE_METADATA,
  guiInfoStatusTypes,
  UrlsCrawled,
  blackListedFileExtensions,
  disallowedListOfPatterns,
  disallowedSelectorPatterns,
  FileTypes,
  RuleFlags,
} from '../constants/constants.js';
import {
  getLinksFromSitemap,
  getPlaywrightLaunchOptions,
  getSafeBrowsingCdpLauncher,
  isDisallowedInRobotsTxt,
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
import { capturePageData } from './pageCapture.js';

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
  ruleset = [],
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
  ruleset?: RuleFlags[];
}) => {
  const crawlStartTime = Date.now();
  let dataset: crawlee.Dataset;
  let urlsCrawled: UrlsCrawled;
  let durationExceeded = false;
  let isAbortingScan = false;
  const remainingBudget = fromCrawlIntelligentSitemap
    ? Math.max(0, maxRequestsPerCrawl - urlsCrawledFromIntelligent.scanned.length)
    : maxRequestsPerCrawl;
  const rateController = new CrawlRateController(
    remainingBudget,
    specifiedMaxConcurrency || constants.maxConcurrency,
  );
  const initialNoSuccessFailureAbortThreshold = Math.max(5, Math.min(maxRequestsPerCrawl, 25));

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
  const { nonAuthHeaders, httpCredentials } = splitAuthHeaders(extraHTTPHeaders);

  const requestList = await RequestList.open({
    sources: linksFromSitemap,
  });

  // Always create a request queue alongside the request list. An empty queue
  // has zero impact on crawl behavior (Crawlee processes RequestList first).
  // Having it available enables: download re-enqueue for PDF scanning,
  // 403 rate-limit retry, and enqueueLinks for intelligent sitemap discovery.
  const { requestQueue } = await createCrawleeSubFolders(randomToken);

  const cdpLauncher = await getSafeBrowsingCdpLauncher(browser, userDataDirectory);

  const crawler = register(
    new crawlee.PlaywrightCrawler({
      launchContext: {
        launcher: (cdpLauncher || constants.launcher) as any,
        launchOptions: getPlaywrightLaunchOptions(browser),
      },
      retryOnBlocked: false,
      browserPoolOptions: {
        useFingerprints: false,
        retireBrowserAfterPageCount: cdpLauncher ? Number.MAX_SAFE_INTEGER : 500,
        closeInactiveBrowserAfterSecs: 30,
        preLaunchHooks: [
          ...(!cdpLauncher ? [getPreLaunchHook(userDataDirectory)] : []),
          async (_pageId, launchContext) => {
            launchContext.launchOptions = {
              ...launchContext.launchOptions,
              ignoreHTTPSErrors: true,
              ...playwrightDeviceDetailsObject,
              ...(process.env.OOBEE_USER_AGENT && { userAgent: process.env.OOBEE_USER_AGENT }),
              ...(process.env.OOBEE_DISABLE_BROWSER_DOWNLOAD && { acceptDownloads: false }),
              ...(nonAuthHeaders && { extraHTTPHeaders: nonAuthHeaders }),
              ...(httpCredentials && { httpCredentials }),
            };
          },
        ],
        postPageCloseHooks: [...(!cdpLauncher ? [getPostPageCloseHook(userDataDirectory)] : [])],
      },
      requestList,
      requestQueue,
      maxRequestRetries: 3,
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
                } else {
                  observer.observe(root, { childList: true, subtree: true });
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
        ...preNavigationHooks(extraHTTPHeaders),
        async ({ request, page }, gotoOptions) => {
          const url = request.url.toLowerCase();

          const isNotSupportedDocument = disallowedListOfPatterns.some(pattern =>
            url.startsWith(pattern),
          );

          if (isNotSupportedDocument) {
            request.skipNavigation = true;
            request.userData.isNotSupportedDocument = true;
            return;
          }

          try {
            const pathname = new URL(url).pathname;
            const ext = pathname.split('.').pop();
            if (ext && blackListedFileExtensions.includes(ext)) {
              request.skipNavigation = true;
              request.userData.isNotSupportedDocument = true;
              return;
            }
          } catch {}
        },
      ],
      requestHandlerTimeoutSecs: 90,
      requestHandler: async ({ page, request, response, sendRequest, enqueueLinks }) => {
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

          if (actualUrl.startsWith('chrome-error:')) {
            guiInfoLog(guiInfoStatusTypes.SKIPPED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });
            urlsCrawled.userExcluded.push({
              url: request.url,
              pageTitle: request.url,
              actualUrl: request.url,
              metadata: STATUS_CODE_METADATA[3],
              httpStatusCode: 3,
            });
            return;
          }

          const hasExceededDuration =
            scanDuration > 0 && Date.now() - crawlStartTime > scanDuration * 1000;

          if (hasExceededDuration) {
            consoleLogger.info(`Crawl duration of ${scanDuration}s exceeded. Aborting sitemap crawl.`);
            durationExceeded = true;
            isAbortingScan = true;
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

          if (status === 403) {
            rateController.onFailure(status, crawler.autoscaledPool);
            guiInfoLog(guiInfoStatusTypes.SKIPPED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });
            urlsCrawled.userExcluded.push({
              url: request.url,
              pageTitle: request.url,
              actualUrl,
              metadata: STATUS_CODE_METADATA[403] || STATUS_CODE_METADATA[599],
              httpStatusCode: 403,
            });
            return;
          }

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

            const results = await runAxeScript({ includeScreenshots, page, randomToken, ruleset });

            await capturePageData(page, actualUrl, randomToken);

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

            if (rateController.claimSlot()) {
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
              if (rateController.isLimitReached()) {
                isAbortingScan = true;
                crawler.autoscaledPool.abort();
              }

              urlsCrawled.scannedRedirects.push({
                fromUrl: request.url,
                toUrl: actualUrl,
              });

              results.url = request.url;
              results.actualUrl = actualUrl;

              await dataset.pushData(results);

              // Discover <a> links from this page for the intelligent sitemap flow.
              // This eliminates the need for a separate crawlDomain supplement phase
              // that would re-visit all these pages just to extract links.
              if (fromCrawlIntelligentSitemap) {
                try {
                  await enqueueLinks({
                    selector: `a:not(${disallowedSelectorPatterns})`,
                    strategy,
                    requestQueue,
                    transformRequestFunction: (req) => {
                      try {
                        req.url = req.url.replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
                      } catch {}
                      if (isDisallowedInRobotsTxt(req.url)) return null;
                      if (isUrlPdf(req.url)) {
                        req.skipNavigation = true;
                      }
                      req.label = req.url;
                      return req;
                    },
                  });
                } catch {
                  // Best-effort link discovery; don't fail the scan
                }
              }
            }
          } else {
            guiInfoLog(guiInfoStatusTypes.SKIPPED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });

            if (isScanHtml) {
              // Non-HTML content types (images, PDFs, binary files) and URLs
              // that redirect to non-HTML resources should be classified as
              // unsupported documents, not generic page errors.
              const isNonHtmlContent =
                contentType &&
                !contentType.startsWith('text/html') &&
                !contentType.includes('html');

              if (isNonHtmlContent && status !== 0) {
                urlsCrawled.userExcluded.push({
                  actualUrl,
                  url: request.url,
                  pageTitle: request.url,
                  metadata: STATUS_CODE_METADATA[1],
                  httpStatusCode: 1,
                });
              } else {
                const httpStatus = response?.status();
                const metadata =
                  typeof httpStatus === 'number'
                    ? STATUS_CODE_METADATA[httpStatus] || STATUS_CODE_METADATA[599]
                    : STATUS_CODE_METADATA[2];

                urlsCrawled.invalid.push({
                  actualUrl,
                  url: request.url,
                  pageTitle: request.url,
                  metadata,
                  httpStatusCode: typeof httpStatus === 'number' ? httpStatus : 0,
                });
              }
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

        // Handle download-triggered navigation errors: Playwright throws
        // "Download is starting" when page.goto() hits a file download URL.
        const isDownloadError = request.errorMessages?.some(
          (msg: string) => msg.includes('Download is starting'),
        );
        if (isDownloadError) {
          if (isScanPdfs) {
            // Re-enqueue with skipNavigation so the requestHandler's PDF download path handles it
            try {
              await requestQueue.addRequest({
                url: request.url,
                skipNavigation: true,
                label: request.url,
                uniqueKey: `download_${request.url}`,
              });
            } catch {}
          } else {
            guiInfoLog(guiInfoStatusTypes.SKIPPED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });
            urlsCrawled.userExcluded.push({
              url: request.url,
              pageTitle: request.url,
              actualUrl: request.url,
              metadata: STATUS_CODE_METADATA[1],
              httpStatusCode: 1,
            });
          }
          return;
        }

        const status = response?.status();

        // Re-enqueue rate-limited (403) URLs once for a retry after concurrency recovers.
        // Call onFailure to reduce concurrency immediately on rate-limit detection.
        if (status === 403 && !request.userData?.rateLimitRetried) {
          rateController.onFailure(status, crawler.autoscaledPool);
          try {
            await requestQueue.addRequest({
              url: request.url,
              label: request.url,
              uniqueKey: `ratelimit_${request.url}`,
              userData: { rateLimitRetried: true },
            });
          } catch {}
          return;
        }

        if (rateController.onFailure(status, crawler.autoscaledPool)) {
          consoleLogger.info(
            `Aborting crawl: consecutive HTTP failures threshold reached (site may be rate-limiting). Successfully scanned ${urlsCrawled.scanned.length} pages.`,
          );
          isAbortingScan = true;
          crawler.autoscaledPool?.abort();
          return;
        }

        const isSafeBrowsingBlock = !!process.env.GOOGLE_SAFE_BROWSING &&
          request.errorMessages?.some((msg: string) =>
            msg.includes('ERR_BLOCKED_BY_CLIENT') ||
            msg.includes('ERR_BLOCKED_BY_RESPONSE'),
          );

        if (isSafeBrowsingBlock) {
          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          urlsCrawled.userExcluded.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl: request.url,
            metadata: STATUS_CODE_METADATA[3],
            httpStatusCode: 3,
          });
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

        if (
          urlsCrawled.scanned.length === 0 &&
          urlsCrawled.error.length >= initialNoSuccessFailureAbortThreshold
        ) {
          consoleLogger.info(
            `Aborting sitemap crawl: ${urlsCrawled.error.length} failed pages with 0 successful scans.`,
          );
          isAbortingScan = true;
          crawler.autoscaledPool?.abort();
        }
      },
      maxRequestsPerCrawl: Infinity,
      maxConcurrency: specifiedMaxConcurrency || maxConcurrency,
      autoscaledPoolOptions: {
        minConcurrency: specifiedMaxConcurrency ? Math.min(specifiedMaxConcurrency, 10) : 10,
        maxConcurrency: specifiedMaxConcurrency || maxConcurrency,
        desiredConcurrencyRatio: 0.98, // Increase threshold for scaling up
        scaleUpStepRatio: 0.99, // Scale up faster
        scaleDownStepRatio: 0.1, // Scale down slower
      },
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