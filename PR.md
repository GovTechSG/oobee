# PR: Extend oobee-crawler as a shared crawling library for oobee and web-crawler

## Summary

This PR extends oobee-crawler from a stripped-down crawling utility into a fully-featured shared library consumed by both oobee (accessibility scanning) and web-crawler (search indexing). It adds consumer extension points (hooks, page handlers, dataset access) and moves Singapore government domain-specific business logic into the library.

**Builds on:** `ba16c37e` (refactor: strip oobee-crawler to a shared crawling library)

---

## Benefits

1. **Single crawling engine** — Both oobee and web-crawler share identical crawling mechanics. Bug fixes (e.g., max-requests enforcement) and optimizations apply to both products simultaneously.

2. **1,400+ lines of duplicated code eliminated** — Domain-specific hooks, resource blocking, page data extraction, URL normalization, and browser management are maintained in one place.

3. **Consumer hook pattern** — `preNavigationHooks` and `postNavigationHooks` allow each consumer to inject custom behavior (Cloudflare signing, cookie injection, resource blocking) without modifying the library.

4. **`pageHandler` callback** — Decouples page processing from crawling. oobee runs axe-core; web-crawler extracts rawHtml + metadata. Both use the same crawler instance.

5. **Configurable via JSON** — `crawl-config.json` is a single source of truth for blocked extensions (20 unified from both products), domain exceptions, and slowdown configs. No code changes needed to adjust.

6. **Proper max-requests enforcement** — Fixes a race condition where concurrent handlers could exceed the page limit indefinitely when `pageHandler` throws or `isScanHtml` is false.

7. **Modern stack** — Crawlee (actively maintained, 15k+ GitHub stars) + Playwright replaces the frozen `@searchsg/apify` fork + Puppeteer in web-crawler.

8. **`urlFilter` and `urlList`** — `crawlSitemap` accepts pre-filtered URL lists or async filter functions, enabling web-crawler's S3-based result-reuse without the library needing to know about S3.

---

## What was added

### Consumer extension points

| Feature | File | Purpose |
|---------|------|---------|
| `DatasetLike` interface | `src/types.ts` | Consumers push per-page results to the dataset |
| `dataset` in `PageHandlerContext` | `src/types.ts` | Page handler receives dataset for result persistence |
| `preNavigationHooks` param | `crawlDomain.ts`, `crawlSitemap.ts` | Consumer-provided Playwright hooks run before navigation |
| `postNavigationHooks` param | `crawlDomain.ts`, `crawlSitemap.ts` | Consumer-provided hooks run after navigation |
| `pageDelayMs` param | `crawlDomain.ts`, `crawlSitemap.ts` | Per-page delay for domain rate limiting (number or function) |
| `urlFilter` param | `crawlSitemap.ts` | Async filter function for result-reuse (skip unchanged pages) |
| `urlList` param | `crawlSitemap.ts` | Pass pre-built URL list directly, bypassing sitemap parsing |

### Business logic modules

| Module | Exports | Description |
|--------|---------|-------------|
| `src/hooks.ts` | `createResourceBlockingHook`, `createCookieHook`, `createCloudflareHook` | Ready-made Playwright pre-navigation hooks for resource blocking (with domain exceptions), cookie injection (mom.gov.sg), Cloudflare bot signing |
| `src/domainConfigs.ts` | `SLOWDOWN_URLS_CONFIG`, `getSlowdownConfig` | Per-domain concurrency limits and random delay functions (mci, mas, mlaw, a-star, developer.tech, psd, enablingguide) |
| `src/pageDataExtractor.ts` | `createSearchSGPageHandler`, `isSingpassLoginPage`, `isGoGovForwarderUrl` | Page handler for SearchSG: extracts rawHtml, HTTP headers, page title, WOGAA RSID metadata, handles Singpass login redirects, resolves go.gov.sg forwarder URLs |
| `src/crawl-config.json` | — | Single source of truth for blocked extensions (20), domain block exceptions, and slowdown URL configs |

### Bug fixes (max-requests enforcement)

