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

Telemetry is sent **once per completed scan**. Nothing is sent while the scan is running, and nothing is sent if the scan is cancelled or no pages could be scanned. What counts as "a scan" depends on how you run Oobee:

| How you run Oobee | When telemetry is sent | Opt out with `OOBEE_DISABLE_TELEMETRY` |
| ----------------- | ---------------------- | -------------------------------------- |
| Command line (`npm run cli`) or interactive mode (`npm start`) | When the scan finishes and the report is generated. | Yes |
| [Oobee Desktop](https://github.com/GovTechSG/oobee-desktop) | When the scan finishes. Desktop also sends its own app events; see its [TELEMETRY.md](https://github.com/GovTechSG/oobee-desktop/blob/main/TELEMETRY.md). | Scan summary only |
| Node.js library (`@govtechsg/oobee`), using `init()` (for example, in Cypress or Playwright tests) | When you call `terminate()` and at least one page was scanned. | Yes |
| Node.js library, using `scanPage()` or `scanHTML()` | On **every call**, after the results are returned. | Yes |
| Node.js library, using `scanCustomFlow()` | When the custom flow finishes and the report is generated. | Yes |
| Browser client scanner (`oobee-client-scanner.js`) | On **every call** to `window.oobee.scan()`, from the browser of whoever loads the page. | No; see [Browser client scanner](#browser-client-scanner) |

If you call `scanPage()` or `scanHTML()` in a loop or a CI job, each call is counted as a separate scan.

### About you

| Data | Where it comes from |
| ---- | ------------------- |
| Name and email address | The `-k "Name:email"` value on the command line, the details entered in Oobee Desktop or interactive mode, or the `name` and `email` you pass to the library functions (`init()`, `scanPage()`, `scanHTML()`, `scanCustomFlow()`). |
| Anonymous user ID | A random ID (UUID) read from `userData.txt`, if that file exists on your machine (see [Where data is stored on your machine](#where-data-is-stored-on-your-machine)). It lets us count returning users without relying on your email. If there is no `userData.txt`, scans are sent without a user ID. |

### About the scan

| Data | Notes |
| ---- | ----- |
| Website scanned | The URL you started the scan from and, if it redirected, the URL it ended up at. Usage analytics (Sentry) receives **only the host name** (for example, `www.example.gov.sg`), with no path, query string or credentials. Local file scans are reported as `file://redacted`. For `scanPage()`, this is the URL of the first page passed in. For `scanHTML()`, it is the `pageUrl` you pass in (default `raw-html`, which is reported as `unknown`). |
| Scan type | For example: website, sitemap, custom flow, intelligent or local file. Library calls to `scanPage()`, `scanHTML()` and `scanCustomFlow()` are reported as custom flow. |
| Browser | The browser the scan used (Chrome, Edge or Chromium). |
| Oobee version | The version number of Oobee. |
| Page counts | The number of pages scanned, pages skipped and redirects followed. |
| Optional tags | Values you choose to add: `--metadata` / `-q`, `--websiteTag` / `-z`, `OOBEE_TAGGED_WEBSITE`, `OOBEE_SCAN_METADATA`, `OOBEE_SCAN_PRODUCT`, and the `scanSource` option of the library functions (see [Tagging your scans](#tagging-your-scans)). |

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

For the Node.js library, set the variable in the environment of the process that imports `@govtechsg/oobee` (for example, your test runner or CI job):

```shell
OOBEE_DISABLE_TELEMETRY=1 npx playwright test
```

When this is set:

- Nothing is sent to Sentry or Google Forms. Your name, email, scanned URL and user ID never leave your machine.
- On the command line, the `-k "Name:email"` flag becomes optional, so you can run scans non-interactively (for example, in CI) without providing personal details.
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
| `scanSource` (library option for `scanPage()`, `scanHTML()` and `scanCustomFlow()`) | Labels which product or integration ran the scan. Takes precedence over `OOBEE_SCAN_PRODUCT`. |

Don't put secrets or personal information in these values; they are sent as-is.

## Browser client scanner

The client scanner (`oobee-client-scanner.js`) is a script you add to a web page so the page can scan itself in the browser. It works differently from the rest of Oobee:

- **It runs in the browser of whoever loads the page.** If you add it to a site, each visitor whose browser calls `window.oobee.scan()` sends telemetry, not just you.
- **It is sent on every `window.oobee.scan()` call**, to a separate Sentry project. Nothing is sent to Google Forms.
- **`OOBEE_DISABLE_TELEMETRY` has no effect.** The variable is read by Node.js, and the script runs in the browser. There is currently no option in the script to turn telemetry off.
- **It has no anonymous user ID.** The script can't read `userData.txt`.

Each event contains:

| Data | Notes |
| ---- | ----- |
| Name and email address | Only if you pass them as `userInfo: { name, email }` to `window.oobee.scan()`. If you leave `userInfo` out, no name or email is sent. |
| Page scanned | The page's origin and path (for example, `https://www.example.gov.sg/services/apply`). The query string and `#` fragment are removed. Unlike the other modes, the **path is included**. |
| Oobee version | The version of Oobee the script was built from. |
| Issue counts | The number of distinct issues and total occurrences in each of *Must Fix*, *Good to Fix* and *Manual Review Required*, and the number of occurrences of each WCAG success criterion. |

HTML snippets are not sent. The script loads the Sentry SDK from `browser.sentry-cdn.com` (checked against a pinned integrity hash) and turns off all of the SDK's automatic features, so it only sends this one event. It doesn't capture errors, console output, network requests, page performance or session data from your page.

If you embed the client scanner on a site with visitors, tell them about this in your own privacy notice. If your content security policy blocks `browser.sentry-cdn.com` or `*.ingest.us.sentry.io`, the scan still works and no telemetry is sent.

## Where data is stored on your machine

Your name, email and anonymous user ID can be stored in a file called `userData.txt`. This file is created by:

- [Oobee Desktop](https://github.com/GovTechSG/oobee-desktop), when you complete its onboarding screen, or
- interactive mode (`npm start`), which saves the name and email you enter.

The command-line mode (`npm run cli`) does not create this file. It only reads the anonymous user ID from it if it already exists, which is how scans on a machine with Oobee Desktop installed are linked to the same user ID.

| Platform | Location |
| -------- | -------- |
| Windows | `%APPDATA%\Oobee\userData.txt` |
| macOS | `~/Library/Application Support/Oobee/userData.txt` |
| Linux | `~/.config/oobee/userData.txt` |

Deleting this file removes the stored anonymous user ID. A new one is generated only when Oobee Desktop or interactive mode creates the file again.

## Privacy

Collection and use of this data follow [GovTech's Privacy Policy](https://www.tech.gov.sg/privacy/) and the [Oobee Privacy Statement](https://go.gov.sg/oobee-privacy-statement). For questions or requests about your data, please [open an issue](https://github.com/GovTechSG/oobee/issues) or contact the Oobee team.
