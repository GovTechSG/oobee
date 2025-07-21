#!/usr/bin/env node
import _yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import printMessage from 'print-message';
import { devices } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import { cleanUp, setHeadlessMode, getVersion, getStoragePath } from './utils.js';
import {
  checkUrl,
  prepareData,
  getFileSitemap,
  validEmail,
  validName,
  getBrowserToRun,
  getPlaywrightDeviceDetailsObject,
  deleteClonedProfiles,
  getScreenToScan,
  getClonedProfilesWithRandomToken,
  validateDirPath,
  validateFilePath,
  validateCustomFlowLabel,
  parseHeaders,
} from './constants/common.js';
import constants, { ScannerTypes } from './constants/constants.js';
import { cliOptions, messageOptions } from './constants/cliFunctions.js';
import combineRun from './combine.js';
import { Answers } from './index.js';
import { consoleLogger } from './logs.js';

const appVersion = getVersion();
const yargs = _yargs(hideBin(process.argv));

const options = yargs
  .version(false)
  .usage(
    `Oobee version: ${appVersion}
Usage: npm run cli -- -c <crawler> -d <device> -w <viewport> -u <url> OPTIONS`,
  )
  .strictOptions(true)
  .options(cliOptions)
  .example([
    [
      `To scan sitemap of website:', 'npm run cli -- -c [ 1 | sitemap ] -u <url_link> [ -d <device> | -w <viewport_width> ]`,
    ],
    [
      `To scan a website', 'npm run cli -- -c [ 2 | website ] -u <url_link> [ -d <device> | -w <viewport_width> ]`,
    ],
    [
      `To start a custom flow scan', 'npm run cli -- -c [ 3 | custom ] -u <url_link> [ -d <device> | -w <viewport_width> ]`,
    ],
  ])
  .coerce('d', option => {
    const device = devices[option];
    if (!device && option !== 'Desktop' && option !== 'Mobile') {
      printMessage(
        [`Invalid device. Please provide an existing device to start the scan.`],
        messageOptions,
      );
      process.exit(1);
    }
    return option;
  })
  .coerce('w', option => {
    if (!option || Number.isNaN(option)) {
      printMessage([`Invalid viewport width. Please provide a number. `], messageOptions);
      process.exit(1);
    } else if (option < 320 || option > 1080) {
      printMessage(
        ['Invalid viewport width! Please provide a viewport width between 320-1080 pixels.'],
        messageOptions,
      );
      process.exit(1);
    }
    return option;
  })
  .coerce('p', option => {
    if (!Number.isInteger(option) || Number(option) <= 0) {
      printMessage(
        [`Invalid maximum number of pages. Please provide a positive integer.`],
        messageOptions,
      );
      process.exit(1);
    }
    return option;
  })
  .coerce('t', option => {
    if (!Number.isInteger(option) || Number(option) <= 0) {
      printMessage(
        [`Invalid number for max concurrency. Please provide a positive integer.`],
        messageOptions,
      );
      process.exit(1);
    }
    return option;
  })
  .coerce('k', nameEmail => {
    if (nameEmail.indexOf(':') === -1) {
      printMessage(
        [`Invalid format. Please provide your name and email address separated by ":"`],
        messageOptions,
      );
      process.exit(1);
    }
    const [name, email] = nameEmail.split(':');
    if (name === '' || name === undefined || name === null) {
      printMessage([`Please provide your name.`], messageOptions);
      process.exit(1);
    }
    if (!validName(name)) {
      printMessage([`Invalid name. Please provide a valid name.`], messageOptions);
      process.exit(1);
    }
    if (!validEmail(email)) {
      printMessage(
        [`Invalid email address. Please provide a valid email address.`],
        messageOptions,
      );
      process.exit(1);
    }
    return nameEmail;
  })
  .coerce('e', option => {
    const validationErrors = validateDirPath(option);
    if (validationErrors) {
      printMessage([`Invalid exportDirectory directory path. ${validationErrors}`], messageOptions);
      process.exit(1);
    }
    return option;
  })
  .coerce('x', option => {
    const filename = fileURLToPath(import.meta.url);
    const dirname = `${path.dirname(filename)}/../`; // check in the parent of dist directory

    try {
      return validateFilePath(option, dirname);
    } catch (err) {
      printMessage([`Invalid blacklistedPatternsFilename file path. ${err}`], messageOptions);
      process.exit(1);
    }
  })
  .coerce('i', option => {
    const { choices } = cliOptions.i;
    if (!choices.includes(option)) {
      printMessage(
        [`Invalid value for fileTypes. Please provide valid keywords: ${choices.join(', ')}.`],
        messageOptions,
      );
      process.exit(1);
    }
    return option;
  })
  .coerce('j', option => {
    const { isValid, errorMessage } = validateCustomFlowLabel(option);
    if (!isValid) {
      printMessage([errorMessage], messageOptions);
      process.exit(1);
    }
    return option;
  })
  .coerce('a', option => {
    const { choices } = cliOptions.a;
    if (!choices.includes(option)) {
      printMessage(
        [`Invalid value for additional. Please provide valid keywords: ${choices.join(', ')}.`],
        messageOptions,
      );
      process.exit(1);
    }
    return option;
  })
  .coerce('q', option => {
    try {
      JSON.parse(option);
    } catch {
      // default to empty object
      return '{}';
    }
    return option;
  })
  .coerce('m', option => {
    return option;
  })
  .check(argvs => {
    if (argvs.scanner === ScannerTypes.CUSTOM && argvs.maxpages) {
      throw new Error(
        '-p or --maxpages is only available in website, sitemap and local file scans.',
      );
    }
    return true;
  })
  .check(argvs => {
    if (argvs.scanner !== ScannerTypes.WEBSITE && argvs.strategy) {
      throw new Error('-s or --strategy is only available in website scans.');
    }
    return true;
  })
  .coerce('l', (option) => {
    const duration = Number(option);
    if (isNaN(duration) || duration < 0) {
      printMessage(
        ['Invalid scan duration. Please provide a positive number of seconds.'],
        messageOptions,
      );
      process.exit(1);
    }
    return duration;
  })
  .check(argvs => {
    if (argvs.scanner === ScannerTypes.CUSTOM && argvs.scanDuration > 0) {
      throw new Error('-l or --scanDuration is not allowed for custom flow scans.');
    }
    return true;
  })
  .conflicts('d', 'w')
  .parse() as unknown as Answers;

