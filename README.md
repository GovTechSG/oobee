# Oobee (CLI)

[Oobee](https://go.gov.sg/oobee-cli) (formerly known as Purple A11y) is a customisable, automated accessibility testing tool that allows software development teams to assess whether their products are user-friendly to persons with disabilities (PWDs).

This is the engine and command-line interface (CLI) for Oobee. The official application can only be downloaded at [https://go.gov.sg/oobee-cli](https://go.gov.sg/oobee-cli). We recommend that you download the software only from the official link, as other sources and/or third party links may pose risks and/or compromise your system.

For the **user-friendly desktop application**, check out [Oobee](https://go.gov.sg/oobee).

## Technology Stack

1. [Crawlee](https://crawlee.dev/)
2. [Axe-core](https://github.com/dequelabs/axe-core)
3. [Node.js](https://Node.js.org/en/)
4. [Playwright](https://playwright.dev/)
5. [Pixelmatch](https://github.com/mapbox/pixelmatch)
6. [Corretto](https://aws.amazon.com/corretto)
7. [VeraPDF](https://github.com/veraPDF/veraPDF-apps)

## Using Oobee as a NodeJS module

If you wish to use Oobee as a NodeJS module that can be integrated with end-to-end testing frameworks, refer to the [integration guide](./INTEGRATION.md) on how you can do so.

## Prerequisites and Installations

### Portable Oobee

Portable Oobee is the recommended way to run Oobee as it reduces the difficulty for installation. Refer to [Installation Guide](./INSTALLATION.md) for step-by-step instructions for portable Oobee.

### Manual Installation

Please ensure the following requirements are met:

#### Node.js

- A Node distribution of 20 (LTS) or above.
- To check your version of Node, go into terminal and paste the command bellow

```shell
node -v
```

- If you do not have node, or if there is a need to manage your node versions, you can consider using [Node Version Manager (NVM)](https://github.com/nvm-sh/nvm). After NVM is installed, you can then install an LTS version of Node:

```shell
# Install NodeJS version with NVM
nvm install --lts

# For subsequent use, you will need to run the command below each time you open a new terminal
nvm use --lts
```

- Install the required NPM packages with `npm install`.
- Build the project with `npm run build` before you try to run it with `npm start`.

#### Java JRE/JDK

- A JRE/JDK distribution of version 11 or above.
- To check your version of Java, go into terminal and paste the command bellow

```shell
java --version
```

- If you do not have java, you can consider installing [Corretto](https://docs.aws.amazon.com/corretto/latest/corretto-11-ug/what-is-corretto-11.html) distribution of OpenJDK.

#### VeraPDF

- VeraPDF is used for scanning PDF files. Install VeraPDF by following the [install guide](https://docs.verapdf.org/install/). You may wish to use the Automated installation script provided on that page, and changing the XML installation script section `<installpath>/tmp/verapdf-test</installpath>` to a location of your choice.
- Ensure you have VeraPDF set in PATH then verify verapdf is installed correctly:

```shell
# Invoke the VeraPDF installer
# Windows users should use vera-install.bat instead of vera-install
./verapdf-install ./auto-install.xml

# Add VeraPDF to PATH. For subsequent use, you will need to run the command below each time you open a new terminal
export PATH="<location of verapdf>:$PATH"

# Verify verapdf is installed
verapdf --version
```

#### Environment variables (Optional)
| Variable Name | Description | Default |
| ------------- | ----------- | ------- |
| OOBEE_VERBOSE | When set to `true`, log output goes to console | `false` |
| OOBEE_FAST_CRAWLER| When set to `true`, increases scan concurrency at a rapid rate.  Experimental, may cause system stability issues on low-powered devices. | `false`|
| OOBEE_VALIDATE_URL| When set to `true`, validates if URLs are valid and exits. | `false` |
| OOBEE_LOGS_PATH | When set, logs are written to this path. |  |
| WARN_LEVEL | Only used in tests. |  |
| OOBEE_DISABLE_BROWSER_DOWNLOAD | Experimental flag to disable file downloads on Chrome/Chromium/Edge.  Does not affect Local File scan | |
| OOBEE_SLOWMO | Experimental flag to slow down web browser behaviour by specified duration (in miliseconds) | |

#### Environment variables used internally (Do not set)
Do not set these environment variables or behaviour might change unexpectedly.
| Variable Name | Description |
| ------------- | ----------- |
| CRAWLEE_LOG_LEVEL | https://crawlee.dev/docs/guides/configuration#crawlee_log_level |
| CRAWLEE_STORAGE_DIR | https://crawlee.dev/docs/guides/configuration#crawlee_storage_dir |
| CRAWLEE_HEADLESS | https://crawlee.dev/docs/guides/configuration#crawlee_headless |

#### Facing issues?

Please refer to [Troubleshooting section](#troubleshooting) for more information.

---

## Features

Oobee can perform the following to scan the target URL.

- To **run** Oobee in **terminal**, run `npm start`. Questions will be prompted to assist you in providing the right inputs.
- Results will be compiled in JSON format, followed by generating a HTML report.

> NOTE: For your initial scan, there may be some loading time required before use. Oobee will also ask for your name and email address and collect your app usage data to personalise your experience. Your information fully complies with [GovTech’s Privacy Policy](https://www.tech.gov.sg/privacy/).

#### Delete/Edit Details

> You may delete and edit your cached name and e-mail address by running the following command to delete `userData.txt`:

> - Windows (PowerShell): `rm "$env:APPDATA\Oobee\userData.txt"`
> - MacOS (Terminal): `rm "$HOME/Library/Application Support/Oobee/userData.txt"`

If `userData.txt` does not exists just run `npm start`.

### Scan Selection

You can interact via your arrow keys.

```shell
% npm start
┌────────────────────────────────────────────────────────────┐
│  Oobee (ver      )                                   │
│  We recommend using Chrome browser for the best experience.│
│                                                            │
│ Welcome back User!                                       │
│ (Refer to readme.txt on how to change your profile)        │
└────────────────────────────────────────────────────────────┘
? What would you like to scan? (Use arrow keys)
❯ Sitemap
  Website
  Custom
```

### Headless Mode

Headless mode would allow you to run the scan in the background. If you would like to observe the scraping process, please enter `n`

```shell
 % npm start
┌────────────────────────────────────────────────────────────┐
│ Oobee (ver      )                                    │
│ We recommend using Chrome browser for the best experience. │
│                                                            │
│ Welcome back User!                                         │
│ (Refer to readme.txt on how to change your profile)        │
└────────────────────────────────────────────────────────────┘
? What would you like to scan? Sitemap
? Do you want oobee to run in the background? (Y/n) No
```

### Sitemap Scan

```shell
% npm start
┌────────────────────────────────────────────────────────────┐
│ Oobee (ver      )                                     │
│ We recommend using Chrome browser for the best experience. │
│                                                            │
│ Welcome back User!                                         │
│ (Refer to readme.txt on how to change your profile)        │
└────────────────────────────────────────────────────────────┘
? What would you like to scan? Sitemap
? Do you want oobee to run in the background? No
? Which screen size would you like to scan? (Use arrow keys) Desktop
? Please enter URL or file path to sitemap, or drag and drop a sitemap file here:  https://www.sitemaps.org/sitemap.xml


 Scanning website...


 Fetching URLs. This might take some time...


Scanning website...

#oobee will then start scraping from the file link provided above.
#Console results

```

If the sitemap URL provided is invalid, an error message will be prompted for you to provide a valid input.

```shell
>> Invalid sitemap format. Please provide a URL with a valid sitemap.
```

### Website Scan

```shell
% npm start
┌────────────────────────────────────────────────────────────┐
│ Oobee (ver      )                                    │
│ We recommend using Chrome browser for the best experience. │
│                                                            │
│ Welcome back User!                                         │
│ (Refer to readme.txt on how to change your profile)        │
└────────────────────────────────────────────────────────────┘
? What would you like to scan? Website
? Do you want oobee to run in the background? Yes
? Which screen size would you like to scan? (Use arrow keys) Desktop
? Please enter URL of website:  https://www.domain.org

```

If the website URL provided is invalid, an error message will be prompted for you to provide a valid input.

```shell
>> Cannot resolve URL. Please provide a valid URL.
```

### Customised Mobile Device Scan

```shell
% npm start
┌────────────────────────────────────────────────────────────┐
│ Oobee (ver      )                                   │
│ We recommend using Chrome browser for the best experience. │
│                                                            │
│ Welcome back User!                                         │
│ (Refer to readme.txt on how to change your profile)        │
└────────────────────────────────────────────────────────────┘
? What would you like to scan? Website
? Do you want oobee to run in the background? No
? Which screen size would you like to scan? (Use arrow keys) (Use arrow keys)
❯ Desktop
  Mobile
  Custom
```

Choose `Mobile` for a default mobile screen size scan and `Custom` to choose a device or specify viewport width options.

### Custom flow

Custom flow allows you to specify a user journey by enabling you to click the scan button on each desired webpage on a browser to initiate scan. This is useful to scan websites that require user and form input.

1. Start by choosing the `Custom flow` in the menu selection.

```shell
% npm start
┌────────────────────────────────────────────────────────────┐
│ Oobee (ver      )                                   │
│ We recommend using Chrome browser for the best experience. │
│                                                            │
│ Welcome back User!                                         │
│ (Refer to readme.txt on how to change your profile)        │
└────────────────────────────────────────────────────────────┘
? What would you like to scan?
  Sitemap
  Website
❯ Custom
```

1. Specify the URL of the starting page you wish to scan
2. A Chrome window will appear. Navigate through the pages and click on the **Scan this page** button at the top right of the broswer's page to conduct an accessibility scan on the current page.
3. You may drag the top black bar to the bottom of the page in the event it prevents you from viewing / blocking certain page elements.
4. Close the Chrome window to end the scan.

Other options:

- You can specify sites to exclude from accessibility scan (e.g. login page) by adding a pattern of the domain to `exclusions.txt`. An example of `exclusions.txt`:

```txt
\.*login.singpass.gov.sg\.*
```

#### Known Issues

If the custom flow fails to start, you might be running multiple versions of Playwright. Re-install Playwright:

1. On Windows, delete the folder `%USERPROFILE%\AppData\Local\ms-playwright` where `%USERPROFILE%` is typically located at `C:\Users\<username>`.
2. On MacOS, delete the folder `~/Library/Caches/ms-playwright` where `~` refers to `/Users/<username>`.
3. Within PowerShell (Windows) or Terminal (MacOS) app, run the following two commands to re-install Playwright:

```Shell
npx playwright@1.27.1 install
```

### CLI Mode

CLI mode is designed to be run in continuous integration (CI) environment.
Run `npm run cli` for a set of command-line parameters available.

```shell
Usage: npm run cli -- -c <crawler> -d <device> -w <view
port> -u <url> OPTIONS

Options:
      --help                         Show help                         [boolean]
  -c, --scanner                      Type of scan, 1) sitemap, 2) website crawl,
                                      3) custom flow, 4) intelligent
                                     elligent
  [required] [choices: "sitemap", "website", "custom", "intelligent"]
  -u, --url                          Website URL you want to scan
                                                             [string] [required]
  -d, --customDevice                 Device you want to scan            [string]
  -w, --viewportWidth                Viewport width (in pixels) you want to scan
                                                                        [number]
  -o, --zip                          Zip filename to save results       [string]
  -p, --maxpages                     Maximum number of pages to scan (default: 1
                                     00). Only available in website and sitemap
                                     scans                              [number]
  -f, --safeMode                     Disable dynamically clicking of page button
                                     s and links to find links, which resolve is
                                     sues on some websites. [yes / no]
                                                        [string] [default: "no"]
  -h, --headless                     Run the scan in headless mode. [yes / no]
                                                       [string] [default: "yes"]
  -b, --browserToRun                 Browser to run the scan on: 1) Chromium, 2)
                                      Chrome, 3) Edge. Defaults to Chromium.
                     [choices: "chromium", "chrome", "edge"] [default: "chrome"]
  -s, --strategy                     Crawls up to general (same parent) domains,
                                      or only specific hostname. Defaults to "sa
                                     me-domain".
                                       [choices: "same-domain", "same-hostname"]
  -e, --exportDirectory              Preferred directory to store scan results.
                                     Path is relative to your home directory.
                                                                        [string]
  -j, --customFlowLabel              Give Custom Flow Scan a label for easier re
                                     ference in the report              [string]
  -k, --nameEmail                    To personalise your experience, we will be
                                     collecting your name, email address and app
                                      usage data. Your information fully complie
                                     s with GovTech’s Privacy Policy. Please pro
                                     vide your name and email address in this fo
                                     rmat "John Doe:john@domain.com".
                                                             [string] [required]
  -t, --specifiedMaxConcurrency      Maximum number of pages to scan concurrentl
                                     y. Use for sites with throttling. Defaults
                                     to 25.                             [number]
  -i, --fileTypes                    File types to include in the scan. Defaults
                                      to html-only.
       [string] [choices: "all", "pdf-only", "html-only"] [default: "html-only"]
  -x, --blacklistedPatternsFilename  Txt file that has a list of pattern of doma
                                     ins to exclude from accessibility scan sepa
                                     rated by new line
                                            [string] [default: "exclusions.txt"]
  -a, --additional                   Additional features to include in the repor
                                     t:
                                     screenshots - Include element screensho
                                     ts in the generated report
                                     none - Exclude
                                     all additional features in the generated re
                                     port
              [string] [choices: "screenshots", "none"] [default: "screenshots"]
  -q, --metadata                     Json string that contains additional scan m
                                     etadata for telemetry purposes. Defaults to
                                      "{}"              [string] [default: "{}"]
  -r, --followRobots                 Crawler adheres to robots.txt rules if it e
                                     xists. [yes / no]  [string] [default: "no"]
  -m, --header                       The HTTP authentication header keys and the
                                     ir respective values to enable crawler acce
                                     ss to restricted resources.        [string]
  -y, --ruleset                      Specify scan ruleset for accessibility chec
                                     ks
  [string] [choices: "default", "disable-oobee", "enable-wcag-aaa", "disable-oob
                                       ee,enable-wcag-aaa"] [default: "default"]
  -g, --generateJsonFiles            Generate two gzipped and base64-encoded
                                     JSON files containing the results of the
                                     accessibility scan:
                                     1. `scanData.json`: Provides an overview of
                                        the scan, including:
                                        - WCAG compliance score
                                        - Violated WCAG clauses
                                        - Metadata (e.g., scan start and end times)
                                        - Pages scanned and skipped
                                     2. `scanItems.json`: Contains detailed
                                        information about detected accessibility
                                        issues, including:
                                        - Severity levels
                                        - Issue descriptions
                                        - Related WCAG guidelines
                                        - URL of the pages violated the WCAG clauses
                                     Useful for in-depth analysis or integration
                                     with external reporting tools.

                                     To obtain the JSON files, you need to base64-decode
                                     the file followed by gunzip. For example:
                                     (macOS) base64 -D -i scanData.json.gz.b64 |
                                     gunzip > scanData.json\n
                                     (linux) base64 -d scanData.json.gz.b64 |
                                     gunzip > scanData.json\n
                                     [string] [choices: "yes", "no"] [default: "no"]
  -l, --scanDuration                 Maximum scan duration in seconds (0 means u
                                     nlimited)             [number] [default: 0]

Examples:
  To scan sitemap of website:', 'npm run cli -- -c [ 1 | sitemap ] -u <url_lin
  k> [ -d <device> | -w <viewport_width> ]
  To scan a website', 'npm run cli -- -c [ 2 | website ] -u <url_link> [ -d <d
  evice> | -w <viewport_width> ]
  To start a custom flow scan', 'npm run cli -- -c [ 3 | custom ] -u <url_link
  > [ -d <device> | -w <viewport_width> ]

```
### Note on Windows PowerShell:
You need to run the command as `npm run cli -- --` (with the extra set of `--`) as PowerShell interprets arguments differently.

### Device Options

<details>
  <summary>Click here for list of device options supported</summary>

- "Desktop" (defaults to a 1280x720 viewport)
- "Mobile" (defaults to iPhone 11 viewport)
- "Desktop Chrome HiDPI"
- "Desktop Edge HiDPI"
- "Desktop Firefox HiDPI"
- "Desktop Safari"
- "Desktop Chrome"
- "Desktop Edge"
- "Desktop Firefox"
- "Blackberry PlayBook"
- "Blackberry PlayBook landscape"
- "BlackBerry Z30"
- "BlackBerry Z30 landscape"
- "Galaxy Note 3"
- "Galaxy Note 3 landscape"
- "Galaxy Note II"
- "Galaxy Note II landscape"
- "Galaxy S III"
- "Galaxy S III landscape"
- "Galaxy S5"
- "Galaxy S5 landscape"
- "Galaxy S8"
- "Galaxy S8 landscape"
- "Galaxy S9+"
- "Galaxy S9+ landscape"
- "Galaxy Tab S4"
- "Galaxy Tab S4 landscape"
- "iPad (gen 6)"
- "iPad (gen 6) landscape"
- "iPad (gen 7)"
- "iPad (gen 7) landscape"
- "iPad Mini"
- "iPad Mini landscape"
- "iPad Pro 11"
- "iPad Pro 11 landscape"
- "iPhone 6"
- "iPhone 6 landscape"
- "iPhone 6 Plus"
- "iPhone 6 Plus landscape"
- "iPhone 7"
- "iPhone 7 landscape"
- "iPhone 7 Plus"
- "iPhone 7 Plus landscape"
- "iPhone 8"
- "iPhone 8 landscape"
- "iPhone 8 Plus"
- "iPhone 8 Plus landscape"
- "iPhone SE"
- "iPhone SE landscape"
- "iPhone X"
- "iPhone X landscape"
- "iPhone XR"
- "iPhone XR landscape"
- "iPhone 11"
- "iPhone 11 landscape"
- "iPhone 11 Pro"
- "iPhone 11 Pro landscape"
- "iPhone 11 Pro Max"
- "iPhone 11 Pro Max landscape"
- "iPhone 12"
- "iPhone 12 landscape"
- "iPhone 12 Pro"
- "iPhone 12 Pro landscape"
- "iPhone 12 Pro Max"
- "iPhone 12 Pro Max landscape"
- "iPhone 12 Mini"
- "iPhone 12 Mini landscape"
- "iPhone 13"
- "iPhone 13 landscape"
- "iPhone 13 Pro"
- "iPhone 13 Pro landscape"
- "iPhone 13 Pro Max"
- "iPhone 13 Pro Max landscape"
- "iPhone 13 Mini"
- "iPhone 13 Mini landscape"
- "Kindle Fire HDX"
- "Kindle Fire HDX landscape"
- "LG Optimus L70"
- "LG Optimus L70 landscape"
- "Microsoft Lumia 550"
- "Microsoft Lumia 550 landscape"
- "Microsoft Lumia 950"
- "Microsoft Lumia 950 landscape"
- "Nexus 10"
- "Nexus 10 landscape"
- "Nexus 4"
- "Nexus 4 landscape"
- "Nexus 5"
- "Nexus 5 landscape"
- "Nexus 5X"
- "Nexus 5X landscape"
- "Nexus 6"
- "Nexus 6 landscape"
- "Nexus 6P"
- "Nexus 6P landscape"
- "Nexus 7"
- "Nexus 7 landscape"
- "Nokia Lumia 520"
- "Nokia Lumia 520 landscape"
- "Nokia N9"
- "Nokia N9 landscape"
- "Pixel 2"
- "Pixel 2 landscape"
- "Pixel 2 XL"
- "Pixel 2 XL landscape"
- "Pixel 3"
- "Pixel 3 landscape"
- "Pixel 4"
- "Pixel 4 landscape"
- "Pixel 4a (5G)"
- "Pixel 4a (5G) landscape"
- "Pixel 5"
- "Pixel 5 landscape"
- "Moto G4"
- "Moto G4 landscape"

</details>

If the device name contains `(` and `)`, wrap the device name in single quotes when entered into the CLI.
Please note that `-d` and `-w` are mutually exclusive. If none are specified, the default device used for the CLI scan is Desktop.

For example, to conduct a website scan to the URL "http://localhost:8000" and write to "oobee-scan-results.zip" with an 'iPad (gen 7) landscape' screen, run

```shell
npm run cli -- -c 2 -o oobee-scan-results.zip -u http://localhost:8000 -d 'iPad (gen 7) landscape'
```

If the site you want to scan has a query string wrap the link in single quotes when entered into the CLI.

For example, to conduct a website scan to the URL "http://localhost:8000" and write to "oobee-scan-results.zip" with a custom screen width '360', run

```shell
npm run cli -- -c 2 -o oobee-scan-results.zip -u "http://localhost:8000" -w 360
```

## Report

Once a scan of the site is completed.

A report will be downloaded into the current working directory.

## Accessibility Scan Results

Each Issue has its own severity "Must Fix" / "Good to Fix" based on the [WCAG 2.2 Conformance](https://www.w3.org/TR/WCAG22/).

For details on which accessibility scan results triggers a "Must Fix" / "Good to Fix" findings, you may refer to [Scan Issue Details](./DETAILS.md).

## Troubleshooting

Please refer to the information below to assist in debugging. Most errors below are due to the switching between Node.js versions.

### Incompatible Node.js versions

**Issue**: When your Node.js version is incompatible, you may face the following syntax error.

```shell
const URL_NO_COMMAS_REGEX = RegExp('https?://(www\\.)?[\\p{L}0-9][-\\p{L}0-9@:%._\\+~#=]{0,254}[\\p{L}0-9]\\.[a-z]{2,63}(:\\d{1,5})?(/[-\\p{L}0-9@:%_\\+.~#?&//=\\(\\)]*)?', 'giu'); // eslint-disable-line
                            ^
SyntaxError: Invalid regular expression: /https?://(www\.)?[\p{L}0-9][-\p{L}0-9@:%\._\+~#=]{0,254}[\p{L}0-9]\.[a-z]{2,63}(:\d{1,5})?(/[-\p{L}0-9@:%_\+.~#?&//=\(\)]*)?/: Invalid escape
```

**Solution**: Install Node.js versions >= 20, i.e. Node.js v20 and above.

### Compiled against a different Node.js version

**Issue**: When you switch between different versions of Node.js in your environment, you may face the following error.

```shell
<user_path>/oobee/node_modules/bindings/bindings.js:91
        throw e
        ^

Error: The module '<module_file_path>'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 57. This version of Node.js requires
NODE_MODULE_VERSION 88. Please try re-compiling or re-installing
the module (for instance, using `npm rebuild` or `npm install`).
```

**Solution**: As recommended in the error message, run `npm rebuild` or `npm install`

### dyld Error

**Issue**: Not able to run Oobee due to the following error shown below

```shell
dyld: lazy symbol binding failed: Symbol not found: __ZN2v87Isolate37AdjustAmountOfExternalAllocatedMemoryEx
  Referenced from: <user_path>/oobee/node_modules/libxmljs/build/Release/xmljs.node
  Expected in: flat namespace

dyld: Symbol not found: __ZN2v87Isolate37AdjustAmountOfExternalAllocatedMemoryEx
  Referenced from: <user_path>/PURPLE_A11y/oobee/node_modules/libxmljs/build/Release/xmljs.node
  Expected in: flat namespace

zsh: abort      node index.js
```

**Solutions**:

1. Delete existing `node_modules` folder and re-install the NPM packages with `npm install`.
2. Refer to this [GitHub issue](https://github.com/fsevents/fsevents/issues/313) for more alternative solutions

### Element Screenshot Limitation

**Limitation**: Due to animations causing elements to shift out of the viewport after an Axe scan, there's a risk of element screenshots timing out within 5 seconds if the element is not found. This known issue is particularly prevalent in scenarios like carousels with interval-based transitions.

## FAQ

### How do I limit number of pages scanned?

If you find a scan takes too long to complete due to large website, or there are too many pages in a sitemap to scan, you may choose to limit number of pages scanned.

To do this, run CLI mode `npm run cli --` with the needed settings and specify `-p 10` where `10` is the number of pages you wish to scan.

### I am a new developer and I have some knowledge gap.

We recommend looking at our **Technology Stack** to understand the usage of each component. Take your time to understand.

## Additional Information on Data

Oobee uses third-party open-source tools that may be downloaded over the Internet during the installation process of Oobee. Users should be aware of the libraries used by examining `package.json`.

Oobee may send information to the website or URL where the user chooses to initiate a Oobee scan. Limited user information such as e-mail address, name, and basic analytics is collected for the purpose of knowing our usage patterns better.
