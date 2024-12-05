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
import { v4 as uuidv4 } from 'uuid';
import readline from 'readline';
import constants, { ScannerTypes } from './constants/constants.js';
import { urlWithoutAuth } from './constants/common.js';
import {
  createScreenshotsFolder,
  getStoragePath,
  getVersion,
  getWcagPassPercentage,
  formatDateTimeForMassScanner,
  retryFunction,
  zipResults,
} from './utils.js';
import { consoleLogger, silentLogger } from './logs.js';
import itemTypeDescription from './constants/itemTypeDescription.js';
import { oobeeAiHtmlETL, oobeeAiRules } from './constants/oobeeAi.js';

const cwd = process.cwd();

export type ItemsInfo = {
  html: string;
  message: string;
  screenshotPath: string;
  xpath: string;
  displayNeedsReview?: boolean;
};

type PageInfo = {
  items: ItemsInfo[];
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
  formatAboutStartTime: (dateString: any) => string;
  isCustomFlow: boolean;
  viewport: string;
  pagesScanned: PageInfo[];
  pagesNotScanned: PageInfo[];
  totalPagesScanned: number;
  totalPagesNotScanned: number;
  totalItems: number;
  topFiveMostIssues: Array<any>;
  wcagViolations: string[];
  customFlowLabel: string;
  phAppVersion: string;
  items: {
    mustFix: { description: string; totalItems: number; rules: RuleInfo[] };
    goodToFix: { description: string; totalItems: number; rules: RuleInfo[] };
    needsReview: { description: string; totalItems: number; rules: RuleInfo[] };
    passed: { description: string; totalItems: number; rules: RuleInfo[] };
  };
  cypressScanAboutMetadata: string;
  wcagLinks: { [key: string]: string };
  [key: string]: any;
};

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

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
  // seems to go into
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
        const howToFix = message.replace(/(\r\n|\n|\r)/g, ' '); // remove newlines
        const violation = html || formatPageViolation(page); // page is a number, not a string
        const context = violation.replace(/(\r\n|\n|\r)/g, ''); // remove newlines

        results.push({
          severity,
          issueId,
          issueDescription,
          wcagConformance,
          url,
          context,
          howToFix,
          axeImpact,
          xpath,
          learnMore,
        });
      });
    });
    if (results.length === 0) return {};
    return results;
  };
  const opts: ParserOptions<any, any> = {
    transforms: [getRulesByCategory, flattenRule],
    fields: [
      'severity',
      'issueId',
      'issueDescription',
      'wcagConformance',
      'url',
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

const writeHTML = async (allIssues, storagePath, htmlFilename = 'report') => {
  const inputFilePath = path.resolve(storagePath, 'scanDetails.csv');
  const outputFilePath = `${storagePath}/${htmlFilename}.html`;

  const prefixData = fs.readFileSync(path.join(cwd, 'report-partial-top.htm.txt'), 'utf-8');
  const suffixData = fs.readFileSync(path.join(cwd, 'report-partial-bottom.htm.txt'), 'utf-8');

  const outputStream = fs.createWriteStream(outputFilePath, { flags: 'a' });

  outputStream.write(prefixData);

  // Create a readable stream for the input file with a highWaterMark set to 10MB
  const BUFFER_LIMIT = 10 * 1024 * 1024; // 10 MB
  const inputStream = fs.createReadStream(inputFilePath, {
    encoding: 'utf-8',
    highWaterMark: BUFFER_LIMIT,
  });

  let isFirstLine = true;
  let lineEndingDetected = false;
  let isFirstField = true;
  let isWritingFirstDataLine = true;
  let buffer = '';

  function flushBuffer() {
    if (buffer.length > 0) {
      outputStream.write(buffer);
      buffer = '';
    }
  }

  inputStream.on('data', chunk => {
    let chunkIndex = 0;

    // Iterate through the chunk character by character
    while (chunkIndex < chunk.length) {
      const char = chunk[chunkIndex];

      if (isFirstLine) {
        // Detecting the line ending to move to the next line (Windows - \r\n, Linux/Mac - \n or \r)
        if (char === '\n' || char === '\r') {
          lineEndingDetected = true;
        } else if (lineEndingDetected) {
          if (char !== '\n' && char !== '\r') {
            isFirstLine = false; // Switch to the data reading mode after the first line is fully skipped

            // Write the prefix for the first field of the data line
            if (isWritingFirstDataLine) {
              buffer += "scanData = base64Decode('";
              isWritingFirstDataLine = false;
            }
            buffer += char;
          }
          lineEndingDetected = false; // Reset for next potential line ending detection
        }
      } else {
        // Processing the actual data (second line)
        if (char === ',') {
          // Close the current base64Decode for scanData and start for scanItems
          buffer += "')\n";
          buffer += "scanItems = base64Decode('";
          isFirstField = false;
        } else if (char === '\n' || char === '\r') {
          // Close the base64Decode for scanItems if we're at the end of the line
          if (!isFirstField) {
            buffer += "')\n";
          }
        } else {
          // Accumulate the character in the buffer
          buffer += char;
        }

        // Write buffer if it exceeds the limit
        if (buffer.length >= BUFFER_LIMIT) {
          flushBuffer();
        }
      }

      chunkIndex++;
    }
  });

  inputStream.on('end', () => {
    // Flush any remaining data in the buffer
    if (!isFirstField) {
      buffer += "')\n";
    }
    flushBuffer();

    // Append the suffix data after the input file content
    outputStream.write(suffixData);
    outputStream.end();
    console.log('Content appended successfully.');
  });

  inputStream.on('error', err => {
    console.error('Error reading input file:', err);
    outputStream.end();
  });

  outputStream.on('error', err => {
    console.error('Error writing to output file:', err);
  });
};

const writeSummaryHTML = async (allIssues, storagePath, htmlFilename = 'summary') => {
  const ejsString = fs.readFileSync(path.join(dirname, './static/ejs/summary.ejs'), 'utf-8');
  const template = ejs.compile(ejsString, {
    filename: path.join(dirname, './static/ejs/summary.ejs'),
  });
  const html = template(allIssues);
  fs.writeFileSync(`${storagePath}/${htmlFilename}.html`, html);
};

function writeFormattedValue(value, writeStream) {
  if (typeof value === 'function') {
    writeStream.write('null');
  } else if (value === undefined) {
    writeStream.write('null');
  } else if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    writeStream.write(JSON.stringify(value));
  } else if (value === null) {
    writeStream.write('null');
  }
}

function serializeObject(obj, writeStream, depth = 0, indent = '  ') {
  const currentIndent = indent.repeat(depth);
  const nextIndent = indent.repeat(depth + 1);

  if (obj instanceof Date) {
    writeStream.write(JSON.stringify(obj.toISOString()));
  } else if (Array.isArray(obj)) {
    writeStream.write('[\n');
    obj.forEach((item, index) => {
      if (index > 0) writeStream.write(',\n');
      writeStream.write(nextIndent);
      serializeObject(item, writeStream, depth + 1, indent);
    });
    writeStream.write(`\n${currentIndent}]`);
  } else if (typeof obj === 'object' && obj !== null) {
    writeStream.write('{\n');
    const keys = Object.keys(obj);
    keys.forEach((key, index) => {
      if (index > 0) writeStream.write(',\n');
      writeStream.write(`${nextIndent}${JSON.stringify(key)}: `);
      serializeObject(obj[key], writeStream, depth + 1, indent);
    });
    writeStream.write(`\n${currentIndent}}`);
  } else {
    writeFormattedValue(obj, writeStream);
  }
}

function writeLargeJsonToFile(obj, filePath) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

    writeStream.on('error', error => {
      console.error('Stream error:', error);
      reject(error);
    });

    writeStream.on('finish', () => {
      console.log('File written successfully:', filePath);
      resolve(true);
    });

    serializeObject(obj, writeStream);
    writeStream.end();
  });
}

