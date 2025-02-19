import crawlee, { EnqueueStrategy } from 'crawlee';
import fs from 'fs';
import type { BrowserContext, ElementHandle, Frame, Page } from 'playwright';
import type { EnqueueLinksOptions, RequestOptions } from 'crawlee';
import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import mime from 'mime-types';
import https from 'https';
import type { BatchAddRequestsResult } from '@crawlee/types';
import {
  createCrawleeSubFolders,
  preNavigationHooks,
  runAxeScript,
  isUrlPdf,
} from './commonCrawlerFunc.js';
import constants, {
  UrlsCrawled,
  blackListedFileExtensions,
  guiInfoStatusTypes,
  cssQuerySelectors,
  RuleFlags,
} from '../constants/constants.js';
import {
  getPlaywrightLaunchOptions,
  isBlacklistedFileExtensions,
  isSkippedUrl,
  isDisallowedInRobotsTxt,
  getUrlsFromRobotsTxt,
  getBlackListedPatterns,
  urlWithoutAuth,
  waitForPageLoaded,
} from '../constants/common.js';
import { areLinksEqual, isFollowStrategy } from '../utils.js';
import {
  handlePdfDownload,
  runPdfScan,
  mapPdfScanResults,
  doPdfScreenshots,
} from './pdfScanFunc.js';
import { silentLogger, guiInfoLog } from '../logs.js';
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
  fileTypes: string;
  blacklistedPatterns: string[];
  includeScreenshots: boolean;
  followRobots: boolean;
  extraHTTPHeaders: Record<string, string>;
  safeMode?: boolean;
  fromCrawlIntelligentSitemap?: boolean;
  datasetFromIntelligent?: crawlee.Dataset;
  urlsCrawledFromIntelligent?: UrlsCrawled;
  ruleset?: RuleFlags[];
}) => {
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

  if (!fs.existsSync(randomToken)) {
    fs.mkdirSync(randomToken);
  }

  const pdfDownloads = [];
  const uuidToPdfMapping = {};
  const isScanHtml = ['all', 'html-only'].includes(fileTypes);
  const isScanPdfs = ['all', 'pdf-only'].includes(fileTypes);
  const { maxConcurrency } = constants;
  const { playwrightDeviceDetailsObject } = viewportSettings;
  const isBlacklistedUrl = isBlacklisted(url, blacklistedPatterns);

  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  // Boolean to omit axe scan for basic auth URL
  let isBasicAuth = false;
  let authHeader = '';

  // Test basic auth and add auth header if auth exist
  const parsedUrl = new URL(url);
  let username: string;
  let password: string;
  if (parsedUrl.username !== '' && parsedUrl.password !== '') {
    isBasicAuth = true;
    username = decodeURIComponent(parsedUrl.username);
    password = decodeURIComponent(parsedUrl.password);

    // Create auth header
    authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

    // Remove username from parsedUrl
    parsedUrl.username = '';
    parsedUrl.password = '';
    // Send the finalUrl without credentials by setting auth header instead
    const finalUrl = parsedUrl.toString();

    await requestQueue.addRequest({
      url: finalUrl,
      skipNavigation: isUrlPdf(finalUrl),
      headers: {
        Authorization: authHeader,
      },
      label: finalUrl,
    });
  } else {
    await requestQueue.addRequest({
      url,
      skipNavigation: isUrlPdf(url),
      label: url,
    });
  }

  const httpHeadCache = new Map<string, boolean>();
  const isProcessibleUrl = async (url: string): Promise<boolean> => {
    if (httpHeadCache.has(url)) {
      silentLogger.info('cache hit', url, httpHeadCache.get(url));
      return false; // return false to avoid processing the url again
    }

    try {
      // Send a HEAD request to check headers without downloading the file
      const headResponse = await axios.head(url, {
        headers: { Authorization: authHeader },
        httpsAgent,
      });
      const contentType = headResponse.headers['content-type'] || '';
      const contentDisposition = headResponse.headers['content-disposition'] || '';

      // Check if the response suggests it's a downloadable file based on Content-Disposition header
      if (contentDisposition.includes('attachment')) {
        silentLogger.info(`Skipping URL due to attachment header: ${url}`);
        httpHeadCache.set(url, false);
        return false;
      }

      // Check if the MIME type suggests it's a downloadable file
      if (contentType.startsWith('application/') || contentType.includes('octet-stream')) {
        silentLogger.info(`Skipping potential downloadable file: ${contentType} at URL ${url}`);
        httpHeadCache.set(url, false);
        return false;
      }

      // Use the mime-types library to ensure it's processible content (e.g., HTML or plain text)
      const mimeType = mime.lookup(contentType);
      if (mimeType && !mimeType.startsWith('text/html') && !mimeType.startsWith('text/')) {
        silentLogger.info(`Detected non-processible MIME type: ${mimeType} at URL ${url}`);
        httpHeadCache.set(url, false);
        return false;
      }

      // Additional check for zip files by their magic number (PK\x03\x04)
      if (url.endsWith('.zip')) {
        silentLogger.info(`Checking for zip file magic number at URL ${url}`);

        // Download the first few bytes of the file to check for the magic number
        const byteResponse = await axios.get(url, {
          headers: { Range: 'bytes=0-3', Authorization: authHeader },
          responseType: 'arraybuffer',
          httpsAgent,
        });

        const magicNumber = byteResponse.data.toString('hex');
        if (magicNumber === '504b0304') {
          silentLogger.info(`Skipping zip file at URL ${url}`);
          httpHeadCache.set(url, false);
          return false;
        }
        silentLogger.info(
          `Not skipping ${url}, magic number does not match ZIP file: ${magicNumber}`,
        );
      }

      // If you want more robust checks, you can download a portion of the content and use the file-type package to detect file types by content
      const response = await axios.get(url, {
        headers: { Range: 'bytes=0-4100', Authorization: authHeader },
        responseType: 'arraybuffer',
        httpsAgent,
      });

      const fileType = await fileTypeFromBuffer(response.data);
      if (
        fileType &&
        !fileType.mime.startsWith('text/html') &&
        !fileType.mime.startsWith('text/')
      ) {
        silentLogger.info(`Detected downloadable file of type ${fileType.mime} at URL ${url}`);
        httpHeadCache.set(url, false);
        return false;
      }
    } catch (e) {
      // silentLogger.error(`Error checking the MIME type of ${url}: ${e.message}`);
      // If an error occurs (e.g., a network issue), assume the URL is processible
      httpHeadCache.set(url, true);
      return true;
    }

    // If none of the conditions to skip are met, allow processing of the URL
    httpHeadCache.set(url, true);
    return true;
  };

  const enqueueProcess = async (
    page: Page,
    enqueueLinks: (options: EnqueueLinksOptions) => Promise<BatchAddRequestsResult>,
    browserContext: BrowserContext,
  ) => {
    try {
      await enqueueLinks({
        // set selector matches anchor elements with href but not contains # or starting with mailto:
        selector: 'a:not(a[href*="#"],a[href^="mailto:"])',
        strategy,
        requestQueue,
        transformRequestFunction: (req: RequestOptions): RequestOptions | null => {
          try {
            req.url = req.url.replace(/(?<=&|\?)utm_.*?(&|$)/gim, '');
          } catch (e) {
            silentLogger.error(e);
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
          silentLogger.info(e);
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
      return isAlreadyScanned || isBlacklistedUrl || isNotFollowStrategy;
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

  let userDataDir = '';
  if (userDataDirectory) {
    userDataDir = process.env.CRAWLEE_HEADLESS !== '0' ? userDataDirectory : '';
  }

  const crawler = new crawlee.PlaywrightCrawler({
    launchContext: {
      launcher: constants.launcher,
      launchOptions: getPlaywrightLaunchOptions(browser),
      // Bug in Chrome which causes browser pool crash when userDataDirectory is set in non-headless mode
      ...(process.env.CRAWLEE_HEADLESS === '0' && { userDataDir }),
    },
    retryOnBlocked: true,
    browserPoolOptions: {
      useFingerprints: false,
      preLaunchHooks: [
        async (_pageId, launchContext) => {
          launchContext.launchOptions = {
            ...launchContext.launchOptions,
            bypassCSP: true,
            ignoreHTTPSErrors: true,
            ...playwrightDeviceDetailsObject,
          };
        },
      ],
    },
    requestQueue,
    postNavigationHooks: [
      async crawlingContext => {
        const { page, request } = crawlingContext;

        request.skipNavigation = true;

        await page.evaluate(() => {
          return new Promise(resolve => {
            let timeout;
            let mutationCount = 0;
            const MAX_MUTATIONS = 250;
            const MAX_SAME_MUTATION_LIMIT = 10;
            const mutationHash = {};

            const observer = new MutationObserver(mutationsList => {
              clearTimeout(timeout);

              mutationCount += 1;

              if (mutationCount > MAX_MUTATIONS) {
                observer.disconnect();
                resolve('Too many mutations detected');
              }

              // To handle scenario where DOM elements are constantly changing and unable to exit
              mutationsList.forEach(mutation => {
                let mutationKey;

                if (mutation.target instanceof Element) {
                  Array.from(mutation.target.attributes).forEach(attr => {
                    mutationKey = `${mutation.target.nodeName}-${attr.name}`;

                    if (mutationKey) {
                      if (!mutationHash[mutationKey]) {
                        mutationHash[mutationKey] = 1;
                      } else {
                        mutationHash[mutationKey]++;
                      }

                      if (mutationHash[mutationKey] >= MAX_SAME_MUTATION_LIMIT) {
                        observer.disconnect();
                        resolve(`Repeated mutation detected for ${mutationKey}`);
                      }
                    }
                  });
                }
              });

              timeout = setTimeout(() => {
                observer.disconnect();
                resolve('DOM stabilized after mutations.');
              }, 1000);
            });

            timeout = setTimeout(() => {
              observer.disconnect();
              resolve('No mutations detected, exit from idle state');
            }, 1000);

            observer.observe(document, { childList: true, subtree: true, attributes: true });
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
    preNavigationHooks: isBasicAuth
      ? [
        async ({ page, request }) => {
          await page.setExtraHTTPHeaders({
            Authorization: authHeader,
            ...extraHTTPHeaders,
          });
          const processible = await isProcessibleUrl(request.url);
          if (!processible) {
            request.skipNavigation = true;
            return null;
          }
        },
      ]
      : [
        async ({ page, request }) => {
          await page.setExtraHTTPHeaders({
            ...extraHTTPHeaders,
          });

          const processible = await isProcessibleUrl(request.url);
          if (!processible) {
            request.skipNavigation = true;
            return null;
          }
        },
      ],
    requestHandlerTimeoutSecs: 90, // Allow each page to be processed by up from default 60 seconds
    requestHandler: async ({ page, request, response, crawler, sendRequest, enqueueLinks }) => {
      const browserContext: BrowserContext = page.context();
      try {
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
        let actualUrl = page.url() || request.loadedUrl || request.url;

        if (page.url() !== 'about:blank') {
          actualUrl = page.url();
        }

        if (!isFollowStrategy(url, actualUrl, strategy) && (isBlacklisted(actualUrl, blacklistedPatterns) || (isUrlPdf(actualUrl) && !isScanPdfs))) {
          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: actualUrl,
          });
          return;
        }

        if (urlsCrawled.scanned.length >= maxRequestsPerCrawl) {
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
        if (request.skipNavigation && isUrlPdf(actualUrl)) {
          if (!isScanPdfs) {
            guiInfoLog(guiInfoStatusTypes.SKIPPED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });
            urlsCrawled.blacklisted.push({
              url: request.url,
              pageTitle: request.url,
              actualUrl: actualUrl, // i.e. actualUrl
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

        const resHeaders = response ? response.headers() : {}; // Safely access response headers
        const contentType = resHeaders['content-type'] || ''; // Ensure contentType is defined

        // Skip non-HTML and non-PDF URLs
        if (!contentType.includes('text/html') && !contentType.includes('application/pdf')) {
          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          urlsCrawled.blacklisted.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl: actualUrl, // i.e. actualUrl
          });

          return;
        }

        if (isBlacklistedFileExtensions(actualUrl, blackListedFileExtensions)) {
          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          urlsCrawled.blacklisted.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl: actualUrl, // i.e. actualUrl
          });

          return;
        }

        if (!isFollowStrategy(url, actualUrl, strategy) && blacklistedPatterns && isSkippedUrl(actualUrl, blacklistedPatterns)) {
          urlsCrawled.userExcluded.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl: actualUrl,
          });

          await enqueueProcess(page, enqueueLinks, browserContext);
          return;
        }

        if (response.status() === 403) {
          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          urlsCrawled.forbidden.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl: actualUrl, // i.e. actualUrl
          });

          return;
        }

        if (response.status() !== 200) {
          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          urlsCrawled.invalid.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl: actualUrl, // i.e. actualUrl
          });

          return;
        }

        if (isScanHtml) {
          // For deduplication, if the URL is redirected, we want to store the original URL and the redirected URL (actualUrl)
          const isRedirected = !areLinksEqual(actualUrl, request.url);

          // check if redirected link is following strategy (same-domain/same-hostname)
          const isLoadedUrlFollowStrategy = isFollowStrategy(
            actualUrl,
            request.url,
            strategy,
          );
          if (isRedirected && !isLoadedUrlFollowStrategy) {
            urlsCrawled.notScannedRedirects.push({
              fromUrl: request.url,
              toUrl: actualUrl, // i.e. actualUrl
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
                url: urlWithoutAuth(request.url),
                pageTitle: results.pageTitle,
                actualUrl: actualUrl, // i.e. actualUrl
              });

              urlsCrawled.scannedRedirects.push({
                fromUrl: urlWithoutAuth(request.url),
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
                urlScanned: urlWithoutAuth(request.url),
              });
              urlsCrawled.scanned.push({
                url: urlWithoutAuth(request.url),
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
          urlsCrawled.blacklisted.push({
            url: request.url,
            pageTitle: request.url,
            actualUrl: actualUrl, // i.e. actualUrl
          });

        }

        if (followRobots) await getUrlsFromRobotsTxt(request.url, browser);
        await enqueueProcess(page, enqueueLinks, browserContext);
      } catch (e) {
        try {
          if (!e.message.includes('page.evaluate')) {
            silentLogger.info(e);
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
          urlsCrawled.error.push({ url: request.url });
        }
      }
    },
    failedRequestHandler: async ({ request }) => {
      guiInfoLog(guiInfoStatusTypes.ERROR, {
        numScanned: urlsCrawled.scanned.length,
        urlScanned: request.url,
      });
      urlsCrawled.error.push({ url: request.url });
      crawlee.log.error(`Failed Request - ${request.url}: ${request.errorMessages}`);
    },
    maxRequestsPerCrawl: Infinity,
    maxConcurrency: specifiedMaxConcurrency || maxConcurrency,
  });

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

  return urlsCrawled;
};

export default crawlDomain;
