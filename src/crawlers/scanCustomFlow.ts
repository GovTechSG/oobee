import fs from 'fs';
import path from 'path';
import { EnqueueStrategy } from 'crawlee';

import constants, { BrowserTypes, RuleFlags, ScannerTypes, UrlsCrawled } from '../constants/constants.js';
import generateArtifacts from '../mergeAxeResults.js';
import { createAndUpdateResultsFolders, getStoragePath } from '../utils.js';
import { submitForm } from '../constants/common.js';
import runCustom from './runCustom.js';
import { consoleLogger } from '../logs.js';

const sanitisePathSegment = (value: string) => value.replace(/[^\w.-]/g, '_');

import type { ViewportSettingsClass } from '../combine.js';
import type {
  NormalizedScanItemsRule,
  ScanCustomFlowConfig,
  ScanCustomFlowResult,
  ScanCustomFlowSession,
  ScanItemsCategory,
  ScanItemsRule,
  ScanPageCategory,
  ScanPageResults,
  UnknownRecord,
} from '../types/scanCustomFlow.js';

const readGeneratedJson = async (filePath: string): Promise<unknown> => {
  const contents = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(contents);
};

const cleanupGeneratedArtifacts = async (resultDirectory: string): Promise<void> => {
  await fs.promises.rm(resultDirectory, { recursive: true, force: true });
};

const flattenScanItemsRuleItems = (rule: ScanItemsRule): UnknownRecord[] => {
  const items: UnknownRecord[] = [];
  for (const page of Array.isArray(rule?.pagesAffected) ? rule.pagesAffected : []) {
    for (const item of Array.isArray(page?.items) ? page.items : []) {
      items.push({
        ...item,
        selector: item?.selector || item?.xpath || '',
        url: page?.url,
        pageTitle: page?.pageTitle,
      });
    }
  }

  return items;
};

const convertScanItemsCategoryToScanPageCategory = (
  category: ScanItemsCategory = {},
): ScanPageCategory => {
  const rules: Record<string, NormalizedScanItemsRule> = {};

  for (const rule of Array.isArray(category?.rules) ? category.rules : []) {
    const ruleId = String(rule?.rule || rule?.id || rule?.description || 'unknown-rule');
    rules[ruleId] = {
      ...rule,
      items: flattenScanItemsRuleItems(rule),
    };
  }

  return {
    ...category,
    rules,
  };
};

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null;

const getScanItemsCategory = (
  scanItems: unknown,
  categoryKey: 'mustFix' | 'goodToFix' | 'needsReview',
): ScanItemsCategory => {
  if (!isRecord(scanItems)) {
    return {};
  }

  const category = scanItems[categoryKey];
  return isRecord(category) ? category as ScanItemsCategory : {};
};

const convertScanItemsToScanPageResults = (scanItems: unknown): ScanPageResults => ({
  mustFix: convertScanItemsCategoryToScanPageCategory(getScanItemsCategory(scanItems, 'mustFix')),
  goodToFix: convertScanItemsCategoryToScanPageCategory(getScanItemsCategory(scanItems, 'goodToFix')),
  needsReview: convertScanItemsCategoryToScanPageCategory(getScanItemsCategory(scanItems, 'needsReview')),
});

/**
 * Runs a headed custom-flow accessibility scan.
 *
 * NOTE: single-flight per Node process. This function mutates module-level
 * state on `constants` (`sitemapFetchedLinks`, `exportDirectory`) and sets
 * `process.env.CRAWLEE_LOG_LEVEL`; running two `scanCustomFlow` sessions
 * concurrently in the same process will cause them to clobber each other's
 * export directory. Serialise calls at the caller.
 */
