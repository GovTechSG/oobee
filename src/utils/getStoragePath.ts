import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import constants from '../constants/constants.js';
import { consoleLogger } from '../logs.js';

const getStoragePath = (randomToken: string): string => {
  // If exportDirectory is set, use it
  if (constants.exportDirectory) {
    return constants.exportDirectory;
  }

  // Otherwise, use the current working directory
  let storagePath = path.join(process.cwd(), 'results', randomToken);

  // Ensure storagePath is writable; if directory doesn't exist, try to create it in Documents or home directory
  const isWritable = (() => {
    try {
      if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
      }
      fs.accessSync(storagePath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();

  if (!isWritable) {
    if (os.platform() === 'win32') {
      // Use Documents folder on Windows
      const documentsPath = path.join(
        process.env.USERPROFILE || process.env.HOMEPATH || '',
        'Documents',
      );
      storagePath = path.join(documentsPath, 'Oobee', randomToken);
    } else if (os.platform() === 'darwin') {
      // Use Documents folder on Mac
      const documentsPath = path.join(process.env.HOME || '', 'Documents');
      storagePath = path.join(documentsPath, 'Oobee', randomToken);
    } else {
      // Use home directory for Linux/other
      const homePath = process.env.HOME || '';
      storagePath = path.join(homePath, 'Oobee', randomToken);
    }
    consoleLogger.warn(`Warning: Cannot write to cwd, writing to ${storagePath}`);
  }

  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  constants.exportDirectory = storagePath;
  return storagePath;
};

export default getStoragePath;
