import printMessage from 'print-message';
import { pathToFileURL } from 'url';
import crawlSitemap from './crawlers/crawlSitemap.js';
import crawlDomain from './crawlers/crawlDomain.js';
import crawlLocalFile from './crawlers/crawlLocalFile.js';
import crawlIntelligentSitemap from './crawlers/crawlIntelligentSitemap.js';
import generateArtifacts from './mergeAxeResults.js';
import { getHost, createAndUpdateResultsFolders, createDetailsAndLogs, cleanUp, cleanUpAndExit } from './utils.js';
import { ScannerTypes, UrlsCrawled } from './constants/constants.js';
import { getBlackListedPatterns, submitForm } from './constants/common.js';
import { consoleLogger, silentLogger } from './logs.js';
import runCustom from './crawlers/runCustom.js';
import { alertMessageOptions } from './constants/cliFunctions.js';
import { Data } from './index.js';

// Class exports
export class ViewportSettingsClass {
  deviceChosen: string;
  customDevice: string;
  viewportWidth: number;
  playwrightDeviceDetailsObject: any; // You can replace 'any' with a more specific type if possible

  constructor(
    deviceChosen: string,
    customDevice: string,
    viewportWidth: number,
    playwrightDeviceDetailsObject: any,
  ) {
    this.deviceChosen = deviceChosen;
    this.customDevice = customDevice;
    this.viewportWidth = viewportWidth;
    this.playwrightDeviceDetailsObject = playwrightDeviceDetailsObject;
  }
}

const combineRun = async (details: Data, deviceToScan: string) => {
  const envDetails = { ...details };

  const {
    type,
    url,
    nameEmail,
    randomToken,
    deviceChosen,
    customDevice,
    viewportWidth,
    playwrightDeviceDetailsObject,
    maxRequestsPerCrawl,
    browser,
    userDataDirectory,
    strategy, // Allow subdomains: if checked, = 'same-domain'
    specifiedMaxConcurrency, // Slow scan mode: if checked, = '1'
    fileTypes,
    blacklistedPatternsFilename,
    includeScreenshots, // Include screenshots: if checked, = 'true'
    followRobots, // Adhere to robots.txt: if checked, = 'true'
    metadata,
    customFlowLabel = 'None',
    extraHTTPHeaders,
    safeMode,
    zip,
    ruleset, // Enable custom checks, Enable WCAG AAA: if checked, = 'enable-wcag-aaa')
    generateJsonFiles,
    scanDuration
  } = envDetails;

  process.env.CRAWLEE_LOG_LEVEL = 'ERROR';
  process.env.CRAWLEE_STORAGE_DIR = randomToken;

  if (process.env.CRAWLEE_SYSTEM_INFO_V2 === undefined) {
  // Set the environment variable to enable system info v2
  // Resolves issue with when wmic is not installed on Windows
    process.env.CRAWLEE_SYSTEM_INFO_V2 = '1';
  }
  
  const host = type === ScannerTypes.SITEMAP || type === ScannerTypes.LOCALFILE ? '' : getHost(url);

  let blacklistedPatterns: string[] | null = null;
  try {
    blacklistedPatterns = getBlackListedPatterns(blacklistedPatternsFilename);
  } catch (error) {
    consoleLogger.error(error);
    cleanUpAndExit(1);
  }

  // remove basic-auth credentials from URL
  const finalUrl = !(type === ScannerTypes.SITEMAP || type === ScannerTypes.LOCALFILE)
    ? new URL(url)
    : new URL(pathToFileURL(url));

  // Use the string version of finalUrl to reduce logic at submitForm
  const finalUrlString = finalUrl.toString();

  const scanDetails = {
    startTime: new Date(),
    endTime: new Date(),
    crawlType: type,
    requestUrl: finalUrl,
    urlsCrawled: new UrlsCrawled(),
    isIncludeScreenshots: envDetails.includeScreenshots,
    isAllowSubdomains: envDetails.strategy,
    isEnableCustomChecks: envDetails.ruleset,
    isEnableWcagAaa: envDetails.ruleset,
    isSlowScanMode: envDetails.specifiedMaxConcurrency,
    isAdhereRobots: envDetails.followRobots,
    deviceChosen: deviceToScan,
    nameEmail: undefined as { name: string; email: string } | undefined,
  };

  // Parse nameEmail and add it to scanDetails for use in generateArtifacts
  if (nameEmail) {
    const [name, email] = nameEmail.split(':');
    scanDetails.nameEmail = { name, email };
  }

  const viewportSettings: ViewportSettingsClass = new ViewportSettingsClass(
    deviceChosen,
    customDevice,
    viewportWidth,
    playwrightDeviceDetailsObject,
  );

  let urlsCrawledObj: UrlsCrawled;
  switch (type) {
    case ScannerTypes.CUSTOM:
      urlsCrawledObj = await runCustom(
        url,
        randomToken,
        viewportSettings,
        blacklistedPatterns,
        includeScreenshots,
      );
      break;

    case ScannerTypes.SITEMAP:
        urlsCrawledObj = await crawlSitemap({
        sitemapUrl: url,
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
        scanDuration,
      });
      break;

    case ScannerTypes.LOCALFILE:
      urlsCrawledObj = await crawlLocalFile({
        url,
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
        scanDuration,
      });
      break;

    case ScannerTypes.INTELLIGENT:
      urlsCrawledObj = await crawlIntelligentSitemap(
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
        scanDuration
      );
      break;

    case ScannerTypes.WEBSITE:
      urlsCrawledObj = await crawlDomain({
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
        scanDuration,
        safeMode,
        ruleset,
      });
      break;

    default:
      consoleLogger.error(`type: ${type} not defined`);
      cleanUpAndExit(1);
  }

  scanDetails.endTime = new Date();
  scanDetails.urlsCrawled = urlsCrawledObj;
  await createDetailsAndLogs(randomToken);
  if (scanDetails.urlsCrawled) {
    if (scanDetails.urlsCrawled.scanned.length > 0) {
      await createAndUpdateResultsFolders(randomToken);
      const pagesNotScanned = [
        ...urlsCrawledObj.error,
        ...urlsCrawledObj.invalid,
        ...urlsCrawledObj.forbidden,
        ...urlsCrawledObj.userExcluded,
      ];
      const basicFormHTMLSnippet = await generateArtifacts(
        randomToken,
        url,
        type,
        deviceToScan,
        urlsCrawledObj.scanned,
        pagesNotScanned,
        customFlowLabel,
        undefined,
        scanDetails,
        zip,
        generateJsonFiles,
      );
      const [name, email] = nameEmail.split(':');

      await submitForm(
        browser,
        userDataDirectory,
        url, // scannedUrl
        new URL(finalUrlString).href, // entryUrl
        type,
        email,
        name,
        JSON.stringify(basicFormHTMLSnippet),
        urlsCrawledObj.scanned.length,
        urlsCrawledObj.scannedRedirects.length,
        pagesNotScanned.length,
        metadata,
      );
    } else {

      // No page were scanned because the URL loaded does not meet the crawler requirements
      printMessage([`No pages were scanned.`], alertMessageOptions);
      cleanUpAndExit(1, randomToken, true);
    }
  } else {

    // No page were scanned because the URL loaded does not meet the crawler requirements
    printMessage([`No pages were scanned.`], alertMessageOptions);
    cleanUpAndExit(1, randomToken, true);
  }
};

export default combineRun;
