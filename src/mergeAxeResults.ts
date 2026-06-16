/* eslint-disable consistent-return */
/* eslint-disable no-console */
import fs, { ensureDirSync } from 'fs-extra';
import printMessage from 'print-message';
import path from 'path';
import ejs from 'ejs';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { Dataset, RequestQueue, Configuration } from 'crawlee';
import constants, {
  BrowserTypes,
  ScannerTypes,
  WCAGclauses,
  a11yRuleShortDescriptionMap,
  disabilityBadgesMap,
  a11yRuleLongDescriptionMap,
  a11yRuleStepByStepGuide,
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
  register,
} from './utils.js';
import { consoleLogger } from './logs.js';
import itemTypeDescription from './constants/itemTypeDescription.js';
import { oobeeAiHtmlETL, oobeeAiRules } from './constants/oobeeAi.js';
import { buildHtmlGroups, convertItemsToReferences } from './mergeAxeResults/itemReferences.js';
import { ItemsStore } from './mergeAxeResults/itemsStore.js';
import {
  compressJsonFileStreaming,
  writeJsonAndBase64Files,
  writeJsonFileAndCompressedJsonFile,
} from './mergeAxeResults/jsonArtifacts.js';
import writeCsv from './mergeAxeResults/writeCsv.js';
import writeScanDetailsCsv from './mergeAxeResults/writeScanDetailsCsv.js';
import writeSitemap from './mergeAxeResults/writeSitemap.js';
import populateScanPagesDetail from './mergeAxeResults/scanPages.js';
import sendWcagBreakdownToSentry from './mergeAxeResults/sentryTelemetry.js';
import type { AllIssues, PageInfo, RuleInfo } from './mergeAxeResults/types.js';