const scanInit = async (argvs: Answers): Promise<string> => {
  let isCustomFlow = false;
  if (argvs.scanner === ScannerTypes.CUSTOM) {
    isCustomFlow = true;
  }

  const updatedArgvs = { ...argvs };

  // Cannot use data.browser and data.isHeadless as the connectivity check comes first before prepareData
  setHeadlessMode(updatedArgvs.browserToRun, updatedArgvs.headless);

  // let chromeDataDir = null;
  // let edgeDataDir = null;
  // Empty string for profile directory will use incognito mode in playwright
  let clonedDataDir = '';
  const statuses = constants.urlCheckStatuses;

  const { browserToRun, clonedBrowserDataDir } = getBrowserToRun(updatedArgvs.browserToRun, true);
  updatedArgvs.browserToRun = browserToRun;
  clonedDataDir = clonedBrowserDataDir;

  if (updatedArgvs.customDevice === 'Desktop' || updatedArgvs.customDevice === 'Mobile') {
    updatedArgvs.deviceChosen = argvs.customDevice;
    delete updatedArgvs.customDevice;
  }

  // Creating the playwrightDeviceDetailObject
  // for use in crawlDomain & crawlSitemap's preLaunchHook
  updatedArgvs.playwrightDeviceDetailsObject = getPlaywrightDeviceDetailsObject(
    updatedArgvs.deviceChosen,
    updatedArgvs.customDevice,
    updatedArgvs.viewportWidth,
  );

  const res = await checkUrl(
    updatedArgvs.scanner,
    updatedArgvs.url,
    updatedArgvs.browserToRun,
    clonedDataDir,
    updatedArgvs.playwrightDeviceDetailsObject,
    isCustomFlow,
    parseHeaders(updatedArgvs.header),
  );

  if (res.httpStatus) consoleLogger.info(`Connectivity Check HTTP Response Code: ${res.httpStatus}`);

  switch (res.status) {
    case statuses.success.code: {
      updatedArgvs.finalUrl = res.url;
      if (process.env.OOBEE_VALIDATE_URL) {
        console.log('Url is valid');
        process.exit(0);
      }

      break;
    }
    case statuses.unauthorised.code: {
      printMessage([statuses.unauthorised.message], messageOptions);
      consoleLogger.info(statuses.unauthorised.message);
      process.exit(res.status);
    }
    case statuses.cannotBeResolved.code: {
      printMessage([statuses.cannotBeResolved.message], messageOptions);
      consoleLogger.info(statuses.cannotBeResolved.message);
      process.exit(res.status);
    }
    case statuses.systemError.code: {
      printMessage([statuses.systemError.message], messageOptions);
      consoleLogger.info(statuses.systemError.message);
      process.exit(res.status);
    }
    case statuses.invalidUrl.code: {
      if (
        updatedArgvs.scanner !== ScannerTypes.SITEMAP &&
        updatedArgvs.scanner !== ScannerTypes.LOCALFILE
      ) {
        printMessage([statuses.invalidUrl.message], messageOptions);
        consoleLogger.info(statuses.invalidUrl.message);
        process.exit(res.status);
      }

      const finalFilePath = getFileSitemap(updatedArgvs.url);
      if (finalFilePath) {
        updatedArgvs.isLocalFileScan = true;
        updatedArgvs.finalUrl = finalFilePath;

        if (process.env.OOBEE_VALIDATE_URL) {
          console.log('Url is valid');
          process.exit(0);
        }
      } else if (updatedArgvs.scanner === ScannerTypes.LOCALFILE) {
        printMessage([statuses.notALocalFile.message], messageOptions);
        consoleLogger.info(statuses.notALocalFile.message);
        process.exit(statuses.notALocalFile.code);
      } else if (updatedArgvs.scanner !== ScannerTypes.SITEMAP) {
        printMessage([statuses.notASitemap.message], messageOptions);
        consoleLogger.info(statuses.notASitemap.message);
        process.exit(statuses.notASitemap.code);
      }
      break;
    }
    case statuses.notASitemap.code: {
      printMessage([statuses.notASitemap.message], messageOptions);
      consoleLogger.info(statuses.notASitemap.message);
      process.exit(res.status);
    }
    case statuses.notALocalFile.code: {
      printMessage([statuses.notALocalFile.message], messageOptions);
      consoleLogger.info(statuses.notALocalFile.message);
      process.exit(res.status);
    }
    case statuses.browserError.code: {
      printMessage([statuses.browserError.message], messageOptions);
      consoleLogger.info(statuses.browserError.message);
      process.exit(res.status);
    }
    default:
      break;
  }

  if (updatedArgvs.scanner === ScannerTypes.WEBSITE && !updatedArgvs.strategy) {
    updatedArgvs.strategy = 'same-domain';
  }

  const data = await prepareData(updatedArgvs);

  // File clean up after url check
  // files will clone a second time below if url check passes
  if (process.env.OOBEE_VERBOSE) {
    deleteClonedProfiles(data.browser, data.randomToken);
  } else {
    deleteClonedProfiles(data.browser); // first deletion
  }

  if (updatedArgvs.exportDirectory) {
    constants.exportDirectory = updatedArgvs.exportDirectory;
  }

  if (process.env.RUNNING_FROM_PH_GUI || process.env.OOBEE_VERBOSE) {
    const randomTokenMessage = {
      type: 'randomToken',
      payload: `${data.randomToken}`,
    };
    if (process.send) {
      process.send(JSON.stringify(randomTokenMessage));
    }
  }

  const screenToScan = getScreenToScan(
    updatedArgvs.deviceChosen,
    updatedArgvs.customDevice,
    updatedArgvs.viewportWidth,
  );

  // Clone profiles a second time
  clonedDataDir = getClonedProfilesWithRandomToken(data.browser, data.randomToken);
  data.userDataDirectory = clonedDataDir;

  printMessage([`Oobee version: ${appVersion}`, 'Starting scan...'], messageOptions);

  await combineRun(data, screenToScan);

  // Delete cloned directory
  if (process.env.OOBEE_VERBOSE) {
    deleteClonedProfiles(data.browser, data.randomToken);
  } else {
    deleteClonedProfiles(data.browser); // second deletion
  }

  // Delete dataset and request queues
  cleanUp(data.randomToken);

  return getStoragePath(data.randomToken);
};

