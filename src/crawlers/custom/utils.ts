/* eslint-disable no-shadow */
/* eslint-disable no-alert */
/* eslint-disable no-param-reassign */
/* eslint-env browser */
import path from 'path';
import { runAxeScript } from '../commonCrawlerFunc.js';
import { consoleLogger, guiInfoLog, silentLogger } from '../../logs.js';
import { guiInfoStatusTypes } from '../../constants/constants.js';
import { isSkippedUrl } from '../../constants/common.js';

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

  urlsCrawled.scanned.push({
    url: page.url(),
    pageTitle: result.pageTitle,
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
  top: 'TOP',
  bottom: 'BOTTOM',
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

export const addOverlayMenu = async (page, urlsCrawled, menuPos) => {
  await page.waitForLoadState('domcontentloaded');
  consoleLogger.info(`Overlay menu: adding to ${menuPos}...`);
  interface CustomWindow extends Window {
    updateMenuPos: (newPos: any) => void;
    handleOnScanClick: () => void;
  }

  // Add the overlay menu with initial styling
  return page
    .evaluate(
      async vars => {
        const menu = document.createElement('div');
        menu.className = 'oobee-menu';
        if (vars.menuPos === vars.MENU_POSITION.top) {
          menu.style.top = '0';
        } else {
          menu.style.bottom = '0';
        }
        let isDragging = false;
        let initialY;
        let offsetY;

        menu.addEventListener('mousedown', e => {
          // The EvenTarget Object is the grandfather interface for Element
          // In order to get the tagName of the item you would need polymorph it into Element
          const targetElement: Element = e.target as Element;
          if (targetElement.tagName.toLowerCase() !== 'button') {
            e.preventDefault();
            isDragging = true;
            initialY = e.clientY - menu.getBoundingClientRect().top;
          }
        });

        document.addEventListener('mousemove', e => {
          if (isDragging) {
            menu.style.removeProperty('bottom');
            offsetY = e.clientY - initialY;
            menu.style.top = `${offsetY}px`;
          }
        });
        const customWindow = window as unknown as CustomWindow;

        document.addEventListener('mouseup', () => {
          // need to tell typeScript to defer first because down int he script updateMenuPos is defined
          if (isDragging) {
            // Snap the menu when it is below half the screen
            const halfScreenHeight: number = window.innerHeight / 2;
            const isTopHalf: boolean = offsetY < halfScreenHeight;
            if (isTopHalf) {
              menu.style.removeProperty('bottom');
              menu.style.top = '0';
              customWindow.updateMenuPos(vars.MENU_POSITION.top);
            } else {
              menu.style.removeProperty('top');
              menu.style.bottom = '0';
              customWindow.updateMenuPos(vars.MENU_POSITION.top);
            }

            isDragging = false;
          }
        });

        const p = document.createElement('p');
        p.id = 'oobee-p-pages-scanned';
        p.innerText = `Pages Scanned: ${vars.urlsCrawled.scanned.length || 0}`;

        const button = document.createElement('button');
        button.innerText = 'Scan this page';
        button.addEventListener('click', async () => {
          customWindow.handleOnScanClick();
        });

        menu.appendChild(p);
        menu.appendChild(button);

        const sheet = new CSSStyleSheet();
        // TODO: separate out into css file if this gets too big
        sheet.replaceSync(`
        .oobee-menu {
          position: fixed;
          left: 0;
          width: 100%;
          box-sizing: border-box;
          background-color: rgba(0, 0, 0, 0.8);
          display: flex;
          justify-content: space-between;
          padding: 10px;
          z-index: 2147483647;
          cursor: grab;
          color: #fff;
        }
        
        .oobee-menu button {
          background-color: #9021a6;
          color: #fff;
          border: none;
          border-radius: 50rem;
          padding: 10px 20px;
          cursor: pointer;
        }
        `);

        // shadow dom used to avoid styling from page
        const shadowHost = document.createElement('div');
        shadowHost.id = 'oobee-shadow-host';
        const shadowRoot = shadowHost.attachShadow({ mode: 'open' });

        shadowRoot.adoptedStyleSheets = [sheet];

        shadowRoot.appendChild(menu);

        let currentNode = document.body;
        if (document.body) {
          // The <body> element exists
          if (document.body.nodeName.toLowerCase() === 'frameset') {
            // if currentNode is a <frameset>
            // Move the variable outside the frameset then appendChild the component
            while (currentNode.nodeName.toLowerCase() === 'frameset') {
              currentNode = currentNode.parentElement;
            }
            currentNode.appendChild(shadowHost);
          } else {
            // currentNode is a <body>
            currentNode.appendChild(shadowHost);
          }
        } else if (document.head) {
          // The <head> element exists
          // Append the variable below the head
          document.head.insertAdjacentElement('afterend', shadowHost);
        } else {
          // Neither <body> nor <head> nor <html> exists
          // Append the variable to the document
          document.documentElement.appendChild(shadowHost);
        }
      },
      { menuPos, MENU_POSITION, urlsCrawled },
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
      const existingOverlay = document.querySelector('#oobee-shadow-host');
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
  let menuPos = MENU_POSITION.top;

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
    pagesDict[pageId] = { page };
  }

  type handleOnScanClickFunction = () => void;

  // Window functions exposed in browser
  const handleOnScanClick: handleOnScanClickFunction = async () => {
    log('Scan: click detected');
    try {
      await removeOverlayMenu(page);
      await processPage(page, processPageParams);
      log('Scan: success');
      await addOverlayMenu(page, processPageParams.urlsCrawled, menuPos);

      Object.keys(pagesDict)
        .filter(k => k !== pageId)
        .forEach(k => {
          updateMenu(pagesDict[k].page, processPageParams.urlsCrawled);
        });
    } catch (error) {
      log(`Scan failed ${error}`);
    }
  };

  // Detection of new url within page
  page.on('domcontentloaded', async () => {
    try {
      const existingOverlay = await page.evaluate(() => {
        return document.querySelector('#oobee-shadow-host');
      });

      consoleLogger.info(`Overlay state: ${existingOverlay}`);

      if (!existingOverlay) {
        consoleLogger.info(`Adding overlay menu to page: ${page.url()}`);
        await addOverlayMenu(page, processPageParams.urlsCrawled, menuPos);
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

  type UpdateMenuPosFunction = (newPos: any) => void;

  // Define the updateMenuPos function
  const updateMenuPos: UpdateMenuPosFunction = newPos => {
    const prevPos = menuPos;
    if (prevPos !== newPos) {
      console.log(`Overlay menu: position updated from ${prevPos} to ${newPos}`);
      menuPos = newPos;
    }
  };
  await page.exposeFunction('updateMenuPos', updateMenuPos);

  return page;
};
