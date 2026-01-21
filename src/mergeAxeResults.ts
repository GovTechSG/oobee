/* eslint-disable consistent-return */
/* eslint-disable no-console */
import os from 'os';
import fs, { ensureDirSync } from 'fs-extra';
import printMessage from 'print-message';
import path from 'path';
import ejs from 'ejs';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { createWriteStream } from 'fs';
import { AsyncParser, ParserOptions } from '@json2csv/node';
import zlib from 'zlib';
import { Base64Encode } from 'base64-stream';
import { pipeline } from 'stream/promises';
// @ts-ignore
import * as Sentry from '@sentry/node';
import constants, {
  BrowserTypes,
  ScannerTypes,
  sentryConfig,
  setSentryUser,
  WCAGclauses,
  a11yRuleShortDescriptionMap,
  disabilityBadgesMap,
  a11yRuleLongDescriptionMap,
} from './constants/constants.js';
import { getBrowserToRun, getPlaywrightLaunchOptions } from './constants/common.js';

import {
  createScreenshotsFolder,
  getStoragePath,
  getVersion,
  getWcagPassPercentage,
  getProgressPercentage,
  retryFunction,
  zipResults,
  getIssuesPercentage,
  getWcagCriteriaMap,
  categorizeWcagCriteria,
  getUserDataTxt,
  register,
} from './utils.js';
import { consoleLogger, silentLogger } from './logs.js';
import itemTypeDescription from './constants/itemTypeDescription.js';
import { oobeeAiHtmlETL, oobeeAiRules } from './constants/oobeeAi.js';

export type ItemsInfo = {
  html: string;
  message: string;
  screenshotPath: string;
  xpath: string;
  displayNeedsReview?: boolean;
};

export type PageInfo = {
  items?: ItemsInfo[];
  itemsCount?: number;
  pageTitle: string;
  url: string;
  actualUrl: string;
  pageImagePath?: string;
  pageIndex?: number;
  metadata?: string;
  httpStatusCode?: number;
};

export type RuleInfo = {
  totalItems: number;
  pagesAffected: PageInfo[];
  pagesAffectedCount: number;
  rule: string;
  description: string;
  axeImpact: string;
  conformance: string[];
  helpUrl: string;
};

type Category = {
  description: string;
  totalItems: number;
  totalRuleIssues: number;
  rules: RuleInfo[];
};

type AllIssues = {
  storagePath: string;
  oobeeAi: {
    htmlETL: any;
    rules: string[];
  };
  siteName: string;
  startTime: Date;
  endTime: Date;
  urlScanned: string;
  scanType: string;
  deviceChosen: string;
  formatAboutStartTime: (dateString: any) => string;
  isCustomFlow: boolean;
  pagesScanned: PageInfo[];
  pagesNotScanned: PageInfo[];
  totalPagesScanned: number;
  totalPagesNotScanned: number;
  totalItems: number;
  topFiveMostIssues: Array<any>;
  topTenPagesWithMostIssues: Array<any>;
  topTenIssues: Array<any>;
  wcagViolations: string[];
  customFlowLabel: string;
  oobeeAppVersion: string;
  items: {
    mustFix: Category;
    goodToFix: Category;
    needsReview: Category;
    passed: Category;
  };
  cypressScanAboutMetadata: {
    browser?: string;
    viewport?: { width: number; height: number };
  };
  wcagLinks: { [key: string]: string };
  wcagClauses: { [key: string]: string };
  [key: string]: any;
  advancedScanOptionsSummaryItems: { [key: string]: boolean };
  scanPagesDetail: {
    pagesAffected: any[];
    pagesNotAffected: any[];
    scannedPagesCount: number;
    pagesNotScanned: any[];
    pagesNotScannedCount: number;
  };
};

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const BUFFER_LIMIT = 100 * 1024 * 1024; // 100MB size

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
const parseContentToJson = async rPath =>
  fs
    .readFile(rPath, 'utf8')
    .then(content => JSON.parse(content))
    .catch(parseError => {
      consoleLogger.info('An error has occurred when parsing the content, please try again.');
    });

