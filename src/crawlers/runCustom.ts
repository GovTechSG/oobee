/* eslint-env browser */
import { chromium } from 'playwright';
import { createCrawleeSubFolders } from './commonCrawlerFunc.js';
import { cleanUpAndExit, register} from '../utils.js';
import constants, {
  getIntermediateScreenshotsPath,
  guiInfoStatusTypes,
  UrlsCrawled,
} from '../constants/constants.js';
import { DEBUG, initNewPage, log } from './custom/utils.js';
import { guiInfoLog } from '../logs.js';
import { ViewportSettingsClass } from '../combine.js';
import { addUrlGuardScript } from './guards/urlGuard.js';

// Export of classes

export class ProcessPageParams {
  scannedIdx: number;
  blacklistedPatterns: string[] | null;
  includeScreenshots: boolean;
  dataset: any;
  intermediateScreenshotsPath: string;
  urlsCrawled: UrlsCrawled;
  randomToken: string;
  constructor(
    scannedIdx: number,
    blacklistedPatterns: string[] | null,
    includeScreenshots: boolean,
    dataset: any,
    intermediateScreenshotsPath: string,
    urlsCrawled: UrlsCrawled,
    randomToken: string,
  ) {
    this.scannedIdx = scannedIdx;
    this.blacklistedPatterns = blacklistedPatterns;
    this.includeScreenshots = includeScreenshots;
    this.dataset = dataset;
    this.intermediateScreenshotsPath = intermediateScreenshotsPath;
    this.urlsCrawled = urlsCrawled;
    this.randomToken = randomToken;
  }
}

const runCustom = async (
  url: string,
  randomToken: string,
  viewportSettings: ViewportSettingsClass,
  blacklistedPatterns: string[] | null,
  includeScreenshots: boolean,
) => {
  // checks and delete datasets path if it already exists
  process.env.CRAWLEE_STORAGE_DIR = randomToken;

  const urlsCrawled: UrlsCrawled = { ...constants.urlsCrawledObj };
  const { dataset } = await createCrawleeSubFolders(randomToken);
  const intermediateScreenshotsPath = getIntermediateScreenshotsPath(randomToken);
  const processPageParams = new ProcessPageParams(
    0, // scannedIdx
    blacklistedPatterns,
    includeScreenshots,
    dataset,
    intermediateScreenshotsPath,
    urlsCrawled,
    randomToken,
  );

  const pagesDict = {};
  const pageClosePromises = [];

  try {
    const browser = await chromium.launch({
      args: ['--window-size=1920,1040'],
      headless: false,
      channel: 'chrome',
      // bypassCSP: true,
      devtools: DEBUG,
    });

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
      viewport: null,
      ...viewportSettings.playwrightDeviceDetailsObject,
    });

    register(context);

    addUrlGuardScript(context, { fallbackUrl: url });

    // Detection of new page
    context.on('page', async newPage => {
      await initNewPage(newPage, pageClosePromises, processPageParams, pagesDict);
    });

    const page = await context.newPage();
    await page.goto(url, { timeout: 0 });

    // to execute and wait for all pages to close
    // idea is for promise to be pending until page.on('close') detected
    const allPagesClosedPromise = async promises =>
      Promise.all(promises)
        // necessary to recheck as during time of execution, more pages added
        .then(() => {
          if (Object.keys(pagesDict).length > 0) {
            return allPagesClosedPromise(promises);
          }

          return Promise.resolve(true);
        });

    await allPagesClosedPromise(pageClosePromises);
  } catch (error) {
    log(`PLAYWRIGHT EXECUTION ERROR ${error}`);
    cleanUpAndExit(1, randomToken, true);
  }

  guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  return urlsCrawled;
};

export default runCustom;
