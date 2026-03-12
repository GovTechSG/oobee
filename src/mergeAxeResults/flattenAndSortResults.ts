import { a11yRuleShortDescriptionMap } from '../constants/constants.js';
import type { AllIssues, PageInfo, RuleInfo } from './types.js';

const getTopTenIssues = allIssues => {
  const categories = ['mustFix', 'goodToFix'];
  const rulesWithCounts = [];

  // This is no longer required and shall not be maintained in future
  /*
  const conformanceLevels = {
    wcag2a: 'A',
    wcag2aa: 'AA',
    wcag21aa: 'AA',
    wcag22aa: 'AA',
    wcag2aaa: 'AAA',
  };
  */

  categories.forEach(category => {
    const rules = allIssues.items[category]?.rules || [];

    rules.forEach(rule => {
      // This is not needed anymore since we want to have the clause number too
      /*
      const wcagLevel = rule.conformance[0];
      const aLevel = conformanceLevels[wcagLevel] || wcagLevel;
      */

      rulesWithCounts.push({
        category,
        ruleId: rule.rule,
        // Replace description with new Oobee short description if available
        description: a11yRuleShortDescriptionMap[rule.rule] || rule.description,
        axeImpact: rule.axeImpact,
        conformance: rule.conformance,
        totalItems: rule.totalItems,
      });
    });
  });

  rulesWithCounts.sort((a, b) => b.totalItems - a.totalItems);

  return rulesWithCounts.slice(0, 10);
};

// Helper: Update totalOccurrences for each issue using our urlOccurrencesMap.
// For pages that have only passed items, the map will return undefined, so default to 0.
function updateIssuesWithOccurrences(issuesList: any[], urlOccurrencesMap: Map<string, number>) {
  issuesList.forEach(issue => {
    issue.totalOccurrences = urlOccurrencesMap.get(issue.url) || 0;
  });
}

const flattenAndSortResults = (allIssues: AllIssues, isCustomFlow: boolean) => {
  // Create a map that will sum items only from mustFix, goodToFix, and needsReview.
  const urlOccurrencesMap = new Map<string, number>();

  // Iterate over all categories; update the map only if the category is not "passed"
  ['mustFix', 'goodToFix', 'needsReview', 'passed'].forEach(category => {
    // Accumulate totalItems regardless of category.
    allIssues.totalItems += allIssues.items[category].totalItems;

    allIssues.items[category].rules = Object.entries(allIssues.items[category].rules)
      .map(ruleEntry => {
        const [rule, ruleInfo] = ruleEntry as [string, RuleInfo];
        ruleInfo.pagesAffected = Object.entries(ruleInfo.pagesAffected)
          .map(pageEntry => {
            if (isCustomFlow) {
              const [pageIndex, pageInfo] = pageEntry as unknown as [number, PageInfo];
              // Only update the occurrences map if not passed.
              if (category !== 'passed') {
                urlOccurrencesMap.set(
                  pageInfo.url!,
                  (urlOccurrencesMap.get(pageInfo.url!) || 0) + pageInfo.items.length,
                );
              }
              return { pageIndex, ...pageInfo };
            }
            const [url, pageInfo] = pageEntry as unknown as [string, PageInfo];
            if (category !== 'passed') {
              urlOccurrencesMap.set(url, (urlOccurrencesMap.get(url) || 0) + pageInfo.items.length);
            }
            return { url, ...pageInfo };
          })
          // Sort pages so that those with the most items come first
          .sort((page1, page2) => page2.items.length - page1.items.length);
        return { rule, ...ruleInfo };
      })
      // Sort the rules by totalItems (descending)
      .sort((rule1, rule2) => rule2.totalItems - rule1.totalItems);
  });

  // Sort top pages (assumes topFiveMostIssues is already populated)
  allIssues.topFiveMostIssues.sort((p1, p2) => p2.totalIssues - p1.totalIssues);
  allIssues.topTenPagesWithMostIssues = allIssues.topFiveMostIssues.slice(0, 10);
  allIssues.topFiveMostIssues = allIssues.topFiveMostIssues.slice(0, 5);

  // Update each issue in topTenPagesWithMostIssues with the computed occurrences,
  // excluding passed items.
  updateIssuesWithOccurrences(allIssues.topTenPagesWithMostIssues, urlOccurrencesMap);

  // Get and assign the topTenIssues (using your existing helper)
  const topTenIssues = getTopTenIssues(allIssues);
  allIssues.topTenIssues = topTenIssues;
};

export default flattenAndSortResults;
