## ADDED Requirements

### Requirement: Comprehensive sitemap discovery and recursion
The scanner MUST discover sitemap sources from `robots.txt` directives and known sitemap paths, and MUST recursively process sitemap indexes.

#### Scenario: Robots and probed sitemap paths are combined
- **WHEN** intelligent sitemap crawl starts
- **THEN** sitemap URLs from both `robots.txt` and known path probing MUST be included for discovery

#### Scenario: Sitemap index recursion
- **WHEN** a sitemap index contains child sitemap URLs
- **THEN** each child sitemap MUST be fetched and parsed recursively until URL sets are resolved

### Requirement: XSL-safe XML fetching strategy
Sitemap fetching MUST use a strategy resilient to XML stylesheet and long-lived network resources.

#### Scenario: Avoid networkidle deadlocks
- **WHEN** fetching sitemap XML via browser automation
- **THEN** navigation MUST wait for `domcontentloaded` (not `networkidle`) to avoid hangs/timeouts caused by stylesheet-linked resources

#### Scenario: Preserve raw XML semantics
- **WHEN** response text is available from sitemap fetch
- **THEN** raw `response.text()` MUST be preferred over transformed DOM extraction to preserve `<sitemapindex>` and `<urlset>` structures

### Requirement: Non-page sitemap feeds exclusion
Image sitemap feeds and non-page sitemap entries MUST be excluded from crawl URL enqueueing.

#### Scenario: Skip image sitemap feeds
- **WHEN** sitemap content resolves to image-only feed structures
- **THEN** those entries MUST be ignored for crawl queue construction

### Requirement: Accurate sitemap discovery accounting
Total discovered sitemap links MUST be tracked independently from scan success counts for reporting.

#### Scenario: Report discovered links count
- **WHEN** sitemap discovery completes
- **THEN** the scanner MUST store total discovered count for `scanData.json` diagnostics, even if crawl success count is lower

#### Scenario: Reset per scan
- **WHEN** a new scan starts
- **THEN** previous sitemap discovery counters MUST be reset to prevent cross-scan contamination

### Requirement: User-agent for sitemap probing
All sitemap discovery network contexts MUST use the patched non-headless user-agent to avoid WAF rejection.

#### Scenario: Headless user-agent patching for sitemap probing
- **WHEN** browser automation fetches robots.txt or sitemap XML in headless mode
- **THEN** the context MUST send `OOBEE_USER_AGENT` (with `HeadlessChrome` replaced by `Chrome`) to prevent bot-blocking