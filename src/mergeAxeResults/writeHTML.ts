import fs from 'fs-extra';
import path from 'path';
import ejs from 'ejs';
import { fileURLToPath } from 'url';
import { consoleLogger } from '../logs.js';
import { convertItemsToReferences } from './itemReferences.js';
import { writeJsonFileAndCompressedJsonFile } from './jsonArtifacts.js';
import type { AllIssues } from './types.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const BUFFER_LIMIT = 100 * 1024 * 1024; // 100MB size
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk

const compileHtmlWithEJS = async (
  allIssues: AllIssues,
  storagePath: string,
  htmlFilename = 'report',
) => {
  const htmlFilePath = `${path.join(storagePath, htmlFilename)}.html`;
  const reportTemplatePath = path.join(dirname, '../static/ejs/report.ejs');
  const ejsString = fs.readFileSync(reportTemplatePath, 'utf-8');
  const template = ejs.compile(ejsString, {
    filename: reportTemplatePath,
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

const splitHtmlAndCreateFiles = async (htmlFilePath: string, storagePath: string) => {
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
    // eslint-disable-next-line no-console
    console.error('Error splitting HTML and creating files:', error);
    throw error;
  }
};

const writeHTML = async (
  allIssues: AllIssues,
  storagePath: string,
  htmlFilename = 'report',
  scanDetailsFilePath: string,
  _scanItemsFilePath?: string,
): Promise<void> => {
  const htmlFilePath = await compileHtmlWithEJS(allIssues, storagePath, htmlFilename);
  const { topFilePath, bottomFilePath } = await splitHtmlAndCreateFiles(htmlFilePath, storagePath);
  const prefixData = fs.readFileSync(path.join(storagePath, 'report-partial-top.htm.txt'), 'utf-8');
  const suffixData = fs.readFileSync(
    path.join(storagePath, 'report-partial-bottom.htm.txt'),
    'utf-8',
  );

  const scanItemsWithHtmlGroupRefs = convertItemsToReferences(allIssues);

  const {
    jsonFilePath: scanItemsWithHtmlGroupRefsJsonFilePath,
    base64FilePath: scanItemsWithHtmlGroupRefsBase64FilePath,
  } = await writeJsonFileAndCompressedJsonFile(
    scanItemsWithHtmlGroupRefs.items,
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
          fs.promises.unlink(scanItemsWithHtmlGroupRefsBase64FilePath),
          fs.promises.unlink(scanItemsWithHtmlGroupRefsJsonFilePath),
        ]);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Error cleaning up temporary files:', err);
      }
    };

    outputStream.write(prefixData);
    outputStream.write(`let proxyUrl = "${process.env.PROXY_API_BASE_URL || ''}"\n`);
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
  \n`);

    outputStream.write('</script>\n<script type="text/plain" id="scanDataRaw">');
    scanDetailsReadStream.pipe(outputStream, { end: false });

    scanDetailsReadStream.on('end', async () => {
      outputStream.write('</script>\n<script>\n');
      outputStream.write(
        "var scanDataPromise = (async () => { console.log('Loading scanData...'); scanData = await decodeUnzipParse(document.getElementById('scanDataRaw').textContent); })();\n",
      );
      outputStream.write('</script>\n');

      try {
        let chunkIndex = 1;
        const scanItemsStream = fs.createReadStream(scanItemsWithHtmlGroupRefsBase64FilePath, {
          encoding: 'utf8',
          highWaterMark: CHUNK_SIZE,
        });

        for await (const chunk of scanItemsStream) {
          outputStream.write(
            `<script type="text/plain" id="scanItemsRaw${chunkIndex}">${chunk}</script>\n`,
          );
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
})();\n`);
        outputStream.write(suffixData);
        outputStream.end();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Error writing chunked scanItems:', err);
        outputStream.destroy(err as Error);
        reject(err);
      }
    });

    scanDetailsReadStream.on('error', err => {
      // eslint-disable-next-line no-console
      console.error('Read stream error:', err);
      outputStream.destroy(err);
      reject(err);
    });

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

export default writeHTML;