export type {
  AllIssues,
  HtmlGroupItem,
  HtmlGroups,
  ItemsInfo,
  PageInfo,
  RuleInfo,
} from './mergeAxeResults/types.js';

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
const parseContentToJson = async (rPath: string) => {
  try {
    const content = await fs.readFile(rPath, 'utf8');
    return JSON.parse(content);
  } catch (parseError: any) {
    // Try to extract JSON.parse byte position from error message: "Unexpected token ... in JSON at position 123"
    let position: number | null = null;
    const msg = String(parseError?.message || '');
    const match = msg.match(/position\s+(\d+)/i);
    if (match) position = Number(match[1]);

    let contextSnippet = '';
    if (position !== null) {
      try {
        const raw = await fs.readFile(rPath, 'utf8');
        const start = Math.max(0, position - 80);
        const end = Math.min(raw.length, position + 80);
        contextSnippet = raw.slice(start, end).replace(/\n/g, '\\n');
      } catch {
        // ignore secondary read failures
      }
    }

    consoleLogger.error(`[parseContentToJson] Failed to parse file: ${rPath}`);
    consoleLogger.error(
      `[parseContentToJson] ${parseError?.name || 'Error'}: ${parseError?.message || parseError}`,
    );
    if (position !== null) {
      consoleLogger.error(`[parseContentToJson] JSON parse position: ${position}`);
    }
    if (contextSnippet) {
      consoleLogger.error(`[parseContentToJson] Context around error: ${contextSnippet}`);
    }

    // Keep current flow: return undefined so pipeline can continue.
    return undefined;
  }
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

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk

const writeHTML = async (
  allIssues: AllIssues,
  storagePath: string,
  htmlFilename = 'report',
  scanDetailsFilePath: string,
  scanItemsFilePath: string,
): Promise<void> => {
  const htmlFilePath = await compileHtmlWithEJS(allIssues, storagePath, htmlFilename);
  const { topFilePath, bottomFilePath } = await splitHtmlAndCreateFiles(htmlFilePath, storagePath);
  const prefixData = fs.readFileSync(path.join(storagePath, 'report-partial-top.htm.txt'), 'utf-8');
  const suffixData = fs.readFileSync(
    path.join(storagePath, 'report-partial-bottom.htm.txt'),
    'utf-8',
  );

  // Create the lighter scanItems payload for embedding in the HTML report.
  const lightScanItemsPayload = convertItemsToReferences(allIssues);

  // Write the lighter items to a file and get the base64 path
  const {
    jsonFilePath: lightScanItemsPayloadJsonFilePath,
    base64FilePath: lightScanItemsPayloadBase64FilePath,
  } = await writeJsonFileAndCompressedJsonFile(
    lightScanItemsPayload,
    storagePath,
    'scanItems-light',
  );

  return new Promise<void>((resolve, reject) => {
    const scanDetailsReadStream = fs.createReadStream(scanDetailsFilePath, {
      encoding: 'utf8',
      highWaterMark: BUFFER_LIMIT,
    });

    const outputFilePath = `${storagePath}/${htmlFilename}.html`;
    const outputStream = fs.createWriteStream(outputFilePath, { flags: 'a' });

    const cleanupFiles = async () => {
      try {
        await Promise.all([
          fs.promises.unlink(topFilePath),
          fs.promises.unlink(bottomFilePath),
          fs.promises.unlink(lightScanItemsPayloadBase64FilePath),
          fs.promises.unlink(lightScanItemsPayloadJsonFilePath),
        ]);
      } catch (err) {
        console.error('Error cleaning up temporary files:', err);
      }
    };

    outputStream.write(prefixData);

    // For Proxied AI environments only
    outputStream.write(`let proxyUrl = "${process.env.PROXY_API_BASE_URL || ''}"\n`);

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

  var scanData = null;
  var scanItems = null;
  \n`);

    outputStream.write('</script>\n<script type="text/plain" id="scanDataRaw">');
    scanDetailsReadStream.pipe(outputStream, { end: false });

    scanDetailsReadStream.on('end', async () => {
      outputStream.write('</script>\n<script>\n');
      outputStream.write(
        "var scanDataPromise = (async () => { console.log('Loading scanData...'); scanData = await decodeUnzipParse(document.getElementById('scanDataRaw').textContent); console.log('[report] scanData loaded'); })();\n",
      );
      outputStream.write('</script>\n');

      // Write scanItems in 2MB chunks using a stream to avoid loading entire file into memory
      try {
        let chunkIndex = 1;
        const scanItemsStream = fs.createReadStream(lightScanItemsPayloadBase64FilePath, {
          encoding: 'utf8',
          highWaterMark: CHUNK_SIZE,
        });

        for await (const chunk of scanItemsStream) {
          const ok = outputStream.write(
            `<script type="text/plain" id="scanItemsRaw${chunkIndex}">${chunk}</script>\n`,
          );
          if (!ok) {
            await new Promise<void>(resolve => outputStream.once('drain', resolve));
          }
          chunkIndex++;
        }

        outputStream.write('<script>\n');
        outputStream.write(`
var scanItemsPromise = (async () => {
  console.log('Loading scanItems...');
  const chunks = [];
  let i = 1;
  while (true) {
    const el = document.getElementById('scanItemsRaw' + i);
    if (!el) break;
    chunks.push(el.textContent);
    i++;
  }
  scanItems = await decodeUnzipParse(chunks);
  console.log('[report] scanItems loaded');
})();\n`);
        outputStream.write(suffixData);
        outputStream.end();
      } catch (err) {
        console.error('Error writing chunked scanItems:', err);
        outputStream.destroy(err as Error);
        reject(err);
      }
    });

    scanDetailsReadStream.on('error', err => {
      console.error('Read stream error:', err);
      outputStream.destroy(err);
      reject(err);
    });

    // Resolve only when output stream fully finishes — this is what makes
    // `await writeHTML(...)` in generateArtifacts wait before cleanUpJsonFiles runs
    outputStream.on('finish', async () => {
      consoleLogger.info('Content appended successfully.');
      await cleanupFiles();
      resolve();
    });

    outputStream.on('error', err => {
      consoleLogger.error('Error writing to output file:', err);
      reject(err);
    });
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

const writeSummaryPdf = async (
  storagePath: string,
  pagesScanned: number,
  filename = 'summary',
  browser: string,
  _userDataDirectory: string,
) => {
  const renderPdfWithBrowser = async (browserToUse: string) => {
    let browserInstance;
    let context;
    let page;

    try {
      const htmlFilePath = path.join(storagePath, `${filename}.html`);
      const fileDestinationPath = path.join(storagePath, `${filename}.pdf`);
      const htmlFileUrl = `file://${htmlFilePath}`;

      const launchOptions = getPlaywrightLaunchOptions(browserToUse);

      browserInstance = await constants.launcher.launch({
        ...launchOptions,
        headless: true,
      });

      register(browserInstance as unknown as { close: () => Promise<void> });

      context = await browserInstance.newContext();
      page = await context.newPage();

      await page.goto(htmlFileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
      });

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

      fs.unlinkSync(htmlFilePath);
    } finally {
      try {
        await page?.close();
      } catch (err) {
        consoleLogger.info(`Error at page close writeSummaryPDF ${err}`);
      }
      try {
        await context?.close();
      } catch (err) {
        consoleLogger.info(`Error at context close writeSummaryPDF ${err}`);
      }
      try {
        await browserInstance?.close();
      } catch (err) {
        consoleLogger.info(`Error at browserInstance close writeSummaryPDF ${err}`);
      }
    }
  };

  const browserAttempts = [browser];

  // Runtime fallback: if Chrome launch fails on Windows, try Edge once for PDF generation.
  if (process.platform === 'win32' && browser === BrowserTypes.CHROME) {
    browserAttempts.push(BrowserTypes.EDGE);
  }

  for (let i = 0; i < browserAttempts.length; i++) {
    const currentBrowser = browserAttempts[i];
    try {
      await renderPdfWithBrowser(currentBrowser);
      if (i > 0) {
        consoleLogger.warn(
          `writeSummaryPDF succeeded with fallback browser '${currentBrowser}' after '${browser}' failed.`,
        );
      }
      return;
    } catch (err) {
      const isLastAttempt = i === browserAttempts.length - 1;
      consoleLogger.info(
        `Error at writeSummaryPDF using browser '${currentBrowser}': ${err instanceof Error ? err.stack : err}`,
      );
      if (isLastAttempt) {
        return;
      }
      const nextBrowser = browserAttempts[i + 1];
      consoleLogger.warn(
        `writeSummaryPDF failed using browser '${currentBrowser}', retrying with '${nextBrowser}'.`,
      );
    }
  }
};

