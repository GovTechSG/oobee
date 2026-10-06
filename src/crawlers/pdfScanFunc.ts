import { spawnSync } from 'child_process';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import type { FileHandle } from 'fs/promises';
import { ensureDirSync, ReadStream } from 'fs-extra';
import { Request } from 'crawlee';
import type { BaseHttpClient, Session, StreamingHttpResponse } from 'crawlee';
import { getPageFromContext, getPdfScreenshots } from '../screenshotFunc/pdfScreenshotFunc.js';
import type { PageInfo } from '../mergeAxeResults.js';
import { consoleLogger, guiInfoLog, silentLogger } from '../logs.js';
import constants, {
  getExecutablePath,
  guiInfoStatusTypes,
  STATUS_CODE_METADATA,
  UrlsCrawled,
} from '../constants/constants.js';
import { cleanUpAndExit, getPdfStoragePath, getStoragePath } from '../utils.js';
import { error } from 'console';

const require = createRequire(import.meta.url);

// CONSTANTS

type RulesMap = { [key: string]: TransformedRuleObject };
// Classes
class TranslatedObject {
  goodToFix: {
    rules: RulesMap;
    totalItems: number;
  };
  mustFix: {
    rules: RulesMap;
    totalItems: number;
  };
  needsReview: {
    rules: RulesMap;
    totalItems: number;
  };
  url: string = '';
  pageTitle: string = '';
  filePath: string = '';
  totalItems: number = 0;

  constructor() {
    this.goodToFix = {
      rules: {},
      totalItems: 0,
    };
    this.mustFix = {
      rules: {},
      totalItems: 0,
    };
    this.needsReview = {
      rules: {},
      totalItems: 0,
    };
  }
}
export class TransformedRuleObject {
  description: string;
  totalItems: number;
  conformance: string[];
  items: { message: string; page: number; screenshotPath?: string; context: string }[];

  constructor() {
    this.description = '';
    this.totalItems = 0;
    this.conformance = [];
    this.items = [];
  }
}

// VeraPDF Scan Results types
type VeraPdfScanResults = { report: Report };

type Report = {
  buildInformation: BuildInformation;
  jobs: Job[];
  batchSummary: BatchSummary;
};

type BuildInformation = {
  releaseDetails: ReleaseDetail[];
};

type ReleaseDetail = {
  id: string;
  version: string;
  buildDate: number;
};

type Job = {
  itemDetails: ItemDetails;
  validationResult: ValidationResult;
  processingTime: ProcessingTime;
};

type ItemDetails = {
  name: string;
  size: number;
};

type ValidationResult = {
  details: ValidationDetails;
  jobEndStatus: string;
  profileName: string;
  statement: string;
  compliant: boolean;
};

type ValidationDetails = {
  passedRules: number;
  failedRules: number;
  passedChecks: number;
  failedChecks: number;
  ruleSummaries: RuleSummary[];
};

type RuleSummary = {
  ruleStatus: string;
  specification: string;
  clause: string;
  testNumber: number;
  status: string;
  failedChecks: number;
  description: string;
  object: string;
  test: string;
  checks: Check[];
};

type Check = {
  status: string;
  context: string;
  errorMessage: string;
  errorArguments: any[];
};

type ProcessingTime = {
  start: number;
  finish: number;
  duration: string;
  difference: number;
};

type BatchSummary = {
  duration: Duration;
  totalJobs: number;
  outOfMemory: number;
  veraExceptions: number;
  failedEncryptedJobs: number;
  failedParsingJobs: number;
  validationSummary: ValidationSummary;
  featuresSummary: FeaturesSummary;
  repairSummary: RepairSummary;
  multiJob: boolean;
};

type Duration = {
  start: number;
  finish: number;
  duration: string;
  difference: number;
};

type ValidationSummary = {
  nonCompliantPdfaCount: number;
  compliantPdfaCount: number;
  failedJobCount: number;
  totalJobCount: number;
  successfulJobCount: number;
};

type FeaturesSummary = {
  failedJobCount: number;
  totalJobCount: number;
  successfulJobCount: number;
};

