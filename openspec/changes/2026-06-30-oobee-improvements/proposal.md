## Why

Oobee accumulated critical crawler hardening fixes across many commits, but those behaviors are only implicit in code and changelogs. A formal OpenSpec baseline is needed so future refactors preserve these web-crawling guarantees and edge-case protections.

## What Changes

- Create first-class OpenSpec capability specs for crawler rate control, sitemap resiliency, auth/header safety, redirect/hostname boundaries, custom-flow URL guard behavior, and report artifact resiliency.
- Convert critical post-`8cf8f9d937c1b4e320b81a35425ba5040b8c9fc5` behaviors into normative SHALL/MUST requirements with explicit scenarios.
- Add an implementation-oriented task breakdown for maintaining and validating these crawler specifications over time.

## Capabilities

### New Capabilities
- `crawl-rate-control`: Governs max-pages accounting, adaptive concurrency, and failure circuit breaking under WAF/rate-limited sites.
- `sitemap-resilience`: Defines robust sitemap discovery/fetch/parsing behavior including XSL and image-sitemap edge cases.
- `auth-header-isolation`: Prevents auth header leakage/CORS regressions and suppresses unnecessary Playwright header-rewrite overhead.
- `redirect-boundary-enforcement`: Enforces canonical URL/hostname comparison and in-scope redirect handling rules.
- `custom-flow-guard-overlay`: Hardens custom-flow URL guard redirects and overlay behavior across platform/headful differences.
- `report-artifact-resilience`: Preserves report generation stability, intermediate data integrity, and retry-safe error accounting.

### Modified Capabilities
- None.

## Impact

- Affected areas: `src/crawlers/*`, `src/constants/common.ts`, `src/utils.ts`, `src/mergeAxeResults.ts`, `src/mergeAxeResults/itemsStore.ts`, and custom-flow guard modules.
- Operational impact: tighter guarantees for large crawls, authenticated scans, sitemap-heavy targets, and Windows-specific cleanup stability.
- Maintenance impact: future crawler/report changes can be validated against explicit OpenSpec requirements instead of inferred tribal knowledge.