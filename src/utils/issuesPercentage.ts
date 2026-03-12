import axe, { Rule } from 'axe-core';
import { getAxeConfiguration } from '../crawlers/custom/getAxeConfiguration.js';
import type { ScanPagesDetail } from './wcagProgress.js';

export const getTotalRulesCount = async (
  enableWcagAaa: boolean,
  disableOobee: boolean,
): Promise<{
  totalRulesMustFix: number;
  totalRulesGoodToFix: number;
  totalRulesMustFixAndGoodToFix: number;
}> => {
  const axeConfig = getAxeConfiguration({
    enableWcagAaa,
    gradingReadabilityFlag: '',
    disableOobee,
  });

  // Get default rules from axe-core
  const defaultRules = axe.getRules();

  // Merge custom rules with default rules, converting RuleMetadata to Rule
  const mergedRules: Rule[] = defaultRules.map(defaultRule => {
    const customRule = axeConfig.rules.find(r => r.id === defaultRule.ruleId);
    if (customRule) {
      // Merge properties from customRule into defaultRule (RuleMetadata) to create a Rule
      return {
        id: defaultRule.ruleId,
        enabled: customRule.enabled,
        selector: customRule.selector,
        any: customRule.any,
        tags: defaultRule.tags,
        metadata: customRule.metadata, // Use custom metadata if it exists
      };
    }
    // Convert defaultRule (RuleMetadata) to Rule
    return {
      id: defaultRule.ruleId,
      enabled: true, // Default to true if not overridden
      tags: defaultRule.tags,
      // No metadata here, since defaultRule.metadata might not exist
    };
  });

  // Add any custom rules that don't override the default rules
  axeConfig.rules.forEach(customRule => {
    if (!mergedRules.some(mergedRule => mergedRule.id === customRule.id)) {
      // Ensure customRule is of type Rule
      const rule: Rule = {
        id: customRule.id,
        enabled: customRule.enabled,
        selector: customRule.selector,
        any: customRule.any,
        tags: customRule.tags,
        metadata: customRule.metadata,
        // Add other properties if needed
      };
      mergedRules.push(rule);
    }
  });

  // Apply the merged configuration to axe-core
  axe.configure({ ...axeConfig, rules: mergedRules });

  // ... (rest of your logic)
  let totalRulesMustFix = 0;
  let totalRulesGoodToFix = 0;

  const wcagRegex = /^wcag\d+a+$/;

  // Use mergedRules instead of rules to check enabled property
  mergedRules.forEach(rule => {
    if (!rule.enabled) {
      return;
    }

    if (rule.id === 'frame-tested') return; // Ignore 'frame-tested' rule

    const tags = rule.tags || [];

    // Skip experimental and deprecated rules
    if (tags.includes('experimental') || tags.includes('deprecated')) {
      return;
    }

    const conformance = tags.filter(tag => tag.startsWith('wcag') || tag === 'best-practice');

    // Ensure conformance level is sorted correctly
    if (
      conformance.length > 0 &&
      conformance[0] !== 'best-practice' &&
      !wcagRegex.test(conformance[0])
    ) {
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

    if (conformance.includes('best-practice')) {
      // console.log(`${totalRulesMustFix} Good To Fix: ${rule.id}`);

      totalRulesGoodToFix += 1; // Categorized as "Good to Fix"
    } else {
      // console.log(`${totalRulesMustFix} Must Fix: ${rule.id}`);

      totalRulesMustFix += 1; // Otherwise, it's "Must Fix"
    }
  });

  return {
    totalRulesMustFix,
    totalRulesGoodToFix,
    totalRulesMustFixAndGoodToFix: totalRulesMustFix + totalRulesGoodToFix,
  };
};

export const getIssuesPercentage = async (
  scanPagesDetail: ScanPagesDetail,
  enableWcagAaa: boolean,
  disableOobee: boolean,
): Promise<{
  avgTypesOfIssuesPercentageOfTotalRulesAtMustFix: string;
  avgTypesOfIssuesPercentageOfTotalRulesAtGoodToFix: string;
  avgTypesOfIssuesPercentageOfTotalRulesAtMustFixAndGoodToFix: string;
  totalRulesMustFix: number;
  totalRulesGoodToFix: number;
  totalRulesMustFixAndGoodToFix: number;
  avgTypesOfIssuesCountAtMustFix: string;
  avgTypesOfIssuesCountAtGoodToFix: string;
  avgTypesOfIssuesCountAtMustFixAndGoodToFix: string;
  pagesAffectedPerRule: Record<string, number>;
  pagesPercentageAffectedPerRule: Record<string, string>;
}> => {
  const pages = scanPagesDetail.pagesAffected || [];
  const totalPages = pages.length;

  const pagesAffectedPerRule: Record<string, number> = {};

  pages.forEach(page => {
    page.typesOfIssues.forEach(issue => {
      if ((issue.occurrencesMustFix || issue.occurrencesGoodToFix) > 0) {
        pagesAffectedPerRule[issue.ruleId] = (pagesAffectedPerRule[issue.ruleId] || 0) + 1;
      }
    });
  });

  const pagesPercentageAffectedPerRule: Record<string, string> = {};
  Object.entries(pagesAffectedPerRule).forEach(([ruleId, count]) => {
    pagesPercentageAffectedPerRule[ruleId] =
      totalPages > 0 ? ((count / totalPages) * 100).toFixed(2) : '0.00';
  });

  const typesOfIssuesCountAtMustFix = pages.map(
    page => page.typesOfIssues.filter(issue => (issue.occurrencesMustFix || 0) > 0).length,
  );

  const typesOfIssuesCountAtGoodToFix = pages.map(
    page => page.typesOfIssues.filter(issue => (issue.occurrencesGoodToFix || 0) > 0).length,
  );

  const typesOfIssuesCountSumMustFixAndGoodToFix = pages.map(
    (_, index) =>
      (typesOfIssuesCountAtMustFix[index] || 0) + (typesOfIssuesCountAtGoodToFix[index] || 0),
  );

  const { totalRulesMustFix, totalRulesGoodToFix, totalRulesMustFixAndGoodToFix } =
    await getTotalRulesCount(enableWcagAaa, disableOobee);

  const avgMustFixPerPage =
    totalPages > 0
      ? typesOfIssuesCountAtMustFix.reduce((sum, count) => sum + count, 0) / totalPages
      : 0;

  const avgGoodToFixPerPage =
    totalPages > 0
      ? typesOfIssuesCountAtGoodToFix.reduce((sum, count) => sum + count, 0) / totalPages
      : 0;

  const avgMustFixAndGoodToFixPerPage =
    totalPages > 0
      ? typesOfIssuesCountSumMustFixAndGoodToFix.reduce((sum, count) => sum + count, 0) / totalPages
      : 0;

  const avgTypesOfIssuesPercentageOfTotalRulesAtMustFix =
    totalRulesMustFix > 0 ? ((avgMustFixPerPage / totalRulesMustFix) * 100).toFixed(2) : '0.00';

  const avgTypesOfIssuesPercentageOfTotalRulesAtGoodToFix =
    totalRulesGoodToFix > 0
      ? ((avgGoodToFixPerPage / totalRulesGoodToFix) * 100).toFixed(2)
      : '0.00';

  const avgTypesOfIssuesPercentageOfTotalRulesAtMustFixAndGoodToFix =
    totalRulesMustFixAndGoodToFix > 0
      ? ((avgMustFixAndGoodToFixPerPage / totalRulesMustFixAndGoodToFix) * 100).toFixed(2)
      : '0.00';

  const avgTypesOfIssuesCountAtMustFix = avgMustFixPerPage.toFixed(2);
  const avgTypesOfIssuesCountAtGoodToFix = avgGoodToFixPerPage.toFixed(2);
  const avgTypesOfIssuesCountAtMustFixAndGoodToFix = avgMustFixAndGoodToFixPerPage.toFixed(2);

  return {
    avgTypesOfIssuesCountAtMustFix,
    avgTypesOfIssuesCountAtGoodToFix,
    avgTypesOfIssuesCountAtMustFixAndGoodToFix,
    avgTypesOfIssuesPercentageOfTotalRulesAtMustFix,
    avgTypesOfIssuesPercentageOfTotalRulesAtGoodToFix,
    avgTypesOfIssuesPercentageOfTotalRulesAtMustFixAndGoodToFix,
    totalRulesMustFix,
    totalRulesGoodToFix,
    totalRulesMustFixAndGoodToFix,
    pagesAffectedPerRule,
    pagesPercentageAffectedPerRule,
  };
};
