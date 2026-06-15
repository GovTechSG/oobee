# Oobee Developer Guide

> **Keep this file up to date.** When you make changes that affect architecture, crawl behavior, environment variables, or testing considerations described here, update the relevant section in the same commit.

Oobee is a web accessibility scanner that crawls websites and runs axe-core + custom checks against each page, producing HTML/PDF/CSV/JSON reports.

## Architecture Overview

```
User Input (CLI / npm API)
    ↓
combine.ts (orchestrator)
    ↓ routes by ScannerTypes
Crawler (crawlDomain / crawlSitemap / crawlIntelligentSitemap / crawlLocalFile / runCustom)
    ↓ uses Crawlee PlaywrightCrawler
Page Handler (axe-core injection + custom checks)
    ↓ writes per-page JSON to Crawlee dataset
generateArtifacts() in mergeAxeResults.ts
    ↓ reads dataset, aggregates, renders templates
Reports (HTML, PDF, CSV, JSON, sitemap.xml)
```

## Entry Points

| Entry | File | Purpose |
|-------|------|---------|
| CLI | `src/cli.ts` | yargs-based CLI, calls `combineRun()` |
| Interactive CLI | `src/index.ts` | Inquirer prompts, calls `combineRun()` |
| npm API | `src/npmIndex.ts` | Programmatic `init()` for external consumers |
| Orchestrator | `src/combine.ts` | Routes scan type, manages lifecycle, calls `generateArtifacts()` |

## Scanner Types

| Type | File | Behavior |
|------|------|----------|
| `Website` | `src/crawlers/crawlDomain.ts` | Domain crawl, discovers links from pages |
| `Sitemap` | `src/crawlers/crawlSitemap.ts` | Fetches URLs from sitemap XML |
| `Intelligent` | `src/crawlers/crawlIntelligentSitemap.ts` | Discovers sitemap via robots.txt, crawls it, then supplements with domain crawl |
| `LocalFile` | `src/crawlers/crawlLocalFile.ts` | Scans local HTML/PDF files via file:// |
| `Custom` | `src/crawlers/runCustom.ts` | User-driven flow (manual navigation in browser) |

## Key Files

### Constants & Configuration

- **`src/constants/constants.ts`** — Enums (`ScannerTypes`, `BrowserTypes`, `FileTypes`, `RuleFlags`), browser data dir paths, sitemap path list, WCAG mappings, shared mutable state (`robotsTxtUrls`, `sitemapFetchedLinks`, `userDataDirectory`, `launcher`)
- **`src/constants/common.ts`** — URL validation (`checkUrl`), browser launch options (`getPlaywrightLaunchOptions`), sitemap parsing (`getLinksFromSitemap`, `getSitemapsFromRobotsTxt`), robots.txt handling, browser selection (`getBrowserToRun`), user-agent initialization (`initModifiedUserAgent`)

### Crawlers