const base64Encode = async (data, num) => {
  try {
    const tempFilename =
      num === 1
        ? `scanItems_${uuidv4()}.json`
        : num === 2
          ? `scanData_${uuidv4()}.json`
          : `${uuidv4()}.json`;
    const tempFilePath = path.join(process.cwd(), tempFilename);

    await writeLargeJsonToFile(data, tempFilePath);

    const outputFilename = `encoded_${uuidv4()}.txt`;
    const outputFilePath = path.join(process.cwd(), outputFilename);

    try {
      const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
      const readStream = fs.createReadStream(tempFilePath, {
        encoding: 'utf8',
        highWaterMark: CHUNK_SIZE,
      });
      const writeStream = fs.createWriteStream(outputFilePath, { encoding: 'utf8' });

      for await (const chunk of readStream) {
        const encodedChunk = Buffer.from(chunk).toString('base64');
        writeStream.write(`${encodedChunk}.`);
      }

      await new Promise((resolve, reject) => {
        writeStream.end(resolve);
        writeStream.on('error', reject);
      });

      return outputFilePath;
    } finally {
      await fs.promises
        .unlink(tempFilePath)
        .catch(err => console.error('Temp file delete error:', err));
    }
  } catch (error) {
    console.error('Error encoding data to Base64:', error);
    throw error;
  }
};

