# PR: Replace inline crawlers with @govtechsg/oobee-crawler

## Summary

This PR replaces oobee's three inline crawler implementations (1,700+ lines) with calls to `@govtechsg/oobee-crawler`, a shared crawling library. oobee now defines a thin `pageHandler` callback that runs axe-core accessibility scanning on each page, while all crawling mechanics (browser management, URL discovery, request queuing, sitemap parsing) are delegated to the shared library.

**Net change: -1,690 lines deleted, +33 lines added**

---

## Benefits

1. **1,700 lines of crawler code removed** — `crawlDomain.ts` (783 lines), `crawlSitemap.ts` (450 lines), and `crawlIntelligentSitemap.ts` (178 lines) are deleted. The same functionality is provided by oobee-crawler.

2. **Shared bug fixes** — The max-requests enforcement bug (unlimited crawling when `pageHandler` throws) is fixed in oobee-crawler and applies to oobee automatically.

3. **Shared improvements** — Performance optimizations, new domain configs, and hook improvements made for web-crawler also benefit oobee's crawling.

4. **Clear separation** — oobee focuses purely on accessibility scanning logic (`runAxeScript`, report generation, custom checks). Crawling infrastructure is maintained separately.

5. **Consistent crawl behavior** — Both oobee and web-crawler use the same URL deduplication, robots.txt enforcement, redirect handling, and DOM stability waiting.

---

## Architecture Change

### Before
```
oobee
├── src/crawlers/crawlDomain.ts            (783 lines — full Crawlee PlaywrightCrawler + axe scanning)
├── src/crawlers/crawlSitemap.ts           (450 lines — sitemap parsing + Crawlee + axe scanning)
├── src/crawlers/crawlIntelligentSitemap.ts (178 lines — sitemap discovery + dispatch)
├── src/crawlers/commonCrawlerFunc.ts      (runAxeScript — accessibility scanning)
└── src/combine.ts                         (orchestration — calls crawlers with scanning params)
```

### After
```
oobee
├── src/crawlers/oobeePageHandler.ts       (19 lines — pageHandler closure wrapping runAxeScript)
├── src/crawlers/commonCrawlerFunc.ts      (runAxeScript — unchanged)
└── src/combine.ts                         (orchestration — calls oobee-crawler with pageHandler)
```

---

## How it works now

```typescript
// src/crawlers/oobeePageHandler.ts
export function createOobeePageHandler({ includeScreenshots, randomToken, ruleset }): PageHandler {
  return async ({ page, request, dataset }) => {
    const results = await runAxeScript({ includeScreenshots, page, randomToken, ruleset });
    results.url = request.url;
    await dataset.pushData(results);
  };
}

// src/combine.ts
import { crawlDomain, crawlSitemap, crawlIntelligentSitemap } from '@govtechsg/oobee-crawler';
import { createOobeePageHandler } from './crawlers/oobeePageHandler.js';

const pageHandler = createOobeePageHandler({ includeScreenshots, randomToken, ruleset });
await crawlDomain({ url, pageHandler, maxRequestsPerCrawl, ... });
```

The `pageHandler` callback pattern: oobee-crawler navigates to each page and calls the handler. The handler runs axe-core and pushes results to the Crawlee dataset. oobee's `mergeAxeResults.ts` reads from the dataset directory to generate reports — unchanged.

---

## Files changed

### Deleted (replaced by oobee-crawler)
| File | Lines | Contained |
|------|-------|-----------|
| `src/crawlers/crawlDomain.ts` | 783 | PlaywrightCrawler setup, request handler, click discovery, PDF handling, axe scanning |
| `src/crawlers/crawlSitemap.ts` | 450 | Sitemap parsing, PlaywrightCrawler, axe scanning |
| `src/crawlers/crawlIntelligentSitemap.ts` | 178 | Sitemap discovery (robots.txt + path probing), dispatch to domain/sitemap crawl |

### Created
| File | Lines | Purpose |
|------|-------|---------|
| `src/crawlers/oobeePageHandler.ts` | 19 | Factory creating a `PageHandler` that calls `runAxeScript` and pushes results |

