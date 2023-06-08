import printMessage from 'print-message';

import crawlSitemap from './crawlers/crawlSitemap.js';
import crawlDomain from './crawlers/crawlDomain.js';

import { generateArtifacts } from './mergeAxeResults.js';
import { getHost, createAndUpdateResultsFolders, createDetailsAndLogs } from './utils.js';
import constants, { basicAuthRegex } from './constants/constants.js';

const combineRun = async (details, deviceToScan) => {
  const envDetails = { ...details };

  // eslint-disable-next-line prettier/prettier
  const {
    type,
    url,
    randomToken,
    deviceChosen,
    customDevice,
    viewportWidth,
    maxRequestsPerCrawl,
    isLocalSitemap,
    browser,
    userDataDirectory,
  } = envDetails;

  process.env.CRAWLEE_STORAGE_DIR = randomToken;

  const host = type === constants.scannerTypes.sitemap && isLocalSitemap ? '' : getHost(url);

  // remove basic-auth credentials from URL
  let finalUrl = url;
  if (basicAuthRegex.test(url)) {
    finalUrl = `${url.split('://')[0]}://${url.split('@')[1]}`;
  }

  const scanDetails = {
    startTime: new Date().getTime(),
    crawlType: type,
    requestUrl: finalUrl,
  };

  const viewportSettings = {
    deviceChosen,
    customDevice,
    viewportWidth,
  };

  let urlsCrawled;
  switch (type) {
    case constants.scannerTypes.sitemap:
      urlsCrawled = await crawlSitemap(
        url,
        randomToken,
        host,
        viewportSettings,
        maxRequestsPerCrawl,
        browser,
        userDataDirectory,
      );
      break;

    case constants.scannerTypes.website:
      urlsCrawled = await crawlDomain(
        url,
        randomToken,
        host,
        viewportSettings,
        maxRequestsPerCrawl,
        browser,
        userDataDirectory,
      );
      break;

    default:
      break;
  }

  scanDetails.endTime = new Date().getTime();
  scanDetails.urlsCrawled = urlsCrawled;
  await createDetailsAndLogs(scanDetails, randomToken);

  if (scanDetails.urlsCrawled.scanned.length > 0) {
    await createAndUpdateResultsFolders(randomToken);
    await generateArtifacts(randomToken, url, type, deviceToScan);
  } else {
    printMessage([`No pages were scanned.`], constants.alertMessageOptions);
  }
};

export default combineRun;
