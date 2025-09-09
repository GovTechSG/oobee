import crawlee, { EnqueueStrategy } from 'crawlee';
import fs from 'fs';
import type { BrowserContext, ElementHandle, Frame, Page } from 'playwright';
import type { EnqueueLinksOptions, RequestOptions } from 'crawlee';
import https from 'https';
import type { BatchAddRequestsResult } from '@crawlee/types';
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
import { consoleLogger, guiInfoLog, silentLogger } from '../logs.js';
import { ViewportSettingsClass } from '../combine.js';
import * as path from 'path';
import fsp from 'fs/promises';

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
  let requestQueue: crawlee.RequestQueue;

  if (fromCrawlIntelligentSitemap) {
    dataset = datasetFromIntelligent;
    urlsCrawled = urlsCrawledFromIntelligent;
  } else {
    ({ dataset } = await createCrawleeSubFolders(randomToken));
    urlsCrawled = { ...constants.urlsCrawledObj };
  }

  ({ requestQueue } = await createCrawleeSubFolders(randomToken));

  const pdfDownloads: Promise<void>[] = [];
  const uuidToPdfMapping: Record<string, string> = {};
  const isScanHtml = [FileTypes.All, FileTypes.HtmlOnly].includes(fileTypes as FileTypes);
  const isScanPdfs = [FileTypes.All, FileTypes.PdfOnly].includes(fileTypes as FileTypes);
  const { maxConcurrency } = constants;
  const { playwrightDeviceDetailsObject } = viewportSettings;

  await requestQueue.addRequest({
    url,
    skipNavigation: isUrlPdf(url),
    label: url,
  });

  const enqueueProcess = async (
    page: Page,
    enqueueLinks: (options: EnqueueLinksOptions) => Promise<BatchAddRequestsResult>,
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
          if (urlsCrawled.scanned.some(item => item.url === req.url)) {
            req.skipNavigation = true;
          }
          if (isDisallowedInRobotsTxt(req.url)) return null;
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
        // Try catch is necessary as clicking links is best effort, it may result in new pages that cause browser load or navigation errors that PlaywrightCrawler does not handle
        try {
          await customEnqueueLinksByClickingElements(page, browserContext);
        } catch (e) {
          // do nothing;
        }
      }
    } catch {
      // No logging for this case as it is best effort to handle dynamic client-side JavaScript redirects and clicks.
      // Handles browser page object been closed.
    }
  };

  const customEnqueueLinksByClickingElements = async (
    page: Page,
    browserContext: BrowserContext,
  ): Promise<void> => {
    const initialPageUrl: string = page.url().toString();

    const isExcluded = (newPageUrl: string): boolean => {
      const isAlreadyScanned: boolean = urlsCrawled.scanned.some(item => item.url === newPageUrl);
      const isBlacklistedUrl: boolean = isBlacklisted(newPageUrl, blacklistedPatterns);
      const isNotFollowStrategy: boolean = !isFollowStrategy(newPageUrl, initialPageUrl, strategy);
      const isNotSupportedDocument: boolean = disallowedListOfPatterns.some(pattern =>
        newPageUrl.toLowerCase().startsWith(pattern),
      );
      return isNotSupportedDocument || isAlreadyScanned || isBlacklistedUrl || isNotFollowStrategy;
    };
    const setPageListeners = (page: Page): void => {
      // event listener to handle new page popups upon button click
      page.on('popup', async (newPage: Page) => {
        try {
          if (newPage.url() != initialPageUrl && !isExcluded(newPage.url())) {
            const newPageUrl: string = newPage.url().replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
            await requestQueue.addRequest({
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
      page.on('framenavigated', async (newFrame: Frame) => {
        try {
          if (
            newFrame.url() !== initialPageUrl &&
            !isExcluded(newFrame.url()) &&
            !(newFrame.url() == 'about:blank')
          ) {
            const newFrameUrl: string = newFrame.url().replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
            await requestQueue.addRequest({
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
    setPageListeners(page);
    let currentElementIndex: number = 0;
    let isAllElementsHandled: boolean = false;
    while (!isAllElementsHandled) {
      try {
        // navigate back to initial page if clicking on a element previously caused it to navigate to a new url
        if (page.url() != initialPageUrl) {
          try {
            await page.close();
          } catch {
            // No logging for this case as it is best effort to handle dynamic client-side JavaScript redirects and clicks.
            // Handles browser page object been closed.
          }
          page = await browserContext.newPage();
          await page.goto(initialPageUrl, {
            waitUntil: 'domcontentloaded',
          });
          setPageListeners(page);
        }
        const selectedElementsString = cssQuerySelectors.join(', ');
        const selectedElements: ElementHandle<SVGElement | HTMLElement>[] =
          await page.$$(selectedElementsString);
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
          // Find url in html elements without clicking them
          await page
            .evaluate(element => {
              // find href attribute
              const hrefUrl: string = element.getAttribute('href');

              // find url in datapath
              const dataPathUrl: string = element.getAttribute('data-path');

              return hrefUrl || dataPathUrl;
            }, element)
            .then(result => {
              if (result) {
                newUrlFoundInElement = result;
                const pageUrl: URL = new URL(page.url());
                const baseUrl: string = `${pageUrl.protocol}//${pageUrl.host}`;
                let absoluteUrl: URL;
                // Construct absolute URL using base URL
                try {
                  // Check if newUrlFoundInElement is a valid absolute URL
                  absoluteUrl = new URL(newUrlFoundInElement);
                } catch (e) {
                  // If it's not a valid URL, treat it as a relative URL
                  absoluteUrl = new URL(newUrlFoundInElement, baseUrl);
                }
                newUrlFoundInElement = absoluteUrl.href;
              }
            });
          if (newUrlFoundInElement && !isExcluded(newUrlFoundInElement)) {
            const newUrlFoundInElementUrl: string = newUrlFoundInElement.replace(
              /(?<=&|\?)utm_.*?(&|$)/gim,
              '',
            );

            await requestQueue.addRequest({
              url: newUrlFoundInElementUrl,
              skipNavigation: isUrlPdf(newUrlFoundInElement),
              label: newUrlFoundInElementUrl,
            });
          } else if (!newUrlFoundInElement) {
            try {
              const shouldSkip = await shouldSkipClickDueToDisallowedHref(page, element);
              if (shouldSkip) {
                const elementHtml = await page.evaluate(el => el.outerHTML, element);
                consoleLogger.info(
                  'Skipping a click due to disallowed href nearby. Element HTML:',
                  elementHtml,
                );
                continue;
              }

              // Find url in html elements by manually clicking them. New page navigation/popups will be handled by event listeners above
              await element.click({ force: true });
              await page.waitForTimeout(1000); // Add a delay of 1 second between each Element click
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
  };

  let isAbortingScanNow = false;

  const crawler = register(new crawlee.PlaywrightCrawler({
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

        let finalUrl = page.url();
        const requestLabelUrl = request.label;

        // to handle scenario where the redirected link is not within the scanning website
        const isLoadedUrlFollowStrategy = isFollowStrategy(finalUrl, requestLabelUrl, strategy);
        if (!isLoadedUrlFollowStrategy) {
          finalUrl = requestLabelUrl;
        }

        const isRedirected = !areLinksEqual(finalUrl, requestLabelUrl);
        if (isRedirected) {
          await requestQueue.addRequest({ url: finalUrl, label: finalUrl });
        } else {
          request.skipNavigation = false;
        }
      },
    ],
    requestHandlerTimeoutSecs: 90, // Allow each page to be processed by up from default 60 seconds
    requestHandler: async ({ page, request, response, crawler, sendRequest, enqueueLinks }) => {
      const browserContext: BrowserContext = page.context();
      try {
        await waitForPageLoaded(page, 10000);
        let actualUrl = page.url() || request.loadedUrl || request.url;

        if (page.url() !== 'about:blank') {
          actualUrl = page.url();
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
          }
          isAbortingScanNow = true;
          crawler.autoscaledPool.abort();
          return;
        }

        // if URL has already been scanned
        if (urlsCrawled.scanned.some(item => item.url === request.url)) {
          // await enqueueProcess(page, enqueueLinks, browserContext);
          return;
        }

        if (isDisallowedInRobotsTxt(request.url)) {
          await enqueueProcess(page, enqueueLinks, browserContext);
          return;
        }

        // handle pdfs
        if (shouldSkipDueToUnsupportedContent(response, request.url) || (request.skipNavigation && actualUrl === 'about:blank')) {
          if (!isScanPdfs) {
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

        if (isBlacklistedFileExtensions(actualUrl, blackListedFileExtensions)) {
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
            const isLoadedUrlInCrawledUrls = urlsCrawled.scanned.some(
              item => (item.actualUrl || item.url) === actualUrl,
            );

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

              urlsCrawled.scannedRedirects.push({
                fromUrl: request.url,
                toUrl: actualUrl, // i.e. actualUrl
              });

              results.url = request.url;
              results.actualUrl = actualUrl;
              await dataset.pushData(results);
            }
          } else {
            // One more check if scanned pages have reached limit due to multi-instances of handler running
            if (urlsCrawled.scanned.length < maxRequestsPerCrawl) {
              guiInfoLog(guiInfoStatusTypes.SCANNED, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
              });
              urlsCrawled.scanned.push({
                url: request.url,
                actualUrl: request.url,
                pageTitle: results.pageTitle,
              });
              await dataset.pushData(results);
            }
          }
        } else {
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
        }

        if (followRobots) await getUrlsFromRobotsTxt(request.url, browser, userDataDirectory, extraHTTPHeaders);
        await enqueueProcess(page, enqueueLinks, browserContext);
      } catch (e) {
        try {
          if (!e.message.includes('page.evaluate')) {
            // do nothing;
            guiInfoLog(guiInfoStatusTypes.ERROR, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });

            page = await browserContext.newPage();
            await page.goto(request.url);

            await page.route('**/*', async route => {
              const interceptedRequest = route.request();
              if (interceptedRequest.resourceType() === 'document') {
                const interceptedRequestUrl = interceptedRequest
                  .url()
                  .replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
                await requestQueue.addRequest({
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
        scaleUpStepRatio: 0.99,        // Scale up faster
        scaleDownStepRatio: 0.1,       // Scale down slower
      },
    }),
  }));

  await crawler.run();

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
    console.log(`Crawl ended after ${elapsed}s. Limit: ${scanDuration}s.`);
  }
  return urlsCrawled;
};

export default crawlDomain;
