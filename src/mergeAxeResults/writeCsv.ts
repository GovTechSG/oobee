import { createWriteStream } from 'fs';
import { a11yRuleShortDescriptionMap } from '../constants/constants.js';
import type { AllIssues, RuleInfo } from './types.js';
import type { ItemsStore } from './itemsStore.js';

function escapeCsvField(value: string): string {
  if (value == null) return '';
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

const writeCsv = async (
  allIssues: AllIssues,
  storagePath: string,
  itemsStore?: ItemsStore,
): Promise<void> => {
  const csvOutput = createWriteStream(`${storagePath}/report.csv`, { encoding: 'utf8' });

  const formatPageViolation = (pageNum: number) => {
    if (pageNum < 0) return 'Document';
    return `Page ${pageNum}`;
  };

  const fields = [
    'customFlowLabel',
    'deviceChosen',
    'scanCompletedAt',
    'severity',
    'issueId',
    'issueDescription',
    'wcagConformance',
    'url',
    'pageTitle',
    'context',
    'howToFix',
    'axeImpact',
    'xpath',
    'learnMore',
  ];

  csvOutput.write(fields.map(escapeCsvField).join(',') + '\n');

  const getRulesByCategory = (issues: AllIssues): [string, RuleInfo][] => {
    return Object.entries(issues.items)
      .filter(([category]) => category !== 'passed')
      .reduce((prev: [string, RuleInfo][], [category, value]) => {
        const rulesEntries = Object.entries(value.rules);
        rulesEntries.forEach(([, ruleInfo]) => {
          prev.push([category, ruleInfo]);
        });
        return prev;
      }, [])
      .sort((a, b) => {
        const compareCategory = -a[0].localeCompare(b[0]);
        return compareCategory === 0 ? a[1].rule.localeCompare(b[1].rule) : compareCategory;
      });
  };

  const rulesByCategory = getRulesByCategory(allIssues);

  for (const [severity, rule] of rulesByCategory) {
    const {
      rule: issueId,
      description: issueDescription,
      axeImpact,
      conformance,
      pagesAffected,
      helpUrl: learnMore,
    } = rule;

    const wcagConformance = conformance.join(',');

    if (itemsStore) {
      const itemsMap = await itemsStore.readRuleItemsMap(severity, issueId);
      const sortedPages = [...pagesAffected].sort((a, b) => (a.url || '').localeCompare(b.url || ''));

      for (const affectedPage of sortedPages) {
        const key = affectedPage.pageIndex != null ? String(affectedPage.pageIndex) : affectedPage.url;
        const entry = itemsMap.get(key);
        if (!entry) continue;

        for (const item of entry.items) {
          const { html, message, xpath } = item;
          const page = (item as any).page;
          const howToFix = (message || '').replace(/(\r\n|\n|\r)/g, '\\n');
          const violation = html || formatPageViolation(page);
          const context = violation.replace(/(\r\n|\n|\r)/g, '');

          const row = [
            allIssues.customFlowLabel || '',
            allIssues.deviceChosen || '',
            allIssues.endTime ? allIssues.endTime.toISOString() : '',
            severity || '',
            issueId || '',
            a11yRuleShortDescriptionMap[issueId] || issueDescription || '',
            wcagConformance || '',
            affectedPage.url || '',
            affectedPage.pageTitle || 'No page title',
            context || '',
            howToFix || '',
            axeImpact || '',
            xpath || '',
            learnMore || '',
          ].map(escapeCsvField);

          csvOutput.write(row.join(',') + '\n');
        }
      }
    } else {
      const sortedPages = [...pagesAffected].sort((a, b) => (a.url || '').localeCompare(b.url || ''));

      for (const affectedPage of sortedPages) {
        const items = (affectedPage as any).items || [];
        for (const item of items) {
          const { html, message, xpath } = item;
          const page = (item as any).page;
          const howToFix = (message || '').replace(/(\r\n|\n|\r)/g, '\\n');
          const violation = html || formatPageViolation(page);
          const context = violation.replace(/(\r\n|\n|\r)/g, '');

          const row = [
            allIssues.customFlowLabel || '',
            allIssues.deviceChosen || '',
            allIssues.endTime ? allIssues.endTime.toISOString() : '',
            severity || '',
            issueId || '',
            a11yRuleShortDescriptionMap[issueId] || issueDescription || '',
            wcagConformance || '',
            affectedPage.url || '',
            affectedPage.pageTitle || 'No page title',
            context || '',
            howToFix || '',
            axeImpact || '',
            xpath || '',
            learnMore || '',
          ].map(escapeCsvField);

          csvOutput.write(row.join(',') + '\n');
        }
      }
    }
  }

  if (allIssues.pagesNotScanned && allIssues.pagesNotScanned.length > 0) {
    allIssues.pagesNotScanned.forEach(page => {
      const row = [
        allIssues.customFlowLabel || '',
        allIssues.deviceChosen || '',
        allIssues.endTime ? allIssues.endTime.toISOString() : '',
        'error',
        'error-pages-skipped',
        page.metadata ? page.metadata : 'An unknown error caused the page to be skipped',
        '',
        (page as any).url || page || '',
        'Error',
        '',
        '',
        '',
        '',
        '',
      ].map(escapeCsvField);

      csvOutput.write(row.join(',') + '\n');
    });
  }

  csvOutput.end();
  await new Promise<void>((resolve, reject) => {
    csvOutput.on('finish', resolve);
    csvOutput.on('error', reject);
  });
};

export default writeCsv;
