import type { AllIssues, ItemsInfo, RuleInfo } from './types.js';

/**
 * Builds pre-computed HTML groups to optimize Group by HTML Element functionality.
 * Keys are composite "html\x00xpath" strings to ensure unique matching per element instance.
 */
export const buildHtmlGroups = (rule: RuleInfo, items: ItemsInfo[], pageUrl: string) => {
  if (!rule.htmlGroups) {
    rule.htmlGroups = {};
  }

  items.forEach(item => {
    // Use composite key of html + xpath for precise matching
    const htmlKey = `${item.html || 'No HTML element'}\x00${item.xpath || ''}`;

    if (!rule.htmlGroups![htmlKey]) {
      // Create new group with the first occurrence
      rule.htmlGroups![htmlKey] = {
        html: item.html || '',
        xpath: item.xpath || '',
        message: item.message || '',
        screenshotPath: item.screenshotPath || '',
        displayNeedsReview: item.displayNeedsReview,
        pageUrls: [],
      };
    }

    if (!rule.htmlGroups![htmlKey].pageUrls.includes(pageUrl)) {
      rule.htmlGroups![htmlKey].pageUrls.push(pageUrl);
    }
  });
};

/**
 * Converts items in pagesAffected to references (html\x00xpath composite keys) for embedding in HTML report.
 * Additionally, it deep-clones allIssues, replaces page.items objects with composite reference keys.
 * Those refs are specifically for htmlGroups lookup (html + xpath).
 */
export const convertItemsToReferences = (allIssues: AllIssues): AllIssues => {
  const cloned = JSON.parse(JSON.stringify(allIssues));

  ['mustFix', 'goodToFix', 'needsReview', 'passed'].forEach(category => {
    if (!cloned.items[category]?.rules) return;

    cloned.items[category].rules.forEach((rule: any) => {
      if (!rule.pagesAffected || !rule.htmlGroups) return;

      rule.pagesAffected.forEach((page: any) => {
        if (!page.items) return;

        page.items = page.items.map((item: any) => {
          if (typeof item === 'string') return item; // Already a reference
          // Use composite key matching buildHtmlGroups
          const htmlKey = `${item.html || 'No HTML element'}\x00${item.xpath || ''}`;
          return htmlKey;
        });
      });
    });
  });

  return cloned;
};