const writeCsv = async (allIssues, storagePath) => {
  const csvOutput = createWriteStream(`${storagePath}/report.csv`, { encoding: 'utf8' });
  const formatPageViolation = pageNum => {
    if (pageNum < 0) return 'Document';
    return `Page ${pageNum}`;
  };

  // transform allIssues into the form:
  // [['mustFix', rule1], ['mustFix', rule2], ['goodToFix', rule3], ...]
  const getRulesByCategory = (allIssues: AllIssues) => {
    return Object.entries(allIssues.items)
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

  const flattenRule = catAndRule => {
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
        const { html, page, message, xpath } = item;
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

  parseStream.on('error', err => {
    console.error('Error parsing CSV:', err);
    csvOutput.end();
  });
};

const compileHtmlWithEJS = async (
  allIssues: AllIssues,
  storagePath: string,
  htmlFilename = 'report',
) => {
  const htmlFilePath = `${path.join(storagePath, htmlFilename)}.html`;
  const ejsString = fs.readFileSync(path.join(dirname, './static/ejs/report.ejs'), 'utf-8');
  const template = ejs.compile(ejsString, {
    filename: path.join(dirname, './static/ejs/report.ejs'),
  });

  const html = template({ ...allIssues, storagePath: JSON.stringify(storagePath) });
  await fs.writeFile(htmlFilePath, html);

  let htmlContent = await fs.readFile(htmlFilePath, { encoding: 'utf8' });

  const headIndex = htmlContent.indexOf('</head>');
  const injectScript = `
  <script>
    // IMPORTANT! DO NOT REMOVE ME: Decode the encoded data

  </script>
  `;

  if (headIndex !== -1) {
    htmlContent = htmlContent.slice(0, headIndex) + injectScript + htmlContent.slice(headIndex);
  } else {
    htmlContent += injectScript;
  }

  await fs.writeFile(htmlFilePath, htmlContent);

  return htmlFilePath;
};

const splitHtmlAndCreateFiles = async (htmlFilePath, storagePath) => {
  try {
    const htmlContent = await fs.readFile(htmlFilePath, { encoding: 'utf8' });
    const splitMarker = '// IMPORTANT! DO NOT REMOVE ME: Decode the encoded data';
    const splitIndex = htmlContent.indexOf(splitMarker);

    if (splitIndex === -1) {
      throw new Error('Marker comment not found in the HTML file.');
    }

    const topContent = `${htmlContent.slice(0, splitIndex + splitMarker.length)}\n\n`;
    const bottomContent = htmlContent.slice(splitIndex + splitMarker.length);

    const topFilePath = path.join(storagePath, 'report-partial-top.htm.txt');
    const bottomFilePath = path.join(storagePath, 'report-partial-bottom.htm.txt');

    await fs.writeFile(topFilePath, topContent, { encoding: 'utf8' });
    await fs.writeFile(bottomFilePath, bottomContent, { encoding: 'utf8' });

    await fs.unlink(htmlFilePath);

    return { topFilePath, bottomFilePath };
  } catch (error) {
    console.error('Error splitting HTML and creating files:', error);
  }
};

const writeHTML = async (
  allIssues: AllIssues,
  storagePath: string,
  htmlFilename = 'report',
  scanDetailsFilePath: string,
  scanItemsFilePath: string,
) => {
  const htmlFilePath = await compileHtmlWithEJS(allIssues, storagePath, htmlFilename);
  const { topFilePath, bottomFilePath } = await splitHtmlAndCreateFiles(htmlFilePath, storagePath);
  const prefixData = fs.readFileSync(path.join(storagePath, 'report-partial-top.htm.txt'), 'utf-8');
  const suffixData = fs.readFileSync(
    path.join(storagePath, 'report-partial-bottom.htm.txt'),
    'utf-8',
  );

  const scanDetailsReadStream = fs.createReadStream(scanDetailsFilePath, {
    encoding: 'utf8',
    highWaterMark: BUFFER_LIMIT,
  });
  const scanItemsReadStream = fs.createReadStream(scanItemsFilePath, {
    encoding: 'utf8',
    highWaterMark: BUFFER_LIMIT,
  });

  const outputFilePath = `${storagePath}/${htmlFilename}.html`;
  const outputStream = fs.createWriteStream(outputFilePath, { flags: 'a' });

  const cleanupFiles = async () => {
    try {
      await Promise.all([fs.promises.unlink(topFilePath), fs.promises.unlink(bottomFilePath)]);
    } catch (err) {
      console.error('Error cleaning up temporary files:', err);
    }
  };

  outputStream.write(prefixData);

  // For Proxied AI environments only
  outputStream.write(`let proxyUrl = "${process.env.PROXY_API_BASE_URL || ""}"\n`);

  // Initialize GenAI feature flag
  outputStream.write(`
  // Fetch GenAI feature flag from backend
  window.oobeeGenAiFeatureEnabled = false;
  if (proxyUrl !== "" && proxyUrl !== undefined && proxyUrl !== null) {
    (async () => {
      try {
        const featuresUrl = proxyUrl + '/api/ai/features';
        const response = await fetch(featuresUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        if (response.ok) {
          const features = await response.json();
          window.oobeeGenAiFeatureEnabled = features.genai_ui_enabled || false;
          console.log('GenAI UI feature flag:', window.oobeeGenAiFeatureEnabled);
        } else {
          console.warn('Failed to fetch GenAI feature flag:', response.status);
        }
      } catch (error) {
        console.warn('Error fetching GenAI feature flag:', error);
      }
    })();
  } else {
    console.warn('Skipping fetch GenAI feature as it is local report');
  }
  \n`)
  
  // outputStream.write("scanData = decompressJsonObject('");
  outputStream.write(
    "let scanDataPromise = (async () => { console.log('Loading scanData...'); scanData = await decodeUnzipParse('",
  );
  scanDetailsReadStream.pipe(outputStream, { end: false });

  scanDetailsReadStream.on('end', () => {
    // outputStream.write("')\n\n");
    outputStream.write("'); })();\n\n");
    // outputStream.write("(scanItems = decompressJsonObject('");
    outputStream.write(
      "let scanItemsPromise = (async () => { console.log('Loading scanItems...'); scanItems = await decodeUnzipParse('",
    );
    scanItemsReadStream.pipe(outputStream, { end: false });
  });

  scanDetailsReadStream.on('error', err => {
    console.error('Read stream error:', err);
    outputStream.end();
  });

  scanItemsReadStream.on('end', () => {
    // outputStream.write("')\n\n");
    outputStream.write("'); })();\n\n");
    outputStream.write(suffixData);
    outputStream.end();
  });

  scanItemsReadStream.on('error', err => {
    console.error('Read stream error:', err);
    outputStream.end();
  });

  consoleLogger.info('Content appended successfully.');
  await cleanupFiles();

  outputStream.on('error', err => {
    consoleLogger.error('Error writing to output file:', err);
  });
};

const writeSummaryHTML = async (
  allIssues: AllIssues,
  storagePath: string,
  htmlFilename = 'summary',
) => {
  const ejsString = fs.readFileSync(path.join(dirname, './static/ejs/summary.ejs'), 'utf-8');
  const template = ejs.compile(ejsString, {
    filename: path.join(dirname, './static/ejs/summary.ejs'),
  });
  const html = template(allIssues);
  fs.writeFileSync(`${storagePath}/${htmlFilename}.html`, html);
};

const writeSitemap = async (pagesScanned: PageInfo[], storagePath: string) => {
  const sitemapPath = path.join(storagePath, 'sitemap.txt');
  const content = pagesScanned.map(p => p.url).join('\n');
  await fs.writeFile(sitemapPath, content, { encoding: 'utf-8' });
  consoleLogger.info(`Sitemap written to ${sitemapPath}`);
};

const cleanUpJsonFiles = async (filesToDelete: string[]) => {
  consoleLogger.info('Cleaning up JSON files...');
  filesToDelete.forEach(file => {
    fs.unlinkSync(file);
    consoleLogger.info(`Deleted ${file}`);
  });
};

function* serializeObject(obj: any, depth = 0, indent = '  ') {
  const currentIndent = indent.repeat(depth);
  const nextIndent = indent.repeat(depth + 1);

  if (obj instanceof Date) {
    yield JSON.stringify(obj.toISOString());
    return;
  }

  if (Array.isArray(obj)) {
    yield '[\n';
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) yield ',\n';
      yield nextIndent;
      yield* serializeObject(obj[i], depth + 1, indent);
    }
    yield `\n${currentIndent}]`;
    return;
  }

  if (obj !== null && typeof obj === 'object') {
    yield '{\n';
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (i > 0) yield ',\n';
      yield `${nextIndent}${JSON.stringify(key)}: `;
      yield* serializeObject(obj[key], depth + 1, indent);
    }
    yield `\n${currentIndent}}`;
    return;
  }

  if (obj === null || typeof obj === 'function' || typeof obj === 'undefined') {
    yield 'null';
    return;
  }

  yield JSON.stringify(obj);
}

function writeLargeJsonToFile(obj: object, filePath: string) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

    writeStream.on('error', error => {
      consoleLogger.error('Stream error:', error);
      reject(error);
    });

    writeStream.on('finish', () => {
      consoleLogger.info(`JSON file written successfully: ${filePath}`);
      resolve(true);
    });

    const generator = serializeObject(obj);

    function write() {
      let next: any;
      while (!(next = generator.next()).done) {
        if (!writeStream.write(next.value)) {
          writeStream.once('drain', write);
          return;
        }
      }
      writeStream.end();
    }

    write();
  });
}

