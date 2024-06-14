import printMessage from 'print-message';
import crawlSitemap from './crawlers/crawlSitemap.js';
import crawlDomain from './crawlers/crawlDomain.js';
import crawlIntelligentSitemap from './crawlers/crawlIntelligentSitemap.js';
import { generateArtifacts } from './mergeAxeResults.js';
import { getHost, createAndUpdateResultsFolders, createDetailsAndLogs } from './utils.js';
import { ScannerTypes,UrlsCrawled} from './constants/constants.js';
import { getBlackListedPatterns, submitForm, urlWithoutAuth } from './constants/common.js';
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

  constructor(deviceChosen: string, customDevice: string, viewportWidth: number, playwrightDeviceDetailsObject: any) {
    this.deviceChosen = deviceChosen;
    this.customDevice = customDevice;
    this.viewportWidth = viewportWidth;
    this.playwrightDeviceDetailsObject = playwrightDeviceDetailsObject;
  }
}


const combineRun = async (details:Data, deviceToScan:string) => {
  const envDetails = { ...details };

  const {
    type,
    url,
    entryUrl,
    nameEmail,
    randomToken,
    deviceChosen,
    customDevice,
    viewportWidth,
    playwrightDeviceDetailsObject,
    maxRequestsPerCrawl,
    isLocalSitemap,
    browser,
    userDataDirectory,
    strategy,
    specifiedMaxConcurrency,
    fileTypes,
    blacklistedPatternsFilename,
    includeScreenshots,
    followRobots,
    metadata,
    customFlowLabel = 'Custom Flow',
    extraHTTPHeaders,
    safeMode,
  } = envDetails;

  process.env.CRAWLEE_LOG_LEVEL = 'ERROR';
  process.env.CRAWLEE_STORAGE_DIR = randomToken;

  const host = type === ScannerTypes.SITEMAP && isLocalSitemap ? '' : getHost(url);

  let blacklistedPatterns:string[] | null = null;
  try {
    blacklistedPatterns = getBlackListedPatterns(blacklistedPatternsFilename);
  } catch (error) {
    consoleLogger.error(error);
    silentLogger.error(error);
    process.exit(1);
  }

  // remove basic-auth credentials from URL
  let finalUrl = urlWithoutAuth(url);

  const scanDetails = {
    startTime: new Date(),
    endTime: new Date(),
    crawlType: type,
    requestUrl: finalUrl,
    urlsCrawled: new UrlsCrawled(),

  };

  const viewportSettings:ViewportSettingsClass = new ViewportSettingsClass(
    deviceChosen,
    customDevice,
    viewportWidth,
    playwrightDeviceDetailsObject,
  );

  let urlsCrawledObj;
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
      urlsCrawledObj = await crawlSitemap(
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
      );
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
      );
      break;

    case ScannerTypes.WEBSITE:
      urlsCrawledObj = await crawlDomain(
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
      );
      break;

    default:
      consoleLogger.error(`type: ${type} not defined`);
      silentLogger.error(`type: ${type} not defined`);
      process.exit(1);
  }

  scanDetails.endTime = new Date();
  scanDetails.urlsCrawled = urlsCrawledObj;
  await createDetailsAndLogs(randomToken);
  if (scanDetails.urlsCrawled.scanned.length > 0) {
    await createAndUpdateResultsFolders(randomToken);
    const pagesNotScanned = [
      ...urlsCrawledObj.error,
      ...urlsCrawledObj.invalid,
      ...urlsCrawledObj.forbidden,
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
    );
    const [name, email] = nameEmail.split(':');

    await submitForm(
      browser,
      userDataDirectory,
      url, // scannedUrl
      finalUrl.href, //entryUrl
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
    printMessage([`No pages were scanned.`], alertMessageOptions);
  }
};

export default combineRun;
