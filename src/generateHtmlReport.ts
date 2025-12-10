import fs from 'fs-extra';
import path from 'path';

import {
  compressJsonFileStreaming,
  writeHTML,
  flattenAndSortResults,
  populateScanPagesDetail,
  getWcagPassPercentage,
  getProgressPercentage,
  getIssuesPercentage,
  itemTypeDescription,
  oobeeAiHtmlETL,
  oobeeAiRules,
  formatAboutStartTime,
} from './mergeAxeResults.js';

import constants, {
  ScannerTypes,
  WCAGclauses,
  a11yRuleShortDescriptionMap,
  disabilityBadgesMap,
  a11yRuleLongDescriptionMap,
} from './constants/constants.js';

import { consoleLogger } from './logs.js';

type EnsureCategoryReturn = {
  description: string;
  totalItems: number;
  totalRuleIssues: number;
  rules: any[];
};

const ensureCategory = (
  categoryObj: any,
  categoryName: 'mustFix' | 'goodToFix' | 'needsReview' | 'passed',
): EnsureCategoryReturn => {
  const rulesRaw = categoryObj?.rules ?? [];
  const rules: any[] = Array.isArray(rulesRaw)
    ? rulesRaw
    : Object.entries(rulesRaw as Record<string, any>).map(([rule, info]: [string, any]) => ({
        rule,
        ...(info as Record<string, any>),
      }));

  rules.forEach((rule: any) => {
    if (
      !Array.isArray(rule.pagesAffected) &&
      rule.pagesAffected &&
      typeof rule.pagesAffected === 'object'
    ) {
      rule.pagesAffected = Object.entries(rule.pagesAffected).map(
        ([url, pageInfo]: [string, any]) => {
          return pageInfo?.url ? pageInfo : { url, ...pageInfo };
        },
      );
    }

    if (!Array.isArray(rule.pagesAffected)) {
      rule.pagesAffected = [];
    }

    if (typeof rule.totalItems !== 'number') {
      rule.totalItems = rule.pagesAffected.reduce(
        (accumulate: number, page: any) =>
          accumulate + (Array.isArray(page.items) ? page.items.length : 0),
        0,
      );
    }
  });

  const totals: { totalItems: number; totalRuleIssues: number } = {
    totalItems:
      typeof categoryObj?.totalItems === 'number'
        ? categoryObj.totalItems
        : rules.reduce((acc: number, rr: any) => acc + (rr.totalItems || 0), 0),
    totalRuleIssues:
      typeof categoryObj?.totalRuleIssues === 'number' ? categoryObj.totalRuleIssues : rules.length,
  };

  return {
    description: categoryObj?.description || itemTypeDescription[categoryName],
    ...totals,
    rules,
  };
};

