import crawlee, { Dataset, EnqueueStrategy, RequestQueue } from 'crawlee';
import type { BrowserContext, ElementHandle, Frame, Page } from 'playwright';
import type { PlaywrightCrawlingContext, RequestOptions } from 'crawlee';
import * as path from 'path';
import fsp from 'fs/promises';
import constants, {
  UrlsCrawled,
  blackListedFileExtensions,
  guiInfoStatusTypes,
  cssQuerySelectors,
  STATUS_CODE_METADATA,
  disallowedListOfPatterns,
  disallowedSelectorPatterns,
  FileTypes,
} from '../constants/constants.js';
import {
  getPlaywrightLaunchOptions,
  isBlacklistedFileExtensions,
  isSkippedUrl,
  isDisallowedInRobotsTxt,
  getUrlsFromRobotsTxt,
  waitForPageLoaded,
} from '../constants/common.js';
import { areLinksEqual, isFollowStrategy, normUrl, register, getStoragePath } from '../utils.js';
import { consoleLogger, guiInfoLog } from '../logs.js';
import type { PageHandler, PlaywrightHook, ViewportSettingsClass } from '../types.js';

const isBlacklisted = (url: string, blacklistedPatterns: string[]) => {
  if (!blacklistedPatterns) {
    return false;
  }
  try {
    const parsedUrl = new URL(url);
    return blacklistedPatterns.some(
      pattern => new RegExp(pattern).test(parsedUrl.hostname) || new RegExp(pattern).test(url),
    );
  } catch (error) {
    console.error(`Error parsing URL: ${url}`, error);
    return false;
  }
};