export const scanCustomFlow = (config: ScanCustomFlowConfig): ScanCustomFlowSession => {
  const {
    url,
    name,
    email,
    browser = BrowserTypes.CHROME,
    deviceChosen = 'Desktop',
    customDevice = '',
    viewportWidth = 1920,
    playwrightDeviceDetailsObject = undefined,
    includeScreenshots = false,
    customFlowLabel = '',
    ruleset = [RuleFlags.DEFAULT],
    strategy = EnqueueStrategy.All,
    followRobots = false,
    blacklistedPatterns = null,
    extraHTTPHeaders = undefined,
    zip = 'oobee-scan-results',
    metadata = '{}', // Note: This is intentionally set {} as it is the default -q flag.
    cleanupArtifacts = true,
    waitForResultSubmission = true,
    maxPagesToScan,
  } = config;

  const [date, time] = new Date().toLocaleString('sv').replace(/[-:]/g, '').split(' ');
  const parsedUrl = new URL(url);
  const entryUrl = parsedUrl.href;
  const domain = parsedUrl.hostname;
  const sanitisedLabel = customFlowLabel ? `_${sanitisePathSegment(customFlowLabel)}` : '';
  const randomToken = config.randomToken || `${date}_${time}${sanitisedLabel}_${domain}`;
  const scanStartedAt = new Date();
  const viewportHeight =
    (playwrightDeviceDetailsObject as { viewport?: { height?: number } } | undefined)?.viewport
      ?.height ?? 1040;
  const scanDetails = {
    startTime: scanStartedAt,
    endTime: scanStartedAt,  // Note: This is a placeholder; it will be updated when the scan completes.
    deviceChosen,
    crawlType: ScannerTypes.CUSTOM,
    requestUrl: url,
    urlsCrawled: undefined as unknown as UrlsCrawled, // Assigned after runCustom completes.
    isIncludeScreenshots: includeScreenshots,
    isAllowSubdomains: strategy, // Note: Report generator treats this as the strategy string (checks `.includes('same-domain')`), not a boolean.
    isEnableCustomChecks: ruleset,
    isEnableWcagAaa: [] as RuleFlags[], // Note: This is not in used by today in runCustom.ts compared to runAxeScript in crawlDomain.ts
    isSlowScanMode: 1, // Note: Considering refactor this because for applicable for normal scan with concurrent scan only.
    isAdhereRobots: followRobots,
    nameEmail: { name, email },
  };
  const viewportSettings: ViewportSettingsClass = {
    deviceChosen,
    customDevice,
    viewportWidth,
    playwrightDeviceDetailsObject,
  };
  const scanAboutMetadata = {
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
    },
  };

  let stopCustomFlow: (() => Promise<void>) | undefined;
  let focusCustomFlow: (() => Promise<void>) | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const result = (async (): Promise<ScanCustomFlowResult> => {
    try {
      process.env.CRAWLEE_LOG_LEVEL = 'ERROR';
      constants.sitemapFetchedLinks = null;
      constants.exportDirectory = undefined; // Note: Reset global storage path so long-lived consumers start each scan in a fresh results folder. This is used when cleanupArtifacts is set to false.

      const customResult = await runCustom(
        url,
        randomToken,
        browser,
        '', // Note: Intended to be '' so user can use an isolated temporary browser profile; We do not want scan cookies/session/cache to persist into later scans.
        viewportSettings,
        blacklistedPatterns,
        includeScreenshots,
        undefined, // Note: Keep unset or undefined so the end-scan modal can collect a user-facing scan name.
        extraHTTPHeaders,
        {
          exitOnError: false,
          onReady: async controls => {
            stopCustomFlow = controls.stop;
            focusCustomFlow = controls.focus;
            await config.onReady?.();
            resolveReady();
          },
        },
        maxPagesToScan,
      );

      scanDetails.endTime = new Date();
      scanDetails.urlsCrawled = customResult.urlsCrawled;

      if (customResult.urlsCrawled.scanned.length === 0) {
        throw new Error('No pages were scanned.');
      }

      await createAndUpdateResultsFolders(randomToken);
      const pagesNotScanned = [
        ...customResult.urlsCrawled.error,
        ...customResult.urlsCrawled.invalid,
        ...customResult.urlsCrawled.forbidden,
        ...customResult.urlsCrawled.userExcluded,
      ];
      const userCustomFlowLabel = customResult.customFlowLabel?.trim();
      const artifactCustomFlowLabel = userCustomFlowLabel || customFlowLabel;

      const basicFormHTMLSnippet = await generateArtifacts(
        randomToken,
        url,
        ScannerTypes.CUSTOM,
        deviceChosen,
        customResult.urlsCrawled.scanned,
        pagesNotScanned,
        artifactCustomFlowLabel,
        scanAboutMetadata,
        scanDetails,
        zip,
        true,
        browser,
      );
      const resultDirectory = getStoragePath(randomToken);
      const scanData = await readGeneratedJson(path.join(resultDirectory, 'scanData.json'));
      const scanItems = await readGeneratedJson(path.join(resultDirectory, 'scanItems.json'));
      const scanResult: ScanCustomFlowResult = {
        customFlowLabel: userCustomFlowLabel,
        scanData,
        scanItems,
        results: convertScanItemsToScanPageResults(scanItems),
      };

      const submitResult = submitForm(
        browser,
        '', // Note: This is the userDataDirectory, which is intentionally left empty so that the scan uses a temporary browser profile and does not persist cookies/session/cache into later scans.
        url,
        entryUrl,
        ScannerTypes.CUSTOM,
        email,
        name,
        JSON.stringify(basicFormHTMLSnippet),
        customResult.urlsCrawled.scanned.length,
        customResult.urlsCrawled.scannedRedirects.length,
        pagesNotScanned.length,
        metadata,
      );

      if (waitForResultSubmission) {
        await submitResult;
      } else {
        void submitResult.catch(error => {
          consoleLogger.warn('[scanCustomFlow] Failed to submit scan result payload.', error);
        });
      }

      if (cleanupArtifacts) {
        await cleanupGeneratedArtifacts(resultDirectory);
      }

      return scanResult;
    } catch (error) {
      rejectReady(error);
      if (cleanupArtifacts) {
        await cleanupGeneratedArtifacts(getStoragePath(randomToken)).catch(() => {});
      }
      throw error;
    }
  })();

  return {
    ready,
    result,
    stop: async () => {
      await ready;
      if (!stopCustomFlow) {
        throw new Error('Custom flow browser is not ready to stop.');
      }
      await stopCustomFlow();
    },
    focus: async () => {
      await ready;
      if (!focusCustomFlow) {
        throw new Error('Custom flow browser is not ready to focus.');
      }
      await focusCustomFlow();
    },
  };
};
