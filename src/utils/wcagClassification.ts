import axe, { Rule } from 'axe-core';
import { getAxeConfiguration } from '../crawlers/custom/getAxeConfiguration.js';

/**
 * Dynamically generates a map of WCAG criteria IDs to their details (name and level)
 * Reuses the rule processing logic from getTotalRulesCount
 */
export const getWcagCriteriaMap = async (
  enableWcagAaa: boolean = true,
  disableOobee: boolean = false,
): Promise<Record<string, { name: string; level: string }>> => {
  // Reuse the configuration setup from getTotalRulesCount
  const axeConfig = getAxeConfiguration({
    enableWcagAaa,
    gradingReadabilityFlag: '',
    disableOobee,
  });

  // Get default rules from axe-core
  const defaultRules = axe.getRules();

  // Merge custom rules with default rules
  const mergedRules: Rule[] = defaultRules.map(defaultRule => {
    const customRule = axeConfig.rules.find(r => r.id === defaultRule.ruleId);
    if (customRule) {
      return {
        id: defaultRule.ruleId,
        enabled: customRule.enabled,
        selector: customRule.selector,
        any: customRule.any,
        tags: defaultRule.tags,
        metadata: customRule.metadata,
      };
    }
    return {
      id: defaultRule.ruleId,
      enabled: true,
      tags: defaultRule.tags,
    };
  });

  // Add custom rules that don't override default rules
  axeConfig.rules.forEach(customRule => {
    if (!mergedRules.some(rule => rule.id === customRule.id)) {
      mergedRules.push({
        id: customRule.id,
        enabled: customRule.enabled,
        selector: customRule.selector,
        any: customRule.any,
        tags: customRule.tags,
        metadata: customRule.metadata,
      });
    }
  });

  // Apply configuration
  axe.configure({ ...axeConfig, rules: mergedRules });

  // Build WCAG criteria map
  const wcagCriteriaMap: Record<string, { name: string; level: string }> = {};

  // Process rules to extract WCAG information
  mergedRules.forEach(rule => {
    if (!rule.enabled) return;
    if (rule.id === 'frame-tested') return;

    const tags = rule.tags || [];
    if (tags.includes('experimental') || tags.includes('deprecated')) return;

    // Look for WCAG criteria tags (format: wcag111, wcag143, etc.)
    tags.forEach(tag => {
      const wcagMatch = tag.match(/^wcag(\d+)$/);
      if (wcagMatch) {
        const wcagId = tag;

        // Default values
        let level = 'a';
        let name = '';

        // Try to extract better info from metadata if available
        const metadata = rule.metadata as any;
        if (metadata && metadata.wcag) {
          const wcagInfo = metadata.wcag as any;

          // Find matching criterion in metadata
          for (const key in wcagInfo) {
            const criterion = wcagInfo[key];
            if (
              criterion &&
              criterion.num &&
              `wcag${criterion.num.replace(/\./g, '')}` === wcagId
            ) {
              // Extract level
              if (criterion.level) {
                level = String(criterion.level).toLowerCase();
              }

              // Extract name
              if (criterion.handle) {
                name = String(criterion.handle);
              } else if (criterion.id) {
                name = String(criterion.id);
              } else if (criterion.num) {
                name = `wcag-${String(criterion.num).replace(/\./g, '-')}`;
              }

              break;
            }
          }
        }

        // Generate fallback name if none found
        if (!name) {
          const numStr = wcagMatch[1];
          const formattedNum = numStr.replace(/(\d)(\d)(\d+)?/, '$1.$2.$3');
          name = `wcag-${formattedNum.replace(/\./g, '-')}`;
        }

        // Store in map
        wcagCriteriaMap[wcagId] = {
          name: name.toLowerCase().replace(/_/g, '-'),
          level,
        };
      }
    });
  });

  return wcagCriteriaMap;
};

/**
 * Determines which WCAG criteria might appear in the "needsReview" category
 * based on axe-core's rule configuration.
 *
 * This dynamically analyzes the rules that might produce "incomplete" results which
 * get categorized as "needsReview" during scans.
 *
 * @param enableWcagAaa Whether to include WCAG AAA criteria
 * @param disableOobee Whether to disable custom Oobee rules
 * @returns A map of WCAG criteria IDs to whether they may produce needsReview results
 */