// Tracking WCAG occurrences
const wcagOccurrencesMap = new Map<string, number>();

const pushResults = async (pageResults, allIssues, isCustomFlow, itemsStore: ItemsStore) => {
  const { url, pageTitle, filePath } = pageResults;

  const totalIssuesInPage = new Set();
  Object.keys(pageResults.mustFix?.rules ?? {}).forEach(k => totalIssuesInPage.add(k));
  Object.keys(pageResults.goodToFix?.rules ?? {}).forEach(k => totalIssuesInPage.add(k));
  Object.keys(pageResults.needsReview?.rules ?? {}).forEach(k => totalIssuesInPage.add(k));

  allIssues.topFiveMostIssues.push({
    url,
    pageTitle,
    totalIssues: totalIssuesInPage.size,
    totalOccurrences: 0,
  });

  for (const category of ['mustFix', 'goodToFix', 'needsReview', 'passed'] as const) {
    if (!pageResults[category]) continue;

    const { totalItems, rules } = pageResults[category];
    const currCategoryFromAllIssues = allIssues.items[category];

    currCategoryFromAllIssues.totalItems += totalItems;

    for (const rule of Object.keys(rules)) {
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
          itemsCount: items.length,
        };
        await itemsStore.appendPageItems(category, rule, {
          url,
          pageTitle,
          items,
          pageIndex,
          pageImagePath,
          metadata,
        });
      } else if (!(url in currRuleFromAllIssues.pagesAffected)) {
        currRuleFromAllIssues.pagesAffected[url] = {
          pageTitle,
          itemsCount: items.length,
          ...(filePath && { filePath }),
        };
        await itemsStore.appendPageItems(category, rule, {
          url,
          pageTitle,
          items,
          ...(filePath && { filePath }),
        });
      }
    }
  }
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
        // Replace description with new Oobee short description if available
        description: a11yRuleShortDescriptionMap[rule.rule] || rule.description,
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
              if (category !== 'passed') {
                urlOccurrencesMap.set(
                  pageInfo.url!,
                  (urlOccurrencesMap.get(pageInfo.url!) || 0) + (pageInfo.itemsCount || 0),
                );
              }
              return { pageIndex, ...pageInfo };
            }
            const [url, pageInfo] = pageEntry as unknown as [string, PageInfo];
            if (category !== 'passed') {
              urlOccurrencesMap.set(
                url,
                (urlOccurrencesMap.get(url) || 0) + (pageInfo.itemsCount || 0),
              );
            }
            return { url, ...pageInfo };
          })
          .sort((page1, page2) => (page2.itemsCount || 0) - (page1.itemsCount || 0));
        return { rule, ...ruleInfo };
      })
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

