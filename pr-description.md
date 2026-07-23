# fix: runCustom window duplication, overlay noise, SB injection, drop --no-sandbox

## Summary

Four related fixes to the `runCustom` (custom flow) code path on macOS, plus a codebase-wide cleanup:

- **Duplicate browser windows** on macOS (a spurious `about:blank` window appearing alongside the scan window).
- **Noisy overlay errors** in the console every time a new tab is opened or Chrome shows an error page.
- **Google Safe Browsing not blocking** in `runCustom` (malware test URLs loaded unchallenged).
- **`--no-sandbox` removed** from all launch args and documentation.

## Details

### 1. Duplicate browser window on macOS

Two independent sources, both fixed:

**a. UA-sniffing browser flashed visible.** `initModifiedUserAgent` briefly launches a fresh Chrome to read `navigator.userAgent`, then closes it. Its `headless` flag came from `CRAWLEE_HEADLESS`, so on macOS (no Xvfb) users saw a Chrome window pop up on top of the scan window.

- Fix: force `headless: true` on that transient launch in [`src/constants/common.ts`](src/constants/common.ts). The real scan window is unaffected — `runCustom` sets its own explicit `headless: false`.

**b. Persistent-context race left an orphan `about:blank`.** After the April 2026 switch to `launchPersistentContext` (#699), Playwright creates an initial `about:blank` page. `runCustom` did `context.pages().find(...) || context.newPage()` — but on some launches `context.pages()` is briefly empty. The fallback `newPage()` fires, and with `viewport: null` + `--start-maximized`, each page becomes its own OS window. Result: two windows.

- Fix: in [`src/crawlers/runCustom.ts`](src/crawlers/runCustom.ts), wait up to 5s for `context.waitForEvent('page')` before falling back to `newPage()`, then close any stray pages that materialized during launch.

### 2. Overlay noise on non-injectable URLs

Every new tab, error page, or new-tab-page produced errors like:

```
Overlay menu: failed to add page.evaluate: SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied
Overlay menu: failed to add page.evaluate: TypeError: Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment
```

`reconcileOverlayMenu` tried to inject on `about:blank` (no origin — blocks localStorage), `chrome://new-tab-page/` and `chrome-error://` (Trusted Types blocks `innerHTML`), etc.

- Fix: in [`src/crawlers/custom/utils.ts`](src/crawlers/custom/utils.ts), short-circuit `reconcileOverlayMenu` when the URL isn't `http(s)://` or `file://`. When the tab navigates to a supported scheme the next trigger reconciles the overlay normally.

### 3. Google Safe Browsing not blocking in runCustom

`crawlDomain` launches from a fresh empty `_pool` dir (SB store copied cleanly). `runCustom` launches from a **full clone of the user's real Chrome profile**, which already contains a `Safe Browsing/` folder with the user's own versioned store files. `injectSafeBrowsingDb`'s `copyDirectory` only overlays same-named files — leaving the user's differently-versioned files behind. The resulting mix looks inconsistent to Chrome's SB service and it disables local checks, so `testsafebrowsing.appspot.com/s/malware.html` loaded without an interstitial.

- Fix: in [`src/safeBrowsingProfile.ts`](src/safeBrowsingProfile.ts), `rmSync` the target's existing `Safe Browsing/` directory before copying the base profile's DB. Cross-platform safe (`recursive: true, force: true` is a no-op if the dir is absent). `crawlDomain` path unaffected since its `effectiveDir` is fresh.

### 4. Drop `--no-sandbox`

Removed from:
- [`src/constants/constants.ts`](src/constants/constants.ts): Docker launch args
- [`src/safeBrowsingProfile.ts`](src/safeBrowsingProfile.ts): Linux SB warmup Chrome args (also removed `--disable-setuid-sandbox`, which is only meaningful alongside `--no-sandbox`)
- [`AGENTS.md`](AGENTS.md): both doc mentions updated to reflect the new arg set

Additionally, Playwright itself pushes `--no-sandbox` by default. In [`src/constants/common.ts`](src/constants/common.ts) `getPlaywrightLaunchOptions`:
- On host OSes (macOS/Linux/Windows desktop): set `chromiumSandbox: true` so Playwright drops its default `--no-sandbox`, and Chrome no longer shows the "unsupported command-line flag: --no-sandbox" yellow banner.
- In containers (Docker / ECS Fargate): the sandbox can't start under default seccomp (no `CLONE_NEWUSER`), so `--no-sandbox` is left in place. Add `--test-type` there to tell Chrome this is a test harness — this suppresses both the "--no-sandbox" yellow banner and the "controlled by automated test software" bar.

## Cross-platform notes

- **macOS**: primary target for all four fixes; verified in user testing.
- **Linux/Docker**: unchanged behavior for the persistent-context race (rarely hits it — headless mode + fresh dirs). SB DB wipe is a no-op since the `_pool` dir path never has a pre-existing `Safe Browsing/`. `--no-sandbox` removal requires the Docker image to run Chrome with a normal user namespace or user-provided sandboxing — verify your container config before shipping.
- **Windows**: SB DB wipe uses Node's `fs.rmSync` with `force: true` so a locked file (unlikely here since this runs before Playwright launches Chrome) is swallowed by the surrounding `try/catch`.

## Test plan

- [ ] macOS + `-b chrome`: only one browser window opens (no duplicate `about:blank`).
- [ ] macOS: open a new tab manually during a scan — no `SecurityError` or `TrustedHTML` errors in console.
- [ ] macOS: run `oobee -u https://testsafebrowsing.appspot.com/s/malware.html` with `GOOGLE_SAFE_BROWSING=1` — Chrome shows the SB interstitial (not the raw page).
- [ ] Linux/Docker: existing scans still run headless without crashing under seccomp/user-namespace defaults.
- [ ] Regression: `crawlDomain` scans still work with SB enabled.