export const getPotentialNeedsReviewWcagCriteria = async (
  enableWcagAaa: boolean = true,
  disableOobee: boolean = false,
): Promise<Record<string, boolean>> => {
  // Reuse configuration setup from other functions
  const axeConfig = getAxeConfiguration({
    enableWcagAaa,
    gradingReadabilityFlag: '',
    disableOobee,
  });

  // Configure axe-core with our settings
  axe.configure(axeConfig);

  // Get all rules from axe-core
  const allRules = axe.getRules();

  // Set to store rule IDs that might produce incomplete results
  const rulesLikelyToProduceIncomplete = new Set<string>();

  // Dynamically analyze each rule and its checks to determine if it might produce incomplete results
  for (const rule of allRules) {
    try {
      // Skip disabled rules
      const customRule = axeConfig.rules.find(r => r.id === rule.ruleId);
      if (customRule && customRule.enabled === false) continue;

      // Skip frame-tested rule as it's handled specially
      if (rule.ruleId === 'frame-tested') continue;

      // Get the rule object from axe-core's internal data
      const ruleObj = (axe as any)._audit?.rules?.find(r => r.id === rule.ruleId);
      if (!ruleObj) continue;

      // For each check in the rule, determine if it might produce an "incomplete" result
      const checks = [...(ruleObj.any || []), ...(ruleObj.all || []), ...(ruleObj.none || [])];

      // Get check details from axe-core's internal data
      for (const checkId of checks) {
        const check = (axe as any)._audit?.checks?.[checkId];
        if (!check) continue;

        // A check can produce incomplete results if:
        // 1. It has an "incomplete" message
        // 2. Its evaluate function explicitly returns undefined
        // 3. It is known to need human verification (accessibility issues that are context-dependent)
        const hasIncompleteMessage = check.messages && 'incomplete' in check.messages;

        // Many checks are implemented as strings that are later evaluated to functions
        const evaluateCode = check.evaluate ? check.evaluate.toString() : '';
        const explicitlyReturnsUndefined =
          evaluateCode.includes('return undefined') || evaluateCode.includes('return;');

        // Some checks use specific patterns that indicate potential for incomplete results
        const indicatesManualVerification =
          evaluateCode.includes('return undefined') ||
          evaluateCode.includes('this.data(') ||
          evaluateCode.includes('options.reviewOnFail') ||
          evaluateCode.includes('incomplete') ||
          (check.metadata && check.metadata.incomplete === true);

        if (hasIncompleteMessage || explicitlyReturnsUndefined || indicatesManualVerification) {
          rulesLikelyToProduceIncomplete.add(rule.ruleId);
          break; // One check is enough to mark the rule
        }
      }

      // Also check rule-level metadata for indicators of potential incomplete results
      if (ruleObj.metadata) {
        if (
          ruleObj.metadata.incomplete === true ||
          (ruleObj.metadata.messages && 'incomplete' in ruleObj.metadata.messages)
        ) {
          rulesLikelyToProduceIncomplete.add(rule.ruleId);
        }
      }
    } catch (e) {
      // Silently continue if we encounter errors analyzing a rule
      // This is a safeguard against unexpected changes in axe-core's internal structure
    }
  }

  // Also check custom Oobee rules if they're enabled
  if (!disableOobee) {
    for (const rule of axeConfig.rules || []) {
      if (!rule.enabled) continue;

      // Check if the rule's metadata indicates it might produce incomplete results
      try {
        const hasIncompleteMessage =
          (rule as any)?.metadata?.messages?.incomplete !== undefined ||
          (axeConfig.checks || []).some(
            check => check.id === rule.id && check.metadata?.messages?.incomplete !== undefined,
          );

        if (hasIncompleteMessage) {
          rulesLikelyToProduceIncomplete.add(rule.id);
        }
      } catch (e) {
        // Continue if we encounter errors
      }
    }
  }

  // Map from WCAG criteria IDs to whether they might produce needsReview results
  const potentialNeedsReviewCriteria: Record<string, boolean> = {};

  // Process each rule to map to WCAG criteria
  for (const rule of allRules) {
    if (rule.ruleId === 'frame-tested') continue;

    const tags = rule.tags || [];
    if (tags.includes('experimental') || tags.includes('deprecated')) continue;

    // Map rule to WCAG criteria
    for (const tag of tags) {
      if (/^wcag\d+$/.test(tag)) {
        const mightNeedReview = rulesLikelyToProduceIncomplete.has(rule.ruleId);

        // If we haven't seen this criterion before or we're updating it to true
        if (mightNeedReview || !potentialNeedsReviewCriteria[tag]) {
          potentialNeedsReviewCriteria[tag] = mightNeedReview;
        }
      }
    }
  }

  return potentialNeedsReviewCriteria;
};

