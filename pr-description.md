## Summary

- Adds optional Google Safe Browsing URL protection, gated by `GOOGLE_SAFE_BROWSING=1` env var
- Blocks navigation to phishing, malware, and unwanted software URLs
- Blocked pages classified as "Blocked by Safe Browsing" in scan reports (not scanned)
- Works across all scan types: website crawl, sitemap crawl, intelligent sitemap, custom flows, and local file lists

## Platform behavior

| Platform | Mechanism | Details |
|----------|-----------|---------|
| **macOS** | System Chrome DB copy + warmup | Copies `Safe Browsing/` directory from system Chrome profile into scan profile. Falls back to spawning Chrome to download the hash-prefix DB. |
| **Docker Linux** | Chrome warmup with Xvfb | Spawns Chrome with standard protection (not enhanced) to download local hash-prefix databases. Xvfb provides a virtual display for headful mode (required for interstitials). |
| **Windows** | Not supported | Prints warning, scans proceed normally. |

## How it works

1. `warmupSafeBrowsingBaseProfile()` downloads the Safe Browsing hash-prefix DB by spawning Chrome with `safebrowsing.enabled=true, enhanced=false` and navigating to `google.com/generate_204`. Timeout configurable via `SB_DB_TIMEOUT_MS` (default 180s).
2. `injectSafeBrowsingDb()` copies the warmed DB + OHTTP key into each scan profile.
3. `getPlaywrightLaunchOptions()` removes Playwright default flags that suppress Safe Browsing (`--safebrowsing-disable-auto-update`, `--disable-client-side-phishing-detection`, `--disable-background-networking`, `--disable-component-update`).
4. `ensureXvfbForSafeBrowsing()` starts Xvfb on Linux when no DISPLAY is available, enabling headful mode for interstitial rendering.
5. Blocked pages are detected via:
   - `chrome-error://` URL in the request handler
   - `ERR_BLOCKED_BY_CLIENT` / `ERR_BLOCKED_BY_RESPONSE` in the failed request handler
6. `urlGuard.ts` allows `chrome-error://` protocol in `runCustom` so the interstitial warning is visible to users.
7. `getPreLaunchHook` in `commonCrawlerFunc.ts` injects Safe Browsing preferences (including OHTTP key) into each browser pool instance on rotation.

## Key changes

| File | Change |
|------|--------|
| `src/safeBrowsingProfile.ts` | DB warmup via Chrome spawn, injection into scan profiles, Xvfb helper, SB ignored args helper |
| `src/constants/common.ts` | `launchPersistentSafeContext()` wrapper; `getPlaywrightLaunchOptions()` removes SB-suppressing flags + forces headful; `cloneChromeProfilePreferences()` for OHTTP key inheritance |
| `src/crawlers/crawlDomain.ts` | `chrome-error://` + `ERR_BLOCKED_BY_CLIENT/RESPONSE` detection as "Blocked by Safe Browsing" |
| `src/crawlers/crawlSitemap.ts` | Same blocked-page detection |
| `src/crawlers/runCustom.ts` | Uses `launchPersistentSafeContext`; `allowChromeErrors` gated on env |
| `src/crawlers/guards/urlGuard.ts` | `allowChromeErrors` option for interstitial pages |
| `src/crawlers/commonCrawlerFunc.ts` | `getPreLaunchHook` injects Safe Browsing preferences into browser pool instances |
| `src/constants/constants.ts` | `STATUS_CODE_METADATA[3]`: "Blocked by Safe Browsing"; `/data/chrome-profile` writability check; `.apk` blacklisted |
| `Dockerfile` | Chrome install for SB; removed `start-gsb-novnc.sh`; sets `GOOGLE_SAFE_BROWSING=1` |
| `package.json` | `adm-zip>=0.6.0` override to fix 18 high-severity vulnerabilities |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `GOOGLE_SAFE_BROWSING=1` | Enable Safe Browsing protection |
| `SB_DB_TIMEOUT_MS` | Override DB download timeout (default 180000ms) |

## Behavior without GOOGLE_SAFE_BROWSING

When the env var is not set:
- No Safe Browsing DB download or injection
- No Xvfb startup or headful mode forcing
- `ignoreDefaultArgs` does not remove Safe Browsing flags
- All crawlers use standard Playwright launcher unchanged

## Test plan

- [x] macOS `runCustom`: phishing page shows interstitial (Dangerous Site warning)
- [x] macOS `crawlSitemap`: phishing/malware pages classified as "Blocked by Safe Browsing"
- [x] macOS `crawlDomain`: phishing/malware pages classified as "Blocked by Safe Browsing"
- [x] Docker `crawlDomain`: phishing/malware pages blocked
- [x] Non-phishing pages scan normally with Safe Browsing enabled
- [x] Without `GOOGLE_SAFE_BROWSING` env var, no behavior change (no overhead)
- [ ] arm64 Docker: prints notice, scans proceed without Safe Browsing
- [ ] Windows: prints warning, scans proceed without Safe Browsing