const writeLargeScanItemsJsonToFile = async (obj: object, filePath: string) => {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    const writeQueue: string[] = [];
    let isWriting = false;

    const processNextWrite = async () => {
      if (isWriting || writeQueue.length === 0) return;

      isWriting = true;
      const data = writeQueue.shift()!;

      try {
        if (!writeStream.write(data)) {
          await new Promise<void>(resolve => {
            writeStream.once('drain', () => {
              resolve();
            });
          });
        }
      } catch (error) {
        writeStream.destroy(error as Error);
        return;
      }

      isWriting = false;
      processNextWrite();
    };

    const queueWrite = (data: string) => {
      writeQueue.push(data);
      processNextWrite();
    };

    writeStream.on('error', error => {
      consoleLogger.error(`Error writing object to JSON file: ${error}`);
      reject(error);
    });

    writeStream.on('finish', () => {
      consoleLogger.info(`JSON file written successfully: ${filePath}`);
      resolve(true);
    });

    try {
      queueWrite('{\n');
      const keys = Object.keys(obj);

      keys.forEach((key, i) => {
        const value = obj[key];

        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          queueWrite(`  "${key}": ${JSON.stringify(value)}`);
        } else {
          queueWrite(`  "${key}": {\n`);

          const { rules, ...otherProperties } = value;

          // Write other properties
          Object.entries(otherProperties).forEach(([propKey, propValue], j) => {
            const propValueString =
              propValue === null ||
              typeof propValue === 'function' ||
              typeof propValue === 'undefined'
                ? 'null'
                : JSON.stringify(propValue);
            queueWrite(`    "${propKey}": ${propValueString}`);
            if (j < Object.keys(otherProperties).length - 1 || (rules && rules.length >= 0)) {
              queueWrite(',\n');
            } else {
              queueWrite('\n');
            }
          });

          if (rules && Array.isArray(rules)) {
            queueWrite('    "rules": [\n');

            rules.forEach((rule, j) => {
              queueWrite('      {\n');
              const { pagesAffected, ...otherRuleProperties } = rule;

              Object.entries(otherRuleProperties).forEach(([ruleKey, ruleValue], k) => {
                const ruleValueString =
                  ruleValue === null ||
                  typeof ruleValue === 'function' ||
                  typeof ruleValue === 'undefined'
                    ? 'null'
                    : JSON.stringify(ruleValue);
                queueWrite(`        "${ruleKey}": ${ruleValueString}`);
                if (k < Object.keys(otherRuleProperties).length - 1 || pagesAffected) {
                  queueWrite(',\n');
                } else {
                  queueWrite('\n');
                }
              });

              if (pagesAffected && Array.isArray(pagesAffected)) {
                queueWrite('        "pagesAffected": [\n');

                pagesAffected.forEach((page, p) => {
                  const pageJson = JSON.stringify(page, null, 2)
                    .split('\n')
                    .map((line, idx) => (idx === 0 ? `          ${line}` : `          ${line}`))
                    .join('\n');

                  queueWrite(pageJson);

                  if (p < pagesAffected.length - 1) {
                    queueWrite(',\n');
                  } else {
                    queueWrite('\n');
                  }
                });

                queueWrite('        ]');
              }

              queueWrite('\n      }');
              if (j < rules.length - 1) {
                queueWrite(',\n');
              } else {
                queueWrite('\n');
              }
            });

            queueWrite('    ]');
          }
          queueWrite('\n  }');
        }

        if (i < keys.length - 1) {
          queueWrite(',\n');
        } else {
          queueWrite('\n');
        }
      });

      queueWrite('}\n');

      // Ensure all queued writes are processed before ending
      const checkQueueAndEnd = () => {
        if (writeQueue.length === 0 && !isWriting) {
          writeStream.end();
        } else {
          setTimeout(checkQueueAndEnd, 100);
        }
      };

      checkQueueAndEnd();
    } catch (err) {
      writeStream.destroy(err as Error);
      reject(err);
    }
  });
};

async function compressJsonFileStreaming(inputPath: string, outputPath: string) {
  // Create the read and write streams
  const readStream = fs.createReadStream(inputPath);
  const writeStream = fs.createWriteStream(outputPath);

  // Create a gzip transform stream
  const gzip = zlib.createGzip();

  // Create a Base64 transform stream
  const base64Encode = new Base64Encode();

  // Pipe the streams:
  //   read -> gzip -> base64 -> write
  await pipeline(readStream, gzip, base64Encode, writeStream);
  consoleLogger.info(`File successfully compressed and saved to ${outputPath}`);
}

const writeJsonFileAndCompressedJsonFile = async (
  data: object,
  storagePath: string,
  filename: string,
): Promise<{ jsonFilePath: string; base64FilePath: string }> => {
  try {
    consoleLogger.info(`Writing JSON to ${filename}.json`);
    const jsonFilePath = path.join(storagePath, `${filename}.json`);
    if (filename === 'scanItems') {
      await writeLargeScanItemsJsonToFile(data, jsonFilePath);
    } else {
      await writeLargeJsonToFile(data, jsonFilePath);
    }

    consoleLogger.info(
      `Reading ${filename}.json, gzipping and base64 encoding it into ${filename}.json.gz.b64`,
    );
    const base64FilePath = path.join(storagePath, `${filename}.json.gz.b64`);
    await compressJsonFileStreaming(jsonFilePath, base64FilePath);

    consoleLogger.info(`Finished compression and base64 encoding for ${filename}`);
    return {
      jsonFilePath,
      base64FilePath,
    };
  } catch (error) {
    consoleLogger.error(`Error compressing and encoding ${filename}`);
    throw error;
  }
};

const streamEncodedDataToFile = async (
  inputFilePath: string,
  writeStream: fs.WriteStream,
  appendComma: boolean,
) => {
  const readStream = fs.createReadStream(inputFilePath, { encoding: 'utf8' });
  let isFirstChunk = true;

  for await (const chunk of readStream) {
    if (isFirstChunk) {
      isFirstChunk = false;
      writeStream.write(chunk);
    } else {
      writeStream.write(chunk);
    }
  }

  if (appendComma) {
    writeStream.write(',');
  }
};

