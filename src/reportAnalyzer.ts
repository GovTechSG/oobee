/**
 * Report Analyzer — Multi-scan aggregation and benchmarking.
 *
 * Reads scan results from multiple oobee scan directories and produces
 * a consolidated snapshot report showing:
 * - Total URLs scanned across all scans
 * - WCAG error counts by category (mustFix, goodToFix, needsReview)
 * - Axe impact severity breakdown (critical, serious, moderate, minor)
 * - WCAG AA pass percentage as a benchmark score
 * - Top issues across all scans for prioritization
 *
 * This enables teams to track accessibility improvement over time by
 * comparing snapshots from different scan dates.
 *
 * @see https://github.com/GovTechSG/oobee/issues/257
 */

import fs from 'fs';
import path from 'path';

export interface ScanSnapshot {
  scanDate: string;
  siteName: string;
  urlScanned: string;
  totalPagesScanned: number;
  totalItems: number;
  mustFix: CategorySummary;
  goodToFix: CategorySummary;
  needsReview: CategorySummary;
  passed: CategorySummary;
  impactBreakdown: ImpactBreakdown;
  wcagPassPercentageAA: string;
  wcagViolations: string[];
}

export interface CategorySummary {
  totalItems: number;
  totalRules: number;
}

export interface ImpactBreakdown {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}

export interface AggregateReport {
  generatedAt: string;
  totalScansAnalyzed: number;
  totalPagesScanned: number;
  totalIssuesFound: number;
  aggregateImpact: ImpactBreakdown;
  aggregateCategories: {
    mustFix: number;
    goodToFix: number;
    needsReview: number;
    passed: number;
  };
  wcagViolationsAcrossScans: string[];
  averageWcagPassPercentageAA: string;
  topIssues: Array<{
    rule: string;
    description: string;
    axeImpact: string;
    totalItems: number;
    scansAffected: number;
  }>;
  scans: ScanSnapshot[];
}

/**
 * Analyze multiple scan result directories and produce an aggregate report.
 *
 * @param resultsDir - Path to the oobee results directory (contains date-stamped subdirs)
 * @param options - Optional filters (date range, site name)
 * @returns AggregateReport with consolidated metrics
 */
export function analyzeReports(
  resultsDir: string,
  options?: {
    fromDate?: string;
    toDate?: string;
    siteName?: string;
  }
): AggregateReport {
  const scanDirs = findScanDirectories(resultsDir);
  const snapshots: ScanSnapshot[] = [];
  const issueTracker = new Map<string, { rule: string; description: string; axeImpact: string; totalItems: number; scansAffected: number }>();

  for (const scanDir of scanDirs) {
    const snapshot = readScanSnapshot(scanDir);

    if (!snapshot) {
      continue;
    }

    if (options?.fromDate && snapshot.scanDate < options.fromDate) {
      continue;
    }

    if (options?.toDate && snapshot.scanDate > options.toDate) {
      continue;
    }

    if (options?.siteName && !snapshot.siteName.toLowerCase().includes(options.siteName.toLowerCase())) {
      continue;
    }

    snapshots.push(snapshot);

    // Track top issues across scans
    const issuesSummaryPath = path.join(scanDir, 'scanIssuesSummary.json');

    if (fs.existsSync(issuesSummaryPath)) {
      try {
        const issuesSummary = JSON.parse(fs.readFileSync(issuesSummaryPath, 'utf-8'));

        for (const category of ['mustFix', 'goodToFix', 'needsReview']) {
          const rules = issuesSummary[category]?.rules || [];

          for (const rule of rules) {
            const existing = issueTracker.get(rule.rule);

            if (existing) {
              existing.totalItems += rule.totalItems || 0;
              existing.scansAffected += 1;
            } else {
              issueTracker.set(rule.rule, {
                rule: rule.rule,
                description: rule.description || '',
                axeImpact: rule.axeImpact || '',
                totalItems: rule.totalItems || 0,
                scansAffected: 1,
              });
            }
          }
        }
      } catch {
        // Skip malformed issue summaries
      }
    }
  }

  const aggregateImpact: ImpactBreakdown = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const aggregateCategories = { mustFix: 0, goodToFix: 0, needsReview: 0, passed: 0 };
  const allWcagViolations = new Set<string>();
  let totalPages = 0;
  let totalIssues = 0;
  let passPercentageSum = 0;
  let passPercentageCount = 0;

  for (const snap of snapshots) {
    totalPages += snap.totalPagesScanned;
    totalIssues += snap.totalItems;

    aggregateImpact.critical += snap.impactBreakdown.critical;
    aggregateImpact.serious += snap.impactBreakdown.serious;
    aggregateImpact.moderate += snap.impactBreakdown.moderate;
    aggregateImpact.minor += snap.impactBreakdown.minor;

    aggregateCategories.mustFix += snap.mustFix.totalItems;
    aggregateCategories.goodToFix += snap.goodToFix.totalItems;
    aggregateCategories.needsReview += snap.needsReview.totalItems;
    aggregateCategories.passed += snap.passed.totalItems;

    for (const v of snap.wcagViolations) {
      allWcagViolations.add(v);
    }

    const pct = parseFloat(snap.wcagPassPercentageAA);

    if (!isNaN(pct)) {
      passPercentageSum += pct;
      passPercentageCount += 1;
    }
  }

  const topIssues = Array.from(issueTracker.values())
    .sort((a, b) => b.totalItems - a.totalItems)
    .slice(0, 10);

  const avgPassPct = passPercentageCount > 0
    ? (passPercentageSum / passPercentageCount).toFixed(1)
    : 'N/A';

  return {
    generatedAt: new Date().toISOString(),
    totalScansAnalyzed: snapshots.length,
    totalPagesScanned: totalPages,
    totalIssuesFound: totalIssues,
    aggregateImpact,
    aggregateCategories,
    wcagViolationsAcrossScans: Array.from(allWcagViolations).sort(),
    averageWcagPassPercentageAA: avgPassPct,
    topIssues,
    scans: snapshots.sort((a, b) => a.scanDate.localeCompare(b.scanDate)),
  };
}

