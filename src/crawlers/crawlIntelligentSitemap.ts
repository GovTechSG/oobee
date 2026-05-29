import { chromium, Page } from 'playwright';
import { Dataset, EnqueueStrategy } from 'crawlee';
import * as path from 'path';
import constants, { FileTypes, guiInfoStatusTypes, sitemapPaths } from '../constants/constants.js';
import { consoleLogger, guiInfoLog } from '../logs.js';
import crawlDomain from './crawlDomain.js';
import crawlSitemap from './crawlSitemap.js';
import { getPlaywrightLaunchOptions, getSitemapsFromRobotsTxt } from '../constants/common.js';
import { register, getStoragePath } from '../utils.js';
import type { PageHandler, PlaywrightHook, ViewportSettingsClass } from '../types.js';

const createCrawleeSubFolders = async (randomToken: string) => {
  const crawleeDir = path.join(getStoragePath(randomToken), 'crawlee');
  const dataset = await Dataset.open(crawleeDir);
  return { dataset };
};

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
  followRobots: boolean,
  extraHTTPHeaders: Record<string, string>,
  safeMode: boolean,
  scanDuration: number,
  pageHandler: PageHandler,
  preNavigationHooks: PlaywrightHook[] = [],
  postNavigationHooks: PlaywrightHook[] = [],
  pageDelayMs?: number | ((url: string) => number),
) => {
  const startTime = Date.now();

  let urlsCrawledFinal;
  const urlsCrawled = { ...constants.urlsCrawledObj };
  let dataset;
  let sitemapExist = false;
  const fromCrawlIntelligentSitemap = true;
  let sitemapUrl;
  let durationExceeded = false;

  ({ dataset } = await createCrawleeSubFolders(randomToken));

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
    let context;
    let browserInstance;

    if (process.env.CRAWLEE_HEADLESS === '1') {
      const effectiveUserDataDirectory = userDataDirectory || '';
      context = await constants.launcher.launchPersistentContext(effectiveUserDataDirectory, {
        ...launchOptions,
        ...(extraHTTPHeaders && { extraHTTPHeaders }),
      });
      register(context);
    } else {
      browserInstance = await constants.launcher.launch(launchOptions);
      register(browserInstance as unknown as { close: () => Promise<void> });
      context = await browserInstance.newContext({
        ...(extraHTTPHeaders && { extraHTTPHeaders }),
      });
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

  const checkUrlExists = async (page: Page, parsedUrl: string) => {
    try {
      const response = await page.goto(parsedUrl);
      return response.ok();
    } catch (e) {
      consoleLogger.error(e);
      return false;
    }
  };

  // Discover sitemaps from robots.txt first
  let sitemapUrls: string[] = [];
  try {
    sitemapUrls = await getSitemapsFromRobotsTxt(url, browser, userDataDirectory, extraHTTPHeaders);
    if (sitemapUrls.length > 0) {
      console.log(`Found ${sitemapUrls.length} sitemap(s) in robots.txt: ${sitemapUrls.join(', ')}`);
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
    console.log('Unable to find sitemap. Commencing website crawl instead.');
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
      followRobots,
      extraHTTPHeaders,
      safeMode,
      scanDuration,
      pageHandler,
      preNavigationHooks,
      postNavigationHooks,
      pageDelayMs,
    });
  }

  // Process all discovered sitemaps sequentially, sharing dataset and urlsCrawled
  for (const currentSitemapUrl of sitemapUrls) {
    if (urlsCrawled.scanned.length >= maxRequestsPerCrawl) break;

    const elapsed = Date.now() - startTime;
    const remainingDuration = scanDuration > 0 ? Math.max(scanDuration - elapsed / 1000, 0) : scanDuration;
    if (scanDuration > 0 && remainingDuration <= 0) {
      durationExceeded = true;
      break;
    }

    console.log(`Processing sitemap: ${currentSitemapUrl}`);
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
      extraHTTPHeaders,
      pageHandler,
      strategy,
      userUrl: url,
      fromCrawlIntelligentSitemap,
      userUrlInputFromIntelligent: url,
      datasetFromIntelligent: dataset,
      urlsCrawledFromIntelligent: urlsCrawled,
      crawledFromLocalFile: false,
      scanDuration: scanDuration > 0 ? remainingDuration : 0,
      preNavigationHooks,
      postNavigationHooks,
      pageDelayMs,
    });
  }

  const elapsed = Date.now() - startTime;
  const remainingScanDuration = scanDuration > 0 ? Math.max(scanDuration - elapsed / 1000, 0) : 0;
  const hasDurationRemaining = scanDuration === 0 || remainingScanDuration > 0;

  if (urlsCrawled.scanned.length < maxRequestsPerCrawl && hasDurationRemaining) {
    console.log(
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
      followRobots,
      extraHTTPHeaders,
      safeMode,
      pageHandler,
      fromCrawlIntelligentSitemap,
      datasetFromIntelligent: dataset,
      urlsCrawledFromIntelligent: urlsCrawled,
      scanDuration: remainingScanDuration,
      preNavigationHooks,
      postNavigationHooks,
      pageDelayMs,
    });
  } else if (!hasDurationRemaining) {
    console.log(`Crawl duration exceeded before more pages could be found (limit: ${scanDuration}s).`);
    durationExceeded = true;
  }

  guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  return { urlsCrawled, durationExceeded };
};

export default crawlIntelligentSitemap;