const writeJsonAndBase64Files = async (
  allIssues: AllIssues,
  storagePath: string,
): Promise<{
  scanDataJsonFilePath: string;
  scanDataBase64FilePath: string;
  scanItemsJsonFilePath: string;
  scanItemsBase64FilePath: string;
  scanItemsSummaryJsonFilePath: string;
  scanItemsSummaryBase64FilePath: string;
  scanItemsMiniReportJsonFilePath: string;
  scanItemsMiniReportBase64FilePath: string;
  scanIssuesSummaryJsonFilePath: string;
  scanIssuesSummaryBase64FilePath: string;
  scanPagesDetailJsonFilePath: string;
  scanPagesDetailBase64FilePath: string;
  scanPagesSummaryJsonFilePath: string;
  scanPagesSummaryBase64FilePath: string;
  scanDataJsonFileSize: number;
  scanItemsJsonFileSize: number;
}> => {
  const { items, ...rest } = allIssues;
  const { jsonFilePath: scanDataJsonFilePath, base64FilePath: scanDataBase64FilePath } =
    await writeJsonFileAndCompressedJsonFile(rest, storagePath, 'scanData');
  const { jsonFilePath: scanItemsJsonFilePath, base64FilePath: scanItemsBase64FilePath } =
    await writeJsonFileAndCompressedJsonFile(
      { oobeeAppVersion: allIssues.oobeeAppVersion, ...items },
      storagePath,
      'scanItems',
    );

  // Add pagesAffectedCount to each rule in scanItemsMiniReport (items) and sort them in descending order of pagesAffectedCount
  ['mustFix', 'goodToFix', 'needsReview', 'passed'].forEach(category => {
    if (items[category].rules && Array.isArray(items[category].rules)) {
      items[category].rules.forEach(rule => {
        rule.pagesAffectedCount = Array.isArray(rule.pagesAffected) ? rule.pagesAffected.length : 0;
      });

      // Sort in descending order of pagesAffectedCount
      items[category].rules.sort(
        (a, b) => (b.pagesAffectedCount || 0) - (a.pagesAffectedCount || 0),
      );
    }
  });

  // Refactor scanIssuesSummary to reuse the scanItemsMiniReport structure by stripping out pagesAffected
  const scanIssuesSummary = {
    mustFix: items.mustFix.rules.map(({ pagesAffected, ...ruleInfo }) => ruleInfo),
    goodToFix: items.goodToFix.rules.map(({ pagesAffected, ...ruleInfo }) => ruleInfo),
    needsReview: items.needsReview.rules.map(({ pagesAffected, ...ruleInfo }) => ruleInfo),
    passed: items.passed.rules.map(({ pagesAffected, ...ruleInfo }) => ruleInfo),
  };

  // Write out the scanIssuesSummary JSON using the new structure
  const {
    jsonFilePath: scanIssuesSummaryJsonFilePath,
    base64FilePath: scanIssuesSummaryBase64FilePath,
  } = await writeJsonFileAndCompressedJsonFile(
    { oobeeAppVersion: allIssues.oobeeAppVersion, ...scanIssuesSummary },
    storagePath,
    'scanIssuesSummary',
  );

  // scanItemsSummary
  // the below mutates the original items object, since it is expensive to clone
  items.mustFix.rules.forEach(rule => {
    rule.pagesAffected.forEach(page => {
      page.itemsCount = page.items.length;
    });
  });
  items.goodToFix.rules.forEach(rule => {
    rule.pagesAffected.forEach(page => {
      page.itemsCount = page.items.length;
    });
  });
  items.needsReview.rules.forEach(rule => {
    rule.pagesAffected.forEach(page => {
      page.itemsCount = page.items.length;
    });
  });
  items.passed.rules.forEach(rule => {
    rule.pagesAffected.forEach(page => {
      page.itemsCount = page.items.length;
    });
  });

  items.mustFix.totalRuleIssues = items.mustFix.rules.length;
  items.goodToFix.totalRuleIssues = items.goodToFix.rules.length;
  items.needsReview.totalRuleIssues = items.needsReview.rules.length;
  items.passed.totalRuleIssues = items.passed.rules.length;

  const {
    pagesScanned,
    topTenPagesWithMostIssues,
    pagesNotScanned,
    wcagLinks,
    wcagPassPercentage,
    progressPercentage,
    issuesPercentage,
    totalPagesScanned,
    totalPagesNotScanned,
    topTenIssues,
  } = rest;

  const summaryItemsMini = {
    ...items,
    pagesScanned,
    topTenPagesWithMostIssues,
    pagesNotScanned,
    wcagLinks,
    wcagPassPercentage,
    progressPercentage,
    issuesPercentage,
    totalPagesScanned,
    totalPagesNotScanned,
    topTenIssues,
  };

  const {
    jsonFilePath: scanItemsMiniReportJsonFilePath,
    base64FilePath: scanItemsMiniReportBase64FilePath,
  } = await writeJsonFileAndCompressedJsonFile(
    { oobeeAppVersion: allIssues.oobeeAppVersion, ...summaryItemsMini },
    storagePath,
    'scanItemsSummaryMiniReport',
  );

  const summaryItems = {
    mustFix: {
      totalItems: items.mustFix?.totalItems || 0,
      totalRuleIssues: items.mustFix?.totalRuleIssues || 0,
    },
    goodToFix: {
      totalItems: items.goodToFix?.totalItems || 0,
      totalRuleIssues: items.goodToFix?.totalRuleIssues || 0,
    },
    needsReview: {
      totalItems: items.needsReview?.totalItems || 0,
      totalRuleIssues: items.needsReview?.totalRuleIssues || 0,
    },
    topTenPagesWithMostIssues,
    wcagLinks,
    wcagPassPercentage,
    progressPercentage,
    issuesPercentage,
    totalPagesScanned,
    totalPagesNotScanned,
    topTenIssues,
  };

  const {
    jsonFilePath: scanItemsSummaryJsonFilePath,
    base64FilePath: scanItemsSummaryBase64FilePath,
  } = await writeJsonFileAndCompressedJsonFile(
    { oobeeAppVersion: allIssues.oobeeAppVersion, ...summaryItems },
    storagePath,
    'scanItemsSummary',
  );

  const {
    jsonFilePath: scanPagesDetailJsonFilePath,
    base64FilePath: scanPagesDetailBase64FilePath,
  } = await writeJsonFileAndCompressedJsonFile(
    { oobeeAppVersion: allIssues.oobeeAppVersion, ...allIssues.scanPagesDetail },
    storagePath,
    'scanPagesDetail',
  );

  const {
    jsonFilePath: scanPagesSummaryJsonFilePath,
    base64FilePath: scanPagesSummaryBase64FilePath,
  } = await writeJsonFileAndCompressedJsonFile(
    { oobeeAppVersion: allIssues.oobeeAppVersion, ...allIssues.scanPagesSummary },
    storagePath,
    'scanPagesSummary',
  );

  return {
    scanDataJsonFilePath,
    scanDataBase64FilePath,
    scanItemsJsonFilePath,
    scanItemsBase64FilePath,
    scanItemsSummaryJsonFilePath,
    scanItemsSummaryBase64FilePath,
    scanItemsMiniReportJsonFilePath,
    scanItemsMiniReportBase64FilePath,
    scanIssuesSummaryJsonFilePath,
    scanIssuesSummaryBase64FilePath,
    scanPagesDetailJsonFilePath,
    scanPagesDetailBase64FilePath,
    scanPagesSummaryJsonFilePath,
    scanPagesSummaryBase64FilePath,
    scanDataJsonFileSize: fs.statSync(scanDataJsonFilePath).size,
    scanItemsJsonFileSize: fs.statSync(scanItemsJsonFilePath).size,
  };
};

const writeScanDetailsCsv = async (
  scanDataFilePath: string,
  scanItemsFilePath: string,
  scanItemsSummaryFilePath: string,
  storagePath: string,
) => {
  const filePath = path.join(storagePath, 'scanDetails.csv');
  const csvWriteStream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  const directoryPath = path.dirname(filePath);

  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }

  csvWriteStream.write('scanData_base64,scanItems_base64,scanItemsSummary_base64\n');
  await streamEncodedDataToFile(scanDataFilePath, csvWriteStream, true);
  await streamEncodedDataToFile(scanItemsFilePath, csvWriteStream, true);
  await streamEncodedDataToFile(scanItemsSummaryFilePath, csvWriteStream, false);

  await new Promise((resolve, reject) => {
    csvWriteStream.end(resolve);
    csvWriteStream.on('error', reject);
  });
};