All crawlers use Crawlee's `PlaywrightCrawler` with:
- `maxRequestsPerCrawl: Infinity` (Crawlee's internal limit disabled)
- Manual stop when `urlsCrawled.scanned.length >= maxRequestsPerCrawl` (counts only successful scans)
- `retryOnBlocked: true`
- `useFingerprints: false`

### Report Generation

- **`src/mergeAxeResults.ts`** — Main `generateArtifacts()` function, reads Crawlee dataset, builds `allIssues` object, generates all output formats
- **`src/mergeAxeResults/`** — Sub-modules: `jsonArtifacts.ts` (JSON+base64), `writeCsv.ts`, `writeSitemap.ts`, `scanPages.ts`, `itemsStore.ts`, `types.ts`
- **`src/static/ejs/`** — EJS templates for HTML report and PDF summary

## Browser Handling

### Selection Priority

`getBrowserToRun()` in `common.ts` resolves the browser:
- If no preference specified: defaults to Chrome on Windows/macOS, Chromium on Linux
- Fallback chains:
  - **macOS**: Chrome → webkit
  - **Windows**: Chrome → Edge → error
  - **Linux**: Chrome → Chromium (bundled by Playwright)
- When `chromium` is specified: uses Playwright's bundled Chromium with no channel

### Launch Options

`getPlaywrightLaunchOptions()` builds Playwright launch config:
- Headless mode from `process.env.CRAWLEE_HEADLESS`
- Docker detection (`/.dockerenv`): adds `--disable-gpu`, `--no-sandbox`, `--disable-dev-shm-usage`
- Proxy support (manual, PAC, or none) via `getProxyInfo()`
- Channel set from browser name (undefined for chromium = bundled)

### User-Agent

`initModifiedUserAgent()` detects the default UA, replaces `HeadlessChrome` with `Chrome`, stores in `process.env.OOBEE_USER_AGENT`. This must be called before any browser context that talks to remote servers in headless mode, or bot-blocking WAFs will reject requests.

Contexts that need `userAgent: process.env.OOBEE_USER_AGENT`:
- `getRobotsTxtViaPlaywright()` — robots.txt fetching
- `findSitemap()` in `crawlIntelligentSitemap.ts` — sitemap path probing
- `getDataUsingPlaywright()` in `getLinksFromSitemap()` — sitemap XML content fetching
- `checkUrl()` — main URL validation context (already handled)
- Crawlee crawler contexts in `crawlDomain`/`crawlSitemap` — UA set via `preLaunchHooks` in `getPreLaunchHook()`

### Headless vs Headful

- Docker/Linux: always headless (`CRAWLEE_HEADLESS=1`)
- macOS CLI: typically headful (`CRAWLEE_HEADLESS=0`) unless user opts in
- Headful mode uses ephemeral contexts (no `userDataDir`) to avoid "Browser window not found" errors
- Headless mode uses `launchPersistentContext` with cloned user data directories

## Sitemap Discovery & Fetching

The intelligent crawl flow:
1. `getSitemapsFromRobotsTxt()` — fetches robots.txt, extracts `Sitemap:` directives
2. `findSitemap()` — probes hardcoded paths (`/sitemap.xml`, `/sitemap-index.xml`, etc.)
3. `getLinksFromSitemap()` — fetches and parses sitemap XML content, returns `Request[]`

Important behaviors:
- All URLs from the sitemap are discovered and stored as strings in a `Set<string>`
- All discovered URLs are converted to `Request` objects (no truncation at this stage)
- The crawler itself enforces `maxRequestsPerCrawl` by counting only successfully scanned pages
- `constants.sitemapFetchedLinks` stores the total discovered count for `scanData.json` reporting
- For sitemap indexes, child sitemaps are processed recursively

## Shared Mutable State

The `constants` default export object holds runtime state:
- `constants.launcher` — Playwright browser type (chromium/webkit)
- `constants.robotsTxtUrls` — Parsed robots.txt disallow/allow rules
- `constants.sitemapFetchedLinks` — Sitemap fetch diagnostics (reset per scan)
- `constants.userDataDirectory` — Current browser profile directory
- `constants.randomToken` — Current scan token
- `constants.resources` — Active Crawlee crawlers, browser contexts, browsers (for cleanup)

## Environment Variables

### User-Facing
| Variable | Purpose |
|----------|---------|
| `CRAWLEE_HEADLESS` | `1` = headless, `0` = headful (set by `setHeadlessMode()`) |
| `OOBEE_USER_AGENT` | Modified UA (set by `initModifiedUserAgent()`) |
| `OOBEE_VERBOSE` | Enable verbose console logging |
| `OOBEE_LOGS_PATH` | Custom log directory |
| `OOBEE_SLOWMO` | Browser slowmo in ms |
| `OOBEE_FAST_CRAWLER` | Experimental high-concurrency mode |
| `OOBEE_DISABLE_BROWSER_DOWNLOAD` | Block browser file downloads |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | Proxy configuration |
| `NO_PROXY` / `INCLUDE_PROXY` | Proxy bypass/include lists |

### Internal (set by code)
| Variable | Purpose |
|----------|---------|
| `CRAWLEE_STORAGE_DIR` | Crawlee dataset directory (= randomToken) |
| `CRAWLEE_LOG_LEVEL` | Set to `ERROR` |
| `CRAWLEE_SYSTEM_INFO_V2` | `1` (Windows wmic workaround) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Set to `0` for self-signed certs |

## Platform Differences

### Docker/Linux
- `/.dockerenv` detection adds `--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage`
- No system Chrome/Edge — always falls back to Playwright's bundled Chromium
- `getDefaultChromeDataDir()` returns null (no Chrome profile to clone)
- `getDefaultChromiumDataDir()` creates `./Chromium Support` or falls back to `/tmp`
- Always headless in Docker
- Default UA contains `HeadlessChrome` — must be patched via `initModifiedUserAgent()`

### macOS
- Defaults to system Chrome if available, falls back to webkit (not Chromium)
- Browser profiles at `~/Library/Application Support/Google/Chrome`
- Typically headful (non-headless)
- Logs at `~/Library/Application Support/Oobee/`

### Windows
- Defaults to system Chrome, falls back to Edge
- Browser profiles at `%APPDATA%/Local/Google/Chrome/User Data`
- File locks require longer cleanup delays (5s vs 3s)
- Path separator differences in cookie profile regex
- `CRAWLEE_SYSTEM_INFO_V2=1` needed (wmic deprecation)

## Testing

```bash
npm test                    # Run Jest tests (uses --experimental-vm-modules)
npx tsc --noEmit            # Type-check without emitting
npm run build               # Compile TypeScript
```

Test files: `__tests__/` directory and `src/crawlers/__tests__/`

## Build & Run

```bash
npm install                 # Install dependencies
npm run build               # Compile TS → dist/
node dist/cli.js            # Run CLI
```

Docker:
```bash
docker build -t oobee .
docker run oobee node dist/cli.js ...
```

## Common Pitfalls

1. **Bot-blocking in headless mode** — Any new browser context that fetches remote content in headless mode must pass `userAgent: process.env.OOBEE_USER_AGENT`. Without this, sites with WAFs block the request.

2. **`maxRequestsPerCrawl` semantics** — This counts *successfully scanned* pages, not total requests. The sitemap enqueues all discovered URLs; the crawler stops when enough succeed. Errored pages do not consume the budget.

3. **Browser profile isolation** — Each scan clones browser profiles with a `randomToken` suffix. Profiles must be cleaned up after scan (`deleteClonedProfiles()`).

    - If Chrome/Edge profile cloning fails (for example `EBUSY` while copying locked cookie/state files on Windows), Oobee now falls back to an empty cloned profile directory for that scan. This keeps browser launch stable, but authenticated session cookies may not be available.
    - Crawlee's browser pool retires and re-launches browser instances after ~4 minutes. On Windows, reusing the same `--user-data-dir` causes Chrome exit code 21 (stale lock contention). `getPreLaunchHook()` in `commonCrawlerFunc.ts` assigns unique `_pool{N}` directories for each re-launch and performs a best-effort async clone of the base profile. Cleanup must glob `_pool*` directories alongside the base `oobee-{token}` dir.

4. **`constants.launcher` mutation** — When webkit is the fallback, `constants.launcher` is reassigned globally. This affects all subsequent browser launches in the same process.

5. **Headful vs headless context creation** — Headful mode must NOT use `launchPersistentContext` with custom `userDataDir` (causes "Browser window not found" crash). Use `launch()` + `newContext()` instead.

6. **Sitemap fetch state** — `constants.sitemapFetchedLinks` accumulates across multiple `getLinksFromSitemap` calls. Must be reset to `null` at scan start.

7. **PDF generation** — `writeSummaryPdf()` always runs headless regardless of scan mode. It loads a local `file://` URL so UA/network issues don't apply, but it needs a working browser binary.

    - On Windows, summary PDF generation now retries with Edge (`msedge`) if the initial Chrome launch fails at runtime.

8. **Crawlee dataset** — Results are stored as numbered JSON files in `{randomToken}/datasets/default/`. Each file is one page's axe results. `generateArtifacts()` reads all of them.

## Testing Considerations

When making changes, validate these areas which have well-established edge cases:

### Memory & Large Scan Handling
- Large scans (1000+ pages) can produce multi-GB JSON payloads. The report pipeline streams per-page results sequentially and writes violation items to per-rule JSONL files on disk. Only rule-level summaries (not full `pagesAffected` arrays) are embedded in report.html. Any change to report generation must be tested with 1000+ page scans.
- When writing chunked base64 data to the HTML output stream, await drain events. Silent data truncation occurs on large payloads (57MB+) without backpressure handling.
- The browser-embedded payload in report.html must remain minimal — only rule summaries with `pagesAffectedCount`, not full item arrays. Browser `JSON.parse()` cannot handle 700MB+ strings.

### Crawlee Lifecycle & Cleanup
- Crawlee's async lock-file operations (`.json.lock` mkdir) can fire after the crawl finishes. On Windows, this triggers uncaughtException EPERM during report generation. A scoped exception handler suppresses these. The cleanup delay is 5s on Windows, 3s on others.
- The crawlee dataset folder and `tmp-items` (intermediate JSONL store) must be deleted BEFORE zipping results. `zipResults` must be the last step in `generateArtifacts()` — any cleanup or processing that removes temp files from `storagePath` must happen earlier. The dataset deletion uses an awaited delay (not fire-and-forget setTimeout) to let lingering Crawlee I/O flush.
- Errors must only be recorded in `failedRequestHandler` (after all retries exhausted), not in the `requestHandler` catch block. Crawlee retries up to 3 times, so recording in the catch block creates duplicates and false positives for URLs that succeed on retry.

### URL & Redirect Handling
- `https://example.com` and `https://example.com/` must be treated as the same page. Use `normUrl()` (wrapping `@apify/utilities normalizeUrl`) for all dedup sets.
- `www.example.com` and `example.com` must be treated as the same host. Never compare hostnames with `===` directly — use `isSameHostname()` from `src/utils.ts`, which strips the `www.` prefix. This applies to follow-strategy checks, click-discovery gating, and any other hostname comparison. Sitemaps commonly list child URLs without the `www.` prefix; browsers redirect between www/non-www variants freely.
- Pages may redirect to external domains. The crawler detects this both pre-scan (via `response.url()` after goto) and post-scan (via `page.url()` after axe completes, since JS redirects can fire during scan). Results are discarded if the page leaves its queued hostname.
- In custom flow, the entry URL should remain the user-provided URL, not the final redirected URL.

### robots.txt Handling
- Bare paths like `/subscription/unsubscribe` must emit both the exact-path pattern AND a children glob (`/subscription/unsubscribe/**`). Query-string `?` must be escaped (minimatch treats `?` as a single-char wildcard).
- URLs found via popups, frame navigations, or interactive clicks go through `enqueueUniqueRequest` which bypasses `transformRequestFunction`. These must also be checked against robots.txt via `isDisallowedInRobotsTxt` before enqueue.

### Local File Sitemaps
- When a local file path is used as `userUrl`, `isFollowStrategy` tries `new URL('/app/sitemaps/...')` which throws. Strategy checks must be skipped when `userUrl` is a file path. The `rule === 'all'` early-return should come before any URL parsing.

### Page Lifecycle
- `document.title` must be captured at the START of `runAxeScript()`, before axe scanning or screenshot capture. Pages can close during these operations (timeout, navigation, crash). Never create a new page just to re-navigate for the title — this leaks pages.
- The URL guard script in custom flow must be defensive against pages that close unexpectedly. All page event handlers should handle closed contexts gracefully.

### Proxy & Network
- Proxy detection must handle `ALL_PROXY` on Windows. The proxy resolution logic should be tested on all platforms.

### Strategy & Filtering in Sitemap Crawls
- The `-s` (strategy) flag must be passed through to `crawlSitemap` and `getLinksFromSitemap`. For sitemap-only scans the default is `'ignore'` (all URLs); for domain/intelligent crawls it's `'same-domain'`.
- `scanDuration=0` means unlimited. Code that calculates `remainingDuration` must treat 0 as "no limit", not as "0 seconds remaining".

### Rate Limiting, Adaptive Concurrency & CrawlRateController
- Sites with WAFs (Cloudflare, Akamai, etc.) will start returning 403/503 after a certain number of concurrent requests — typically 200-300 pages in rapid succession.
- Both crawlers use a shared `CrawlRateController` class (`src/crawlers/crawlRateController.ts`) that provides:
  1. **Strict maxPages**: `claimSlot()` is called at the moment of success (synchronously right before `urlsCrawled.scanned.push()`), not at the top of the request handler. `abort()` is called only after claiming the last slot (`isLimitReached()` becomes true post-claim). Never abort from the top of the handler — doing so kills in-flight pages that other handlers are scanning, causing undershoot.
  2. **Circuit breaker**: After 100 consecutive HTTP 4xx/5xx failures (configurable via `OOBEE_CONSECUTIVE_MAX_RETRIES`), the crawl aborts gracefully.
  3. **Adaptive concurrency**: On each 4xx/5xx failure, concurrency is halved (floor 1). After every 10 consecutive successes, concurrency recovers by +2 toward the original value. This automatically finds the site's rate limit threshold without manual tuning.
- **Critical placement of `claimSlot()` and `abort()`**: `claimSlot()` must be synchronously right before `push()` — never at the top of the handler. `abort()` must be called only after the last slot is claimed — never from an early-exit check. Pages can be discarded mid-handler (redirect, dedup, robots.txt block), and aborting prematurely kills in-flight handlers that would have succeeded.
- Only HTTP 4xx/5xx responses trigger rate adaptation and count toward the circuit breaker — timeouts and network errors do not.
- In intelligent crawl, each phase (sitemap then domain) creates its own `CrawlRateController` instance — transitioning from sitemap to domain crawl starts fresh.
- Without the circuit breaker, a rate-limited crawl with thousands of enqueued URLs would run indefinitely, never hit the success threshold, and never generate a report.
- When enqueuing all sitemap URLs (which we do for accurate `totalLinksFetchedFromSitemaps` reporting), always ensure either a scan duration (`-d`) or the circuit breaker is in place as a safety net.

### Axe & Custom Checks
- When axe reports color-contrast violations but cannot determine the actual colors, skip augmenting the message with contrast context (avoids crashes on null/undefined color values).
- Violation messages are enriched with live DOM context (element text, computed styles, dimensions) via `page.evaluate()` during scan. Handle cases where elements are no longer in DOM at evaluation time.
- `aria-hidden-focus` violations are re-verified against the live DOM after axe completes, to handle race conditions with JS that sets `tabindex="-1"` after `aria-hidden="true"` (common in carousel/slider libraries). The re-verification yields to the event loop before re-checking, allowing pending timers to fire. If all focusable descendants now have `tabindex < 0`, the violation is filtered out as a false positive.

## Report Output Structure

```
{randomToken}/
├── datasets/default/       # Crawlee per-page JSON results
├── report.html             # Interactive HTML report
├── summary.html → summary.pdf  # PDF summary (HTML deleted after conversion)
├── report.csv              # Issue-level CSV
├── scanData.json           # Scan metadata (site, dates, type, sitemap info)
├── scanItems.json          # All issues grouped by severity
├── scanItemsSummary.json   # Summary counts
├── scanIssuesSummary.json  # Issues without page details
├── scanPagesDetail.json    # Per-page breakdown
├── scanPagesSummary.json   # Page-level summary
├── sitemap.xml             # Discovered URLs
└── screenshots/            # Violation screenshots (if enabled)
```
