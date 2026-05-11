import type { AllIssues, ItemsInfo, RuleInfo } from './types.js';

type ScanItems = AllIssues['items'];
type ScanCategory = ScanItems[keyof ScanItems];
type ScanItemsLight = Pick<ScanItems, 'mustFix' | 'goodToFix' | 'needsReview' | 'passed'>;

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

/*
// Commenting this out for now as we are not including htmlGroups in the embedded report payload to keep it lean.
// We can revisit this if we want to include htmlGroups in the future and need a reference builder for it.
const toHtmlGroupReference = (item: any) => {
  if (typeof item === 'string') {
    return item;
  }

  return `${item?.html || 'No HTML element'}\x00${item?.xpath || ''}`;
};

const cloneCategoryWithReferenceItems = (category: ScanCategory): ScanCategory =>
  ({
    ...category,
    rules: category.rules.map(
      rule =>
        ({
          ...rule,
          pagesAffected: rule.pagesAffected.map(
            page => {
              const { items, ...pageWithoutItems } = page;

              return {
                ...pageWithoutItems,
                itemsCount: page.itemsCount ?? (Array.isArray(items) ? items.length : 0),
                items: Array.isArray(items) ? items.map(toHtmlGroupReference) : items,
              } as any;
            },
          ),
        }) as any,
    ),
  }) as ScanCategory;
*/

const cloneCategoryWithoutPageItems = (category: ScanCategory): ScanCategory =>
  ({
    ...category,
    rules: category.rules.map(
      rule =>
        ({
          ...rule,
          pagesAffected: rule.pagesAffected.map(
            page => {
              const { items, ...rest } = page;

              return {
                ...rest,
                itemsCount: page.itemsCount ?? (Array.isArray(items) ? items.length : 0),
              } as any;
            },
          ),
        }) as any,
    ),
  }) as ScanCategory;

/**
 * Builds the embedded HTML-report payload from the full scan items.
 * The current report path omits page.items and relies on htmlGroups + itemsCount
 * to rebuild per-page occurrences in the browser.
 */
export const convertItemsToReferences = (source: Pick<AllIssues, 'items'>): ScanItemsLight => {
  return {
    mustFix: cloneCategoryWithoutPageItems(source.items.mustFix),
    goodToFix: cloneCategoryWithoutPageItems(source.items.goodToFix),
    needsReview: cloneCategoryWithoutPageItems(source.items.needsReview),
    passed: cloneCategoryWithoutPageItems(source.items.passed),
  };
};
