/* eslint-env browser */
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
import {
  getBrowserToRun,
  getPlaywrightLaunchOptions,
  initModifiedUserAgent,
} from '../constants/common.js';
import { BrowserTypes } from '../constants/constants.js';

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
  entryUrl!: string;
  strategy: string;

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
  browserToRun: string,
  userDataDirectory: string,
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

  processPageParams.entryUrl = url;

  if (initialCustomFlowLabel && initialCustomFlowLabel.trim()) {
    processPageParams.customFlowLabel = initialCustomFlowLabel.trim();
  }

  const pagesDict = {};
  const pageClosePromises = [];

  try {
    const { browserToRun: resolvedBrowserToRun } = getBrowserToRun(
      randomToken,
      browserToRun as BrowserTypes,
      false,
    );
    const deviceConfig = viewportSettings.playwrightDeviceDetailsObject;
    const hasCustomViewport = !!deviceConfig;
    const rawDevice = (deviceConfig || {}) as Record<string, unknown>;
    const { userAgent: deviceUserAgent, ...contextDeviceOptions } = rawDevice;

    await initModifiedUserAgent(resolvedBrowserToRun, viewportSettings.playwrightDeviceDetailsObject);

    const baseLaunchOptions = getPlaywrightLaunchOptions(resolvedBrowserToRun);

    // Merge base args with custom flow specific args
    const baseArgs = baseLaunchOptions.args || [];
    const customArgs = hasCustomViewport ? ['--window-size=1920,1040'] : ['--start-maximized'];
    const mergedArgs = [
      ...baseArgs.filter(a => !a.startsWith('--window-size') && a !== '--start-maximized'),
      ...customArgs,
    ];

    const context = await constants.launcher.launchPersistentContext(userDataDirectory, {
      ...baseLaunchOptions,
      args: mergedArgs,
      headless: false,
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
      viewport: null,
      ...(hasCustomViewport ? contextDeviceOptions : {}),
      userAgent: process.env.OOBEE_USER_AGENT || (deviceUserAgent as string | undefined),
    });

    register(context);

    processPageParams.stopAll = async () => {
      try {
        await context.close().catch(() => {});
      } catch {}
    };

    // For handling closing playwright browser and continue generate artifacts etc
    registerSoftClose(processPageParams.stopAll);

    addUrlGuardScript(context, { fallbackUrl: url });

    const page = context.pages().find(existingPage => !existingPage.isClosed()) || (await context.newPage());
    await initNewPage(page, pageClosePromises, processPageParams, pagesDict);

    // Detection of new page
    context.on('page', async newPage => {
      try {
        await initNewPage(newPage, pageClosePromises, processPageParams, pagesDict);
      } catch (e) {
        log(`Error initializing new page: ${e}`);
      }
    });

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
