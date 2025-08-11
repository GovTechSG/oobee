import fs from 'fs';
import { chromium, Page } from 'playwright';
import { createCrawleeSubFolders } from './commonCrawlerFunc.js';
import constants, { guiInfoStatusTypes, sitemapPaths } from '../constants/constants.js';
import { consoleLogger, guiInfoLog } from '../logs.js';
import crawlDomain from './crawlDomain.js';
import crawlSitemap from './crawlSitemap.js';
import { EnqueueStrategy } from 'crawlee';
import { ViewportSettingsClass } from '../combine.js';
import { getPlaywrightLaunchOptions } from '../constants/common.js';
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
  fileTypes: string,
  blacklistedPatterns: string[],
  includeScreenshots: boolean,
  followRobots: boolean,
  extraHTTPHeaders: Record<string, string>,
  safeMode: boolean,
  scanDuration: number
) => {
  const startTime = Date.now(); // Track start time

  let urlsCrawledFinal;
  let urlsCrawled = { ...constants.urlsCrawledObj };
  let dataset;
  let sitemapExist = false;
  const fromCrawlIntelligentSitemap = true;
  let sitemapUrl;

  ({ dataset } = await createCrawleeSubFolders(randomToken));

  function getHomeUrl(parsedUrl: string) {
    const urlObject = new URL(parsedUrl);
    if (urlObject.username && urlObject.password) {
      return `${urlObject.protocol}//${urlObject.username}:${urlObject.password}@${urlObject.hostname}${urlObject.port ? `:${urlObject.port}` : ''}`;
    }
    return `${urlObject.protocol}//${urlObject.hostname}${urlObject.port ? `:${urlObject.port}` : ''}`;
  }

  async function findSitemap(link: string, userDataDirectory: string, extraHTTPHeaders: Record<string, string>) {
    const homeUrl = getHomeUrl(link);
    let sitemapLink = '';

    const effectiveUserDataDirectory = process.env.CRAWLEE_HEADLESS === '1'
        ? userDataDirectory
        : '';
    const context = await constants.launcher.launchPersistentContext(effectiveUserDataDirectory, {
        headless: process.env.CRAWLEE_HEADLESS === '1',
        ...getPlaywrightLaunchOptions(browser),
        ...(extraHTTPHeaders && { extraHTTPHeaders }),
    });
    register(context);

    const page = await context.newPage();

    for (const path of sitemapPaths) {
      sitemapLink = homeUrl + path;
      if (await checkUrlExists(page, sitemapLink)) {
        sitemapExist = true;
        break;
      }
    }
    await page.close();
    await context.close().catch(() => { });
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

  try {
    sitemapUrl = await findSitemap(url, userDataDirectory, extraHTTPHeaders);
  } catch (error) {
    consoleLogger.error(error);
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
      scanDuration, // Use full duration since no sitemap
    });
  }

  console.log(`Sitemap found at ${sitemapUrl}`);
  urlsCrawledFinal = await crawlSitemap({
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
    fromCrawlIntelligentSitemap,
    userUrlInputFromIntelligent: url,
    datasetFromIntelligent: dataset,
    urlsCrawledFromIntelligent: urlsCrawled,
    crawledFromLocalFile: false,
    scanDuration,
  });

  const elapsed = Date.now() - startTime;
  const remainingScanDuration = Math.max(scanDuration - elapsed / 1000, 0); // in seconds

  if (
    urlsCrawledFinal.scanned.length < maxRequestsPerCrawl &&
    remainingScanDuration > 0
  ) {
    console.log(`Continuing crawl from root website. Remaining scan time: ${remainingScanDuration.toFixed(1)}s`);
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
    console.log(`Crawl duration exceeded before more pages could be found (limit: ${scanDuration}s).`);
  }

  guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  return urlsCrawledFinal;
};

export default crawlIntelligentSitemap;
