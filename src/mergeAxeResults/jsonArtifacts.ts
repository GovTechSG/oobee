import fs from 'fs-extra';
import path from 'path';
import zlib from 'zlib';
import { Base64Encode } from 'base64-stream';
import { pipeline } from 'stream/promises';
import { a11yRuleShortDescriptionMap } from '../constants/constants.js';
import { consoleLogger } from '../logs.js';
import type { AllIssues } from './types.js';

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
                    .map(line => `          ${line}`)
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
  const readStream = fs.createReadStream(inputPath);
  const writeStream = fs.createWriteStream(outputPath);
  const gzip = zlib.createGzip();
  const base64Encode = new Base64Encode();

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

  ['mustFix', 'goodToFix', 'needsReview', 'passed'].forEach(category => {
    if (items[category].rules && Array.isArray(items[category].rules)) {
      items[category].rules.forEach(rule => {
        rule.pagesAffectedCount = Array.isArray(rule.pagesAffected) ? rule.pagesAffected.length : 0;
      });

      items[category].rules.sort(
        (a, b) => (b.pagesAffectedCount || 0) - (a.pagesAffectedCount || 0),
      );
    }
  });

  const scanIssuesSummary = {
    mustFix: items.mustFix.rules.map(({ pagesAffected, ...ruleInfo }) => ({
      ...ruleInfo,
      description: a11yRuleShortDescriptionMap[ruleInfo.rule] || ruleInfo.description,
    })),
    goodToFix: items.goodToFix.rules.map(({ pagesAffected, ...ruleInfo }) => ({
      ...ruleInfo,
      description: a11yRuleShortDescriptionMap[ruleInfo.rule] || ruleInfo.description,
    })),
    needsReview: items.needsReview.rules.map(({ pagesAffected, ...ruleInfo }) => ({
      ...ruleInfo,
      description: a11yRuleShortDescriptionMap[ruleInfo.rule] || ruleInfo.description,
    })),
    passed: items.passed.rules.map(({ pagesAffected, ...ruleInfo }) => ({
      ...ruleInfo,
      description: a11yRuleShortDescriptionMap[ruleInfo.rule] || ruleInfo.description,
    })),
  };

  const {
    jsonFilePath: scanIssuesSummaryJsonFilePath,
    base64FilePath: scanIssuesSummaryBase64FilePath,
  } = await writeJsonFileAndCompressedJsonFile(
    { oobeeAppVersion: allIssues.oobeeAppVersion, ...scanIssuesSummary },
    storagePath,
    'scanIssuesSummary',
  );

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
    topTenPagesWithMostIssues,
    wcagLinks,
    wcagPassPercentage,
    progressPercentage,
    issuesPercentage,
    totalPagesScanned,
    totalPagesNotScanned,
    topTenIssues,
  } = rest;

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

export { compressJsonFileStreaming, writeJsonAndBase64Files, writeJsonFileAndCompressedJsonFile };
