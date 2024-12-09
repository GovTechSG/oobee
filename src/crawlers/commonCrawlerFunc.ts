import crawlee, { CrawlingContext, PlaywrightGotoOptions } from 'crawlee';
import axe, { AxeResults, ImpactValue, NodeResult, Result, resultGroups, TagValue } from 'axe-core';
import xPathToCss from 'xpath-to-css';
import { Page } from 'playwright';
import {
  axeScript,
  guiInfoStatusTypes,
  RuleFlags,
  saflyIconSelector,
} from '../constants/constants.js';
import { consoleLogger, guiInfoLog, silentLogger } from '../logs.js';
import { takeScreenshotForHTMLElements } from '../screenshotFunc/htmlScreenshotFunc.js';
import { isFilePath } from '../constants/common.js';
import { customAxeConfig } from './customAxeFunctions.js';
import { flagUnlabelledClickableElements } from './custom/flagUnlabelledClickableElements.js';
import { extractAndGradeText } from './custom/extractAndGradeText.js';
import { ItemsInfo } from '../mergeAxeResults.js';

// types
interface AxeResultsWithScreenshot extends AxeResults {
  passes: ResultWithScreenshot[];
  incomplete: ResultWithScreenshot[];
  violations: ResultWithScreenshot[];
}

export interface ResultWithScreenshot extends Result {
  nodes: NodeResultWithScreenshot[];
}

export interface NodeResultWithScreenshot extends NodeResult {
  screenshotPath?: string;
}

type RuleDetails = {
  description: string;
  axeImpact: ImpactValue;
  helpUrl: string;
  conformance: TagValue[];
  totalItems: number;
  items: ItemsInfo[];
};

type ResultCategory = {
  totalItems: number;
  rules: Record<string, RuleDetails>;
};

type CustomFlowDetails = {
  pageIndex?: any;
  metadata?: any;
  pageImagePath?: any;
};

type FilteredResults = {
  url: string;
  pageTitle: string;
  pageIndex?: any;
  metadata?: any;
  pageImagePath?: any;
  totalItems: number;
  mustFix: ResultCategory;
  goodToFix: ResultCategory;
  needsReview: ResultCategory;
  passed: ResultCategory;
  actualUrl?: string;
};

export const filterAxeResults = (
  results: AxeResultsWithScreenshot,
  pageTitle: string,
  customFlowDetails?: CustomFlowDetails,
): FilteredResults => {
  const { violations, passes, incomplete, url } = results;

  let totalItems = 0;
  const mustFix: ResultCategory = { totalItems: 0, rules: {} };
  const goodToFix: ResultCategory = { totalItems: 0, rules: {} };
  const passed: ResultCategory = { totalItems: 0, rules: {} };
  const needsReview: ResultCategory = { totalItems: 0, rules: {} };

  const process = (item: ResultWithScreenshot, displayNeedsReview: boolean) => {
    const { id: rule, help: description, helpUrl, tags, nodes } = item;

    if (rule === 'frame-tested') return;

    const conformance = tags.filter(tag => tag.startsWith('wcag') || tag === 'best-practice');

    // handle rare cases where conformance level is not the first element
    const levels = ['wcag2a', 'wcag2aa', 'wcag2aaa'];
    if (conformance[0] !== 'best-practice' && !levels.includes(conformance[0])) {
      conformance.sort((a, b) => {
        if (levels.includes(a)) {
          return -1;
        }
        if (levels.includes(b)) {
          return 1;
        }

        return 0;
      });
    }

    const addTo = (category: ResultCategory, node: NodeResultWithScreenshot) => {
      const { html, failureSummary, screenshotPath, target, impact: axeImpact } = node;
      if (!(rule in category.rules)) {
        category.rules[rule] = {
          description,
          axeImpact,
          helpUrl,
          conformance,
          totalItems: 0,
          items: [],
        };
      }
      const message = displayNeedsReview
        ? failureSummary.slice(failureSummary.indexOf('\n') + 1).trim()
        : failureSummary;

      let finalHtml = html;
      if (html.includes('</script>')) {
        finalHtml = html.replaceAll('</script>', '&lt;/script>');
      }

      const xpath = target.length === 1 && typeof target[0] === 'string' ? target[0] : null;

      // add in screenshot path
      category.rules[rule].items.push({
        html: finalHtml,
        message,
        screenshotPath,
        xpath: xpath || undefined,
        displayNeedsReview: displayNeedsReview || undefined,
      });
      category.rules[rule].totalItems += 1;
      category.totalItems += 1;
      totalItems += 1;
    };

    nodes.forEach(node => {
      const { impact } = node;
      if (displayNeedsReview) {
        addTo(needsReview, node);
      } else if (impact === 'critical' || impact === 'serious') {
        addTo(mustFix, node);
      } else {
        addTo(goodToFix, node);
      }
    });
  };

  violations.forEach(item => process(item, false));
  incomplete.forEach(item => process(item, true));

  passes.forEach((item: Result) => {
    const { id: rule, help: description, impact: axeImpact, helpUrl, tags, nodes } = item;

    if (rule === 'frame-tested') return;

    const conformance = tags.filter(tag => tag.startsWith('wcag') || tag === 'best-practice');

    nodes.forEach(node => {
      const { html } = node;
      if (!(rule in passed.rules)) {
        passed.rules[rule] = {
          description,
          axeImpact,
          helpUrl,
          conformance,
          totalItems: 0,
          items: [],
        };
      }
      passed.rules[rule].items.push({ html, screenshotPath: '', message: '', xpath: '' });
      passed.totalItems += 1;
      passed.rules[rule].totalItems += 1;
      totalItems += 1;
    });
  });

  return {
    url,
    pageTitle: customFlowDetails ? `${customFlowDetails.pageIndex}: ${pageTitle}` : pageTitle,
    pageIndex: customFlowDetails ? customFlowDetails.pageIndex : undefined,
    metadata: customFlowDetails?.metadata
      ? `${customFlowDetails.pageIndex}: ${customFlowDetails.metadata}`
      : undefined,
    pageImagePath: customFlowDetails ? customFlowDetails.pageImagePath : undefined,
    totalItems,
    mustFix,
    goodToFix,
    needsReview,
    passed,
  };
};

