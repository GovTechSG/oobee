/* eslint-disable consistent-return */
/* eslint-disable no-console */
import fs, { ensureDirSync } from 'fs-extra';
import printMessage from 'print-message';
import path from 'path';
import constants, {
  BrowserTypes,
  ScannerTypes,
  WCAGclauses,
  a11yRuleShortDescriptionMap,
  disabilityBadgesMap,
  a11yRuleLongDescriptionMap,
} from './constants/constants.js';
import { getBrowserToRun } from './constants/common.js';

import {
  createScreenshotsFolder,
  getStoragePath,
  getVersion,
  getWcagPassPercentage,
  getProgressPercentage,
  retryFunction,
  zipResults,
  getIssuesPercentage,
} from './utils.js';
import { consoleLogger } from './logs.js';
import itemTypeDescription from './constants/itemTypeDescription.js';
import { oobeeAiHtmlETL, oobeeAiRules } from './constants/oobeeAi.js';
import { buildHtmlGroups, convertItemsToReferences } from './mergeAxeResults/itemReferences.js';
import flattenAndSortResults from './mergeAxeResults/flattenAndSortResults.js';
import {
  compressJsonFileStreaming,
  writeJsonAndBase64Files,
} from './mergeAxeResults/jsonArtifacts.js';
import writeCsv from './mergeAxeResults/writeCsv.js';
import writeHTML from './mergeAxeResults/writeHTML.js';
import writeScanDetailsCsv from './mergeAxeResults/writeScanDetailsCsv.js';
import writeSitemap from './mergeAxeResults/writeSitemap.js';
import writeSummaryHTML from './mergeAxeResults/writeSummaryHTML.js';
import writeSummaryPdf from './mergeAxeResults/writeSummaryPdf.js';
import populateScanPagesDetail from './mergeAxeResults/scanPages.js';
import sendWcagBreakdownToSentry from './mergeAxeResults/sentryTelemetry.js';
import type { AllIssues, PageInfo } from './mergeAxeResults/types.js';

export type {
  AllIssues,
  HtmlGroupItem,
  HtmlGroups,
  ItemsInfo,
  PageInfo,
  RuleInfo,
} from './mergeAxeResults/types.js';

const extractFileNames = async (directory: string): Promise<string[]> => {
  ensureDirSync(directory);

  return fs
    .readdir(directory)
    .then(allFiles => allFiles.filter(file => path.extname(file).toLowerCase() === '.json'))
    .catch(readdirError => {
      consoleLogger.info('An error has occurred when retrieving files, please try again.');
      throw readdirError;
    });
};
const parseContentToJson = async (rPath: string) => {
  try {
    const content = await fs.readFile(rPath, 'utf8');
    return JSON.parse(content);
  } catch (parseError: any) {
    // Try to extract JSON.parse byte position from error message: "Unexpected token ... in JSON at position 123"
    let position: number | null = null;
    const msg = String(parseError?.message || '');
    const match = msg.match(/position\s+(\d+)/i);
    if (match) position = Number(match[1]);

    let contextSnippet = '';
    if (position !== null) {
      try {
        const raw = await fs.readFile(rPath, 'utf8');
        const start = Math.max(0, position - 80);
        const end = Math.min(raw.length, position + 80);
        contextSnippet = raw.slice(start, end).replace(/\n/g, '\\n');
      } catch {
        // ignore secondary read failures
      }
    }

    consoleLogger.error(`[parseContentToJson] Failed to parse file: ${rPath}`);
    consoleLogger.error(
      `[parseContentToJson] ${parseError?.name || 'Error'}: ${parseError?.message || parseError}`,
    );
    if (position !== null) {
      consoleLogger.error(`[parseContentToJson] JSON parse position: ${position}`);
    }
    if (contextSnippet) {
      consoleLogger.error(`[parseContentToJson] Context around error: ${contextSnippet}`);
    }

    // Keep current flow: return undefined so pipeline can continue.
    return undefined;
  }
};


const cleanUpJsonFiles = async (filesToDelete: string[]) => {
  consoleLogger.info('Cleaning up JSON files...');
  filesToDelete.forEach(file => {
    fs.unlinkSync(file);
    consoleLogger.info(`Deleted ${file}`);
  });
};

