import { execFileSync, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import constants, {
  destinationPath,
  getIntermediateScreenshotsPath,
} from './constants/constants.js';

export const getVersion = () => {
  const loadJSON = pathString => JSON.parse(fs.readFileSync(new URL(pathString, import.meta.url)));
  const versionNum = loadJSON('./package.json').version;

  return versionNum;
};

export const getHost = url => new URL(url).host;

export const getCurrentDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

export const isWhitelistedContentType = contentType => {
  const whitelist = ['text/html'];
  return whitelist.filter(type => contentType.trim().startsWith(type)).length === 1;
};

export const getStoragePath = randomToken => {
  if (constants.exportDirectory === process.cwd()) {
    return `results/${randomToken}`;
  }
  if (!path.isAbsolute(constants.exportDirectory)) {
    constants.exportDirectory = path.resolve(process.cwd(), constants.exportDirectory);
  }
  return `${constants.exportDirectory}/${randomToken}`;
};

export const createDetailsAndLogs = async (scanDetails, randomToken) => {
  const storagePath = getStoragePath(randomToken);
  const logPath = `logs/${randomToken}`;
  await fs.ensureDir(storagePath);
  await fs.writeFile(`${storagePath}/details.json`, JSON.stringify(scanDetails, 0, 2));

  // update logs
  await fs.ensureDir(logPath);
  await fs.pathExists('errors.txt').then(async exists => {
    if (exists) {
      await fs.copy('errors.txt', `${logPath}/${randomToken}.txt`);
    }
  });
};

export const getUserDataTxt = () => {
  const textFilePath =
    os.platform() === 'win32'
      ? path.join(process.env.APPDATA, 'Purple HATS', 'userData.txt')
      : path.join(
          process.env.HOME,
          'Library',
          'Application Support',
          'Purple HATS',
          'userData.txt',
        );
  // check if textFilePath exists
  if (fs.existsSync(textFilePath)) {
    const userData = JSON.parse(fs.readFileSync(textFilePath, 'utf8'));
    return userData;
  }
  return null;
};

export const writeToUserDataTxt = async (key, value) => {
  const textFilePath =
    os.platform() === 'win32'
      ? path.join(process.env.APPDATA, 'Purple HATS', 'userData.txt')
      : path.join(
          process.env.HOME,
          'Library',
          'Application Support',
          'Purple HATS',
          'userData.txt',
        );
  // Create file if it doesn't exist
  if (fs.existsSync(textFilePath)) {
    const userData = JSON.parse(fs.readFileSync(textFilePath, 'utf8'));
    userData[key] = value;
    await fs.writeFile(textFilePath, JSON.stringify(userData, 0, 2));
  } else {
    const textFilePathDir = path.dirname(textFilePath);
    if (!fs.existsSync(textFilePathDir)) {
      fs.mkdirSync(textFilePathDir, { recursive: true });
    }
    fs.appendFileSync(textFilePath, JSON.stringify({ [key]: value }, 0, 2));
  }
};

export const createAndUpdateResultsFolders = async randomToken => {
  const storagePath = getStoragePath(randomToken);
  await fs.ensureDir(`${storagePath}/reports`);
  await fs.copy(
    `${randomToken}/datasets/${randomToken}`,
    `${storagePath}/${constants.allIssueFileName}`,
  );
};

export const createScreenshotsFolder = randomToken => {
  const storagePath = getStoragePath(randomToken);
  const intermediateScreenshotsPath = getIntermediateScreenshotsPath(randomToken);
  if (fs.existsSync(intermediateScreenshotsPath)) {
    fs.readdir(intermediateScreenshotsPath, (err, files) => {
      if (err) {
        console.log(`Screenshots were not moved successfully: ${err.message}`);
      }

      if (!fs.existsSync(destinationPath(storagePath))) {
        fs.mkdirSync(destinationPath(storagePath), error => {
          if (error) {
            console.log(`Screenshots folder was not created successfully: ${error.message}`);
          }
        });
      }

      files.forEach(file => {
        fs.renameSync(
          `${intermediateScreenshotsPath}/${file}`,
          `${destinationPath(storagePath)}/${file}`,
        );
      });

      fs.rmdir(intermediateScreenshotsPath, error => {
        if (error) {
          console.log(error);
        }
      });
    });
  }
};

export const cleanUp = async pathToDelete => {
  await fs.pathExists(pathToDelete).then(exists => {
    if (exists) {
      fs.removeSync(pathToDelete);
    }
  });
};

/* istanbul ignore next */
export const getCurrentTime = () =>
  new Date().toLocaleTimeString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour12: true,
    hour: 'numeric',
    minute: '2-digit',
  });

export const setHeadlessMode = (browser, isHeadless) => {
  const isWindowsOSAndEdgeBrowser =
    browser === constants.browserTypes.edge && os.platform() === 'win32';
  if (isHeadless || isWindowsOSAndEdgeBrowser) {
    process.env.CRAWLEE_HEADLESS = 1;
  } else {
    process.env.CRAWLEE_HEADLESS = 0;
  }
};

export const setThresholdLimits = setWarnLevel => {
  process.env.WARN_LEVEL = setWarnLevel;
};

export const zipResults = (zipName, resultsPath) => {
  // Check prior zip file exist and remove
  if (fs.existsSync(zipName)) {
    fs.unlinkSync(zipName);
  }

  if (os.platform() === 'win32') {
    execSync(
      `Get-ChildItem -Path "${resultsPath}\\*.*" -Recurse | Compress-Archive -DestinationPath "${zipName}"`,
      { shell: 'powershell.exe' },
    );
  } else {
    // To zip up files recursively )-r) in the results folder path
    // Will only zip up the content of the results folder path with (-j) i.e. junk the path
    const command = '/usr/bin/zip';
    const args = ['-r', '-j', zipName, resultsPath];
    execFileSync(command, args);
  }
};

// areLinksEqual compares 2 string URLs and ignores comparison of 'www.' and url protocol
// i.e. 'http://google.com' and 'https://www.google.com' returns true
export const areLinksEqual = (link1, link2) => {
  let l1;
  let l2;
  try {
    const format = link => new URL(link.replace(/www\./, ''));
    l1 = format(link1);
    l2 = format(link2);

    const areHostEqual = l1.host === l2.host;
    const arePathEqual = l1.pathname === l2.pathname;

    return areHostEqual && arePathEqual;
  } catch (error) {
    return l1 === l2;
  }
};
