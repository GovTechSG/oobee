# Telemetry

Oobee sends usage information to the Oobee team at GovTech each time you complete a scan. This page explains what is collected, why, and how to turn it off.

## Why we collect telemetry

We use telemetry to understand:

- **Adoption.** How many people and teams are using Oobee, and whether usage is growing across releases.
- **Who our users are.** Which organisations, sectors and industries use Oobee (for example, government agencies or private-sector companies), so we can prioritise the support, guides and features that matter most to them.
- **The types and scope of accessibility issues.** Which WCAG success criteria fail most often and how many issues a typical site has. This tells us which checks, explanations and fix guidance are most valuable, and helps us track the overall state of web accessibility over time.
- **How often and how widely scans are run.** How frequently people scan, which scan types they use (website crawl, sitemap, custom flow, local file, and so on), how many pages a typical scan covers, and which browsers they run on.
- **Product health.** Which Oobee versions are in use, so we know when it is safe to retire older releases and whether a release has introduced problems.

We do not use telemetry for advertising, and we do not sell it.

## What is collected

Telemetry is sent **once at the end of each completed scan**. Nothing is sent while the scan is running, and nothing is sent if the scan is cancelled or no pages could be scanned.

### About you

| Data | Where it comes from |
| ---- | ------------------- |
| Name and email address | The `-k "Name:email"` value you provide when running a scan. |
| Anonymous user ID | A random ID (UUID) generated on your machine the first time you run Oobee and stored in `userData.txt` (see [Where data is stored on your machine](#where-data-is-stored-on-your-machine)). It lets us count returning users without relying on your email. |

### About the scan

| Data | Notes |
| ---- | ----- |
| Website scanned | The URL you started the scan from and, if it redirected, the URL it ended up at. Usage analytics (Sentry) receives **only the host name** (for example, `www.example.gov.sg`), with no path, query string or credentials. Local file scans are reported as `file://redacted`. |
| Scan type | For example: website, sitemap, custom flow, intelligent or local file. |
| Browser | The browser the scan used (Chrome, Edge or Chromium). |
| Oobee version | The version number of Oobee. |
| Page counts | The number of pages scanned, pages skipped and redirects followed. |
| Optional tags | Values you choose to add: `--metadata` / `-q`, `--websiteTag` / `-z`, `OOBEE_TAGGED_WEBSITE`, `OOBEE_SCAN_METADATA` and `OOBEE_SCAN_PRODUCT` (see [Tagging your scans](#tagging-your-scans)). |

### About the accessibility issues found

| Data | Notes |
| ---- | ----- |
| Issue counts by category | The number of distinct issues and total occurrences in each of *Must Fix*, *Good to Fix* and *Manual Review Required*. |
| WCAG breakdown | The number of occurrences of each WCAG success criterion (for example, `1.1.1 Non-text Content: 12`). |
| Issue counts by rule | The number of occurrences of each accessibility rule that failed. |
| Cleaned-up HTML snippets (selected rules only) | For a set of form and ARIA rules (for example, missing labels or invalid ARIA attributes), Oobee sends the **structure** of the failing element so we can improve fix suggestions. Before sending, Oobee removes all text content and all attributes except a short allow-list of structural ones (such as `type`, `role` and `aria-*`). Values that could identify content, such as `href`, `src`, `name`, `value`, `title` and `aria-label`, are replaced with `...`. |

### What is *not* collected

- Page content, page text, screenshots or the generated report.
- Full page URLs, URL paths or query strings (usage analytics only sees the host name; see above).
- Cookies, passwords, authentication headers or anything you pass with `-m` / `--header`.
- Files on your computer.

## Where telemetry is sent

| Destination | Purpose |
| ----------- | ------- |
| [Sentry](https://sentry.io) (`*.ingest.us.sentry.io`) | Usage analytics: scan counts, WCAG breakdowns, versions and user ID. |
| Google Forms (`docs.google.com`) | Scan summary records: name, email, scanned URL, scan type, page counts and the issue summary described above. |

If these services can't be reached (for example, behind a firewall), the scan still completes and your report is unaffected.

## How to turn telemetry off

Set the `OOBEE_DISABLE_TELEMETRY` environment variable to `1`, `true` or `yes`:

```shell
# macOS / Linux
OOBEE_DISABLE_TELEMETRY=1 npm run cli -- -c website -u https://example.com

# Windows PowerShell
$env:OOBEE_DISABLE_TELEMETRY = "1"
npm run cli -- -- -c website -u https://example.com
```

When this is set:

- Nothing is sent to Sentry or Google Forms. Your name, email, scanned URL and user ID never leave your machine.
- The `-k "Name:email"` flag becomes optional, so you can run scans non-interactively (for example, in CI) without providing personal details.
- Scans and reports are unaffected.

To opt out permanently, add the variable to your shell profile, CI pipeline settings or container environment.

## Tagging your scans

If you run Oobee for a team or across many sites, you can attach your own labels to your telemetry so that usage can be attributed correctly. These are optional and only take effect when telemetry is on.

| Option | What it does |
| ------ | ------------ |
| `-z, --websiteTag` / `OOBEE_TAGGED_WEBSITE` | Labels the website being scanned. The CLI flag takes precedence. |
| `-q, --metadata` | A JSON string of extra information to attach to the scan record. |
| `OOBEE_SCAN_METADATA` | Overrides the website host reported to usage analytics. |
| `OOBEE_SCAN_PRODUCT` | Labels which product or integration ran the scan. |

Don't put secrets or personal information in these values; they are sent as-is.

## Browser client scanner

If you embed the Oobee client scanner script (`oobee-client-scanner.js`) in a web page, each call to `window.oobee.scan()` sends a similar summary to a separate Sentry project. That summary contains the page's origin and path (no query string or fragment), the WCAG and issue counts, the Oobee version, and any name and email you pass in. The script loads the Sentry SDK from `browser.sentry-cdn.com` and only sends this one event. It doesn't capture errors, console output, network requests or performance data from your page.

## Where data is stored on your machine

Oobee keeps your name, email and anonymous user ID in a file called `userData.txt`:

| Platform | Location |
| -------- | -------- |
| Windows | `%APPDATA%\Oobee\userData.txt` |
| macOS | `~/Library/Application Support/Oobee/userData.txt` |
| Linux | `~/.config/oobee/userData.txt` |

Deleting this file resets your anonymous user ID. A new one is generated the next time you scan.

## Privacy

Collection and use of this data follow [GovTech's Privacy Policy](https://www.tech.gov.sg/privacy/) and the [Oobee Privacy Statement](https://go.gov.sg/oobee-privacy-statement). For questions or requests about your data, please [open an issue](https://github.com/GovTechSG/oobee/issues) or contact the Oobee team.
