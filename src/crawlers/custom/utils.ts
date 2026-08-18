/* eslint-disable no-alert */
/* eslint-disable no-param-reassign */
/* eslint-env browser */
import path from 'path';
import { getDomain } from 'tldts';
import { runAxeScript } from '../commonCrawlerFunc.js';
import { capturePageData } from '../pageCapture.js';
import { consoleLogger, guiInfoLog, silentLogger } from '../../logs.js';
import { guiInfoStatusTypes, STATUS_CODE_METADATA } from '../../constants/constants.js';
import { isSkippedUrl, validateCustomFlowLabel } from '../../constants/common.js';
import type { CustomFlowOverlayScope } from '../../types/scanCustomFlow.js';

declare global {
  interface Window {
    handleOnScanClick?: () => Promise<void> | void;
    handleOnStopClick?: () => Promise<void> | void;
    oobeeSetCollapsed?: (val: boolean) => void;
    oobeeShowStopModal?: () => Promise<{ confirmed: boolean; label: string }>;
    oobeeHideStopModal?: () => void;
    oobeeShowFinalising?: () => void;
    oobeeScanShortcutHandler?: (event: KeyboardEvent) => void;
    oobeeScanShortcutInProgress?: boolean;
    updateMenuPos?: (pos: 'LEFT' | 'RIGHT') => void;
  }
}

const sameRegistrableDomain = (hostA: string, hostB: string) => {
  const domainA = getDomain(hostA);
  const domainB = getDomain(hostB);

  if (!domainA || !domainB) return hostA === hostB;

  return domainA === domainB;
};

const parseBoolEnv = (val: string | undefined, defaultVal: boolean) => {
  if (val == null) return defaultVal;
  const v = String(val).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return defaultVal;
};

const parseOverlayScope = (val: unknown): CustomFlowOverlayScope | undefined => {
  const v = String(val || '').trim().toLowerCase();
  return v === 'all' || v === 'same-domain' || v === 'same-origin' ? v : undefined;
};

const getOverlayScope = (scope?: CustomFlowOverlayScope): CustomFlowOverlayScope => {
  const restrictOverlayToEntryDomain = parseBoolEnv(
    process.env.RESTRICT_OVERLAY_TO_ENTRY_DOMAIN,
    false,
  );

  return parseOverlayScope(scope)
    ?? parseOverlayScope(process.env.OOBEE_OVERLAY_SCOPE)
    ?? (restrictOverlayToEntryDomain ? 'same-domain' : 'all');
};

const getUseExtensionOverlayUi = (useExtensionOverlayUi?: boolean): boolean =>
  typeof useExtensionOverlayUi === 'boolean'
    ? useExtensionOverlayUi
    : parseBoolEnv(process.env.DEV_SUITE_EXTENSION_OVERLAY_UI, false);

const getExtensionSessionOrigin = (extensionSessionOrigin?: string): string =>
  extensionSessionOrigin || process.env.OOBEE_EXTENSION_SESSION_ORIGIN || 'VS Code - Oobee Dev Suite extension';
const EXTENSION_WIDGET_FONT_FAMILY =
  '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
const EXTENSION_VSCODE_ICON_SVG = String.raw`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<rect width="24" height="24" fill="url(#pattern0_3048_542)"/>
<defs>
<pattern id="pattern0_3048_542" patternContentUnits="objectBoundingBox" width="1" height="1">
<use xlink:href="#image0_3048_542" transform="translate(-0.1 -0.1) scale(0.00638298)"/>
</pattern>
<image id="image0_3048_542" width="188" height="188" preserveAspectRatio="none" xlink:href="data:image/png;base64,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"/>
</defs>
</svg>
`;
const OVERLAY_OPERATION_TIMEOUT_MS = 5000;
const EXTENSION_FINALISING_DISPLAY_MS = 1500;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const raceWithTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const isOverlayAllowed = (
  currentUrl: string,
  entryUrl: string,
  overlayScope: CustomFlowOverlayScope,
) => {
  try {
    const cur = new URL(currentUrl);

    if (cur.protocol !== 'http:' && cur.protocol !== 'https:') return false;

    const base = new URL(entryUrl);

    if (overlayScope === 'all') return true;
    if (overlayScope === 'same-origin') return cur.origin === base.origin;

    return sameRegistrableDomain(cur.hostname, base.hostname);
  } catch {
    return false;
  }
};

//! For Cypress Test
// env to check if Cypress test is running
const isCypressTest = process.env.IS_CYPRESS_TEST === 'true';

export const DEBUG = false;
export const log = str => {
  if (DEBUG) {
    console.log(str);
  }
};

export const screenshotFullPage = async (page, screenshotsDir: string, screenshotIdx) => {
  const imgName = `PHScan-screenshot${screenshotIdx}.png`;
  const imgPath = path.join(screenshotsDir, imgName);
  const originalSize = page.viewportSize();

  try {
    const fullPageSize = await page.evaluate(() => ({
      width: Math.max(
        document.body.scrollWidth,
        document.documentElement.scrollWidth,
        document.body.offsetWidth,
        document.documentElement.offsetWidth,
        document.body.clientWidth,
        document.documentElement.clientWidth,
      ),
      height: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight,
        document.body.clientHeight,
        document.documentElement.clientHeight,
      ),
    }));

    const usesInfiniteScroll = async () => {
      const prevHeight = await page.evaluate(() => document.body.scrollHeight);

      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      const isLoadMoreContent = async () => {
        await new Promise(resolve => setTimeout(resolve, 2500));
        if (page.isClosed()) return false;
        try {
          await page.waitForLoadState('domcontentloaded');
          const newHeight = await page.evaluate(() => document.body.scrollHeight);
          return newHeight > prevHeight;
        } catch {
          return false;
        }
      };

      const result = await isLoadMoreContent();
      return result;
    };

    await usesInfiniteScroll();

    // scroll back to top of page for screenshot
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });

    consoleLogger.info(`Screenshot page at: ${page.url()}`);

    await page.screenshot({
      timeout: 5000,
      path: imgPath,
      clip: {
        x: 0,
        y: 0,
        width: fullPageSize.width,
        height: 5400,
      },
      fullPage: true,
      scale: 'css',
    });

    if (originalSize) await page.setViewportSize(originalSize);
  } catch {
    consoleLogger.error('Unable to take screenshot');
    // Do not return screenshot path if screenshot fails
    return '';
  }

  return `screenshots/${imgName}`; // relative path from reports folder
};

export const runAxeScan = async (
  page,
  includeScreenshots,
  randomToken,
  customFlowDetails,
  dataset,
  urlsCrawled,
) => {
  const result = await runAxeScript({ includeScreenshots, page, randomToken, customFlowDetails });

  if (result.axeScanFailed) {
    guiInfoLog(guiInfoStatusTypes.ERROR, {
      numScanned: urlsCrawled.scanned.length,
      urlScanned: page.url(),
    });
    urlsCrawled.error.push({
      url: page.url(),
      pageTitle: result.pageTitle,
      actualUrl: page.url(),
      metadata: STATUS_CODE_METADATA[2],
      httpStatusCode: 2,
    });
    return;
  }

  await capturePageData(page, page.url(), randomToken);

  await dataset.pushData(result);

  const rawTitle = result.pageTitle ?? '';
  let pageTitleTextOnly = rawTitle; // Note: The original pageTitle contains the index and is being used in top 10 issues

  if (typeof result.pageIndex === 'number') {
    const re = new RegExp(`^\\s*${result.pageIndex}\\s*:\\s*`);
    pageTitleTextOnly = rawTitle.replace(re, '');
  } else {
    pageTitleTextOnly = rawTitle.replace(/^\s*\d+\s*:\s*/, '');
  }

  urlsCrawled.scanned.push({
    url: page.url(),
    pageTitle: pageTitleTextOnly,
    pageImagePath: customFlowDetails.pageImagePath,
  });
};

export const processPage = async (page, processPageParams) => {
  // make sure to update processPageParams' scannedIdx
  processPageParams.scannedIdx += 1;

  let { includeScreenshots } = processPageParams;

  const {
    scannedIdx,
    blacklistedPatterns,
    dataset,
    intermediateScreenshotsPath,
    urlsCrawled,
    randomToken,
  } = processPageParams;

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
  } catch {
    consoleLogger.info('Unable to detect page load state');
  }

  consoleLogger.info(`Attempting to scan: ${page.url()}`);

  const pageUrl = page.url();

  if (blacklistedPatterns && isSkippedUrl(pageUrl, blacklistedPatterns)) {
    const continueScan = await page.evaluate(() =>
      window.confirm('Page has been excluded, would you still like to proceed with the scan?'),
    );
    if (!continueScan) {
      urlsCrawled.userExcluded.push({
        url: pageUrl,
        pageTitle: pageUrl,
        actualUrl: pageUrl,
      });

      return;
    }
  }

  // TODO: Check if necessary
  // To skip already scanned pages
  // if (urlsCrawled.scanned.some(scan => scan.url === pageUrl)) {
  //   page.evaluate(() => {
  //     window.alert('Page has already been scanned, skipping scan.');
  //   });
  //   return;
  // }

  try {
    const initialScrollPos = await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
    }));

    const pageImagePath = await screenshotFullPage(page, intermediateScreenshotsPath, scannedIdx);

    // TODO: This is a temporary fix to not take element screenshots on pages when errors out at full page screenshot
    if (pageImagePath === '') {
      includeScreenshots = false;
    }

    await runAxeScan(
      page,
      includeScreenshots,
      randomToken,
      {
        pageIndex: scannedIdx,
        pageImagePath,
      },
      dataset,
      urlsCrawled,
    );

    if (includeScreenshots) {
      consoleLogger.info(`Successfully screenshot page at: ${page.url()}`);
    }

    guiInfoLog(guiInfoStatusTypes.SCANNED, {
      numScanned: urlsCrawled.scanned.length,
      urlScanned: pageUrl,
    });

    await page.evaluate(pos => {
      window.scrollTo(pos.x, pos.y);
    }, initialScrollPos);
  } catch {
    consoleLogger.error(`Error in scanning page: ${pageUrl}`);
  }
};

