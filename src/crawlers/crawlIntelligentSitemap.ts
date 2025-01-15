import fs from 'fs';
import { chromium } from 'playwright';
import { createCrawleeSubFolders } from './commonCrawlerFunc.js';
import constants, { guiInfoStatusTypes, sitemapPaths } from '../constants/constants.js';
import { silentLogger, guiInfoLog } from '../logs.js';
import crawlDomain from './crawlDomain.js';
import crawlSitemap from './crawlSitemap.js';

const crawlIntelligentSitemap = async (
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
) => {
  let urlsCrawledFinal;
  let urlsCrawled;
  let dataset;
  let sitemapExist = false;
  const fromCrawlIntelligentSitemap = true;
  let sitemapUrl;

  urlsCrawled = { ...constants.urlsCrawledObj };
  ({ dataset } = await createCrawleeSubFolders(randomToken));

  if (!fs.existsSync(randomToken)) {
    fs.mkdirSync(randomToken);
  }

  function getHomeUrl(parsedUrl) {
    const urlObject = new URL(parsedUrl);
    if (urlObject.username !== '' && urlObject.password !== '') {
      return `${urlObject.protocol}//${urlObject.username}:${urlObject.password}@${urlObject.hostname}${urlObject.port ? `:${urlObject.port}` : ''}`;
    }

    return `${urlObject.protocol}//${urlObject.hostname}${urlObject.port ? `:${urlObject.port}` : ''}`;
  }

  async function findSitemap(link) {
    const homeUrl = getHomeUrl(link);
    let sitemapLinkFound = false;
    let sitemapLink = '';
    const chromiumBrowser = await chromium.launch(
      {
        headless: false,
        channel: 'chrome',
        args: ['--headless=new', '--no-sandbox']
      });

    const page = await chromiumBrowser.newPage();
    for (const path of sitemapPaths) {
      sitemapLink = homeUrl + path;
      sitemapLinkFound = await checkUrlExists(page, sitemapLink);
      if (sitemapLinkFound) {
        sitemapExist = true;
        break;
      }
    }
    await chromiumBrowser.close();
    return sitemapExist ? sitemapLink : '';
  }

  const checkUrlExists = async (page, parsedUrl) => {
    try {
      const response = await page.goto(parsedUrl);
      if (response.ok()) {
        return true;
      }
      return false;
    } catch (e) {
      silentLogger.error(e);
      return false;
    }
  };

  try {
    sitemapUrl = await findSitemap(url);
  } catch (error) {
    silentLogger.error(error);
  }

  if (!sitemapExist) {
    console.log('Unable to find sitemap. Commencing website crawl instead.');
    // run crawlDomain as per normal
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
    });
    return urlsCrawledFinal;
  }
  console.log(`Sitemap found at ${sitemapUrl}`);
  // run crawlSitemap then crawDomain subsequently if urlsCrawled.scanned.length < maxRequestsPerCrawl
  urlsCrawledFinal = await crawlSitemap(
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
    url,
    dataset, // for crawlSitemap to add on to
    urlsCrawled, // for crawlSitemap to add on to
    false,
  );

  if (urlsCrawled.scanned.length < maxRequestsPerCrawl) {
    // run crawl domain starting from root website, only on pages not scanned before
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
      datasetFromIntelligent: dataset, // for crawlDomain to add on to
      urlsCrawledFromIntelligent: urlsCrawledFinal, // urls for crawlDomain to exclude
    });
  }

  guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  return urlsCrawledFinal;
};
export default crawlIntelligentSitemap;
