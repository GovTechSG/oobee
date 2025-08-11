import { spawnSync } from 'child_process';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { ensureDirSync, ReadStream } from 'fs-extra';
import { Request } from 'crawlee';
import { getPageFromContext, getPdfScreenshots } from '../screenshotFunc/pdfScreenshotFunc.js';
import { isFilePath } from '../constants/common.js';
import { consoleLogger, guiInfoLog, silentLogger } from '../logs.js';
import constants, {
  getExecutablePath,
  guiInfoStatusTypes,
  STATUS_CODE_METADATA,
  UrlsCrawled,
} from '../constants/constants.js';
import { cleanUpAndExit } from '../utils.js';

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

const isPDF = (buffer: Buffer) => {
  return (
    Buffer.isBuffer(buffer) && buffer.lastIndexOf('%PDF-') === 0 && buffer.lastIndexOf('%%EOF') > -1
  );
};

export const handlePdfDownload = (
  randomToken: string,
  pdfDownloads: Promise<void>[],
  request: Request,
  sendRequest: any,
  urlsCrawled: UrlsCrawled,
): { pdfFileName: string; url: string } => {
  const pdfFileName = randomUUID();
  const { url } = request;
  const pageTitle = decodeURI(request.url).split('/').pop();

  pdfDownloads.push(
    new Promise<void>(async resolve => {
      let bufs: Buffer[] = [];
      let buf: Buffer;

      if (isFilePath(url)) {
        // Read from local file system
        const filePath = new URL(url).pathname;
        const pdfResponse = fs.createReadStream(filePath, { encoding: 'binary' });

        const downloadFile = fs.createWriteStream(`${randomToken}/${pdfFileName}.pdf`, {
          flags: 'a',
        });

        pdfResponse.on('data', (chunk: Buffer) => {
          downloadFile.write(chunk, 'binary');
          bufs.push(Buffer.from(chunk));
        });

        pdfResponse.on('end', () => {
          downloadFile.end();
          buf = Buffer.concat(bufs);

          if (isPDF(buf)) {
            guiInfoLog(guiInfoStatusTypes.SCANNED, {
              numScanned: urlsCrawled.scanned.length,
              urlScanned: request.url,
            });
            urlsCrawled.scanned.push({
              url: request.url,
              pageTitle,
              actualUrl: url,
            });
          } else {
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
          }

          resolve();
        });
      } else {
        // Download from remote URL
        const response = await sendRequest({ responseType: 'buffer' });
        buf = Buffer.isBuffer(response) ? response : response.body;

        const downloadFile = fs.createWriteStream(`${randomToken}/${pdfFileName}.pdf`, {
          flags: 'a',
        });

        downloadFile.write(buf, 'binary');
        downloadFile.end();

        if (isPDF(buf)) {
          guiInfoLog(guiInfoStatusTypes.SCANNED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          urlsCrawled.scanned.push({
            url: request.url,
            pageTitle,
            actualUrl: url,
          });
        } else {
          guiInfoLog(guiInfoStatusTypes.SKIPPED, {
            numScanned: urlsCrawled.scanned.length,
            urlScanned: request.url,
          });
          urlsCrawled.invalid.push({
            url: request.url,
            pageTitle: url,
            actualUrl: url,
          });
        }

        resolve();
      }
    }),
  );

  return { pdfFileName, url };
};

export const runPdfScan = async (randomToken: string) => {
  const execFile = getVeraExecutable();
  const veraPdfExe = `"${execFile}"`;
  // const veraPdfProfile = getVeraProfile();
  const veraPdfProfile = `"${path.join(
    execFile,
    '..',
    'profiles/veraPDF-validation-profiles-rel-1.26/PDF_UA/WCAG-2-2.xml',
  )}"`;
  if (!veraPdfExe || !veraPdfProfile) {
    cleanUpAndExit(1);
  }

  const intermediateFolder = randomToken; // NOTE: assumes this folder is already created for crawlee

  // store in a intermediate folder as we transfer final results later
  const intermediateResultPath = `${intermediateFolder}/${constants.pdfScanResultFileName}`;

  const veraPdfCmdArgs = [
    '-p',
    veraPdfProfile,
    '--format',
    'json',
    '-r', // recurse through directory
    `"${intermediateFolder}"`,
  ];

  const ls = spawnSync(veraPdfExe, veraPdfCmdArgs, { shell: true });
  fs.writeFileSync(intermediateResultPath, ls.stdout, { encoding: 'utf-8' });
};

// transform results from veraPDF to desired format for report
export const mapPdfScanResults = async (
  randomToken: string,
  uuidToUrlMapping: Record<string, string>,
) => {
  const intermediateFolder = randomToken;
  const intermediateResultPath = `${intermediateFolder}/${constants.pdfScanResultFileName}`;

  const rawdata = fs.readFileSync(intermediateResultPath, 'utf-8');

  let parsedJsonData: VeraPdfScanResults;
  try {
    parsedJsonData = JSON.parse(rawdata);
  } catch (err) {
    consoleLogger.log(err);
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

      const filePath = `${randomToken}/${rawFileName}`;


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
  const screenshotsDir = path.join(randomToken, 'elemScreenshots', 'pdf');

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
