import fs from 'fs-extra';
import constants, {
  destinationPath,
  getIntermediateScreenshotsPath,
} from '../constants/constants.js';
import { consoleLogger } from '../logs.js';
import getStoragePath from './getStoragePath.js';

export const createAndUpdateResultsFolders = async (randomToken: string): Promise<void> => {
  const storagePath = getStoragePath(randomToken);
  await fs.ensureDir(`${storagePath}`);

  const intermediatePdfResultsPath = `${randomToken}/${constants.pdfScanResultFileName}`;

  const transferResults = async (intermPath: string, resultFile: string): Promise<void> => {
    try {
      if (fs.existsSync(intermPath)) {
        await fs.copy(intermPath, `${storagePath}/${resultFile}`);
      }
    } catch (error) {
      if (error.code === 'EBUSY') {
        consoleLogger.error(
          `Unable to copy the file from ${intermPath} to ${storagePath}/${resultFile} because it is currently in use.`,
        );
        consoleLogger.error(
          'Please close any applications that might be using this file and try again.',
        );
      } else {
        consoleLogger.error(
          `An unexpected error occurred while copying the file from ${intermPath} to ${storagePath}/${resultFile}: ${error.message}`,
        );
      }
    }
  };

  await Promise.all([transferResults(intermediatePdfResultsPath, constants.pdfScanResultFileName)]);
};

export const createScreenshotsFolder = (randomToken: string): void => {
  const storagePath = getStoragePath(randomToken);
  const intermediateScreenshotsPath = getIntermediateScreenshotsPath(randomToken);
  if (fs.existsSync(intermediateScreenshotsPath)) {
    fs.readdir(intermediateScreenshotsPath, (err, files) => {
      if (err) {
        consoleLogger.error(`Screenshots were not moved successfully: ${err.message}`);
      }

      if (!fs.existsSync(destinationPath(storagePath))) {
        try {
          fs.mkdirSync(destinationPath(storagePath), { recursive: true });
        } catch (error) {
          consoleLogger.error('Screenshots folder was not created successfully:', error);
        }
      }

      files.forEach(file => {
        fs.renameSync(
          `${intermediateScreenshotsPath}/${file}`,
          `${destinationPath(storagePath)}/${file}`,
        );
      });

      fs.rmdir(intermediateScreenshotsPath, rmdirErr => {
        if (rmdirErr) {
          consoleLogger.error(rmdirErr);
        }
      });
    });
  }
};
