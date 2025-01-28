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
import constants, { ScannerTypes } from './constants/constants.js';
import { urlWithoutAuth, prepareData } from './constants/common.js';
import {
  createScreenshotsFolder,
  getStoragePath,
  getVersion,
  getWcagPassPercentage,
  retryFunction,
  zipResults,
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

type PageInfo = {
  items: ItemsInfo[];
  itemsCount?: number;
  pageTitle: string;
  url?: string;
  pageImagePath?: string;
  pageIndex?: number;
  metadata: string;
};

export type RuleInfo = {
  totalItems: number;
  pagesAffected: PageInfo[];
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
  startTime: Date;
  endTime: Date;
  urlScanned: string;
  scanType: string;
  deviceChosen: string;
  formatAboutStartTime: (dateString: any) => string;
  isCustomFlow: boolean;
  viewport: string;
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
  phAppVersion: string;
  items: {
    mustFix: Category;
    goodToFix: Category;
    needsReview: Category;
    passed: Category;
  };
  cypressScanAboutMetadata: string;
  wcagLinks: { [key: string]: string };
  [key: string]: any;
  advancedScanOptionsSummaryItems: { [key: string]: boolean };
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
      silentLogger.error(`(extractFileNames) - ${readdirError}`);
      throw readdirError;
    });
};
const parseContentToJson = async rPath =>
  fs
    .readFile(rPath, 'utf8')
    .then(content => JSON.parse(content))
    .catch(parseError => {
      consoleLogger.info('An error has occurred when parsing the content, please try again.');
      silentLogger.error(`(parseContentToJson) - ${parseError}`);
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
    // we filter out the below as it represents the A/AA/AAA level, not the clause itself
    const clausesArr = conformance.filter(
      clause => !['wcag2a', 'wcag2aa', 'wcag2aaa'].includes(clause),
    );
    pagesAffected.sort((a, b) => a.url.localeCompare(b.url));
    // format clauses as a string
    const wcagConformance = clausesArr.join(',');

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
          issueDescription: issueDescription || '',
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

  const parser = new AsyncParser(opts);
  parser.parse(allIssues).pipe(csvOutput);
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
  const html = template(allIssues);
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
  console.log(`File successfully compressed and saved to ${outputPath}`);
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
  scanDataJsonFileSize: number;
  scanItemsJsonFileSize: number;
}> => {
  const { items, ...rest } = allIssues;
  const { jsonFilePath: scanDataJsonFilePath, base64FilePath: scanDataBase64FilePath } =
    await writeJsonFileAndCompressedJsonFile(rest, storagePath, 'scanData');
  const { jsonFilePath: scanItemsJsonFilePath, base64FilePath: scanItemsBase64FilePath } =
    await writeJsonFileAndCompressedJsonFile(items, storagePath, 'scanItems');

  // scanItemsSummary
  // the below mutates the original items object, since it is expensive to clone
  items.mustFix.rules.forEach(rule => {
    rule.pagesAffected.forEach(page => {
      page.itemsCount = page.items.length;
      page.items = [];
    });
  });
  items.goodToFix.rules.forEach(rule => {
    rule.pagesAffected.forEach(page => {
      page.itemsCount = page.items.length;
      page.items = [];
    });
  });
  items.needsReview.rules.forEach(rule => {
    rule.pagesAffected.forEach(page => {
      page.itemsCount = page.items.length;
      page.items = [];
    });
  });
  items.passed.rules.forEach(rule => {
    rule.pagesAffected.forEach(page => {
      page.itemsCount = page.items.length;
      page.items = [];
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
    totalPagesScanned,
    totalPagesNotScanned,
    topTenIssues,
  } = rest;

  const summaryItems = {
    ...items,
    pagesScanned,
    topTenPagesWithMostIssues,
    pagesNotScanned,
    wcagLinks,
    wcagPassPercentage,
    totalPagesScanned,
    totalPagesNotScanned,
    topTenIssues,
  };

  const {
    jsonFilePath: scanItemsSummaryJsonFilePath,
    base64FilePath: scanItemsSummaryBase64FilePath,
  } = await writeJsonFileAndCompressedJsonFile(summaryItems, storagePath, 'scanItemsSummary');

  return {
    scanDataJsonFilePath,
    scanDataBase64FilePath,
    scanItemsJsonFilePath,
    scanItemsBase64FilePath,
    scanItemsSummaryJsonFilePath,
    scanItemsSummaryBase64FilePath,
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

let browserChannel = 'chrome';

if (os.platform() === 'win32') {
  browserChannel = 'msedge';
}

if (os.platform() === 'linux') {
  browserChannel = 'chromium';
}

const writeSummaryPdf = async (storagePath: string, pagesScanned: number, filename = 'summary') => {
  const htmlFilePath = `${storagePath}/${filename}.html`;
  const fileDestinationPath = `${storagePath}/${filename}.pdf`;
  const browser = await chromium.launch({
    headless: false,
    channel: browserChannel,
    args: ['--headless=new', '--no-sandbox'],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });

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

  await context.close();
  await browser.close();

  if (pagesScanned < 2000) {
    fs.unlinkSync(htmlFilePath);
  }
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

  const conformanceLevels = {
    wcag2a: 'A',
    wcag2aa: 'AA',
    wcag21aa: 'AA',
    wcag22aa: 'AA',
    wcag2aaa: 'AAA',
  };

  categories.forEach(category => {
    const rules = allIssues.items[category]?.rules || [];

    rules.forEach(rule => {
      const wcagLevel = rule.conformance[0];
      const aLevel = conformanceLevels[wcagLevel] || wcagLevel;

      rulesWithCounts.push({
        category,
        ruleId: rule.rule,
        description: rule.description,
        axeImpact: rule.axeImpact,
        conformance: aLevel,
        totalItems: rule.totalItems,
      });
    });
  });

  rulesWithCounts.sort((a, b) => b.totalItems - a.totalItems);

  return rulesWithCounts.slice(0, 10);
};

const flattenAndSortResults = (allIssues: AllIssues, isCustomFlow: boolean) => {
  const urlOccurrencesMap = new Map<string, number>();

  ['mustFix', 'goodToFix', 'needsReview', 'passed'].forEach(category => {
    allIssues.totalItems += allIssues.items[category].totalItems;

    if (category === 'passed') return;

    allIssues.items[category].rules = Object.entries(allIssues.items[category].rules)
      .map(ruleEntry => {
        const [rule, ruleInfo] = ruleEntry as [string, RuleInfo];
        ruleInfo.pagesAffected = Object.entries(ruleInfo.pagesAffected)
          .map(pageEntry => {
            if (isCustomFlow) {
              const [pageIndex, pageInfo] = pageEntry as unknown as [number, PageInfo];
              urlOccurrencesMap.set(
                pageInfo.url!,
                (urlOccurrencesMap.get(pageInfo.url!) || 0) + pageInfo.items.length,
              );
              return { pageIndex, ...pageInfo };
            }
            const [url, pageInfo] = pageEntry as unknown as [string, PageInfo];
            urlOccurrencesMap.set(url, (urlOccurrencesMap.get(url) || 0) + pageInfo.items.length);
            return { url, ...pageInfo };
          })
          .sort((page1, page2) => page2.items.length - page1.items.length);
        return { rule, ...ruleInfo };
      })
      .sort((rule1, rule2) => rule2.totalItems - rule1.totalItems);
  });

  const updateIssuesWithOccurrences = (issuesList: Array<any>) => {
    issuesList.forEach(issue => {
      issue.totalOccurrences = urlOccurrencesMap.get(issue.url) || 0;
    });
  };

  allIssues.topFiveMostIssues.sort((page1, page2) => page2.totalIssues - page1.totalIssues);
  allIssues.topFiveMostIssues = allIssues.topFiveMostIssues.slice(0, 5);
  allIssues.topTenPagesWithMostIssues = allIssues.topFiveMostIssues.slice(0, 10);
  updateIssuesWithOccurrences(allIssues.topTenPagesWithMostIssues);
  const topTenIssues = getTopTenIssues(allIssues);
  allIssues.topTenIssues = topTenIssues;
};

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

const moveElemScreenshots = (randomToken, storagePath) => {
  const currentScreenshotsPath = `${randomToken}/elemScreenshots`;
  const resultsScreenshotsPath = `${storagePath}/elemScreenshots`;
  if (fs.existsSync(currentScreenshotsPath)) {
    fs.moveSync(currentScreenshotsPath, resultsScreenshotsPath);
  }
};

const generateArtifacts = async (
  randomToken,
  urlScanned,
  scanType,
  viewport,
  pagesScanned,
  pagesNotScanned,
  customFlowLabel,
  cypressScanAboutMetadata,
  scanDetails,
  zip = undefined, // optional
  generateJsonFiles = false,
) => {
  const intermediateDatasetsPath = `${randomToken}/datasets/${randomToken}`;
  const phAppVersion = getVersion();
  const storagePath = getStoragePath(randomToken);

  urlScanned =
    scanType === ScannerTypes.SITEMAP || scanType === ScannerTypes.LOCALFILE
      ? urlScanned
      : urlWithoutAuth(urlScanned);

  const formatAboutStartTime = dateString => {
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

  const isCustomFlow = scanType === ScannerTypes.CUSTOM;

  const allIssues: AllIssues = {
    storagePath,
    oobeeAi: {
      htmlETL: oobeeAiHtmlETL,
      rules: oobeeAiRules,
    },
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
    phAppVersion,
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
    silentLogger.error(flattenIssuesError.stack);
  });

  flattenAndSortResults(allIssues, isCustomFlow);

  printMessage([
    'Scan Summary',
    '',
    `Must Fix: ${allIssues.items.mustFix.rules.length} ${Object.keys(allIssues.items.mustFix.rules).length === 1 ? 'issue' : 'issues'} / ${allIssues.items.mustFix.totalItems} ${allIssues.items.mustFix.totalItems === 1 ? 'occurrence' : 'occurrences'}`,
    `Good to Fix: ${allIssues.items.goodToFix.rules.length} ${Object.keys(allIssues.items.goodToFix.rules).length === 1 ? 'issue' : 'issues'} / ${allIssues.items.goodToFix.totalItems} ${allIssues.items.goodToFix.totalItems === 1 ? 'occurrence' : 'occurrences'}`,
    `Needs Review: ${allIssues.items.needsReview.rules.length} ${Object.keys(allIssues.items.needsReview.rules).length === 1 ? 'issue' : 'issues'} / ${allIssues.items.needsReview.totalItems} ${allIssues.items.needsReview.totalItems === 1 ? 'occurrence' : 'occurrences'}`,
    `Passed: ${allIssues.items.passed.totalItems} ${allIssues.items.passed.totalItems === 1 ? 'occurrence' : 'occurrences'}`,
  ]);

  // move screenshots folder to report folders
  moveElemScreenshots(randomToken, storagePath);
  if (isCustomFlow) {
    createScreenshotsFolder(randomToken);
  }

  allIssues.wcagPassPercentage = getWcagPassPercentage(allIssues.wcagViolations);
  consoleLogger.info(
    `advancedScanOptionsSummaryItems is ${allIssues.advancedScanOptionsSummaryItems}`,
  );

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
  const {
    scanDataJsonFilePath,
    scanDataBase64FilePath,
    scanItemsJsonFilePath,
    scanItemsBase64FilePath,
    scanItemsSummaryJsonFilePath,
    scanItemsSummaryBase64FilePath,
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
    resultsTooBig ? scanItemsSummaryBase64FilePath : scanItemsBase64FilePath,
  );

  if (!generateJsonFiles) {
    await cleanUpJsonFiles([
      scanDataJsonFilePath,
      scanDataBase64FilePath,
      scanItemsJsonFilePath,
      scanItemsBase64FilePath,
      scanItemsSummaryJsonFilePath,
      scanItemsSummaryBase64FilePath,
    ]);
  }

  await retryFunction(() => writeSummaryPdf(storagePath, pagesScanned.length), 1);

  // Take option if set
  if (typeof zip === 'string') {
    constants.cliZipFileName = zip;

    if (!zip.endsWith('.zip')) {
      constants.cliZipFileName += '.zip';
    }
  }

  await fs
    .ensureDir(storagePath)
    .then(() => {
      zipResults(constants.cliZipFileName, storagePath);
      const messageToDisplay = [
        `Report of this run is at ${constants.cliZipFileName}`,
        `Results directory is at ${storagePath}`,
      ];

      if (process.env.REPORT_BREAKDOWN === '1') {
        messageToDisplay.push(
          'Reports have been further broken down according to their respective impact level.',
        );
      }

      if (process.send && process.env.OOBEE_VERBOSE && process.env.REPORT_BREAKDOWN != '1') {
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
    })
    .catch(error => {
      printMessage([`Error in zipping results: ${error}`]);
    });

  return createRuleIdJson(allIssues);
};

export default generateArtifacts;
