/* eslint-env browser */
import { chromium } from 'playwright';
import { createCrawleeSubFolders } from './commonCrawlerFunc.js';
import { cleanUpAndExit, register, registerSoftClose } from '../utils.js';
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
  customFlowLabel?: string;
  stopAll?: () => Promise<void>;

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
  initialCustomFlowLabel?: string,
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

  if (initialCustomFlowLabel && initialCustomFlowLabel.trim()) {
    processPageParams.customFlowLabel = initialCustomFlowLabel.trim();
  }

  const pagesDict = {};
  const pageClosePromises = [];

  try {
    const deviceConfig = viewportSettings.playwrightDeviceDetailsObject;
    const hasCustomViewport = !!deviceConfig;

    const browser = await chromium.launch({
      args: hasCustomViewport ? ['--window-size=1920,1040'] : ['--start-maximized'],
      headless: false,
      channel: 'chrome',
      // bypassCSP: true,
    });

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
      viewport: null,
      ...(hasCustomViewport ? deviceConfig : {}),
    });

    register(context);

    processPageParams.stopAll = async () => {
      try {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      } catch {
      }
    };

    // For handling closing playwright browser and continue generate artifacts etc
    registerSoftClose(processPageParams.stopAll);

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
  return {
    urlsCrawled,
    customFlowLabel: processPageParams.customFlowLabel,
  };
};

export default runCustom;
