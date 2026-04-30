import { spawnSync } from 'child_process';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { ensureDirSync } from 'fs-extra';
import { getPageFromContext, getPdfScreenshots } from '../screenshotFunc/pdfScreenshotFunc.js';
import { consoleLogger, guiInfoLog } from '../logs.js';
import constants, { getExecutablePath, guiInfoStatusTypes, STATUS_CODE_METADATA, } from '../constants/constants.js';
import { cleanUpAndExit, getPdfStoragePath, getStoragePath } from '../utils.js';
const require = createRequire(import.meta.url);
// Classes
class TranslatedObject {
    constructor() {
        this.url = '';
        this.pageTitle = '';
        this.filePath = '';
        this.totalItems = 0;
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
    constructor() {
        this.description = '';
        this.totalItems = 0;
        this.conformance = [];
        this.items = [];
    }
}
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
const isRuleExcluded = (rule) => {
    const isExcluded = EXCLUDED_RULES[rule.clause]
        ? EXCLUDED_RULES[rule.clause][rule.testNumber]
        : false;
    return isExcluded || LEVEL_AAA.includes(rule.clause);
};
const getVeraExecutable = () => {
    let veraPdfExe;
    if (os.platform() === 'win32') {
        veraPdfExe = getExecutablePath('**/verapdf', 'verapdf.bat');
    }
    else {
        veraPdfExe = getExecutablePath('**/verapdf', 'verapdf');
    }
    if (!veraPdfExe) {
        const veraPdfExeNotFoundError = 'Could not find veraPDF executable.  Please ensure veraPDF is installed at current directory.';
        consoleLogger.error(veraPdfExeNotFoundError);
        consoleLogger.error(veraPdfExeNotFoundError);
    }
    return veraPdfExe;
};
const isPDF = (buffer) => {
    return (Buffer.isBuffer(buffer) && buffer.lastIndexOf('%PDF-') === 0 && buffer.lastIndexOf('%%EOF') > -1);
};
export const handlePdfDownload = (randomToken, pdfDownloads, request, sendRequest, urlsCrawled) => {
    const pdfFileName = randomUUID();
    const { url } = request;
    const pageTitle = decodeURI(request.url).split('/').pop();
    pdfDownloads.push(new Promise(async (resolve) => {
        let buf;
        // Download from remote URL
        const response = await sendRequest({ responseType: 'buffer' });
        if (response.statusCode !== 200) {
            guiInfoLog(guiInfoStatusTypes.SKIPPED, {
                numScanned: urlsCrawled.scanned.length,
                urlScanned: request.url,
            });
            urlsCrawled.userExcluded.push({
                url: request.url,
                pageTitle: request.url,
                actualUrl: request.url, // because about:blank is not useful
                metadata: STATUS_CODE_METADATA[response.statusCode] || STATUS_CODE_METADATA[1],
                httpStatusCode: 0,
            });
            resolve();
            return;
        }
        buf = Buffer.isBuffer(response) ? response : response.body;
        const downloadFile = fs.createWriteStream(`${getPdfStoragePath(randomToken)}/${pdfFileName}.pdf`, {
            flags: 'w',
        });
        downloadFile.write(buf, 'binary');
        downloadFile.end();
        downloadFile.on('finish', () => {
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
            }
            else {
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
    }));
    return { pdfFileName, url };
};
export const runPdfScan = async (randomToken) => {
    const execFile = getVeraExecutable();
    const veraPdfExe = `"${execFile}"`;
    // const veraPdfProfile = getVeraProfile();
    const veraPdfProfile = `"${path.join(path.dirname(execFile), 'profiles/veraPDF-validation-profiles-rel-1.26/PDF_UA/WCAG-2-2.xml')}"`;
    if (!veraPdfExe || !veraPdfProfile) {
        cleanUpAndExit(1);
    }
    const intermediateFolder = getPdfStoragePath(randomToken);
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
    if (ls.stderr && ls.stderr.length > 0)
        consoleLogger.error(ls.stderr.toString());
    fs.writeFileSync(intermediateResultPath, ls.stdout, { encoding: 'utf-8' });
};
// transform results from veraPDF to desired format for report
export const mapPdfScanResults = async (randomToken, uuidToUrlMapping) => {
    const intermediateFolder = getPdfStoragePath(randomToken);
    const intermediateResultPath = `${intermediateFolder}/${constants.pdfScanResultFileName}`;
    const rawdata = fs.readFileSync(intermediateResultPath, 'utf-8');
    let parsedJsonData;
    try {
        parsedJsonData = JSON.parse(rawdata);
    }
    catch (err) {
        consoleLogger.error(err);
    }
    const errorMeta = require('../constants/errorMeta.json');
    const resultsList = [];
    if (parsedJsonData) {
        // jobs: files that are scanned
        const { report: { jobs }, } = parsedJsonData;
        // loop through all jobs
        for (let jobIdx = 0; jobIdx < jobs.length; jobIdx++) {
            const translated = new TranslatedObject();
            const { itemDetails, validationResult } = jobs[jobIdx];
            const { name: fileName } = itemDetails;
            const rawFileName = fileName.split(os.platform() === 'win32' ? '\\' : '/').pop();
            const fileNameWithoutExt = rawFileName.replace(/\.pdf$/i, '');
            const url = uuidToUrlMapping[rawFileName] || // exact match like 'Some-filename.pdf'
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
                if (isRuleExcluded(rule))
                    continue;
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
const transformRule = async (rule, filePath) => {
    // get specific rule
    const transformed = new TransformedRuleObject();
    const { specification, description, clause, testNumber, checks } = rule;
    transformed.description = description;
    transformed.totalItems = checks.length;
    if (specification === 'WCAG2.1') {
        transformed.conformance = [clauseToLevel[clause], `wcag${clause.split('.').join('')}`];
    }
    else {
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
export const doPdfScreenshots = async (randomToken, result) => {
    const { filePath, pageTitle } = result;
    const formattedPageTitle = pageTitle.replaceAll(' ', '_').split('.')[0];
    const screenshotsDir = path.join(getStoragePath(randomToken), 'elemScreenshots', 'pdf');
    ensureDirSync(screenshotsDir);
    for (const category of ['mustFix', 'goodToFix']) {
        const ruleItems = Object.entries(result[category].rules);
        for (const [ruleId, ruleInfo] of ruleItems) {
            const { items } = ruleInfo;
            const filename = `${formattedPageTitle}-${category}-${ruleId}`;
            const screenshotPath = path.join(screenshotsDir, filename);
            const newItems = await getPdfScreenshots(filePath, items, screenshotPath);
            ruleInfo.items = newItems;
        }
    }
};