const streamEncodedDataToFile = async (inputFilePath, writeStream, appendComma) => {
  const readStream = fs.createReadStream(inputFilePath, { encoding: 'utf8' });
  let isFirstChunk = true;

  for await (const chunk of readStream) {
    if (isFirstChunk) {
      isFirstChunk = false;
      writeStream.write(chunk); // Write the first chunk directly
    } else {
      writeStream.write(chunk); // Write subsequent chunks
    }
  }

  // Append a comma after streaming the entire file if needed
  if (appendComma) {
    writeStream.write(','); // No new line, just a comma
  }
};

const writeBase64 = async (allIssues, storagePath, htmlFilename = 'report.html') => {
  const { items, ...rest } = allIssues;
  const encodedScanItemsPath = await base64Encode(items, 1);
  const encodedScanDataPath = await base64Encode(rest, 2);

  const filePath = path.join(storagePath, 'scanDetails.csv');
  const directoryPath = path.dirname(filePath);

  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }

  const csvWriteStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

  csvWriteStream.write('scanData_base64,scanItems_base64\n'); // Write the header
  await streamEncodedDataToFile(encodedScanDataPath, csvWriteStream, true); // Append scanData chunks
  await streamEncodedDataToFile(encodedScanItemsPath, csvWriteStream, false); // Append scanItems chunks

  await new Promise((resolve, reject) => {
    csvWriteStream.end(resolve);
    csvWriteStream.on('error', reject);
  });

  // const htmlFilePath = path.join(storagePath, htmlFilename);
  // let htmlContent = await fs.promises.readFile(htmlFilePath, { encoding: 'utf8' });

  // const headIndex = htmlContent.indexOf('</head>');
  // const injectScript = `
  // <script>
  //   try {
  //     // Function to decode Base64
  //     const base64Decode = (data) => {
  //       const encodedChunks = data.split('.');
  //       const jsonString = encodedChunks
  //         .map(chunk => atob(chunk))
  //         .join('');
  //       return JSON.parse(jsonString);
  //     };

  //     const loadBase64Data = async () => {
  //       const response = await fetch('${encodedScanDataPath}');
  //       const scanDataChunks = await response.text();
  //       const scanData = base64Decode(scanDataChunks);

  //       const response2 = await fetch('${encodedScanItemsPath}');
  //       const scanItemsChunks = await response2.text();
  //       const scanItems = base64Decode(scanItemsChunks);

  //       console.log('Decoded scanData:', scanData);
  //       console.log('Decoded scanItems:', scanItems);
  //     };

  //     loadBase64Data();
  //   } catch (error) {
  //     console.error("Error decoding base64 data:", error);
  //   }
  // </script>
  // `;

  // if (headIndex !== -1) {
  //   htmlContent = htmlContent.slice(0, headIndex) + injectScript + htmlContent.slice(headIndex);
  // } else {
  //   htmlContent += injectScript;
  // }

  // await fs.promises.writeFile(htmlFilePath, htmlContent);

  await fs.promises
    .unlink(encodedScanDataPath)
    .catch(err => console.error('Encoded file delete error:', err));
  await fs.promises
    .unlink(encodedScanItemsPath)
    .catch(err => console.error('Encoded file delete error:', err));
};