const extractRuleAiData = (
  ruleId: string,
  totalItems: number,
  items: any[],
  callback?: () => void,
) => {
  let snippets = [];

  if (oobeeAiRules.includes(ruleId)) {
    const snippetsSet = new Set();
    if (items) {
      items.forEach(item => {
        snippetsSet.add(oobeeAiHtmlETL(item.html));
      });
    }
    snippets = [...snippetsSet];
    if (callback) callback();
  }
  return {
    snippets,
    occurrences: totalItems,
  };
};

// This is for telemetry purposes called within mergeAxeResults.ts
export const createRuleIdJson = async (allIssues, itemsStore?: ItemsStore) => {
  const compiledRuleJson = {};

  for (const category of ['mustFix', 'goodToFix', 'needsReview'] as const) {
    compiledRuleJson[category] = {};

    for (const rule of allIssues.items[category].rules) {
      let allItems: any[] = [];

      if (itemsStore) {
        for await (const entry of itemsStore.readRuleItems(category, rule.rule)) {
          allItems.push(...entry.items);
        }
      } else {
        allItems = rule.pagesAffected.flatMap(page => page.items || []);
      }

      const ruleData = extractRuleAiData(rule.rule, rule.totalItems, allItems);

      // Stable hashes of html+xpath groups for tracking remediation across scans in Sentry
      const htmlGroupHashes: string[] = [];
      if (rule.htmlGroups) {
        for (const key of Object.keys(rule.htmlGroups)) {
          htmlGroupHashes.push(createHash('sha256').update(key).digest('hex').slice(0, 12));
        }
      }

      compiledRuleJson[category][rule.rule] = { ...ruleData, htmlGroupHashes, htmlGroupHashesCount: htmlGroupHashes.length };
    }
  }

  return compiledRuleJson;
};

// This is for telemetry purposes called from npmIndex (scanPage and scanHTML) where report is not generated
export const createBasicFormHTMLSnippet = filteredResults => {
  const compiledRuleJson = {};

  ['mustFix', 'goodToFix', 'needsReview'].forEach(category => {
    compiledRuleJson[category] = {};

    if (filteredResults[category] && filteredResults[category].rules) {
      Object.entries(filteredResults[category].rules).forEach(
        ([ruleId, ruleVal]: [string, any]) => {
          const ruleData = extractRuleAiData(ruleId, ruleVal.totalItems, ruleVal.items);

          // Stable hashes of html+xpath groups for tracking remediation across scans in Sentry
          const htmlGroupSet = new Set<string>();
          if (ruleVal.items) {
            ruleVal.items.forEach((item: any) => {
              const key = `${item.html || 'No HTML element'}\x00${item.xpath || ''}`;
              htmlGroupSet.add(createHash('sha256').update(key).digest('hex').slice(0, 12));
            });
          }

          const htmlGroupHashes = [...htmlGroupSet];
          compiledRuleJson[category][ruleId] = { ...ruleData, htmlGroupHashes, htmlGroupHashesCount: htmlGroupHashes.length };
        },
      );
    }
  });

  return compiledRuleJson;
};

