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
import { consoleLogger, errorsTxtPath, silentLogger } from './logs.js';
import { getAxeConfiguration } from './crawlers/custom/getAxeConfiguration.js';
import JSZip from 'jszip';
import { createReadStream, createWriteStream } from 'fs';

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

export const getPdfStoragePath = (randomToken: string): string => {
  const storagePath = getStoragePath(randomToken);
  const pdfStoragePath = path.join(storagePath, 'pdfs');
  if (!fs.existsSync(pdfStoragePath)) {
    fs.mkdirSync(pdfStoragePath, { recursive: true });
  }
  return pdfStoragePath;
};

export const getStoragePath = (randomToken: string): string => {
  // If exportDirectory is set, use it
  if (constants.exportDirectory) {
    return constants.exportDirectory;
  }

  // Otherwise, use the current working directory
  let storagePath = path.join(process.cwd(), 'results', randomToken);

  // Ensure storagePath is writable; if directory doesn't exist, try to create it in Documents or home directory
  const isWritable = (() => {
    try {
      if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
      }
      fs.accessSync(storagePath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();

  if (!isWritable) {
    if (os.platform() === 'win32') {
      // Use Documents folder on Windows
      const documentsPath = path.join(process.env.USERPROFILE || process.env.HOMEPATH || '', 'Documents');
      storagePath = path.join(documentsPath, 'Oobee', randomToken);
    } else if (os.platform() === 'darwin') {
      // Use Documents folder on Mac
      const documentsPath = path.join(process.env.HOME || '', 'Documents');
      storagePath = path.join(documentsPath, 'Oobee', randomToken);
    } else {
      // Use home directory for Linux/other
      const homePath = process.env.HOME || '';
      storagePath = path.join(homePath, 'Oobee', randomToken);
    }
    consoleLogger.warn(`Warning: Cannot write to cwd, writing to ${storagePath}`);

  }

  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  constants.exportDirectory = storagePath;
  return storagePath;

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


let __shuttingDown = false;
let __stopAllLock: Promise<void> | null = null;

/**
 * Register a resource so it can be stopped later.
 * Supports Crawlee crawlers, Playwright BrowserContexts, and Browsers.
 */
export function register(resource: any) {
  const name = resource?.constructor?.name;

  if (name?.endsWith('Crawler')) {
    constants.resources.crawlers.add(resource);
  } else if (name === 'BrowserContext') {
    constants.resources.browserContexts.add(resource);
  } else if (name === 'Browser') {
    constants.resources.browsers.add(resource);
  }

  return resource;
}

/**
 * Stops or tears down all tracked resources.
 * @param mode "graceful" (finish in-flight), "abort" (drop in-flight), or "teardown" (close immediately)
 * @param timeoutMs Max time to wait before forcing shutdown
 */
export async function stopAll({ mode = 'graceful', timeoutMs = 10_000 } = {}) {
  if (__stopAllLock) return __stopAllLock; // prevent overlap
  __stopAllLock = (async () => {
    const timeout = (ms: number) => new Promise(res => setTimeout(res, ms));
    consoleLogger.info(`Stop browsers starting, mode=${mode}, timeoutMs=${timeoutMs}`);

    // --- Crawlers ---
    for (const c of [...constants.resources.crawlers]) {
      try {
        const pool = (c as any).autoscaledPool;
        if (pool && typeof pool.isRunning !== 'undefined' && !pool.isRunning) {
          consoleLogger.info('Skipping crawler (already stopped)');
          continue;
        }

        consoleLogger.info(`Closing crawler (${mode})...`);
        if (mode === 'graceful') {
          if (typeof c.stop === 'function') {
            await Promise.race([c.stop(), timeout(timeoutMs)]);
          }
        } else if (mode === 'abort') {
          pool?.abort?.();
        } else {
          if (typeof c.teardown === 'function') {
            await Promise.race([c.teardown(), timeout(timeoutMs)]);
          }
        }
        consoleLogger.info(`Crawler closed (${mode})`);
      } catch (err) {
        consoleLogger.warn(`Error stopping crawler: ${(err as Error).message}`);
      } finally {
        constants.resources.crawlers.delete(c);
      }
    }

    // --- BrowserContexts ---
    for (const ctx of [...constants.resources.browserContexts]) {
      // compute once so we can also use in finally
      const pagesArr = typeof ctx.pages === 'function' ? ctx.pages() : [];
      const hasOpenPages = Array.isArray(pagesArr) && pagesArr.length > 0;

      try {
        const browser = typeof ctx.browser === 'function' ? ctx.browser() : null;
        if (browser && (browser as any).isClosed?.()) {
          consoleLogger.info('Skipping BrowserContext (browser already closed)');
          continue;
        }

        // ➜ Graceful: don't kill contexts that are still doing work
        if (mode === 'graceful' && hasOpenPages) {
          consoleLogger.info(`Skipping BrowserContext in graceful (has ${pagesArr.length} open page(s))`);
          continue; // leave it for the teardown pass
        }

        // (Optional speed-up) close pages first if any
        if (hasOpenPages) {
          consoleLogger.info(`Closing ${pagesArr.length} page(s) before context close...`);
          for (const p of pagesArr) {
            try { await Promise.race([p.close(), timeout(1500)]); } catch {}
          }
        }

        consoleLogger.info('Closing BrowserContext...');
        if (typeof ctx.close === 'function') {
          await Promise.race([ctx.close(), timeout(timeoutMs)]);
        }
        consoleLogger.info('BrowserContext closed');

        // also close its browser (persistent contexts)
        const b = browser;
        if (b && !(b as any).isClosed?.()) {
          consoleLogger.info('Closing Browser (from context.browser())...');
          if (typeof b.close === 'function') {
            await Promise.race([b.close(), timeout(timeoutMs)]);
          }
          consoleLogger.info('Browser closed (from context.browser())');
        }
      } catch (err) {
        consoleLogger.warn(`Error closing BrowserContext: ${(err as Error).message}`);
      } finally {
        // only delete from the set if we actually closed it (or tried to)
        if (!(mode === 'graceful' && hasOpenPages)) {
          constants.resources.browserContexts.delete(ctx);
        }
      }
    }

    // --- Browsers ---
    for (const b of [...constants.resources.browsers]) {
      try {
        if ((b as any).isClosed?.()) {
          consoleLogger.info('Skipping Browser (already closed)');
          continue;
        }

        consoleLogger.info('Closing Browser...');
        if (typeof b.close === 'function') {
          await Promise.race([b.close(), timeout(timeoutMs)]);
        }
        consoleLogger.info('Browser closed');
      } catch (err) {
        consoleLogger.warn(`Error closing Browser: ${(err as Error).message}`);
      } finally {
        constants.resources.browsers.delete(b);
      }
    }

    consoleLogger.info(`Stop browsers finished for mode=${mode}`);
  })();

  try {
    await __stopAllLock;
  } finally {
    __stopAllLock = null;
  }
}

export const cleanUp = async (randomToken?: string, isError: boolean = false): Promise<void> => {

  if (isError) {
    await stopAll({ mode: 'graceful', timeoutMs: 8000 });
    await stopAll({ mode: 'teardown', timeoutMs: 4000 });
  }
  
  if (randomToken === undefined && constants.randomToken) {
    randomToken = constants.randomToken;
  }

  if (constants.userDataDirectory) try {
    fs.rmSync(constants.userDataDirectory, { recursive: true, force: true });
  } catch (error) {
    consoleLogger.warn(`Unable to force remove userDataDirectory: ${error.message}`);
  }

  if (randomToken !== undefined) {
    const storagePath = getStoragePath(randomToken);

    try {
      fs.rmSync(path.join(storagePath, 'crawlee'), { recursive: true, force: true });
    } catch (error) {
      consoleLogger.warn(`Unable to force remove crawlee folder: ${error.message}`);
    }

    try {
      fs.rmSync(path.join(storagePath, 'pdfs'), { recursive: true, force: true });
    } catch (error) {
      consoleLogger.warn(`Unable to force remove pdfs folder: ${error.message}`);
    }
    
    let deleteErrorLogFile = true;

    if (isError) {
      let logsPath = storagePath;

      if (process.env.OOBEE_LOGS_PATH) {
        logsPath = process.env.OOBEE_LOGS_PATH;
      }

      if (fs.existsSync(errorsTxtPath)) {
        try {
          const logFilePath = path.join(logsPath, `logs-${randomToken}.txt`);
          fs.copyFileSync(errorsTxtPath, logFilePath);
          console.log(`An error occured. Log file is located at: ${logFilePath}`);

        } catch (copyError) {
          consoleLogger.error(`Error copying errors file during cleanup: ${copyError.message}`);
          console.log(`An error occured. Log file is located at: ${errorsTxtPath}`);
          deleteErrorLogFile = false; // Do not delete the log file if copy failed
        }
    
        if (deleteErrorLogFile && fs.existsSync(errorsTxtPath)) {
          try {
            fs.unlinkSync(errorsTxtPath);
          } catch (error) {
            consoleLogger.warn(`Unable to delete log file ${errorsTxtPath}: ${error.message}`);
          }
        }

      }

    } 
    
    if (fs.existsSync(storagePath) && fs.readdirSync(storagePath).length === 0) {
      try {
        fs.rmdirSync(storagePath);
        consoleLogger.info(`Deleted empty storage path: ${storagePath}`);
    
      } catch (error) {
        consoleLogger.warn(`Error deleting empty storage path ${storagePath}: ${error.message}`);
      }
    }

    consoleLogger.info(`Clean up completed for: ${randomToken}`);
  } 

};

export const cleanUpAndExit = async (
  exitCode: number,
  randomToken?: string,
  isError: boolean = false,
): Promise<void> => {
  if (__shuttingDown) {
    consoleLogger.info('Cleanup already in progress; ignoring duplicate exit request.');
    return;
  }
  __shuttingDown = true;

  try {
    await cleanUp(randomToken, isError);   // runs stopAll inside cleanUp
  } catch (e: any) {
    consoleLogger.warn(`Cleanup error: ${e?.message || e}`);
  }

  consoleLogger.info(`Exiting with code: ${exitCode}`);
  process.exit(exitCode); // explicit exit after cleanup completes
};

export const listenForCleanUp = (randomToken: string): void => {
  consoleLogger.info(`PID: ${process.pid}`);

  process.on('SIGINT', async () => {   // ← keep handler installed
    consoleLogger.info('SIGINT received. Cleaning up and exiting.');
    await cleanUpAndExit(130, randomToken, true);
  });

  process.on('SIGTERM', async () => {  // ← keep handler installed
    consoleLogger.info('SIGTERM received. Cleaning up and exiting.');
    await cleanUpAndExit(143, randomToken, true);
  });
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
  const wcagAAALinks = ['WCAG 1.4.6', 'WCAG 2.2.4', 'WCAG 2.4.9', 'WCAG 3.1.5', 'WCAG 3.2.5', 'WCAG 2.1.3'];
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

export const zipResults = async (zipName: string, resultsPath: string): Promise<void> => {
  // Resolve and validate the output path
  const zipFilePath = path.isAbsolute(zipName) ? zipName : path.join(resultsPath, zipName);

  // Ensure parent dir exists
  fs.mkdirSync(path.dirname(zipFilePath), { recursive: true });

  // Remove any prior file atomically
  try { fs.unlinkSync(zipFilePath); } catch { /* ignore if not exists */ }

  // CWD must exist and be a directory
  const stats = fs.statSync(resultsPath);
  if (!stats.isDirectory()) {
    throw new Error(`resultsPath is not a directory: ${resultsPath}`);
  }
  async function addFolderToZip(folderPath: string, zipFolder: JSZip): Promise<void> {
    const items = await fs.readdir(folderPath);
    for (const item of items) {
      const fullPath = path.join(folderPath, item);
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        const folder = zipFolder.folder(item);
        await addFolderToZip(fullPath, folder);
      } else {
        // Add file as a stream so that it doesn't load the entire file into memory
        zipFolder.file(item, createReadStream(fullPath));
      }
    }
  }

  await addFolderToZip(resultsPath, new JSZip());

  const zip = new JSZip();
  await addFolderToZip(resultsPath, zip);

  const zipStream = zip.generateNodeStream({
    type: 'nodebuffer',
    streamFiles: true,
    compression: 'DEFLATE',
  });

  await new Promise((resolve, reject) => {
    const outStream = createWriteStream(zipFilePath);
    zipStream.pipe(outStream)
      .on('finish', resolve)
      .on('error', reject);
  });
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
      // do nothing, just retry  
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
