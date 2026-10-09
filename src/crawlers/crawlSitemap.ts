import crawlee, { EnqueueStrategy, LaunchContext, Request, RequestList, Dataset } from 'crawlee';
import { CrawlRateController, startConcurrencyEnforcer } from './crawlRateController.js';
import fs from 'fs';
import { getDomain } from 'tldts';
import {
  createCrawleeSubFolders,
  getPreLaunchHook,
  getPostPageCloseHook,
  preNavigationHooks,
  runAxeScript,
  isUrlPdf,
  splitAuthHeaders,
  hasCredentialHeaders,
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
  isDisallowedInRobotsTxt,
  isSkippedUrl,
  waitForPageLoaded,
  isFilePath,
  isInternalOrLoopbackUrl,
  isLinkLocalOrMetadataUrl,
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
import { registerCrawler, unregisterCrawler, isShutdownRequested } from '../shutdownController.js';

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
  requestQueueName,
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
  requestQueueName?: string;
}) => {
  const crawlStartTime = Date.now();
  let dataset: crawlee.Dataset;
  let urlsCrawled: UrlsCrawled;
  let durationExceeded = false;
  let isAbortingScan = false;
  let lastSuccessTime = Date.now();
  // Default 0 = disabled (no idle-timeout abort). Any positive value enables
  // aborting after that many minutes without a successful scan.
  const maxIdleMinutes = Number(process.env.OOBEE_MAX_IDLE_MINUTES) || 0;
  const maxIdleMs = maxIdleMinutes > 0 ? maxIdleMinutes * 60 * 1000 : 0;
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
    ({ dataset } = await createCrawleeSubFolders(randomToken, requestQueueName));
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
  // Intelligent scans process multiple sitemaps sequentially. The shared request
  // queue deduplicates enqueueLinks discoveries, but each phase builds its own
  // RequestList from the sitemap XML — RequestList entries bypass queue dedup.
  // Track previously scanned URLs so we can filter the RequestList upfront and
  // short-circuit the handler for any that slip through.
  const scannedUrlSet = fromCrawlIntelligentSitemap
    ? new Set<string>(urlsCrawled.scanned.map(item => normUrl(item.url)))
    : null;
  const { playwrightDeviceDetailsObject } = viewportSettings;
  const { maxConcurrency } = constants;
  // Bind Basic-auth credentials to the entry URL's origin so Playwright
  // won't auto-attach them after a cross-origin redirect (credential leak).
  const { nonAuthHeaders, httpCredentials } = splitAuthHeaders(
    extraHTTPHeaders,
    userUrl || sitemapUrl,
  );

  // asgard-0004: operator headers (Cookie, X-Api-Key, WAF bypass tokens, ...)
  // are scoped to the entry URL's registrable domain by default, so a sitemap
  // entry or third-party subresource on another site never receives them.
  // Site rather than origin is the default because these headers commonly
  // authenticate same-site subdomains too (static./cdn./api.) — stripping
  // them there could change what renders, which would invalidate the scan.
  // OOBEE_SCOPE_HEADERS_TO_ORIGIN=1 tightens to exact origin;
  // OOBEE_UNSCOPED_OPERATOR_HEADERS=1 restores the legacy send-everywhere
  // behaviour for setups that genuinely need it.
  const envOn = (v?: string) => /^(1|true|yes)$/i.test(v ?? '');
  const headerScope: 'all' | 'origin' | 'site' = envOn(process.env.OOBEE_UNSCOPED_OPERATOR_HEADERS)
    ? 'all'
    : envOn(process.env.OOBEE_SCOPE_HEADERS_TO_ORIGIN)
      ? 'origin'
      : 'site';
  const scopeHeaders = headerScope !== 'all';
  const headerScopedContexts = new WeakSet<object>();
  const scopeEntry = (() => {
    try {
      const u = new URL(userUrl || sitemapUrl);
      return { origin: u.origin, site: getDomain(u.hostname, { allowPrivateDomains: true }) || u.hostname };
    } catch {
      return null;
    }
  })();
  const isInHeaderScope = (target: string): boolean => {
    if (!scopeEntry) return false;
    try {
      const u = new URL(target);
      if (headerScope === 'origin') return u.origin === scopeEntry.origin;
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      return (getDomain(u.hostname, { allowPrivateDomains: true }) || u.hostname) === scopeEntry.site;
    } catch {
      return false;
    }
  };
  // preNavigationHooks copies whatever it is given onto request.headers,
  // which Crawlee applies page-wide via setExtraHTTPHeaders — that would
  // re-leak the non-auth headers to every subresource. When scoping, hand it
  // only Authorization (which it already origin-gates) and let the route
  // handler below attach the rest per request.
  const navHeaders = scopeHeaders
    ? Object.fromEntries(
        Object.entries(extraHTTPHeaders || {}).filter(([k]) => k.toLowerCase() === 'authorization'),
      )
    : extraHTTPHeaders;

  // Never send caller-supplied credentials to a server whose certificate
  // couldn't be validated (asgard-0006). Matches the runCustom /
  // launchPersistentSafeContext safe pattern: hold TLS validation ON whenever
  // credentials are attached, and require an explicit opt-in env var for
  // credential-less scans that legitimately need to reach hosts with broken
  // certs.
  // asgard-0008: Cookie / API-key style headers count as credentials too.
  const hasCredentials = !!httpCredentials || hasCredentialHeaders(extraHTTPHeaders);
  const allowInsecureTls =
    !hasCredentials &&
    ['1', 'true', 'yes'].includes(
      String(process.env.OOBEE_ALLOW_INSECURE_TLS || '').toLowerCase(),
    );
  if (hasCredentials) {
    consoleLogger.info(
      '[crawlSitemap] Credentials detected — enforcing TLS certificate validation for this scan',
    );
  }

  // Filter out URLs already scanned in previous phases to avoid navigating to
  // them at all (the handler-level check is a safety net, not the primary gate).
  const filteredSources = scannedUrlSet
    ? linksFromSitemap.filter(req => !scannedUrlSet.has(normUrl(req.url)))
    : linksFromSitemap;

  if (scannedUrlSet && filteredSources.length < linksFromSitemap.length) {
    consoleLogger.info(
      `Skipped ${linksFromSitemap.length - filteredSources.length} URLs already scanned in previous phases`,
    );
  }

  const requestList = await RequestList.open({
    sources: filteredSources,
  });

  // Always create a request queue alongside the request list. An empty queue
  // has zero impact on crawl behavior (Crawlee processes RequestList first).
  // Having it available enables: download re-enqueue for PDF scanning,
  // 403 rate-limit retry, and enqueueLinks for intelligent sitemap discovery.
  const { requestQueue } = await createCrawleeSubFolders(randomToken, requestQueueName);

  // asgard-0004: PDF downloads may reach internal addresses only when the
  // operator's own entry URL is internal (localhost / intranet scans).
  const entryIsInternal = await isInternalOrLoopbackUrl(userUrl || sitemapUrl);

  // asgard-0004 (2026-10-09 scan): sitemap <loc> entries are scanned content,
  // so they can point anywhere. Same policy as crawlDomain's navigation guard:
  //  - link-local / cloud-metadata: always refused;
  //  - loopback / private: refused unless the operator's entry is internal.
  // Non-http(s) entries (local-file sitemaps) are not network egress.
  const isRefusedEgressUrl = async (target: string): Promise<boolean> => {
    let protocol = '';
    try {
      protocol = new URL(target).protocol;
    } catch {
      return false;
    }
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    if (await isLinkLocalOrMetadataUrl(target)) return true;
    if (entryIsInternal) return false;
    return isInternalOrLoopbackUrl(target);
  };
  const recordRefusedEgress = (requestUrl: string) => {
    guiInfoLog(guiInfoStatusTypes.SKIPPED, {
      numScanned: urlsCrawled.scanned.length,
      urlScanned: requestUrl,
    });
    urlsCrawled.userExcluded.push({
      url: requestUrl,
      pageTitle: requestUrl,
      actualUrl: requestUrl,
      metadata: STATUS_CODE_METADATA[0],
      httpStatusCode: 0,
    });
  };

  // Shared with handlePdfDownload so PDFs stream through the same client the crawler uses.
  const httpClient = new crawlee.GotScrapingHttpClient();

  const crawler = register(
    new crawlee.PlaywrightCrawler({
      httpClient,
      launchContext: {
        launcher: constants.launcher,
        launchOptions: getPlaywrightLaunchOptions(browser),
      },
      retryOnBlocked: false,
      // Crawlee's session pool treats 401/403/429 as "blocked" by default: it
      // throws before the requestHandler runs and retires the session, which
      // retires the whole browser. Combined with maxRequestRetries and the
      // ratelimit_ re-enqueue below, every blocked URL cost ~8 navigations and
      // ~8 Chrome relaunches — hours on a 2 vCPU container when a WAF blocks
      // most of a large sitemap. Let these statuses reach the requestHandler,
      // which records them and retries once via the ratelimit_ re-enqueue.
      sessionPoolOptions: { blockedStatusCodes: [] },
      browserPoolOptions: {
        useFingerprints: false,
        retireBrowserAfterPageCount: 500,
        closeInactiveBrowserAfterSecs: 30,
        preLaunchHooks: [
          getPreLaunchHook(userDataDirectory),
          async (_pageId, launchContext) => {
            launchContext.launchOptions = {
              ...launchContext.launchOptions,
              ignoreHTTPSErrors: allowInsecureTls,
              ...playwrightDeviceDetailsObject,
              ...(process.env.OOBEE_USER_AGENT && { userAgent: process.env.OOBEE_USER_AGENT }),
              ...(process.env.OOBEE_DISABLE_BROWSER_DOWNLOAD && { acceptDownloads: false }),
              ...(!scopeHeaders && nonAuthHeaders && { extraHTTPHeaders: nonAuthHeaders }),
              ...(httpCredentials && { httpCredentials }),
            };
          },
        ],
        postPageCloseHooks: [getPostPageCloseHook(userDataDirectory)],
      },
      requestList,
      requestQueue,
      maxRequestRetries: 3,
      postNavigationHooks: [
        async ({ page, response }) => {
          // Blocked responses are recorded/retried without being scanned, so
          // there's nothing to wait for. Without this, every 403/429 paid the
          // full observer cap — serialised once the rate controller has
          // dropped concurrency to 1, that's 5s × every blocked URL × 2.
          const status = response?.status();
          if (status === 403 || status === 429) return;
          try {
            // Wait for a quiet period in the DOM, but with safeguards
            await page.evaluate(() => {
              return new Promise(resolve => {
                let timeout: ReturnType<typeof setTimeout>;
                let hardCap: ReturnType<typeof setTimeout>;
                let mutationCount = 0;
                const MAX_MUTATIONS = 500; // stop if things never quiet down
                const OBSERVER_TIMEOUT = 5000; // hard cap on total wait
                const QUIET_MS = 1000;

                const finish = (reason: string) => {
                  clearTimeout(timeout);
                  clearTimeout(hardCap);
                  observer.disconnect();
                  resolve(reason);
                };

                const observer = new MutationObserver(() => {
                  clearTimeout(timeout);

                  mutationCount++;
                  if (mutationCount > MAX_MUTATIONS) {
                    finish('Too many mutations, exiting.');
                    return;
                  }

                  // restart quiet‑period timer
                  timeout = setTimeout(() => finish('DOM stabilized.'), QUIET_MS);
                });

                // Initial quiet window: a page that never mutates is already
                // stable. This previously used OBSERVER_TIMEOUT, so every
                // static page (incl. WAF block pages) waited the full 5s.
                timeout = setTimeout(() => finish('No mutations, DOM stable.'), QUIET_MS);
                // Overall cap in case the page never settles. Separate timer:
                // the old code reused `timeout`, so the first mutation cleared
                // the cap and a steady trickle of mutations could extend the
                // wait indefinitely (bounded only by MAX_MUTATIONS).
                hardCap = setTimeout(() => finish('Observer timeout reached.'), OBSERVER_TIMEOUT);

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
        ...preNavigationHooks(navHeaders, userUrl || sitemapUrl),
        // Renderer crashes are almost always OOM; let the controller shed load.
        async ({ page, request }) => {
          page.once('crash', () => rateController.onRendererCrash(crawler.autoscaledPool, request.url));
        },
        // asgard-0004: attach non-Authorization operator headers per request,
        // only when the request is within headerScope. fallback() (not
        // continue()) so any later-registered route handler still runs.
        async ({ page }) => {
          if (!scopeHeaders || !nonAuthHeaders) return;
          const ctx = page.context();
          if (headerScopedContexts.has(ctx)) return;
          headerScopedContexts.add(ctx);
          await ctx.route('**/*', async (route, req) => {
            try {
              if (isInHeaderScope(req.url())) {
                await route.fallback({ headers: { ...req.headers(), ...nonAuthHeaders } });
                return;
              }
            } catch {
              // fall through to an unmodified request
            }
            await route.fallback();
          });
        },
        async ({ request, page }, gotoOptions) => {
          if (await isRefusedEgressUrl(request.url)) {
            consoleLogger.warn(`Refusing to navigate to internal/metadata address: ${request.url}`);
            request.skipNavigation = true;
            request.userData.isRefusedEgress = true;
            return;
          }
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
      errorHandler: async ({ request }, error) => {
        const msg = error?.message || '';
        if (msg.includes('ERR_BLOCKED_BY_CLIENT') || msg.includes('ERR_BLOCKED_BY_RESPONSE')) {
          request.noRetry = true;
        }
      },
      requestHandlerTimeoutSecs: 90,
      requestHandler: async ({ page, request, response, enqueueLinks, session }) => {
        // asgard-0004: refused before navigation (internal/metadata target).
        if (request.userData?.isRefusedEgress) {
          recordRefusedEgress(request.url);
          return;
        }

        // asgard-0004: the pre-nav check can't see 3xx targets or a DNS answer
        // that changes after our lookup. response.serverAddr() can't be used
        // here: Crawlee routes Chrome through its own local proxy, so it always
        // reports 127.0.0.1 (that refused every page). Instead re-check every
        // redirect hop and the final URL; isRefusedEgressUrl resolves DNS again,
        // so a host that has since rebound to an internal address is refused.
        if (response) {
          const hops = new Set<string>();
          let hop = response.request();
          while (hop) {
            hops.add(hop.url());
            hop = hop.redirectedFrom();
          }
          hops.add(page.url());
          let refusedHop: string | undefined;
          for (const hopUrl of hops) {
            if (await isRefusedEgressUrl(hopUrl)) {
              refusedHop = hopUrl;
              break;
            }
          }
          if (refusedHop) {
            consoleLogger.warn(`Refusing content from internal address ${refusedHop} (${request.url})`);
            recordRefusedEgress(request.url);
            return;
          }
        }

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
          // Blocked responses are recorded (or retried) below without being
          // scanned — don't spend the full page-stability budget on a WAF page.
          const earlyStatus = response?.status();
          if (earlyStatus !== 403 && earlyStatus !== 429) {
            const { mainThreadBusy } = await waitForPageLoaded(page);
            rateController.onPageLoad(mainThreadBusy, crawler.autoscaledPool);
          }

          // Cross-phase dedup for intelligent scans: skip URLs already scanned by a
          // previous phase (shared urlsCrawled). Standalone sitemap scans have
          // scannedUrlSet === null and fall through unchanged. Placed after
          // waitForPageLoaded so every loaded page still stabilizes the browser
          // context before we return.
          if (scannedUrlSet?.has(normUrl(request.url))) {
            return;
          }

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
                httpClient,
                urlsCrawled,
                session,
                entryIsInternal,
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

          if (status === 403 || status === 429) {
            const isRetry = request.userData?.rateLimitRetried === true;
            if (
              rateController.onFailure(status, crawler.autoscaledPool, {
                skipConcurrencyReduction: isRetry,
              })
            ) {
              consoleLogger.info(
                `Aborting crawl: consecutive HTTP failures threshold reached (site may be rate-limiting). Successfully scanned ${urlsCrawled.scanned.length} pages.`,
              );
              isAbortingScan = true;
              crawler.autoscaledPool?.abort();
            }
            // Retry once (at the back of the queue, after concurrency has
            // dropped) before recording the URL as blocked.
            if (!isRetry && !isAbortingScan) {
              try {
                await requestQueue.addRequest({
                  url: request.url,
                  label: request.url,
                  uniqueKey: `ratelimit_${request.url}`,
                  userData: { rateLimitRetried: true },
                });
                return;
              } catch {}
            }
            guiInfoLog(guiInfoStatusTypes.SKIPPED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });
            urlsCrawled.userExcluded.push({
              url: request.url,
              pageTitle: request.url,
              actualUrl,
              metadata: STATUS_CODE_METADATA[status] || STATUS_CODE_METADATA[599],
              httpStatusCode: status,
            });
            return;
          }

          // Transient 5xx from load balancers / origin overload often resolves
          // on a second attempt. Re-enqueue once (mirrors the 403 pattern) so
          // a single flaky response doesn't drop the URL as "invalid". We do
          // NOT call rateController.onFailure here — 5xx isn't a rate-limit
          // signal, and halving concurrency for a transient upstream error
          // would hurt throughput on the rest of the crawl.
          const isTransient5xx =
            status === 500 || status === 502 || status === 503 || status === 504;
          if (isTransient5xx && !request.userData?.serverErrorRetried) {
            try {
              await requestQueue.addRequest({
                url: request.url,
                label: request.url,
                uniqueKey: `5xx_${request.url}`,
                userData: { serverErrorRetried: true },
              });
            } catch {}
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

            if (isAbortingScan || page.isClosed()) return;

            const results = await runAxeScript({ includeScreenshots, page, randomToken, ruleset });

            if (results.axeScanFailed) {
              guiInfoLog(guiInfoStatusTypes.ERROR, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
              });
              urlsCrawled.error.push({
                url: request.url,
                pageTitle: results.pageTitle,
                actualUrl,
                metadata: STATUS_CODE_METADATA[2],
                httpStatusCode: 2,
              });
              return;
            }

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
              scannedUrlSet?.add(normUrl(request.url));
              rateController.onSuccess(crawler.autoscaledPool);
              lastSuccessTime = Date.now();
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
                      // Drop URLs already scanned in this or a previous phase —
                      // no point enqueuing them at all.
                      if (scannedUrlSet?.has(normUrl(req.url))) {
                        return null;
                      }
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

        if (
          rateController.onFailure(status, crawler.autoscaledPool, {
            skipConcurrencyReduction: request.userData?.rateLimitRetried === true,
          })
        ) {
          consoleLogger.info(
            `Aborting crawl: consecutive HTTP failures threshold reached (site may be rate-limiting). Successfully scanned ${urlsCrawled.scanned.length} pages.`,
          );
          isAbortingScan = true;
          crawler.autoscaledPool?.abort();
          return;
        }

        const timeSinceLastSuccess = Date.now() - lastSuccessTime;
        if (maxIdleMs > 0 && timeSinceLastSuccess > maxIdleMs) {
          consoleLogger.info(
            `Aborting crawl: no successful scan in ${Math.round(timeSinceLastSuccess / 1000)}s. Generating partial report with ${urlsCrawled.scanned.length} pages.`,
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
      maxConcurrency: rateController.target,
      autoscaledPoolOptions: {
        // Pinned to the rate controller's target (min = desired = max). Only
        // 403/429 and measured main-thread starvation lower it — not Crawlee's
        // overload heuristic, which on shared CI runners pins scans at 1.
        minConcurrency: rateController.target,
        desiredConcurrency: rateController.target,
        maxConcurrency: rateController.target,
        desiredConcurrencyRatio: 0.98, // Increase threshold for scaling up
        scaleUpStepRatio: 0.99, // Scale up faster
        scaleDownStepRatio: 0.1, // Scale down slower
      },
    }),
  );

  // Reset the idle timer right before crawler.run() so that sitemap-discovery
  // time (URL sitemaps can take minutes to walk a big sitemap index) doesn't
  // count against the idle window.
  lastSuccessTime = Date.now();
  const idleCheckInterval = setInterval(() => {
    const timeSinceLastSuccess = Date.now() - lastSuccessTime;
    if (maxIdleMs > 0 && timeSinceLastSuccess > maxIdleMs) {
      consoleLogger.info(
        `Aborting crawl: no successful scan in ${Math.round(timeSinceLastSuccess / 1000)}s. Generating partial report with ${urlsCrawled.scanned.length} pages.`,
      );
      isAbortingScan = true;
      crawler.autoscaledPool?.abort();
    }
  }, 30_000);

  // Publish the crawler to the shutdown controller so a SIGTERM/SIGINT that
  // arrives during crawler.run() can abort the autoscaledPool. Without this,
  // the container's SIGKILL lands mid-write and produces a corrupted results.zip.
  registerCrawler(crawler);
  const stopEnforcer = startConcurrencyEnforcer('sitemap', () => crawler.autoscaledPool, rateController);
  try {
    await crawler.run();
  } finally {
    stopEnforcer();
    // Always unregister and clear the idle watchdog, even if crawler.run()
    // threw — otherwise a later phase could inherit a stale reference or the
    // interval could keep firing after the crawler has exited.
    unregisterCrawler(crawler);
    clearInterval(idleCheckInterval);
  }
  // If we got here because of SIGTERM/SIGINT (not a natural finish), route
  // into the same partial-report finalization path that idle-abort and
  // duration-cap use. Downstream code branches on isAbortingScan.
  if (isShutdownRequested()) {
    isAbortingScan = true;
  }

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