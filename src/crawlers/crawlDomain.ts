import crawlee, { EnqueueStrategy } from 'crawlee';
import type { BrowserContext, ElementHandle, Frame, Page } from 'playwright';
import type { PlaywrightCrawlingContext, RequestOptions } from 'crawlee';
import * as path from 'path';
import fsp from 'fs/promises';
import {
  createCrawleeSubFolders,
  runAxeScript,
  isUrlPdf,
  shouldSkipClickDueToDisallowedHref,
  shouldSkipDueToUnsupportedContent,
} from './commonCrawlerFunc.js';
import constants, {
  UrlsCrawled,
  blackListedFileExtensions,
  guiInfoStatusTypes,
  cssQuerySelectors,
  RuleFlags,
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
import { areLinksEqual, isFollowStrategy, register } from '../utils.js';
import {
  handlePdfDownload,
  runPdfScan,
  mapPdfScanResults,
  doPdfScreenshots,
} from './pdfScanFunc.js';
import { consoleLogger, guiInfoLog } from '../logs.js';
import { ViewportSettingsClass } from '../combine.js';

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
  includeScreenshots,
  followRobots,
  extraHTTPHeaders,
  scanDuration = 0,
  safeMode = false,
  fromCrawlIntelligentSitemap = false,
  datasetFromIntelligent = null,
  urlsCrawledFromIntelligent = null,
  ruleset = [],
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
  includeScreenshots: boolean;
  followRobots: boolean;
  extraHTTPHeaders: Record<string, string>;
  scanDuration?: number;
  safeMode?: boolean;
  fromCrawlIntelligentSitemap?: boolean;
  datasetFromIntelligent?: crawlee.Dataset;
  urlsCrawledFromIntelligent?: UrlsCrawled;
  ruleset?: RuleFlags[];
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

  const pdfDownloads: Promise<void>[] = [];
  const uuidToPdfMapping: Record<string, string> = {};
  const queuedUrlSet = new Set<string>();
  const scannedUrlSet = new Set<string>(urlsCrawled.scanned.map(item => item.url));
  const scannedResolvedUrlSet = new Set<string>(
    urlsCrawled.scanned.map(item => item.actualUrl || item.url),
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
    if (queuedUrlSet.has(url)) {
      return;
    }
    queuedUrlSet.add(url);

    try {
      await requestQueue.addRequest({
        url,
        skipNavigation,
        label,
      });
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
      const isAlreadyScanned: boolean = urlsCrawled.scanned.some(item => item.url === newPageUrl);
      const isBlacklistedUrl: boolean = isBlacklisted(newPageUrl, blacklistedPatterns);
      const isNotFollowStrategy: boolean = !isFollowStrategy(newPageUrl, initialPageUrl, strategy);
      const isNotSupportedDocument: boolean = disallowedListOfPatterns.some(pattern =>
        newPageUrl.toLowerCase().startsWith(pattern),
      );
      return isNotSupportedDocument || isAlreadyScanned || isBlacklistedUrl || isNotFollowStrategy;
    };
    const setPageListeners = (pageListener: Page): void => {
      // event listener to handle new page popups upon button click
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
            try {
              await newPage.close();
            } catch {
              // No logging for this case as it is best effort to handle dynamic client-side JavaScript redirects and clicks.
              // Handles browser page object been closed.
            }
          }
        } catch {
          // No logging for this case as it is best effort to handle dynamic client-side JavaScript redirects and clicks.
          // Handles browser page object been closed.
        }
      });

      // event listener to handle navigation to new url within same page upon element click
      pageListener.on('framenavigated', async (newFrame: Frame) => {
        try {
          if (
            newFrame.url() !== initialPageUrl &&
            !isExcluded(newFrame.url()) &&
            !(newFrame.url() === 'about:blank')
          ) {
            const newFrameUrl: string = newFrame.url().replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
            await enqueueUniqueRequest({
              url: newFrameUrl,
              skipNavigation: isUrlPdf(newFrame.url()),
              label: newFrameUrl,
            });
          }
        } catch {
          // No logging for this case as it is best effort to handle dynamic client-side JavaScript redirects and clicks.
          // Handles browser page object been closed.
        }
      });
    };
    setPageListeners(workingPage);
    let currentElementIndex: number = 0;
    let isAllElementsHandled: boolean = false;
    // This loop is intentionally sequential because each step depends on the latest page state
    // (navigation, popup/frame events, and potential page recreation).
    // Running iterations in parallel (for example with Promise.all) would race on shared `page`
    // state, causing stale element handles and nondeterministic enqueue/navigation behavior.
    /* eslint-disable no-await-in-loop */
    while (!isAllElementsHandled) {
      try {
        // navigate back to initial page if clicking on a element previously caused it to navigate to a new url
        if (workingPage.url() !== initialPageUrl) {
          try {
            await workingPage.close();
          } catch {
            // No logging for this case as it is best effort to handle dynamic client-side JavaScript redirects and clicks.
            // Handles browser page object been closed.
          }
          workingPage = await browserContext.newPage();
          await workingPage.goto(initialPageUrl, {
            waitUntil: 'domcontentloaded',
          });
          setPageListeners(workingPage);
        }
        const selectedElements: ElementHandle<SVGElement | HTMLElement>[] =
          await workingPage.$$(selectedElementsString);
        // edge case where there might be elements on page that appears intermittently
        if (currentElementIndex + 1 > selectedElements.length || !selectedElements) {
          break;
        }
        // handle the last element in selectedElements
        if (currentElementIndex + 1 === selectedElements.length) {
          isAllElementsHandled = true;
        }
        const element: ElementHandle<SVGElement | HTMLElement> =
          selectedElements[currentElementIndex];
        currentElementIndex += 1;
        let newUrlFoundInElement: string = null;
        if (await element.isVisible()) {
          const currentPageUrl = workingPage.url();
          // Find url in html elements without clicking them
          const result = await workingPage.evaluate(pageElement => {
            // find href attribute
            const hrefUrl: string = pageElement.getAttribute('href');

            // find url in datapath
            const dataPathUrl: string = pageElement.getAttribute('data-path');

            return hrefUrl || dataPathUrl;
          }, element);
          if (result) {
            newUrlFoundInElement = result;
            const pageUrl: URL = new URL(currentPageUrl);
            const baseUrl: string = `${pageUrl.protocol}//${pageUrl.host}`;
            let absoluteUrl: URL;
            // Construct absolute URL using base URL
            try {
              // Check if newUrlFoundInElement is a valid absolute URL
              absoluteUrl = new URL(newUrlFoundInElement);
            } catch {
              // If it's not a valid URL, treat it as a relative URL
              absoluteUrl = new URL(newUrlFoundInElement, baseUrl);
            }
            newUrlFoundInElement = absoluteUrl.href;
          }
          if (newUrlFoundInElement && !isExcluded(newUrlFoundInElement)) {
            const newUrlFoundInElementUrl: string = newUrlFoundInElement.replace(
              /(?<=&|\?)utm_.*?(&|$)/gim,
              '',
            );

            await enqueueUniqueRequest({
              url: newUrlFoundInElementUrl,
              skipNavigation: isUrlPdf(newUrlFoundInElement),
              label: newUrlFoundInElementUrl,
            });
          } else if (!newUrlFoundInElement) {
            try {
              const shouldSkip = await shouldSkipClickDueToDisallowedHref(workingPage, element);
              if (shouldSkip) {
                const elementHtml = await workingPage.evaluate(el => el.outerHTML, element);
                consoleLogger.info(
                  'Skipping a click due to disallowed href nearby. Element HTML:',
                  elementHtml,
                );
              } else {
                // Find url in html elements by manually clicking them. New page navigation/popups will be handled by event listeners above
                await element.click({ force: true });
                await workingPage.waitForTimeout(1000); // Add a delay of 1 second between each Element click
              }
            } catch {
              // No logging for this case as it is best effort to handle dynamic client-side JavaScript redirects and clicks.
              // Handles browser page object been closed.
            }
          }
        }
      } catch {
        // No logging for this case as it is best effort to handle dynamic client-side JavaScript redirects and clicks.
        // Handles browser page object been closed.
      }
    }
    /* eslint-enable no-await-in-loop */
  };

  const enqueueProcess = async (
    page: Page,
    enqueueLinks: PlaywrightCrawlingContext['enqueueLinks'],
    browserContext: BrowserContext,
  ) => {
    try {
      await enqueueLinks({
        // set selector matches anchor elements with href but not contains # or starting with mailto:
        selector: `a:not(${disallowedSelectorPatterns})`,
        strategy,
        requestQueue,
        transformRequestFunction: (req: RequestOptions): RequestOptions | null => {
          try {
            req.url = req.url.replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
          } catch (e) {
            consoleLogger.error(e);
          }
          if (scannedUrlSet.has(req.url)) {
            req.skipNavigation = true;
          }
          if (isDisallowedInRobotsTxt(req.url)) return null;
          if (isBlacklisted(req.url, blacklistedPatterns)) return null;
          if (isUrlPdf(req.url)) {
            // playwright headless mode does not support navigation to pdf document
            req.skipNavigation = true;
          }
          req.label = req.url;

          return req;
        },
      });

      // If safeMode flag is enabled, skip enqueueLinksByClickingElements
      if (!safeMode) {
        // Only run the expensive element-clicking discovery on pages sharing the
        // same hostname as the seed URL.  Cross-subdomain pages (reachable via
        // same-domain strategy) still contribute their <a> links above, but
        // clicking every interactive element on them is too slow and starves
        // the crawler of time to discover pages on the primary hostname.
        const currentHostname = new URL(page.url()).hostname;
        const seedHostname = new URL(url).hostname;
        if (currentHostname === seedHostname) {
          // Try catch is necessary as clicking links is best effort, it may result in new pages that cause browser load or navigation errors that PlaywrightCrawler does not handle
          try {
            await customEnqueueLinksByClickingElements(page, browserContext);
          } catch {
            // do nothing;
          }
        }
      }
    } catch {
      // No logging for this case as it is best effort to handle dynamic client-side JavaScript redirects and clicks.
      // Handles browser page object been closed.
    }
  };

  let isAbortingScanNow = false;

  const crawler = register(
    new crawlee.PlaywrightCrawler({
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
            const subProfileDir = path.join(
              baseDir,
              `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            );
            await fsp.mkdir(subProfileDir, { recursive: true });

            // Assign to Crawlee's launcher
            // Crawlee preLaunchHooks expects launchContext to be mutated in-place.
            // eslint-disable-next-line no-param-reassign
            launchContext.userDataDir = subProfileDir;

            // Safely extend launchOptions
            // eslint-disable-next-line no-param-reassign
            launchContext.launchOptions = {
              ...launchContext.launchOptions,
              ignoreHTTPSErrors: true,
              ...playwrightDeviceDetailsObject,
              ...(process.env.OOBEE_DISABLE_BROWSER_DOWNLOAD && { acceptDownloads: false }),
              ...(extraHTTPHeaders && { extraHTTPHeaders }),
            };

            // Optionally log for debugging
            // console.log(`[HOOK] Using userDataDir: ${subProfileDir}`);
          },
        ],
      },
      requestQueue,
      postNavigationHooks: [
        async crawlingContext => {
          const { page, request } = crawlingContext;

          await page.evaluate(() => {
            return new Promise(resolve => {
              let timeout;
              let mutationCount = 0;
              const MAX_MUTATIONS = 500; // stop if things never quiet down
              const OBSERVER_TIMEOUT = 5000; // hard cap on total wait

              const observer = new MutationObserver(() => {
                clearTimeout(timeout);

                mutationCount += 1;
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

          let finalUrl = page.url();
          const requestLabelUrl = request.label;

          // to handle scenario where the redirected link is not within the scanning website
          const isLoadedUrlFollowStrategy = isFollowStrategy(finalUrl, requestLabelUrl, strategy);
          if (!isLoadedUrlFollowStrategy) {
            finalUrl = requestLabelUrl;
          }

          const isRedirected = !areLinksEqual(finalUrl, requestLabelUrl);
          if (isRedirected) {
            await enqueueUniqueRequest({ url: finalUrl, label: finalUrl });
          } else {
            request.skipNavigation = false;
          }
        },
      ],
      requestHandlerTimeoutSecs: 90, // Allow each page to be processed by up from default 60 seconds
      requestHandler: async ({
        page,
        request,
        response,
        crawler: activeCrawler,
        sendRequest,
        enqueueLinks,
      }) => {
        const browserContext: BrowserContext = page.context();
        try {
          await waitForPageLoaded(page, 10000);
          let actualUrl = page.url() || request.loadedUrl || request.url;

          if (page.url() !== 'about:blank') {
            actualUrl = page.url();
          }

          // Second-pass requests: only do click-discovery, skip scanning
          if (request.label?.startsWith('__clickpass__')) {
            await enqueueProcess(page, enqueueLinks, browserContext);
            return;
          }

          if (
            !isFollowStrategy(url, actualUrl, strategy) &&
            (isBlacklisted(actualUrl, blacklistedPatterns) || (isUrlPdf(actualUrl) && !isScanPdfs))
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

          // if URL has already been scanned
          if (scannedUrlSet.has(request.url)) {
            await enqueueProcess(page, enqueueLinks, browserContext);
            return;
          }

          if (isDisallowedInRobotsTxt(request.url)) {
            await enqueueProcess(page, enqueueLinks, browserContext);
            return;
          }

          // handle pdfs
          if (
            shouldSkipDueToUnsupportedContent(response, request.url) ||
            (request.skipNavigation && actualUrl === 'about:blank')
          ) {
            if (!isScanPdfs) {
              // Don't inform the user it is skipped since web crawler is best-effort.
              /*
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
            */

              return;
            }
            const { pdfFileName, url: downloadedPdfUrl } = handlePdfDownload(
              randomToken,
              pdfDownloads,
              request,
              sendRequest,
              urlsCrawled,
            );

            uuidToPdfMapping[pdfFileName] = downloadedPdfUrl;
            return;
          }

          if (isBlacklistedFileExtensions(actualUrl, blackListedFileExtensions)) {
            // Don't inform the user it is skipped since web crawler is best-effort.
            /*
          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          urlsCrawled.userExcluded.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl, // because about:blank is not useful
            metadata: STATUS_CODE_METADATA[1],
            httpStatusCode: 0,
          });
          */
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
            // For deduplication, if the URL is redirected, we want to store the original URL and the redirected URL (actualUrl)
            const isRedirected = !areLinksEqual(actualUrl, request.url);

            // check if redirected link is following strategy (same-domain/same-hostname)
            const isLoadedUrlFollowStrategy = isFollowStrategy(actualUrl, request.url, strategy);
            if (isRedirected && !isLoadedUrlFollowStrategy) {
              urlsCrawled.notScannedRedirects.push({
                fromUrl: request.url,
                toUrl: actualUrl, // i.e. actualUrl
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

            const results = await runAxeScript({ includeScreenshots, page, randomToken, ruleset });

            if (isRedirected) {
              const isLoadedUrlInCrawledUrls = scannedResolvedUrlSet.has(actualUrl);

              if (isLoadedUrlInCrawledUrls) {
                urlsCrawled.notScannedRedirects.push({
                  fromUrl: request.url,
                  toUrl: actualUrl, // i.e. actualUrl
                });
                return;
              }

              // One more check if scanned pages have reached limit due to multi-instances of handler running
              if (urlsCrawled.scanned.length < maxRequestsPerCrawl) {
                guiInfoLog(guiInfoStatusTypes.SCANNED, {
                  numScanned: urlsCrawled.scanned.length,
                  urlScanned: request.url,
                });

                urlsCrawled.scanned.push({
                  url: request.url,
                  pageTitle: results.pageTitle,
                  actualUrl, // i.e. actualUrl
                });
                scannedUrlSet.add(request.url);
                scannedResolvedUrlSet.add(actualUrl);

                urlsCrawled.scannedRedirects.push({
                  fromUrl: request.url,
                  toUrl: actualUrl, // i.e. actualUrl
                });

                results.url = request.url;
                results.actualUrl = actualUrl;
                await dataset.pushData(results);
              }
            } else if (urlsCrawled.scanned.length < maxRequestsPerCrawl) {
              // One more check if scanned pages have reached limit due to multi-instances of handler running
              guiInfoLog(guiInfoStatusTypes.SCANNED, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
              });
              urlsCrawled.scanned.push({
                url: request.url,
                actualUrl: request.url,
                pageTitle: results.pageTitle,
              });
              scannedUrlSet.add(request.url);
              scannedResolvedUrlSet.add(request.url);
              await dataset.pushData(results);
            }
          } else {
            // Don't inform the user it is skipped since web crawler is best-effort.
            /*
          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          urlsCrawled.userExcluded.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl, // because about:blank is not useful
            metadata: STATUS_CODE_METADATA[1],
            httpStatusCode: 0,
          });
          */
          }

          if (followRobots)
            await getUrlsFromRobotsTxt(request.url, browser, userDataDirectory, extraHTTPHeaders);
          await enqueueProcess(page, enqueueLinks, browserContext);
        } catch (e) {
          try {
            if (!e.message.includes('page.evaluate')) {
              // do nothing;
              guiInfoLog(guiInfoStatusTypes.ERROR, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
              });

              const recoveryPage = await browserContext.newPage();
              await recoveryPage.goto(request.url);

              await recoveryPage.route('**/*', async route => {
                const interceptedRequest = route.request();
                if (interceptedRequest.resourceType() === 'document') {
                  const interceptedRequestUrl = interceptedRequest
                    .url()
                    .replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
                  await enqueueUniqueRequest({
                    url: interceptedRequestUrl,
                    skipNavigation: isUrlPdf(interceptedRequest.url()),
                    label: interceptedRequestUrl,
                  });
                }
              });
            }
          } catch {
            // Do nothing since the error will be pushed
          }

          // when max pages have been scanned, scan will abort and all relevant pages still opened will close instantly.
          // a browser close error will then be flagged. Since this is an intended behaviour, this error will be excluded.
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

  // Additional passes: keep re-visiting scanned seed-hostname pages for
  // click-discovery until no new pages are found or limits are reached.
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
          } catch {
            return false;
          }
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
            await requestQueue.addRequest({
              url: pageUrl,
              label: clickPassLabel,
              skipNavigation: false,
            });
            enqueued += 1;
          }
        } catch {
          // ignore enqueue errors
        }
      }

      if (enqueued === 0) break;

      await crawler.run();

      // Stop looping if no new pages were discovered in this pass
    } while (urlsCrawled.scanned.length > prevScannedCount);
  }

  if (pdfDownloads.length > 0) {
    // wait for pdf downloads to complete
    await Promise.all(pdfDownloads);

    // scan and process pdf documents
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
