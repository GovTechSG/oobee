/* eslint-disable no-shadow */
/* eslint-disable no-alert */
/* eslint-disable no-param-reassign */
/* eslint-env browser */
import path from 'path';
import { runAxeScript } from '../commonCrawlerFunc.js';
import { consoleLogger, guiInfoLog, silentLogger } from '../../logs.js';
import { guiInfoStatusTypes } from '../../constants/constants.js';
import { isSkippedUrl, validateCustomFlowLabel } from '../../constants/common.js';

declare global {
  interface Window {
    handleOnScanClick?: () => Promise<void> | void;
    handleOnStopClick?: () => Promise<void> | void;
    oobeeSetCollapsed?: (val: boolean) => void;
    oobeeShowStopModal?: () => Promise<{ confirmed: boolean; label: string }>;
    oobeeHideStopModal?: () => void;
    updateMenuPos?: (pos: 'LEFT' | 'RIGHT') => void;
  }
}

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

      const isLoadMoreContent = async () =>
        new Promise(resolve => {
          setTimeout(async () => {
            await page.waitForLoadState('domcontentloaded');

            const newHeight = await page.evaluate(
              // eslint-disable-next-line no-shadow
              () => document.body.scrollHeight,
            );
            const result = newHeight > prevHeight;

            resolve(result);
          }, 2500);
        });

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
};