export const runAxeScript = async ({
  includeScreenshots,
  page,
  randomToken,
  customFlowDetails = null,
  selectors = [],
  ruleset = [],
}: {
  includeScreenshots: boolean;
  page: Page;
  randomToken: string;
  customFlowDetails?: CustomFlowDetails;
  selectors?: string[];
  ruleset?: RuleFlags[];
}) => {
  // Checking for DOM mutations before proceeding to scan
  await page.evaluate(() => {
    return new Promise(resolve => {
      let timeout: NodeJS.Timeout;
      let mutationCount = 0;
      const MAX_MUTATIONS = 100;
      const MAX_SAME_MUTATION_LIMIT = 10;
      const mutationHash = {};

      const observer = new MutationObserver(mutationsList => {
        clearTimeout(timeout);

        mutationCount += 1;

        if (mutationCount > MAX_MUTATIONS) {
          observer.disconnect();
          resolve('Too many mutations detected');
        }

        // To handle scenario where DOM elements are constantly changing and unable to exit
        mutationsList.forEach(mutation => {
          let mutationKey: string;

          if (mutation.target instanceof Element) {
            Array.from(mutation.target.attributes).forEach(attr => {
              mutationKey = `${mutation.target.nodeName}-${attr.name}`;

              if (mutationKey) {
                if (!mutationHash[mutationKey]) {
                  mutationHash[mutationKey] = 1;
                } else {
                  mutationHash[mutationKey] += 1;
                }

                if (mutationHash[mutationKey] >= MAX_SAME_MUTATION_LIMIT) {
                  observer.disconnect();
                  resolve(`Repeated mutation detected for ${mutationKey}`);
                }
              }
            });
          }
        });

        timeout = setTimeout(() => {
          observer.disconnect();
          resolve('DOM stabilized after mutations.');
        }, 1000);
      });

      timeout = setTimeout(() => {
        observer.disconnect();
        resolve('No mutations detected, exit from idle state');
      }, 1000);

      observer.observe(document, { childList: true, subtree: true, attributes: true });
    });
  });

  page.on('console', msg => {
    const type = msg.type();
    if (type === 'error') {
      silentLogger.log({ level: 'error', message: msg.text() });
    } else {
      silentLogger.log({ level: 'info', message: msg.text() });
    }
  });

  const disableOobee = ruleset.includes(RuleFlags.DISABLE_OOBEE);
  const oobeeAccessibleLabelFlaggedXpaths = disableOobee
    ? []
    : (await flagUnlabelledClickableElements(page)).map(item => item.xpath);
  const oobeeAccessibleLabelFlaggedCssSelectors = oobeeAccessibleLabelFlaggedXpaths
    .map(xpath => {
      try {
        const cssSelector = xPathToCss(xpath);
        return cssSelector;
      } catch (e) {
        console.error('Error converting XPath to CSS: ', xpath, e);
        return '';
      }
    })
    .filter(item => item !== '');

  const enableWcagAaa = ruleset.includes(RuleFlags.ENABLE_WCAG_AAA);

  const gradingReadabilityFlag = await extractAndGradeText(page); // Ensure flag is obtained before proceeding
  console.log(gradingReadabilityFlag);

  await crawlee.playwrightUtils.injectFile(page, axeScript);

  const results = await page.evaluate(
    async ({
      selectors,
      saflyIconSelector,
      customAxeConfig,
      disableOobee,
      enableWcagAaa,
      oobeeAccessibleLabelFlaggedCssSelectors,
      gradingReadabilityFlag,
    }) => {
      try {
        const evaluateAltText = (node: Element) => {
          const altText = node.getAttribute('alt');
          const confusingTexts = ['img', 'image', 'picture', 'photo', 'graphic'];

          if (altText) {
            const trimmedAltText = altText.trim().toLowerCase();
            if (confusingTexts.includes(trimmedAltText)) {
              return false;
            }
          }
          return true;
        };

        // for css id selectors starting with a digit, escape it with the unicode character e.g. #123 -> #\31 23
        const escapeCSSSelector = (selector: string) => {
          try {
            return selector.replace(
              /([#\.])(\d)/g,
              (_match, prefix, digit) => `${prefix}\\3${digit} `,
            );
          } catch (e) {
            console.error(`error escaping css selector: ${selector}`, e);
            return selector;
          }
        };

        // remove so that axe does not scan
        document.querySelector(saflyIconSelector)?.remove();

        axe.configure({
          branding: customAxeConfig.branding,
          checks: [
            {
              ...customAxeConfig.checks[0],
              evaluate: evaluateAltText,
            },
            {
              ...customAxeConfig.checks[1],
              evaluate: (node: Element) => {
                return !node.dataset.flagged; // fail any element with a data-flagged attribute set to true
              },
            },
            {
              ...customAxeConfig.checks[2],
              evaluate: (_node: HTMLElement) => {
                console.log('Readability flag check triggered');
                if (gradingReadabilityFlag === '') {
                  console.log('No readability issues detected');
                  return true; // Pass if no readability issues
                }
                console.log('Readability issues detected');
                // Dynamically update the grading messages
                const gradingCheck = customAxeConfig.checks.find(
                  check => check.id === 'oobee-grading-text-contents',
                );
                if (gradingCheck) {
                  gradingCheck.metadata.messages.fail =
                    'The text content is potentially difficult to read, with a Flesch-Kincaid Reading Ease score of ' +
                    gradingReadabilityFlag +
                    '.\nThe target passing score is above 50, indicating content readable by university students and lower grade levels.\nA higher score reflects better readability.';
                }

                return false; // Fail if readability issues are detected
              },
            },
            {
              ...customAxeConfig.checks[2],
              evaluate: (_node: HTMLElement) => {
                // console.log('Evaluate function triggered');
                // if (flag === true) {
                //   console.warn('Readability issues detected passed');
                //   return true; // nothing flagged, so pass everything
                // }
                // console.warn('Readability issues detected failed');
                // return false; // fail all elements that match the selector
                // console.log('Flag in evaluate:', flag);
                // return flag ? true : false; // Fail if flag is true, pass if false
                if (gradingReadabilityFlag === '') {
                  console.log('No readability issues detected');
                  return true; // Pass if no readability issues
                }
                console.log('Readability issues detected');
                // Dynamically update the grading messages
                const gradingCheck = customAxeConfig.checks.find(
                  check => check.id === 'oobee-grading-text-contents',
                );
                if (gradingCheck) {
                  gradingCheck.metadata.messages.fail = `The text content is potentially difficult to read, with a Flesch-Kincaid Reading Ease score of ${gradingReadabilityFlag}. The target passing score is above 50, indicating content readable by university students and lower grade levels. A higher score reflects better readability.`;
                }

                return false;
              },
            },
          ],
          rules: customAxeConfig.rules
            .filter(rule => (disableOobee ? !rule.id.startsWith('oobee') : true))
            .concat(
              enableWcagAaa
                ? [
                    {
                      id: 'color-contrast-enhanced',
                      enabled: true,
                      tags: ['wcag2aaa', 'wcag146'],
                    },
                    {
                      id: 'identical-links-same-purpose',
                      enabled: true,
                      tags: ['wcag2aaa', 'wcag249'],
                    },
                    {
                      id: 'meta-refresh-no-exceptions',
                      enabled: true,
                      tags: ['wcag2aaa', 'wcag224', 'wcag325'],
                    },
                  ]
                : [],
            ),
        });

        // removed needsReview condition
        const defaultResultTypes: resultGroups[] = ['violations', 'passes', 'incomplete'];

        return axe
          .run(selectors, {
            resultTypes: defaultResultTypes,
          })
          .then(results => {
            if (disableOobee) {
              return results;
            }
            // handle css id selectors that start with a digit
            const escapedCssSelectors =
              oobeeAccessibleLabelFlaggedCssSelectors.map(escapeCSSSelector);

            function findElementByCssSelector(cssSelector: string): string | null {
              let element = document.querySelector(cssSelector);
              if (!element) {
                const shadowRoots = [];
                const allElements = document.querySelectorAll('*');
                
                // Look for elements with shadow roots
                allElements.forEach(el => {
                  if (el.shadowRoot) {
                    shadowRoots.push(el.shadowRoot);
                  }
                });
          
                // Search inside each shadow root for the element
                for (const shadowRoot of shadowRoots) {
                  const shadowElement = shadowRoot.querySelector(cssSelector);
                  if (shadowElement) {
                    element = shadowElement;  // Found the element inside shadow DOM
                    break;
                  }
                }
              }
              return element ? element.outerHTML : null;
            }

            // Add oobee violations to Axe's report
            const oobeeAccessibleLabelViolations = {
              id: 'oobee-accessible-label',
              impact: 'serious' as ImpactValue,
              tags: ['wcag2a', 'wcag211', 'wcag243', 'wcag412'],
              description: 'Ensures clickable elements have an accessible label.',
              help: 'Clickable elements (i.e. elements with mouse-click interaction) must have accessible labels.',
              helpUrl: 'https://www.deque.com/blog/accessible-aria-buttons',
              nodes: escapedCssSelectors.map(cssSelector => ({
                html: document.querySelector(cssSelector).outerHTML,
                target: [cssSelector],
                impact: 'serious' as ImpactValue,
                failureSummary:
                  'Fix any of the following:\n  The clickable element does not have an accessible label.',
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
              })),
            };

            results.violations = [...results.violations, oobeeAccessibleLabelViolations];
            return results;
          })
          .catch(e => {
            console.error('Error at axe.run', e);
            throw e;
          });
      } catch (e) {
        console.error(e);
        throw e;
      }
    },
    {
      selectors,
      saflyIconSelector,
      customAxeConfig,
      disableOobee,
      enableWcagAaa,
      oobeeAccessibleLabelFlaggedCssSelectors,
      gradingReadabilityFlag,
    },
  );

  if (includeScreenshots) {
    // console.log('Before screenshot processing:', results.violations);
    results.violations = await takeScreenshotForHTMLElements(results.violations, page, randomToken);
    results.incomplete = await takeScreenshotForHTMLElements(results.incomplete, page, randomToken);
  }

  console.log(results);

  const pageTitle = await page.evaluate(() => document.title);

  return filterAxeResults(results, pageTitle, customFlowDetails);
};

export const createCrawleeSubFolders = async (
  randomToken: string,
): Promise<{ dataset: crawlee.Dataset; requestQueue: crawlee.RequestQueue }> => {
  const dataset = await crawlee.Dataset.open(randomToken);
  const requestQueue = await crawlee.RequestQueue.open(randomToken);
  return { dataset, requestQueue };
};

export const preNavigationHooks = (extraHTTPHeaders: Record<string, string>) => {
  return [
    async (crawlingContext: CrawlingContext, gotoOptions: PlaywrightGotoOptions) => {
      if (extraHTTPHeaders) {
        crawlingContext.request.headers = extraHTTPHeaders;
      }
      gotoOptions = { waitUntil: 'networkidle', timeout: 30000 };
    },
  ];
};

export const postNavigationHooks = [
  async (_crawlingContext: CrawlingContext) => {
    guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  },
];

export const failedRequestHandler = async ({ request }) => {
  guiInfoLog(guiInfoStatusTypes.ERROR, { numScanned: 0, urlScanned: request.url });
  crawlee.log.error(`Failed Request - ${request.url}: ${request.errorMessages}`);
};

export const isUrlPdf = (url: string) => {
  if (isFilePath(url)) {
    return /\.pdf$/i.test(url);
  }
  const parsedUrl = new URL(url);
  return /\.pdf($|\?|#)/i.test(parsedUrl.pathname) || /\.pdf($|\?|#)/i.test(parsedUrl.href);
};
