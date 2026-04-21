import fs from 'fs';
import path from 'path';
import printMessage from 'print-message';
import axe, { AxeResults, ImpactValue } from 'axe-core';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';
import { EnqueueStrategy } from 'crawlee';
import constants, { BrowserTypes, RuleFlags, ScannerTypes, a11yRuleShortDescriptionMap, a11yRuleLongDescriptionMap, a11yRuleStepByStepGuide } from './constants/constants.js';
import {
  deleteClonedProfiles,
  getBrowserToRun,
  getPlaywrightLaunchOptions,
  submitForm,
} from './constants/common.js';
import { createCrawleeSubFolders, filterAxeResults } from './crawlers/commonCrawlerFunc.js';
import { createAndUpdateResultsFolders, getVersion } from './utils.js';
import generateArtifacts, { createBasicFormHTMLSnippet, sendWcagBreakdownToSentry } from './mergeAxeResults.js';
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
import { BrowserContext, Page } from 'playwright';
import { filter } from 'jszip';

// Define global window properties for Oobee injection functions
declare global {
  interface Window {
    runA11yScan: (
      elements?: any[],
      gradingReadabilityFlag?: string,
    ) => Promise<{
      pageUrl: string;
      pageTitle: string;
      axeScanResults: AxeResults;
    }>;
    axe: any;
    getAxeConfiguration: any;
    flagUnlabelledClickableElements: any;
    disableOobee: boolean;
    enableWcagAaa: boolean;
    xPathToCss: any;
    evaluateAltText: any;
    escapeCssSelector: any;
    framesCheck: any;
    findElementByCssSelector: any;
    extractText: any;
  }
}

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const getAxeScriptContent = () => {
  return axe.source;
};

