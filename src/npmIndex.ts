import fs from 'fs';
import path from 'path';
import printMessage from 'print-message';
import axe from 'axe-core';
import { fileURLToPath } from 'url';
import constants, { BrowserTypes } from './constants/constants.js';
import {
  deleteClonedProfiles,
  getBrowserToRun,
  getPlaywrightLaunchOptions,
  submitForm,
  urlWithoutAuth,
} from './constants/common.js';
import { createCrawleeSubFolders, filterAxeResults } from './crawlers/commonCrawlerFunc.js';
import { createAndUpdateResultsFolders, createDetailsAndLogs } from './utils.js';
import generateArtifacts from './mergeAxeResults.js';
import { takeScreenshotForHTMLElements } from './screenshotFunc/htmlScreenshotFunc.js';
import { silentLogger } from './logs.js';
import { alertMessageOptions } from './constants/cliFunctions.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

export const init = async (
  entryUrl,
  testLabel,
  name = 'Your Name',
  email = 'email@domain.com',
  includeScreenshots = false,
  viewportSettings = { width: 1000, height: 660 }, // cypress' default viewport settings
  thresholds = { mustFix: undefined, goodToFix: undefined },
  scanAboutMetadata = undefined,
  zip = undefined,
) => {
  console.log('Starting Oobee');

  const [date, time] = new Date().toLocaleString('sv').replaceAll(/-|:/g, '').split(' ');
  const domain = new URL(entryUrl).hostname;
  const sanitisedLabel = testLabel ? `_${testLabel.replaceAll(' ', '_')}` : '';
  const randomToken = `${date}_${time}${sanitisedLabel}_${domain}`;

  // max numbers of mustFix/goodToFix occurrences before test returns a fail
  const { mustFix: mustFixThreshold, goodToFix: goodToFixThreshold } = thresholds;

  process.env.CRAWLEE_STORAGE_DIR = randomToken;

  const scanDetails = {
    startTime: new Date(),
    endTime: new Date(),
    crawlType: 'Custom',
    requestUrl: entryUrl,
    urlsCrawled: { ...constants.urlsCrawledObj },
  };

  const urlsCrawled = { ...constants.urlsCrawledObj };

  const { dataset } = await createCrawleeSubFolders(randomToken);

  let mustFixIssues = 0;
  let goodToFixIssues = 0;

  let isInstanceTerminated = false;

  const throwErrorIfTerminated = () => {
    if (isInstanceTerminated) {
      throw new Error('This instance of Oobee was terminated. Please start a new instance.');
    }
  };

  const getScripts = () => {
    throwErrorIfTerminated();
    const axeScript = fs.readFileSync(
      path.join(dirname, '../node_modules/axe-core/axe.min.js'),
      'utf-8',
    );
    async function runA11yScan(elementsToScan = []) {
      axe.configure({
        branding: {
          application: 'oobee',
        },
        // Add custom img alt text check
        checks: [
          {
            id: 'oobee-confusing-alt-text',
            evaluate(node: HTMLElement) {
              const altText = node.getAttribute('alt');
              const confusingTexts = ['img', 'image', 'picture', 'photo', 'graphic'];

              if (altText) {
                const trimmedAltText = altText.trim().toLowerCase();
                // Check if the alt text exactly matches one of the confusingTexts
                if (confusingTexts.some(text => text === trimmedAltText)) {
                  return false; // Fail the check if the alt text is confusing or not useful
                }
              }

              return true; // Pass the check if the alt text seems appropriate
            },
            metadata: {
              impact: 'serious', // Set the severity to serious
              messages: {
                pass: 'The image alt text is probably useful',
                fail: "The image alt text set as 'img', 'image', 'picture', 'photo', or 'graphic' is confusing or not useful",
              },
            },
          },
        ],
        rules: [
          { id: 'target-size', enabled: true },
          {
            id: 'oobee-confusing-alt-text',
            selector: 'img[alt]',
            enabled: true,
            any: ['oobee-confusing-alt-text'],
            all: [],
            none: [],
            tags: ['wcag2a', 'wcag111'],
            metadata: {
              description: 'Ensures image alt text is clear and useful',
              help: 'Image alt text must not be vague or unhelpful',
              helpUrl: 'https://www.deque.com/blog/great-alt-text-introduction/',
            },
          },
        ],
      });
      const axeScanResults = await axe.run(elementsToScan, {
        resultTypes: ['violations', 'passes', 'incomplete'],
      });
      return {
        pageUrl: window.location.href,
        pageTitle: document.title,
        axeScanResults,
      };
    }
    return `${axeScript} ${runA11yScan.toString()}`;
  };

  const pushScanResults = async (res, metadata, elementsToClick) => {
    throwErrorIfTerminated();
    if (includeScreenshots) {
      // use chrome by default
      const { browserToRun, clonedBrowserDataDir } = getBrowserToRun(BrowserTypes.CHROME);
      const browserContext = await constants.launcher.launchPersistentContext(
        clonedBrowserDataDir,
        { viewport: scanAboutMetadata.viewport, ...getPlaywrightLaunchOptions(browserToRun) },
      );
      const page = await browserContext.newPage();
      await page.goto(res.pageUrl);
      await page.waitForLoadState('networkidle');

      // click on elements to reveal hidden elements so screenshots can be taken
      elementsToClick?.forEach(async elem => {
        try {
          await page.locator(elem).click();
        } catch (e) {
          silentLogger.info(e);
        }
      });

      res.axeScanResults.violations = await takeScreenshotForHTMLElements(
        res.axeScanResults.violations,
        page,
        randomToken,
        3000,
      );
      res.axeScanResults.incomplete = await takeScreenshotForHTMLElements(
        res.axeScanResults.incomplete,
        page,
        randomToken,
        3000,
      );

      await browserContext.close();
      deleteClonedProfiles(browserToRun);
    }
    const pageIndex = urlsCrawled.scanned.length + 1;
    const filteredResults = filterAxeResults(res.axeScanResults, res.pageTitle, {
      pageIndex,
      metadata,
    });
    urlsCrawled.scanned.push({
      url: urlWithoutAuth(res.pageUrl).toString(),
      actualUrl: 'tbd',
      pageTitle: `${pageIndex}: ${res.pageTitle}`,
    });

    mustFixIssues += filteredResults.mustFix ? filteredResults.mustFix.totalItems : 0;
    goodToFixIssues += filteredResults.goodToFix ? filteredResults.goodToFix.totalItems : 0;
    await dataset.pushData(filteredResults);

    // return counts for users to perform custom assertions if needed
    return {
      mustFix: filteredResults.mustFix ? filteredResults.mustFix.totalItems : 0,
      goodToFix: filteredResults.goodToFix ? filteredResults.goodToFix.totalItems : 0,
    };
  };

  const terminate = async () => {
    throwErrorIfTerminated();
    console.log('Stopping Oobee');
    isInstanceTerminated = true;
    scanDetails.endTime = new Date();
    scanDetails.urlsCrawled = urlsCrawled;

    if (urlsCrawled.scanned.length === 0) {
      printMessage([`No pages were scanned.`], alertMessageOptions);
    } else {
      await createDetailsAndLogs(randomToken);
      await createAndUpdateResultsFolders(randomToken);
      const pagesNotScanned = [
        ...scanDetails.urlsCrawled.error,
        ...scanDetails.urlsCrawled.invalid,
      ];
      const updatedScanAboutMetadata = {
        viewport: `${viewportSettings.width} x ${viewportSettings.height}`,
        ...scanAboutMetadata,
      };
      const basicFormHTMLSnippet = await generateArtifacts(
        randomToken,
        scanDetails.requestUrl,
        scanDetails.crawlType,
        updatedScanAboutMetadata.viewport,
        scanDetails.urlsCrawled.scanned,
        pagesNotScanned,
        testLabel,
        updatedScanAboutMetadata,
        scanDetails,
        zip,
      );

      await submitForm(
        BrowserTypes.CHROMIUM, // browserToRun
        '', // userDataDirectory
        scanDetails.requestUrl, // scannedUrl
        null, // entryUrl
        scanDetails.crawlType, // scanType
        email, // email
        name, // name
        JSON.stringify(basicFormHTMLSnippet), // scanResultsKson
        urlsCrawled.scanned.length, // numberOfPagesScanned
        0,
        0,
        '{}',
      );
    }

    return randomToken;
  };

  const testThresholds = () => {
    // check against thresholds to fail tests
    let isThresholdExceeded = false;
    let thresholdFailMessage = 'Exceeded thresholds:\n';
    if (mustFixThreshold !== undefined && mustFixIssues > mustFixThreshold) {
      isThresholdExceeded = true;
      thresholdFailMessage += `mustFix occurrences found: ${mustFixIssues} > ${mustFixThreshold}\n`;
    }

    if (goodToFixThreshold !== undefined && goodToFixIssues > goodToFixThreshold) {
      isThresholdExceeded = true;
      thresholdFailMessage += `goodToFix occurrences found: ${goodToFixIssues} > ${goodToFixThreshold}\n`;
    }

    // uncomment to reset counts if you do not want violations count to be cumulative across other pages
    // mustFixIssues = 0;
    // goodToFixIssues = 0;

    if (isThresholdExceeded) {
      terminate(); // terminate if threshold exceeded
      throw new Error(thresholdFailMessage);
    }
  };

  return {
    getScripts,
    pushScanResults,
    terminate,
    scanDetails,
    randomToken,
    testThresholds,
  };
};

export default init;