const optionsAnswer: Answers = {
  scanner: options.scanner,
  header: options.header,
  browserToRun: options.browserToRun,
  zip: options.zip,
  url: options.url,
  finalUrl: options.finalUrl,
  headless: options.headless,
  maxpages: options.maxpages,
  metadata: options.metadata,
  safeMode: options.safeMode,
  strategy: options.strategy,
  fileTypes: options.fileTypes,
  nameEmail: options.nameEmail,
  additional: options.additional,
  customDevice: options.customDevice,
  deviceChosen: options.deviceChosen,
  followRobots: options.followRobots,
  customFlowLabel: options.customFlowLabel,
  viewportWidth: options.viewportWidth,
  isLocalFileScan: options.isLocalFileScan,
  exportDirectory: options.exportDirectory,
  clonedBrowserDataDir: options.clonedBrowserDataDir,
  specifiedMaxConcurrency: options.specifiedMaxConcurrency,
  blacklistedPatternsFilename: options.blacklistedPatternsFilename,
  playwrightDeviceDetailsObject: options.playwrightDeviceDetailsObject,
  ruleset: options.ruleset,
  generateJsonFiles: options.generateJsonFiles,
  scanDuration: options.scanDuration,
};

await scanInit(optionsAnswer);
process.exit(0);

export default options;
