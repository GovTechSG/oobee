import { execSync, spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import constants, {
  BrowserTypes,
  destinationPath,
  getIntermediateScreenshotsPath,
} from './constants/constants.js';
import { consoleLogger, silentLogger } from './logs.js';
import { getAxeConfiguration } from './crawlers/custom/getAxeConfiguration.js';
import axe from 'axe-core';
import { Rule, RuleMetadata } from 'axe-core';

export const getVersion = () => {
  const loadJSON = filePath =>
    JSON.parse(fs.readFileSync(new URL(filePath, import.meta.url)).toString());
  const versionNum = loadJSON('../package.json').version;

  return versionNum;
};

export const getHost = url => new URL(url).host;

export const getCurrentDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

export const isWhitelistedContentType = contentType => {
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

export const createDetailsAndLogs = async randomToken => {
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
            console.log(
              `Unable to copy the file from 'errors.txt' to '${logPath}/${randomToken}.txt' because it is currently in use.`,
            );
            console.log(
              'Please close any applications that might be using this file and try again.',
            );
          } else {
            console.log(`An unexpected error occurred while copying the file: ${error.message}`);
          }
        }
      }
    });
  } catch (error) {
    console.log(`An error occurred while setting up storage or log directories: ${error.message}`);
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
    return userData;
  }
  return null;
};

export const writeToUserDataTxt = async (key, value) => {
  const textFilePath = getUserDataFilePath();

  // Create file if it doesn't exist
  if (fs.existsSync(textFilePath)) {
    const userData = JSON.parse(fs.readFileSync(textFilePath, 'utf8'));
    userData[key] = value;
    fs.writeFileSync(textFilePath, JSON.stringify(userData, null, 2));
  } else {
    const textFilePathDir = path.dirname(textFilePath);
    if (!fs.existsSync(textFilePathDir)) {
      fs.mkdirSync(textFilePathDir, { recursive: true });
    }
    fs.appendFileSync(textFilePath, JSON.stringify({ [key]: value }, null, 2));
  }
};

export const createAndUpdateResultsFolders = async randomToken => {
  const storagePath = getStoragePath(randomToken);
  await fs.ensureDir(`${storagePath}`);

  const intermediatePdfResultsPath = `${randomToken}/${constants.pdfScanResultFileName}`;

  const transferResults = async (intermPath, resultFile) => {
    try {
      if (fs.existsSync(intermPath)) {
        await fs.copy(intermPath, `${storagePath}/${resultFile}`);
      }
    } catch (error) {
      if (error.code === 'EBUSY') {
        console.log(
          `Unable to copy the file from ${intermPath} to ${storagePath}/${resultFile} because it is currently in use.`,
        );
        console.log('Please close any applications that might be using this file and try again.');
      } else {
        console.log(
          `An unexpected error occurred while copying the file from ${intermPath} to ${storagePath}/${resultFile}: ${error.message}`,
        );
      }
    }
  };

  await Promise.all([transferResults(intermediatePdfResultsPath, constants.pdfScanResultFileName)]);
};

export const createScreenshotsFolder = randomToken => {
  const storagePath = getStoragePath(randomToken);
  const intermediateScreenshotsPath = getIntermediateScreenshotsPath(randomToken);
  if (fs.existsSync(intermediateScreenshotsPath)) {
    fs.readdir(intermediateScreenshotsPath, (err, files) => {
      if (err) {
        console.log(`Screenshots were not moved successfully: ${err.message}`);
      }

      if (!fs.existsSync(destinationPath(storagePath))) {
        try {
          fs.mkdirSync(destinationPath(storagePath), { recursive: true });
        } catch (error) {
          console.error('Screenshots folder was not created successfully:', error);
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
          console.log(rmdirErr);
        }
      });
    });
  }
};

export const cleanUp = async pathToDelete => {
  fs.removeSync(pathToDelete);
};

