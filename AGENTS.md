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
- `--mute-audio` is added by default in both headless and headful modes, but must be disabled for `customFlow` by calling `getPlaywrightLaunchOptions(browser, { includeMuteAudio: false })`

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
- Some sitemap XMLs include `<?xml-stylesheet ...?>` (XSL). In `getDataUsingPlaywright()`:
  - Use `waitUntil: 'domcontentloaded'` (not `networkidle`) to avoid 60s timeouts caused by stylesheet/resource loading
  - Prefer `response.text()` to capture raw XML before browser XSL transformation (preserves `<sitemapindex>` / `<urlset>` structure)
  - Only fall back to DOM extraction when raw response text is unavailable

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
| `OOBEE_TAGGED_WEBSITE` | Tag to identify the website in Sentry telemetry (overridden by `--websiteTag` CLI flag) |
| `OOBEE_SCAN_METADATA` | Overrides `entryUrl` tag in Sentry events |
| `OOBEE_SCAN_PRODUCT` | Adds `scanProduct` tag to Sentry events |
| `OOBEE_CONSECUTIVE_MAX_RETRIES` | Max consecutive HTTP failures before circuit breaker aborts crawl (default 100) |
| `OOBEE_VALIDATE_URL` | If set, exit after URL validation without scanning |
<<<<<<< HEAD
| `OOBEE_SAVE_DOM` | `1` or `true` = save full-page DOM HTML to `pageDOMs/` in results directory. Supported scan types: Website, Sitemap, Intelligent, LocalFile, Custom |
| `OOBEE_SAVE_PAGE_SCREENSHOT` | `1` or `true` = save full-page desktop + mobile viewport screenshots to `pageDOMs/desktopPageScreenshots/` and `pageDOMs/mobilePageScreenshots/`. Mobile viewport uses iPhone 11 width programmatically. Supported scan types: Website, Sitemap, Intelligent, LocalFile, Custom |
=======
| `GOOGLE_SAFE_BROWSING` | `1` = enable Google Safe Browsing (requires Chrome, not Chromium) |
| `GOOGLE_SAFE_BROWSING_DEBUG` | `1` = enable verbose Safe Browsing debug logging |
>>>>>>> 86d9da36 (feat: add Google Safe Browsing support via Chrome real-time URL protection)
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

## Safe Browsing

### Overview

Google Safe Browsing protects users by checking URLs against Google's threat database. Modern Chrome (v128+) uses the **v5 hash-real-time protocol** — it does NOT download a local threat database. Instead, URLs are checked in real-time via OHTTP (Oblivious HTTP) on every navigation.

### Requirements

1. **Google Chrome** (not Chromium) — Safe Browsing requires Google's proprietary API keys baked into the Chrome build. Chromium does not include them.
2. **`GOOGLE_SAFE_BROWSING=1`** environment variable — gates the feature.
3. **Network access** to `safebrowsing.googleapis.com` and `safebrowsingohttpgateway.googleapis.com`.

### How It Works

When `GOOGLE_SAFE_BROWSING=1` is set:

1. `getPlaywrightLaunchOptions()` in `src/constants/common.ts` adds three Playwright default args to `ignoreDefaultArgs`:
   - `--safebrowsing-disable-auto-update` (allows SB updater to run)
   - `--disable-background-networking` (allows hash lookups)
   - `--disable-client-side-phishing-detection` (allows phishing detection)

2. `ensureSafeBrowsingPreferences()` writes `{ safebrowsing: { enabled: true, enhanced: false } }` into the Chrome profile's `Default/Preferences` before launch. Called from:
   - `launchPersistentContextWithSafeBrowsing()` wrapper (used by all direct `launchPersistentContext` call sites)
   - `getPreLaunchHook()` in `commonCrawlerFunc.ts` (Crawlee-managed browser pool)

3. Chrome performs real-time hash-prefix lookups on every navigation. No warmup or pre-seeding is needed.

### Docker / Architecture Constraints

