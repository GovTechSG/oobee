import fs from 'fs';
import path from 'path';
import { EnqueueStrategy } from 'crawlee';

import constants, { BrowserTypes, RuleFlags, ScannerTypes, UrlsCrawled } from '../constants/constants.js';
import generateArtifacts from '../mergeAxeResults.js';
import { createAndUpdateResultsFolders, getStoragePath } from '../utils.js';
import {
  checkUrlConnectivityWithBrowser,
  isInternalOrLoopbackUrl,
  isLinkLocalOrMetadataUrl,
  submitForm,
} from '../constants/common.js';
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
 * export directory. Enforced: a call made while another session is running
 * rejects immediately (asgard-0010). Serialise calls at the caller.
 */
let customFlowSessionActive = false;

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
    scanSource,
    overlayScope,
    useExtensionOverlayUi,
    extensionSessionOrigin,
  } = config;

  const [date, time] = new Date().toLocaleString('sv').replace(/[-:]/g, '').split(' ');
  const parsedUrl = new URL(url);
  const entryUrl = parsedUrl.href;
  const domain = parsedUrl.hostname;
  const sanitisedLabel = customFlowLabel ? `_${sanitisePathSegment(customFlowLabel)}` : '';
  // A caller-supplied randomToken is used directly as the results directory
  // segment (see getStoragePath). Apply the same character allowlist as the
  // generated tokens so a hostile "config.randomToken" cannot climb out of
  // the results dir via "../".
  const rawRandomToken = config.randomToken || `${date}_${time}${sanitisedLabel}_${domain}`;
  const randomToken = sanitisePathSegment(rawRandomToken);
  if (!randomToken) {
    throw new Error('Invalid randomToken supplied to scanCustomFlow');
  }
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
    scanSource,
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
    // asgard-0010 (2026-10-09 scan): enforce single-flight in code. A second
    // concurrent session would share constants.exportDirectory with the first
    // and read/submit (or clean up) the other session's results. Refuse it
    // before touching any shared state, so the running session is unaffected.
    if (customFlowSessionActive) {
      const busy = new Error(
        'scanCustomFlow is already running in this process; wait for the current session to finish.',
      );
      rejectReady(busy);
      throw busy;
    }
    customFlowSessionActive = true;
    try {
      process.env.CRAWLEE_LOG_LEVEL = 'ERROR';
      constants.sitemapFetchedLinks = null;
      constants.exportDirectory = undefined; // Note: Reset global storage path so long-lived consumers start each scan in a fresh results folder. This is used when cleanupArtifacts is set to false.
      await validateCustomFlowEntryUrl({
        url,
        browser,
        extraHTTPHeaders,
        playwrightDeviceDetailsObject,
      });

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
        {
          overlayScope,
          useExtensionOverlayUi,
          extensionSessionOrigin,
        },
      );

      try {
        await config.onFinalizing?.();
      } catch (error) {
        consoleLogger.warn('[scanCustomFlow] Failed to run onFinalizing callback.', error);
      }

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
    } finally {
      customFlowSessionActive = false;
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

// Opt-in SSRF hardening for the exported scanCustomFlow entry point. Off by
// default so operator/CLI scans of localhost, internal hosts and file:// URLs
// keep working unchanged. SECURITY: consumers that forward config.url from
// untrusted end users MUST set OOBEE_SSRF_PROTECTION=1 — without it the
// scanner can reach internal hosts and local files and embed them in reports.
const isSsrfProtectionEnabled = (): boolean =>
  /^(1|true|yes)$/i.test(process.env.OOBEE_SSRF_PROTECTION ?? '');

// Entry URL policy for scanCustomFlow (asgard-0002).
//
// Threat model: scanCustomFlow is public npm API. If an embedder forwards an
// untrusted config.url, the scanner's browser fetches it and the rendered
// content ends up in the report — a readable SSRF / local-file-read channel.
//
// Why the internal-host / file:// block stays OPT-IN (OOBEE_SSRF_PROTECTION):
// config.url is normally chosen by the operator, and custom flow is routinely
// pointed at localhost dev servers, intranet/VPN/Tailscale staging hosts and
// local file:// pages. Making the block default-on would break those scans
// for every existing integrator (CLI, Oobee Desktop, CI pipelines). The risk
// is instead pushed to the one party who can judge it — an embedder exposing
// config.url to end users — and documented as a hard requirement.
//
// What is UNCONDITIONAL, because no legitimate workflow needs it:
//  1. Scheme allowlist: http:, https: (both allowed — plain http intranet and
//     dev servers are common) and file:. data:, javascript:, blob:, ftp:,
//     chrome:, view-source:, gopher: etc. are never accessibility targets and
//     only serve as script-injection or scheme-confusion vectors.
//  2. file: must be local (empty host or "localhost"). file://host/share is a
//     UNC/SMB path on Windows: it reads remote shares and leaks the user's
//     NTLM hash to the named host.
//  3. Link-local / cloud-metadata addresses: nothing to scan there; refusing
//     them removes the credential-theft case for embedders who forgot the flag.
//
// Windows drive paths (C:\site\index.html) parse with a single-letter scheme
// ("c:"); they are local files and were accepted before this guard, so they
// are treated as file: rather than refused as an unknown scheme.
const ALWAYS_ALLOWED_CUSTOM_FLOW_SCHEMES = new Set(['http:', 'https:', 'file:']);
const isWindowsDrivePath = (protocol: string): boolean => /^[a-z]:$/i.test(protocol);

export const assertSafeCustomFlowUrl = async (url: string): Promise<void> => {
  let parsedEntryUrl: URL;
  try {
    parsedEntryUrl = new URL(url);
  } catch {
    throw new Error('Invalid URL supplied to scanCustomFlow.');
  }

  const isDrivePath = isWindowsDrivePath(parsedEntryUrl.protocol);
  if (!isDrivePath && !ALWAYS_ALLOWED_CUSTOM_FLOW_SCHEMES.has(parsedEntryUrl.protocol)) {
    throw new Error(
      `Unsupported URL scheme "${parsedEntryUrl.protocol}" - scanCustomFlow only permits http://, https:// or local file:// scan targets.`,
    );
  }

  if (
    parsedEntryUrl.protocol === 'file:' &&
    parsedEntryUrl.hostname !== '' &&
    parsedEntryUrl.hostname.toLowerCase() !== 'localhost'
  ) {
    throw new Error(
      `scanCustomFlow refuses remote file:// host "${parsedEntryUrl.hostname}" - only local files may be scanned.`,
    );
  }

  if (await isLinkLocalOrMetadataUrl(url)) {
    throw new Error('scanCustomFlow refuses to scan a link-local or cloud-metadata address.');
  }

  if (!isSsrfProtectionEnabled()) return;

  if (parsedEntryUrl.protocol !== 'http:' && parsedEntryUrl.protocol !== 'https:') {
    throw new Error(
      `Unsupported URL scheme "${parsedEntryUrl.protocol}" - OOBEE_SSRF_PROTECTION only permits http:// or https:// scan targets.`,
    );
  }

  if (await isInternalOrLoopbackUrl(parsedEntryUrl.href)) {
    throw new Error(
      `scanCustomFlow refuses to scan "${parsedEntryUrl.hostname}" - it resolves to a private, loopback, or link-local address (OOBEE_SSRF_PROTECTION is enabled).`,
    );
  }
};

const validateCustomFlowEntryUrl = async (options: {
  url: string;
  browser: BrowserTypes;
  extraHTTPHeaders?: Record<string, string>;
  playwrightDeviceDetailsObject?: UnknownRecord;
}): Promise<void> => {
  await assertSafeCustomFlowUrl(options.url);

  const previousHeadless = process.env.CRAWLEE_HEADLESS;
  process.env.CRAWLEE_HEADLESS = '1';

  try {
    const res = await checkUrlConnectivityWithBrowser(
      options.url,
      options.browser,
      '',
      options.playwrightDeviceDetailsObject as any,
      options.extraHTTPHeaders ?? {},
    );

    if (res.status !== constants.urlCheckStatuses.success.code) {
      const status = Object.values(constants.urlCheckStatuses)
        .find((candidate: any) => candidate.code === res.status) as { message?: string } | undefined;
      throw new Error(status?.message || 'URL does not exist. Please check the URL and try again later.');
    }
  } finally {
    if (typeof previousHeadless === 'string') {
      process.env.CRAWLEE_HEADLESS = previousHeadless;
    } else {
      delete process.env.CRAWLEE_HEADLESS;
    }
  }
};