/**
 * Format an aggregate report as a human-readable text summary.
 */
export function formatReportText(report: AggregateReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════');
  lines.push('  OOBEE ACCESSIBILITY BENCHMARK REPORT');
  lines.push(`  Generated: ${report.generatedAt}`);
  lines.push('═══════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Scans analyzed:     ${report.totalScansAnalyzed}`);
  lines.push(`  Total pages:        ${report.totalPagesScanned}`);
  lines.push(`  Total issues:       ${report.totalIssuesFound}`);
  lines.push(`  Avg WCAG AA pass:   ${report.averageWcagPassPercentageAA}%`);
  lines.push('');
  lines.push('  SEVERITY BREAKDOWN');
  lines.push(`    Critical:  ${report.aggregateImpact.critical}`);
  lines.push(`    Serious:   ${report.aggregateImpact.serious}`);
  lines.push(`    Moderate:  ${report.aggregateImpact.moderate}`);
  lines.push(`    Minor:     ${report.aggregateImpact.minor}`);
  lines.push('');
  lines.push('  CATEGORY BREAKDOWN');
  lines.push(`    Must Fix:      ${report.aggregateCategories.mustFix}`);
  lines.push(`    Good to Fix:   ${report.aggregateCategories.goodToFix}`);
  lines.push(`    Needs Review:  ${report.aggregateCategories.needsReview}`);
  lines.push(`    Passed:        ${report.aggregateCategories.passed}`);
  lines.push('');

  if (report.topIssues.length > 0) {
    lines.push('  TOP ISSUES');

    for (const issue of report.topIssues) {
      lines.push(`    [${issue.axeImpact}] ${issue.rule}: ${issue.totalItems} occurrences (${issue.scansAffected} scans)`);
    }

    lines.push('');
  }

  if (report.scans.length > 1) {
    lines.push('  SCAN HISTORY');

    for (const scan of report.scans) {
      lines.push(`    ${scan.scanDate} | ${scan.siteName} | ${scan.totalPagesScanned} pages | ${scan.totalItems} issues | ${scan.wcagPassPercentageAA}% AA`);
    }

    lines.push('');
  }

  lines.push('═══════════════════════════════════════════════════');

  return lines.join('\n');
}

function findScanDirectories(resultsDir: string): string[] {
  const dirs: string[] = [];

  if (!fs.existsSync(resultsDir)) {
    return dirs;
  }

  const dateDirs = fs.readdirSync(resultsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dateDir of dateDirs) {
    const datePath = path.join(resultsDir, dateDir);
    const scanDirs = fs.readdirSync(datePath, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const scanDir of scanDirs) {
      const scanPath = path.join(datePath, scanDir.name);

      if (fs.existsSync(path.join(scanPath, 'scanItemsSummary.json'))) {
        dirs.push(scanPath);
      }
    }
  }

  return dirs;
}

function readScanSnapshot(scanDir: string): ScanSnapshot | null {
  try {
    const summaryPath = path.join(scanDir, 'scanItemsSummary.json');
    const dataPath = path.join(scanDir, 'scanData.json');

    if (!fs.existsSync(summaryPath)) {
      return null;
    }

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

    let scanData: any = {};

    if (fs.existsSync(dataPath)) {
      scanData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    }

    const impactBreakdown: ImpactBreakdown = { critical: 0, serious: 0, moderate: 0, minor: 0 };

    for (const category of ['mustFix', 'goodToFix', 'needsReview']) {
      const rules = summary[category]?.rules || [];

      for (const rule of rules) {
        const impact = rule.axeImpact as keyof ImpactBreakdown;

        if (impact in impactBreakdown) {
          impactBreakdown[impact] += rule.totalItems || 0;
        }
      }
    }

    return {
      scanDate: scanData.startTime || path.basename(path.dirname(scanDir)),
      siteName: scanData.siteName || '',
      urlScanned: scanData.urlScanned || '',
      totalPagesScanned: scanData.totalPagesScanned || 0,
      totalItems: (summary.mustFix?.totalItems || 0) +
        (summary.goodToFix?.totalItems || 0) +
        (summary.needsReview?.totalItems || 0),
      mustFix: {
        totalItems: summary.mustFix?.totalItems || 0,
        totalRules: summary.mustFix?.totalRuleIssues || 0,
      },
      goodToFix: {
        totalItems: summary.goodToFix?.totalItems || 0,
        totalRules: summary.goodToFix?.totalRuleIssues || 0,
      },
      needsReview: {
        totalItems: summary.needsReview?.totalItems || 0,
        totalRules: summary.needsReview?.totalRuleIssues || 0,
      },
      passed: {
        totalItems: summary.passed?.totalItems || 0,
        totalRules: summary.passed?.totalRuleIssues || 0,
      },
      impactBreakdown,
      wcagPassPercentageAA: summary.wcagPassPercentage?.passPercentageAA || '0',
      wcagViolations: scanData.wcagViolations || [],
    };
  } catch {
    return null;
  }
}
