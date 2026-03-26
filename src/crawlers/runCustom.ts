/* eslint-env browser */
import { Browser, BrowserContext, chromium, Page } from 'playwright';
import { newInjectedContext } from 'fingerprint-injector';
import { createCrawleeSubFolders } from './commonCrawlerFunc.js';
import { cleanUpAndExit, register, registerSoftClose } from '../utils.js';
import constants, {
  getIntermediateScreenshotsPath,
  guiInfoStatusTypes,
  UrlsCrawled,
} from '../constants/constants.js';
import { DEBUG, initNewPage, log } from './custom/utils.js';
import { guiInfoLog, consoleLogger } from '../logs.js';
import { ViewportSettingsClass } from '../combine.js';
import { addUrlGuardScript } from './guards/urlGuard.js';
import { getPlaywrightLaunchOptions } from '../constants/common.js';

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

const createContextWithOptionalFingerprintInjection = async (
  browser: Browser,
  contextOptions: Parameters<Browser['newContext']>[0],
): Promise<BrowserContext> => {
  console.log(
    'inside createContextWithOptionalFingerprintInjection 111',
    process.env.OOBEE_EXPERIMENTAL_FINGERPRINT_INJECTION,
  );
  console.log(
    'inside createContextWithOptionalFingerprintInjection 222',
    process.env.OOBEE_EXPERIMENTAL_FINGERPRINT_INJECTION !== '1',
  );
  if (process.env.OOBEE_EXPERIMENTAL_FINGERPRINT_INJECTION !== '1') {
    return browser.newContext(contextOptions);
  }

  try {
    consoleLogger.info('Enabling experimental fingerprint injection for custom flow');

    return newInjectedContext(browser, {
      newContextOptions: {
        ...contextOptions,
        locale: 'en-GB',
        timezoneId: 'Asia/Singapore',
        viewport: {
          width: 1280,
          height: 720,
        },
        // userAgent:
        //   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      fingerprintOptions: {
        devices: ['desktop'],
        operatingSystems: ['windows'],
        browsers: [{ name: 'chrome' }],
        locales: ['en-GB'],
      },
    });
  } catch (error) {
    consoleLogger.info(
      `Fingerprint injection unavailable, falling back to default context: ${error}`,
    );
    return browser.newContext(contextOptions);
  }
};

const logPlaywrightFingerprint = async (page: Page, label: string) => {
  const fingerprint = await page.evaluate(async () => {
    type NavigatorWithDeviceMemory = Navigator & {
      deviceMemory?: number;
    };

    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl') as WebGLRenderingContext | null) ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

    let webglVendor = null;
    let webglRenderer = null;
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        webglRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      }
    }

    return {
      location: window.location.href,
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      platform: navigator.platform,
      language: navigator.language,
      languages: navigator.languages,
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as NavigatorWithDeviceMemory).deviceMemory ?? null,
      maxTouchPoints: navigator.maxTouchPoints,
      vendor: navigator.vendor,
      pluginsLength: navigator.plugins.length,
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        colorDepth: window.screen.colorDepth,
      },
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      resolvedLocale: Intl.DateTimeFormat().resolvedOptions().locale,
      webglVendor,
      webglRenderer,
    };
  });

  consoleLogger.info(`OOBEE PLAYWRIGHT FINGERPRINT ${label} ${JSON.stringify(fingerprint)}`);
};

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

  processPageParams.entryUrl = url;

  if (initialCustomFlowLabel && initialCustomFlowLabel.trim()) {
    processPageParams.customFlowLabel = initialCustomFlowLabel.trim();
  }

  const pagesDict = {};
  const pageClosePromises = [];

  try {
    const deviceConfig = viewportSettings.playwrightDeviceDetailsObject;
    const hasCustomViewport = !!deviceConfig;

    const baseLaunchOptions = getPlaywrightLaunchOptions();

    // Merge base args with custom flow specific args
    const baseArgs = baseLaunchOptions.args || [];
    const customArgs = hasCustomViewport ? ['--window-size=1920,1040'] : ['--start-maximized'];
    const mergedArgs = [
      ...baseArgs.filter(a => !a.startsWith('--window-size') && a !== '--start-maximized'),
      ...customArgs,
    ];

    const browser = await chromium.launch({
      ...baseLaunchOptions,
      args: mergedArgs,
      headless: false,
    });

    console.log('hello world 111');
    consoleLogger.info('hello world 222');

    const context = await createContextWithOptionalFingerprintInjection(browser, {
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
      } catch {}
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
    await logPlaywrightFingerprint(
      page,
      process.env.OOBEE_EXPERIMENTAL_FINGERPRINT_INJECTION === '1' ? 'INJECTED' : 'DEFAULT',
    );

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
