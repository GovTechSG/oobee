export { default as crawlDomain } from './crawlers/crawlDomain.js';
export { default as crawlSitemap } from './crawlers/crawlSitemap.js';
export { default as crawlIntelligentSitemap } from './crawlers/crawlIntelligentSitemap.js';

export {
  getPlaywrightLaunchOptions,
  getClonedProfilesWithRandomToken,
  deleteClonedProfiles,
  getLinksFromSitemap,
  getUrlsFromRobotsTxt,
  getSitemapsFromRobotsTxt,
  isDisallowedInRobotsTxt,
  isBlacklistedFileExtensions,
  isSkippedUrl,
  waitForPageLoaded,
  isFilePath,
  getBrowserToRun,
} from './constants/common.js';

export {
  getProxyInfo,
  proxyInfoToResolution,
} from './proxyService.js';

export { getStoragePath, normUrl, areLinksEqual, isFollowStrategy, register, stopAll } from './utils.js';

export type { PageHandler, PageHandlerContext, PageInfo, ViewportSettingsClass, DatasetLike, PlaywrightHook } from './types.js';
export { UrlsCrawled, FileTypes, STATUS_CODE_METADATA } from './types.js';

export { guiInfoLog, consoleLogger, silentLogger } from './logs.js';
