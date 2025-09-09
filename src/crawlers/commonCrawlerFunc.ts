import crawlee, { CrawlingContext, PlaywrightGotoOptions, Request } from 'crawlee';
import axe, { AxeResults, ImpactValue, NodeResult, Result, resultGroups, TagValue } from 'axe-core';
import { BrowserContext, ElementHandle, Page } from 'playwright';
import {
  axeScript,
  disallowedListOfPatterns,
  guiInfoStatusTypes,
  RuleFlags,
  saflyIconSelector,
} from '../constants/constants.js';
import { consoleLogger, guiInfoLog, silentLogger } from '../logs.js';
import { takeScreenshotForHTMLElements } from '../screenshotFunc/htmlScreenshotFunc.js';
import { isFilePath } from '../constants/common.js';
import { extractAndGradeText } from './custom/extractAndGradeText.js';
import { ItemsInfo } from '../mergeAxeResults.js';
import { evaluateAltText } from './custom/evaluateAltText.js';
import { escapeCssSelector } from './custom/escapeCssSelector.js';
import { framesCheck } from './custom/framesCheck.js';
import { findElementByCssSelector } from './custom/findElementByCssSelector.js';
import { getAxeConfiguration } from './custom/getAxeConfiguration.js';
import { flagUnlabelledClickableElements } from './custom/flagUnlabelledClickableElements.js';
import xPathToCss from './custom/xPathToCss.js';
import type { Response as PlaywrightResponse } from 'playwright';
import fs from 'fs';
import { getStoragePath } from '../utils.js';
import path from 'path';

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