export const MENU_POSITION = {
  left: 'LEFT',
  right: 'RIGHT',
};

type OverlayOpts = {
  inProgress?: boolean;
  collapsed?: boolean;
  hideStopInput?: boolean;
  entryUrl?: string;
  extensionOverlayUi?: boolean;
  sessionOrigin?: string;
  fontFamily?: string;
  vscodeIconSvg?: string;
  maxPagesToScan?: number;
};

export const updateMenu = async (page, urlsCrawled) => {
  log(`Overlay menu: updating: ${page.url()}`);
  await page.evaluate(
    vars => {
      const shadowHost = document.querySelector('#oobeeShadowHost');
      if (shadowHost) {
        const p = shadowHost.shadowRoot.querySelector('#oobee-p-pages-scanned');
        if (p) {
          p.textContent = `Pages Scanned: ${vars.urlsCrawled.scanned.length}`;
        }
      }
    },
    { urlsCrawled },
  );

  consoleLogger.info(`Overlay menu updated`);
};

export const addOverlayMenu = async (
  page,
  urlsCrawled,
  menuPos,
  opts: OverlayOpts = {
    inProgress: false,
    collapsed: false,
  },
) => {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 2000 });
  } catch {
    // In CDP mode the load state may not resolve after script injection (e.g. axe-core).
    // Proceed with injection anyway — the DOM is accessible if evaluate() succeeds.
  }
  consoleLogger.info(`Overlay menu: adding to ${menuPos}...`);

  // Add the overlay menu with initial styling
  return page
    .evaluate(
      async vars => {
        const customWindow: Window = window as unknown as Window;
        const inProgress = !!(vars?.opts && vars.opts.inProgress);
        const collapsedOption = !!(vars?.opts && vars.opts.collapsed);
        const useExtensionUi = !!(vars?.opts && vars.opts.extensionOverlayUi);
        const scannedCount = vars.urlsCrawled.scanned.length;
        const maxPagesToScan = Number(vars?.opts?.maxPagesToScan);
        const hasScanLimit = Number.isFinite(maxPagesToScan) && maxPagesToScan > 0;
        const isScanLimitReached = hasScanLimit && scannedCount >= maxPagesToScan;

        const safeLocalGet = (key: string): string | null => {
          try {
            return localStorage.getItem(key);
          } catch {
            return null;
          }
        };
        const safeLocalSet = (key: string, value: string): void => {
          try {
            localStorage.setItem(key, value);
          } catch {
            // ignore
          }
        };
        const sessionOrigin = vars?.opts?.sessionOrigin || 'VS Code - Oobee Dev Suite extension';
        const widgetFontFamily =
          vars?.opts?.fontFamily ||
          '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
        const vscodeIconSvg = vars?.opts?.vscodeIconSvg || '';

        const panel = document.createElement('aside');
        panel.className = useExtensionUi ? 'oobee-panel oobee-panel-extension' : 'oobee-panel';
        panel.id = 'oobeePanel';
        if (useExtensionUi) {
          // The visible <h2 id="oobeeHPagesScanned"> is display:none'd in extension
          // mode, leaving the <aside> landmark unnamed for screen readers.
          panel.setAttribute('aria-label', 'Scanned pages');
        }

        const minBtn = document.createElement('button');
        minBtn.type = 'button';
        minBtn.className = 'oobee-minbtn';
        minBtn.setAttribute('aria-label', 'Minimize/expand panel');

        // Skip the SVG payload in extension mode — minBtn is never attached to
        // the shadow root there, so the icon is never rendered.
        if (!useExtensionUi) {
          minBtn.innerHTML = `
            <svg class="oobee-minbtn__icon" xmlns="http://www.w3.org/2000/svg"
                width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              <g clip-path="url(#clip0_59_3691)">
                <path d="M6.41 6L5 7.41L9.58 12L5 16.59L6.41 18L12.41 12L6.41 6Z" fill="#9021A6"/>
                <path d="M14.41 6L13 7.41L17.58 12L13 16.59L14.41 18L20.41 12L14.41 6Z" fill="#9021A6"/>
              </g>
              <defs>
                <clipPath id="clip0_59_3691">
                  <rect width="24" height="24" fill="white"/>
                </clipPath>
              </defs>
            </svg>
          `;
        }

        let currentPos: 'LEFT' | 'RIGHT' = useExtensionUi ? 'RIGHT' : vars.menuPos || 'RIGHT';
        const isCollapsed = () => panel.classList.contains('collapsed');

        const setPosClass = (pos: 'LEFT' | 'RIGHT') => {
          panel.classList.remove('pos-left', 'pos-right');
          minBtn.classList.remove('pos-left', 'pos-right');
          if (pos === 'LEFT') {
            panel.classList.add('pos-left');
            minBtn.classList.add('pos-left');
          } else {
            panel.classList.add('pos-right');
            minBtn.classList.add('pos-right');
          }
          positionMinimizeBtn();
          setDraggableSidebarMenu();
        };

        const toggleCollapsed = (force?: boolean) => {
          const willCollapse = typeof force === 'boolean' ? force : !isCollapsed();
          if (willCollapse) {
            panel.classList.add('collapsed');
            safeLocalSet('oobee:overlay-collapsed', '1');
            customWindow.oobeeSetCollapsed?.(true);
          } else {
            panel.classList.remove('collapsed');
            safeLocalSet('oobee:overlay-collapsed', '0');
            customWindow.oobeeSetCollapsed?.(false);
          }
          positionMinimizeBtn();
          setDraggableSidebarMenu();
        };

        setPosClass(currentPos);
        const persisted = safeLocalGet('oobee:overlay-collapsed');
        const startCollapsed = persisted != null ? persisted === '1' : collapsedOption;
        if (startCollapsed) panel.classList.add('collapsed');

        const header = document.createElement('div');
        header.className = 'oobee-header';

        const grip = document.createElement('button');
        grip.type = 'button';
        grip.className = 'oobee-grip';
        grip.setAttribute('aria-label', 'Drag to move panel left or right');

        const GRIP_SVG = `
          <svg class="oobee-grip__icon" xmlns="http://www.w3.org/2000/svg"
              width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <path d="M6 11C4.9 11 4 10.1 4 9C4 7.9 4.9 7 6 7C7.1 7 8 7.9 8 9C8 10.1 7.1 11 6 11ZM14 9C14 7.9 13.1 7 12 7C10.9 7 10 7.9 10 9C10 10.1 10.9 11 12 11C13.1 11 14 10.1 14 9ZM20 9C20 7.9 19.1 7 18 7C16.9 7 16 7.9 16 9C16 10.1 16.9 11 18 11C19.1 11 20 10.1 20 9ZM16 15C16 16.1 16.9 17 18 17C19.1 17 20 16.1 20 15C20 13.9 19.1 13 18 13C16.9 13 16 13.9 16 15ZM14 15C14 13.9 13.1 13 12 13C10.9 13 10 13.9 10 15C10 16.1 10.9 17 12 17C13.1 17 14 16.1 14 15ZM8 15C8 13.9 7.1 13 6 13C4.9 13 4 13.9 4 15C4 16.1 4.9 17 6 17C7.1 17 8 16.1 8 15Z" fill="#AFAFB0"/>
          </svg>
        `;
        grip.innerHTML = GRIP_SVG;

        const leftSpacer = document.createElement('div');
        leftSpacer.className = 'oobee-spacer';
        const rightSpacer = document.createElement('div');
        rightSpacer.className = 'oobee-spacer';

        header.appendChild(leftSpacer);
        header.appendChild(grip);
        header.appendChild(rightSpacer);

        const body = document.createElement('div');
        body.className = 'oobee-body';

        const h2 = document.createElement('h2');
        h2.id = 'oobeeHPagesScanned';
        h2.className = 'oobee-section-title';
        h2.textContent = hasScanLimit
          ? `Pages Scanned (${Math.min(scannedCount, maxPagesToScan)}/${maxPagesToScan})`
          : `Pages Scanned (${scannedCount})`;

        const scanIcon = document.createElement('span');
        scanIcon.className = 'oobee-btn-icon';

        const SCAN_SVG = `
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">
            <g clip-path="url(#clip0_1421_431)">
              <path d="M12.5763 11.5472L12.2958 11.2857L12.1037 11.1005C12.776 10.3183 12.9194 9.56432 12.9194 8.45969C12.9194 5.99657 10.9228 4 8.45969 4C5.99657 4 4 5.99657 4 8.45969C4 10.9228 5.99657 12.9194 8.45969 12.9194C9.56432 12.9194 10.3183 12.776 11.1005 12.1037L11.2857 12.2958L11.5472 12.5763L14.9777 16L16 14.9777L12.5763 11.5472ZM8.45969 11.5472C6.75129 11.5472 5.37221 10.1681 5.37221 8.45969C5.37221 6.75129 6.75129 5.37221 8.45969 5.37221C10.1681 5.37221 11.5472 6.75129 11.5472 8.45969C11.5472 10.1681 10.1681 11.5472 8.45969 11.5472Z" fill="white"/>
              <path d="M18.5 0H19.5C19.7761 0 20 0.223858 20 0.5V5H18.5V0Z" fill="white"/>
              <path d="M19.5 2.18552e-08L19.5 1.5L15 1.5L15 -2.18556e-07L19.5 2.18552e-08Z" fill="white"/>
              <path d="M1.5 0H0.5C0.223858 0 0 0.223858 0 0.5V5H1.5V0Z" fill="white"/>
              <path d="M0.5 2.18552e-08L0.5 1.5L5 1.5L5 -2.18556e-07L0.5 2.18552e-08Z" fill="white"/>
              <path d="M1.5 20H0.5C0.223858 20 0 19.7761 0 19.5V15H1.5V20Z" fill="white"/>
              <path d="M0.5 20L0.5 18.5L5 18.5L5 20L0.5 20Z" fill="white"/>
              <path d="M18.5 20H19.5C19.7761 20 20 19.7761 20 19.5V15H18.5V20Z" fill="white"/>
              <path d="M19.5 20L19.5 18.5L15 18.5L15 20L19.5 20Z" fill="white"/>
            </g>
            <defs>
              <clipPath id="clip0_1421_431">
                <rect width="20" height="20" fill="white"/>
              </clipPath>
            </defs>
          </svg>
        `;
        
        scanIcon.innerHTML = SCAN_SVG; 
        const scanBtn = isScanLimitReached
          ? document.createElement('div') // Note: Using div instead of button to prevent user open inspector and remove disabled attributes
          : document.createElement('button');
        scanBtn.id = 'oobeeBtnScan';
        scanBtn.className = isScanLimitReached
          ? 'oobee-btn oobee-btn-primary oobee-btn-static'
          : 'oobee-btn oobee-btn-primary';
        if (scanBtn instanceof HTMLButtonElement) {
          scanBtn.type = 'button';
          scanBtn.disabled = inProgress;
        }
        scanBtn.appendChild(scanIcon);

        const scanText = document.createElement('span');
        scanText.className = 'oobee-btn-text';
        scanText.innerText = isScanLimitReached ? 'Scan limit reached' : 'Scan page';
        scanBtn.appendChild(scanText);

        if (scanBtn instanceof HTMLButtonElement) {
          scanBtn.addEventListener('click', async () => customWindow.handleOnScanClick?.());
        }

        const endScanIcon = document.createElement('span');
        endScanIcon.className = 'oobee-btn-icon';

        const ENDSCAN_SVG = 
          `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 0C4.47 0 0 4.47 0 10C0 15.53 4.47 20 10 20C15.53 20 20 15.53 20 10C20 4.47 15.53 0 10 0ZM10 18C5.59 18 2 14.41 2 10C2 5.59 5.59 2 10 2C14.41 2 18 5.59 18 10C18 14.41 14.41 18 10 18ZM13.59 5L10 8.59L6.41 5L5 6.41L8.59 10L5 13.59L6.41 15L10 11.41L13.59 15L15 13.59L11.41 10L15 6.41L13.59 5Z" fill="#9021A6"/>
          </svg>
        `;

        endScanIcon.innerHTML = ENDSCAN_SVG;
        const endScanBtn = document.createElement('button');
        endScanBtn.id = 'oobeeBtnEndScan';
        endScanBtn.className = 'oobee-btn oobee-btn-secondary';
        endScanBtn.appendChild(endScanIcon);
        
        const endScanText = document.createElement('span');
        endScanText.className = 'oobee-btn-text';
        endScanText.innerText = 'End scan';
        endScanBtn.appendChild(endScanText);

        endScanBtn.addEventListener('click', async () => customWindow.handleOnStopClick?.());

        // Topbar is only rendered in extension mode. All the DOM construction,
        // event bindings, and layout state below are extension-only — skipping
        // them in CLI mode avoids ~8 pointer listeners and a full DOM tree
        // that would never be attached.
        let topbar: HTMLElement | null = null;
        let getStoredToolbarY: () => number = () => 0;
        let setExtensionLayout: (nextY: number, persist?: boolean) => void = () => {};
        let setPagesPanelHidden: (hidden: boolean) => void = () => {};
        let getCurrentToolbarY: () => number = () => 0;

        if (useExtensionUi) {
          const topbarEl = document.createElement('div');
          topbarEl.className = 'oobee-topbar oobee-topbar-visible';
          topbarEl.setAttribute('role', 'toolbar');
          topbarEl.setAttribute('aria-label', 'Oobee scan controls');

          const topbarBrand = document.createElement('div');
          topbarBrand.className = 'oobee-topbar-brand';

          const topbarDrag = document.createElement('span');
          topbarDrag.className = 'oobee-topbar-drag';
          topbarDrag.setAttribute('aria-hidden', 'true');
          topbarDrag.innerHTML = '<svg width="10" height="16" viewBox="0 0 10 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 14C4 15.1 3.1 16 2 16C0.9 16 0 15.1 0 14C0 12.9 0.9 12 2 12C3.1 12 4 12.9 4 14ZM2 6C0.9 6 0 6.9 0 8C0 9.1 0.9 10 2 10C3.1 10 4 9.1 4 8C4 6.9 3.1 6 2 6ZM2 0C0.9 0 0 0.9 0 2C0 3.1 0.9 4 2 4C3.1 4 4 3.1 4 2C4 0.9 3.1 0 2 0ZM8 4C9.1 4 10 3.1 10 2C10 0.9 9.1 0 8 0C6.9 0 6 0.9 6 2C6 3.1 6.9 4 8 4ZM8 6C6.9 6 6 6.9 6 8C6 9.1 6.9 10 8 10C9.1 10 10 9.1 10 8C10 6.9 9.1 6 8 6ZM8 12C6.9 12 6 12.9 6 14C6 15.1 6.9 16 8 16C9.1 16 10 15.1 10 14C10 12.9 9.1 12 8 12Z" fill="#CCCCCC"/></svg>';

          const topbarLogo = document.createElement('span');
          topbarLogo.className = 'oobee-topbar-logo';
          topbarLogo.setAttribute('aria-hidden', 'true');
          topbarLogo.innerHTML = vscodeIconSvg;

          const topbarTitle = document.createElement('span');
          topbarTitle.className = 'oobee-topbar-title';
          topbarTitle.textContent = `Session Origin: ${sessionOrigin}`;

          topbarBrand.appendChild(topbarDrag);
          topbarBrand.appendChild(topbarLogo);
          topbarBrand.appendChild(topbarTitle);

          const topbarActions = document.createElement('div');
          topbarActions.className = 'oobee-topbar-actions';

          const topbarScanIconSvg = '<svg width="11" height="14" viewBox="0 0 11 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10.6667 11.7267V4.55333C10.6667 4.2 10.5267 3.86 10.2733 3.61333L7.05333 0.393333C6.80667 0.14 6.46667 0 6.11333 0H1.33333C0.6 0 0.00666682 0.6 0.00666682 1.33333L0 12C0 12.7333 0.593333 13.3333 1.32667 13.3333H9.33333C9.63333 13.3333 9.9 13.2333 10.1267 13.0667L7.17333 10.1133C6.6 10.4867 5.91333 10.7 5.17333 10.66C3.59333 10.5867 2.24 9.35333 2.02667 7.78667C1.73333 5.55333 3.66 3.66667 5.91333 4.04667C7.21333 4.26667 8.29333 5.28 8.58 6.56667C8.8 7.54 8.58667 8.44667 8.11333 9.16667L10.6667 11.7267ZM3.33333 7.33333C3.33333 8.44 4.22667 9.33333 5.33333 9.33333C6.44 9.33333 7.33333 8.44 7.33333 7.33333C7.33333 6.22667 6.44 5.33333 5.33333 5.33333C4.22667 5.33333 3.33333 6.22667 3.33333 7.33333Z" fill="white"/></svg>';
          const topbarEndScanIconSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.66667 9.33333H8.66667C9.03333 9.33333 9.33333 9.03333 9.33333 8.66667V4.66667C9.33333 4.3 9.03333 4 8.66667 4H4.66667C4.3 4 4 4.3 4 4.66667V8.66667C4 9.03333 4.3 9.33333 4.66667 9.33333ZM6.66667 0C2.98667 0 0 2.98667 0 6.66667C0 10.3467 2.98667 13.3333 6.66667 13.3333C10.3467 13.3333 13.3333 10.3467 13.3333 6.66667C13.3333 2.98667 10.3467 0 6.66667 0Z" fill="white"/></svg>';
          const topbarPagesIconSvg = '<svg width="11" height="14" viewBox="0 0 11 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.33333 0C0.6 0 0.00666682 0.6 0.00666682 1.33333L0 12C0 12.7333 0.593333 13.3333 1.32667 13.3333H9.33333C10.0667 13.3333 10.6667 12.7333 10.6667 12V4.55333C10.6667 4.2 10.5267 3.86 10.2733 3.61333L7.05333 0.393333C6.80667 0.14 6.46667 0 6.11333 0H1.33333ZM6 4V1L9.66667 4.66667H6.66667C6.3 4.66667 6 4.36667 6 4Z" fill="white"/></svg>';
          const topbarDropdownIconSvg = '<svg width="8" height="5" viewBox="0 0 8 5" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.30833 0.195L3.72167 2.78167L1.135 0.195C0.875 -0.065 0.455 -0.065 0.195 0.195C-0.065 0.455 -0.065 0.875 0.195 1.135L3.255 4.195C3.515 4.455 3.935 4.455 4.195 4.195L7.255 1.135C7.515 0.875 7.515 0.455 7.255 0.195C6.995 -0.0583333 6.56833 -0.065 6.30833 0.195Z" fill="white"/></svg>';

          const makeTopbarButton = (
            id: string,
            iconHtml: string,
            text: string,
            onClick: () => void,
            extra?: (btn: HTMLButtonElement) => void,
          ): HTMLButtonElement => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = id;
            btn.className = 'oobee-topbar-action';
            const icon = document.createElement('span');
            icon.className = 'oobee-btn-icon';
            icon.innerHTML = iconHtml;
            const label = document.createElement('span');
            label.className = 'oobee-btn-text';
            label.textContent = text;
            btn.appendChild(icon);
            btn.appendChild(label);
            btn.addEventListener('click', onClick);
            if (extra) extra(btn);
            return btn;
          };

          const topbarScanBtn = makeTopbarButton(
            'oobeeTopbarBtnScan',
            topbarScanIconSvg,
            'Scan Page (Ctrl/Cmd+Shift+X)',
            () => { void customWindow.handleOnScanClick?.(); },
            btn => {
              btn.disabled = inProgress || isScanLimitReached;
              btn.setAttribute('aria-keyshortcuts', 'Control+Shift+X Meta+Shift+X');
              if (isScanLimitReached) {
                btn.classList.add('oobee-topbar-action-static');
                const label = btn.querySelector('.oobee-btn-text');
                if (label) label.textContent = 'Scan limit reached';
              }
            },
          );

          const topbarEndScanBtn = makeTopbarButton(
            'oobeeTopbarBtnEndScan',
            topbarEndScanIconSvg,
            'End scan',
            () => { void customWindow.handleOnStopClick?.(); },
          );

          const topbarPagesBtn = document.createElement('button');
          topbarPagesBtn.type = 'button';
          topbarPagesBtn.className = 'oobee-topbar-action oobee-topbar-pages';
          topbarPagesBtn.setAttribute('aria-controls', 'oobeePanel');
          topbarPagesBtn.setAttribute('aria-expanded', 'true');
          const pagesLabel = hasScanLimit
            ? `${Math.min(scannedCount, maxPagesToScan)}/${maxPagesToScan}`
            : String(scannedCount);
          topbarPagesBtn.innerHTML = `<span class="oobee-btn-icon">${topbarPagesIconSvg}</span><span class="oobee-btn-text">${pagesLabel} Pages scanned</span><span class="oobee-dropdown-icon" aria-hidden="true">${topbarDropdownIconSvg}</span>`;

          topbarActions.appendChild(topbarScanBtn);
          topbarActions.appendChild(topbarEndScanBtn);
          topbarActions.appendChild(topbarPagesBtn);

          topbarEl.appendChild(topbarBrand);
          const topbarDragSurface = document.createElement('div');
          topbarDragSurface.className = 'oobee-topbar-drag-surface';
          topbarDragSurface.setAttribute('aria-hidden', 'true');
          topbarEl.appendChild(topbarDragSurface);
          topbarEl.appendChild(topbarActions);

          const TOOLBAR_HEIGHT = 40;
          const MIN_PANEL_HEIGHT = 180;
          let toolbarY = 0;
          const clampToolbarY = (value: number) =>
            Math.max(0, Math.min(value, Math.max(0, window.innerHeight - TOOLBAR_HEIGHT)));
          getStoredToolbarY = () => {
            const raw = safeLocalGet('oobee:extension-toolbar-y');
            const parsed = raw == null ? 0 : Number(raw);
            return Number.isFinite(parsed) ? clampToolbarY(parsed) : 0;
          };
          getCurrentToolbarY = () => toolbarY;
          setExtensionLayout = (nextY, persist = true) => {
            toolbarY = clampToolbarY(nextY);
            const panelTop = toolbarY + TOOLBAR_HEIGHT;
            const spaceBelow = window.innerHeight - panelTop;
            const spaceAbove = toolbarY;
            const openPanelAbove = spaceBelow < MIN_PANEL_HEIGHT && spaceAbove > spaceBelow;
            topbarEl.style.top = `${toolbarY}px`;
            panel.classList.toggle('opens-above', openPanelAbove);
            if (openPanelAbove) {
              panel.style.top = '0';
              panel.style.bottom = `${window.innerHeight - toolbarY}px`;
              panel.style.height = `${spaceAbove}px`;
            } else {
              panel.style.top = `${panelTop}px`;
              panel.style.bottom = '';
              panel.style.height = `calc(100vh - ${panelTop}px)`;
            }
            const finalising = shadowRoot.querySelector<HTMLElement>('.oobee-finalising');
            if (finalising) {
              finalising.style.top = `${panelTop}px`;
            }
            if (persist) {
              safeLocalSet('oobee:extension-toolbar-y', String(toolbarY));
            }
          };
          setPagesPanelHidden = hidden => {
            panel.classList.toggle('is-pages-hidden', hidden);
            topbarPagesBtn.setAttribute('aria-expanded', String(!hidden));
            safeLocalSet('oobee:extension-pages-hidden', hidden ? '1' : '0');
          };
          topbarPagesBtn.addEventListener('click', () => {
            setPagesPanelHidden(!panel.classList.contains('is-pages-hidden'));
          });

          // Bind pointerdown on drag surfaces; window handles move/up/cancel so
          // the drag survives if the pointer leaves the surface.
          let dragStartY = 0;
          let dragOriginY = 0;
          let activeDragTarget: HTMLElement | null = null;
          const startTopbarDrag = (event: PointerEvent, dragTarget: HTMLElement) => {
            dragStartY = event.clientY;
            dragOriginY = toolbarY;
            activeDragTarget = dragTarget;
            try {
              dragTarget.setPointerCapture(event.pointerId);
            } catch {}
            topbarEl.classList.add('is-dragging');
            event.preventDefault();
          };
          const moveTopbarDrag = (event: PointerEvent) => {
            if (!activeDragTarget) return;
            setExtensionLayout(dragOriginY + event.clientY - dragStartY);
          };
          const stopTopbarDrag = (event: PointerEvent) => {
            if (!activeDragTarget) return;
            try {
              activeDragTarget.releasePointerCapture(event.pointerId);
            } catch {}
            activeDragTarget = null;
            topbarEl.classList.remove('is-dragging');
          };
          const bindTopbarDrag = (dragTarget: HTMLElement) => {
            dragTarget.addEventListener('pointerdown', event => startTopbarDrag(event, dragTarget));
          };
          window.addEventListener('pointermove', moveTopbarDrag);
          window.addEventListener('pointerup', stopTopbarDrag);
          window.addEventListener('pointercancel', stopTopbarDrag);
          bindTopbarDrag(topbarBrand);
          bindTopbarDrag(topbarDragSurface);

          topbar = topbarEl;
        }

        const btnGroup = document.createElement('div');
        btnGroup.className = 'oobee-actions';
        btnGroup.appendChild(scanBtn);
        btnGroup.appendChild(endScanBtn);

        const listWrap = document.createElement('div');
        listWrap.id = 'oobeeList';
        listWrap.className = 'oobee-list';
        if (useExtensionUi) {
          // Prevent scroll from bubbling to the page when the user scrolls the
          // extension pages panel. In classic (CLI) mode the list is inside the
          // sidebar and we want native scroll pass-through.
          listWrap.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
          listWrap.addEventListener('touchmove', event => event.stopPropagation(), { passive: true });
        }

        const limitMessage = document.createElement('p');
        limitMessage.className = 'oobee-limit-message';
        limitMessage.textContent = hasScanLimit
          ? `Scan limit reached. You can scan up to ${maxPagesToScan} pages; additional pages will be ignored.`
          : '';
        limitMessage.hidden = !isScanLimitReached;

        if (useExtensionUi) {
          if (customWindow.oobeeScanShortcutHandler) {
            window.removeEventListener('keydown', customWindow.oobeeScanShortcutHandler, true);
          }
          customWindow.oobeeScanShortcutHandler = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'x') {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (!inProgress && !isScanLimitReached && !customWindow.oobeeScanShortcutInProgress) {
              customWindow.oobeeScanShortcutInProgress = true;
              void Promise.resolve(customWindow.handleOnScanClick?.()).finally(() => {
                customWindow.oobeeScanShortcutInProgress = false;
              });
            }
          };
          window.addEventListener('keydown', customWindow.oobeeScanShortcutHandler, true);
        }

        const renderList = () => {
          const scanned = vars.urlsCrawled.scanned || [];
          listWrap.innerHTML = '';

          if (scanned.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'oobee-empty';
            empty.textContent = 'Scan a page to start';
            listWrap.appendChild(empty);
            return;
          }

          const ol = document.createElement('ol');
          ol.className = 'oobee-ol';

          if (useExtensionUi) {
            const host = document.createElement('div');
            host.className = 'oobee-list-host';
            try {
              host.textContent = new URL(vars?.opts?.entryUrl || window.location.href).origin;
            } catch {
              host.textContent = vars?.opts?.entryUrl || window.location.origin;
            }
            listWrap.appendChild(host);
          }

          scanned.forEach(item => {
            const li = document.createElement('li');
            li.className = 'oobee-li';

            const title = document.createElement('div');
            title.className = 'oobee-item-title';
            title.textContent = item.pageTitle && item.pageTitle.trim() ? item.pageTitle : item.url;

            const url = document.createElement('div');
            url.className = 'oobee-item-url';
            url.textContent = item.url;

            li.appendChild(title);
            li.appendChild(url);
            ol.appendChild(li);
          });

          listWrap.appendChild(ol);
        };
        renderList();

        body.appendChild(btnGroup);
        body.appendChild(h2);
        body.appendChild(limitMessage);
        body.appendChild(listWrap);

        panel.appendChild(header);
        panel.appendChild(body);

        const sheet = new CSSStyleSheet();
        // TODO: separate out into css file if this gets too big
        sheet.replaceSync(`
          .oobee-panel{
            position: fixed;
            top: 0;
            height: 100vh;
            width: 320px;
            box-sizing: border-box;
            background: #fff;
            color: #111;
            font-family: ${widgetFontFamily};
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            border: 1px solid rgba(0,0,0,.08);border-left: none;border-right: none;
            box-shadow: 0 6px 24px rgba(0,0,0,.08);
            transition: width .16s ease,left .16s ease,right .16s ease
          }
          .oobee-panel.pos-right {
            right: 0;
            border-left: 1px solid rgba(0,0,0,.08)
          }
          .oobee-panel.pos-left {
            left: 0;
            border-right: 1px solid rgba(0,0,0,.08)
          }
          .oobee-panel.collapsed {
            width: 58px;
            overflow: hidden
          }

          .oobee-panel-extension {
            top: 40px;
            height: calc(100vh - 40px);
            width: 240px;
            background: #333333;
            color: #f5f5f5;
            border: 0;
            box-shadow: none;
          }
          .oobee-panel-extension.is-pages-hidden {
            display: none;
          }

          :host {
            --oobee-gap: 8px;                 /* distance from panel edge */
            --oobee-panel-offset: 320px;      /* overwritten by JS to actual width */
          }

          /* external minimize button (always OUTSIDE the panel) */
          .oobee-minbtn {
            position: fixed;
            top: 0;
            z-index: 2147483647;
            width: 32px;
            height: 32px;
            border: none;
            background: #fff;
            cursor: pointer;
          }

          /* right-docked: button sits to the LEFT of the panel */
          .oobee-minbtn.pos-right{
            right: calc(var(--oobee-panel-offset) + var(--oobee-gap));
          }
          /* left-docked: button sits to the RIGHT of the panel */
          .oobee-minbtn.pos-left{
            left: calc(var(--oobee-panel-offset) + var(--oobee-gap));
          }
          .oobee-minbtn:hover {
            box-shadow:0 4px 12px rgba(0,0,0,.12);
          }
          .oobee-minbtn:active {
            transform:translateY(1px);
          }
          .oobee-minbtn:focus-visible {
            outline: 2px solid #7b4dff;
            outline-offset: 2px;
          }

          .oobee-panel-extension + .oobee-minbtn {
            display: none;
          }

          .oobee-header {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: space-between;
          }

          .oobee-panel-extension .oobee-header {
            display: none;
          }

          .oobee-spacer {
            width:28px;
            height:28px;
          }

          .oobee-grip{
            border: 0;
            background: #FFFFFF;
            cursor: grab;
            margin-top: 0.4rem;
          }
          .oobee-grip:active {
            cursor:grabbing;
          }

          .oobee-body {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            overflow: hidden;
          }

          .oobee-actions {
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 1rem;
          }

          .oobee-panel-extension .oobee-actions {
            display: none;
          }

          .oobee-panel.collapsed .oobee-actions {
            display: flex;
            justify-content: center;
            padding: 1rem 0.7rem;
          }

          /* Base button */
          .oobee-btn {
            width: 100%;
            min-height: 44px;
            border-radius: 999px;
            padding: 12px 16px;
            font-size: 16px;
            line-height: 1.2;
            font-weight: 400;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            transition: {
              box-shadow .12s ease,
              transform .02s ease,
              background-color .12s ease,
              color .12s ease,
              border-color .12s ease;
            }
          }
          .oobee-btn:disabled {
            opacity:.6;
            cursor:not-allowed
          }
          .oobee-btn-static {
            cursor: default;
            opacity: .85;
          }

          .oobee-panel.collapsed .oobee-btn {
            width: 44px !important;
            height: 44px !important;
            min-width: 44px !important;
            min-height: 44px !important;
            max-width: 44px !important;
            max-height: 44px !important;
            border-radius: 50% !important;
            padding: 0 !important;
            justify-content: center;
            gap: 0;
          }

          /* Primary (filled) */
          .oobee-btn-primary {
            background: #9021a6;
            color: #fff;
            border: 1px solid transparent;
          }
          .oobee-btn-primary:hover:not(:disabled):not(.oobee-btn-static) {
            box-shadow:0 2px 10px rgba(0,0,0,.12);
          }
          .oobee-btn-primary:active:not(:disabled):not(.oobee-btn-static) {
            transform:translateY(1px);
          }
          .oobee-btn-primary:focus-visible:not(.oobee-btn-static) {
            outline:2px solid #7b4dff;
            outline-offset:2px;
          }

          /* Stop button */
          .oobee-btn-secondary{
            background: #fff;
            color: #9021A6;
            border: 1px solid #9021A6;
          }
          .oobee-btn-secondary:active:not(:disabled) {
            transform:translateY(1px);
          }
          .oobee-btn-secondary:focus-visible{
            outline: 2px solid #7b4dff;
            outline-offset:2px;
          }

          /* Text for empty scans */
          .oobee-empty{
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100%;
            font-size: 14px;
            color: #555555;
          }

          .oobee-panel-extension .oobee-empty {
            justify-content: flex-start;
            align-items: flex-start;
            height: auto;
            padding: 0;
            color: #CCCCCC;
            font-size: 14px;
          }

          .oobee-limit-message {
            margin: 0 1rem 0.75rem;
            padding: 0.75rem;
            border-radius: 4px;
            background: #fff7ed;
            color: #9a3412;
            font-size: 12px;
            line-height: 1.4;
          }

          .oobee-limit-message[hidden] {
            display: none;
          }

          .oobee-panel-extension .oobee-limit-message {
            margin: 0 16px;
            background: #4a3528;
            color: #ffd7ba;
          }

          .oobee-list {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding-left: 1rem;
            padding-right: 1rem;
            padding-bottom: 1rem;
            padding-top: 0;
          }

          .oobee-panel-extension .oobee-list {
            padding: 16px;
            color: #CCCCCC;
            overscroll-behavior: contain;
          }

          .oobee-panel.collapsed .oobee-list {
            display: none;
          }

          .oobee-btn-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            vertical-align: middle;
          }

          .oobee-btn-text {
            display: inline;
            white-space: nowrap;
            vertical-align: middle;
          }
          
          .oobee-panel.collapsed .oobee-btn-text {
            display: none;
          }

          #oobeeStopOverlay[hidden] {
            display:none !important;
          }
          #oobeeStopOverlay {
            display:grid;
          }

          .oobee-section-title {
            font-size: 16px;
            font-weight: 700;
            color: #161616;
            border-top: 1px solid rgba(0, 0, 0, 0.08);
            padding: 1rem;
            margin: 0;
          }

          .oobee-panel-extension .oobee-section-title {
            display: none;
          }

          .oobee-panel.collapsed .oobee-section-title {
            font-size: 14px;
            display: flex;
            justify-content: center;
            text-align: center;
          }

          .oobee-ol {
            margin: 0;
            padding-left: 1.25rem;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          .oobee-panel-extension .oobee-ol {
            padding-left: 18px;
            gap: 14px;
          }

          .oobee-li {
            list-style: decimal;
            font-size: 14px;
          }

          .oobee-panel-extension .oobee-li {
            color: #CCCCCC;
            font-size: 14px;
          }

          .oobee-item-title {
            font-size: 14px;
            color: #161616;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .oobee-panel-extension .oobee-item-title {
            color: #CCCCCC;
            font-size: 14px;
          }

          .oobee-item-url {
            font-size: 12px;
            color: #6b7280;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            direction: rtl;
            text-align: left;
          }

          .oobee-panel-extension .oobee-item-url {
            color: #CCCCCC;
            font-size: 14px;
          }

          .oobee-list-host {
            margin: 2px 0 12px;
            color: #CCCCCC;
            font-size: 14px;
            font-weight: 700;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .oobee-topbar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 40px;
            z-index: 2147483647;
            box-sizing: border-box;
            display: none;
            align-items: center;
            justify-content: space-between;
            gap: 0;
            padding: 0 24px;
            background: #9021A6;
            color: #ffffff;
            font: 600 16px/1.2 ${widgetFontFamily};
          }
          .oobee-topbar-brand,
          .oobee-topbar-drag-surface,
          .oobee-topbar-actions,
          .oobee-topbar-action {
            display: inline-flex;
            align-items: center;
          }
          .oobee-topbar-brand {
            min-width: 0;
            height: 100%;
            gap: 12px;
            cursor: grab;
            user-select: none;
            touch-action: none;
          }
          .oobee-topbar.is-dragging .oobee-topbar-brand {
            cursor: grabbing;
          }
          .oobee-topbar-drag-surface {
            flex: 1 1 auto;
            align-self: stretch;
            min-width: 24px;
            box-sizing: border-box;
            padding: 0 24px;
            cursor: grab;
            user-select: none;
            touch-action: none;
          }
          .oobee-topbar.is-dragging .oobee-topbar-drag-surface {
            cursor: grabbing;
          }
          .oobee-topbar-drag {
            width: 10px;
            height: 16px;
            flex: 0 0 auto;
            margin-right: 10px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }
          .oobee-topbar-drag svg {
            display: block;
          }
          .oobee-topbar-logo {
            width: 24px;
            height: 24px;
            border-radius: 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex: 0 0 auto;
            overflow: hidden;
            background: #ffffff;
            line-height: 0;
          }
          .oobee-topbar-logo svg {
            display: block;
          }
          .oobee-topbar-title {
            display: inline-flex;
            align-items: center;
            height: 100%;
            line-height: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .oobee-topbar-actions {
            height: 100%;
            gap: 16px;
            flex: 0 0 auto;
          }
          .oobee-topbar-action {
            border: 0;
            background: transparent;
            color: #ffffff;
            height: 100%;
            padding: 0 8px;
            gap: 8px;
            min-height: 0;
            border-radius: 4px;
            font: 400 16px/1.2 ${widgetFontFamily};
            cursor: pointer;
            transition: background-color .12s ease, box-shadow .12s ease;
          }
          .oobee-topbar-action:hover:not(:disabled):not(.oobee-topbar-action-static),
          .oobee-topbar-action:focus-visible:not(.oobee-topbar-action-static) {
            background: rgba(255, 255, 255, .16);
          }
          .oobee-topbar-action:focus-visible:not(.oobee-topbar-action-static) {
            outline: 2px solid rgba(255, 255, 255, .9);
            outline-offset: -2px;
            box-shadow: 0 0 0 1px rgba(144, 33, 166, .35);
          }
          .oobee-topbar-action:disabled {
            opacity: .58;
            cursor: not-allowed;
          }
          .oobee-topbar-action-static {
            opacity: .65;
            cursor: default;
          }
          .oobee-topbar-pages[aria-expanded="false"] {
            opacity: .88;
          }
          .oobee-dropdown-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transform: rotate(0deg);
            transition: transform .16s ease;
          }
          .oobee-topbar-pages[aria-expanded="false"] .oobee-dropdown-icon {
            transform: rotate(180deg);
          }
          .oobee-dropdown-icon svg {
            display: block;
          }
          .oobee-topbar-action .oobee-btn-icon {
            width: 16px;
            height: 16px;
          }
          .oobee-topbar-action .oobee-btn-icon svg {
            width: 16px;
            height: 16px;
          }
          .oobee-topbar-action .oobee-btn-text {
            display: inline-flex;
            align-items: center;
            height: 100%;
            font-size: 16px;
            font-weight: 400;
            line-height: 1;
          }
          .oobee-doc-icon {
            font-size: 12px;
          }
          .oobee-finalising {
            position: fixed;
            top: 40px;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 2147483646;
            display: grid;
            place-items: center;
            background: #333333;
            color: #f2f2f2;
            font: 14px/1.45 ${widgetFontFamily};
            text-align: center;
            padding: 24px;
            box-sizing: border-box;
          }
          .oobee-topbar-visible {
            display: flex;
          }
          .oobee-topbar-action svg path {
            fill: #ffffff;
          }
          .oobee-finalising-card {
            display: grid;
            gap: 14px;
            justify-items: center;
          }
          .oobee-finalising-title {
            margin: 0;
            font-weight: 500;
          }
          .oobee-finalising-body {
            margin: 0;
          }

          .oobee-minbtn__icon {
            transition: transform .18s ease;
            transform: rotate(0deg);
          }
          .oobee-minbtn__icon.is-left {
            transform: rotate(180deg);
          }

          :host-context(.oobee-snap) .oobee-panel,
          :host-context(.oobee-snap) .oobee-minbtn { display:none !important; }

          @media (max-width:1024px) {
            .oobee-panel {
              width:280px
            }
          }
          @media (max-width:768px) {
            .oobee-panel {
              width: 92vw;
              height: 100vh;
              top: 0;
              bottom: 0;
              border-radius: 0;
            }
            .oobee-panel.collapsed {
              width: auto;
              height: auto;
              padding: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              border-radius: 999px;
              box-shadow: 0 6px 24px rgba(0,0,0,.4);
              top: auto;
              bottom: max(16px, env(safe-area-inset-bottom,0px))
            }
          }
        `);

        document.documentElement.classList.remove('oobee-snap');
        const shadowHost = document.createElement('div');
        shadowHost.id = 'oobeeShadowHost';
        const shadowRoot = shadowHost.attachShadow({ mode: 'open' });

        shadowRoot.adoptedStyleSheets = [sheet];

        if (useExtensionUi && topbar) {
          shadowRoot.appendChild(topbar);
          setExtensionLayout(getStoredToolbarY(), false);
          setPagesPanelHidden(safeLocalGet('oobee:extension-pages-hidden') === '1');
        }
        shadowRoot.appendChild(panel);
        // The minimize button is hidden in extension mode via CSS; keep it out
        // of the shadow tree entirely so it isn't paying rendering cost.
        if (!useExtensionUi) {
          shadowRoot.appendChild(minBtn);
        }

        function setDraggableSidebarMenu() {
          const icon = minBtn.querySelector<SVGElement>('.oobee-minbtn__icon');
          if (!icon) return;

          const closed = isCollapsed();
          const arrowPointsRight =
            (currentPos === 'RIGHT' && !closed) || (currentPos === 'LEFT' && closed);

          icon.classList.toggle('is-left', !arrowPointsRight);
          minBtn.setAttribute('aria-label', closed ? 'Expand panel' : 'Collapse panel');
        }

        function positionMinimizeBtn() {
          const OPEN_OFFSET = 318;
          const COLLAPSED_OFFSET = 55;
          const offset = isCollapsed() ? COLLAPSED_OFFSET : OPEN_OFFSET;

          minBtn.style.left = '';
          minBtn.style.right = '';

          if (currentPos === 'RIGHT') {
            minBtn.style.right = `${offset}px`;
          } else {
            minBtn.style.left = `${offset}px`;
          }
        }
        positionMinimizeBtn();
        setDraggableSidebarMenu();

        minBtn.addEventListener('click', () => toggleCollapsed());

        let startX = 0;
        const THRESH = 40;

        grip.addEventListener('pointerdown', (e: PointerEvent) => {
          startX = e.clientX;
          grip.setPointerCapture(e.pointerId); // <-- use the button
        });

        grip.addEventListener('pointermove', (e: PointerEvent) => {
          if (!grip.hasPointerCapture?.(e.pointerId)) return; // <-- check the button
          const dx = e.clientX - startX;
          if (Math.abs(dx) >= THRESH) {
            const nextPos: 'LEFT' | 'RIGHT' = dx < 0 ? 'LEFT' : 'RIGHT';
            if (nextPos !== currentPos) {
              currentPos = nextPos;
              setPosClass(currentPos);
              window.updateMenuPos?.(currentPos);
            }
            startX = e.clientX;
          }
        });

        grip.addEventListener('pointerup', (e: PointerEvent) => {
          try {
            grip.releasePointerCapture(e.pointerId);
          } catch {}
        });

        const stopDialog = document.createElement('dialog');
        stopDialog.id = 'oobeeStopDialog';
        stopDialog.setAttribute('aria-labelledby', 'oobee-stop-title');
        Object.assign(stopDialog.style, {
          width: useExtensionUi ? 'min(480px, calc(100vw - 32px))' : 'min(560px, calc(100vw - 32px))',
          border: 'none',
          padding: '0',
          borderRadius: useExtensionUi ? '4px' : '16px',
          overflow: 'hidden',
          boxShadow: useExtensionUi ? 'none' : '0 10px 40px rgba(0,0,0,.35)',
          fontFamily: widgetFontFamily,
          background: useExtensionUi ? '#333333' : '#ffffff',
          color: useExtensionUi ? '#ffffff' : '#111111',
        });
        const dialogSheet = new CSSStyleSheet();
        dialogSheet.replaceSync(`
          #oobeeStopDialog::backdrop {
            background: ${useExtensionUi ? 'rgba(0,0,0,.62)' : 'rgba(0,0,0,.55)'};
          }

          /* primary button hover/focus */
          .oobee-stop-primary:hover {
            filter: brightness(0.95);
          }
          .oobee-stop-primary:focus-visible {
            outline: 2px solid #7b4dff; outline-offset: 2px;
          }

          /* cancel link hover */
          .oobee-stop-cancel {
            color: ${useExtensionUi ? '#c681ef' : '#9021A6'};
            text-decoration: underline;
          }
          .oobee-stop-cancel:hover {
            filter: brightness(0.95);
          }

          /* close “X” hover ring */
          .oobee-stop-close:hover {
            background: ${useExtensionUi ? 'rgba(255,255,255,.1)' : '#f3f4f6'};
          }
        `);
        shadowRoot.adoptedStyleSheets = [sheet, dialogSheet];

        const head = document.createElement('div');
        Object.assign(head.style, {
          padding: useExtensionUi ? '24px 24px 8px 24px' : '20px 20px 8px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
        });

        const title = document.createElement('h2');
        title.id = 'oobee-stop-title';
        title.textContent = 'Are you sure you want to stop this scan?';
        Object.assign(title.style, {
          margin: '0',
          fontSize: useExtensionUi ? '20px' : '22px',
          fontWeight: '700',
          lineHeight: '1.25',
          color: useExtensionUi ? '#ffffff' : '#111111',
        });

        const closeX = document.createElement('button');
        closeX.type = 'button';
        closeX.setAttribute('aria-label', 'Close');
        closeX.textContent = '×';
        closeX.className = 'oobee-stop-close';
        Object.assign(closeX.style, {
          border: 'none',
          background: 'transparent',
          fontSize: '28px',
          lineHeight: '1',
          cursor: 'pointer',
          color: useExtensionUi ? '#f5f5f5' : '#4b5563',
          width: '36px',
          height: '36px',
          borderRadius: '12px',
          display: 'grid',
          placeItems: 'center',
        });
        head.appendChild(title);
        head.appendChild(closeX);

        const bodyWrap = document.createElement('div');
        Object.assign(bodyWrap.style, {
          padding: useExtensionUi ? '8px 24px 24px 24px' : '12px 20px 20px 20px',
        });

        const form = document.createElement('form');
        form.noValidate = true;
        form.autocomplete = 'off';
        Object.assign(form.style, {
          display: 'grid',
          gridTemplateColumns: '1fr',
          rowGap: '12px',
        });

        const label = document.createElement('label');
        label.setAttribute('for', 'oobeeStopInput');
        label.textContent = 'Enter a name for this scan';
        Object.assign(label.style, {
          fontSize: useExtensionUi ? '14px' : '15px',
          fontWeight: '600',
          color: useExtensionUi ? '#ffffff' : '#111111',
        });

        const input = document.createElement('input');
        input.id = 'oobeeStopInput';
        input.type = 'text';
        Object.assign(input.style, {
          width: '100%',
          borderRadius: '5px',
          border: useExtensionUi ? '1px solid #555555' : '1px solid #e5e7eb',
          padding: useExtensionUi ? '10px 12px' : '12px 14px',
          fontSize: '14px',
          outline: 'none',
          boxSizing: 'border-box',
          background: useExtensionUi ? '#242424' : '#ffffff',
          color: useExtensionUi ? '#ffffff' : '#111111',
        });
        input.addEventListener('focus', () => {
          input.style.borderColor = useExtensionUi ? '#c681ef' : '#7b4dff';
          input.style.boxShadow = useExtensionUi ? 'none' : '0 0 0 3px rgba(123,77,255,.25)';
        });
        input.addEventListener('blur', () => {
          input.style.borderColor = useExtensionUi ? '#555555' : '#e5e7eb';
          input.style.boxShadow = 'none';
        });

        const actions = document.createElement('div');
        Object.assign(actions.style, {
          display: 'grid',
          gap: useExtensionUi ? '10px' : '12px',
          marginTop: useExtensionUi ? '8px' : '4px',
        });

        const primary = document.createElement('button');
        primary.type = 'submit';
        primary.textContent = useExtensionUi ? 'End scan' : 'Stop scan';
        primary.className = 'oobee-stop-primary';
        Object.assign(primary.style, {
          border: 'none',
          borderRadius: '999px',
          padding: useExtensionUi ? '10px 16px' : '12px 16px',
          fontSize: '15px',
          fontWeight: '600',
          color: useExtensionUi ? '#111111' : '#fff',
          background: useExtensionUi ? '#c681ef' : '#9021A6',
          cursor: 'pointer',
        });

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'No, continue scan';
        cancel.className = 'oobee-stop-cancel';
        Object.assign(cancel.style, {
          border: 'none',
          background: 'transparent',
          fontSize: '14px',
          justifySelf: 'center',
          cursor: 'pointer',
          padding: '6px',
        });

        actions.appendChild(primary);
        actions.appendChild(cancel);
        const shouldHideInput = !!(vars?.opts && vars.opts.hideStopInput);
        if (!shouldHideInput) {
          form.appendChild(label);
          form.appendChild(input);
        }
        form.appendChild(actions);
        bodyWrap.appendChild(form);

        stopDialog.appendChild(head);
        stopDialog.appendChild(bodyWrap);
        shadowRoot.appendChild(stopDialog);

        let stopResolver: null | ((v: { confirmed: boolean; label: string }) => void) = null;
        const hideStop = () => {
          try {
            stopDialog.close();
          } catch {}
          stopResolver = null;
        };
        const showStop = () => {
          if (!shouldHideInput) input.value = '';
          try {
            stopDialog.showModal();
          } catch {}
          if (!shouldHideInput) {
            requestAnimationFrame(() => {
              try {
                input.focus({ preventScroll: true });
                input.select();
              } catch {}
            });
          }
        };
        form.addEventListener('submit', e => {
          e.preventDefault();
          const v = (input.value || '').trim();
          if (stopResolver) stopResolver({ confirmed: true, label: v });
          hideStop();
        });
        closeX.addEventListener('click', () => {
          if (stopResolver) stopResolver({ confirmed: false, label: '' });
          hideStop();
        });
        cancel.addEventListener('click', () => {
          if (stopResolver) stopResolver({ confirmed: false, label: '' });
          hideStop();
        });
        stopDialog.addEventListener('cancel', e => {
          e.preventDefault();
          if (stopResolver) stopResolver({ confirmed: false, label: '' });
          hideStop();
        });
        (customWindow as Window).oobeeShowStopModal = () =>
          new Promise<{ confirmed: boolean; label: string }>(resolve => {
            stopResolver = resolve;
            showStop();
          });
        (customWindow as Window).oobeeHideStopModal = hideStop;
        if (useExtensionUi) {
          customWindow.oobeeShowFinalising = () => {
            if (shadowRoot.querySelector('.oobee-finalising')) return;
            panel.remove();
            minBtn.remove();
            const finalising = document.createElement('div');
            finalising.className = 'oobee-finalising';
            finalising.setAttribute('role', 'status');
            finalising.setAttribute('aria-live', 'polite');
            finalising.innerHTML = `
              <div class="oobee-finalising-card">
                <p class="oobee-finalising-title">Finalising headed scan report...</p>
                <p class="oobee-finalising-body">Head back to VS Code Oobee dev suite extension to view the scan results.</p>
              </div>
            `;
            shadowRoot.appendChild(finalising);
            setExtensionLayout(getCurrentToolbarY(), false);
          };
        }

        if (document.body) {
          document.body.appendChild(shadowHost);
        } else if (document.head) {
          // The <head> element exists
          // Append the variable below the head
          document.head.insertAdjacentElement('afterend', shadowHost);
        } else {
          // Neither <body> nor <head> nor <html> exists
          // Append the variable to the document
          document.documentElement.appendChild(shadowHost);
        }
        positionMinimizeBtn();
        setDraggableSidebarMenu();
      },
      {
        menuPos,
        MENU_POSITION,
        urlsCrawled,
        opts: {
          ...opts,
          extensionOverlayUi: getUseExtensionOverlayUi(opts.extensionOverlayUi),
          sessionOrigin: getExtensionSessionOrigin(opts.sessionOrigin),
          fontFamily: EXTENSION_WIDGET_FONT_FAMILY,
          vscodeIconSvg: EXTENSION_VSCODE_ICON_SVG,
        },
      },
    )
    .then(() => {
      log('Overlay menu: successfully added');
    })
    .catch(error => {
      consoleLogger.error('Overlay menu: failed to add', error);
      throw error;
    });
};