export const generateHtmlReport = async (resultDir: string): Promise<string> => {
  try {
    const storagePath = path.resolve(resultDir);
    const scanDataJsonPath = path.join(storagePath, 'scanData.json');
    const scanItemsJsonPath = path.join(storagePath, 'scanItems.json');

    if (!fs.existsSync(scanDataJsonPath)) {
      throw new Error(`Missing file: ${scanDataJsonPath}`);
    }

    if (!fs.existsSync(scanItemsJsonPath)) {
      throw new Error(`Missing file: ${scanItemsJsonPath}`);
    }

    const scanDataB64Path = path.join(storagePath, 'scanData.json.gz.b64');
    const scanItemsB64Path = path.join(storagePath, 'scanItems.json.gz.b64');

    if (!fs.existsSync(scanDataB64Path)) {
      consoleLogger.info('scanData.json.gz.b64 not found — generating from scanData.json');
      await compressJsonFileStreaming(scanDataJsonPath, scanDataB64Path);
    }

    if (!fs.existsSync(scanItemsB64Path)) {
      consoleLogger.info('scanItems.json.gz.b64 not found — generating from scanItems.json');
      await compressJsonFileStreaming(scanItemsJsonPath, scanItemsB64Path);
    }

    const scanData = JSON.parse(await fs.readFile(scanDataJsonPath, 'utf8'));
    const scanItemsAll = JSON.parse(await fs.readFile(scanItemsJsonPath, 'utf8'));

    const {
      oobeeAppVersion: itemsAppVersion,
      mustFix = {},
      goodToFix = {},
      needsReview = {},
      passed = {},
    } = scanItemsAll;

    const items = {
      mustFix: ensureCategory(mustFix, 'mustFix'),
      goodToFix: ensureCategory(goodToFix, 'goodToFix'),
      needsReview: ensureCategory(needsReview, 'needsReview'),
      passed: ensureCategory(passed, 'passed'),
    };

    const pagesScanned = Array.isArray(scanData.pagesScanned) ? scanData.pagesScanned : [];
    const pagesNotScanned = Array.isArray(scanData.pagesNotScanned) ? scanData.pagesNotScanned : [];

    const allIssues: any = {
      storagePath,
      oobeeAi: { htmlETL: oobeeAiHtmlETL, rules: oobeeAiRules },
      siteName: (scanData.siteName || (pagesScanned[0]?.pageTitle ?? ''))
        .toString()
        .replace(/^\d+\s*:\s*/, '')
        .trim(),
      startTime: scanData.startTime ? new Date(scanData.startTime) : new Date(),
      endTime: scanData.endTime ? new Date(scanData.endTime) : new Date(),
      urlScanned: scanData.urlScanned || scanData.url || '',
      scanType: scanData.scanType || ScannerTypes.WEBSITE,
      deviceChosen: scanData.deviceChosen || 'Desktop',
      formatAboutStartTime,
      isCustomFlow: (scanData.scanType || '') === ScannerTypes.CUSTOM,
      viewport: scanData.deviceChosen || 'Desktop',
      pagesScanned,
      pagesNotScanned,
      totalPagesScanned:
        typeof scanData.totalPagesScanned === 'number'
          ? scanData.totalPagesScanned
          : pagesScanned.length,
      totalPagesNotScanned:
        typeof scanData.totalPagesNotScanned === 'number'
          ? scanData.totalPagesNotScanned
          : pagesNotScanned.length,
      totalItems: 0,
      topFiveMostIssues: Array.isArray(scanData.topFiveMostIssues)
        ? scanData.topFiveMostIssues
        : [],
      topTenPagesWithMostIssues: Array.isArray(scanData.topTenPagesWithMostIssues)
        ? scanData.topTenPagesWithMostIssues
        : [],
      topTenIssues: Array.isArray(scanData.topTenIssues) ? scanData.topTenIssues : [],
      wcagViolations: Array.isArray(scanData.wcagViolations) ? scanData.wcagViolations : [],
      customFlowLabel: scanData.customFlowLabel || '',
      oobeeAppVersion: itemsAppVersion || scanData.oobeeAppVersion || 'dev',
      items,
      cypressScanAboutMetadata: scanData.cypressScanAboutMetadata || {},
      wcagLinks: scanData.wcagLinks || constants.wcagLinks,
      wcagClauses: WCAGclauses,
      a11yRuleShortDescriptionMap,
      disabilityBadgesMap,
      a11yRuleLongDescriptionMap,
      advancedScanOptionsSummaryItems: {
        showIncludeScreenshots: !!scanData.advancedScanOptionsSummaryItems?.showIncludeScreenshots,
        showAllowSubdomains: !!scanData.advancedScanOptionsSummaryItems?.showAllowSubdomains,
        showEnableCustomChecks: !!scanData.advancedScanOptionsSummaryItems?.showEnableCustomChecks,
        showEnableWcagAaa: !!scanData.advancedScanOptionsSummaryItems?.showEnableWcagAaa,
        showSlowScanMode: !!scanData.advancedScanOptionsSummaryItems?.showSlowScanMode,
        showAdhereRobots: !!scanData.advancedScanOptionsSummaryItems?.showAdhereRobots,
      },
      scanPagesDetail: scanData.scanPagesDetail || {
        pagesAffected: [],
        pagesNotAffected: [],
        scannedPagesCount: 0,
        pagesNotScanned: [],
        pagesNotScannedCount: 0,
      },
    };

    flattenAndSortResults(allIssues, allIssues.isCustomFlow);
    populateScanPagesDetail(allIssues);

    allIssues.wcagPassPercentage = getWcagPassPercentage(
      allIssues.wcagViolations,
      allIssues.advancedScanOptionsSummaryItems.showEnableWcagAaa,
    );
    allIssues.progressPercentage = getProgressPercentage(
      allIssues.scanPagesDetail,
      allIssues.advancedScanOptionsSummaryItems.showEnableWcagAaa,
    );
    allIssues.issuesPercentage = await getIssuesPercentage(
      allIssues.scanPagesDetail,
      allIssues.advancedScanOptionsSummaryItems.showEnableWcagAaa,
      (allIssues as any).advancedScanOptionsSummaryItems?.disableOobee,
    );

    await writeHTML(allIssues, storagePath, 'report', scanDataB64Path, scanItemsB64Path);

    consoleLogger.info(`Report generated at: ${path.join(storagePath, 'report.html')}`);
    return path.join(storagePath, 'report.html');
  } catch (err: any) {
    consoleLogger.error(`generateHtmlReport failed: ${err?.message || err}`);
    throw err;
  }
};

export default generateHtmlReport;