export const updateMenu = async (page, urlsCrawled) => {
  log(`Overlay menu: updating: ${page.url()}`);
  await page.evaluate(
    vars => {
      const shadowHost = document.querySelector('#oobee-shadow-host');
      if (shadowHost) {
        const p = shadowHost.shadowRoot.querySelector('#oobee-p-pages-scanned');
        if (p) {
          p.textContent = `Pages Scanned: ${vars.urlsCrawled.scanned.length || 0}`;
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
  await page.waitForLoadState('domcontentloaded');
  consoleLogger.info(`Overlay menu: adding to ${menuPos}...`);

  // Add the overlay menu with initial styling
  return page
    .evaluate(
      async vars => {
        const customWindow: Window = window as unknown as Window;
        const inProgress = !!(vars?.opts && vars.opts.inProgress);
        const collapsedOption = !!(vars?.opts && vars.opts.collapsed);

        const panel = document.createElement('aside');
        panel.className = 'oobee-panel';

        const minBtn = document.createElement('button');
        minBtn.type = 'button';
        minBtn.className = 'oobee-minbtn';
        minBtn.setAttribute('aria-label', 'Minimize/expand panel');

        const MINBTN_SVG = `
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
        minBtn.innerHTML = MINBTN_SVG;

        let currentPos: 'LEFT' | 'RIGHT' = (vars.menuPos || 'RIGHT');
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
          const willCollapse = (typeof force === 'boolean') ? force : !isCollapsed();
          if (willCollapse) {
            panel.classList.add('collapsed');
            localStorage.setItem('oobee:overlay-collapsed', '1');
            customWindow.oobeeSetCollapsed?.(true);
          } else {
            panel.classList.remove('collapsed');
            localStorage.setItem('oobee:overlay-collapsed', '0');
            customWindow.oobeeSetCollapsed?.(false);
          }
          positionMinimizeBtn();
          setDraggableSidebarMenu();
        };

        setPosClass(currentPos);
        const persisted = localStorage.getItem('oobee:overlay-collapsed');
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
        h2.textContent = 'Pages Scanned';

        const scanBtn = document.createElement('button');
        scanBtn.id = 'oobeeBtnScan';
        scanBtn.className = 'oobee-btn oobee-btn-primary';
        scanBtn.innerText = 'Scan this page';
        scanBtn.disabled = inProgress;
        scanBtn.addEventListener('click', async () => customWindow.handleOnScanClick?.());

        const stopBtn = document.createElement('button');
        stopBtn.id = 'oobeeBtnStop';
        stopBtn.className = 'oobee-btn oobee-btn-secondary';
        stopBtn.innerText = 'Stop scan';
        stopBtn.addEventListener('click', async () => customWindow.handleOnStopClick?.());

        const btnGroup = document.createElement('div');
        btnGroup.className = 'oobee-actions';
        btnGroup.appendChild(scanBtn);
        btnGroup.appendChild(stopBtn);

        const listWrap = document.createElement('div');
        listWrap.id = 'oobeeList';
        listWrap.className = 'oobee-list';

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

          scanned.forEach((item) => {
            const li = document.createElement('li');
            li.className = 'oobee-li';

            const title = document.createElement('div');
            title.className = 'oobee-item-title';
            title.textContent = (item.pageTitle && item.pageTitle.trim()) ? item.pageTitle : item.url;

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
            width: 56px;
            overflow: hidden
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

          .oobee-header {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: space-between;
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

          /* Primary (filled) */
          .oobee-btn-primary {
            background: #9021a6;
            color: #fff;
            border: 1px solid transparent;
          }
          .oobee-btn-primary:hover:not(:disabled) {
            box-shadow:0 2px 10px rgba(0,0,0,.12);
          }
          .oobee-btn-primary:active:not(:disabled) {
            transform:translateY(1px);
          }
          .oobee-btn-primary:focus-visible {
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

          .oobee-list {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding-left: 1rem;
            padding-right: 1rem;
            padding-bottom: 1rem;
            padding-top: 0;
          }

          .oobee-panel.collapsed .oobee-list {
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

          .oobee-panel.collapsed .oobee-section-title {
            display: none;
          }

          .oobee-ol {
            margin: 0;
            padding-left: 1.25rem;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          .oobee-li {
            list-style: decimal;
            font-size: 14px;
          }

          .oobee-item-title {
            font-size: 14px;
            color: #161616;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
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

        shadowRoot.appendChild(panel);
        shadowRoot.appendChild(minBtn);

        function setDraggableSidebarMenu() {
          const icon = minBtn.querySelector<SVGElement>('.oobee-minbtn__icon');
          if (!icon) return;

          const closed = isCollapsed();
          const arrowPointsRight =
            (currentPos === 'RIGHT' && !closed) ||
            (currentPos === 'LEFT'  &&  closed);

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
          grip.setPointerCapture(e.pointerId);       // <-- use the button
        });

        grip.addEventListener('pointermove', (e: PointerEvent) => {
          if (!grip.hasPointerCapture?.(e.pointerId)) return;  // <-- check the button
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
          try { grip.releasePointerCapture(e.pointerId); } catch {}
        });

        const stopDialog = document.createElement('dialog');
        stopDialog.id = 'oobeeStopDialog';
        Object.assign(stopDialog.style, {
          width: 'min(560px, calc(100vw - 32px))',
          border: 'none',
          padding: '0',
          borderRadius: '16px',
          overflow: 'hidden',
          boxShadow: '0 10px 40px rgba(0,0,0,.35)',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
        });
        const dialogSheet = new CSSStyleSheet();
        dialogSheet.replaceSync(`
          #oobeeStopDialog::backdrop {
            background: rgba(0,0,0,.55);
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
            color: #9021A6;
            text-decoration: underline;
          }
          .oobee-stop-cancel:hover {
            filter: brightness(0.95);
          }

          /* close “X” hover ring */
          .oobee-stop-close:hover {
            background: #f3f4f6;
          }
        `);
        shadowRoot.adoptedStyleSheets = [sheet, dialogSheet];

        const head = document.createElement('div');
        Object.assign(head.style, {
          padding: '20px 20px 8px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px'
        });

        const title = document.createElement('h2');
        title.id = 'oobee-stop-title';
        title.textContent = 'Are you sure you want to stop this scan?';
        Object.assign(title.style, { margin: '0', fontSize: '22px', fontWeight: '700', lineHeight: '1.25' });

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
          color: '#4b5563',
          width: '36px',
          height: '36px',
          borderRadius: '12px',
          display: 'grid',
          placeItems: 'center'
        });
        head.appendChild(title);
        head.appendChild(closeX);

        const bodyWrap = document.createElement('div');
        Object.assign(bodyWrap.style, {
          padding: '12px 20px 20px 20px'
        });

        const form = document.createElement('form');
        form.noValidate = true;
        form.autocomplete = 'off';
        Object.assign(form.style, {
          display: 'grid',
          gridTemplateColumns: '1fr',
          rowGap: '12px'
        });

        const label = document.createElement('label');
        label.setAttribute('for', 'oobee-stop-input');
        label.textContent = 'Enter a name for this scan';
        Object.assign(label.style, { fontSize: '15px', fontWeight: '600' });

        const input = document.createElement('input');
        input.id = 'oobeeStopInput';
        input.type = 'text';
        Object.assign(input.style, {
          width: '100%',
          borderRadius: '5px',
          border: '1px solid #e5e7eb',
          padding: '12px 14px',
          fontSize: '14px',
          outline: 'none',
          boxSizing: 'border-box'
        });
        input.addEventListener('focus', () => {
          input.style.borderColor = '#7b4dff';
          input.style.boxShadow = '0 0 0 3px rgba(123,77,255,.25)';
        });
        input.addEventListener('blur', () => {
          input.style.borderColor = '#e5e7eb';
          input.style.boxShadow = 'none';
        });

        const actions = document.createElement('div');
        Object.assign(actions.style, { display: 'grid', gap: '12px', marginTop: '4px' });

        const primary = document.createElement('button');
        primary.type = 'submit';
        primary.textContent = 'Stop scan';
        primary.className = 'oobee-stop-primary';
        Object.assign(primary.style, {
          border: 'none',
          borderRadius: '999px',
          padding: '12px 16px',
          fontSize: '15px',
          fontWeight: '600',
          color: '#fff',
          background: '#9021A6',
          cursor: 'pointer'
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
          padding: '6px'
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
        const hideStop = () => { try { stopDialog.close(); } catch {} stopResolver = null; };
        const showStop = () => {
          if (!shouldHideInput) input.value = '';
          try { stopDialog.showModal(); } catch {}
          if (!shouldHideInput) {
            requestAnimationFrame(() => {
              try { input.focus({ preventScroll: true }); input.select(); } catch {}
            });
          }
        };
        form.addEventListener('submit', (e) => {
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
        stopDialog.addEventListener('cancel', (e) => {
          e.preventDefault();
          if (stopResolver) stopResolver({ confirmed: false, label: '' });
          hideStop();
        });
        (customWindow as Window).oobeeShowStopModal = () =>
          new Promise<{ confirmed: boolean; label: string }>((resolve) => {
            stopResolver = resolve;
            showStop();
          });
        (customWindow as Window).oobeeHideStopModal = hideStop;

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
      { menuPos, MENU_POSITION, urlsCrawled, opts },
    )
    .then(() => {
      log('Overlay menu: successfully added');
    })
    .catch(error => {
      error('Overlay menu: failed to add', error);
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

  // eslint-disable-next-line no-underscore-dangle
  const pageId = page._guid;

  page.on('dialog', () => { });

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

  type handleOnScanClickFunction = () => void;

  // Window functions exposed in browser
  const handleOnScanClick: handleOnScanClickFunction = async () => {
    consoleLogger.info('Scan: click detected');
    log('Scan: click detected');
    try {
      pagesDict[pageId].isScanning = true;
      await removeOverlayMenu(page);
      await processPage(page, processPageParams);
      log('Scan: success');
      pagesDict[pageId].isScanning = false;
       await addOverlayMenu(page, processPageParams.urlsCrawled, menuPos, {
         inProgress: false,
         collapsed: !!pagesDict[pageId]?.collapsed,
         hideStopInput: !!processPageParams.customFlowLabel,
       });
    } catch (error) {
      log(`Scan failed ${error}`);
    }
  };

  const handleOnStopClick = async () => {
    const scannedCount = processPageParams?.urlsCrawled?.scanned?.length ?? 0;
    if (scannedCount === 0) {
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
          const stopBtn = document.getElementById('oobeeBtnStop') as HTMLButtonElement | null;
          if (stopBtn) {
            stopBtn.disabled = false;
            stopBtn.textContent = 'Stop';
          }
        });
        return;
      }

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
    try {
      const existingOverlay = await page.evaluate(() => {
        return document.querySelector('#oobeeShadowHost');
      });

      consoleLogger.info(`Overlay state: ${existingOverlay}`);

      if (!existingOverlay) {
        consoleLogger.info(`Adding overlay menu to page: ${page.url()}`);
        await addOverlayMenu(page, processPageParams.urlsCrawled, menuPos, {
          inProgress: !!pagesDict[pageId]?.isScanning,
          collapsed: !!pagesDict[pageId]?.collapsed,
          hideStopInput: !!processPageParams.customFlowLabel,
        });
      }

      setTimeout(() => {
        // Timeout here to slow things down a little
      }, 1000);

      //! For Cypress Test
      // Auto-clicks 'Scan this page' button only once
      if (isCypressTest) {
        try {
          await handleOnScanClick();
          page.close();
        } catch {
          consoleLogger.info(`Error in calling handleOnScanClick, isCypressTest: ${isCypressTest}`);
        }
      }

      consoleLogger.info(`Overlay state: ${existingOverlay}`);
    } catch {
      consoleLogger.info('Error in adding overlay menu to page');
      consoleLogger.info('Error in adding overlay menu to page');
    }
  });

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

  return page;
};
