import { execSync, spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import axe, { Rule } from 'axe-core';
import { v4 as uuidv4 } from 'uuid';
import constants, {
  BrowserTypes,
  destinationPath,
  getIntermediateScreenshotsPath,
} from './constants/constants.js';
import { consoleLogger, silentLogger } from './logs.js';
import { getAxeConfiguration } from './crawlers/custom/getAxeConfiguration.js';

export const getVersion = () => {
  const loadJSON = (filePath: string): { version: string } =>
    JSON.parse(fs.readFileSync(new URL(filePath, import.meta.url)).toString());
  const versionNum = loadJSON('../package.json').version;

  return versionNum;
};

export const getHost = (url: string): string => new URL(url).host;

export const getCurrentDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

export const isWhitelistedContentType = (contentType: string): boolean => {
  const whitelist = ['text/html'];
  return whitelist.filter(type => contentType.trim().startsWith(type)).length === 1;
};

export const getStoragePath = (randomToken: string): string => {
  if (process.env.OOBEE_VERBOSE_STORAGE_PATH) {
    return `${process.env.OOBEE_VERBOSE_STORAGE_PATH}/${randomToken}`;
  }
  if (constants.exportDirectory === process.cwd()) {
    return `results/${randomToken}`;
  }
  if (!path.isAbsolute(constants.exportDirectory)) {
    constants.exportDirectory = path.resolve(process.cwd(), constants.exportDirectory);
  }
  return `${constants.exportDirectory}/${randomToken}`;
};

export const createDetailsAndLogs = async (randomToken: string): Promise<void> => {
  const storagePath = getStoragePath(randomToken);
  const logPath = `logs/${randomToken}`;
  try {
    await fs.ensureDir(storagePath);

    // update logs
    await fs.ensureDir(logPath);
    await fs.pathExists('errors.txt').then(async exists => {
      if (exists) {
        try {
          await fs.copy('errors.txt', `${logPath}/${randomToken}.txt`);
        } catch (error) {
          if (error.code === 'EBUSY') {
            consoleLogger.error(
              `Unable to copy the file from 'errors.txt' to '${logPath}/${randomToken}.txt' because it is currently in use.`,
            );
            consoleLogger.error(
              'Please close any applications that might be using this file and try again.',
            );
          } else {
            consoleLogger.error(
              `An unexpected error occurred while copying the file: ${error.message}`,
            );
          }
        }
      }
    });
  } catch (error) {
    consoleLogger.error(
      `An error occurred while setting up storage or log directories: ${error.message}`,
    );
  }
};

export const getUserDataFilePath = () => {
  const platform = os.platform();
  if (platform === 'win32') {
    return path.join(process.env.APPDATA, 'Oobee', 'userData.txt');
  }
  if (platform === 'darwin') {
    return path.join(process.env.HOME, 'Library', 'Application Support', 'Oobee', 'userData.txt');
  }
  // linux and other OS
  return path.join(process.env.HOME, '.config', 'oobee', 'userData.txt');
};

export const getUserDataTxt = () => {
  const textFilePath = getUserDataFilePath();

  // check if textFilePath exists
  if (fs.existsSync(textFilePath)) {
    const userData = JSON.parse(fs.readFileSync(textFilePath, 'utf8'));
    // If userId doesn't exist, generate one and save it
    if (!userData.userId) {
      userData.userId = uuidv4();
      fs.writeFileSync(textFilePath, JSON.stringify(userData, null, 2));
    }
    return userData;
  }
  return null;
};

export const writeToUserDataTxt = async (key: string, value: string): Promise<void> => {
  const textFilePath = getUserDataFilePath();

  // Create file if it doesn't exist
  if (fs.existsSync(textFilePath)) {
    const userData = JSON.parse(fs.readFileSync(textFilePath, 'utf8'));
    userData[key] = value;
    // Ensure userId exists
    if (!userData.userId) {
      userData.userId = uuidv4();
    }
    fs.writeFileSync(textFilePath, JSON.stringify(userData, null, 2));
  } else {
    const textFilePathDir = path.dirname(textFilePath);
    if (!fs.existsSync(textFilePathDir)) {
      fs.mkdirSync(textFilePathDir, { recursive: true });
    }
    // Initialize with userId
    fs.appendFileSync(textFilePath, JSON.stringify({ [key]: value, userId: uuidv4() }, null, 2));
  }
};

export const createAndUpdateResultsFolders = async (randomToken: string): Promise<void> => {
  const storagePath = getStoragePath(randomToken);
  await fs.ensureDir(`${storagePath}`);

  const intermediatePdfResultsPath = `${randomToken}/${constants.pdfScanResultFileName}`;

  const transferResults = async (intermPath: string, resultFile: string): Promise<void> => {
    try {
      if (fs.existsSync(intermPath)) {
        await fs.copy(intermPath, `${storagePath}/${resultFile}`);
      }
    } catch (error) {
      if (error.code === 'EBUSY') {
        consoleLogger.error(
          `Unable to copy the file from ${intermPath} to ${storagePath}/${resultFile} because it is currently in use.`,
        );
        consoleLogger.error(
          'Please close any applications that might be using this file and try again.',
        );
      } else {
        consoleLogger.error(
          `An unexpected error occurred while copying the file from ${intermPath} to ${storagePath}/${resultFile}: ${error.message}`,
        );
      }
    }
  };

  await Promise.all([transferResults(intermediatePdfResultsPath, constants.pdfScanResultFileName)]);
};

export const createScreenshotsFolder = (randomToken: string): void => {
  const storagePath = getStoragePath(randomToken);
  const intermediateScreenshotsPath = getIntermediateScreenshotsPath(randomToken);
  if (fs.existsSync(intermediateScreenshotsPath)) {
    fs.readdir(intermediateScreenshotsPath, (err, files) => {
      if (err) {
        consoleLogger.error(`Screenshots were not moved successfully: ${err.message}`);
      }

      if (!fs.existsSync(destinationPath(storagePath))) {
        try {
          fs.mkdirSync(destinationPath(storagePath), { recursive: true });
        } catch (error) {
          consoleLogger.error('Screenshots folder was not created successfully:', error);
        }
      }

      files.forEach(file => {
        fs.renameSync(
          `${intermediateScreenshotsPath}/${file}`,
          `${destinationPath(storagePath)}/${file}`,
        );
      });

      fs.rmdir(intermediateScreenshotsPath, rmdirErr => {
        if (rmdirErr) {
          consoleLogger.error(rmdirErr);
        }
      });
    });
  }
};

export const cleanUp = (pathToDelete: string): void => {
  fs.removeSync(pathToDelete);
};

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
  const wcagAAALinks = ['WCAG 1.4.6', 'WCAG 2.2.4', 'WCAG 2.4.9', 'WCAG 3.1.5', 'WCAG 3.2.5'];
  const wcagAAA = ['wcag146', 'wcag224', 'wcag249', 'wcag315', 'wcag325'];

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

/**
 * Dynamically generates a map of WCAG criteria IDs to their details (name and level)
 * Reuses the rule processing logic from getTotalRulesCount
 */
export const getWcagCriteriaMap = async (
  enableWcagAaa: boolean = true,
  disableOobee: boolean = false
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
            if (criterion && 
                criterion.num && 
                `wcag${criterion.num.replace(/\./g, '')}` === wcagId) {
              
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
          level
        };
      }
    });
  });
  
  return wcagCriteriaMap;
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

