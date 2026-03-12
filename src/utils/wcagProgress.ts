import constants from '../constants/constants.js';

export type IssueCategory = 'mustFix' | 'goodToFix' | 'needsReview' | 'passed';

export interface IssueDetail {
  ruleId: string;
  wcagConformance: string[];
  occurrencesMustFix?: number;
  occurrencesGoodToFix?: number;
  occurrencesNeedsReview?: number;
  occurrencesPassed: number;
}

export interface PageDetail {
  pageTitle: string;
  url: string;
  totalOccurrencesFailedIncludingNeedsReview: number;
  totalOccurrencesFailedExcludingNeedsReview: number;
  totalOccurrencesMustFix?: number;
  totalOccurrencesGoodToFix?: number;
  totalOccurrencesNeedsReview: number;
  totalOccurrencesPassed: number;
  occurrencesExclusiveToNeedsReview: boolean;
  typesOfIssuesCount: number;
  typesOfIssuesExcludingNeedsReviewCount: number;
  categoriesPresent: IssueCategory[];
  conformance?: string[]; // WCAG levels as flexible strings
  typesOfIssues: IssueDetail[];
}

export interface ScanPagesDetail {
  oobeeAppVersion?: string;
  pagesAffected: PageDetail[];
  pagesNotAffected: PageDetail[];
  scannedPagesCount: number;
  pagesNotScanned: PageDetail[];
  pagesNotScannedCount: number;
}

export const getWcagPassPercentage = (
  wcagViolations: string[],
  showEnableWcagAaa: boolean,
): {
  passPercentageAA: string;
  totalWcagChecksAA: number;
  totalWcagViolationsAA: number;
  passPercentageAAandAAA: string;
  totalWcagChecksAAandAAA: number;
  totalWcagViolationsAAandAAA: number;
} => {
  // These AAA rules should not be counted as WCAG Pass Percentage only contains A and AA
  const wcagAAALinks = [
    'WCAG 1.4.6',
    'WCAG 2.2.4',
    'WCAG 2.4.9',
    'WCAG 3.1.5',
    'WCAG 3.2.5',
    'WCAG 2.1.3',
  ];
  const wcagAAA = ['wcag146', 'wcag224', 'wcag249', 'wcag315', 'wcag325', 'wcag213'];

  const wcagLinksAAandAAA = constants.wcagLinks;

  const wcagViolationsAAandAAA = showEnableWcagAaa ? wcagViolations.length : null;
  const totalChecksAAandAAA = showEnableWcagAaa ? Object.keys(wcagLinksAAandAAA).length : null;
  const passedChecksAAandAAA = showEnableWcagAaa
    ? totalChecksAAandAAA - wcagViolationsAAandAAA
    : null;
  // eslint-disable-next-line no-nested-ternary
  const passPercentageAAandAAA = showEnableWcagAaa
    ? totalChecksAAandAAA === 0
      ? 0
      : (passedChecksAAandAAA / totalChecksAAandAAA) * 100
    : null;

  const wcagViolationsAA = wcagViolations.filter(violation => !wcagAAA.includes(violation)).length;
  const totalChecksAA = Object.keys(wcagLinksAAandAAA).filter(
    key => !wcagAAALinks.includes(key),
  ).length;
  const passedChecksAA = totalChecksAA - wcagViolationsAA;
  const passPercentageAA = totalChecksAA === 0 ? 0 : (passedChecksAA / totalChecksAA) * 100;

  return {
    passPercentageAA: passPercentageAA.toFixed(2), // toFixed returns a string, which is correct here
    totalWcagChecksAA: totalChecksAA,
    totalWcagViolationsAA: wcagViolationsAA,
    passPercentageAAandAAA: passPercentageAAandAAA ? passPercentageAAandAAA.toFixed(2) : null, // toFixed returns a string, which is correct here
    totalWcagChecksAAandAAA: totalChecksAAandAAA,
    totalWcagViolationsAAandAAA: wcagViolationsAAandAAA,
  };
};

export const getProgressPercentage = (
  scanPagesDetail: ScanPagesDetail,
  showEnableWcagAaa: boolean,
): {
  averageProgressPercentageAA: string;
  averageProgressPercentageAAandAAA: string;
} => {
  const pages = scanPagesDetail.pagesAffected || [];

  const progressPercentagesAA = pages.map((page: PageDetail) => {
    const violations: string[] = page.conformance;
    return getWcagPassPercentage(violations, showEnableWcagAaa).passPercentageAA;
  });

  const progressPercentagesAAandAAA = pages.map((page: PageDetail) => {
    const violations: string[] = page.conformance;
    return getWcagPassPercentage(violations, showEnableWcagAaa).passPercentageAAandAAA;
  });

  const totalAA = progressPercentagesAA.reduce((sum, p) => sum + parseFloat(p), 0);
  const avgAA = progressPercentagesAA.length ? totalAA / progressPercentagesAA.length : 0;

  const totalAAandAAA = progressPercentagesAAandAAA.reduce((sum, p) => sum + parseFloat(p), 0);
  const avgAAandAAA = progressPercentagesAAandAAA.length
    ? totalAAandAAA / progressPercentagesAAandAAA.length
    : 0;

  return {
    averageProgressPercentageAA: avgAA.toFixed(2),
    averageProgressPercentageAAandAAA: avgAAandAAA.toFixed(2),
  };
};