- **amd64 (x86_64)**: Google Chrome .deb is installed in Dockerfile. Safe Browsing works fully.
- **arm64 (aarch64)**: Google Chrome is NOT available for ARM64 Linux (as of July 2026). The Dockerfile skips Chrome installation. Safe Browsing is unavailable; only Chromium is present.
- Build the image with `docker build --platform linux/amd64` to ensure Chrome is available.

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `GOOGLE_SAFE_BROWSING` | `1` = enable Safe Browsing (requires Chrome) |
| `GOOGLE_SAFE_BROWSING_DEBUG` | `1` = enable verbose Chrome Safe Browsing logging |

### Key Files

- `src/constants/common.ts` — `getPlaywrightLaunchOptions()`, `ensureSafeBrowsingPreferences()`, `launchPersistentContextWithSafeBrowsing()`
- `src/crawlers/commonCrawlerFunc.ts` — `getPreLaunchHook()` calls `ensureSafeBrowsingPreferences()`
- `Dockerfile` — Conditional Chrome installation for amd64

### What Does NOT Work

- Chromium (Playwright's bundled browser) — lacks Safe Browsing entirely
- `--headless=old` or `--headless=new` for DB warmup — the old v4 local database approach is obsolete as of Chrome 128+
- ARM64 Linux Docker — Chrome .deb not published for arm64

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
    - On Windows, Chrome writes files asynchronously during its shutdown sequence (`first_party_sets.db`, `optimization_guide_model_store/`, `segmentation_platform/`, `Local State`, `Profile N/`). Pool directory cleanup uses a 5s initial delay (vs 2s on other platforms) and retries up to 3 times in `getPostPageCloseHook()`. The final sweep in `cleanUp()` also retries after a 3s delay on Windows.

4. **`constants.launcher` mutation** — When webkit is the fallback, `constants.launcher` is reassigned globally. This affects all subsequent browser launches in the same process.

5. **Headful vs headless context creation** — Headful mode must NOT use `launchPersistentContext` with custom `userDataDir` (causes "Browser window not found" crash). Use `launch()` + `newContext()` instead.

6. **Sitemap fetch state** — `constants.sitemapFetchedLinks` accumulates across multiple `getLinksFromSitemap` calls. Must be reset to `null` at scan start.

7. **PDF generation** — `writeSummaryPdf()` always runs headless regardless of scan mode. It loads a local `file://` URL so UA/network issues don't apply, but it needs a working browser binary.

    - On Windows, summary PDF generation now retries with Edge (`msedge`) if the initial Chrome launch fails at runtime.

8. **Crawlee dataset** — Results are stored as numbered JSON files in `{randomToken}/datasets/default/`. Each file is one page's axe results. `generateArtifacts()` reads all of them.

9. **Auth headers and CORS** — Never set `Authorization` in `extraHTTPHeaders` globally on a browser context. Playwright sends `extraHTTPHeaders` to ALL requests (including cross-origin CDNs), which triggers CORS preflight failures. Instead use `splitAuthHeaders()` from `commonCrawlerFunc.ts` to separate auth from non-auth headers:
    - Non-auth headers → safe to set globally via `extraHTTPHeaders` on context/launch options
    - Basic auth → set `httpCredentials` on context (Playwright auto-responds to 401 challenges, origin-aware)
    - Any Authorization header → send only to same-origin requests via `addAuthRouteHandler()` (route interception) or Crawlee's `preNavigationHooks` (navigation-only)
    - Credentials come from URL-embedded `user:pass@host` or `-m "Authorization Basic ..."` — both produce the same `extraHTTPHeaders.Authorization` value in `prepareData()`

10. **Intermediate JSONL write safety + corruption tolerance** — `ItemsStore.appendPageItems()` requires strict serialization of writes per rule file to prevent interleaved corruption. It also enforces a strict text sanitization regex to filter out literal `\n` and `\r` control characters from website HTML inputs immediately after `JSON.stringify()`. This ensures no single JSON issue accidentally injects illegal implicit newline boundaries when writing to JSONL format. Maintain backward-compatible `fs.appendFile` queues over buffered WriteStreams to guarantee pipeline sync visibility. `ItemsStore.readRuleItems()` tolerates historical malformed lines via fallback skip logic.

11. **`preNavigationHooks` and the Playwright header-rewrite warning** — `preNavigationHooks()` in `commonCrawlerFunc.ts` is always included in the crawler `preNavigationHooks` array (for both `crawlDomain` and `crawlSitemap`). The hook does two things:
    - **Header rewriting**: only sets `crawlingContext.request.headers = extraHTTPHeaders` when `extraHTTPHeaders` is non-empty. Setting request headers causes Crawlee/Playwright to intercept every network request to rewrite them, which triggers `WARN Playwright Utils: Using other request methods than GET, rewriting headers and adding payloads has a high impact on performance`. This warning is expected for authenticated scans; it is suppressed for unauthenticated scans because `extraHTTPHeaders` stays empty (see pitfall 12 below).
    - **Navigation wait**: always sets `gotoOptions.waitUntil = 'domcontentloaded'` and `gotoOptions.timeout = 30000` via **in-place object mutation**. Do NOT reassign the `gotoOptions` parameter (`gotoOptions = {...}`) — that only rebinds the local variable and does not propagate to Crawlee. `domcontentloaded` is used (not `networkidle`) to avoid indefinite hangs on sites with WebSockets, analytics polling, lazy-load beacons, or health-check pings that never quiet their network activity. Further page stability is handled by `waitForPageLoaded()` in each requestHandler and the DOM mutation observer in `postNavigationHooks`.

12. **`extraHTTPHeaders` must not be mutated before being passed to crawlers** — `checkUrlConnectivityWithBrowser()` in `common.ts` needs an `Accept` header for its own connectivity check but must NOT add it to the shared `extraHTTPHeaders` object. Mutating the shared object causes crawlers to see a non-empty `extraHTTPHeaders` (at minimum `{ Accept: '...' }`), which silently triggers header rewriting and the Playwright performance warning for every unauthenticated scan. Always use a local copy: `const localHeaders = { ...extraHTTPHeaders }; localHeaders.Accept ||= '...';`.

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
- **"Download is starting" navigation errors**: URLs that trigger file downloads (e.g. Salesforce `/download/` endpoints without `.pdf` extension) cause `page.goto()` to throw. Crawlee retries 3 times (all fail the same way). In `failedRequestHandler`, detect via `request.errorMessages.includes('Download is starting')`. If `isScanPdfs`: re-enqueue with `skipNavigation: true` and unique key `download_${url}` so the requestHandler's PDF download path handles it via `sendRequest`. If not scanning PDFs: classify as `STATUS_CODE_METADATA[1]` ("Not A Supported Document").
- **403 rate-limit retry**: In `failedRequestHandler`, 403 URLs are re-enqueued once with `userData.rateLimitRetried = true` and unique key `ratelimit_${url}`. This gives them a fresh attempt cycle after adaptive concurrency recovers from the rate-limit burst. Do NOT call `rateController.onFailure()` on the first pass — this avoids double-counting toward the circuit breaker. If the retry also fails, it falls through to the normal `onFailure` + circuit breaker path.
- **Non-HTML document classification ("Unsupported Documents")**: URLs serving non-HTML content (images, PDFs, media, binary files) must be classified as `STATUS_CODE_METADATA[1]` ("Not A Supported Document") with `httpStatusCode: 1` in both crawlers. This applies whether the content-type is detected pre-navigation (via file extension in `preNavigationHooks`) or post-navigation (via response `content-type` header). The report UI identifies unsupported documents by `httpStatusCode === 1` — any other status code (even 0) with incorrect metadata may land in "Pages Not Scanned" instead. Both crawlDomain and crawlSitemap now report these consistently — crawlDomain no longer silently drops them.
  - **`blackListedFileExtensions` (shared constant in `constants.ts`)**: Single source of truth for non-scannable file extensions. Used in both crawlers' `preNavigationHooks` to skip navigation, and in crawlDomain's post-navigation `isBlacklistedFileExtensions()` check. When adding new non-scannable types, update this one list. Does NOT include `.pdf` — PDFs are handled by the separate PDF scan path.
  - **Both crawlers' preNavigationHooks**: Check URL pathname extension against `blackListedFileExtensions`. If matched, set `skipNavigation=true` (crawlDomain) or `skipNavigation=true` + `isNotSupportedDocument=true` (crawlSitemap). This avoids wasting browser resources on non-HTML URLs.
  - **crawlSitemap else block**: when navigation succeeds but `content-type` is non-HTML (e.g. `image/png`, `application/pdf` after a 302 redirect), classifies as unsupported instead of using the HTTP status code. The check: `contentType && !contentType.startsWith('text/html') && !contentType.includes('html')`. Empty content-type falls through to existing logic (preserves behavior for pages that don't send content-type headers).
  - **crawlDomain**: `shouldSkipDueToUnsupportedContent()` and `isBlacklistedFileExtensions()` now push to `urlsCrawled.userExcluded` with `httpStatusCode: 1`. Previously these silently returned with no classification. The preNavigationHook catches blacklisted extensions before navigation; for URLs without obvious extensions (e.g. redirects to non-HTML), the post-navigation content-type check is the safety net.
  - **No impact to runAxeScript**: HTML pages never trigger these paths — `shouldSkipDueToUnsupportedContent` returns false for `text/html`, `blackListedFileExtensions` doesn't match `.html`/no-extension URLs, and `isWhitelistedContentType` passes for `text/html`. The full page lifecycle (waitForPageLoaded → DOM mutation observer → runAxeScript) is unchanged for scannable pages.

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

### URL Guard & Overlay Management in Custom Flow

`src/crawlers/guards/urlGuard.ts` — attached via `addUrlGuardScript()` in `runCustom.ts`:

- **`restoreToSafeUrl` must validate the safe URL before calling `page.goto()`**. If the entry URL is `file://` (e.g. `-u '/path/to/report.html'`), `fallbackUrl` is also `file://`. Redirecting to it fires another `framenavigated` for `file://`, which re-triggers `restoreToSafeUrl` → infinite reload loop. Always check `ALLOWED_PROTOCOLS.has(safeObj.protocol)` before navigating; if the fallback is not http/https, return without redirecting.

- **`about:` protocol must be skipped in `framenavigated`**. Chromium fires `framenavigated` for `about:blank` as a transient intermediate state during every `page.goto()` call. Intercepting it and calling `restoreToSafeUrl` → `page.goto(safeUrl)` → `about:blank` → `restoreToSafeUrl` → … creates a second infinite loop. Always `return` early when `urlObj.protocol === 'about:'`.

- **`reconcileOverlayMenu` must not remove the overlay on macOS/Windows**. On `darwin`/`win32` the custom flow runs headful. When `isOverlayAllowed` returns `false` (e.g. transient `file://` or `about:blank` URL), do **not** call `removeOverlayMenu` — the URL guard will redirect back to the safe URL momentarily. Instead, fall through to the `hasOverlay` / `addOverlayMenu` block so the overlay is (re-)injected regardless of the current URL protocol. On Linux/Docker (headless) the removal behaviour is unchanged.

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
- **WAF behavior differs by source IP**: Datacenter/cloud IPs (Linux servers) are often rate-limited more aggressively by WAFs than residential/ISP IPs (Windows desktops). This means the circuit breaker (100 consecutive failures) fires on Linux but NOT on Windows for the same site — Windows successfully recovers concurrency between rate-limit bursts, keeping the consecutive failure counter below 100. This difference affects whether `isAbortingScanNow` is set, which gates the second-pass click-discovery loop.

### Click-Discovery Second Pass in crawlDomain
- After `crawler.run()` completes, `crawlDomain` has a second-pass loop that re-visits all scanned same-hostname pages for `customEnqueueLinksByClickingElements` — a sequential loop that clicks every interactive element with 1s delay between clicks.
- **This loop is skipped when `fromCrawlIntelligentSitemap` is true** — the domain phase of intelligent crawl is only meant to discover new pages via `<a>` link extraction, not exhaustively click 3000+ already-scanned pages.
- **This loop is skipped when `isAbortingScanNow` is true** — if the circuit breaker fired or the rate controller hit its page limit, the second pass is skipped. This is why Linux scans (where the circuit breaker fires due to stricter WAF) don't get stuck, but Windows scans (where recovery succeeds) enter the loop.
- Without `scanDuration` or the `fromCrawlIntelligentSitemap` guard, the second pass on a 3000+ page site can take 10+ hours (each page × 90s `requestHandlerTimeoutSecs` at concurrency 1).
- The second pass produces no log output — `__clickpass__` handlers call `enqueueProcess` and return without `guiInfoLog` or rate controller interaction, making it appear as if the scan is hung.

### Intelligent Sitemap Link Discovery Optimization
- In intelligent crawl mode, `crawlSitemap` now performs `enqueueLinks` on each successfully scanned page (gated by `fromCrawlIntelligentSitemap`). This discovers `<a>` links from sitemap pages without any additional page loads — just a DOM query on the already-loaded page.
- Discovered URLs go into a `RequestQueue`. Crawlee processes `RequestList` (sitemap URLs) first, then `RequestQueue` items after. So discovered links are scanned after all sitemap URLs complete, within the same crawlSitemap phase.
- This eliminates most of the work the subsequent `crawlDomain` supplement phase would otherwise do. The domain phase still runs (to discover pages reachable only from the entry URL), but finds almost everything already in `scannedUrlSet` and finishes quickly.
- **No behavior change for standalone scans**: The `enqueueLinks` block is gated by `fromCrawlIntelligentSitemap` — standalone sitemap scans (`-s sitemap`) and standalone website scans (`-s website`) are unaffected.
- The `transformRequestFunction` in sitemap `enqueueLinks` filters robots.txt-disallowed URLs and marks PDFs for `skipNavigation`, matching `crawlDomain`'s behavior.
- `crawlSitemap` always creates a `RequestQueue` (even in standalone mode) to enable download re-enqueue and 403 retry handling. An empty queue has zero impact on crawl behavior.

### Scan Consistency Between crawlDomain and crawlSitemap
- Both crawlers must produce equivalent axe scan results for the same page. Any difference in how the page is observed/stabilized before `runAxeScript()` will cause inconsistent accessibility findings between scan types.
- **postNavigationHook DOM observer must be identical**: Both crawlers use a MutationObserver in `postNavigationHooks` to wait for DOM stabilization before proceeding to the request handler. The observer must call `observer.observe(root, { childList: true, subtree: true })` — without this call, the hook degrades to a fixed 5-second timeout (the `OBSERVER_TIMEOUT` fallback) and the DOM may be in a different state when scanning begins.
- **`runAxeScript()` has its own secondary DOM observer** (in `commonCrawlerFunc.ts`) that additionally watches `attributes: true`. This is a second stabilization gate shared by all crawlers — it ensures attribute animations settle before axe runs.
- **`waitForPageLoaded(page, 10000)` in the requestHandler** is the third stabilization check (waits for `load` event or 10s timeout). All crawlers call this at the top of their request handler.
- **Parameters passed to `runAxeScript()` must match**: both must pass `ruleset` (controls `DISABLE_OOBEE` / `ENABLE_WCAG_AAA`). Any new parameter added to `runAxeScript()` must be propagated to all crawlers via `combine.ts`.
- **Error handling in postNavigationHook**: wrap `page.evaluate()` in try/catch to handle pages destroyed during the DOM observer (navigation, timeout, crash). Without this, the error propagates and may affect Crawlee's retry logic differently between crawlers.

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
├── screenshots/            # Violation screenshots (if enabled)
└── pageDOMs/              # Page capture (if OOBEE_SAVE_DOM or OOBEE_SAVE_PAGE_SCREENSHOT)
    ├── {hash}-{truncated_path}.html          # Full DOM (OOBEE_SAVE_DOM)
    ├── domManifest.json                     # Maps URLs → hash, file paths, errors
    ├── desktopPageScreenshots/             # Desktop viewport PNGs (OOBEE_SAVE_PAGE_SCREENSHOT)
    │   └── {hash}-{truncated_path}.png
    └── mobilePageScreenshots/              # Mobile viewport PNGs (OOBEE_SAVE_PAGE_SCREENSHOT)
        └── {hash}-{truncated_path}.png
```

- `{hash}` is a 7-character SHA-256 of the page URL (consistent per URL, like git short hashes)
- `{truncated_path}` is the URL path with `/` replaced by `_`, max 80 characters
- If filename collisions occur, a `-2`, `-3` etc. suffix is added before the extension
- `domManifest.json` is written when either env var is enabled, containing URL-to-file mappings
