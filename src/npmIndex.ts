import fs from 'fs';
import path from 'path';
import printMessage from 'print-message';
import axe, { AxeResults, ImpactValue } from 'axe-core';
import { fileURLToPath } from 'url';
import { EnqueueStrategy } from 'crawlee';
import constants, { BrowserTypes, RuleFlags, ScannerTypes } from './constants/constants.js';
import {
  deleteClonedProfiles,
  getBrowserToRun,
  getPlaywrightLaunchOptions,
  submitForm,
} from './constants/common.js';
import { createCrawleeSubFolders, filterAxeResults } from './crawlers/commonCrawlerFunc.js';
import { createAndUpdateResultsFolders } from './utils.js';
import generateArtifacts from './mergeAxeResults.js';
import { takeScreenshotForHTMLElements } from './screenshotFunc/htmlScreenshotFunc.js';
import { consoleLogger, silentLogger } from './logs.js';
import { alertMessageOptions } from './constants/cliFunctions.js';
import { evaluateAltText } from './crawlers/custom/evaluateAltText.js';
import { escapeCssSelector } from './crawlers/custom/escapeCssSelector.js';
import { framesCheck } from './crawlers/custom/framesCheck.js';
import { findElementByCssSelector } from './crawlers/custom/findElementByCssSelector.js';
import { flagUnlabelledClickableElements } from './crawlers/custom/flagUnlabelledClickableElements.js';
import xPathToCss from './crawlers/custom/xPathToCss.js';
import { extractText } from './crawlers/custom/extractText.js';
import { gradeReadability } from './crawlers/custom/gradeReadability.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