export const getWcagPassPercentage = (
  wcagViolations: string[],
  showEnableWcagAaa: boolean
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
  const passedChecksAAandAAA = showEnableWcagAaa ? totalChecksAAandAAA - wcagViolationsAAandAAA : null;
  const passPercentageAAandAAA = showEnableWcagAaa ? (totalChecksAAandAAA === 0 ? 0 : (passedChecksAAandAAA / totalChecksAAandAAA) * 100) : null;

  const wcagViolationsAA = wcagViolations.filter(violation => !wcagAAA.includes(violation)).length;
  const totalChecksAA = Object.keys(wcagLinksAAandAAA).filter(key => !wcagAAALinks.includes(key)).length;
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

export interface ScanPagesDetail {
  oobeeAppVersion?: string;
  pagesAffected: PageDetail[];
  pagesNotAffected: PageDetail[];
  scannedPagesCount: number;
  pagesNotScanned: PageDetail[];
  pagesNotScannedCount: number;
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

export type IssueCategory = "mustFix" | "goodToFix" | "needsReview" | "passed";

export interface IssueDetail {
  ruleId: string;
  wcagConformance: string[];
  occurrencesMustFix?: number;
  occurrencesGoodToFix?: number;
  occurrencesNeedsReview?: number;
  occurrencesPassed: number;
}

export const getProgressPercentage = (
  scanPagesDetail: ScanPagesDetail,
  showEnableWcagAaa: boolean
): {
  averageProgressPercentageAA: string;
  averageProgressPercentageAAandAAA: string;
} => {
  const pages = scanPagesDetail.pagesAffected || [];
  
  const progressPercentagesAA = pages.map((page: any) => {
    const violations: string[] = page.conformance;
    return getWcagPassPercentage(violations, showEnableWcagAaa).passPercentageAA;
  });
  
  const progressPercentagesAAandAAA = pages.map((page: any) => {
    const violations: string[] = page.conformance;
    return getWcagPassPercentage(violations, showEnableWcagAaa).passPercentageAAandAAA;
  });
  
  const totalAA = progressPercentagesAA.reduce((sum, p) => sum + parseFloat(p), 0);
  const avgAA = progressPercentagesAA.length ? totalAA / progressPercentagesAA.length : 0;

  const totalAAandAAA = progressPercentagesAAandAAA.reduce((sum, p) => sum + parseFloat(p), 0);
  const avgAAandAAA = progressPercentagesAAandAAA.length ? totalAAandAAA / progressPercentagesAAandAAA.length : 0;
  
  return { 
    averageProgressPercentageAA: avgAA.toFixed(2),
    averageProgressPercentageAAandAAA: avgAAandAAA.toFixed(2),
  };
};

export const getTotalRulesCount = async (
  enableWcagAaa: boolean,
  disableOobee: boolean
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
  const defaultRules = await axe.getRules();

  // Merge custom rules with default rules, converting RuleMetadata to Rule
  const mergedRules: Rule[] = defaultRules.map((defaultRule) => {
    const customRule = axeConfig.rules.find((r) => r.id === defaultRule.ruleId);
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
    } else {
      // Convert defaultRule (RuleMetadata) to Rule
      return {
        id: defaultRule.ruleId,
        enabled: true, // Default to true if not overridden
        tags: defaultRule.tags,
        // No metadata here, since defaultRule.metadata might not exist
      };
    }
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
  await axe.configure({ ...axeConfig, rules: mergedRules });

  const rules = await axe.getRules();

  // ... (rest of your logic)
  let totalRulesMustFix = 0;
  let totalRulesGoodToFix = 0;

  const wcagRegex = /^wcag\d+a+$/;

  // Use mergedRules instead of rules to check enabled property
  mergedRules.forEach((rule) => {
    if (!rule.enabled) {
      return;
    }

    if (rule.id === 'frame-tested') return; // Ignore 'frame-tested' rule

    const tags = rule.tags || [];

    // Skip experimental and deprecated rules
    if (tags.includes('experimental') || tags.includes('deprecated')) {
      return;
    }

    let conformance = tags.filter(tag => tag.startsWith('wcag') || tag === 'best-practice');

    // Ensure conformance level is sorted correctly
    if (conformance.length > 0 && conformance[0] !== 'best-practice' && !wcagRegex.test(conformance[0])) {
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

      totalRulesGoodToFix++; // Categorized as "Good to Fix"
    } else {
      // console.log(`${totalRulesMustFix} Must Fix: ${rule.id}`);

      totalRulesMustFix++; // Otherwise, it's "Must Fix"
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
  disableOobee: boolean
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
}> => {
  const pages = scanPagesDetail.pagesAffected || [];

  const typesOfIssuesCountAtMustFix = pages.map((page) =>
    page.typesOfIssues.filter((issue) => (issue.occurrencesMustFix || 0) > 0).length
  );

  const typesOfIssuesCountAtGoodToFix = pages.map((page) =>
    page.typesOfIssues.filter((issue) => (issue.occurrencesGoodToFix || 0) > 0).length
  );

  const typesOfIssuesCountSumMustFixAndGoodToFix = pages.map(
    (_, index) =>
      (typesOfIssuesCountAtMustFix[index] || 0) +
      (typesOfIssuesCountAtGoodToFix[index] || 0)
  );

  // Get the total rules count for normalization
  const { totalRulesMustFix, totalRulesGoodToFix, totalRulesMustFixAndGoodToFix } = await getTotalRulesCount(
    enableWcagAaa,
    disableOobee
  );

  // Compute average issues per page first
  const avgMustFixPerPage = pages.length > 0
    ? typesOfIssuesCountAtMustFix.reduce((sum, count) => sum + count, 0) / pages.length
    : 0;

  const avgGoodToFixPerPage = pages.length > 0
    ? typesOfIssuesCountAtGoodToFix.reduce((sum, count) => sum + count, 0) / pages.length
    : 0;

  const avgMustFixAndGoodToFixPerPage = pages.length > 0
    ? typesOfIssuesCountSumMustFixAndGoodToFix.reduce((sum, count) => sum + count, 0) / pages.length
    : 0;

  // Compute percentages based on total rules
  const avgTypesOfIssuesPercentageOfTotalRulesAtMustFix =
    totalRulesMustFix > 0
      ? ((avgMustFixPerPage / totalRulesMustFix) * 100).toFixed(2)
      : "0.00";

  const avgTypesOfIssuesPercentageOfTotalRulesAtGoodToFix =
    totalRulesGoodToFix > 0
      ? ((avgGoodToFixPerPage / totalRulesGoodToFix) * 100).toFixed(2)
      : "0.00";

  const avgTypesOfIssuesPercentageOfTotalRulesAtMustFixAndGoodToFix =
    totalRulesMustFixAndGoodToFix > 0
      ? ((avgMustFixAndGoodToFixPerPage / totalRulesMustFixAndGoodToFix) * 100).toFixed(2)
      : "0.00";

  // Compute raw count averages (without normalization)
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
  };
};
export const getFormattedTime = inputDate => {
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

export const formatDateTimeForMassScanner = date => {
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

export const setThresholdLimits = setWarnLevel => {
  process.env.WARN_LEVEL = setWarnLevel;
};

export const zipResults = (zipName, resultsPath) => {
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
export const areLinksEqual = (link1, link2) => {
  try {
    const format = link => {
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

export const isFollowStrategy = (link1, link2, rule) => {
  const parsedLink1 = new URL(link1);
  const parsedLink2 = new URL(link2);
  if (rule === 'same-domain') {
    const link1Domain = parsedLink1.hostname.split('.').slice(-2).join('.');
    const link2Domain = parsedLink2.hostname.split('.').slice(-2).join('.');
    return link1Domain === link2Domain;
  }
  return parsedLink1.hostname === parsedLink2.hostname;
};

/* eslint-disable no-await-in-loop */
export const retryFunction = async (func, maxAttempt) => {
  let attemptCount = 0;
  while (attemptCount < maxAttempt) {
    attemptCount += 1;
    try {
      const result = await func();
      return result;
    } catch (error) {
      silentLogger.error(`(Attempt count: ${attemptCount} of ${maxAttempt}) ${error}`);
    }
  }
};
/* eslint-enable no-await-in-loop */