### Modified
| File | Change |
|------|--------|
| `src/combine.ts` | Import crawl functions from `@govtechsg/oobee-crawler` instead of local files; create `pageHandler` for each scan type; remove `includeScreenshots`/`ruleset` from crawl function args; re-export `ViewportSettingsClass` from oobee-crawler |
| `src/crawlers/crawlLocalFile.ts` | Import `crawlSitemap` and `ViewportSettingsClass` from `@govtechsg/oobee-crawler`; use `pageHandler` pattern |

### Kept (unchanged)
| File | Purpose |
|------|---------|
| `src/crawlers/commonCrawlerFunc.ts` | `runAxeScript` — axe-core injection, scanning, result filtering |
| `src/crawlers/pdfScanFunc.ts` | PDF download and scanning |
| `src/crawlers/crawlLocalFile.ts` | Local file scanning (updated imports only) |
| `src/crawlers/runCustom.ts` | Custom flow scanning |
| `src/crawlers/custom/` | Custom axe checks (accessible labels, readability) |

---

## Dependency

```json
"@govtechsg/oobee-crawler": "file:../oobee-crawler"
```

oobee-crawler provides:
- `crawlDomain()`, `crawlSitemap()`, `crawlIntelligentSitemap()` — the three crawl modes
- `ViewportSettingsClass` — viewport configuration (replaces local definition)
- `PageHandler` type — the callback contract
- Browser profile management, robots.txt handling, URL dedup, DOM stability

---

## What oobee still owns

| Capability | Location |
|-----------|----------|
| Axe-core scanning | `src/crawlers/commonCrawlerFunc.ts` |
| Custom accessibility checks | `src/crawlers/custom/` |
| PDF scanning | `src/crawlers/pdfScanFunc.ts` |
| Local file scanning | `src/crawlers/crawlLocalFile.ts` |
| Custom flow (browser recording) | `src/crawlers/runCustom.ts` |
| Report generation (HTML, CSV, JSON) | `src/mergeAxeResults.ts` + submodules |
| CLI interface | `src/cli.ts` |
| npm module API | `src/npmIndex.ts` |
| S3 upload | `src/services/s3Uploader.ts` |

---

## Follow-up: Further deduplication

oobee still maintains local copies of functions that are already exported by `@govtechsg/oobee-crawler`. These should be replaced with imports in a follow-up PR to reduce code maintenance burden:

| Functions | oobee file | Notes |
|-----------|-----------|-------|
| `normUrl`, `areLinksEqual`, `isFollowStrategy` | `src/utils.ts` | URL normalization utilities |
| `getProxyInfo`, `proxyInfoToResolution` | `src/proxyService.ts` | Entire file is a duplicate |
| `getSitemapsFromRobotsTxt`, `isDisallowedInRobotsTxt` | `src/constants/common.ts` | robots.txt parsing |
| `waitForPageLoaded` | `src/constants/common.ts` | Page load detection |
| `getPlaywrightLaunchOptions`, `getClonedProfilesWithRandomToken` | `src/constants/common.ts` | Browser launch config |
| `isBlacklistedFileExtensions`, `blackListedFileExtensions` | `src/constants/common.ts` + `constants.ts` | Extension blocking |
| `UrlsCrawled` class | `src/constants/constants.ts` | Result tracking class |
| `getLinksFromSitemap`, `isFilePath` | `src/constants/common.ts` | Sitemap parsing |
| `guiInfoLog`, `consoleLogger`, `silentLogger` | `src/logs.ts` | Entire file is a duplicate |
| DOM MutationObserver wait | `src/crawlers/commonCrawlerFunc.ts` | Redundant — oobee-crawler's postNavigationHook already stabilizes DOM before pageHandler runs |

The main blocker is `src/constants/common.ts` (~2000 lines) which has many internal cross-references between these functions and oobee-specific logic (CLI parsing, form submission, etc.). Extracting the shared functions requires careful untangling.

---

## Verification

- `npm run build` succeeds (TypeScript compiles with no errors)
- `npm run cli -- -c intelligent -p 5 -u https://www.tech.gov.sg -k "Zui Young:accessibility@tech.gov.sg"` → 5 pages scanned, accessibility report generated in 38s
