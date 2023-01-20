import crawlSitemap from './crawlers/crawlSitemap.js';
import crawlDomain from './crawlers/crawlDomain.js';

import { generateArtifacts } from './mergeAxeResults.js';
import { getHostnameFromRegex, createAndUpdateFolders } from './utils.js';
import constants from './constants/constants.js';

process.env.CRAWLEE_STORAGE_DIR = constants.a11yStorage;

const combineRun = async details => {
  const envDetails = { ...details };

  // eslint-disable-next-line prettier/prettier
  const { type, url, randomToken, deviceChosen, customDevice, viewportWidth } = envDetails;

  const host = getHostnameFromRegex(url);

  const scanDetails = {
    startTime: new Date().getTime(),
    crawlType: type,
    requestUrl: url,
  };

  const viewportSettings = {
    deviceChosen,
    customDevice,
    viewportWidth,
  };

  let urlsCrawled;
  switch (type) {
    case constants.scannerTypes.sitemap:
      urlsCrawled = await crawlSitemap(url, randomToken, host, viewportSettings);
      break;

    case constants.scannerTypes.website:
      urlsCrawled = await crawlDomain(url, randomToken, host, viewportSettings);
      break;

    default:
      break;
  }

  scanDetails.endTime = new Date().getTime();
  scanDetails.urlsCrawled = urlsCrawled;
  await createAndUpdateFolders(scanDetails, randomToken);
  await generateArtifacts(randomToken);
};

export default combineRun;