const moveElemScreenshots = (randomToken: string, storagePath: string) => {
  const currentScreenshotsPath = `${randomToken}/elemScreenshots`;
  const resultsScreenshotsPath = `${storagePath}/elemScreenshots`;
  if (fs.existsSync(currentScreenshotsPath)) {
    fs.moveSync(currentScreenshotsPath, resultsScreenshotsPath);
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
  preferredBrowser?: string,
) => {
  consoleLogger.info('Generating report artifacts');

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
    totalLinksFetchedFromSitemaps: constants.sitemapFetchedLinks?.totalLinksFetchedFromSitemaps ?? 0,
    fetchedSitemaps: constants.sitemapFetchedLinks?.fetchedSitemaps ?? [],
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
    a11yRuleStepByStepGuide,
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
  const itemsStore = new ItemsStore(storagePath);

  for (const file of allFiles) {
    try {
      const pageResults = await parseContentToJson(`${intermediateDatasetsPath}/${file}`);
      if (pageResults) {
        await pushResults(pageResults, allIssues, isCustomFlow, itemsStore);
      }
    } catch (flattenIssuesError: any) {
      consoleLogger.error(
        `[generateArtifacts] Error processing ${file}: ${flattenIssuesError?.stack || flattenIssuesError}`,
      );
    }
  }

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

  // Build htmlGroups in a second pass from disk-backed items
  for (const category of ['mustFix', 'goodToFix', 'needsReview', 'passed'] as const) {
    for (const rule of allIssues.items[category].rules) {
      for await (const entry of itemsStore.readRuleItems(category, rule.rule)) {
        buildHtmlGroups(rule, entry.items, entry.url);
      }
    }
  }

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

  await writeCsv(allIssues, storagePath, itemsStore);
  await writeSitemap(pagesScanned, storagePath);
  const {
    scanDataJsonFilePath,
    scanDataBase64FilePath,
    scanItemsJsonFilePath,
    scanItemsBase64FilePath,
    scanItemsSummaryJsonFilePath,
    scanItemsSummaryBase64FilePath,
    scanIssuesSummaryJsonFilePath,
    scanIssuesSummaryBase64FilePath,
    scanPagesDetailJsonFilePath,
    scanPagesDetailBase64FilePath,
    scanPagesSummaryJsonFilePath,
    scanPagesSummaryBase64FilePath,
    scanDataJsonFileSize,
    scanItemsJsonFileSize,
  } = await writeJsonAndBase64Files(allIssues, storagePath, itemsStore);
  // Removed BIG_RESULTS_THRESHOLD check - always use full scanItems

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
    scanItemsBase64FilePath,
  );

  if (!generateJsonFiles) {
    await cleanUpJsonFiles([
      scanDataJsonFilePath,
      scanDataBase64FilePath,
      scanItemsJsonFilePath,
      scanItemsBase64FilePath,
      scanItemsSummaryJsonFilePath,
      scanItemsSummaryBase64FilePath,
      scanIssuesSummaryJsonFilePath,
      scanIssuesSummaryBase64FilePath,
      scanPagesDetailJsonFilePath,
      scanPagesDetailBase64FilePath,
      scanPagesSummaryJsonFilePath,
      scanPagesSummaryBase64FilePath,
    ]);
  }

  const browserChannel = getBrowserToRun(
    randomToken,
    (preferredBrowser as BrowserTypes) || BrowserTypes.CHROME,
    false,
  ).browserToRun;

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

  // Flush pending background storage operations (metadata writes, lock-file ops)
  const storageClient = Configuration.getStorageClient();
  if (storageClient.teardown) {
    await storageClient.teardown();
  }

  // Gracefully drop Dataset and RequestQueue — releases locks and removes files
  const crawleeDir = path.join(storagePath, 'crawlee');
  try {
    const dataset = await Dataset.open(crawleeDir);
    await dataset.drop();
  } catch (error) {
    consoleLogger.info(`Dataset drop: ${error.message}`);
  }

  try {
    const requestQueue = await RequestQueue.open(crawleeDir);
    await requestQueue.drop();
  } catch (error) {
    consoleLogger.info(`RequestQueue drop: ${error.message}`);
  }

  // Fallback rm for any leftover files not managed by Crawlee's storage API
  const crawleePath = path.join(storagePath, 'crawlee');
  try {
    await fs.promises.rm(crawleePath, { recursive: true, force: true });
  } catch {
    // Best-effort; storage was already dropped via API
  }

  try {
    await fs.promises.rm(path.join(storagePath, 'pdfs'), { recursive: true, force: true });
  } catch (error) {
    consoleLogger.warn(`Unable to force remove pdfs folder: ${error.message}`);
  }

  // Generate scrubbed HTML Code Snippets
  const ruleIdJson = await createRuleIdJson(allIssues, itemsStore);

  // Clean up intermediate items files before zipping
  await itemsStore.cleanup();

  try {
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

  if (process.env.RUNNING_FROM_PH_GUI || process.env.OOBEE_VERBOSE)
    console.log('Report generated successfully');

  return ruleIdJson;
};

export {
  writeHTML,
  compressJsonFileStreaming,
  convertItemsToReferences,
  flattenAndSortResults,
  populateScanPagesDetail,
  sendWcagBreakdownToSentry,
  getWcagPassPercentage,
  getProgressPercentage,
  getIssuesPercentage,
  itemTypeDescription,
  oobeeAiHtmlETL,
  oobeeAiRules,
  formatAboutStartTime,
};

export default generateArtifacts;