type RepairSummary = {
  failedJobCount: number;
  totalJobCount: number;
  successfulJobCount: number;
};
// AAA: 1.4.8, 2.4.9
// AA: 1.3.4, 1.4.3, 1.4.4, 1.4.10
// A: 1.3.1, 4.1.1, 4.1.2
const LEVEL_AAA = ['2.4.9', '1.4.8'];
const LEVEL_AA = ['1.3.4', '1.4.3', '1.4.4', '1.4.10'];
const LEVEL_A = ['1.3.1', '4.1.1', '4.1.2'];
const clauseToLevel = {
  // mapping of clause to its A/AA/AAA level
  ...LEVEL_AAA.reduce((prev, curr) => {
    prev[curr] = 'wcag2aaa';
    return prev;
  }, {}),
  ...LEVEL_AA.reduce((prev, curr) => {
    prev[curr] = 'wcag2aa';
    return prev;
  }, {}),
  ...LEVEL_A.reduce((prev, curr) => {
    prev[curr] = 'wcag2a';
    return prev;
  }, {}),
};

const metaToCategoryMap = {
  critical: 'mustFix',
  error: 'goodToFix',
  serious: 'goodToFix',
  warning: 'goodToFix',
  ignore: 'goodToFix',
};

const EXCLUDED_RULES = {
  '1.3.4': { 1: true }, // test for page orientation deemed a false positive, so its excluded
};

const isRuleExcluded = (rule: RuleSummary) => {
  const isExcluded = EXCLUDED_RULES[rule.clause]
    ? EXCLUDED_RULES[rule.clause][rule.testNumber]
    : false;
  return isExcluded || LEVEL_AAA.includes(rule.clause);
};

const getVeraExecutable = () => {
  let veraPdfExe: string;
  if (os.platform() === 'win32') {
    veraPdfExe = getExecutablePath('**/verapdf', 'verapdf.bat');
  } else {
    veraPdfExe = getExecutablePath('**/verapdf', 'verapdf');
  }
  if (!veraPdfExe) {
    const veraPdfExeNotFoundError =
      'Could not find veraPDF executable.  Please ensure veraPDF is installed at current directory.';
    consoleLogger.error(veraPdfExeNotFoundError);
    consoleLogger.error(veraPdfExeNotFoundError);
  }
  return veraPdfExe;
};

const PDF_MAGIC = Buffer.from('%PDF-');

// PDF 1.7 §7.5.5 requires %%EOF to be the last line of the file; allow for trailing
// whitespace and the byte-offset slack that real-world writers introduce.
const PDF_EOF_SEARCH_WINDOW = 1024;

// Checked against the file on disk rather than an in-memory buffer so that arbitrarily
// large PDFs never have to be fully resident.
const isPdfFile = async (filePath: string): Promise<boolean> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const { size } = await handle.stat();
    if (size < PDF_MAGIC.length) return false;

    const head = Buffer.alloc(PDF_MAGIC.length);
    await handle.read(head, 0, head.length, 0);
    if (!head.equals(PDF_MAGIC)) return false;

    const tailLength = Math.min(PDF_EOF_SEARCH_WINDOW, size);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    return tail.includes('%%EOF');
  } catch (e) {
    consoleLogger.error(`Unable to verify PDF at ${filePath}: ${e}`);
    return false;
  } finally {
    await handle?.close();
  }
};

// Downloads are kicked off from the request handler and only awaited once the crawl has
// finished, so Crawlee's autoscaled pool does not throttle them. Without a cap, a
// PDF-heavy site opens one socket per PDF link found. Shared across crawlers so an
// intelligent scan running crawlSitemap then crawlDomain stays under one budget.
const MAX_CONCURRENT_PDF_DOWNLOADS = 4;

