# How Oobee Scanning Works

## Table of Contents

**Part 1: How Scanning Affects Accessibility Results**
- [What Oobee Does](#what-oobee-does)
- [What Gets Scanned](#what-gets-scanned)
- [Scan Strategy](#scan-strategy)
- [Why Some Pages Are Not Scanned](#why-some-pages-are-not-scanned)
- [What Affects Result Accuracy](#what-affects-result-accuracy)
- [Understanding the Report](#understanding-the-report)
- [Choosing a Page Budget](#choosing-a-page-budget)
- [Tips for Better Scan Results](#tips-for-better-scan-results)
- [Recommended Hardware](#recommended-hardware)

**Part 2: Technical Details**
- [Scan Modes](#scan-modes)
- [Page Discovery Mechanics](#page-discovery-mechanics)
- [Concurrency and Ordering](#concurrency-and-ordering)
- [Adaptive Concurrency and Rate Limiting](#adaptive-concurrency-and-rate-limiting)
- [Error Handling Pipeline](#error-handling-pipeline)
- [Page Classification](#page-classification)
- [Page Budget](#page-budget)
- [Browser Pool and Session State](#browser-pool-and-session-state)

---

## Part 1: How Scanning Affects Accessibility Results

### What Oobee Does

Oobee visits web pages using a real browser (Chrome/Chromium) and runs automated accessibility checks against each page. It produces a report of issues found, organized by severity (must fix, good to fix, needs review).

### What Gets Scanned

Oobee supports three main scan modes:

- **Intelligent** (recommended): Automatically finds your sitemap via robots.txt, scans all sitemap pages, then follows links to discover any pages the sitemap missed. This gives the most complete and predictable coverage — the sitemap ensures known pages are scanned in a consistent order, while link discovery catches pages the sitemap doesn't list.
- **Sitemap**: Scans only the pages listed in your website's sitemap XML file. You provide the sitemap URL, and Oobee visits each page listed in it. Good when you know your sitemap is comprehensive.
- **Website**: Starts at one page and follows links to discover more pages on the same site. Discovers pages organically by extracting links from each page it visits. Coverage depends heavily on site navigation structure.

Not all pages on a site will necessarily be scanned. The scanner stops when it reaches the page limit, time limit, or runs out of discoverable pages.

### Scan Strategy

The **strategy** (`-s`) controls which discovered links are followed. It is supported in Intelligent, Website, and Sitemap modes:

- **`same-domain`** (default): Follows links on the same registered domain, including subdomains.
- **`same-hostname`**: Only follows links on the exact same hostname (after stripping `www.`).
- **`ignore`** (sitemap mode only): No URL filtering — all URLs in the sitemap are scanned regardless of domain. This is the default for standalone sitemap scans.

**Example**: Scanning `https://www.acme.gov.sg/services/home`

| Discovered Link | `same-domain` | `same-hostname` |
|-----------------|:---:|:---:|
| `https://www.acme.gov.sg/services/faq` | Followed | Followed |
| `https://acme.gov.sg/about` | Followed | Followed (www. stripped) |
| `https://employer.acme.gov.sg/dashboard` | Followed (same domain `acme.gov.sg`) | Skipped (different hostname) |
| `https://blog.acme.gov.sg/news` | Followed (same domain `acme.gov.sg`) | Skipped (different hostname) |
| `https://www.other.gov.sg/resources` | Skipped (different domain) | Skipped (different hostname) |

Choosing the right strategy affects coverage:
- Use `same-domain` when your site spans multiple subdomains and you want a holistic view.
- Use `same-hostname` when you only care about one specific subdomain, or when following subdomains would waste budget on unrelated content (e.g., a separate blog platform).
- The strategy only filters links discovered dynamically during the crawl — it does NOT affect which pages are listed in the sitemap.

### Why Some Pages Are Not Scanned

Pages may be skipped for several reasons:

- **Not an HTML document**: The URL points to an image, PDF, spreadsheet, video, or other file type that cannot be checked for web accessibility.
- **Blocked by the server**: The website's firewall or rate limiter returned an error (commonly 403 Forbidden). This is especially common on large scans where the server detects rapid automated requests.
- **Requires authentication the scanner doesn't have**: Download endpoints, APIs, or pages behind a different login system than the one whose cookies were provided.
- **Took too long to respond**: Pages that don't load within 30 seconds are skipped.
- **Budget exhausted**: The scanner reached its page limit or time limit before getting to this page.
- **Redirected out of scope**: The page redirected to a different domain that's outside the scan's strategy filter.

### What Affects Result Accuracy

- **Dynamic content**: Pages with heavy JavaScript may produce slightly different results on different runs because content loads asynchronously. The scanner waits for the page to stabilize, but some elements may appear after the check completes.
- **Rate limiting**: When a site blocks the scanner, it reduces its speed and retries, but some pages may be permanently lost if the site continues blocking. Accuracy improves with higher page budgets and longer scan durations.
- **Authentication**: The scanner sees pages as a logged-out visitor unless you provide authenticated browser cookies. Some page content is only visible when logged in.
- **Non-deterministic discovery** (website mode): Pages are discovered by following links. Because multiple pages load simultaneously, the order in which links are found varies between runs. A page discovered on one run may not be found on another if the scanner hits its limit first.
- **Mid-scan redirects**: If a page redirects while being scanned (JavaScript redirect, meta refresh), the accessibility check may run on the redirect target rather than the original page.

### Understanding the Report

The scan report categorizes URLs into three groups:

- **Pages Scanned**: Pages where the accessibility check completed successfully. These have full results.
- **Pages Not Scanned**: Pages that were found but couldn't be checked. The report shows why (e.g., "403 - Forbidden", "Web Crawler Errored", "access restrictions").
- **Unsupported Documents**: URLs that point to non-web-page content — images, PDFs (when PDF scanning is disabled), downloads, media files. These are not accessibility-checkable.

A higher "Pages Scanned" count relative to total discovered URLs means more comprehensive coverage.

### Choosing a Page Budget

The page budget (`-p`) determines how many pages are scanned. Choosing the right number is important for getting a representative picture of your site's accessibility:

- **Small sites (< 100 pages)**: Set the budget equal to or above your total page count. You want full coverage.
- **Medium sites (100-1000 pages)**: A budget of 500-1000 pages gives a good representative sample. Most accessibility issues repeat across page templates, so scanning a subset often reveals the same patterns as scanning everything.
- **Large sites (1000+ pages)**: A budget of 2000-5000 pages typically captures all unique page templates and their issues. Beyond this, you'll mostly find the same issue types on more pages.

A representative scan means enough pages have been checked that the issues found reflect the overall accessibility posture of the site. If your site has 20 page templates, scanning 100 pages is likely sufficient. If it has hundreds of unique layouts, you need a larger budget.

### Tips for Better Scan Results

- **Use Intelligent mode** for the most complete coverage — it combines sitemap accuracy with link-discovery thoroughness. This is the recommended mode for all production scans.
- **Set an appropriate page budget** (`-p`) — too low and you miss page templates; too high and you waste time scanning duplicate layouts. Start with 2000 for large sites and adjust.
- **Provide authenticated cookies** for sites behind login (clone your Chrome profile with `-u`).
- **Increase scan duration** (`-d 3600`) for large sites to give the scanner enough time.
- **Use `same-hostname` strategy** (`-s same-hostname`) to avoid following links to subdomains or external sites.
- **Run from a residential IP** if possible — datacenter IPs are more likely to be rate-limited by firewalls.

### Recommended Hardware

Scanning is CPU and memory intensive — each page runs in a real browser with full JavaScript execution.

| Scan Size | Hardware | Max Concurrency | Expected Duration |
|-----------|----------|-----------------|-------------------|
| 1,000 pages | ECS Fargate, 2 vCPU / 4 GB RAM | 10 (`-t 10`) | 2-3 hours |
| 5,000 pages | Laptop/desktop, 8 cores / 12 threads, 24 GB RAM | 25 (`-t 25`) | 2-3 hours |

**Oobee Desktop** runs with `OOBEE_FAST_CRAWLER=true`, which means concurrency scales up aggressively to the maximum (25) as fast as possible. This is suitable for desktop machines with adequate CPU and RAM, but may cause stability issues on low-powered devices.

Setting concurrency above 25 (e.g. `-t 50`) is possible but generally provides no speed improvement — either the target website rate-limits the extra requests, or the machine itself becomes the bottleneck (CPU saturation, memory pressure). In practice, 25 is the sweet spot for most hardware and most sites.

For smaller environments (Fargate, low-spec VMs), reduce concurrency to 10 to avoid overwhelming the container's limited CPU and memory. Higher concurrency on constrained hardware causes thrashing, not faster scans.

**Slow scan mode** (`-c website` with click discovery): The second-pass click-discovery loop visits every scanned page sequentially and clicks each interactive element with delays. On large sites (1000+ pages), this can add many hours to the scan. Use Intelligent mode instead — it discovers links via `<a>` tag extraction during the sitemap phase without the expensive click loop.

These estimates assume the target site doesn't aggressively rate-limit. Actual times depend on page complexity, server response speed, and WAF behavior.

**Disk space**: Ensure at least 20 GB free for a 5,000-page scan. This accounts for browser pool directories (~30-50 MB active at any time, but accumulates if cleanup is delayed), intermediate per-page JSON results (~2-5 KB each, ~10-25 MB total), uncompressed report artifacts (HTML report with embedded data can reach 500 MB+ before compression), and temporary PDF/screenshot storage if enabled. Smaller scans (1,000 pages) can get by with 5-10 GB free. Running out of disk space mid-scan causes hard failures (ENOSPC).

**Slow machines degrade both coverage and accuracy**: Oobee has fixed timeouts — 30 seconds for a page to start loading, 90 seconds total for the page to load and be scanned. On an underpowered machine, Chromium itself runs slowly, which means:

- **Dropped pages**: Pages that would load fine on a fast machine may hit the 30s navigation timeout simply because the CPU can't parse JavaScript fast enough. These pages are retried 3 times and then recorded as errors.
- **Inaccurate DOM state**: Poorly-coded websites that rely on JavaScript to render content (SPAs, lazy-loaded components, deferred widgets) may not finish rendering before the scanner checks them. On a fast machine, the DOM mutation observer (5s quiet window) catches most dynamic content. On a slow machine, JavaScript execution is delayed — the DOM appears "settled" (no mutations detected) even though rendering hasn't started yet. This means the accessibility scan runs against an incomplete page, producing false negatives (missing issues that exist on the fully-rendered page) or false positives (flagging placeholder content that would normally be replaced).
- **Thermal throttling cascade**: Sustained CPU load triggers thermal throttling on laptops, which makes subsequent pages even slower, leading to more timeouts and increasingly stale DOM snapshots. A scan that starts fine can degrade badly in its second hour.

Desktop machines or cloud instances with adequate cooling and dedicated CPU cores are strongly preferred for large scans.

**Docker deployments**: Ensure the container has access to the recommended CPU and memory — Chromium under-performs significantly when CPU-throttled or memory-constrained (swapping). Allocate sufficient storage volume and avoid thin-provisioned storage that can exhaust mid-scan.

---

## Part 2: Technical Details

### Scan Modes

| Mode | Entry Point | Discovery Method | Page Order |
|------|-------------|------------------|------------|
| Website | `crawlDomain.ts` | BFS via `enqueueLinks` + click discovery | Non-deterministic |
| Sitemap | `crawlSitemap.ts` | URLs from sitemap XML | Mostly FIFO from XML |
| Intelligent | `crawlIntelligentSitemap.ts` | Sitemap → `enqueueLinks` → domain supplement | Sitemap-ordered, then non-deterministic |

### Page Discovery Mechanics

**Sitemap mode:**
- URLs parsed from sitemap XML into a Crawlee `RequestList` (ordered array)
- In intelligent mode: URLs sorted by closeness to user URL + last-modified date
- `RequestQueue` created alongside for discovered `<a>` links (intelligent mode) and download/403 re-enqueue
- Crawlee processes `RequestList` first, then `RequestQueue` items

**Website (domain) mode:**
- Seed URL added to `RequestQueue`
- Each scanned page runs `enqueueLinks` to extract `<a>` tags matching the strategy filter
- Click-discovery pass: re-visits seed-hostname pages, clicks interactive elements, captures popup/navigation URLs
- Second-pass click-discovery is skipped in intelligent mode (already covered by sitemap + link extraction)

**Strategy filter** restricts which discovered URLs are followed:
- `same-hostname`: Only URLs on the same hostname (after stripping `www.`)
- `same-domain`: Same registered domain (includes subdomains)
- `all`: Follow all URLs regardless of domain

**Pre-navigation filtering:**
- `blackListedFileExtensions`: Skips known non-HTML extensions (images, media, documents) before browser navigates
- `disallowedListOfPatterns`: Skips non-HTTP protocols (mailto:, tel:, javascript:, etc.)
- `robots.txt` disallow rules: Checked before enqueue

### Concurrency and Ordering

- Default max concurrency: 25 simultaneous pages (configurable via `-t`)
- Pages process in parallel — completion order depends on server response times, not queue order
- **Sitemap mode**: `RequestList` provides FIFO order to workers, but with 25 workers, pages 1-25 start together and complete in arbitrary order
- **Domain mode**: Entirely non-deterministic — faster pages discover and enqueue links first, which get processed before slower pages' links
- **Practical implication**: Two runs of the same sitemap scan produce the same set of pages (deterministic input), but a domain scan may find different pages depending on timing

### Adaptive Concurrency and Rate Limiting

The `CrawlRateController` manages concurrency dynamically:

- **On HTTP 4xx/5xx**: Concurrency halved (floor 1). Consecutive failure counter incremented.
- **On success**: After 10 consecutive successes, concurrency increases by 2 (up to original max). Counter reset.
- **Circuit breaker**: After 100 consecutive failures (`OOBEE_CONSECUTIVE_MAX_RETRIES`), the crawl aborts gracefully.
- **403 retry**: First 403 re-enqueued with `rateLimitRetried` flag (doesn't count toward circuit breaker). Second 403 is permanent failure.

Crawlee's `retryOnBlocked: true` detects blocked responses (403, 429) and rotates sessions automatically before the request reaches the handler.

### Error Handling Pipeline

```
Page Request
    ↓
[Navigation: 30s timeout]
    ↓ success                    ↓ failure (timeout, network error, blocked)
requestHandler                   Crawlee retries (up to 3 times)
    ↓                                ↓ all retries exhausted
[waitForPageLoaded: 10s]         failedRequestHandler
[DOM mutation observer: 5s]          ↓
[runAxeScript: axe-core scan]    Final classification:
    ↓                            - "Download is starting" → Unsupported Document
Results pushed to dataset        - 403 (first time) → re-enqueue for retry
                                 - 403 (second time) → circuit breaker check → error
                                 - Other → "Web Crawler Errored"
```

- `requestHandler` processes successful navigations. Errors thrown here are caught by Crawlee and the page is retried.
- `failedRequestHandler` fires only after all retries are exhausted. This is where final error classification happens.
- `requestHandlerTimeoutSecs: 90` — if the entire handler (navigation + scan) takes longer, Crawlee kills and retries.
- Errors are never recorded in the `requestHandler` catch block — only in `failedRequestHandler` — to avoid duplicates for pages that succeed on retry.

### Page Classification

| Array | Report Category | Trigger |
|-------|----------------|---------|
| `urlsCrawled.scanned` | Pages Scanned | Successful axe scan |
| `urlsCrawled.error` | Pages Not Scanned | All retries exhausted |
| `urlsCrawled.invalid` | Pages Not Scanned | HTTP 3xx+ status or non-whitelisted content-type |
| `urlsCrawled.forbidden` | Pages Not Scanned | (reserved) |
| `urlsCrawled.userExcluded` | Unsupported Documents (if `httpStatusCode=1`) or Pages Not Scanned | Blacklisted extension, non-HTML content-type, excluded pattern, download URL |

The report splits "Pages Not Scanned" further:
- Items with `httpStatusCode === 1` → **Unsupported Documents** tab
- Everything else → **Pages Not Scanned** tab

Key `STATUS_CODE_METADATA` values:
- `[1]` = "Not A Supported Document"
- `[2]` = "Web Crawler Errored"
- `[200]` = "Oobee was not able to scan the page due to access restrictions or compatibility issues"
- `[403]` = "403 - Forbidden"
- `[599]` = "Uncommon Response Status Code Received"

### Page Budget

`maxRequestsPerCrawl` counts **successful scans only**, not total requests:
- A page that errors 3 times and succeeds on the 4th still counts as 1
- A page that errors permanently doesn't consume budget
- In intelligent mode, budget is shared across phases: `remaining = max - sitemapPhaseScanned`
- `scanDuration` is a hard time limit (seconds) that aborts all phases when exceeded

### Browser Pool and Session State

- Browser instance retired after 500 pages → new browser launched
- Each browser gets its own `_pool{N}` directory with cookies cloned fresh from the pristine profile
- The base `userDataDirectory` is never modified by a running browser — always treated as read-only source
- Pool directories cleaned mid-scan (when new browser launches) and at scan end
- `--disk-cache-size=10485760` (10MB) caps per-browser cache to prevent storage bloat
- Browser rotation means session cookies stay fresh (cloned from original) but any server-side session tracking may see the crawler as a "new visitor" after rotation
