# PR: Refactor oobee-crawler as a shared crawling library

## Summary

Refactors `oobee-crawler` from a full clone of `oobee` into a **library/utility** providing core crawling functionality (URL discovery, page navigation, browser management) that is consumed by both `oobee` (accessibility scanning) and `web-crawler` (content extraction).

**Branch:** `feat-oobee-crawler-util` (in all 3 repos)

---

## Architecture

```
oobee-crawler (library)
├── crawlDomain()       — crawl by following links
├── crawlSitemap()      — crawl from sitemap URLs  
├── crawlIntelligent()  — discover sitemaps → sitemap crawl → domain crawl
├── Browser utilities   — profile cloning, proxy detection, launch options
└── Shared helpers      — robots.txt parsing, URL normalization, etc.

Consumer: oobee
└── Imports crawlDomain/Sitemap/Intelligent from oobee-crawler
    Passes a pageHandler callback that runs axe-core scanning

Consumer: web-crawler  
└── Imports crawlDomain/Sitemap from oobee-crawler
    Passes a pageHandler callback that extracts rawHtml, headers, OG metadata
```

## Key Design: `pageHandler` Callback

The core change is that crawler functions now accept a **`pageHandler`** parameter:

```typescript
export type PageHandler = (context: {
  page: Page;                    // Playwright Page (already navigated)
  request: { url: string };      // Original request URL
  response: Response | null;     // HTTP response
  enqueueLinks: Function;        // Crawlee link enqueue function
}) => Promise<void>;
```

Each consumer defines what to do with a crawled page:
- **oobee**: Runs `runAxeScript()` for accessibility violations
- **web-crawler**: Extracts `rawHtml`, headers, title, WOGAA RSID

---

## Changes by Repository

### oobee-crawler (main changes)

**Deleted (scanning/CLI/reporting):**
- `src/cli.ts`, `src/index.ts` (CLI), `src/npmIndex.ts`, `src/combine.ts`
- `src/mergeAxeResults.ts` + `src/mergeAxeResults/` directory
- `src/screenshotFunc/`, `src/services/`, `src/static/` (EJS templates)
- `src/generateHtmlReport.ts`, `src/generateOobeeClientScanner.ts`
- `src/crawlers/commonCrawlerFunc.ts` (axe injection), `src/crawlers/custom/`
- `src/crawlers/pdfScanFunc.ts`, `src/crawlers/runCustom.ts`, `src/crawlers/crawlLocalFile.ts`

**Modified:**
- `src/crawlers/crawlDomain.ts` — removed `runAxeScript`, `includeScreenshots`, `ruleset`; added `pageHandler` param
- `src/crawlers/crawlSitemap.ts` — same pattern
- `src/crawlers/crawlIntelligentSitemap.ts` — passes `pageHandler` through
- `src/constants/constants.ts` — stripped axe-specific constants (WCAG links, rule descriptions, Sentry)
- `src/utils.ts` — stripped scanning helpers, kept URL normalization and resource management
- `src/constants/common.ts` — fixed imports for deleted modules

**Added:**
- `src/types.ts` — `PageHandler`, `PageHandlerContext`, `ViewportSettingsClass`, `UrlsCrawled`, `PageInfo`
- `src/index.ts` — library entry point exporting all public API
- `package.json` — stripped to crawling deps only (crawlee, playwright, cheerio, etc.)
- `tsconfig.json` — added `declaration: true` for type exports

**Preserved:**
- Proxy detection (`proxyService.ts`)
- Browser profile cloning (in `constants/common.ts`)
- Robots.txt parsing and sitemap discovery
- Crawlee orchestration with PlaywrightCrawler
- Request queue management and URL deduplication
- DOM stability detection (MutationObserver)
- Browser pool with per-request profile isolation

### oobee

- `package.json` — added `"@govtechsg/oobee-crawler": "file:../oobee-crawler"` dependency

### web-crawler

- `services/web-crawler-service/tasks/crawlWebPages/package.json` — added `"@govtechsg/oobee-crawler": "file:../../../../oobee-crawler"` dependency

---

## Usage Example (oobee consumer)

```typescript
import { crawlDomain } from '@govtechsg/oobee-crawler';
import { runAxeScript } from './crawlers/commonCrawlerFunc.js';

const pageHandler = async ({ page, request, response, enqueueLinks }) => {
  const results = await runAxeScript({ includeScreenshots, page, randomToken, ruleset });
  results.url = request.url;
  await dataset.pushData(results);
};

const { urlsCrawled } = await crawlDomain({
  url, randomToken, host, viewportSettings,
  maxRequestsPerCrawl, browser, userDataDirectory,
  strategy, specifiedMaxConcurrency, fileTypes,
  blacklistedPatterns, followRobots, extraHTTPHeaders,
  pageHandler,
});
```

## Usage Example (web-crawler consumer)

```typescript
import { crawlDomain } from '@govtechsg/oobee-crawler';

const pageHandler = async ({ page, request, response }) => {
  const rawHtml = await page.content();
  const title = await page.title();
  const headers = response?.headers() || {};
  const statusCode = response?.status() || 0;
  
  results.push({
    url: request.url,
    loadedUrl: page.url(),
    rawHtml,
    title,
    statusCode,
    httpResponseHeaders: headers,
    timeOfScrape: new Date().toISOString(),
  });
};

const { urlsCrawled } = await crawlDomain({
  url, randomToken, host, viewportSettings,
  maxRequestsPerCrawl, browser, userDataDirectory,
  strategy, specifiedMaxConcurrency, fileTypes,
  blacklistedPatterns, followRobots, extraHTTPHeaders,
  pageHandler,
});
```

---

## What's NOT in this PR (future work)

1. **oobee integration**: Wiring `combine.ts` to import from oobee-crawler and define the axe-scanning pageHandler
2. **web-crawler integration**: Replacing `@searchsg/apify` + Puppeteer with oobee-crawler's Playwright + Crawlee
3. **PDF scanning**: Remains in oobee (not moved to oobee-crawler)
4. **NPM publishing**: oobee-crawler currently uses local file references

---

## Verification

1. `cd oobee-crawler && npx tsc --noEmit` — compiles with zero errors
2. All three repos have committed changes on `feat-oobee-crawler-util` branch