// Hard cap on a single PDF download (asgard-0008). Streaming keeps memory flat
// but leaves disk unbounded without this — enforced via a Content-Length
// pre-check plus a running byte counter that aborts the stream.
const MAX_PDF_DOWNLOAD_BYTES = (() => {
  const v = parseInt(process.env.OOBEE_PDF_MAX_DOWNLOAD_BYTES ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 100 * 1024 * 1024; // default 100 MB
})();

let inFlightPdfDownloads = 0;
const waitingPdfDownloads: (() => void)[] = [];

const acquirePdfDownloadSlot = (): Promise<void> => {
  if (inFlightPdfDownloads < MAX_CONCURRENT_PDF_DOWNLOADS) {
    inFlightPdfDownloads += 1;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => waitingPdfDownloads.push(resolve));
};

const releasePdfDownloadSlot = () => {
  const next = waitingPdfDownloads.shift();
  if (next) {
    // Hand the slot straight over so the in-flight count never dips and lets an
    // unrelated caller slip past the cap.
    next();
    return;
  }
  inFlightPdfDownloads -= 1;
};

export const handlePdfDownload = (
  randomToken: string,
  pdfDownloads: Promise<void>[],
  request: Request,
  httpClient: BaseHttpClient,
  urlsCrawled: UrlsCrawled,
  session?: Session,
): { pdfFileName: string; url: string } => {
  const pdfFileName = randomUUID();
  const { url } = request;
  const pageTitle = decodeURI(request.url).split('/').pop() || request.url;
  const pdfFilePath = `${getPdfStoragePath(randomToken)}/${pdfFileName}.pdf`;

  const recordNotScanned = (bucket: PageInfo[], metadata: string, httpStatusCode: number) => {
    guiInfoLog(guiInfoStatusTypes.SKIPPED, {
      numScanned: urlsCrawled.scanned.length,
      urlScanned: request.url,
    });
    bucket.push({
      url: request.url,
      pageTitle: request.url,
      actualUrl: request.url, // because about:blank is not useful
      metadata,
      httpStatusCode,
    });
  };

  pdfDownloads.push(
    (async () => {
      // Only http(s) is fetched here. A file:// PDF is already on disk — crawlLocalFile
      // copies it into the scan folder directly — and got has no file:// handler, so a
      // local-sitemap entry reaching this point would otherwise throw.
      let protocol = '';
      try {
        protocol = new URL(url).protocol;
      } catch {
        protocol = '';
      }
      if (protocol !== 'http:' && protocol !== 'https:') {
        consoleLogger.info(`Skipping PDF with non-http(s) scheme: ${url}`);
        recordNotScanned(urlsCrawled.userExcluded, STATUS_CODE_METADATA[1], 0);
        return;
      }

      await acquirePdfDownloadSlot();
      try {
        let response: StreamingHttpResponse;
        try {
          // This fetch bypasses the browser, so it inherits none of the cookies the
          // crawl has already earned (login, consent gate, WAF clearance). Crawlee's
          // `sendRequest` used to inject the session cookie jar for us, but
          // `GotScrapingHttpClient.stream()` discards `cookieJar` outright — the
          // cookies have to travel as a plain header instead. Without this, PDFs on
          // an authenticated or challenge-gated origin come back 403 and get filed
          // as skipped rather than scanned.
          const cookieHeader = session?.getCookieString(url);
          response = await httpClient.stream({
            url,
            method: 'GET',
            headers: { ...request.headers, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
            // Keeps got-scraping's generated TLS/header fingerprint stable per
            // session, matching what the browser already presented to this origin.
            sessionToken: session,
          });
        } catch (e) {
          consoleLogger.error(`Unable to request PDF at ${url}: ${e}`);
          recordNotScanned(urlsCrawled.error, STATUS_CODE_METADATA[2], 0);
          return;
        }

        if (response.statusCode !== 200) {
          response.stream.destroy();
          recordNotScanned(
            urlsCrawled.userExcluded,
            STATUS_CODE_METADATA[response.statusCode] || STATUS_CODE_METADATA[1],
            0,
          );
          return;
        }

        // Reject before streaming when the server advertises an oversized body.
        const declaredLength = Number(response.headers?.['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_DOWNLOAD_BYTES) {
          response.stream.destroy();
          recordNotScanned(urlsCrawled.userExcluded, STATUS_CODE_METADATA[1], 0);
          return;
        }

        try {
          // Abort mid-stream once the running byte count exceeds the cap, so a
          // server that lies about (or omits) Content-Length still can't fill disk.
          let downloadedBytes = 0;
          const enforceSizeCap = new Transform({
            transform(chunk, _encoding, callback) {
              downloadedBytes += chunk.length;
              if (downloadedBytes > MAX_PDF_DOWNLOAD_BYTES) {
                callback(new Error(`PDF at ${url} exceeds ${MAX_PDF_DOWNLOAD_BYTES}-byte download cap`));
                return;
              }
              callback(null, chunk);
            },
          });
          await pipeline(response.stream, enforceSizeCap, fs.createWriteStream(pdfFilePath, { flags: 'w' }));
        } catch (e) {
          consoleLogger.error(`Unable to save PDF at ${url}: ${e}`);
          await fs.promises.rm(pdfFilePath, { force: true });
          recordNotScanned(urlsCrawled.error, STATUS_CODE_METADATA[2], 0);
          return;
        }
      } finally {
        releasePdfDownloadSlot();
      }

      if (await isPdfFile(pdfFilePath)) {
        guiInfoLog(guiInfoStatusTypes.SCANNED, {
          numScanned: urlsCrawled.scanned.length,
          urlScanned: request.url,
        });
        urlsCrawled.scanned.push({
          url: request.url,
          pageTitle,
          actualUrl: url,
        });
        return;
      }

      // Keep non-PDF payloads out of the folder veraPDF is pointed at.
      await fs.promises.rm(pdfFilePath, { force: true });
      guiInfoLog(guiInfoStatusTypes.SKIPPED, {
        numScanned: urlsCrawled.scanned.length,
        urlScanned: request.url,
      });
      urlsCrawled.invalid.push({
        url: request.url,
        pageTitle: url,
        actualUrl: url,
        metadata: STATUS_CODE_METADATA[1],
      });
    })(),
  );

  return { pdfFileName, url };
};

export const runPdfScan = async (randomToken: string) => {
  const execFile = getVeraExecutable();
  const veraPdfProfile = path.join(
    path.dirname(execFile),
    'profiles/veraPDF-validation-profiles-rel-1.26/PDF_UA/WCAG-2-2.xml',
  );
  if (!execFile || !veraPdfProfile) {
    cleanUpAndExit(1);
  }

  const intermediateFolder = getPdfStoragePath(randomToken);

  // store in a intermediate folder as we transfer final results later
  const intermediateResultPath = `${intermediateFolder}/${constants.pdfScanResultFileName}`;

  // Invoke veraPDF as an argv array with shell:false so ``intermediateFolder``
  // (derived from randomToken and the scanned URL's hostname) is passed
  // verbatim to execve rather than concatenated into a shell command line.
  // The old ``shell: true`` + `"${intermediateFolder}"` wrapping let a
  // hostname such as ``example.com"; rm -rf ~; #`` break out of the quoting
  // and execute arbitrary commands.
  const veraPdfCmdArgs = [
    '-p',
    veraPdfProfile,
    '--format',
    'json',
    '-r', // recurse through directory
    intermediateFolder,
  ];

  const ls = spawnSync(execFile, veraPdfCmdArgs, { shell: false });
  if (ls.stderr && ls.stderr.length > 0)
    consoleLogger.error(ls.stderr.toString());

  fs.writeFileSync(intermediateResultPath, ls.stdout, { encoding: 'utf-8' });
};

// transform results from veraPDF to desired format for report
export const mapPdfScanResults = async (
  randomToken: string,
  uuidToUrlMapping: Record<string, string>,
) => {
  const intermediateFolder = getPdfStoragePath(randomToken);
  const intermediateResultPath = `${intermediateFolder}/${constants.pdfScanResultFileName}`;

  const rawdata = fs.readFileSync(intermediateResultPath, 'utf-8');

  let parsedJsonData: VeraPdfScanResults;
  try {
    parsedJsonData = JSON.parse(rawdata);
  } catch (err) {
    consoleLogger.error(err);
  }

  const errorMeta = require('../constants/errorMeta.json');

  const resultsList = [];

  if (parsedJsonData) {
    // jobs: files that are scanned
    const {
      report: { jobs },
    } = parsedJsonData;

    // loop through all jobs
    for (let jobIdx = 0; jobIdx < jobs.length; jobIdx++) {
      const translated = new TranslatedObject();

      const { itemDetails, validationResult } = jobs[jobIdx];
      const { name: fileName } = itemDetails;

      const rawFileName = fileName.split(os.platform() === 'win32' ? '\\' : '/').pop();
      const fileNameWithoutExt = rawFileName.replace(/\.pdf$/i, '');

      const url =
        uuidToUrlMapping[rawFileName] || // exact match like 'Some-filename.pdf'
        uuidToUrlMapping[fileNameWithoutExt] || // uuid-based key like 'a9f7ebbd-5a90...'
        `file://${fileName}`; // fallback

      const filePath = path.join(getPdfStoragePath(randomToken), rawFileName);


      const pageTitle = decodeURI(url).split('/').pop();
      translated.url = url;
      translated.pageTitle = pageTitle;
      
      translated.url = url;
      translated.pageTitle = pageTitle;
      translated.filePath = filePath;

      if (!validationResult) {
        // check for error in scan
        consoleLogger.info(`Unable to scan ${pageTitle}, skipping`);
        continue; // skip this job
      }

      // destructure validation result
      const { passedChecks, failedChecks, ruleSummaries } = validationResult.details;
      const totalChecks = passedChecks + failedChecks;

      translated.totalItems = totalChecks;

      // loop through all failed rules
      for (let ruleIdx = 0; ruleIdx < ruleSummaries.length; ruleIdx++) {
        const rule = ruleSummaries[ruleIdx];
        const { specification, testNumber, clause } = rule;

        if (isRuleExcluded(rule)) continue;
        const [ruleId, transformedRule] = await transformRule(rule, filePath);

        // ignore if violation is not in the meta file
        const meta = errorMeta[specification][clause][testNumber]?.STATUS ?? 'ignore';
        const category = translated[metaToCategoryMap[meta]];

        category.rules[ruleId] = transformedRule;
        category.totalItems += transformedRule.totalItems;
      }

      resultsList.push(translated);
    }
  }
  return resultsList;
};

const transformRule = async (
  rule: RuleSummary,
  filePath: string,
): Promise<[string, TransformedRuleObject]> => {
  // get specific rule
  const transformed = new TransformedRuleObject();
  const { specification, description, clause, testNumber, checks } = rule;

  transformed.description = description;
  transformed.totalItems = checks.length;

  if (specification === 'WCAG2.1') {
    transformed.conformance = [clauseToLevel[clause], `wcag${clause.split('.').join('')}`];
  } else {
    transformed.conformance = ['best-practice'];
  }

  transformed.items = [];

  for (let checkIdx = 0; checkIdx < checks.length; checkIdx++) {
    const { errorMessage, context } = checks[checkIdx];
    const page = await getPageFromContext(context, filePath);
    transformed.items.push({ message: errorMessage, page, context });
  }
  const ruleId = `pdf-${specification}-${clause}-${testNumber}`.replaceAll(' ', '_');

  return [ruleId, transformed];
};

export const doPdfScreenshots = async (randomToken: string, result: TranslatedObject) => {
  const { filePath, pageTitle } = result;
  const formattedPageTitle = pageTitle.replaceAll(' ', '_').split('.')[0];
  const screenshotsDir = path.join(getStoragePath(randomToken), 'elemScreenshots', 'pdf');

  ensureDirSync(screenshotsDir);

  for (const category of ['mustFix', 'goodToFix']) {
    const ruleItems = Object.entries(result[category].rules) as [
      keyof RulesMap,
      RulesMap[keyof RulesMap],
    ][];
    for (const [ruleId, ruleInfo] of ruleItems) {
      const { items } = ruleInfo;
      const filename = `${formattedPageTitle}-${category}-${ruleId}`;
      const screenshotPath = path.join(screenshotsDir, filename);
      const newItems = await getPdfScreenshots(filePath, items, screenshotPath);
      ruleInfo.items = newItems;
    }
  }
};
