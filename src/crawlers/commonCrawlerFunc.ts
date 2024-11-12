/* eslint-disable no-unused-vars */
/* eslint-disable no-param-reassign */
import crawlee from 'crawlee';
import axe, { resultGroups } from 'axe-core';
import { axeScript, guiInfoStatusTypes, saflyIconSelector } from '../constants/constants.js';
import { guiInfoLog, silentLogger } from '../logs.js';
import { takeScreenshotForHTMLElements } from '../screenshotFunc/htmlScreenshotFunc.js';
import { isFilePath } from '../constants/common.js';
import customAxeConfig from './customAxeFunctions.js';
import { extractAndGradeText } from './custom/extractAndGradeText.js';

// types
type RuleDetails = {
  [key: string]: any[];
};

type ResultCategory = {
  totalItems: number;
  rules: RuleDetails;
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
  results: any,
  pageTitle: string,
  customFlowDetails?: CustomFlowDetails,
): FilteredResults => {
  const { violations, passes, incomplete, url } = results;

  let totalItems = 0;
  const mustFix = { totalItems: 0, rules: {} };
  const goodToFix = { totalItems: 0, rules: {} };
  const passed = { totalItems: 0, rules: {} };
  const needsReview = { totalItems: 0, rules: {} };

  const process = (item, displayNeedsReview) => {
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

    const addTo = (category, node) => {
      const { html, failureSummary, screenshotPath, target } = node;
      const axeImpact = node.impact;
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

  passes.forEach(item => {
    const { id: rule, help: description, axeImpact, helpUrl, tags, nodes } = item;

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
      passed.rules[rule].items.push({ html });
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
  includeScreenshots,
  page,
  randomToken,
  customFlowDetails,
  selectors = [],
) => {
  // Checking for DOM mutations before proceeding to scan
  await page.evaluate(() => {
    return new Promise(resolve => {
      let timeout;
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
          let mutationKey;

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

  // Call extractAndGradeText to get readability score and flag for difficult-to-read text
  const flag = await extractAndGradeText(page);

  if (!flag) {
      console.warn("Flag was not set as expected in extractAndGradeText.");
  }else{
    console.warn("Flag was set as expected in extractAndGradeText.");
  }

  await crawlee.playwrightUtils.injectFile(page, axeScript);

  const results = await page.evaluate(
    async ({ selectors, saflyIconSelector, customAxeConfig, flag }) => {
      const evaluateAltText = node => {
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
            evaluate: (_node: HTMLElement) => {
              if (flag === false) {
                return true; // nothing flagged, so pass everything
              }
              return false; // fail all elements that match the selector
            },
          },
        ],
        rules: [
          customAxeConfig.rules[0],
          customAxeConfig.rules[1],
          { ...customAxeConfig.rules[2], selector: flag },
        ],
      });         

      // removed needsReview condition
      const defaultResultTypes: resultGroups[] = ['violations', 'passes', 'incomplete'];

      return axe.run(selectors, {
        resultTypes: defaultResultTypes,
      });
    },
    { selectors, saflyIconSelector, customAxeConfig, flag },
  );

  if (includeScreenshots) {
    results.violations = await takeScreenshotForHTMLElements(results.violations, page, randomToken);
    results.incomplete = await takeScreenshotForHTMLElements(results.incomplete, page, randomToken);
  }

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

export const isUrlPdf = url => {
  if (isFilePath(url)) {
    return /\.pdf$/i.test(url);
  }
  const parsedUrl = new URL(url);
  return /\.pdf($|\?|#)/i.test(parsedUrl.pathname) || /\.pdf($|\?|#)/i.test(parsedUrl.href);
};