const writeSummaryPdf = async (
  storagePath: string,
  pagesScanned: number,
  filename = 'summary',
  browser: string,
  userDataDirectory: string,
) => {
  const htmlFilePath = `${storagePath}/${filename}.html`;
  const fileDestinationPath = `${storagePath}/${filename}.pdf`;

  const effectiveUserDataDirectory = process.env.CRAWLEE_HEADLESS === '1' ? userDataDirectory : '';
  const context = await constants.launcher.launchPersistentContext(effectiveUserDataDirectory, {
    headless: true,
    ...getPlaywrightLaunchOptions(browser),
  });

  register(context);

  const page = await context.newPage();

  const data = fs.readFileSync(htmlFilePath, { encoding: 'utf-8' });
  await page.setContent(data);

  await page.waitForLoadState('networkidle', { timeout: 30000 });

  await page.emulateMedia({ media: 'print' });

  await page.pdf({
    margin: { bottom: '32px' },
    path: fileDestinationPath,
    format: 'A4',
    displayHeaderFooter: true,
    footerTemplate: `
    <div style="margin-top:50px;color:#26241b;font-family:Open Sans;text-align: center;width: 100%;font-weight:400">
      <span style="color:#26241b;font-size: 14px;font-weight:400">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>
  `,
  });

  await page.close();

  await context.close().catch(() => {});

  if (pagesScanned < 2000) {
    fs.unlinkSync(htmlFilePath);
  }
};

// Tracking WCAG occurrences
const wcagOccurrencesMap = new Map<string, number>();

// Format WCAG tag in requested format: wcag111a_Occurrences
const formatWcagTag = async (wcagId: string): Promise<string | null> => {
  // Get dynamic WCAG criteria map
  const wcagCriteriaMap = await getWcagCriteriaMap();

  if (wcagCriteriaMap[wcagId]) {
    const { level } = wcagCriteriaMap[wcagId];
    return `${wcagId}${level}_Occurrences`;
  }
  return null;
};

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

      if (isCustomFlow) {
        const { pageIndex, pageImagePath, metadata } = pageResults;
        currRuleFromAllIssues.pagesAffected[pageIndex] = {
          url,
          pageTitle,
          pageImagePath,
          metadata,
          items: [],
        };
        currRuleFromAllIssues.pagesAffected[pageIndex].items.push(...items);
      } else {
        if (!(url in currRuleFromAllIssues.pagesAffected)) {
          currRuleFromAllIssues.pagesAffected[url] = {
            pageTitle,
            items: [],
            ...(filePath && { filePath }),
          };
          /* if (actualUrl) {
            currRuleFromAllIssues.pagesAffected[url].actualUrl = actualUrl;
            // Deduct duplication count from totalItems
            currRuleFromAllIssues.totalItems -= 1;
            // Previously using pagesAffected.length to display no. of pages affected
            // However, since pagesAffected array contains duplicates, we need to deduct the duplicates
            // Hence, start with negative offset, will add pagesAffected.length later
            currRuleFromAllIssues.numberOfPagesAffectedAfterRedirects -= 1;
            currCategoryFromAllIssues.totalItems -= 1;
          } */
        }

        currRuleFromAllIssues.pagesAffected[url].items.push(...items);
        // currRuleFromAllIssues.numberOfPagesAffectedAfterRedirects +=
        //   currRuleFromAllIssues.pagesAffected.length;
      }
    });
  });
};

const getTopTenIssues = allIssues => {
  const categories = ['mustFix', 'goodToFix'];
  const rulesWithCounts = [];

  // This is no longer required and shall not be maintained in future
  /*
  const conformanceLevels = {
    wcag2a: 'A',
    wcag2aa: 'AA',
    wcag21aa: 'AA',
    wcag22aa: 'AA',
    wcag2aaa: 'AAA',
  };
  */

  categories.forEach(category => {
    const rules = allIssues.items[category]?.rules || [];

    rules.forEach(rule => {
      // This is not needed anymore since we want to have the clause number too
      /*
      const wcagLevel = rule.conformance[0];
      const aLevel = conformanceLevels[wcagLevel] || wcagLevel;
      */

      rulesWithCounts.push({
        category,
        ruleId: rule.rule,
        description: rule.description,
        axeImpact: rule.axeImpact,
        conformance: rule.conformance,
        totalItems: rule.totalItems,
      });
    });
  });

  rulesWithCounts.sort((a, b) => b.totalItems - a.totalItems);

  return rulesWithCounts.slice(0, 10);
};

const flattenAndSortResults = (allIssues: AllIssues, isCustomFlow: boolean) => {
  // Create a map that will sum items only from mustFix, goodToFix, and needsReview.
  const urlOccurrencesMap = new Map<string, number>();

  // Iterate over all categories; update the map only if the category is not "passed"
  ['mustFix', 'goodToFix', 'needsReview', 'passed'].forEach(category => {
    // Accumulate totalItems regardless of category.
    allIssues.totalItems += allIssues.items[category].totalItems;

    allIssues.items[category].rules = Object.entries(allIssues.items[category].rules)
      .map(ruleEntry => {
        const [rule, ruleInfo] = ruleEntry as [string, RuleInfo];
        ruleInfo.pagesAffected = Object.entries(ruleInfo.pagesAffected)
          .map(pageEntry => {
            if (isCustomFlow) {
              const [pageIndex, pageInfo] = pageEntry as unknown as [number, PageInfo];
              // Only update the occurrences map if not passed.
              if (category !== 'passed') {
                urlOccurrencesMap.set(
                  pageInfo.url!,
                  (urlOccurrencesMap.get(pageInfo.url!) || 0) + pageInfo.items.length,
                );
              }
              return { pageIndex, ...pageInfo };
            }
            const [url, pageInfo] = pageEntry as unknown as [string, PageInfo];
            if (category !== 'passed') {
              urlOccurrencesMap.set(url, (urlOccurrencesMap.get(url) || 0) + pageInfo.items.length);
            }
            return { url, ...pageInfo };
          })
          // Sort pages so that those with the most items come first
          .sort((page1, page2) => page2.items.length - page1.items.length);
        return { rule, ...ruleInfo };
      })
      // Sort the rules by totalItems (descending)
      .sort((rule1, rule2) => rule2.totalItems - rule1.totalItems);
  });

  // Sort top pages (assumes topFiveMostIssues is already populated)
  allIssues.topFiveMostIssues.sort((p1, p2) => p2.totalIssues - p1.totalIssues);
  allIssues.topTenPagesWithMostIssues = allIssues.topFiveMostIssues.slice(0, 10);
  allIssues.topFiveMostIssues = allIssues.topFiveMostIssues.slice(0, 5);

  // Update each issue in topTenPagesWithMostIssues with the computed occurrences,
  // excluding passed items.
  updateIssuesWithOccurrences(allIssues.topTenPagesWithMostIssues, urlOccurrencesMap);

  // Get and assign the topTenIssues (using your existing helper)
  const topTenIssues = getTopTenIssues(allIssues);
  allIssues.topTenIssues = topTenIssues;
};

