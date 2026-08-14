/* eslint-env browser */
import { Configuration } from 'crawlee';
import { createCrawleeSubFolders, splitAuthHeaders, addAuthRouteHandler } from './commonCrawlerFunc.js';
import { cleanUpAndExit, getStoragePath, register, registerSoftClose } from '../utils.js';
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
  launchPersistentSafeContext,
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
  maxPagesToScan?: number;

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

export interface RunCustomControls {
  stop: () => Promise<void>;
  focus: () => Promise<void>;
}

export interface RunCustomHooks {
  onReady?: (controls: RunCustomControls) => void | Promise<void>;
  exitOnError?: boolean;
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
  extraHTTPHeaders?: Record<string, string>,
  hooks?: RunCustomHooks,
  maxPagesToScan?: number,
) => {
  // Crawlee keeps the storage client/manager on a process-global Configuration.
  // Programmatic callers such as the VS Code extension run multiple scans in the
  // same Node process, so force each scan to open its own result directory.
  const storagePath = getStoragePath(randomToken);
  const crawleeConfig = Configuration.getGlobalConfig();
  process.env.CRAWLEE_STORAGE_DIR = storagePath;
  crawleeConfig.set('storageClientOptions', { localDataDirectory: storagePath });
  crawleeConfig.storageManagers.clear();

  const urlsCrawled = new UrlsCrawled();
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
  processPageParams.maxPagesToScan = maxPagesToScan;

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

    const { authHeader, nonAuthHeaders, httpCredentials } = splitAuthHeaders(extraHTTPHeaders);

    const context = await launchPersistentSafeContext(userDataDirectory, {
      ...baseLaunchOptions,
      args: mergedArgs,
      headless: false,
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block' as const,
      viewport: null,
      ...(hasCustomViewport ? contextDeviceOptions : {}),
      userAgent: process.env.OOBEE_USER_AGENT || (deviceUserAgent as string | undefined),
      ...(nonAuthHeaders && { extraHTTPHeaders: nonAuthHeaders }),
      ...(httpCredentials && { httpCredentials }),
    });

    if (authHeader) {
      await addAuthRouteHandler(context, url, authHeader);
    }

    register(context);

    processPageParams.stopAll = async () => {
      try {
        await context.close().catch(() => {});
      } catch {}
    };

    // For handling closing playwright browser and continue generate artifacts etc
    registerSoftClose(processPageParams.stopAll);

    addUrlGuardScript(context, { fallbackUrl: url, allowChromeErrors: !!process.env.GOOGLE_SAFE_BROWSING });

    // Persistent Chrome always opens an initial about:blank page. If context.pages()
    // is briefly empty right after launch, wait for that initial page rather than
    // calling context.newPage() — with viewport: null + --start-maximized, newPage()
    // spawns a second window and the original about:blank is left orphaned.
    let page = context.pages().find(existingPage => !existingPage.isClosed());
    if (!page) {
      page = await context
        .waitForEvent('page', { timeout: 5000 })
        .catch(() => undefined);
    }
    if (!page) {
      page = await context.newPage();
    }

    // Close any extra pages (stray about:blank windows) that came up during launch.
    for (const other of context.pages()) {
      if (other !== page && !other.isClosed()) {
        await other.close().catch(() => {});
      }
    }

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
    if (hooks?.onReady) {
      const focusBrowser = async () => {
        const pages = context.pages().filter(existingPage => !existingPage.isClosed());
        const targetPage = pages[pages.length - 1] || page;
        if (!targetPage || targetPage.isClosed()) return;

        await targetPage.bringToFront();
        await targetPage.evaluate(() => window.focus()).catch(() => {});
      };
      await hooks.onReady({
        stop: processPageParams.stopAll!,
        focus: focusBrowser,
      });
    }

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

    // Race the page-close wait against context 'close'. When the caller sends
    // SIGUSR1 (or otherwise triggers softCloseBrowserAndContext), context.close()
    // tears the browser down; individual pages may not fire their own 'close'
    // event before the context is gone. Without this race, pageClosePromises
    // stays pending, this await never resolves, and Node exits the process with
    // code 13 ("Unfinished Top-Level Await") from cli.ts's top-level await.
    const contextClosedPromise = new Promise<true>(resolve => {
      context.once('close', () => resolve(true));
    });

    await Promise.race([allPagesClosedPromise(pageClosePromises), contextClosedPromise]);
  } catch (error) {
    log(`PLAYWRIGHT EXECUTION ERROR ${error}`);
    // Default to propagating the error when hooks are provided (library
    // consumers), so we don't kill the caller's process. CLI callers do not
    // pass hooks and continue to receive the historical cleanUpAndExit path.
    const propagate = hooks?.exitOnError === false || (!!hooks && hooks.exitOnError !== true);
    if (propagate) {
      throw error;
    }
    await cleanUpAndExit(1, randomToken, true);
  }

  guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  return {
    urlsCrawled,
    customFlowLabel: processPageParams.customFlowLabel,
  };
};

export default runCustom;
