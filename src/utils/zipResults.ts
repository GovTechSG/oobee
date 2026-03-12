import path from 'path';
import fs from 'fs-extra';
import JSZip from 'jszip';
import { createReadStream, createWriteStream } from 'fs';

const zipResults = async (zipName: string, resultsPath: string): Promise<void> => {
  // Resolve and validate the output path
  const zipFilePath = path.isAbsolute(zipName) ? zipName : path.join(resultsPath, zipName);

  // Ensure parent dir exists
  fs.mkdirSync(path.dirname(zipFilePath), { recursive: true });

  // Remove any prior file atomically
  try {
    fs.unlinkSync(zipFilePath);
  } catch {
    /* ignore if not exists */
  }

  // CWD must exist and be a directory
  const stats = fs.statSync(resultsPath);
  if (!stats.isDirectory()) {
    throw new Error(`resultsPath is not a directory: ${resultsPath}`);
  }
  async function addFolderToZip(folderPath: string, zipFolder: JSZip): Promise<void> {
    const items = await fs.readdir(folderPath);
    for (const item of items) {
      const fullPath = path.join(folderPath, item);
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        const folder = zipFolder.folder(item);
        await addFolderToZip(fullPath, folder);
      } else {
        // Add file as a stream so that it doesn't load the entire file into memory
        zipFolder.file(item, createReadStream(fullPath));
      }
    }
  }

  const zip = new JSZip();
  await addFolderToZip(resultsPath, zip);

  const zipStream = zip.generateNodeStream({
    type: 'nodebuffer',
    streamFiles: true,
    compression: 'DEFLATE',
  });

  await new Promise((resolve, reject) => {
    const outStream = createWriteStream(zipFilePath);
    zipStream
      .pipe(outStream)
      .on('finish', () => resolve(undefined))
      .on('error', reject);
  });
};

export default zipResults;