export const getFormattedTime = (inputDate: Date): string => {
  if (inputDate) {
    return inputDate.toLocaleTimeString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour12: false,
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  return new Date().toLocaleTimeString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour12: false,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'longGeneric',
  });
};

export const formatDateTimeForMassScanner = (date: Date): string => {
  // Format date and time parts separately
  const year = date.getFullYear().toString().slice(-2); // Get the last two digits of the year
  const month = `0${date.getMonth() + 1}`.slice(-2); // Month is zero-indexed
  const day = `0${date.getDate()}`.slice(-2);
  const hour = `0${date.getHours()}`.slice(-2);
  const minute = `0${date.getMinutes()}`.slice(-2);

  // Combine formatted date and time with a slash
  const formattedDateTime = `${day}/${month}/${year} ${hour}:${minute}`;

  return formattedDateTime;
};

export const setHeadlessMode = (browser: string, isHeadless: boolean): void => {
  const isWindowsOSAndEdgeBrowser = browser === BrowserTypes.EDGE && os.platform() === 'win32';
  if (isHeadless || isWindowsOSAndEdgeBrowser) {
    process.env.CRAWLEE_HEADLESS = '1';
  } else {
    process.env.CRAWLEE_HEADLESS = '0';
  }
};

export const setThresholdLimits = (setWarnLevel: string): void => {
  process.env.WARN_LEVEL = setWarnLevel;
};