const getOobeeFunctionsScript = (disableOobee: boolean, enableWcagAaa: boolean) => {
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
            ...((enableWcagAaa && !disableOobee)
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
            ...((enableWcagAaa && !disableOobee)
              ? [
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
              : []),
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

        if (axeScanResults) {
          ['violations', 'incomplete'].forEach(type => {
            if (axeScanResults[type]) {
              axeScanResults[type].forEach(result => {
                if (result.nodes) {
                  result.nodes.forEach(node => {
                     ['any', 'all', 'none'].forEach(key => {
                        if (node[key]) {
                          node[key].forEach(check => {
                            if (check.message && check.message.indexOf("Axe encountered an error") !== -1) {
                                if (check.data) {
                                  // console.error(check.data);
                                  console.error("Axe encountered an error: " + (check.data.stack || check.data.message || JSON.stringify(check.data)));
                                }
                            }
                          });
                        }
                     });
                  });
                }
              });
            }
          });
        }
  
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
    return getAxeScriptContent();
  };

  const getOobeeFunctions = () => {
    throwErrorIfTerminated();
    return getOobeeFunctionsScript(disableOobee, enableWcagAaa);
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
    page?: Page,
    disableScreenshots: boolean = false, // Only for Cypress (or other library that wants to use it's own screenshotting)
  ) => {
    throwErrorIfTerminated();
    if (includeScreenshots && !disableScreenshots) {
      let browserContext: BrowserContext | undefined;
      let browserToRun: BrowserTypes | undefined;
      let clonedBrowserDataDir: string | undefined;
      let pageToScan: Page;

      if (page) {
        pageToScan = page;
      } else {
        // use chrome by default
        const browserData = getBrowserToRun(randomToken, BrowserTypes.CHROME, false);
        browserToRun = browserData.browserToRun;
        clonedBrowserDataDir = browserData.clonedBrowserDataDir;

        browserContext = await constants.launcher.launchPersistentContext(clonedBrowserDataDir, {
          viewport: viewportSettings,
          ...getPlaywrightLaunchOptions(browserToRun),
        });
        const newPage = await browserContext.newPage();
        await newPage.goto(res.pageUrl);
        try {
          await newPage.waitForLoadState('networkidle', { timeout: 10000 });
        } catch (e) {
          console.log('Network idle timeout, continuing with screenshot capture...');
          // Fall back to domcontentloaded if networkidle times out
          await newPage.waitForLoadState('domcontentloaded', { timeout: 5000 });
        } // click on elements to reveal hidden elements so screenshots can be taken
        if (elementsToClick) {
          for (const elem of elementsToClick) {
            try {
              await newPage.locator(elem).click();
            } catch (e) {
              // do nothing if element is not found or not clickable
            }
          }
        }
        pageToScan = newPage;
      }

      res.axeScanResults.violations = await takeScreenshotForHTMLElements(
        res.axeScanResults.violations,
        pageToScan,
        randomToken,
        3000,
      );
      res.axeScanResults.incomplete = await takeScreenshotForHTMLElements(
        res.axeScanResults.incomplete,
        pageToScan,
        randomToken,
        3000,
      );

      if (browserContext && browserToRun) {
        await browserContext.close();
        deleteClonedProfiles(browserToRun, randomToken);
      }
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

const processAndSubmitResults = async (
  scanData: { axeScanResults: AxeResults; pageUrl: string; pageTitle: string } | { axeScanResults: AxeResults; pageUrl: string; pageTitle: string }[],
  name: string,
  email: string,
  metadata: string,
) => {
  const items = Array.isArray(scanData) ? scanData : [scanData];
  const numberOfPagesScanned = items.length;
  
  const allFilteredResults = items.map((item, index) => {
    const filtered = filterAxeResults(item.axeScanResults, item.pageTitle, { pageIndex: index + 1, metadata });
    (filtered as any).url = item.pageUrl;
    return filtered;
  });

  type Rule = {
    totalItems: number;
    items: any[];
    [key: string]: any;
  };

  type ResultCategory = {
    totalItems: number;
    rules: Record<string, Rule>;
  };

  type CategoryKey = 'mustFix' | 'goodToFix' | 'needsReview';

  const mergedResults: Record<CategoryKey, ResultCategory> = {
    mustFix: { totalItems: 0, rules: {} },
    goodToFix: { totalItems: 0, rules: {} },
    needsReview: { totalItems: 0, rules: {} },
    // omitting passed from being processed to reduce payload size
    // passed: { totalItems: 0, rules: {} },
  };

  allFilteredResults.forEach(result => {
    (['mustFix', 'goodToFix', 'needsReview'] as CategoryKey[]).forEach(category => {
      const categoryResult = (result as any)[category];
      if (categoryResult) {
        mergedResults[category].totalItems += categoryResult.totalItems;
        Object.entries(categoryResult.rules).forEach(([ruleId, ruleVal]: [string, any]) => {
          if (!mergedResults[category].rules[ruleId]) {
            mergedResults[category].rules[ruleId] = JSON.parse(JSON.stringify(ruleVal));

            // Map the description to the short description if available
            if (constants.a11yRuleShortDescriptionMap[ruleId]) {
              mergedResults[category].rules[ruleId].description = constants.a11yRuleShortDescriptionMap[ruleId];
            }

            // Add short description, long description and step-by-step guide
            mergedResults[category].rules[ruleId].shortDescription = a11yRuleShortDescriptionMap[ruleId];
            mergedResults[category].rules[ruleId].longDescription = a11yRuleLongDescriptionMap[ruleId];
            mergedResults[category].rules[ruleId].stepByStepGuide = a11yRuleStepByStepGuide[ruleId];
            
            // Add url to items
            mergedResults[category].rules[ruleId].items.forEach((item: any) => {
              item.url = (result as any).url;
              if (item.displayNeedsReview) {
                delete item.displayNeedsReview;
              }
            });
          } else {
            mergedResults[category].rules[ruleId].totalItems += ruleVal.totalItems;
            const newItems = ruleVal.items.map((item: any) => {
               const newItem = { ...item, url: (result as any).url };
               if (newItem.displayNeedsReview) {
                 delete newItem.displayNeedsReview;
               }
               return newItem;
             });
            mergedResults[category].rules[ruleId].items.push(...newItems);
          }
        });
      }
    });
  });

  const basicFormHTMLSnippet = createBasicFormHTMLSnippet(mergedResults);
  const entryUrl = items[0].pageUrl;

  await submitForm(
    BrowserTypes.CHROMIUM,
    '',
    entryUrl,
    null,
    ScannerTypes.CUSTOM,
    email,
    name,
    JSON.stringify(basicFormHTMLSnippet),
    numberOfPagesScanned,
    0,
    0,
    '{}',
  );

  // Generate WCAG breakdown for Sentry
  const wcagOccurrencesMap = new Map<string, number>();
  
  // Iterate through relevant categories to collect WCAG violation occurrences
  (['mustFix', 'goodToFix'] as CategoryKey[]).forEach(category => {
    const rulesObj = mergedResults[category]?.rules;
    if (rulesObj) {
      Object.values(rulesObj).forEach((rule: any) => {
        const count = rule.totalItems;
        if (rule.conformance && Array.isArray(rule.conformance)) {
          rule.conformance
            .filter((c: string) => /wcag[0-9]{3,4}/.test(c))
            .forEach((c: string) => {
              const current = wcagOccurrencesMap.get(c) || 0;
              wcagOccurrencesMap.set(c, current + count);
            });
        }
      });
    }
  });

  const oobeeAppVersion = getVersion();
  
  await sendWcagBreakdownToSentry(
    oobeeAppVersion,
    wcagOccurrencesMap,
    basicFormHTMLSnippet,
    {
      entryUrl: entryUrl,
      scanType: ScannerTypes.CUSTOM,
      browser: 'chromium', // Defaulting since we might scan HTML without browser or implicit browser
      email: email,
      name: name,
    },
    undefined,
    numberOfPagesScanned,
  );

  // Return original single result if only one page was scanning to maintain backward compatibility structure
  if (numberOfPagesScanned === 1) {
    const singleResult = allFilteredResults[0];
    
    // Clean up displayNeedsReview from single result
    (['mustFix', 'goodToFix', 'needsReview'] as CategoryKey[]).forEach(category => {
      const resultCategory = (singleResult as any)[category];
      if (resultCategory && resultCategory.rules) {
        Object.values(resultCategory.rules).forEach((rule: any) => {

          // Map the description to the short description if available
          if (constants.a11yRuleShortDescriptionMap[rule.rule]) {
            rule.description = constants.a11yRuleShortDescriptionMap[rule.rule];
          }

          // Add short description, long description and step-by-step guide
          rule.shortDescription = a11yRuleShortDescriptionMap[rule.rule];
          rule.longDescription = a11yRuleLongDescriptionMap[rule.rule];
          rule.stepByStepGuide = a11yRuleStepByStepGuide[rule.rule];

          if (rule.items) {
           rule.items.forEach((item: any) => {
             // Ensure item URL matches the result URL
             item.url = (singleResult as any).url;

             if (item.displayNeedsReview) {
               delete item.displayNeedsReview;
             }
           });
          }
        });
      }
    });

    return singleResult;
  }

  return mergedResults;
};

// This is an experimental feature to scan static HTML code without the need for Playwright browser
export const scanHTML = async (
  htmlContent: string | string[],
  config: {
    name: string;
    email: string;
    pageUrl?: string; // If array, we will append index
    pageTitle?: string; // If array, we will append index
    metadata?: string;
    ruleset?: RuleFlags[];
  },
) => {
  const {
    name,
    email,
    pageUrl = 'raw-html',
    pageTitle = 'HTML Content',
    metadata = '',
    ruleset = [RuleFlags.DEFAULT],
  } = config;

  const enableWcagAaa = ruleset.includes(RuleFlags.ENABLE_WCAG_AAA);
  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

  if (enableWcagAaa) {
    tags.push('wcag2aaa');
  }

  const htmlItems = Array.isArray(htmlContent) ? htmlContent : [htmlContent];
  const scanData = [];

  for (let i = 0; i < htmlItems.length; i++) {
    const htmlString = htmlItems[i];
    const dom = new JSDOM(htmlString);

    // Configure axe for node environment
    // eslint-disable-next-line no-await-in-loop
    const axeScanResults = await axe.run(
      dom.window.document.documentElement as unknown as Element,
      {
        runOnly: {
          type: 'tag',
          values: tags,
        },
        resultTypes: ['violations', 'passes', 'incomplete'],
      },
    );
    
    scanData.push({
      axeScanResults,
      pageUrl: htmlItems.length > 1 ? `${pageUrl}-${i + 1}` : pageUrl,
      pageTitle: htmlItems.length > 1 ? `${pageTitle} ${i + 1}` : pageTitle,
    });
  }

  return processAndSubmitResults(scanData, name, email, metadata);
};

export const scanPage = async (
  pages: Page | Page[],
  config: {
    name: string;
    email: string;
    pageTitle?: string;
    metadata?: string;
    ruleset?: RuleFlags[];
  },
) => {
  const {
    name,
    email,
    pageTitle,
    metadata = '',
    ruleset = [RuleFlags.DEFAULT],
  } = config;

  const disableOobee = ruleset.includes(RuleFlags.DISABLE_OOBEE);
  const enableWcagAaa = ruleset.includes(RuleFlags.ENABLE_WCAG_AAA);

  const axeScript = getAxeScriptContent();
  const oobeeFunctions = getOobeeFunctionsScript(disableOobee, enableWcagAaa);

  const pagesArray = Array.isArray(pages) ? pages : [pages];
  const scanData = [];

  for (const page of pagesArray) {
    await page.evaluate(`${axeScript}\n${oobeeFunctions}`);

    // Run the scan inside the page
    const consoleListener = (msg: any) => {
      if (msg.type() === 'error') {
        console.error(`[Browser Console] ${msg.text()}`);
      }
    };
    page.on('console', consoleListener);

    try {
      const scanResult = await page.evaluate(async () => {
        return window.runA11yScan();
      });

      scanData.push({
        axeScanResults: scanResult.axeScanResults,
        pageUrl: page.url(),
        pageTitle: await page.title(),
      });
    } finally {
      page.off('console', consoleListener);
    }
  }

  // Allow override of page title if scanning a single page
  if (!Array.isArray(pages) && pageTitle) {
    scanData[0].pageTitle = pageTitle;
  }

  return processAndSubmitResults(
    scanData,
    name,
    email,
    metadata,
  );
};

export { RuleFlags, a11yRuleLongDescriptionMap, a11yRuleStepByStepGuide, getOobeeFunctionsScript };

// ---------------------------------------------------------------------------
// Color-contrast context enrichment for LLM-assisted fixes
// ---------------------------------------------------------------------------

export type ColorContrastFinding = {
  html: string;
  xpath: string;
  foreground: string;
  background: string;
  contrastRatio: number;
  requiredRatio: number;
  fontSize: string;
  fontWeight: string;
  isLargeText: boolean;
  wcagLevel: 'AA' | 'AAA';
  suggestedForeground: { hex: string; contrastRatio: number };
  suggestedBackground: { hex: string; contrastRatio: number };
  message: string;
};

// WCAG 2.1 relative luminance + contrast ratio (no external dependency)
function _lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function _lum(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b);
}
function _contrast(a: string, b: string): number {
  const l1 = _lum(a), l2 = _lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Minimal HSL <-> hex helpers for lightness walking
function _toHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h * 360, s * 100, l * 100];
}
function _h2r(p: number, q: number, t: number): number {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function _fromHsl(h: number, s: number, l: number): string {
  h /= 360; s /= 100; l /= 100;
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = _h2r(p, q, h + 1 / 3);
    g = _h2r(p, q, h);
    b = _h2r(p, q, h - 1 / 3);
  }
  return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// Walk the lightness channel until the required contrast ratio is met
function _findCompliant(
  toAdjust: string,
  reference: string,
  required: number,
): { hex: string; contrastRatio: number } {
  const [h, s, l] = _toHsl(toAdjust);
  const lighten = _lum(toAdjust) >= _lum(reference);
  let cur = l;
  for (let i = 0; i < 201; i++) {
    cur = lighten ? Math.min(100, cur + 0.5) : Math.max(0, cur - 0.5);
    const candidate = _fromHsl(h, s, cur);
    const ratio = _contrast(candidate, reference);
    if (ratio >= required) return { hex: candidate, contrastRatio: +ratio.toFixed(2) };
    if (cur <= 0 || cur >= 100) break;
  }
  // Fallback to black or white if no compliant shade found (e.g. grey on grey)
  const black = { hex: '#000000', contrastRatio: +_contrast('#000000', reference).toFixed(2) };
  const white = { hex: '#ffffff', contrastRatio: +_contrast('#ffffff', reference).toFixed(2) };
  return black.contrastRatio >= white.contrastRatio ? black : white;
}

function _isLargeText(fontSize: string, fontWeight: string): boolean {
  const px = parseFloat((fontSize.match(/(\d+(?:\.\d+)?)px/) ?? [])[1] ?? '0');
  const bold = fontWeight === 'bold' || parseInt(fontWeight) >= 700;
  return px >= 24 || (bold && px >= 18.67);
}

// Matches axe failureSummary substring:
// "...color contrast of 4.48 (foreground color: #777777, background color: #ffffff,
//  font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1"
const _CC_RE =
  /color contrast of ([\d.]+) \(foreground color: (#[0-9a-fA-F]+), background color: (#[0-9a-fA-F]+), font size: ([^,]+), font weight: ([^)]+)\)[^]*?ratio of ([\d.]+)/;

function _parseMessage(message: string) {
  const m = _CC_RE.exec(message);
  if (!m) return null;
  return {
    contrastRatio: parseFloat(m[1]),
    foreground: m[2].toLowerCase(),
    background: m[3].toLowerCase(),
    fontSize: m[4].trim(),
    fontWeight: m[5].trim(),
    requiredRatio: parseFloat(m[6]),
  };
}

/**
 * Extracts color-contrast findings from scan results returned by scanPage or scanHTML,
 * enriched with WCAG-compliant color suggestions computed server-side.
 *
 * Usage:
 *   const results = await scanPage(page, config);
 *   const findings = getColorContrastContext(results);
 *   // pass findings to LLM for accurate color fixes
 */
export function getColorContrastContext(scanResults: {
  mustFix?: { rules: Record<string, { items: Array<{ html: string; message: string; xpath: string }> }> };
  goodToFix?: { rules: Record<string, { items: Array<{ html: string; message: string; xpath: string }> }> };
}): ColorContrastFinding[] {
  const findings: ColorContrastFinding[] = [];

  for (const [categoryKey, wcagLevel] of [['mustFix', 'AA'], ['goodToFix', 'AA']] as const) {
    const category = scanResults[categoryKey];
    if (!category?.rules) continue;

    for (const [ruleId, rule] of Object.entries(category.rules)) {
      if (ruleId !== 'color-contrast' && ruleId !== 'color-contrast-enhanced') continue;
      if (!rule?.items) continue;

      const level: 'AA' | 'AAA' = ruleId === 'color-contrast-enhanced' ? 'AAA' : 'AA';

      for (const item of rule.items) {
        const parsed = _parseMessage(item.message);
        if (!parsed) continue;

        findings.push({
          html: item.html,
          xpath: item.xpath,
          foreground: parsed.foreground,
          background: parsed.background,
          contrastRatio: parsed.contrastRatio,
          requiredRatio: parsed.requiredRatio,
          fontSize: parsed.fontSize,
          fontWeight: parsed.fontWeight,
          isLargeText: _isLargeText(parsed.fontSize, parsed.fontWeight),
          wcagLevel: level,
          suggestedForeground: _findCompliant(parsed.foreground, parsed.background, parsed.requiredRatio),
          suggestedBackground: _findCompliant(parsed.background, parsed.foreground, parsed.requiredRatio),
          message: item.message,
        });
      }
    }
  }

  return findings;
}