// Tracking WCAG occurrences
const wcagOccurrencesMap = new Map<string, number>();

const pushResults = async (pageResults, allIssues, isCustomFlow) => {
  const { url, pageTitle, filePath } = pageResults;

  const totalIssuesInPage = new Set();
  Object.keys(pageResults.mustFix.rules).forEach(k => totalIssuesInPage.add(k));
  Object.keys(pageResults.goodToFix.rules).forEach(k => totalIssuesInPage.add(k));
  Object.keys(pageResults.needsReview.rules).forEach(k => totalIssuesInPage.add(k));

  allIssues.topFiveMostIssues.push({
    url,
    pageTitle,
    totalIssues: totalIssuesInPage.size,
    totalOccurrences: 0,
  });

  ['mustFix', 'goodToFix', 'needsReview', 'passed'].forEach(category => {
    if (!pageResults[category]) return;

    const { totalItems, rules } = pageResults[category];
    const currCategoryFromAllIssues = allIssues.items[category];

    currCategoryFromAllIssues.totalItems += totalItems;

    Object.keys(rules).forEach(rule => {
      const {
        description,
        axeImpact,
        helpUrl,
        conformance,
        totalItems: count,
        items,
      } = rules[rule];
      if (!(rule in currCategoryFromAllIssues.rules)) {
        currCategoryFromAllIssues.rules[rule] = {
          description,
          axeImpact,
          helpUrl,
          conformance,
          totalItems: 0,
          // numberOfPagesAffectedAfterRedirects: 0,
          pagesAffected: {},
        };
      }

      if (category !== 'passed' && category !== 'needsReview') {
        conformance
          .filter(c => /wcag[0-9]{3,4}/.test(c))
          .forEach(c => {
            if (!allIssues.wcagViolations.includes(c)) {
              allIssues.wcagViolations.push(c);
            }

            // Track WCAG criteria occurrences for Sentry
            const currentCount = wcagOccurrencesMap.get(c) || 0;
            wcagOccurrencesMap.set(c, currentCount + count);
          });
      }

      const currRuleFromAllIssues = currCategoryFromAllIssues.rules[rule];

      currRuleFromAllIssues.totalItems += count;

      // Build htmlGroups for pre-computed Group by HTML Element
      buildHtmlGroups(currRuleFromAllIssues, items, url);

      if (isCustomFlow) {
        const { pageIndex, pageImagePath, metadata } = pageResults;
        currRuleFromAllIssues.pagesAffected[pageIndex] = {
          url,
          pageTitle,
          pageImagePath,
          metadata,
          items: [...items],
        };
      } else if (!(url in currRuleFromAllIssues.pagesAffected)) {
        currRuleFromAllIssues.pagesAffected[url] = {
          pageTitle,
          items: [...items],
          ...(filePath && { filePath }),
        };
      }
    });
  });
};

const extractRuleAiData = (
  ruleId: string,
  totalItems: number,
  items: any[],
  callback?: () => void,
) => {
  let snippets = [];

  if (oobeeAiRules.includes(ruleId)) {
    const snippetsSet = new Set();
    if (items) {
      items.forEach(item => {
        snippetsSet.add(oobeeAiHtmlETL(item.html));
      });
    }
    snippets = [...snippetsSet];
    if (callback) callback();
  }
  return {
    snippets,
    occurrences: totalItems,
  };
};

// This is for telemetry purposes called within mergeAxeResults.ts
export const createRuleIdJson = allIssues => {
  const compiledRuleJson = {};

  ['mustFix', 'goodToFix', 'needsReview'].forEach(category => {
    allIssues.items[category].rules.forEach(rule => {
      const allItems = rule.pagesAffected.flatMap(page => page.items || []);
      compiledRuleJson[rule.rule] = extractRuleAiData(rule.rule, rule.totalItems, allItems, () => {
        rule.pagesAffected.forEach(p => {
          delete p.items;
        });
      });
    });
  });

  return compiledRuleJson;
};

