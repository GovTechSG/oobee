import crawlee, { EnqueueStrategy, RequestList, Dataset } from 'crawlee';
import * as path from 'path';
import fsp from 'fs/promises';
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
import { areLinksEqual, isFollowStrategy, isWhitelistedContentType, normUrl, register, getStoragePath } from '../utils.js';
import { guiInfoLog } from '../logs.js';
import type { PageHandler, ViewportSettingsClass } from '../types.js';

const createCrawleeSubFolders = async (randomToken: string) => {
  const crawleeDir = path.join(getStoragePath(randomToken), 'crawlee');
  const dataset = await Dataset.open(crawleeDir);
  return { dataset };
};

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
  extraHTTPHeaders,
  pageHandler,
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
  extraHTTPHeaders: Record<string, string>;
  pageHandler: PageHandler;
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

  const isScanHtml = [FileTypes.All, FileTypes.HtmlOnly].includes(fileTypes as FileTypes);
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
        ...(process.env.CRAWLEE_HEADLESS === '1' && { userDataDir: userDataDirectory }),
      },
      retryOnBlocked: true,
      browserPoolOptions: {
        useFingerprints: false,
        preLaunchHooks: [
          async (_pageId, launchContext) => {
            const baseDir = userDataDirectory;
            await fsp.mkdir(baseDir, { recursive: true });
            const subProfileDir = path.join(
              baseDir,
              `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            );
            await fsp.mkdir(subProfileDir, { recursive: true });
            launchContext.userDataDir = subProfileDir;
            launchContext.launchOptions = {
              ...launchContext.launchOptions,
              ignoreHTTPSErrors: true,
              ...playwrightDeviceDetailsObject,
              ...(process.env.OOBEE_DISABLE_BROWSER_DOWNLOAD && { acceptDownloads: false }),
            };
          },
        ],
      },
      requestList,
      postNavigationHooks: [
        async ({ page }) => {
          try {
            await page.evaluate(() => {
              return new Promise(resolve => {
                let timeout;
                let mutationCount = 0;
                const MAX_MUTATIONS = 500;
                const OBSERVER_TIMEOUT = 5000;

                const observer = new MutationObserver(() => {
                  clearTimeout(timeout);
                  mutationCount++;
                  if (mutationCount > MAX_MUTATIONS) {
                    observer.disconnect();
                    resolve('Too many mutations, exiting.');
                    return;
                  }
                  timeout = setTimeout(() => {
                    observer.disconnect();
                    resolve('DOM stabilized.');
                  }, 1000);
                });

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
            if (err.message?.includes('was destroyed')) return;
            throw err;
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
            return;
          }
          if (extraHTTPHeaders) {
            request.headers = extraHTTPHeaders;
          }
        },
      ],
      requestHandlerTimeoutSecs: 90,
      requestHandler: async ({ page, request, response, enqueueLinks }) => {
        if (request.userData?.isNotSupportedDocument) {
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
          return;
        }

        try {
          await waitForPageLoaded(page, 10000);
          const actualUrl = page.url() || request.loadedUrl || request.url;

          const hasExceededDuration =
            scanDuration > 0 && Date.now() - crawlStartTime > scanDuration * 1000;

          if (urlsCrawled.scanned.length >= maxRequestsPerCrawl || hasExceededDuration) {
            isAbortingScan = true;
            if (hasExceededDuration) {
              console.log(`Crawl duration of ${scanDuration}s exceeded. Aborting sitemap crawl.`);
              durationExceeded = true;
            }
            crawler.autoscaledPool.abort();
            return;
          }

          if (request.skipNavigation && actualUrl === 'about:blank') {
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
              urlsCrawled.notScannedRedirects.push({ fromUrl: request.url, toUrl: actualUrl });
              return;
            }

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
              urlsCrawled.notScannedRedirects.push({ fromUrl: request.url, toUrl: actualUrl });
              guiInfoLog(guiInfoStatusTypes.SKIPPED, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
              });
              return;
            }

            // Call the consumer's page handler
            await pageHandler({ page, request: { url: request.url }, response, enqueueLinks });

            const pageTitle = await page.title().catch(() => request.url);

            guiInfoLog(guiInfoStatusTypes.SCANNED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });

            urlsCrawled.scanned.push({ url: request.url, pageTitle, actualUrl });
            urlsCrawled.scannedRedirects.push({ fromUrl: request.url, toUrl: actualUrl });
          } else {
            guiInfoLog(guiInfoStatusTypes.SKIPPED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });

            if (isScanHtml) {
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
          if (!isAbortingScan) {
            guiInfoLog(guiInfoStatusTypes.ERROR, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });
            urlsCrawled.error.push({
              url: request.url,
              pageTitle: request.url,
              actualUrl: request.url,
              metadata: STATUS_CODE_METADATA[2],
              httpStatusCode: 0,
            });
          }
        }
      },
      failedRequestHandler: async ({ request, response }) => {
        if (isAbortingScan) return;
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
          desiredConcurrencyRatio: 0.98,
          scaleUpStepRatio: 0.99,
          scaleDownStepRatio: 0.1,
        },
      }),
    }),
  );

  await crawler.run();
  await requestList.isFinished();

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