| Fix | Impact |
|-----|--------|
| Gate `enqueueProcess` behind `< maxRequestsPerCrawl` check | Prevents unlimited crawling when `isScanHtml=false` or `pageHandler` throws |
| Gate error-recovery URL enqueueing behind limit check | Prevents unlimited crawling when pages consistently fail |
| Set Crawlee's `maxRequestsPerCrawl` to `limit * 3` safety ceiling | Hard cap prevents runaway crawls even if manual enforcement has gaps |
| Add `< maxRequestsPerCrawl` guard to `crawlSitemap` scanned push | Prevents concurrency overshoot in sitemap crawling |

---

## Architecture

```
oobee-crawler (shared library)
├── crawlDomain()              — crawl by following links
├── crawlSitemap()             — crawl from sitemap URL or pre-built list
├── crawlIntelligentSitemap()  — discover sitemaps, then crawl domain
├── createSearchSGPageHandler()— extract page data for SearchSG indexing
├── createResourceBlockingHook()— block images/fonts/PDFs per domain
├── createCookieHook()         — inject domain-specific cookies
├── createCloudflareHook()     — add Cloudflare bot-signing headers
├── getSlowdownConfig()        — per-domain concurrency + delay
├── crawl-config.json          — JSON config (extensions, exceptions, slowdowns)
├── Proxy service              — multi-platform proxy detection (PAC, SOCKS, manual)
└── Browser utilities          — profile cloning, launch options, DOM stability
```

**Consumer pattern:**
```typescript
import { crawlDomain, createSearchSGPageHandler, createResourceBlockingHook, getSlowdownConfig } from '@govtechsg/oobee-crawler';

const pageHandler = createSearchSGPageHandler({ startingUrl, scrapeType });
const { maxConcurrency, delayFn } = getSlowdownConfig(startingUrl);

await crawlDomain({
  url: startingUrl,
  pageHandler,
  preNavigationHooks: [createResourceBlockingHook(startingUrl)],
  pageDelayMs: delayFn,
  specifiedMaxConcurrency: maxConcurrency || 50,
  ...
});
```

---

## Files changed

| File | Change |
|------|--------|
| `src/types.ts` | Added `DatasetLike`, `PlaywrightHook` types; added `dataset` to `PageHandlerContext` |
| `src/index.ts` | Export new modules and types; `ViewportSettingsClass` as value export |
| `src/crawlers/crawlDomain.ts` | Pass dataset to pageHandler; add hooks/pageDelay params; fix max-requests enforcement |
| `src/crawlers/crawlSitemap.ts` | Pass dataset to pageHandler; add hooks/pageDelay/urlFilter/urlList params; fix scanned guard |
| `src/crawlers/crawlIntelligentSitemap.ts` | Pass through hooks/pageDelay params to sub-calls |
| `src/constants/constants.ts` | Derive `blackListedFileExtensions` from crawl-config.json |
| `tsconfig.json` | Add `resolveJsonModule: true` |
| `src/hooks.ts` | **NEW** — Resource blocking, cookie, Cloudflare hooks |
| `src/domainConfigs.ts` | **NEW** — Slowdown URL configs |
| `src/pageDataExtractor.ts` | **NEW** — SearchSG page handler |
| `src/crawl-config.json` | **NEW** — Unified config (20 blocked extensions, 5 exception domains, 7 slowdown domains) |

---

## Configuration: `crawl-config.json`

```json
{
  "blockExtensions": [".css", ".js", ".txt", ".mp3", ".mp4", ".jpg", ...20 total],
  "blockExceptionMap": { "np.edu.sg": [".jpg", ".png", ...], ... },
  "slowdownUrls": { "https://www.mas.gov.sg/": { "maxConcurrency": 5, "delayMinMax": [0, 1000] }, ... }
}
```

---

## Consumers

| Consumer | How it uses oobee-crawler |
|----------|--------------------------|
| **oobee** | Imports `crawlDomain`/`crawlSitemap`/`crawlIntelligentSitemap` with a `pageHandler` that calls `runAxeScript` and pushes axe results to the dataset |
| **web-crawler** | Imports `crawlDomain`/`crawlSitemap` with `createSearchSGPageHandler` + hooks for resource blocking, Cloudflare signing, cookies, and domain slowdown |

---

## Verification

- `npm run build` succeeds (TypeScript compiles with no errors)
- oobee: 5-page intelligent scan of tech.gov.sg → accessibility report with 5 pages scanned
- web-crawler: 5-page crawl of tech.gov.sg → 19 intermediate results + 14 file metadata persisted
