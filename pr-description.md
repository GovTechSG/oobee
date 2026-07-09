## feat: Page DOM and Screenshot Capture for UA Testing

### Summary

- Adds `OOBEE_SAVE_DOM` env var to save the full-page DOM HTML for each scanned page
- Adds `OOBEE_SAVE_PAGE_SCREENSHOT` env var to save full-page desktop and mobile viewport screenshots for each scanned page
- Generates a `dom-manifest.json` mapping each page URL to its hash, saved file paths, and any errors encountered during capture
- Supported across **all scan types**: Website, Sitemap, Intelligent, LocalFile, and Custom

### How it works

| Env Variable | Effect |
|---|---|
| `OOBEE_SAVE_DOM=1` | Saves full DOM to `<results>/page-doms/<hash>-<truncated_path>.html` |
| `OOBEE_SAVE_PAGE_SCREENSHOT=1` | Saves desktop PNG to `page-doms/desktop-page-screenshots/` and mobile PNG to `page-doms/mobile-page-screenshots/` |

- **Hash**: 7-character SHA-256 of the page URL (consistent, like git short hashes)
- **Truncated path**: URL pathname with `/` replaced by `_`, max 80 chars, for human readability
- **Filename collisions**: Resolved by appending `-2`, `-3`, etc. before the file extension
- **Mobile viewport**: Width derived programmatically from Playwright's `devices['iPhone 11']` profile. The viewport is resized in-place (no separate tab), then restored to the original desktop size
- **Manifest**: `page-doms/dom-manifest.json` is written when either env var is enabled

### Output structure

```
results/<token>/page-doms/
├── <hash>-<truncated_path>.html              # Full DOM (OOBEE_SAVE_DOM)
├── dom-manifest.json                         # URL → file path mapping
├── desktop-page-screenshots/
│   └── <hash>-<truncated_path>.png
└── mobile-page-screenshots/
    └── <hash>-<truncated_path>.png
```

### Example `dom-manifest.json`

```json
{
  "generatedAt": "2026-07-06T13:22:06.000Z",
  "pages": [
    {
      "url": "https://example.com/about",
      "hash": "a1b2c3d",
      "domFile": "page-doms/a1b2c3d-about.html",
      "desktopScreenshot": "page-doms/desktop-page-screenshots/a1b2c3d-about.png",
      "mobileScreenshot": "page-doms/mobile-page-screenshots/a1b2c3d-about.png",
      "errors": []
    }
  ]
}
```

### Files changed

| File | Change |
|------|--------|
| `src/crawlers/pageCapture.ts` | **New** — core module for DOM/screenshot capture and manifest generation |
| `src/crawlers/crawlDomain.ts` | Calls `capturePageData()` after axe scan |
| `src/crawlers/crawlSitemap.ts` | Calls `capturePageData()` after axe scan |
| `src/crawlers/crawlLocalFile.ts` | Calls `capturePageData()` after axe scan |
| `src/crawlers/custom/utils.ts` | Calls `capturePageData()` after axe scan |
| `src/combine.ts` | Calls `writeManifest()` + `resetCaptureEntries()` post-crawl |
| `README.md` | Documents new env vars |
| `AGENTS.md` | Documents new env vars and output structure |

### Test plan

- [ ] Run sitemap scan with `OOBEE_SAVE_DOM=1` — verify `.html` files appear in `page-doms/`
- [ ] Run website scan with `OOBEE_SAVE_PAGE_SCREENSHOT=1` — verify desktop and mobile PNGs
- [ ] Run with both env vars set — verify `dom-manifest.json` contains all entries
- [ ] Verify filenames are flat (no nested subdirectories under `page-doms/`)
- [ ] Verify mobile screenshots use iPhone 11 width (375px)
- [ ] Verify desktop viewport is restored after mobile screenshot
- [ ] Run without env vars set — verify no `page-doms/` directory is created
- [ ] Test URL with long path (>80 chars) — verify truncation
- [ ] Test filename collision scenario — verify `-2` suffix applied