// This is for telemetry purposes called from npmIndex (scanPage and scanHTML) where report is not generated
export const createBasicFormHTMLSnippet = filteredResults => {
  const compiledRuleJson = {};

  ['mustFix', 'goodToFix', 'needsReview'].forEach(category => {
    if (filteredResults[category] && filteredResults[category].rules) {
      Object.entries(filteredResults[category].rules).forEach(
        ([ruleId, ruleVal]: [string, any]) => {
          compiledRuleJson[ruleId] = extractRuleAiData(ruleId, ruleVal.totalItems, ruleVal.items);
        },
      );
    }
  });

  return compiledRuleJson;
};

const moveElemScreenshots = (randomToken: string, storagePath: string) => {
  const currentScreenshotsPath = `${randomToken}/elemScreenshots`;
  const resultsScreenshotsPath = `${storagePath}/elemScreenshots`;
  if (fs.existsSync(currentScreenshotsPath)) {
    fs.moveSync(currentScreenshotsPath, resultsScreenshotsPath);
  }
};

const formatAboutStartTime = (dateString: string) => {
  const utcStartTimeDate = new Date(dateString);
  const formattedStartTime = utcStartTimeDate.toLocaleTimeString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour12: false,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'shortGeneric',
  });

  const timezoneAbbreviation = new Intl.DateTimeFormat('en', {
    timeZoneName: 'shortOffset',
  })
    .formatToParts(utcStartTimeDate)
    .find(part => part.type === 'timeZoneName').value;

  // adding a breakline between the time and timezone so it looks neater on report
  const timeColonIndex = formattedStartTime.lastIndexOf(':');
  const timePart = formattedStartTime.slice(0, timeColonIndex + 3);
  const timeZonePart = formattedStartTime.slice(timeColonIndex + 4);
  const htmlFormattedStartTime = `${timePart}<br>${timeZonePart} ${timezoneAbbreviation}`;

  return htmlFormattedStartTime;
};