export const init = async ({
  entryUrl,
  testLabel,
  name,
  email,
  includeScreenshots = false,
  viewportSettings = { width: 1000, height: 660 }, // cypress' default viewport settings
  thresholds = { mustFix: undefined, goodToFix: undefined },
  scanAboutMetadata = undefined,
  zip = 'oobee-scan-results',
  deviceChosen,
  strategy = EnqueueStrategy.All,
  ruleset = [RuleFlags.DEFAULT],
  specifiedMaxConcurrency = 25,
  followRobots = false,
}: {
  entryUrl: string;
  testLabel: string;
  name: string;
  email: string;
  includeScreenshots?: boolean;
  viewportSettings?: { width: number; height: number };
  thresholds?: { mustFix: number; goodToFix: number };
  scanAboutMetadata?: {
    browser?: string;
    viewport?: { width: number; height: number };
  };
  zip?: string;
  deviceChosen?: string;
  strategy?: EnqueueStrategy;
  ruleset?: RuleFlags[];
  specifiedMaxConcurrency?: number;
  followRobots?: boolean;
}) => {
  consoleLogger.info('Starting Oobee');

  const [date, time] = new Date().toLocaleString('sv').replaceAll(/-|:/g, '').split(' ');
  const domain = new URL(entryUrl).hostname;
  const sanitisedLabel = testLabel ? `_${testLabel.replaceAll(' ', '_')}` : '';
  const randomToken = `${date}_${time}${sanitisedLabel}_${domain}`;

  const disableOobee = ruleset.includes(RuleFlags.DISABLE_OOBEE);
  const enableWcagAaa = ruleset.includes(RuleFlags.ENABLE_WCAG_AAA);

  // max numbers of mustFix/goodToFix occurrences before test returns a fail
  const { mustFix: mustFixThreshold, goodToFix: goodToFixThreshold } = thresholds;

  process.env.CRAWLEE_STORAGE_DIR = randomToken;

  const scanDetails = {
    startTime: new Date(),
    endTime: new Date(),
    deviceChosen,
    crawlType: ScannerTypes.CUSTOM,
    requestUrl: entryUrl,
    urlsCrawled: { ...constants.urlsCrawledObj },
    isIncludeScreenshots: includeScreenshots,
    isAllowSubdomains: strategy,
    isEnableCustomChecks: ruleset,
    isEnableWcagAaa: ruleset,
    isSlowScanMode: specifiedMaxConcurrency,
    isAdhereRobots: followRobots,
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

  const getAxeScript = () => {
    throwErrorIfTerminated();
    const axeScript = fs.readFileSync(
      path.join(dirname, '../../../axe-core/axe.min.js'),
      'utf-8',
    );
    return axeScript;
  };

  const getOobeeFunctions = () => {
    throwErrorIfTerminated();
    return `
      // Fix for missing __name function used by bundler
      if (typeof __name === 'undefined') {
        window.__name = function(fn, name) {
          if (fn && typeof fn === 'function' && name) {
            try {
              Object.defineProperty(fn, 'name', { value: name, configurable: true });
            } catch (e) {
              // Ignore errors if name property cannot be set
            }
          }
          return fn;
        };
      }
      
      window.flagUnlabelledClickableElements = ${flagUnlabelledClickableElements.toString()};
      window.evaluateAltText = ${evaluateAltText.toString()};
      window.escapeCssSelector = ${escapeCssSelector.toString()};
      window.framesCheck = ${framesCheck.toString()};
      window.findElementByCssSelector = ${findElementByCssSelector.toString()};
      
      window.xPathToCss = ${xPathToCss.toString()};
      window.extractText = ${extractText.toString()};
      
      function getAxeConfiguration({
        enableWcagAaa = false,
        gradingReadabilityFlag = '',
        disableOobee = false,
      }) {
        return {
          branding: {
            application: 'oobee',
          },
          checks: [
            {
              id: 'oobee-confusing-alt-text',
              metadata: {
                impact: 'serious',
                messages: {
                  pass: 'The image alt text is probably useful.',
                  fail: "The image alt text set as 'img', 'image', 'picture', 'photo', or 'graphic' is confusing or not useful.",
                },
              },
              evaluate: window.evaluateAltText,
            },
            {
              id: 'oobee-accessible-label',
              metadata: {
                impact: 'serious',
                messages: {
                  pass: 'The clickable element has an accessible label.',
                  fail: 'The clickable element does not have an accessible label.',
                },
              },
              evaluate: (node) => {
                return !node.dataset.flagged; // fail any element with a data-flagged attribute set to true
              },
            },
            ...(enableWcagAaa
              ? [
                  {
                    id: 'oobee-grading-text-contents',
                    metadata: {
                      impact: 'moderate',
                      messages: {
                        pass: 'The text content is easy to understand.',
                        fail: 'The text content is potentially difficult to understand.',
                        incomplete: \`The text content is potentially difficult to read, with a Flesch-Kincaid Reading Ease score of \${gradingReadabilityFlag}.\nThe target passing score is above 50, indicating content readable by university students and lower grade levels.\nA higher score reflects better readability.\`,
                      },
                    },
                    evaluate: (_node) => {
                      if (gradingReadabilityFlag === '') {
                        return true; // Pass if no readability issues
                      }
                      // Fail if readability issues are detected
                    },
                  },
                ]
              : []),
          ],
          rules: [
            { id: 'target-size', enabled: true },
            {
              id: 'oobee-confusing-alt-text',
              selector: 'img[alt]',
              enabled: true,
              any: ['oobee-confusing-alt-text'],
              tags: ['wcag2a', 'wcag111'],
              metadata: {
                description: 'Ensures image alt text is clear and useful.',
                help: 'Image alt text must not be vague or unhelpful.',
                helpUrl: 'https://www.deque.com/blog/great-alt-text-introduction/',
              },
            },
            {
              id: 'oobee-accessible-label',
              // selector: '*', // to be set with the checker function output xpaths converted to css selectors
              enabled: true,
              any: ['oobee-accessible-label'],
              tags: ['wcag2a', 'wcag211', 'wcag412'],
              metadata: {
                description: 'Ensures clickable elements have an accessible label.',
                help: 'Clickable elements must have accessible labels.',
                helpUrl: 'https://www.deque.com/blog/accessible-aria-buttons',
              },
            },
            {
              id: 'oobee-grading-text-contents',
              selector: 'html',
              enabled: true,
              any: ['oobee-grading-text-contents'],
              tags: ['wcag2aaa', 'wcag315'],
              metadata: {
                description:
                  'Text content should be easy to understand for individuals with education levels up to university graduates. If the text content is difficult to understand, provide supplemental content or a version that is easy to understand.',
                help: 'Text content should be clear and plain to ensure that it is easily understood.',
                helpUrl: 'https://www.wcag.com/uncategorized/3-1-5-reading-level/',
              },
            },
          ]
            .filter(rule => (disableOobee ? !rule.id.startsWith('oobee') : true))
            .concat(
              enableWcagAaa
                ? [
                    {
                      id: 'color-contrast-enhanced',
                      enabled: true,
                    },
                    {
                      id: 'identical-links-same-purpose',
                      enabled: true,
                    },
                    {
                      id: 'meta-refresh-no-exceptions',
                      enabled: true,
                    },
                  ]
                : [],
            ),
        };
      }
      window.getAxeConfiguration = getAxeConfiguration;

      async function runA11yScan(elementsToScan = [], gradingReadabilityFlag = '') {

        const oobeeAccessibleLabelFlaggedXpaths = (window).disableOobee
          ? []
          : (await (window).flagUnlabelledClickableElements()).map(item => item.xpath);
        console.log('OOBEE DEBUG: Flagged XPaths count:', oobeeAccessibleLabelFlaggedXpaths.length);
        console.log('OOBEE DEBUG: Flagged XPaths:', oobeeAccessibleLabelFlaggedXpaths);
        
        // Force visibility of the result in Cypress by adding to page title temporarily
        const originalTitle = document.title;
        document.title = '[OOBEE: ' + oobeeAccessibleLabelFlaggedXpaths.length + ' flagged] ' + originalTitle;
        setTimeout(function() { document.title = originalTitle; }, 1000);
        const oobeeAccessibleLabelFlaggedCssSelectors = oobeeAccessibleLabelFlaggedXpaths
          .map(xpath => {
            try {
              const cssSelector = (window).xPathToCss(xpath);
              return cssSelector;
            } catch (e) {
              // console.error(\`Error converting XPath to CSS: \${xpath} - \${e}\`);
              return '';
            }
          })
          .filter(item => item !== '');
  
        (window).axe.configure((window).getAxeConfiguration({ disableOobee: (window).disableOobee, enableWcagAaa: (window).enableWcagAaa, gradingReadabilityFlag }));
        const axeScanResults = await (window).axe.run(elementsToScan, {
          resultTypes: ['violations', 'passes', 'incomplete'],
        });
  
        // add custom Oobee violations
        if (!(window).disableOobee) {
          // handle css id selectors that start with a digit
          const escapedCssSelectors = oobeeAccessibleLabelFlaggedCssSelectors.map((window).escapeCssSelector);
  
          // Add oobee violations to Axe's report
          const oobeeAccessibleLabelViolations = {
            id: 'oobee-accessible-label',
            impact: 'serious',
            tags: ['wcag2a', 'wcag211', 'wcag412'],
            description: 'Ensures clickable elements have an accessible label.',
            help: 'Clickable elements (i.e. elements with mouse-click interaction) must have accessible labels.',
            helpUrl: 'https://www.deque.com/blog/accessible-aria-buttons',
            nodes: escapedCssSelectors
              .map(cssSelector => ({
                html: (window).findElementByCssSelector(cssSelector),
                target: [cssSelector],
                impact: 'serious',
                failureSummary:
                  'Fix any of the following:\\n  The clickable element does not have an accessible label.',
                any: [
                  {
                    id: 'oobee-accessible-label',
                    data: null,
                    relatedNodes: [],
                    impact: 'serious',
                    message: 'The clickable element does not have an accessible label.',
                  },
                ],
                all: [],
                none: [],
              }))
              .filter(item => item.html),
          };
  
          axeScanResults.violations = [...axeScanResults.violations, oobeeAccessibleLabelViolations];
        }
  
        return {
          pageUrl: window.location.href,
          pageTitle: document.title,
          axeScanResults,
        };
      }
      window.disableOobee=${disableOobee};
      window.enableWcagAaa=${enableWcagAaa};
      window.runA11yScan = runA11yScan;
    `;
  };

  // Helper script for manually copy-paste testing in Chrome browser
  /*
  const scripts = `${getAxeScript()}\n${getOobeeFunctions()}`;
  fs.writeFileSync(path.join(dirname, 'testScripts.txt'), scripts);
  */
 
  const pushScanResults = async (
    res: { pageUrl: string; pageTitle: string; axeScanResults: AxeResults },
    metadata: string,
    elementsToClick: string[],
  ) => {
    throwErrorIfTerminated();
    if (includeScreenshots) {
      // use chrome by default
      const { browserToRun, clonedBrowserDataDir } = getBrowserToRun(randomToken, BrowserTypes.CHROME, false);
      const browserContext = await constants.launcher.launchPersistentContext(
        clonedBrowserDataDir,
        { viewport: viewportSettings, ...getPlaywrightLaunchOptions(browserToRun) },
      );
            const page = await browserContext.newPage();
            await page.goto(res.pageUrl);
            try {
                await page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch (e) {
                console.log('Network idle timeout, continuing with screenshot capture...');
                // Fall back to domcontentloaded if networkidle times out
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
            }      // click on elements to reveal hidden elements so screenshots can be taken
      if (elementsToClick) {
        for (const elem of elementsToClick) {
          try {
            await page.locator(elem).click();
          } catch (e) {
            // do nothing if element is not found or not clickable
          }
        }
      }

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
      deleteClonedProfiles(browserToRun, randomToken);
    }
    const pageIndex = urlsCrawled.scanned.length + 1;
    const filteredResults = filterAxeResults(res.axeScanResults, res.pageTitle, {
      pageIndex,
      metadata,
    });
    urlsCrawled.scanned.push({
      url: res.pageUrl.toString(),
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
    consoleLogger.info('Stopping Oobee');
    isInstanceTerminated = true;
    scanDetails.endTime = new Date();
    scanDetails.urlsCrawled = urlsCrawled;

    if (urlsCrawled.scanned.length === 0) {
      printMessage([`No pages were scanned.`], alertMessageOptions);
    } else {
      await createAndUpdateResultsFolders(randomToken);
      const pagesNotScanned = [
        ...scanDetails.urlsCrawled.error,
        ...scanDetails.urlsCrawled.invalid,
        ...scanDetails.urlsCrawled.forbidden,
        ...scanDetails.urlsCrawled.userExcluded,
      ];
      const updatedScanAboutMetadata = {
        viewport: {
          width: viewportSettings.width,
          height: viewportSettings.height,
        },
        ...scanAboutMetadata,
      };
      const basicFormHTMLSnippet = await generateArtifacts(
        randomToken,
        scanDetails.requestUrl,
        scanDetails.crawlType,
        deviceChosen,
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
    getAxeScript,
    getOobeeFunctions,
    gradeReadability,
    pushScanResults,
    terminate,
    scanDetails,
    randomToken,
    testThresholds,
  };
};

export default init;