let browserChannel = 'chrome';

if (os.platform() === 'win32') {
  browserChannel = 'msedge';
}

if (os.platform() === 'linux') {
  browserChannel = 'chromium';
}

const writeSummaryPdf = async (storagePath, filename = 'summary') => {
  const htmlFilePath = `${storagePath}/${filename}.html`;
  const fileDestinationPath = `${storagePath}/${filename}.pdf`;
  const browser = await chromium.launch({
    headless: true,
    channel: browserChannel,
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

  fs.unlinkSync(htmlFilePath);
};

const pushResults = async (pageResults, allIssues, isCustomFlow) => {
  const { url, pageTitle, filePath } = pageResults;

  // console.log('pageResults 111', pageResults);
  // console.log('allIssues 111', allIssues);

  const totalIssuesInPage = new Set();
  Object.keys(pageResults.mustFix.rules).forEach(k => totalIssuesInPage.add(k));
  Object.keys(pageResults.goodToFix.rules).forEach(k => totalIssuesInPage.add(k));
  Object.keys(pageResults.needsReview.rules).forEach(k => totalIssuesInPage.add(k));

  allIssues.topFiveMostIssues.push({ url, pageTitle, totalIssues: totalIssuesInPage.size });

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

const flattenAndSortResults = (allIssues: AllIssues, isCustomFlow: boolean) => {
  ['mustFix', 'goodToFix', 'needsReview', 'passed'].forEach(category => {
    allIssues.totalItems += allIssues.items[category].totalItems;
    allIssues.items[category].rules = Object.entries(allIssues.items[category].rules)
      .map(ruleEntry => {
        const [rule, ruleInfo] = ruleEntry as [string, RuleInfo];
        ruleInfo.pagesAffected = Object.entries(ruleInfo.pagesAffected)
          .map(pageEntry => {
            if (isCustomFlow) {
              const [pageIndex, pageInfo] = pageEntry as unknown as [number, PageInfo];
              return { pageIndex, ...pageInfo };
            }
            const [url, pageInfo] = pageEntry as unknown as [string, PageInfo];
            return { url, ...pageInfo };
          })
          .sort((page1, page2) => page2.items.length - page1.items.length);
        return { rule, ...ruleInfo };
      })
      .sort((rule1, rule2) => rule2.totalItems - rule1.totalItems);
  });
  allIssues.topFiveMostIssues.sort((page1, page2) => page2.totalIssues - page1.totalIssues);
  allIssues.topFiveMostIssues = allIssues.topFiveMostIssues.slice(0, 5);
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
    formatAboutStartTime,
    isCustomFlow,
    viewport,
    pagesScanned,
    pagesNotScanned,
    totalPagesScanned: pagesScanned.length,
    totalPagesNotScanned: pagesNotScanned.length,
    totalItems: 0,
    topFiveMostIssues: [],
    wcagViolations: [],
    customFlowLabel,
    phAppVersion,
    items: {
      mustFix: { description: itemTypeDescription.mustFix, totalItems: 0, rules: [] },
      goodToFix: { description: itemTypeDescription.goodToFix, totalItems: 0, rules: [] },
      needsReview: { description: itemTypeDescription.needsReview, totalItems: 0, rules: [] },
      passed: { description: itemTypeDescription.passed, totalItems: 0, rules: [] },
    },
    cypressScanAboutMetadata,
    wcagLinks: constants.wcagLinks,
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

  // console.log('allIssues 111', allIssues);

  console.log('process.env.OOBEE_VERBOSE 111', process.env.OOBEE_VERBOSE);

  if (process.env.OOBEE_VERBOSE) {
    const axeImpactCount = getAxeImpactCount(allIssues);

    const scanData = {
      url: allIssues.urlScanned,
      startTime: formatDateTimeForMassScanner(allIssues.startTime),
      endTime: formatDateTimeForMassScanner(allIssues.endTime),
      pagesScanned: allIssues.pagesScanned.length,
      wcagPassPercentage: allIssues.wcagPassPercentage,
      critical: axeImpactCount.critical,
      serious: axeImpactCount.serious,
      moderate: axeImpactCount.moderate,
      minor: axeImpactCount.minor,
      mustFix: {
        issues: allIssues.items.mustFix.rules.length,
        occurrence: allIssues.items.mustFix.totalItems,
        rules: allIssues.items.mustFix.rules,
      },
      goodToFix: {
        issues: allIssues.items.goodToFix.rules.length,
        occurrence: allIssues.items.goodToFix.totalItems,
        rules: allIssues.items.goodToFix.rules,
      },
      needsReview: {
        issues: allIssues.items.needsReview.rules.length,
        occurrence: allIssues.items.needsReview.totalItems,
        rules: allIssues.items.needsReview.rules,
      },
      passed: {
        occurrence: allIssues.items.passed.totalItems,
      },
    };

    const { items, startTime, endTime, ...rest } = allIssues;
    const encodedScanItems = await base64Encode(items, 1);
    const formattedStartTime = formatDateTimeForMassScanner(startTime);
    const formattedEndTime = formatDateTimeForMassScanner(endTime);
    rest.critical = axeImpactCount.critical;
    rest.serious = axeImpactCount.serious;
    rest.moderate = axeImpactCount.moderate;
    rest.minor = axeImpactCount.minor;
    // rest.startTime = startTime;
    // rest.endTime = endTime;

    // Adding encoded start time and end time to rest object
    // console.log('formattedStartTime 111', formattedStartTime);
    rest.formattedStartTime = formattedStartTime;
    rest.formattedEndTime = formattedEndTime;

    const encodedScanData = await base64Encode(rest, 2);

    console.log('typeof 111 encodedScanData', typeof encodedScanData);

    // const largeData = await fs.readFile('largeDataWithBase64.json', { encoding: 'utf8' });
    // console.log('largeData 111', JSON.stringify(largeData));

    const scanDetailsMessageModified = `{
      "type": "scanDetailsMessage",
      "payload": { "scanData": "${encodedScanData}", "scanItems": "${encodedScanItems}" }
    }`;

    // const scanDetailsMessage = {
    //   type: 'scanDetailsMessage',
    //   payload: { scanData: encodedScanData, scanItems: encodedScanItems },
    // };

    // console.log('result 111', scanDetailsMessageModified === JSON.stringify(scanDetailsMessage));
    // console.log('result 222', scanDetailsMessageModified);
    // console.log('result 333', JSON.stringify(scanDetailsMessage));

    // console.log('before process.send', scanDetailsMessage);
    // if (process.send) {
    //   // console.log('what happened here? 111', JSON.stringify(scanDetailsMessage));
    //   process.send(scanDetailsMessageModified);
    // }
  }

  await writeCsv(allIssues, storagePath);
  await writeBase64(allIssues, storagePath);
  await writeSummaryHTML(allIssues, storagePath);
  await writeHTML(allIssues, storagePath);
  await retryFunction(() => writeSummaryPdf(storagePath), 1);

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
        console.log('what happened here? 222');
        const zipFileNameMessage = {
          type: 'zipFileName',
          payload: `${constants.cliZipFileName}`,
        };
        const storagePathMessage = {
          type: 'storagePath',
          payload: `${storagePath}`,
        };

        // console.log('zipFileNameMessage 111', storagePathMessage);
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
