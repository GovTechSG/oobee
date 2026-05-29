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

export type { PageHandler, PageHandlerContext, PageInfo, DatasetLike, PlaywrightHook } from './types.js';
export { ViewportSettingsClass, UrlsCrawled, FileTypes, STATUS_CODE_METADATA } from './types.js';

export { guiInfoLog, consoleLogger, silentLogger } from './logs.js';

export { createResourceBlockingHook, createCookieHook, createCloudflareHook } from './hooks.js';
export type { CloudflareSignFn } from './hooks.js';
export { SLOWDOWN_URLS_CONFIG, getSlowdownConfig } from './domainConfigs.js';
export { createSearchSGPageHandler, isSingpassLoginPage, isGoGovForwarderUrl } from './pageDataExtractor.js';
export type { SearchSGPageHandlerConfig } from './pageDataExtractor.js';