// Helper: Update totalOccurrences for each issue using our urlOccurrencesMap.
// For pages that have only passed items, the map will return undefined, so default to 0.
function updateIssuesWithOccurrences(issuesList: any[], urlOccurrencesMap: Map<string, number>) {
  issuesList.forEach(issue => {
    issue.totalOccurrences = urlOccurrencesMap.get(issue.url) || 0;
  });
}

const createRuleIdJson = allIssues => {
  const compiledRuleJson = {};

  const ruleIterator = rule => {
    const ruleId = rule.rule;
    let snippets = [];

    if (oobeeAiRules.includes(ruleId)) {
      const snippetsSet = new Set();
      rule.pagesAffected.forEach(page => {
        page.items.forEach(htmlItem => {
          snippetsSet.add(oobeeAiHtmlETL(htmlItem.html));
        });
      });
      snippets = [...snippetsSet];
      rule.pagesAffected.forEach(p => {
        delete p.items;
      });
    }
    compiledRuleJson[ruleId] = {
      snippets,
      occurrences: rule.totalItems,
    };
  };

  allIssues.items.mustFix.rules.forEach(ruleIterator);
  allIssues.items.goodToFix.rules.forEach(ruleIterator);
  allIssues.items.needsReview.rules.forEach(ruleIterator);
  return compiledRuleJson;
};

const moveElemScreenshots = (randomToken: string, storagePath: string) => {
  const currentScreenshotsPath = `${randomToken}/elemScreenshots`;
  const resultsScreenshotsPath = `${storagePath}/elemScreenshots`;
  if (fs.existsSync(currentScreenshotsPath)) {
    fs.moveSync(currentScreenshotsPath, resultsScreenshotsPath);
  }
};

/**
 * Build allIssues.scanPagesDetail and allIssues.scanPagesSummary
 * by analyzing pagesScanned (including mustFix/goodToFix/etc.).
 */
