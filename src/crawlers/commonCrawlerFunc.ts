/* eslint-disable no-unused-vars */
/* eslint-disable no-param-reassign */
import crawlee from 'crawlee';
import axe, { AfterResult, resultGroups } from 'axe-core';
import { axeScript, guiInfoStatusTypes, saflyIconSelector } from '../constants/constants.js';
import { guiInfoLog, silentLogger } from '../logs.js';
import { takeScreenshotForHTMLElements } from '../screenshotFunc/htmlScreenshotFunc.js';
import { isFilePath } from '../constants/common.js';
import { customAxeConfig } from './customAxeFunctions.js';
import { Page } from 'playwright';
import { scrapeTextContent } from './custom/flag_grading_text_contents.js';

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

// Function to filter accessibility results
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
    const levels = ['wcag2a', 'wcag2aa', 'wcag2aaa'];
    if (conformance[0] !== 'best-practice' && !levels.includes(conformance[0])) {
      conformance.sort((a, b) => {
        if (levels.includes(a)) {
          return -1;
        } else if (levels.includes(b)) {
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

      let finalHtml = html.includes('</script>') ? html.replaceAll('</script>', '&lt;/script>') : html;

      const xpath = target.length === 1 && typeof target[0] === 'string' ? target[0] : null;

      // Add in screenshot path
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

// Function to run the axe accessibility script
export const runAxeScript = async (
  includeScreenshots,
  page,
  randomToken,
  customFlowDetails,
  selectors = [],
) => {
  try {
    // Checking for DOM mutations before proceeding to scan
    await page.evaluate(() => {
      return new Promise((resolve) => {
        let timeout;
        let mutationCount = 0;
        const MAX_MUTATIONS = 100;
        const MAX_SAME_MUTATION_LIMIT = 10;
        const mutationHash = {};

        const observer = new MutationObserver((mutationsList) => {
          clearTimeout(timeout);
          mutationCount += 1;

          if (mutationCount > MAX_MUTATIONS) {
            observer.disconnect();
            resolve('Too many mutations detected');
          }

          mutationsList.forEach((mutation) => {
            let mutationKey;

            if (mutation.target instanceof Element) {
              Array.from(mutation.target.attributes).forEach(attr => {
                mutationKey = `${mutation.target.nodeName}-${attr.name}`;
  
                if (mutationKey) {
                  if (!mutationHash[mutationKey]) {
                    mutationHash[mutationKey] = 1;
                  } else {
                    mutationHash[mutationKey]++;
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

    // Logging console messages
    page.on('console', msg => silentLogger.log({ level: 'info', message: msg.text() }));

    console.log('BEFORE ----------------------------------------------------------------------------------------');
    const oobeeAccessibleTextFlagged = (await scrapeTextContent(page));
    console.log('AFTER ----------------------------------------------------------------------------------------');
    console.log('-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=', oobeeAccessibleTextFlagged);

    await crawlee.playwrightUtils.injectFile(page, axeScript);

    const results = await page.evaluate(
      async ({ selectors, saflyIconSelector, customAxeConfig, oobeeAccessibleTextFlagged }) => {
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

        // Remove specific elements so that axe does not scan them
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
              evaluate: (node: HTMLElement) => {
                return false; // Fail all elements
              },
              after: (results: AfterResult[]) => {
                return results.map(result => {
                  return result; // Return results without modification
                });
              },
            },
          ],
          rules: [
            customAxeConfig.rules[0],
            customAxeConfig.rules[1],
            { ...customAxeConfig.rules[2], enabled: true },
            { ...customAxeConfig.rules[3], enabled: true },
          ],
        });

        return await axe.run(selectors);
      },
      { selectors, saflyIconSelector, customAxeConfig, oobeeAccessibleTextFlagged }
    );

    if (includeScreenshots) {
      results.violations = await takeScreenshotForHTMLElements(results.violations, page, randomToken);
      results.incomplete = await takeScreenshotForHTMLElements(results.incomplete, page, randomToken);
    }

    const pageTitle = await page.evaluate(() => document.title);
    return filterAxeResults(results, pageTitle, customFlowDetails);
  } catch (error) {
    console.error("Error running axe script:", error);
    throw new Error("Accessibility check failed");
  }
};

// Function to check if the URL points to a PDF
export const isUrlPdf = (url: string): boolean => {
  const pdfPattern = /\.pdf$/i;
  return pdfPattern.test(url) || isFilePath(url);
};
