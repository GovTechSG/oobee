import type { AllIssues } from './types.js';

/**
 * Build allIssues.scanPagesDetail and allIssues.scanPagesSummary
 * by analyzing pagesScanned (including mustFix/goodToFix/etc.).
 */
export default function populateScanPagesDetail(allIssues: AllIssues): void {
  const allScannedPages = Array.isArray(allIssues.pagesScanned) ? allIssues.pagesScanned : [];

  const mustFixCategory = 'mustFix';
  const goodToFixCategory = 'goodToFix';
  const needsReviewCategory = 'needsReview';
  const passedCategory = 'passed';

  type RuleData = {
    ruleId: string;
    wcagConformance: string[];
    occurrencesMustFix: number;
    occurrencesGoodToFix: number;
    occurrencesNeedsReview: number;
    occurrencesPassed: number;
  };

  type PageData = {
    pageTitle: string;
    url: string;
    totalOccurrencesFailedIncludingNeedsReview: number;
    totalOccurrencesFailedExcludingNeedsReview: number;
    totalOccurrencesNeedsReview: number;
    totalOccurrencesPassed: number;
    typesOfIssues: Record<string, RuleData>;
  };

  const pagesMap: Record<string, PageData> = {};

  Object.entries(allIssues.items).forEach(([categoryName, categoryData]) => {
    if (!categoryData?.rules) return;

    categoryData.rules.forEach(rule => {
      const { rule: ruleId, conformance = [] } = rule;

      rule.pagesAffected.forEach(p => {
        const { url, pageTitle, items = [] } = p;
        const itemsCount = items.length;

        if (!pagesMap[url]) {
          pagesMap[url] = {
            pageTitle,
            url,
            totalOccurrencesFailedIncludingNeedsReview: 0,
            totalOccurrencesFailedExcludingNeedsReview: 0,
            totalOccurrencesNeedsReview: 0,
            totalOccurrencesPassed: 0,
            typesOfIssues: {},
          };
        }

        if (!pagesMap[url].typesOfIssues[ruleId]) {
          pagesMap[url].typesOfIssues[ruleId] = {
            ruleId,
            wcagConformance: conformance,
            occurrencesMustFix: 0,
            occurrencesGoodToFix: 0,
            occurrencesNeedsReview: 0,
            occurrencesPassed: 0,
          };
        }

        if (categoryName === mustFixCategory) {
          pagesMap[url].typesOfIssues[ruleId].occurrencesMustFix += itemsCount;
          pagesMap[url].totalOccurrencesFailedIncludingNeedsReview += itemsCount;
          pagesMap[url].totalOccurrencesFailedExcludingNeedsReview += itemsCount;
        } else if (categoryName === goodToFixCategory) {
          pagesMap[url].typesOfIssues[ruleId].occurrencesGoodToFix += itemsCount;
          pagesMap[url].totalOccurrencesFailedIncludingNeedsReview += itemsCount;
          pagesMap[url].totalOccurrencesFailedExcludingNeedsReview += itemsCount;
        } else if (categoryName === needsReviewCategory) {
          pagesMap[url].typesOfIssues[ruleId].occurrencesNeedsReview += itemsCount;
          pagesMap[url].totalOccurrencesFailedIncludingNeedsReview += itemsCount;
          pagesMap[url].totalOccurrencesNeedsReview += itemsCount;
        } else if (categoryName === passedCategory) {
          pagesMap[url].typesOfIssues[ruleId].occurrencesPassed += itemsCount;
          pagesMap[url].totalOccurrencesPassed += itemsCount;
        }
      });
    });
  });

  const pagesInMap = Object.values(pagesMap);
  const pagesInMapUrls = new Set(Object.keys(pagesMap));

  const pagesAllPassed = pagesInMap.filter(p => p.totalOccurrencesFailedIncludingNeedsReview === 0);

  const pagesNoEntries = allScannedPages
    .filter(sp => !pagesInMapUrls.has(sp.url))
    .map(sp => ({
      pageTitle: sp.pageTitle,
      url: sp.url,
      totalOccurrencesFailedIncludingNeedsReview: 0,
      totalOccurrencesFailedExcludingNeedsReview: 0,
      totalOccurrencesNeedsReview: 0,
      totalOccurrencesPassed: 0,
      typesOfIssues: {},
    }));

  const pagesNotAffectedRaw = [...pagesAllPassed, ...pagesNoEntries];
  const pagesAffectedRaw = pagesInMap.filter(p => p.totalOccurrencesFailedIncludingNeedsReview > 0);

  function transformPageData(page: PageData) {
    const typesOfIssuesArray = Object.values(page.typesOfIssues);
    const mustFixSum = typesOfIssuesArray.reduce((acc, r) => acc + r.occurrencesMustFix, 0);
    const goodToFixSum = typesOfIssuesArray.reduce((acc, r) => acc + r.occurrencesGoodToFix, 0);
    const needsReviewSum = typesOfIssuesArray.reduce((acc, r) => acc + r.occurrencesNeedsReview, 0);

    const categoriesPresent: string[] = [];
    if (mustFixSum > 0) categoriesPresent.push('mustFix');
    if (goodToFixSum > 0) categoriesPresent.push('goodToFix');
    if (needsReviewSum > 0) categoriesPresent.push('needsReview');

    const failedRuleIds = new Set<string>();
    typesOfIssuesArray.forEach(r => {
      if (
        (r.occurrencesMustFix || 0) > 0 ||
        (r.occurrencesGoodToFix || 0) > 0 ||
        (r.occurrencesNeedsReview || 0) > 0
      ) {
        failedRuleIds.add(r.ruleId);
      }
    });
    const failedRuleCount = failedRuleIds.size;

    const typesOfIssuesExcludingNeedsReviewCount = typesOfIssuesArray.filter(
      r => (r.occurrencesMustFix || 0) + (r.occurrencesGoodToFix || 0) > 0,
    ).length;

    const typesOfIssuesExclusiveToNeedsReviewCount = typesOfIssuesArray.filter(
      r =>
        (r.occurrencesNeedsReview || 0) > 0 &&
        (r.occurrencesMustFix || 0) === 0 &&
        (r.occurrencesGoodToFix || 0) === 0,
    ).length;

    const allConformance = typesOfIssuesArray.reduce((acc, curr) => {
      const nonPassedCount =
        (curr.occurrencesMustFix || 0) +
        (curr.occurrencesGoodToFix || 0) +
        (curr.occurrencesNeedsReview || 0);

      if (nonPassedCount > 0) {
        return acc.concat(curr.wcagConformance || []);
      }
      return acc;
    }, [] as string[]);
    const conformance = Array.from(new Set(allConformance));

    return {
      pageTitle: page.pageTitle,
      url: page.url,
      totalOccurrencesFailedIncludingNeedsReview: page.totalOccurrencesFailedIncludingNeedsReview,
      totalOccurrencesFailedExcludingNeedsReview: page.totalOccurrencesFailedExcludingNeedsReview,
      totalOccurrencesMustFix: mustFixSum,
      totalOccurrencesGoodToFix: goodToFixSum,
      totalOccurrencesNeedsReview: needsReviewSum,
      totalOccurrencesPassed: page.totalOccurrencesPassed,
      typesOfIssuesExclusiveToNeedsReviewCount,
      typesOfIssuesCount: failedRuleCount,
      typesOfIssuesExcludingNeedsReviewCount,
      categoriesPresent,
      conformance,
      typesOfIssues: typesOfIssuesArray,
    };
  }

  const pagesAffected = pagesAffectedRaw.map(transformPageData);
  const pagesNotAffected = pagesNotAffectedRaw.map(transformPageData);
  pagesAffected.sort((a, b) => b.typesOfIssuesCount - a.typesOfIssuesCount);
  pagesNotAffected.sort((a, b) => b.typesOfIssuesCount - a.typesOfIssuesCount);

  const scannedPagesCount = pagesAffected.length + pagesNotAffected.length;
  const pagesNotScannedCount = Array.isArray(allIssues.pagesNotScanned)
    ? allIssues.pagesNotScanned.length
    : 0;

  allIssues.scanPagesDetail = {
    pagesAffected,
    pagesNotAffected,
    scannedPagesCount,
    pagesNotScanned: Array.isArray(allIssues.pagesNotScanned) ? allIssues.pagesNotScanned : [],
    pagesNotScannedCount,
  };

  function stripTypesOfIssues(page: ReturnType<typeof transformPageData>) {
    const { typesOfIssues, ...rest } = page;
    return rest;
  }

  const summaryPagesAffected = pagesAffected.map(stripTypesOfIssues);
  const summaryPagesNotAffected = pagesNotAffected.map(stripTypesOfIssues);

  allIssues.scanPagesSummary = {
    pagesAffected: summaryPagesAffected,
    pagesNotAffected: summaryPagesNotAffected,
    scannedPagesCount,
    pagesNotScanned: Array.isArray(allIssues.pagesNotScanned) ? allIssues.pagesNotScanned : [],
    pagesNotScannedCount,
  };
}
