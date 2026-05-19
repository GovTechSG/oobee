import fs from 'fs';
import { chromium, Page } from 'playwright';
import { EnqueueStrategy } from 'crawlee';
import { createCrawleeSubFolders } from './commonCrawlerFunc.js';
import constants, { FileTypes, guiInfoStatusTypes, sitemapPaths } from '../constants/constants.js';
import { consoleLogger, guiInfoLog } from '../logs.js';
import crawlDomain from './crawlDomain.js';
import crawlSitemap from './crawlSitemap.js';
import { ViewportSettingsClass } from '../combine.js';
import { getPlaywrightLaunchOptions, getSitemapsFromRobotsTxt } from '../constants/common.js';
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
      // In headful mode, avoid launchPersistentContext to prevent "Browser window not found"
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

  // Discover sitemaps from robots.txt first (supports multiple Sitemap: directives)
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
      includeScreenshots,
      followRobots,
      extraHTTPHeaders,
      safeMode,
      scanDuration,
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
    });
  }

  const elapsed = Date.now() - startTime;
  const remainingScanDuration = Math.max(scanDuration - elapsed / 1000, 0); // in seconds

  if (urlsCrawledFinal.scanned.length < maxRequestsPerCrawl && remainingScanDuration > 0) {
    console.log(
      `Continuing crawl from root website. Remaining scan time: ${remainingScanDuration.toFixed(1)}s`,
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
      urlsCrawledFromIntelligent: urlsCrawledFinal,
      scanDuration: remainingScanDuration,
    });
  } else if (remainingScanDuration <= 0) {
    console.log(
      `Crawl duration exceeded before more pages could be found (limit: ${scanDuration}s).`,
    );
    durationExceeded = true;
  }

  guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  return { urlsCrawled: urlsCrawledFinal, durationExceeded };
};

export default crawlIntelligentSitemap;