const truncateHtml = (html: string, maxBytes = 1024, suffix = '…'): string => {
  const encoder = new TextEncoder();
  if (encoder.encode(html).length <= maxBytes) return html;

  let left = 0;
  let right = html.length;
  let result = '';

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const truncated = html.slice(0, mid) + suffix;
    const bytes = encoder.encode(truncated).length;

    if (bytes <= maxBytes) {
      result = truncated;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return result;
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
    const wcagRegex = /^wcag\d+a+$/;

    if (conformance[0] !== 'best-practice' && !wcagRegex.test(conformance[0])) {
      conformance.sort((a, b) => {
        if (wcagRegex.test(a) && !wcagRegex.test(b)) {
          return -1;
        }
        if (!wcagRegex.test(a) && wcagRegex.test(b)) {
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
      finalHtml = truncateHtml(finalHtml);

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
      const hasWcagA = conformance.some(tag => /^wcag\d*a$/.test(tag));
      const hasWcagAA = conformance.some(tag => /^wcag\d*aa$/.test(tag));
      // const hasWcagAAA = conformance.some(tag => /^wcag\d*aaa$/.test(tag));

      if (displayNeedsReview) {
        addTo(needsReview, node);
      } else if (hasWcagA || hasWcagAA) {
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
      
      const finalHtml = truncateHtml(html);
      passed.rules[rule].items.push({ html: finalHtml, screenshotPath: '', message: '', xpath: '' });

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
  const browserContext: BrowserContext = page.context();
  const requestUrl = page.url();

  try {
    // Checking for DOM mutations before proceeding to scan
    await page.evaluate(() => {
      return new Promise(resolve => {
        let timeout: NodeJS.Timeout;
        let mutationCount = 0;
        const MAX_MUTATIONS = 500;
        const MAX_SAME_MUTATION_LIMIT = 10;
        const mutationHash: Record<string, number> = {};

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
  } catch (e) {
    // do nothing, just continue
  }

  // Omit logging of browser console errors to reduce unnecessary verbosity
  /*
  page.on('console', msg => {
    const type = msg.type();
    if (type === 'error') {
      consoleLogger.error(msg.text());
    } else {
      consoleLogger.info(msg.text());
    }
  });
  */

  const disableOobee = ruleset.includes(RuleFlags.DISABLE_OOBEE);
  const enableWcagAaa = ruleset.includes(RuleFlags.ENABLE_WCAG_AAA);

  const gradingReadabilityFlag = await extractAndGradeText(page); // Ensure flag is obtained before proceeding

  await crawlee.playwrightUtils.injectFile(page, axeScript);

  const results = await page.evaluate(
    async ({
      selectors,
      saflyIconSelector,
      disableOobee,
      enableWcagAaa,
      gradingReadabilityFlag,
      evaluateAltTextFunctionString,
      escapeCssSelectorFunctionString,
      framesCheckFunctionString,
      findElementByCssSelectorFunctionString,
      getAxeConfigurationFunctionString,
      flagUnlabelledClickableElementsFunctionString,
      xPathToCssFunctionString,
    }) => {
      try {
        // Load functions into the browser context
        eval(evaluateAltTextFunctionString);
        eval(escapeCssSelectorFunctionString);
        eval(framesCheckFunctionString);
        eval(findElementByCssSelectorFunctionString);
        eval(flagUnlabelledClickableElementsFunctionString);
        eval(xPathToCssFunctionString);
        eval(getAxeConfigurationFunctionString);
        // remove so that axe does not scan
        document.querySelector(saflyIconSelector)?.remove();

        const oobeeAccessibleLabelFlaggedXpaths = disableOobee
          ? []
          : (await flagUnlabelledClickableElements()).map(item => item.xpath);
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

        const axeConfig = getAxeConfiguration({
          enableWcagAaa,
          gradingReadabilityFlag,
          disableOobee,
        });

        axe.configure(axeConfig);

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
              oobeeAccessibleLabelFlaggedCssSelectors.map(escapeCssSelector);

            // Add oobee violations to Axe's report
            const oobeeAccessibleLabelViolations = {
              id: 'oobee-accessible-label',
              impact: 'serious' as ImpactValue,
              tags: ['wcag2a', 'wcag211', 'wcag412'],
              description: 'Ensures clickable elements have an accessible label.',
              help: 'Clickable elements (i.e. elements with mouse-click interaction) must have accessible labels.',
              helpUrl: 'https://www.deque.com/blog/accessible-aria-buttons',
              nodes: escapedCssSelectors
                .map((cssSelector: string): NodeResult => ({
                  html: findElementByCssSelector(cssSelector),
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
                }))
                .filter(item => item.html),
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
      disableOobee,
      enableWcagAaa,
      gradingReadabilityFlag,
      evaluateAltTextFunctionString: evaluateAltText.toString(),
      escapeCssSelectorFunctionString: escapeCssSelector.toString(),
      framesCheckFunctionString: framesCheck.toString(),
      findElementByCssSelectorFunctionString: findElementByCssSelector.toString(),
      getAxeConfigurationFunctionString: getAxeConfiguration.toString(),
      flagUnlabelledClickableElementsFunctionString: flagUnlabelledClickableElements.toString(),
      xPathToCssFunctionString: xPathToCss.toString(),
    },
  );

  if (includeScreenshots) {
    results.violations = await takeScreenshotForHTMLElements(results.violations, page, randomToken);
    results.incomplete = await takeScreenshotForHTMLElements(results.incomplete, page, randomToken);
  }

  let pageTitle = null;
  try {
    pageTitle = await page.evaluate(() => document.title);
  } catch (e) {
    consoleLogger.info(`Error while getting page title: ${e}`);
    if (page.isClosed()) {
      consoleLogger.info(`Page was closed for ${requestUrl}, creating new page`);
      page = await browserContext.newPage();
      await page.goto(requestUrl, { waitUntil: 'domcontentloaded' });
      pageTitle = await page.evaluate(() => document.title);
    }
  }

  return filterAxeResults(results, pageTitle, customFlowDetails);
};

export const createCrawleeSubFolders = async (
  randomToken: string,
): Promise<{ dataset: crawlee.Dataset; requestQueue: crawlee.RequestQueue }> => {

  const crawleeDir = path.join(getStoragePath(randomToken),"crawlee");

  const dataset = await crawlee.Dataset.open(crawleeDir);
  const requestQueue = await crawlee.RequestQueue.open(crawleeDir);
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

export const failedRequestHandler = async ({ request }: { request: Request }) => {
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

export async function shouldSkipClickDueToDisallowedHref(
  page: Page,
  element: ElementHandle
): Promise<boolean> {
  return await page.evaluate(
    ({ el, disallowedPrefixes }) => {
      function isDisallowedHref(href: string | null): boolean {
        if (!href) return false;
        href = href.toLowerCase();
        return disallowedPrefixes.some((prefix: string) => href.startsWith(prefix));
      }

      const castEl = el as HTMLElement;

      // Check descendant <a href="">
      const descendants = castEl.querySelectorAll('a[href]');
      for (const a of descendants) {
        const href = a.getAttribute('href');
        if (isDisallowedHref(href)) {
          return true;
        }
      }

      // Check self and ancestors for disallowed <a>
      let current: HTMLElement | null = castEl;
      while (current) {
        if (
          current.tagName === 'A' &&
          isDisallowedHref(current.getAttribute('href'))
        ) {
          return true;
        }
        current = current.parentElement;
      }

      return false;
    },
    {
      el: element,
      disallowedPrefixes: disallowedListOfPatterns,
    }
  );
}

/**
 * Check if response should be skipped based on content headers.
 * @param response - Playwright Response object
 * @param requestUrl - Optional: request URL for logging
 * @returns true if the content should be skipped
 */
export const shouldSkipDueToUnsupportedContent = (
  response: PlaywrightResponse,
  requestUrl: string = ''
): boolean => {
  if (!response) return false;

  const headers = response.headers();
  const contentDisposition = headers['content-disposition'] || '';
  const contentType = headers['content-type'] || '';

  if (contentDisposition.includes('attachment')) {
    // consoleLogger.info(`Skipping attachment (content-disposition) at ${requestUrl}`);
    return true;
  }

  if (
    contentType.startsWith('application/') ||
    contentType.includes('octet-stream') ||
    (!contentType.startsWith('text/') && !contentType.includes('html'))
  ) {
    // consoleLogger.info(`Skipping non-processible content-type "${contentType}" at ${requestUrl}`);
    return true;
  }

  return false;
};