const generateArtifacts = async (
  randomToken: string,
  urlScanned: string,
  scanType: ScannerTypes,
  viewport: string,
  pagesScanned: PageInfo[],
  pagesNotScanned: PageInfo[],
  customFlowLabel: string,
  cypressScanAboutMetadata: {
    browser?: string;
    viewport: { width: number; height: number };
  },
  scanDetails: {
    startTime: Date;
    endTime: Date;
    deviceChosen: string;
    isIncludeScreenshots: boolean;
    isAllowSubdomains: string;
    isEnableCustomChecks: string[];
    isEnableWcagAaa: string[];
    isSlowScanMode: number;
    isAdhereRobots: boolean;
    nameEmail?: { name: string; email: string };
  },
  zip: string = undefined, // optional
  generateJsonFiles = false,
) => {
  consoleLogger.info('Generating report artifacts');

  const storagePath = getStoragePath(randomToken);
  const intermediateDatasetsPath = `${storagePath}/crawlee`;
  const oobeeAppVersion = getVersion();
  const isCustomFlow = scanType === ScannerTypes.CUSTOM;

  const allIssues: AllIssues = {
    storagePath,
    oobeeAi: {
      htmlETL: oobeeAiHtmlETL,
      rules: oobeeAiRules,
    },
    siteName: (pagesScanned[0]?.pageTitle ?? '').replace(/^\d+\s*:\s*/, '').trim(),
    startTime: scanDetails.startTime ? scanDetails.startTime : new Date(),
    endTime: scanDetails.endTime ? scanDetails.endTime : new Date(),
    urlScanned,
    scanType,
    deviceChosen: scanDetails.deviceChosen || 'Desktop',
    formatAboutStartTime,
    isCustomFlow,
    viewport,
    pagesScanned,
    pagesNotScanned,
    totalPagesScanned: pagesScanned.length,
    totalPagesNotScanned: pagesNotScanned.length,
    totalItems: 0,
    topFiveMostIssues: [],
    topTenPagesWithMostIssues: [],
    topTenIssues: [],
    wcagViolations: [],
    customFlowLabel,
    oobeeAppVersion,
    items: {
      mustFix: {
        description: itemTypeDescription.mustFix,
        totalItems: 0,
        totalRuleIssues: 0,
        rules: [],
      },
      goodToFix: {
        description: itemTypeDescription.goodToFix,
        totalItems: 0,
        totalRuleIssues: 0,
        rules: [],
      },
      needsReview: {
        description: itemTypeDescription.needsReview,
        totalItems: 0,
        totalRuleIssues: 0,
        rules: [],
      },
      passed: {
        description: itemTypeDescription.passed,
        totalItems: 0,
        totalRuleIssues: 0,
        rules: [],
      },
    },
    cypressScanAboutMetadata,
    wcagLinks: constants.wcagLinks,
    wcagClauses: WCAGclauses,
    a11yRuleShortDescriptionMap,
    disabilityBadgesMap,
    a11yRuleLongDescriptionMap,
    wcagCriteriaLabels: constants.wcagCriteriaLabels,
    scanPagesDetail: {
      pagesAffected: [],
      pagesNotAffected: [],
      scannedPagesCount: 0,
      pagesNotScanned: [],
      pagesNotScannedCount: 0,
    },
    // Populate boolean values for id="advancedScanOptionsSummary"
    advancedScanOptionsSummaryItems: {
      showIncludeScreenshots: [true].includes(scanDetails.isIncludeScreenshots),
      showAllowSubdomains: ['same-domain'].includes(scanDetails.isAllowSubdomains),
      showEnableCustomChecks: ['default', 'enable-wcag-aaa'].includes(
        scanDetails.isEnableCustomChecks?.[0],
      ),
      showEnableWcagAaa: (scanDetails.isEnableWcagAaa || []).includes('enable-wcag-aaa'),
      showSlowScanMode: [1].includes(scanDetails.isSlowScanMode),
      showAdhereRobots: [true].includes(scanDetails.isAdhereRobots),
    },
  };

  const allFiles = await extractFileNames(intermediateDatasetsPath);

  const jsonArray = await Promise.all(
    allFiles.map(async file => parseContentToJson(`${intermediateDatasetsPath}/${file}`)),
  );

  await Promise.all(
    jsonArray.map(async pageResults => {
      await pushResults(pageResults, allIssues, isCustomFlow);
    }),
  ).catch(flattenIssuesError => {
    consoleLogger.error(
      `[generateArtifacts] Error flattening issues: ${flattenIssuesError?.stack || flattenIssuesError}`,
    );
  });

  flattenAndSortResults(allIssues, isCustomFlow);

  const labelKey = scanType.toLowerCase() === 'custom' ? 'CustomFlowLabel' : 'Label';
  const labelValue = allIssues.customFlowLabel || 'N/A';

  printMessage([
    'Scan Summary',
    `Oobee App Version: ${allIssues.oobeeAppVersion}`,
    '',
    `Site Name: ${allIssues.siteName}`,
    `URL: ${allIssues.urlScanned}`,
    `Pages Scanned: ${allIssues.totalPagesScanned}`,
    `Start Time: ${allIssues.startTime}`,
    `End Time: ${allIssues.endTime}`,
    `Elapsed Time: ${(new Date(allIssues.endTime).getTime() - new Date(allIssues.startTime).getTime()) / 1000}s`,
    `Device: ${allIssues.deviceChosen}`,
    `Viewport: ${allIssues.viewport}`,
    `Scan Type: ${allIssues.scanType}`,
    `${labelKey}: ${labelValue}`,
    '',
    `Must Fix: ${allIssues.items.mustFix.rules.length} ${Object.keys(allIssues.items.mustFix.rules).length === 1 ? 'issue' : 'issues'} / ${allIssues.items.mustFix.totalItems} ${allIssues.items.mustFix.totalItems === 1 ? 'occurrence' : 'occurrences'}`,
    `Good to Fix: ${allIssues.items.goodToFix.rules.length} ${Object.keys(allIssues.items.goodToFix.rules).length === 1 ? 'issue' : 'issues'} / ${allIssues.items.goodToFix.totalItems} ${allIssues.items.goodToFix.totalItems === 1 ? 'occurrence' : 'occurrences'}`,
    `Manual Review Required: ${allIssues.items.needsReview.rules.length} ${Object.keys(allIssues.items.needsReview.rules).length === 1 ? 'issue' : 'issues'} / ${allIssues.items.needsReview.totalItems} ${allIssues.items.needsReview.totalItems === 1 ? 'occurrence' : 'occurrences'}`,
    `Passed: ${allIssues.items.passed.totalItems} ${allIssues.items.passed.totalItems === 1 ? 'occurrence' : 'occurrences'}`,
  ]);

  // move screenshots folder to report folders
  moveElemScreenshots(randomToken, storagePath);
  if (isCustomFlow) {
    createScreenshotsFolder(randomToken);
  }

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
    allIssues.advancedScanOptionsSummaryItems.disableOobee,
  );

  consoleLogger.info(`Site Name: ${allIssues.siteName}`);
  consoleLogger.info(`URL: ${allIssues.urlScanned}`);
  consoleLogger.info(`Pages Scanned: ${allIssues.totalPagesScanned}`);
  consoleLogger.info(`Start Time: ${allIssues.startTime}`);
  consoleLogger.info(`End Time: ${allIssues.endTime}`);
  const elapsedSeconds =
    (new Date(allIssues.endTime).getTime() - new Date(allIssues.startTime).getTime()) / 1000;
  consoleLogger.info(`Elapsed Time: ${elapsedSeconds}s`);
  consoleLogger.info(`Device: ${allIssues.deviceChosen}`);
  consoleLogger.info(`Viewport: ${allIssues.viewport}`);
  consoleLogger.info(`Scan Type: ${allIssues.scanType}`);
  consoleLogger.info(`Label: ${allIssues.customFlowLabel || 'N/A'}`);

  const getAxeImpactCount = (allIssues: AllIssues) => {
    const impactCount = {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    };
    Object.values(allIssues.items).forEach(category => {
      if (category.totalItems > 0) {
        Object.values(category.rules).forEach(rule => {
          if (rule.axeImpact === 'critical') {
            impactCount.critical += rule.totalItems;
          } else if (rule.axeImpact === 'serious') {
            impactCount.serious += rule.totalItems;
          } else if (rule.axeImpact === 'moderate') {
            impactCount.moderate += rule.totalItems;
          } else if (rule.axeImpact === 'minor') {
            impactCount.minor += rule.totalItems;
          }
        });
      }
    });

    return impactCount;
  };

  if (process.env.OOBEE_VERBOSE) {
    const axeImpactCount = getAxeImpactCount(allIssues);
    const { items, startTime, endTime, ...rest } = allIssues;

    rest.critical = axeImpactCount.critical;
    rest.serious = axeImpactCount.serious;
    rest.moderate = axeImpactCount.moderate;
    rest.minor = axeImpactCount.minor;
  }

  await writeCsv(allIssues, storagePath);
  await writeSitemap(pagesScanned, storagePath);
  const {
    scanDataJsonFilePath,
    scanDataBase64FilePath,
    scanItemsJsonFilePath,
    scanItemsBase64FilePath,
    scanItemsSummaryJsonFilePath,
    scanItemsSummaryBase64FilePath,
    scanIssuesSummaryJsonFilePath,
    scanIssuesSummaryBase64FilePath,
    scanPagesDetailJsonFilePath,
    scanPagesDetailBase64FilePath,
    scanPagesSummaryJsonFilePath,
    scanPagesSummaryBase64FilePath,
    scanDataJsonFileSize,
    scanItemsJsonFileSize,
  } = await writeJsonAndBase64Files(allIssues, storagePath);
  // Removed BIG_RESULTS_THRESHOLD check - always use full scanItems

  await writeScanDetailsCsv(
    scanDataBase64FilePath,
    scanItemsBase64FilePath,
    scanItemsSummaryBase64FilePath,
    storagePath,
  );
  await writeSummaryHTML(allIssues, storagePath);

  await writeHTML(
    allIssues,
    storagePath,
    'report',
    scanDataBase64FilePath,
    scanItemsBase64FilePath,
  );

  if (!generateJsonFiles) {
    await cleanUpJsonFiles([
      scanDataJsonFilePath,
      scanDataBase64FilePath,
      scanItemsJsonFilePath,
      scanItemsBase64FilePath,
      scanItemsSummaryJsonFilePath,
      scanItemsSummaryBase64FilePath,
      scanIssuesSummaryJsonFilePath,
      scanIssuesSummaryBase64FilePath,
      scanPagesDetailJsonFilePath,
      scanPagesDetailBase64FilePath,
      scanPagesSummaryJsonFilePath,
      scanPagesSummaryBase64FilePath,
    ]);
  }

  const browserChannel = getBrowserToRun(randomToken, BrowserTypes.CHROME, false).browserToRun;

  // Should consider refactor constants.userDataDirectory to be a parameter in future
  await retryFunction(
    () =>
      writeSummaryPdf(
        storagePath,
        pagesScanned.length,
        'summary',
        browserChannel,
        constants.userDataDirectory,
      ),
    1,
  );

  try {
    await fs.promises.rm(path.join(storagePath, 'crawlee'), { recursive: true, force: true });
  } catch (error) {
    consoleLogger.warn(`Unable to force remove crawlee folder: ${error.message}`);
  }

  try {
    await fs.promises.rm(path.join(storagePath, 'pdfs'), { recursive: true, force: true });
  } catch (error) {
    consoleLogger.warn(`Unable to force remove pdfs folder: ${error.message}`);
  }

  // Take option if set
  if (typeof zip === 'string') {
    constants.cliZipFileName = zip;

    if (!zip.endsWith('.zip')) {
      constants.cliZipFileName += '.zip';
    }
  }

  if (
    !path.isAbsolute(constants.cliZipFileName) ||
    path.dirname(constants.cliZipFileName) === '.'
  ) {
    constants.cliZipFileName = path.join(storagePath, constants.cliZipFileName);
  }

  try {
    await fs.ensureDir(storagePath);

    await zipResults(constants.cliZipFileName, storagePath);

    const messageToDisplay = [
      `Report of this run is at ${constants.cliZipFileName}`,
      `Results directory is at ${storagePath}`,
    ];

    if (process.send && process.env.OOBEE_VERBOSE) {
      const zipFileNameMessage = {
        type: 'zipFileName',
        payload: `${constants.cliZipFileName}`,
      };
      const storagePathMessage = {
        type: 'storagePath',
        payload: `${storagePath}`,
      };

      process.send(JSON.stringify(storagePathMessage));

      process.send(JSON.stringify(zipFileNameMessage));
    }

    printMessage(messageToDisplay);
  } catch (error) {
    printMessage([`Error in zipping results: ${error}`]);
  }

  // Generate scrubbed HTML Code Snippets
  const ruleIdJson = createRuleIdJson(allIssues);

  // At the end of the function where results are generated, add:
  try {
    // Always send WCAG breakdown to Sentry, even if no violations were found
    // This ensures that all criteria are reported, including those with 0 occurrences
    await sendWcagBreakdownToSentry(
      oobeeAppVersion,
      wcagOccurrencesMap,
      ruleIdJson,
      {
        entryUrl: urlScanned,
        scanType,
        browser: scanDetails.deviceChosen,
        email: scanDetails.nameEmail?.email,
        name: scanDetails.nameEmail?.name,
      },
      allIssues,
      pagesScanned.length,
    );
  } catch (error) {
    console.error('Error sending WCAG data to Sentry:', error);
  }

  if (process.env.RUNNING_FROM_PH_GUI || process.env.OOBEE_VERBOSE)
    console.log('Report generated successfully');

  return ruleIdJson;
};

export {
  writeHTML,
  compressJsonFileStreaming,
  convertItemsToReferences,
  flattenAndSortResults,
  populateScanPagesDetail,
  sendWcagBreakdownToSentry,
  getWcagPassPercentage,
  getProgressPercentage,
  getIssuesPercentage,
  itemTypeDescription,
  oobeeAiHtmlETL,
  oobeeAiRules,
  formatAboutStartTime,
};

export default generateArtifacts;