function populateScanPagesDetail(allIssues: AllIssues): void {
  // --------------------------------------------
  // 1) Gather your "scanned" pages from allIssues
  // --------------------------------------------
  const allScannedPages = Array.isArray(allIssues.pagesScanned) ? allIssues.pagesScanned : [];

  // --------------------------------------------
  // 2) Define category constants (optional, just for clarity)
  // --------------------------------------------
  const mustFixCategory = 'mustFix';
  const goodToFixCategory = 'goodToFix';
  const needsReviewCategory = 'needsReview';
  const passedCategory = 'passed';

  // --------------------------------------------
  // 3) Set up type declarations (if you want them local to this function)
  // --------------------------------------------
  type RuleData = {
    ruleId: string;
    wcagConformance: string[];
    occurrencesMustFix: number;
    occurrencesGoodToFix: number;
    occurrencesNeedsReview: number;
    occurrencesPassed: number;
  };

  type PageData = {
    pageTitle: string;
    url: string;
    // Summaries
    totalOccurrencesFailedIncludingNeedsReview: number; // mustFix + goodToFix + needsReview
    totalOccurrencesFailedExcludingNeedsReview: number; // mustFix + goodToFix
    totalOccurrencesNeedsReview: number; // needsReview
    totalOccurrencesPassed: number; // passed only
    typesOfIssues: Record<string, RuleData>;
  };

  // --------------------------------------------
  // 4) We'll accumulate pages in a map keyed by URL
  // --------------------------------------------
  const pagesMap: Record<string, PageData> = {};

  // --------------------------------------------
  // 5) Build pagesMap by iterating over each category in allIssues.items
  // --------------------------------------------
  Object.entries(allIssues.items).forEach(([categoryName, categoryData]) => {
    if (!categoryData?.rules) return; // no rules in this category? skip

    categoryData.rules.forEach(rule => {
      const { rule: ruleId, conformance = [] } = rule;

      rule.pagesAffected.forEach(p => {
        const { url, pageTitle, items = [] } = p;
        const itemsCount = items.length;

        // Ensure the page is in pagesMap
        if (!pagesMap[url]) {
          pagesMap[url] = {
            pageTitle,
            url,
            totalOccurrencesFailedIncludingNeedsReview: 0,
            totalOccurrencesFailedExcludingNeedsReview: 0,
            totalOccurrencesNeedsReview: 0,
            totalOccurrencesPassed: 0,
            typesOfIssues: {},
          };
        }

        // Ensure the rule is present for this page
        if (!pagesMap[url].typesOfIssues[ruleId]) {
          pagesMap[url].typesOfIssues[ruleId] = {
            ruleId,
            wcagConformance: conformance,
            occurrencesMustFix: 0,
            occurrencesGoodToFix: 0,
            occurrencesNeedsReview: 0,
            occurrencesPassed: 0,
          };
        }

        // Depending on the category, increment the relevant occurrence counts
        if (categoryName === mustFixCategory) {
          pagesMap[url].typesOfIssues[ruleId].occurrencesMustFix += itemsCount;
          pagesMap[url].totalOccurrencesFailedIncludingNeedsReview += itemsCount;
          pagesMap[url].totalOccurrencesFailedExcludingNeedsReview += itemsCount;
        } else if (categoryName === goodToFixCategory) {
          pagesMap[url].typesOfIssues[ruleId].occurrencesGoodToFix += itemsCount;
          pagesMap[url].totalOccurrencesFailedIncludingNeedsReview += itemsCount;
          pagesMap[url].totalOccurrencesFailedExcludingNeedsReview += itemsCount;
        } else if (categoryName === needsReviewCategory) {
          pagesMap[url].typesOfIssues[ruleId].occurrencesNeedsReview += itemsCount;
          pagesMap[url].totalOccurrencesFailedIncludingNeedsReview += itemsCount;
          pagesMap[url].totalOccurrencesNeedsReview += itemsCount;
        } else if (categoryName === passedCategory) {
          pagesMap[url].typesOfIssues[ruleId].occurrencesPassed += itemsCount;
          pagesMap[url].totalOccurrencesPassed += itemsCount;
        }
      });
    });
  });

  // --------------------------------------------
  // 6) Separate scanned pages into “affected” vs. “notAffected”
  // --------------------------------------------
  const pagesInMap = Object.values(pagesMap); // All pages that have some record in pagesMap
  const pagesInMapUrls = new Set(Object.keys(pagesMap));

  // (a) Pages with only passed (no mustFix/goodToFix/needsReview)
  const pagesAllPassed = pagesInMap.filter(p => p.totalOccurrencesFailedIncludingNeedsReview === 0);

  // (b) Pages that do NOT appear in pagesMap at all => scanned but no items found
  const pagesNoEntries = allScannedPages
    .filter(sp => !pagesInMapUrls.has(sp.url))
    .map(sp => ({
      pageTitle: sp.pageTitle,
      url: sp.url,
      totalOccurrencesFailedIncludingNeedsReview: 0,
      totalOccurrencesFailedExcludingNeedsReview: 0,
      totalOccurrencesNeedsReview: 0,
      totalOccurrencesPassed: 0,
      typesOfIssues: {},
    }));

  // Combine these into "notAffected"
  const pagesNotAffectedRaw = [...pagesAllPassed, ...pagesNoEntries];

  // "affected" pages => have at least 1 mustFix/goodToFix/needsReview
  const pagesAffectedRaw = pagesInMap.filter(p => p.totalOccurrencesFailedIncludingNeedsReview > 0);

  // --------------------------------------------
  // 7) Transform both arrays to the final shape
  // --------------------------------------------
  function transformPageData(page: PageData) {
    const typesOfIssuesArray = Object.values(page.typesOfIssues);

    // Compute sums for each failing category
    const mustFixSum = typesOfIssuesArray.reduce((acc, r) => acc + r.occurrencesMustFix, 0);
    const goodToFixSum = typesOfIssuesArray.reduce((acc, r) => acc + r.occurrencesGoodToFix, 0);
    const needsReviewSum = typesOfIssuesArray.reduce((acc, r) => acc + r.occurrencesNeedsReview, 0);

    // Build categoriesPresent based on nonzero failing counts
    const categoriesPresent: string[] = [];
    if (mustFixSum > 0) categoriesPresent.push('mustFix');
    if (goodToFixSum > 0) categoriesPresent.push('goodToFix');
    if (needsReviewSum > 0) categoriesPresent.push('needsReview');

    // Count how many rules have failing issues
    const failedRuleIds = new Set<string>();
    typesOfIssuesArray.forEach(r => {
      if (
        (r.occurrencesMustFix || 0) > 0 ||
        (r.occurrencesGoodToFix || 0) > 0 ||
        (r.occurrencesNeedsReview || 0) > 0
      ) {
        failedRuleIds.add(r.ruleId); // Ensure ruleId is unique
      }
    });
    const failedRuleCount = failedRuleIds.size;

    // Possibly these two for future convenience
    const typesOfIssuesExcludingNeedsReviewCount = typesOfIssuesArray.filter(
      r => (r.occurrencesMustFix || 0) + (r.occurrencesGoodToFix || 0) > 0,
    ).length;

    const typesOfIssuesExclusiveToNeedsReviewCount = typesOfIssuesArray.filter(
      r =>
        (r.occurrencesNeedsReview || 0) > 0 &&
        (r.occurrencesMustFix || 0) === 0 &&
        (r.occurrencesGoodToFix || 0) === 0,
    ).length;

    // Aggregate wcagConformance for rules that actually fail
    const allConformance = typesOfIssuesArray.reduce((acc, curr) => {
      const nonPassedCount =
        (curr.occurrencesMustFix || 0) +
        (curr.occurrencesGoodToFix || 0) +
        (curr.occurrencesNeedsReview || 0);

      if (nonPassedCount > 0) {
        return acc.concat(curr.wcagConformance || []);
      }
      return acc;
    }, [] as string[]);
    // Remove duplicates
    const conformance = Array.from(new Set(allConformance));

    return {
      pageTitle: page.pageTitle,
      url: page.url,
      totalOccurrencesFailedIncludingNeedsReview: page.totalOccurrencesFailedIncludingNeedsReview,
      totalOccurrencesFailedExcludingNeedsReview: page.totalOccurrencesFailedExcludingNeedsReview,
      totalOccurrencesMustFix: mustFixSum,
      totalOccurrencesGoodToFix: goodToFixSum,
      totalOccurrencesNeedsReview: needsReviewSum,
      totalOccurrencesPassed: page.totalOccurrencesPassed,
      typesOfIssuesExclusiveToNeedsReviewCount,
      typesOfIssuesCount: failedRuleCount,
      typesOfIssuesExcludingNeedsReviewCount,
      categoriesPresent,
      conformance,
      // Keep full detail for "scanPagesDetail"
      typesOfIssues: typesOfIssuesArray,
    };
  }

  // Transform raw pages
  const pagesAffected = pagesAffectedRaw.map(transformPageData);
  const pagesNotAffected = pagesNotAffectedRaw.map(transformPageData);

  // --------------------------------------------
  // 8) Sort pages by typesOfIssuesCount (descending) for both arrays
  // --------------------------------------------
  pagesAffected.sort((a, b) => b.typesOfIssuesCount - a.typesOfIssuesCount);
  pagesNotAffected.sort((a, b) => b.typesOfIssuesCount - a.typesOfIssuesCount);

  // --------------------------------------------
  // 9) Compute scanned/ skipped counts
  // --------------------------------------------
  const scannedPagesCount = pagesAffected.length + pagesNotAffected.length;
  const pagesNotScannedCount = Array.isArray(allIssues.pagesNotScanned)
    ? allIssues.pagesNotScanned.length
    : 0;

  // --------------------------------------------
  // 10) Build scanPagesDetail (with full "typesOfIssues")
  // --------------------------------------------
  allIssues.scanPagesDetail = {
    pagesAffected,
    pagesNotAffected,
    scannedPagesCount,
    pagesNotScanned: Array.isArray(allIssues.pagesNotScanned) ? allIssues.pagesNotScanned : [],
    pagesNotScannedCount,
  };

  // --------------------------------------------
  // 11) Build scanPagesSummary (strip out "typesOfIssues")
  // --------------------------------------------
  function stripTypesOfIssues(page: ReturnType<typeof transformPageData>) {
    const { typesOfIssues, ...rest } = page;
    return rest;
  }

  const summaryPagesAffected = pagesAffected.map(stripTypesOfIssues);
  const summaryPagesNotAffected = pagesNotAffected.map(stripTypesOfIssues);

  allIssues.scanPagesSummary = {
    pagesAffected: summaryPagesAffected,
    pagesNotAffected: summaryPagesNotAffected,
    scannedPagesCount,
    pagesNotScanned: Array.isArray(allIssues.pagesNotScanned) ? allIssues.pagesNotScanned : [],
    pagesNotScannedCount,
  };
}

