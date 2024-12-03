/* eslint-disable no-unused-vars */
/* eslint-disable no-param-reassign */
import crawlee from 'crawlee';
import axe, { AxeResults, ImpactValue, NodeResult, Result, resultGroups, TagValue } from 'axe-core';
import xPathToCss from 'xpath-to-css';
import { Page } from 'playwright';
import { axeScript, guiInfoStatusTypes, saflyIconSelector } from '../constants/constants.js';
import { guiInfoLog, silentLogger } from '../logs.js';
import { takeScreenshotForHTMLElements } from '../screenshotFunc/htmlScreenshotFunc.js';
import { isFilePath } from '../constants/common.js';
import { customAxeConfig } from './customAxeFunctions.js';
import { flagUnlabelledClickableElements } from './custom/flagUnlabelledClickableElements.js';
import { extractAndGradeText } from './custom/extractAndGradeText.js';
import { ItemsInfo } from '../mergeAxeResults.js';

// types
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
  results: AxeResults,
  pageTitle: string,
  customFlowDetails?: CustomFlowDetails,
): FilteredResults => {
  const { violations, passes, incomplete, url } = results;

  let totalItems = 0;
  const mustFix: ResultCategory = { totalItems: 0, rules: {} };
  const goodToFix: ResultCategory = { totalItems: 0, rules: {} };
  const passed: ResultCategory = { totalItems: 0, rules: {} };
  const needsReview: ResultCategory = { totalItems: 0, rules: {} };

  const process = (item: Result, displayNeedsReview: boolean) => {
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

    const addTo = (category: ResultCategory, node) => {
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

export const runAxeScript = async (
  includeScreenshots: boolean,
  page: Page,
  randomToken: string,
  customFlowDetails: CustomFlowDetails,
  selectors = [],
) => {
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

  page.on('console', msg => silentLogger.log({ level: 'info', message: msg.text() }));
  page.on('console', msg => {
    console.log(msg.text()); // This will capture logs from page.evaluate()
  });

  const oobeeAccessibleLabelFlaggedCssSelectors = (await flagUnlabelledClickableElements(page))
    .map(item => item.xpath)
    .map(xPathToCss)
    .join(', ');

  // Call extractAndGradeText to get readability score and flag for difficult-to-read text
  const gradingReadabilityFlag = await extractAndGradeText(page); // Ensure flag is obtained before proceeding
  console.log(gradingReadabilityFlag);

  await crawlee.playwrightUtils.injectFile(page, axeScript);

  const results = await page.evaluate(
    async ({
      selectors,
      saflyIconSelector,
      customAxeConfig,
      oobeeAccessibleLabelFlaggedCssSelectors,
      gradingReadabilityFlag,
    }) => {
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

      // Remove Safly Icon to avoid scanning it
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
            evaluate: (_node: HTMLElement) => {
              if (oobeeAccessibleLabelFlaggedCssSelectors === '') {
                return true; // nothing flagged, so pass everything
              }
              return false; // fail all elements that match the selector
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
                gradingCheck.metadata.messages.incomplete = `The text content may be challenging to understand, with a Flesch-Kincaid Reading Ease score of ${
                  gradingReadabilityFlag
                }.\nThe target passing score is above 50, indicating content that can be understood by education levels up to university graduates.\nA higher score reflects greater ease of understanding.\nFor scores below 50, provide supplemental content and/or versions that helps aid in the original text’s understanding. Some considerations to explore are (but not limited to):\n Simplify the language\n Shorten sentences\n Structure the content\n Provide summaries or simplified versions\n Include visual aids, illustrations\n Provide glossary of difficult terms or acronyms`;
              }

              // Fail if readability issues are detected
            },
          },
        ],
        rules: [
          customAxeConfig.rules[0],
          customAxeConfig.rules[1],
          { ...customAxeConfig.rules[2], selector: oobeeAccessibleLabelFlaggedCssSelectors },
          { ...customAxeConfig.rules[3], select: gradingReadabilityFlag },
        ],
      });

      // Perform the axe accessibility test
      const defaultResultTypes: resultGroups[] = ['violations', 'passes', 'incomplete'];
      return axe.run(selectors, {
        resultTypes: defaultResultTypes,
      });
    },
    {
      selectors,
      saflyIconSelector,
      customAxeConfig,
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

  // console.log('After screenshot processing:', results.violations);  // Check for unexpected changes

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

export const preNavigationHooks = extraHTTPHeaders => {
  return [
    async (crawlingContext, gotoOptions) => {
      if (extraHTTPHeaders) {
        crawlingContext.request.headers = extraHTTPHeaders;
      }
      gotoOptions = { waitUntil: 'networkidle', timeout: 30000 };
    },
  ];
};

export const postNavigationHooks = [
  async _crawlingContext => {
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