export const zipResults = (zipName: string, resultsPath: string): void => {
  // Check prior zip file exist and remove
  if (fs.existsSync(zipName)) {
    fs.unlinkSync(zipName);
  }

  if (os.platform() === 'win32') {
    execSync(
      `Get-ChildItem -Path "${resultsPath}\\*.*" -Recurse | Compress-Archive -DestinationPath "${zipName}"`,
      { shell: 'powershell.exe' },
    );
  } else {
    // Get zip command in Mac and Linux
    const command = '/usr/bin/zip';
    // Check if user specified absolute or relative path
    const zipFilePath = path.isAbsolute(zipName) ? zipName : path.join(process.cwd(), zipName);

    // To zip up files recursively (-r) in the results folder path and write it to user's specified path
    const args = ['-r', zipFilePath, '.'];

    // Change working directory only for the zip command
    const options = {
      cwd: resultsPath,
    };

    spawnSync(command, args, options);
  }
};

// areLinksEqual compares 2 string URLs and ignores comparison of 'www.' and url protocol
// i.e. 'http://google.com' and 'https://www.google.com' returns true
export const areLinksEqual = (link1: string, link2: string): boolean => {
  try {
    const format = (link: string): URL => {
      return new URL(link.replace(/www\./, ''));
    };
    const l1 = format(link1);
    const l2 = format(link2);

    const areHostEqual = l1.host === l2.host;
    const arePathEqual = l1.pathname === l2.pathname;

    return areHostEqual && arePathEqual;
  } catch {
    return link1 === link2;
  }
};

export const randomThreeDigitNumberString = () => {
  // Generate a random decimal between 0 (inclusive) and 1 (exclusive)
  const randomDecimal = Math.random();
  // Multiply by 900 to get a decimal between 0 (inclusive) and 900 (exclusive)
  const scaledDecimal = randomDecimal * 900;
  // Add 100 to ensure the result is between 100 (inclusive) and 1000 (exclusive)
  const threeDigitNumber = Math.floor(scaledDecimal) + 100;
  return String(threeDigitNumber);
};

export const isFollowStrategy = (link1: string, link2: string, rule: string): boolean => {
  const parsedLink1 = new URL(link1);
  const parsedLink2 = new URL(link2);
  if (rule === 'same-domain') {
    const link1Domain = parsedLink1.hostname.split('.').slice(-2).join('.');
    const link2Domain = parsedLink2.hostname.split('.').slice(-2).join('.');
    return link1Domain === link2Domain;
  }
  return parsedLink1.hostname === parsedLink2.hostname;
};

export const retryFunction = async <T>(func: () => Promise<T>, maxAttempt: number): Promise<T> => {
  let attemptCount = 0;
  while (attemptCount < maxAttempt) {
    attemptCount += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await func();
      return result;
    } catch (error) {
      silentLogger.error(`(Attempt count: ${attemptCount} of ${maxAttempt}) ${error}`);
    }
  }
  throw new Error('Maximum number of attempts reached');
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
  disableOobee: boolean = false
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
      const checks = [
        ...(ruleObj.any || []),
        ...(ruleObj.all || []),
        ...(ruleObj.none || [])
      ];
      
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
        const explicitlyReturnsUndefined = evaluateCode.includes('return undefined') || 
                                          evaluateCode.includes('return;');
        
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
        if (ruleObj.metadata.incomplete === true ||
            (ruleObj.metadata.messages && 'incomplete' in ruleObj.metadata.messages)) {
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
          ((rule as any)?.metadata?.messages?.incomplete !== undefined) ||
          (axeConfig.checks || []).some(check => 
            check.id === rule.id && 
            (check.metadata?.messages?.incomplete !== undefined));
        
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
  disableOobee: boolean = false
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
  } else {
    return 'goodToFix';
  }
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
  disableOobee: boolean = false
): Promise<Record<string, 'mustFix' | 'goodToFix' | 'needsReview'>> => {
  // Get both maps once to avoid repeated expensive calls
  const [needsReviewMap, wcagCriteriaMap] = await Promise.all([
    getPotentialNeedsReviewWcagCriteria(enableWcagAaa, disableOobee),
    getWcagCriteriaMap(enableWcagAaa, disableOobee)
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
