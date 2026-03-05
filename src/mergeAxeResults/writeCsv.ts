import { createWriteStream } from 'fs';
import { AsyncParser, ParserOptions } from '@json2csv/node';
import { a11yRuleShortDescriptionMap } from '../constants/constants.js';
import type { AllIssues, RuleInfo } from './types.js';

const writeCsv = async (allIssues: AllIssues, storagePath: string): Promise<void> => {
  const csvOutput = createWriteStream(`${storagePath}/report.csv`, { encoding: 'utf8' });
  const formatPageViolation = (pageNum: number) => {
    if (pageNum < 0) return 'Document';
    return `Page ${pageNum}`;
  };

  // transform allIssues into the form:
  // [['mustFix', rule1], ['mustFix', rule2], ['goodToFix', rule3], ...]
  const getRulesByCategory = (issues: AllIssues) => {
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
        // sort rules according to severity, then ruleId
        const compareCategory = -a[0].localeCompare(b[0]);
        return compareCategory === 0 ? a[1].rule.localeCompare(b[1].rule) : compareCategory;
      });
  };

  const flattenRule = (catAndRule: [string, RuleInfo]) => {
    const [severity, rule] = catAndRule;
    const results = [];
    const {
      rule: issueId,
      description: issueDescription,
      axeImpact,
      conformance,
      pagesAffected,
      helpUrl: learnMore,
    } = rule;

    // format clauses as a string
    const wcagConformance = conformance.join(',');

    pagesAffected.sort((a, b) => a.url.localeCompare(b.url));

    pagesAffected.forEach(affectedPage => {
      const { url, items } = affectedPage;
      items.forEach(item => {
        const { html, message, xpath } = item;
        const page = (item as any).page;
        const howToFix = message.replace(/(\r\n|\n|\r)/g, '\\n'); // preserve newlines as \n
        const violation = html || formatPageViolation(page); // page is a number, not a string
        const context = violation.replace(/(\r\n|\n|\r)/g, ''); // remove newlines

        results.push({
          customFlowLabel: allIssues.customFlowLabel || '',
          deviceChosen: allIssues.deviceChosen || '',
          scanCompletedAt: allIssues.endTime ? allIssues.endTime.toISOString() : '',
          severity: severity || '',
          issueId: issueId || '',
          issueDescription: a11yRuleShortDescriptionMap[issueId] || issueDescription || '',
          wcagConformance: wcagConformance || '',
          url: url || '',
          pageTitle: affectedPage.pageTitle || 'No page title',
          context: context || '',
          howToFix: howToFix || '',
          axeImpact: axeImpact || '',
          xpath: xpath || '',
          learnMore: learnMore || '',
        });
      });
    });
    if (results.length === 0) return {};
    return results;
  };

  const opts: ParserOptions<any, any> = {
    transforms: [getRulesByCategory, flattenRule],
    fields: [
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
    ],
    includeEmptyRows: true,
  };

  // Create the parse stream (it's asynchronous)
  const parser = new AsyncParser(opts);
  const parseStream = parser.parse(allIssues);

  // Pipe JSON2CSV output into the file, but don't end automatically
  parseStream.pipe(csvOutput, { end: false });

  // Once JSON2CSV is done writing all normal rows, append any "pagesNotScanned"
  parseStream.on('end', () => {
    if (allIssues.pagesNotScanned && allIssues.pagesNotScanned.length > 0) {
      csvOutput.write('\n');
      allIssues.pagesNotScanned.forEach(page => {
        const skippedPage = {
          customFlowLabel: allIssues.customFlowLabel || '',
          deviceChosen: allIssues.deviceChosen || '',
          scanCompletedAt: allIssues.endTime ? allIssues.endTime.toISOString() : '',
          severity: 'error',
          issueId: 'error-pages-skipped',
          issueDescription: page.metadata
            ? page.metadata
            : 'An unknown error caused the page to be skipped',
          wcagConformance: '',
          url: page.url || page || '',
          pageTitle: 'Error',
          context: '',
          howToFix: '',
          axeImpact: '',
          xpath: '',
          learnMore: '',
        };
        csvOutput.write(`${Object.values(skippedPage).join(',')}\n`);
      });
    }

    // Now close the CSV file
    csvOutput.end();
  });

  parseStream.on('error', (err: unknown) => {
    console.error('Error parsing CSV:', err);
    csvOutput.end();
  });
};

export default writeCsv;
