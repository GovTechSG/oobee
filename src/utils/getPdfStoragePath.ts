import path from 'path';
import fs from 'fs-extra';
import getStoragePath from './getStoragePath.js';

const getPdfStoragePath = (randomToken: string): string => {
  const storagePath = getStoragePath(randomToken);
  const pdfStoragePath = path.join(storagePath, 'pdfs');
  if (!fs.existsSync(pdfStoragePath)) {
    fs.mkdirSync(pdfStoragePath, { recursive: true });
  }
  return pdfStoragePath;
};

export default getPdfStoragePath;