export const removeOverlayMenu = async page => {
  await page
    .evaluate(() => {
      const existingOverlay = document.querySelector('#oobeeShadowHost');
      if (existingOverlay) {
        existingOverlay.remove();
        return true;
      }
      return false;
    })
    .then(removed => {
      if (removed) {
        consoleLogger.info('Overlay Menu: successfully removed');
      }
    });
};

export const initNewPage = async (page, pageClosePromises, processPageParams, pagesDict) => {
  let menuPos = MENU_POSITION.right;
  let overlayRefreshSeq = 0;
  let overlayRefreshChain = Promise.resolve();

  // eslint-disable-next-line no-underscore-dangle
  const pageId = page._guid;

  page.on('dialog', async dialog => {
    try {
      await dialog.dismiss();
    } catch {
      // dialog may already be closed
    }
  });

  const pageClosePromise = new Promise(resolve => {
    page.on('close', () => {
      log(`Page: close detected: ${page.url()}`);
      delete pagesDict[pageId];
      resolve(true);
    });
  });
  pageClosePromises.push(pageClosePromise);

  if (!pagesDict[pageId]) {
    pagesDict[pageId] = {
      page,
      isScanning: false,
      collapsed: false,
    };
  }

  const reconcileOverlayMenu = async (trigger: string) => {
    // Mark this as the latest refresh so older ones can stop.
    const refreshSeq = ++overlayRefreshSeq;

    // Serialize overlay updates so multiple navigation events do not add/remove concurrently.
    overlayRefreshChain = overlayRefreshChain
      .catch(() => {})
      .then(async () => {
        if (refreshSeq !== overlayRefreshSeq || page.isClosed()) return;

        // Skip overlay work on schemes we can't inject into — about:blank (no origin,
        // blocks localStorage), chrome://new-tab-page and chrome-error:// (Trusted
        // Types policy blocks innerHTML), devtools://, view-source://, chrome-extension://,
        // etc. The overlay cannot inject on any of these and the attempt produces
        // noisy errors on every new tab / failed navigation. Allow http(s) and file://
        // (used for local-file scans). Subsequent triggers will reconcile the overlay
        // once the tab navigates to a supported scheme.
        const currentUrl = page.url();
        const isInjectable =
          currentUrl.startsWith('http://') ||
          currentUrl.startsWith('https://') ||
          currentUrl.startsWith('file://');
        if (!isInjectable) return;

        // During an active scan, navigation events (framenavigated/domcontentloaded) can fire
        // due to axe-core injection or page resource loading. In CDP mode, concurrent
        // page.evaluate() calls conflict with the running scan. Skip overlay injection
        // for non-scan triggers while scanning — the overlay will be re-added by the
        // 'scan-click' trigger after the scan completes.
        if (pagesDict[pageId]?.isScanning && trigger !== 'scan-click') return;

        try {
          // `framenavigated` can fire before the new document is ready for DOM inspection/injection.
          // Use a short timeout — in CDP mode, waitForLoadState can hang after script injection.
          await page.waitForLoadState('domcontentloaded', { timeout: 2000 });
        } catch {
          // Best effort only. The page may still be mid-navigation or state tracking confused.
        }

        try {
          // Give fast redirect chains a brief chance to advance before we inject/remove the overlay.
          await page.waitForTimeout(300);
        } catch {
          // Best effort only. The page may already be closing.
        }

        // Re-check staleness after waiting because a newer navigation may have happened meanwhile.
        if (refreshSeq !== overlayRefreshSeq || page.isClosed()) return;

        const overlayScope = getOverlayScope(processPageParams.overlayScope);
        const allowed = isOverlayAllowed(page.url(), processPageParams.entryUrl, overlayScope);

        if (!allowed) {
          // Restrictive overlay scopes intentionally hide the overlay once users
          // leave the configured URL boundary, while the default CLI keeps the
          // historical desktop fallback below.
          if (overlayScope !== 'all') {
            await raceWithTimeout(
              removeOverlayMenu(page),
              OVERLAY_OPERATION_TIMEOUT_MS,
              'removeOverlayMenu',
            ).catch(() => {});
            return;
          }

          // On macOS and Windows the custom flow always runs headful.
          // The URL guard (urlGuard.ts) intercepts non-http/https navigations
          // and calls page.goto(safeUrl). Do NOT remove the overlay here —
          // removing it causes it to stay permanently disabled if the redirect
          // races ahead of the next reconcile cycle.
          // Instead, fall through to the hasOverlay / addOverlayMenu block so
          // the overlay is (re-)injected even on transient non-http/https URLs
          // (e.g. file://, about:blank) and again after the guard's redirect.
          const isDesktopHost = process.platform === 'darwin' || process.platform === 'win32';
          if (!isDesktopHost) {
            // On Linux / Docker: remove overlay for non-http/https URLs and stop.
            await raceWithTimeout(
              removeOverlayMenu(page),
              OVERLAY_OPERATION_TIMEOUT_MS,
              'removeOverlayMenu',
            ).catch(() => {});
            return;
          }
          // Desktop hosts: skip removal and fall through to re-add overlay.
        }

        const hasOverlay = await page.evaluate(() =>
          Boolean(document.querySelector('#oobeeShadowHost')),
        );

        consoleLogger.info(`Overlay state (${trigger}): ${hasOverlay}`);

        if (!hasOverlay) {
          // Recreate the overlay after allowed redirects while preserving current UI state.
          consoleLogger.info(`Adding overlay menu to page (${trigger}): ${page.url()}`);
          await raceWithTimeout(
            addOverlayMenu(page, processPageParams.urlsCrawled, menuPos, {
              inProgress: !!pagesDict[pageId]?.isScanning,
              collapsed: !!pagesDict[pageId]?.collapsed,
              hideStopInput: !!processPageParams.customFlowLabel,
              entryUrl: processPageParams.entryUrl,
              maxPagesToScan: processPageParams.maxPagesToScan,
              extensionOverlayUi: processPageParams.useExtensionOverlayUi,
              sessionOrigin: processPageParams.extensionSessionOrigin,
            }),
            OVERLAY_OPERATION_TIMEOUT_MS,
            'addOverlayMenu',
          );
        }
      })
      .catch(() => {
        consoleLogger.info('Error in adding overlay menu to page');
      });

    await overlayRefreshChain;
  };

  type handleOnScanClickFunction = () => void;

  const isScanLimitReached = () => {
    const maxPagesToScan = processPageParams.maxPagesToScan;
    return (
      typeof maxPagesToScan === 'number' &&
      Number.isFinite(maxPagesToScan) &&
      maxPagesToScan > 0 &&
      processPageParams.urlsCrawled.scanned.length >= maxPagesToScan
    );
  };

  // Window functions exposed in browser
  const handleOnScanClick: handleOnScanClickFunction = async () => {
    consoleLogger.info('Scan: click detected');
    log('Scan: click detected');
    try {
      if (isScanLimitReached()) {
        log('Scan ignored because the page limit has been reached');
        if (!page.isClosed()) {
          await reconcileOverlayMenu('scan-limit');
        }
        return;
      }

      pagesDict[pageId].isScanning = true;
      await removeOverlayMenu(page);
      await processPage(page, processPageParams);
      log('Scan: success');
      pagesDict[pageId].isScanning = false;

      if (page.isClosed()) return;
      await reconcileOverlayMenu('scan-click');

      // If the overlay still isn't present after the first attempt (can happen in
      // CDP mode where waitForLoadState tracking is unreliable), retry once.
      if (!page.isClosed()) {
        const overlayPresent = await page.evaluate(() =>
          Boolean(document.querySelector('#oobeeShadowHost')),
        ).catch(() => false);
        if (!overlayPresent) {
          log('Overlay missing after scan-click reconcile, retrying...');
          await reconcileOverlayMenu('scan-click');
        }
      }
    } catch (error) {
      log(`Scan failed ${error}`);
    }
  };

  const showFinalisingBeforeClose = async () => {
    if (!getUseExtensionOverlayUi(processPageParams.useExtensionOverlayUi)) return;
    await page.evaluate(() => {
      const win = window as Window;
      win.oobeeShowFinalising?.();
    }).catch(() => {});
    await sleep(EXTENSION_FINALISING_DISPLAY_MS);
  };

  const handleOnStopClick = async () => {
    const scannedCount = processPageParams?.urlsCrawled?.scanned?.length ?? 0;
    if (scannedCount === 0) {
      // Skip finalising banner — no report will be generated.
      if (typeof processPageParams.stopAll === 'function') {
        try {
          await processPageParams.stopAll();
        } catch (e) {
          // ignore invalid; continue without label
        }
      }
      return;
    }

    try {
      const inputValue = await page.evaluate(async () => {
        const win = window as Window;
        if (typeof win.oobeeShowStopModal === 'function') {
          return await win.oobeeShowStopModal();
        }
        const ok = window.confirm('Are you sure you want to stop this scan?');
        return { confirmed: ok, label: '' };
      });

      if (!inputValue?.confirmed) {
        await page.evaluate(() => {
          const endScanBtn = document.getElementById('oobeeBtnEndScan') as HTMLButtonElement | null;
          if (endScanBtn) {
            endScanBtn.disabled = false;
            endScanBtn.textContent = 'Stop';
          }
        });
        return;
      }

      await showFinalisingBeforeClose();

      const label = (inputValue.label || '').trim();
      try {
        const { isValid } = validateCustomFlowLabel(label);
        if (isValid && label) {
          processPageParams.customFlowLabel = label;
        }
      } catch {
        // ignore invalid; continue without label
      }

      if (typeof processPageParams.stopAll === 'function') {
        try {
          await processPageParams.stopAll();
        } catch (e) {
          // any console log will be on user browser, do not need to log
        }
      }
    } catch (e) {
      // any console log will be on user browser, do not need to log
    }
  };

  page.on('domcontentloaded', async () => {
    if (page.isClosed()) return;
    await reconcileOverlayMenu('domcontentloaded');

    if (isCypressTest) {
      try {
        await handleOnScanClick();
        page.close();
      } catch {
        consoleLogger.info(
          `Error in calling handleOnScanClick, isCypressTest: ${isCypressTest}`,
        );
      }
    }
  });

  page.on('framenavigated', async (frame: any) => {
    if (frame !== page.mainFrame() || page.isClosed()) return;
    await reconcileOverlayMenu('framenavigated');
  });

  try {
    if (page.isClosed()) return page;
    await page.exposeFunction('handleOnScanClick', handleOnScanClick);
    await page.exposeFunction('handleOnStopClick', handleOnStopClick);

    type UpdateMenuPosFunction = (newPos: any) => void;

    // Define the updateMenuPos function
    const updateMenuPos: UpdateMenuPosFunction = newPos => {
      const prevPos = menuPos;
      if (prevPos !== newPos) {
        menuPos = newPos;
      }
    };
    await page.exposeFunction('updateMenuPos', updateMenuPos);
  } catch (e) {
    log(`Error exposing functions on page: ${e}`);
  }

  await reconcileOverlayMenu('init');

  return page;
};