const isUrlPdf = (url: string): boolean => {
  const driveLetterPattern = /^[A-Z]:/i;
  const backslashPattern = /\\/;
  const isLocal = url.startsWith('/') || driveLetterPattern.test(url) || backslashPattern.test(url) ||
    url.startsWith('./') || url.startsWith('../') || url.startsWith('.\\') || url.startsWith('..\\');
  if (isLocal) return /\.pdf$/i.test(url);
  try {
    const parsedUrl = new URL(url);
    return /\.pdf($|\?|#)/i.test(parsedUrl.pathname) || /\.pdf($|\?|#)/i.test(parsedUrl.href);
  } catch {
    return false;
  }
};

const createCrawleeSubFolders = async (
  randomToken: string,
): Promise<{ dataset: Dataset; requestQueue: RequestQueue }> => {
  const crawleeDir = path.join(getStoragePath(randomToken), 'crawlee');
  const dataset = await Dataset.open(crawleeDir);
  const requestQueue = await RequestQueue.open(crawleeDir);
  return { dataset, requestQueue };
};

const crawlDomain = async ({
  url,
  randomToken,
  host: _host,
  viewportSettings,
  maxRequestsPerCrawl,
  browser,
  userDataDirectory,
  strategy,
  specifiedMaxConcurrency,
  fileTypes,
  blacklistedPatterns,
  followRobots,
  extraHTTPHeaders,
  pageHandler,
  scanDuration = 0,
  safeMode = false,
  fromCrawlIntelligentSitemap = false,
  datasetFromIntelligent = null,
  urlsCrawledFromIntelligent = null,
  preNavigationHooks: consumerPreNavHooks = [],
  postNavigationHooks: consumerPostNavHooks = [],
  pageDelayMs,
}: {
  url: string;
  randomToken: string;
  host: string;
  viewportSettings: ViewportSettingsClass;
  maxRequestsPerCrawl: number;
  browser: string;
  userDataDirectory: string;
  strategy: EnqueueStrategy;
  specifiedMaxConcurrency: number;
  fileTypes: FileTypes;
  blacklistedPatterns: string[];
  followRobots: boolean;
  extraHTTPHeaders: Record<string, string>;
  pageHandler: PageHandler;
  scanDuration?: number;
  safeMode?: boolean;
  fromCrawlIntelligentSitemap?: boolean;
  datasetFromIntelligent?: crawlee.Dataset;
  urlsCrawledFromIntelligent?: UrlsCrawled;
  preNavigationHooks?: PlaywrightHook[];
  postNavigationHooks?: PlaywrightHook[];
  pageDelayMs?: number | ((url: string) => number);
}) => {
  const crawlStartTime = Date.now();
  let dataset: crawlee.Dataset;
  let urlsCrawled: UrlsCrawled;
  const { requestQueue }: { requestQueue: crawlee.RequestQueue } =
    await createCrawleeSubFolders(randomToken);
  let durationExceeded = false;

  if (fromCrawlIntelligentSitemap) {
    dataset = datasetFromIntelligent;
    urlsCrawled = urlsCrawledFromIntelligent;
  } else {
    ({ dataset } = await createCrawleeSubFolders(randomToken));
    urlsCrawled = { ...constants.urlsCrawledObj };
  }

  const queuedUrlSet = new Set<string>();
  const scannedUrlSet = new Set<string>(urlsCrawled.scanned.map(item => normUrl(item.url)));
  const scannedResolvedUrlSet = new Set<string>(
    urlsCrawled.scanned.map(item => normUrl(item.actualUrl || item.url)),
  );
  const isScanHtml = [FileTypes.All, FileTypes.HtmlOnly].includes(fileTypes as FileTypes);
  const isScanPdfs = [FileTypes.All, FileTypes.PdfOnly].includes(fileTypes as FileTypes);
  const { maxConcurrency } = constants;
  const { playwrightDeviceDetailsObject } = viewportSettings;

  const enqueueUniqueRequest = async ({
    url,
    skipNavigation,
    label,
  }: {
    url: string;
    skipNavigation?: boolean;
    label?: string;
  }) => {
    if (queuedUrlSet.has(url)) return;
    queuedUrlSet.add(url);
    try {
      await requestQueue.addRequest({ url, skipNavigation, label });
    } catch (error) {
      queuedUrlSet.delete(url);
      throw error;
    }
  };

  await enqueueUniqueRequest({
    url,
    skipNavigation: isUrlPdf(url),
    label: url,
  });

  const customEnqueueLinksByClickingElements = async (
    currentPage: Page,
    browserContext: BrowserContext,
  ): Promise<void> => {
    let workingPage = currentPage;
    const initialPageUrl: string = workingPage.url().toString();
    const selectedElementsString = cssQuerySelectors.join(', ');

    const isExcluded = (newPageUrl: string): boolean => {
      const isAlreadyScanned: boolean = scannedUrlSet.has(normUrl(newPageUrl));
      const isBlacklistedUrl: boolean = isBlacklisted(newPageUrl, blacklistedPatterns);
      const isNotFollowStrategy: boolean = !isFollowStrategy(newPageUrl, initialPageUrl, strategy);
      const isNotSupportedDocument: boolean = disallowedListOfPatterns.some(pattern =>
        newPageUrl.toLowerCase().startsWith(pattern),
      );
      const isRobotsDisallowed: boolean = isDisallowedInRobotsTxt(newPageUrl);
      return isNotSupportedDocument || isAlreadyScanned || isBlacklistedUrl || isNotFollowStrategy || isRobotsDisallowed;
    };

    const setPageListeners = (pageListener: Page): void => {
      pageListener.on('popup', async (newPage: Page) => {
        try {
          if (newPage.url() !== initialPageUrl && !isExcluded(newPage.url())) {
            const newPageUrl: string = newPage.url().replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
            await enqueueUniqueRequest({
              url: newPageUrl,
              skipNavigation: isUrlPdf(newPage.url()),
              label: newPageUrl,
            });
          } else {
            try { await newPage.close(); } catch { /* best effort */ }
          }
        } catch { /* best effort */ }
      });
    };

    setPageListeners(workingPage);

    const selectedElements: ElementHandle[] = await workingPage.$$(selectedElementsString);
    const filteredElements: ElementHandle[] = [];

    for (const element of selectedElements) {
      const href = await element.evaluate(el => (el as HTMLElement).getAttribute('href'));
      const shouldSkip = href && disallowedListOfPatterns.some(p => href.toLowerCase().startsWith(p));
      if (!shouldSkip) filteredElements.push(element);
    }

    for (const element of filteredElements) {
      try {
        const newUrl = await element.evaluate(el => {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true });
          el.dispatchEvent(event);
          return (el as HTMLAnchorElement).href || '';
        });

        if (newUrl && !isExcluded(newUrl)) {
          const cleanUrl = newUrl.replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
          await enqueueUniqueRequest({
            url: cleanUrl,
            skipNavigation: isUrlPdf(cleanUrl),
            label: cleanUrl,
          });
        }

        const currentUrl = workingPage.url();
        if (currentUrl !== initialPageUrl && !isExcluded(currentUrl)) {
          const cleanCurrentUrl = currentUrl.replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
          await enqueueUniqueRequest({
            url: cleanCurrentUrl,
            skipNavigation: isUrlPdf(cleanCurrentUrl),
            label: cleanCurrentUrl,
          });
          await workingPage.goBack();
        }
      } catch { /* best effort click discovery */ }
    }
  };

  const enqueueProcess = async (
    page: Page,
    enqueueLinks: PlaywrightCrawlingContext['enqueueLinks'],
    browserContext: BrowserContext,
  ) => {
    try {
      await enqueueLinks({
        selector: `a:not(${disallowedSelectorPatterns})`,
        strategy,
        requestQueue,
        transformRequestFunction: (req: RequestOptions): RequestOptions | null => {
          try {
            req.url = req.url.replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
          } catch (e) {
            consoleLogger.error(e);
          }
          if (scannedUrlSet.has(normUrl(req.url))) {
            req.skipNavigation = true;
          }
          if (isDisallowedInRobotsTxt(req.url)) return null;
          if (isBlacklisted(req.url, blacklistedPatterns)) return null;
          if (isUrlPdf(req.url)) {
            req.skipNavigation = true;
          }
          req.label = req.url;
          return req;
        },
      });

      if (!safeMode) {
        const currentHostname = new URL(page.url()).hostname;
        const seedHostname = new URL(url).hostname;
        if (currentHostname === seedHostname) {
          try {
            await customEnqueueLinksByClickingElements(page, browserContext);
          } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }
  };

  let isAbortingScanNow = false;

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
              ...(extraHTTPHeaders && { extraHTTPHeaders }),
            };
          },
        ],
      },
      requestQueue,
      preNavigationHooks: consumerPreNavHooks.length > 0 ? [...consumerPreNavHooks] : undefined,
      postNavigationHooks: [
        ...consumerPostNavHooks,
        async crawlingContext => {
          const { page, request } = crawlingContext;

          await page.evaluate(() => {
            return new Promise(resolve => {
              let timeout;
              let mutationCount = 0;
              const MAX_MUTATIONS = 500;
              const OBSERVER_TIMEOUT = 5000;

              const observer = new MutationObserver(() => {
                clearTimeout(timeout);
                mutationCount += 1;
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
              } else {
                observer.observe(root, { childList: true, subtree: true });
              }
            });
          });

          let finalUrl = page.url();
          const requestLabelUrl = request.label;

          const isLoadedUrlFollowStrategy = isFollowStrategy(finalUrl, requestLabelUrl, strategy);
          if (!isLoadedUrlFollowStrategy) {
            finalUrl = requestLabelUrl;
          }

          const isRedirected = !areLinksEqual(finalUrl, requestLabelUrl);
          if (isRedirected && !isDisallowedInRobotsTxt(finalUrl)) {
            await enqueueUniqueRequest({ url: finalUrl, label: finalUrl });
          } else {
            request.skipNavigation = false;
          }
        },
      ],
      requestHandlerTimeoutSecs: 90,
      requestHandler: async ({
        page,
        request,
        response,
        crawler: activeCrawler,
        enqueueLinks,
      }) => {
        const browserContext: BrowserContext = page.context();
        try {
          await waitForPageLoaded(page, 10000);
          let actualUrl = page.url() || request.loadedUrl || request.url;

          if (page.url() !== 'about:blank') {
            actualUrl = page.url();
          }

          if (request.label?.startsWith('__clickpass__')) {
            await enqueueProcess(page, enqueueLinks, browserContext);
            return;
          }

          if (
            !isFollowStrategy(url, actualUrl, strategy) &&
            (isBlacklisted(actualUrl, blacklistedPatterns) || isUrlPdf(actualUrl))
          ) {
            guiInfoLog(guiInfoStatusTypes.SKIPPED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: actualUrl,
            });
            return;
          }

          const hasExceededDuration =
            scanDuration > 0 && Date.now() - crawlStartTime > scanDuration * 1000;

          if (urlsCrawled.scanned.length >= maxRequestsPerCrawl || hasExceededDuration) {
            if (hasExceededDuration) {
              console.log(`Crawl duration of ${scanDuration}s exceeded. Aborting website crawl.`);
              durationExceeded = true;
            }
            isAbortingScanNow = true;
            activeCrawler.autoscaledPool.abort();
            return;
          }

          if (scannedUrlSet.has(normUrl(request.url))) {
            await enqueueProcess(page, enqueueLinks, browserContext);
            return;
          }

          if (isDisallowedInRobotsTxt(request.url)) {
            await enqueueProcess(page, enqueueLinks, browserContext);
            return;
          }

          if (request.skipNavigation && actualUrl === 'about:blank') {
            return;
          }

          if (isBlacklistedFileExtensions(actualUrl, blackListedFileExtensions)) {
            return;
          }

          if (
            !isFollowStrategy(url, actualUrl, strategy) &&
            blacklistedPatterns &&
            isSkippedUrl(actualUrl, blacklistedPatterns)
          ) {
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
            await enqueueProcess(page, enqueueLinks, browserContext);
            return;
          }

          if (isScanHtml) {
            const isRedirected = !areLinksEqual(actualUrl, request.url);
            const isLoadedUrlFollowStrategy = isFollowStrategy(actualUrl, request.url, strategy);
            if (isRedirected && !isLoadedUrlFollowStrategy) {
              urlsCrawled.notScannedRedirects.push({
                fromUrl: request.url,
                toUrl: actualUrl,
              });
              return;
            }

            const responseStatus = response?.status();
            if (responseStatus && responseStatus >= 300) {
              guiInfoLog(guiInfoStatusTypes.SKIPPED, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
              });
              urlsCrawled.userExcluded.push({
                url: request.url,
                pageTitle: request.url,
                actualUrl,
                metadata: STATUS_CODE_METADATA[responseStatus] || STATUS_CODE_METADATA[599],
                httpStatusCode: responseStatus,
              });
              return;
            }

            if (pageDelayMs) {
              const delay = typeof pageDelayMs === 'function' ? pageDelayMs(request.url) : pageDelayMs;
              if (delay > 0) await new Promise(r => setTimeout(r, delay));
            }

            // Call the consumer's page handler
            await pageHandler({ page, request: { url: request.url }, response, enqueueLinks, dataset });

            // Track page as scanned
            const pageTitle = await page.title().catch(() => request.url);

            if (isRedirected) {
              const isLoadedUrlInCrawledUrls = scannedResolvedUrlSet.has(normUrl(actualUrl));
              if (isLoadedUrlInCrawledUrls) {
                urlsCrawled.notScannedRedirects.push({ fromUrl: request.url, toUrl: actualUrl });
                return;
              }

              if (urlsCrawled.scanned.length < maxRequestsPerCrawl) {
                guiInfoLog(guiInfoStatusTypes.SCANNED, {
                  numScanned: urlsCrawled.scanned.length,
                  urlScanned: request.url,
                });
                urlsCrawled.scanned.push({ url: request.url, pageTitle, actualUrl });
                scannedUrlSet.add(normUrl(request.url));
                scannedResolvedUrlSet.add(normUrl(actualUrl));
                urlsCrawled.scannedRedirects.push({ fromUrl: request.url, toUrl: actualUrl });
              }
            } else if (urlsCrawled.scanned.length < maxRequestsPerCrawl) {
              guiInfoLog(guiInfoStatusTypes.SCANNED, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
              });
              urlsCrawled.scanned.push({ url: request.url, actualUrl: request.url, pageTitle });
              scannedUrlSet.add(normUrl(request.url));
              scannedResolvedUrlSet.add(normUrl(request.url));
            }
          }

          if (urlsCrawled.scanned.length < maxRequestsPerCrawl) {
            if (followRobots)
              await getUrlsFromRobotsTxt(request.url, browser, userDataDirectory, extraHTTPHeaders);
            await enqueueProcess(page, enqueueLinks, browserContext);
          }
        } catch (e) {
          try {
            if (
              !e.message?.includes('page.evaluate') &&
              urlsCrawled.scanned.length < maxRequestsPerCrawl
            ) {
              guiInfoLog(guiInfoStatusTypes.ERROR, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
              });
              const recoveryPage = await browserContext.newPage();
              await recoveryPage.goto(request.url);
              await recoveryPage.route('**/*', async route => {
                const interceptedRequest = route.request();
                if (interceptedRequest.resourceType() === 'document') {
                  const interceptedRequestUrl = interceptedRequest.url().replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
                  await enqueueUniqueRequest({
                    url: interceptedRequestUrl,
                    skipNavigation: isUrlPdf(interceptedRequest.url()),
                    label: interceptedRequestUrl,
                  });
                }
              });
            }
          } catch { /* best effort recovery */ }

          if (!isAbortingScanNow) {
            guiInfoLog(guiInfoStatusTypes.ERROR, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });
            urlsCrawled.error.push({
              url: request.url,
              pageTitle: request.url,
              actualUrl: request.url,
              metadata: STATUS_CODE_METADATA[2],
            });
          }
        }
      },
      failedRequestHandler: async ({ request, response }) => {
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
      },
      maxRequestsPerCrawl: maxRequestsPerCrawl * 3,
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

  // Additional click-discovery passes
  if (!safeMode && !isAbortingScanNow && !durationExceeded) {
    const seedHostname = new URL(url).hostname;
    const clickPassVisited = new Set<string>();
    let prevScannedCount: number;

    do {
      prevScannedCount = urlsCrawled.scanned.length;
      if (prevScannedCount >= maxRequestsPerCrawl) break;
      if (scanDuration > 0 && Date.now() - crawlStartTime > scanDuration * 1000) break;

      const seedHostnamePages = urlsCrawled.scanned
        .map(item => item.actualUrl || item.url)
        .filter(pageUrl => {
          try {
            return new URL(pageUrl).hostname === seedHostname && !clickPassVisited.has(pageUrl);
          } catch { return false; }
        });

      if (seedHostnamePages.length === 0) break;

      let enqueued = 0;
      for (const pageUrl of seedHostnamePages) {
        if (urlsCrawled.scanned.length >= maxRequestsPerCrawl) break;
        if (scanDuration > 0 && Date.now() - crawlStartTime > scanDuration * 1000) break;
        clickPassVisited.add(pageUrl);
        try {
          const clickPassLabel = `__clickpass__${pageUrl}`;
          if (!queuedUrlSet.has(clickPassLabel)) {
            queuedUrlSet.add(clickPassLabel);
            await requestQueue.addRequest({ url: pageUrl, label: clickPassLabel, skipNavigation: false });
            enqueued += 1;
          }
        } catch { /* ignore enqueue errors */ }
      }

      if (enqueued === 0) break;
      await crawler.run();
    } while (urlsCrawled.scanned.length > prevScannedCount);
  }

  if (!fromCrawlIntelligentSitemap) {
    guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  }

  if (scanDuration > 0) {
    const elapsed = Math.round((Date.now() - crawlStartTime) / 1000);
    console.log(`Crawl ended after ${elapsed}s. Limit: ${scanDuration}s.`);
  }
  return { urlsCrawled, durationExceeded };
};

export default crawlDomain;
