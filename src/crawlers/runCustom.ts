/* eslint-env browser */
// import { chromium } from 'playwright';
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
import { getPlaywrightLaunchOptions } from '../constants/common.js';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

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

    const baseLaunchOptions = getPlaywrightLaunchOptions();

    // Merge base args with custom flow specific args
    const baseArgs = baseLaunchOptions.args || [];
    // const customArgs = hasCustomViewport ? ['--window-size=1920,1040'] : ['--start-maximized'];
const customArgs = ['--start-maximized','--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream','--disable-blink-features=AutomationControlled'];
    
    const mergedArgs = [...baseArgs.filter(a => !a.startsWith('--window-size') && a !== '--start-maximized'), ...customArgs];
    
    chromium.use(StealthPlugin());

    const browser = await chromium.launch({
      ...baseLaunchOptions,
      args: mergedArgs,
      headless: false,
    });
    const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.165 Safari/537.36';
    const MACOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
    const context = await browser.newContext({
      userAgent: WINDOWS_UA,
      // ignoreHTTPSErrors: true,
      // serviceWorkers: 'block',
      // // deviceScaleFactor: 1, // Standard desktop scale
      // isMobile: false,
      // hasTouch: false,
      // locale: 'en-SG', // Essential: Match the Singapore context
      // timezoneId: 'Asia/Singapore',
      // permissions: ['geolocation'],
      // viewport: null,
      // ...(hasCustomViewport ? deviceConfig : {}),
      locale: 'en-SG', 
  timezoneId: 'Asia/Singapore',
  // 2. Grant permissions to avoid the "Prompt" state
  permissions: ['geolocation', 'notifications'],
      viewport: { width: 1280, height: 720 },
  screen: { width: 1280, height: 800 },
    });

    await context.addInitScript(() => {
  // Deep WebGL Masking
  const getParameterProxy = (context) => {
    const origGetParam = context.prototype.getParameter;
    context.prototype.getParameter = function(parameter) {
      // UNMASKED_VENDOR_WEBGL
      if (parameter === 37445) return 'NVIDIA Corporation';
      // UNMASKED_RENDERER_WEBGL
      if (parameter === 37446) return 'NVIDIA GeForce RTX 4070/PCIe/SSE2';
      return origGetParam.apply(this, arguments);
    };
  };
  getParameterProxy(WebGLRenderingContext);
  getParameterProxy(WebGL2RenderingContext);

  // CRITICAL: Mask the WebGL Debug Extension specifically
  const getExtension = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attributes) {
    const ctx = getExtension.apply(this, arguments);
    if (ctx && (type === 'webgl' || type === 'webgl2')) {
      const origGetExt = ctx.getExtension;
      ctx.getExtension = function(name) {
        const ext = origGetExt.apply(this, arguments);
        if (name === 'WEBGL_debug_renderer_info') {
          return {
            UNMASKED_VENDOR_WEBGL: 37445,
            UNMASKED_RENDERER_WEBGL: 37446,
          };
        }
        return ext;
      };
    }
    return ctx;
  };
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