// Send WCAG criteria breakdown to Sentry
const sendWcagBreakdownToSentry = async (
  appVersion: string,
  wcagBreakdown: Map<string, number>,
  ruleIdJson: any,
  scanInfo: {
    entryUrl: string;
    scanType: string;
    browser: string;
    email?: string;
    name?: string;
  },
  allIssues?: AllIssues,
  pagesScannedCount: number = 0,
) => {
  try {
    // Initialize Sentry
    Sentry.init(sentryConfig);
    // Set user ID for Sentry tracking
    const userData = getUserDataTxt();
    if (userData && userData.userId) {
      setSentryUser(userData.userId);
    }

    // Prepare tags for the event
    const tags: Record<string, string> = {};
    const wcagCriteriaBreakdown: Record<string, any> = {};

    // Tag app version
    tags.version = appVersion;

    // Get dynamic WCAG criteria map once
    const wcagCriteriaMap = await getWcagCriteriaMap();

    // Categorize all WCAG criteria for reporting
    const wcagIds = Array.from(
      new Set([...Object.keys(wcagCriteriaMap), ...Array.from(wcagBreakdown.keys())]),
    );
    const categorizedWcag = await categorizeWcagCriteria(wcagIds);

    // First ensure all WCAG criteria are included in the tags with a value of 0
    // This ensures criteria with no violations are still reported
    for (const [wcagId, info] of Object.entries(wcagCriteriaMap)) {
      const formattedTag = await formatWcagTag(wcagId);
      if (formattedTag) {
        // Initialize with zero
        tags[formattedTag] = '0';

        // Store in breakdown object with category information
        wcagCriteriaBreakdown[formattedTag] = {
          count: 0,
          category: categorizedWcag[wcagId] || 'mustFix', // Default to mustFix if not found
        };
      }
    }

    // Now override with actual counts from the scan
    for (const [wcagId, count] of wcagBreakdown.entries()) {
      const formattedTag = await formatWcagTag(wcagId);
      if (formattedTag) {
        // Add as a tag with the count as value
        tags[formattedTag] = String(count);

        // Update count in breakdown object
        if (wcagCriteriaBreakdown[formattedTag]) {
          wcagCriteriaBreakdown[formattedTag].count = count;
        } else {
          // If somehow this wasn't in our initial map
          wcagCriteriaBreakdown[formattedTag] = {
            count,
            category: categorizedWcag[wcagId] || 'mustFix',
          };
        }
      }
    }

    // Calculate category counts based on actual issue counts from the report
    // rather than occurrence counts from wcagBreakdown
    const categoryCounts = {
      mustFix: 0,
      goodToFix: 0,
      needsReview: 0,
    };

    if (allIssues) {
      // Use the actual report data for the counts
      categoryCounts.mustFix = allIssues.items.mustFix.rules.length;
      categoryCounts.goodToFix = allIssues.items.goodToFix.rules.length;
      categoryCounts.needsReview = allIssues.items.needsReview.rules.length;
    } else {
      // Fallback to the old way if allIssues not provided
      Object.values(wcagCriteriaBreakdown).forEach(item => {
        if (item.count > 0 && categoryCounts[item.category] !== undefined) {
          categoryCounts[item.category] += 1; // Count rules, not occurrences
        }
      });
    }

    // Add category counts as tags
    tags['WCAG-MustFix-Count'] = String(categoryCounts.mustFix);
    tags['WCAG-GoodToFix-Count'] = String(categoryCounts.goodToFix);
    tags['WCAG-NeedsReview-Count'] = String(categoryCounts.needsReview);

    // Also add occurrence counts for reference
    if (allIssues) {
      tags['WCAG-MustFix-Occurrences'] = String(allIssues.items.mustFix.totalItems);
      tags['WCAG-GoodToFix-Occurrences'] = String(allIssues.items.goodToFix.totalItems);
      tags['WCAG-NeedsReview-Occurrences'] = String(allIssues.items.needsReview.totalItems);

      // Add number of pages scanned tag
      tags['Pages-Scanned-Count'] = String(allIssues.totalPagesScanned);
    } else if (pagesScannedCount > 0) {
      // Still add the pages scanned count even if we don't have allIssues
      tags['Pages-Scanned-Count'] = String(pagesScannedCount);
    }

    // Send the event to Sentry
    await Sentry.captureEvent({
      message: 'Accessibility Scan Completed',
      level: 'info',
      tags: {
        ...tags,
        event_type: 'accessibility_scan',
        scanType: scanInfo.scanType,
        browser: scanInfo.browser,
        entryUrl: scanInfo.entryUrl,
      },
      user: {
        ...(scanInfo.email && scanInfo.name
          ? {
              email: scanInfo.email,
              username: scanInfo.name,
            }
          : {}),
        ...(userData && userData.userId ? { id: userData.userId } : {}),
      },
      extra: {
        additionalScanMetadata: ruleIdJson != null ? JSON.stringify(ruleIdJson) : '{}',
        wcagBreakdown: wcagCriteriaBreakdown,
        reportCounts: allIssues
          ? {
              mustFix: {
                issues: allIssues.items.mustFix.rules?.length ?? 0,
                occurrences: allIssues.items.mustFix.totalItems ?? 0,
              },
              goodToFix: {
                issues: allIssues.items.goodToFix.rules?.length ?? 0,
                occurrences: allIssues.items.goodToFix.totalItems ?? 0,
              },
              needsReview: {
                issues: allIssues.items.needsReview.rules?.length ?? 0,
                occurrences: allIssues.items.needsReview.totalItems ?? 0,
              },
            }
          : undefined,
      },
    });

    // Wait for events to be sent
    await Sentry.flush(2000);
  } catch (error) {
    console.error('Error sending WCAG breakdown to Sentry:', error);
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
    consoleLogger.info('An error has occurred when flattening the issues, please try again.');
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
    scanItemsMiniReportJsonFilePath,
    scanItemsMiniReportBase64FilePath,
    scanIssuesSummaryJsonFilePath,
    scanIssuesSummaryBase64FilePath,
    scanPagesDetailJsonFilePath,
    scanPagesDetailBase64FilePath,
    scanPagesSummaryJsonFilePath,
    scanPagesSummaryBase64FilePath,
    scanDataJsonFileSize,
    scanItemsJsonFileSize,
  } = await writeJsonAndBase64Files(allIssues, storagePath);
  const BIG_RESULTS_THRESHOLD = 500 * 1024 * 1024; // 500 MB
  const resultsTooBig = scanDataJsonFileSize + scanItemsJsonFileSize > BIG_RESULTS_THRESHOLD;

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
    resultsTooBig ? scanItemsMiniReportBase64FilePath : scanItemsBase64FilePath,
  );

  if (!generateJsonFiles) {
    await cleanUpJsonFiles([
      scanDataJsonFilePath,
      scanDataBase64FilePath,
      scanItemsJsonFilePath,
      scanItemsBase64FilePath,
      scanItemsSummaryJsonFilePath,
      scanItemsSummaryBase64FilePath,
      scanItemsMiniReportJsonFilePath,
      scanItemsMiniReportBase64FilePath,
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
    fs.rmSync(path.join(storagePath, 'crawlee'), { recursive: true, force: true });
  } catch (error) {
    consoleLogger.warn(`Unable to force remove crawlee folder: ${error.message}`);
  }

  try {
    fs.rmSync(path.join(storagePath, 'pdfs'), { recursive: true, force: true });
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
  flattenAndSortResults,
  populateScanPagesDetail,
  getWcagPassPercentage,
  getProgressPercentage,
  getIssuesPercentage,
  itemTypeDescription,
  oobeeAiHtmlETL,
  oobeeAiRules,
  formatAboutStartTime,
};

export default generateArtifacts;