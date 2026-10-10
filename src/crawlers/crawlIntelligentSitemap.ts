import fs from 'fs';
import { chromium, Page } from 'playwright';
import { EnqueueStrategy } from 'crawlee';
import { createCrawleeSubFolders, splitAuthHeaders, addAuthRouteHandler, addScopedHeaderRoute } from './commonCrawlerFunc.js';
import constants, { FileTypes, guiInfoStatusTypes, RuleFlags, sitemapPaths } from '../constants/constants.js';
import { consoleLogger, guiInfoLog } from '../logs.js';
import crawlDomain from './crawlDomain.js';
import crawlSitemap from './crawlSitemap.js';
import { ViewportSettingsClass } from '../combine.js';
import {
  getPlaywrightLaunchOptions,
  getSitemapsFromRobotsTxt,
  initModifiedUserAgent,
  launchPersistentSafeContext,
  isRefusedRedirectTarget,
  isRefusedNavigation,
} from '../constants/common.js';
import { register } from '../utils.js';

const crawlIntelligentSitemap = async (
  url: string,
  randomToken: string,
  host: string,
  viewportSettings: ViewportSettingsClass,
  maxRequestsPerCrawl: number,
  browser: string,
  userDataDirectory: string,
  strategy: EnqueueStrategy,
  specifiedMaxConcurrency: number,
  fileTypes: FileTypes,
  blacklistedPatterns: string[],
  includeScreenshots: boolean,
  followRobots: boolean,
  extraHTTPHeaders: Record<string, string>,
  safeMode: boolean,
  scanDuration: number,
  ruleset: RuleFlags[] = [],
) => {
  const startTime = Date.now(); // Track start time

  let urlsCrawledFinal;
  const urlsCrawled = { ...constants.urlsCrawledObj };
  let dataset;
  let sitemapExist = false;
  const fromCrawlIntelligentSitemap = true;
  let sitemapUrl;
  let durationExceeded = false;

  ({ dataset } = await createCrawleeSubFolders(randomToken));

  // Initialise modified User-Agent early so sitemap discovery requests
  // don't expose "HeadlessChrome" (which triggers bot-blocking on some sites).
  await initModifiedUserAgent(browser);

  function getHomeUrl(parsedUrl: string) {
    const urlObject = new URL(parsedUrl);
    return `${urlObject.protocol}//${urlObject.hostname}${urlObject.port ? `:${urlObject.port}` : ''}`;
  }

  async function findSitemap(
    link: string,
    userDataDirectory: string,
    extraHTTPHeaders: Record<string, string>,
  ) {
    const homeUrl = getHomeUrl(link);
    let sitemapLink = '';

    const launchOptions = getPlaywrightLaunchOptions(browser);
    const { authHeader, nonAuthHeaders, httpCredentials } = splitAuthHeaders(extraHTTPHeaders, link);
    let context;
    let browserInstance;

    // asgard-0005 (2026-10-09 re-scan): nonAuthHeaders (Cookie, X-Api-Key,
    // bearer tokens, ...) used to be set as context-wide extraHTTPHeaders, so
    // they were resent to every redirect hop checkUrlExists follows — not just
    // internal/metadata hops (which asgard-0003 already blocks), but any public
    // cross-origin hop too. Drop them from the context and attach them per
    // request only within the entry URL's scope via addScopedHeaderRoute,
    // matching the pattern crawlDomain/crawlSitemap already use.
    if (process.env.CRAWLEE_HEADLESS === '1') {
      const effectiveUserDataDirectory = userDataDirectory || '';
      context = await launchPersistentSafeContext(effectiveUserDataDirectory, {
        ...launchOptions,
        ...(httpCredentials && { httpCredentials }),
        ...(process.env.OOBEE_USER_AGENT && { userAgent: process.env.OOBEE_USER_AGENT }),
      });
      register(context);
    } else {
      browserInstance = await constants.launcher.launch(launchOptions);
      register(browserInstance as unknown as { close: () => Promise<void> });
      context = await browserInstance.newContext({
        ...(httpCredentials && { httpCredentials }),
        ...(process.env.OOBEE_USER_AGENT && { userAgent: process.env.OOBEE_USER_AGENT }),
      });
    }

    if (authHeader) {
      await addAuthRouteHandler(context, link, authHeader);
    }
    if (nonAuthHeaders) {
      await addScopedHeaderRoute(context, link, nonAuthHeaders);
    }

    const page = await context.newPage();

    for (const path of sitemapPaths) {
      sitemapLink = homeUrl + path;
      if (await checkUrlExists(page, sitemapLink)) {
        sitemapExist = true;
        break;
      }
    }
    await page.close();
    await context.close().catch(() => {});
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
    }
    return sitemapExist ? sitemapLink : '';
  }

  // asgard-0003 (2026-10-09 scan): the probed sitemap paths are on the scanned
  // (untrusted) site, which can redirect them anywhere. Apply the same policy
  // as checkUrlConnectivityWithBrowser, pinned to the operator's entry URL:
  // refuse a probe that targets or is redirected (at any hop) to an
  // internal/metadata address the operator did not choose. Each check
  // resolves DNS again, so a host rebound to an internal IP is refused too.
  // response.serverAddr() is not used: behind a configured proxy it reports
  // the proxy's address, not the site's. A refused probe is treated as
  // "no sitemap here", so the scan falls back to a domain crawl.
  const checkUrlExists = async (page: Page, parsedUrl: string) => {
    try {
      if (await isRefusedRedirectTarget(url, parsedUrl)) {
        consoleLogger.warn(`Refusing sitemap probe to internal/metadata address: ${parsedUrl}`);
        return false;
      }
      const response = await page.goto(parsedUrl);
      if (!response) return false;
      // Shared proxy-safe check: every redirect hop plus the connected
      // address when the connection was direct.
      const refusedAt = await isRefusedNavigation(url, response, page.url());
      if (refusedAt) {
        consoleLogger.warn(`Refusing sitemap probe ${parsedUrl}: reached internal address ${refusedAt}`);
        return false;
      }
      return response.ok();
    } catch (e) {
      consoleLogger.error(e);
      return false;
    }
  };

  // Discover sitemaps from robots.txt first (supports multiple Sitemap: directives)
  let sitemapUrls: string[] = [];
  try {
    sitemapUrls = await getSitemapsFromRobotsTxt(url, browser, userDataDirectory, extraHTTPHeaders);
    if (sitemapUrls.length > 0) {
      consoleLogger.info(`Found ${sitemapUrls.length} sitemap(s) in robots.txt: ${sitemapUrls.join(', ')}`);
      sitemapExist = true;
    }
  } catch (error) {
    consoleLogger.error(error);
  }

  // Fall back to hardcoded path probing if robots.txt had no sitemaps
  if (!sitemapExist) {
    try {
      sitemapUrl = await findSitemap(url, userDataDirectory, extraHTTPHeaders);
      if (sitemapExist) {
        sitemapUrls = [sitemapUrl];
      }
    } catch (error) {
      consoleLogger.error(error);
    }
  }

  if (!sitemapExist) {
    consoleLogger.info('Unable to find sitemap. Commencing website crawl instead.');
    return await crawlDomain({
      url,
      randomToken,
      host,
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
      safeMode,
      scanDuration,
    });
  }

  // Process all discovered sitemaps sequentially, sharing dataset, urlsCrawled,
  // and a single request queue. The shared queue gives us Crawlee's built-in
  // uniqueKey dedup across phases for free — a URL enqueued in phase 1 won't be
  // re-enqueued in phase 2.
  for (let i = 0; i < sitemapUrls.length; i += 1) {
    const currentSitemapUrl = sitemapUrls[i];
    if (urlsCrawled.scanned.length >= maxRequestsPerCrawl) break;

    const elapsed = Date.now() - startTime;
    const remainingDuration = scanDuration > 0 ? Math.max(scanDuration - elapsed / 1000, 0) : scanDuration;
    if (scanDuration > 0 && remainingDuration <= 0) {
      durationExceeded = true;
      break;
    }

    consoleLogger.info(`Processing sitemap: ${currentSitemapUrl}`);
    urlsCrawledFinal = await crawlSitemap({
      sitemapUrl: currentSitemapUrl,
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
      strategy,
      userUrl: url,
      fromCrawlIntelligentSitemap,
      userUrlInputFromIntelligent: url,
      datasetFromIntelligent: dataset,
      urlsCrawledFromIntelligent: urlsCrawled,
      crawledFromLocalFile: false,
      scanDuration: scanDuration > 0 ? remainingDuration : 0,
      ruleset,
    });
  }

  const elapsed = Date.now() - startTime;
  const remainingScanDuration = scanDuration > 0 ? Math.max(scanDuration - elapsed / 1000, 0) : 0;
  const hasDurationRemaining = scanDuration === 0 || remainingScanDuration > 0;

  if (urlsCrawled.scanned.length < maxRequestsPerCrawl && hasDurationRemaining) {
    consoleLogger.info(
      `Continuing crawl from root website.${scanDuration > 0 ? ` Remaining scan time: ${remainingScanDuration.toFixed(1)}s` : ''}`,
    );
    urlsCrawledFinal = await crawlDomain({
      url,
      randomToken,
      host,
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
      safeMode,
      fromCrawlIntelligentSitemap,
      datasetFromIntelligent: dataset,
      urlsCrawledFromIntelligent: urlsCrawled,
      scanDuration: remainingScanDuration,
      ruleset,
    });
  } else if (!hasDurationRemaining) {
    consoleLogger.info(
      `Crawl duration exceeded before more pages could be found (limit: ${scanDuration}s).`,
    );
    durationExceeded = true;
  }

  guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  return { urlsCrawled, durationExceeded };
};

export default crawlIntelligentSitemap;