/**
 * Categorizes a WCAG criterion into one of: "mustFix", "goodToFix", or "needsReview"
 * for use in Sentry reporting
 *
 * @param wcagId The WCAG criterion ID (e.g., "wcag144")
 * @param enableWcagAaa Whether WCAG AAA criteria are enabled
 * @param disableOobee Whether Oobee custom rules are disabled
 * @returns The category: "mustFix", "goodToFix", or "needsReview"
 */
export const categorizeWcagCriterion = async (
  wcagId: string,
  enableWcagAaa: boolean = true,
  disableOobee: boolean = false,
): Promise<'mustFix' | 'goodToFix' | 'needsReview'> => {
  // First check if this criterion might produce "needsReview" results
  const needsReviewMap = await getPotentialNeedsReviewWcagCriteria(enableWcagAaa, disableOobee);
  if (needsReviewMap[wcagId]) {
    return 'needsReview';
  }

  // Get the WCAG criteria map to check the level
  const wcagCriteriaMap = await getWcagCriteriaMap(enableWcagAaa, disableOobee);
  const criterionInfo = wcagCriteriaMap[wcagId];

  if (!criterionInfo) {
    // If we can't find info, default to mustFix for safety
    return 'mustFix';
  }

  // Check if it's a level A or AA criterion (mustFix) or AAA (goodToFix)
  if (criterionInfo.level === 'a' || criterionInfo.level === 'aa') {
    return 'mustFix';
  }
  return 'goodToFix';
};

/**
 * Batch categorizes multiple WCAG criteria for Sentry reporting
 *
 * @param wcagIds Array of WCAG criterion IDs (e.g., ["wcag144", "wcag143"])
 * @param enableWcagAaa Whether WCAG AAA criteria are enabled
 * @param disableOobee Whether Oobee custom rules are disabled
 * @returns Object mapping each criterion to its category
 */
export const categorizeWcagCriteria = async (
  wcagIds: string[],
  enableWcagAaa: boolean = true,
  disableOobee: boolean = false,
): Promise<Record<string, 'mustFix' | 'goodToFix' | 'needsReview'>> => {
  // Get both maps once to avoid repeated expensive calls
  const [needsReviewMap, wcagCriteriaMap] = await Promise.all([
    getPotentialNeedsReviewWcagCriteria(enableWcagAaa, disableOobee),
    getWcagCriteriaMap(enableWcagAaa, disableOobee),
  ]);

  const result: Record<string, 'mustFix' | 'goodToFix' | 'needsReview'> = {};

  wcagIds.forEach(wcagId => {
    // First check if this criterion might produce "needsReview" results
    if (needsReviewMap[wcagId]) {
      result[wcagId] = 'needsReview';
      return;
    }

    // Get criterion info
    const criterionInfo = wcagCriteriaMap[wcagId];

    if (!criterionInfo) {
      // If we can't find info, default to mustFix for safety
      result[wcagId] = 'mustFix';
      return;
    }

    // Check if it's a level A or AA criterion (mustFix) or AAA (goodToFix)
    if (criterionInfo.level === 'a' || criterionInfo.level === 'aa') {
      result[wcagId] = 'mustFix';
    } else {
      result[wcagId] = 'goodToFix';
    }
  });

  return result;
};
