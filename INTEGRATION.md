## Integrating Oobee with end-to-end testing frameworks

Oobee provides functionalities that makes it possible to be integrated with end-to-end testing frameworks such as [Cypress](https://www.cypress.io/) and [Playwright](https://playwright.dev/).

### Prerequisites

In order to use this functionality, the testing framework must support:

- Execution of scripts in a NodeJS environment.
- Injection of JavaScript into the document that is being tested.
- Execution of JavaScript in the context of the document and retrieval of results back into the NodeJS environment after execution.

### How to include Oobee in your project

1. Add Oobee to your project by running the following command:

   `npm install --save-dev @govtechsg/oobee`

2. In the file of choice, import Oobee using:

   `import oobeeA11yInit from '@govtechsg/oobee'`

   Note that Oobee should be imported in a script that runs in a NodeJS environment.

3. Create an instance of Oobee with:

   `const oobeeA11y = await oobeeA11yInit(entryUrl)`

   `entryUrl` should be a valid URL referring to the domain of the website to be scanned with Oobee.

### API Reference

#### `async oobeeA11yInit({entryUrl, testLabel, name, email, includeScreenshots, viewportSettings, thresholds, scanAboutMetadata, zip, deviceChosen, strategy, ruleset, specifiedMaxConcurrency, followRobots})`

Returns an instance of Oobee

##### Parameters

- `entryUrl`
  - Initial URL to start the oobee oobee scan
- `testLabel`
  - Label for test in report
- `name`
  - For Oobee data collection purposes
- `email`
  - For Oobee data collection purposes
- `includeScreenshots` (optional)
  - Include screenshots of affected elements in the report. Defaults to false.
- `viewportSettings` (optional)
  - Viewport settings used in cypress tests needed to optimize screenshot function. Defaults to cypress’ default viewport settings. Example: `{ width: 1000, height: 600 }`
- `thresholds` (optional)
  - Object containing the max number of mustFix or goodToFix issue occurrences before an error is thrown for test failure. Does not fail tests by default. Example: `{ mustFix: 1, goodToFix: 3 }`
- `scanAboutMetadata` (optional)
  - Include additional information in the Scan About section of the report by passing in a JSON object.
- `zip` (optional)
  - Name of the generated zip of Oobee results at the end of scan. Defaults to "oobee-scan-results.zip".
- `deviceChosen` (optional)
  - Name of the device to scan on. Example: `iPhone 13 Pro Max`
- `strategy` (optional)
  - The EnqueueStrategy to use. Options: `all`, `same-hostname`, `same-domain`, `same-origin`
- `ruleset` (optional)
  - The array of rulesets to use. Options: `default`, `disable-oobee`, `enable-wcag-aaa`
- `specifiedMaxConcurrency` (optional)
  - The maximum number of concurrent requests to be made. Defaults to 25.
- `followRobots` (optional)
  - Whether to follow robots.txt. Defaults to false.

#### Oobee Instance

##### Properties

`scanDetails`

Object containing details about the scan

- E.g. `{
  startTime: 1700104789495,
  crawlType: 'Customized',
  requestUrl: 'https://govtechsg.github.io',
  urlsCrawled: { } 
}`

`randomToken`

Unique identifier for the scan instance

##### Methods

`getAxeScript()`

Get the axe-core engine to be injected into the browser.

`getOobeeFunctions()`

Get the Oobee custom functions to run accessibility scan. Call this after `getAxeScript()`.

- `runA11yScan(elementsToScan, gradingReadabilityFlag)`
  Runs axe scan on the current page.

  Parameter(s):

  - `elementsToScan`: Specifies which element should and which should not be tested
  - `gradingReadabilityFlag`: This is the readability score as a string. If it is non-empty, a readability violation will be added.

  Returns:

  - Object consisting of the current page url, current page title and axe scan result. `{ pageUrl, pageTitle, axeScanResults }`

`async pushScanResults(res, metadata, elementsToClick, page, disableScreenshots)`

Process scan results to be included in the report.

Parameter(s):

- `res`: Object consisting of the current page url, current page title and axe scan result. ` {pageUrl, pageTitle, axeScanResults}`
- `metadata` (optional): Additional string information to be stored. Useful for distinguishing between different states of the same page. Note: This feature is not implemented in the report HTML currently.
- `elementsToClick` (optional): A list of CSS selectors to click to reveal hidden elements (like modals or menus) before taking screenshots. This is only used if Oobee launches its own browser for screenshots (i.e., when `page` is not provided and `disableScreenshots` is false). Reproducing the state allows the screenshots to capture the violating elements correctly.
- `page` (optional): Playwright Page object. If provided, reuses the existing page for taking screenshots of affected elements.
- `disableScreenshots` (optional): Boolean to disable screenshot capturing. Useful when integrating with tools like Cypress where the browser context cannot be easily shared with Node.js.

Returns:

- Object containing the number of mustFix and goodToFix issue occurrences for this scan run e.g. `{ mustFix: 1, goodToFix: 5 }`

`testThresholds()`

Checks the accumulated issue occurrences count against the specified threshold.

- Terminates oobeeA11y instance and throws an error if the number of accumulated mustFix or goodToFix issue occurrences exceeds either of the specified thresholds.

`async terminate()`

Stops the Oobee instance and generates the scan report and other scan result artifacts. Returns the name of the generated folder containing the results.

### How to use

Example usages for Cypress and Playwright can be found in [this section](#example-usages).

With reference to an instance of Oobee as `oobeeA11y`:

1. Fetch the necessary scripts needed to be injected to document to be scanned by executing `oobeeA11y.getScripts()`. The scripts will be returned as a string.
2. Inject the scripts into the document to be scanned. The easiest way that this can be done is by using `eval()` in the document's environment.
   - Note that this step needs to be done for every page visited.
3. Run a scan by executing `runA11yScan()` in the document's environment.
   - By default, the scan will be run for the entire page.
   - It is possible to run the scan for specific sections or elements in the page. One way to do this is to pass an array of CSS selectors of the elements to be scanned into `runA11yScan`. For example, `runA11yScan(['#my-component', 'button'])`. Other acceptable forms of argument can be found [here](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#context-parameter).
4. Pass the scan results back into the NodeJS environment where `oobeeA11y` is in.
5. Push the results using `await oobeeA11y.pushScanResults(scanResults)`.
   - For Playwright, pass the `page` object as the 4th argument: `await oobeeA11y.pushScanResults(scanResults, undefined, undefined, page)`. This optimizes performance by reusing the existing browser for screenshots.
   - For Cypress, to avoid launching a separate browser for screenshots, you must handle screenshot capturing manually and set `disableScreenshots` to `true`. Refer to the provided Cypress examples for the implementation details.
6. Repeat steps 2-5 as many times as desired.
7. Terminate Oobee by using `await oobeeA11y.terminate()`. A folder containing the details and report of your scan will be created, under the directory `results` which can be found in your project's root directory.

### Example usages

#### Cypress

<details>
<summary>Click here to see an example usage in an E2E Cypress test (javascript)</summary>

We will be creating the following files in a demo Cypress project:

```
    ├── cypress
    │   ├── e2e
    │   │   └── spec.cy.js
    │   └── support
    │       └── e2e.js
    ├── cypress.config.js
    └── package.json

```

Copy the examples provided in `./examples/oobee-cypress-integration-js` to a folder and set that as a working directory.

Install any dependencies with `npm install` .

Navigate to <code>node_modules/@govtechsg/oobee</code> and run <code>npm install</code> and <code>npm run build</code> within the folder to install remaining Oobee dependencies:

```
    cd node_modules/@govtechsg/oobee
    npm install
    npm run build
    cd ../../..
```

Run your test with <code>npx cypress run</code>.

You will see Oobee results generated in <code>results</code> folder.

</details>

<details>
   <summary>Click here to see an example usage in an E2E Cypress test (typescript)</summary>

We will be creating the following files in a demo Cypress project:

```
    ├── cypress.config.ts
    ├── cypress.d.ts
    ├── package.json
    ├── src
    │   └── cypress
    │       ├── e2e
    │       │   └── spec.cy.ts
    │       └── support
    │           └── e2e.ts
    └── tsconfig.json

```

Copy the examples provided in `./examples/oobee-cypress-integration-ts` to a folder and set that as a working directory.

Install any dependencies with `npm install` .

Navigate to <code>node_modules/@govtechsg/oobee</code> and run <code>npm install</code> and <code>npm run build</code> within the folder to install remaining Oobee dependencies:

```
    cd node_modules/@govtechsg/oobee
    npm install
    npm run build
    cd ../../..
```

Compile your typescript code with <code>npx tsc</code>.  
Run your test with <code>npx cypress run</code>.

You will see Oobee results generated in <code>results</code> folder.

</details>

#### Playwright

<details>
    <summary>Click here to see an example usage in Playwright (javascript)</summary>

Copy the examples provided in `./examples/oobee-playwright-integration-js` to a folder and set that as a working directory.

Install any dependencies with `npm install`.

Install Playwright Chromium by running <code>npx playwright install chromium</code>

Navigate to <code>node_modules/@govtechsg/oobee</code> and run <code>npm install</code> and <code>npm run build</code> within the folder to install remaining Oobee dependencies:

```
    cd node_modules/@govtechsg/oobee
    npm install
    npm run build
    cd ../../..
```

Run your test with `node oobee-playwright-demo.js` .

You will see Oobee results generated in results folder.

</details>

<details>
    <summary>Click here to see an example usage in Playwright (typescript)</summary>

Copy the examples provided in `./examples/oobee-playwright-integration-ts` to a folder and set that as a working directory.

Install any dependencies with `npm install`.

Install Playwright Chromium by running <code>npx playwright install chromium</code>

Navigate to <code>node_modules/@govtechsg/oobee</code> and run <code>npm install</code> and <code>npm run build</code> within the folder to install remaining Oobee dependencies:

```
    cd node_modules/@govtechsg/oobee
    npm install
    npm run build
    cd ../../..
```

Compile your typescript code with <code>npx tsc</code>.

Run your test with <code>npm test</code>

You will see Oobee results generated in <code>results</code> folder.

</details>

#### Automating Web Crawler Login

<details>
    <summary>Click here to see an example automated web crawler login (javascript)</summary>
<code>automated-web-crawler-login.js</code>:
   
    import { chromium } from 'playwright';
    import { exec } from 'child_process';

    const loginAndCaptureHeaders = async (url, email, password) => {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        await page.goto(url);
        await page.fill('input[name="email"]', email);
        await page.fill('input[name="password"]', password);

        const [response] = await Promise.all([
            page.waitForNavigation(),
            page.click('input[type="submit"]'),
        ]);

        // Format cookie retrieved from page
        const formatCookies = cookies => {
            return cookies.map(cookie => `cookie ${cookie.name}=${cookie.value}`).join('; ');
        };

        // Retrieve cookies after login
        let cookies = await page.context().cookies();
        const formattedCookies = formatCookies(cookies);

        // Close browser
        await browser.close();

        return formattedCookies;
    };

    const runOobeeA11yScan = command => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(stderr);
            }
            console.log(stdout);
        });
    };

    const runScript = () => {
        loginAndCaptureHeaders(
            // Test example with authenticationtest.com
            'https://authenticationtest.com/simpleFormAuth/',
            'simpleForm@authenticationtest.com',
            'pa$$w0rd',
        )
            .then(formattedCookies => {
                console.log('Cookies retrieved.\n');
                // where -m "..." are the headers needed in the format "header1 value1, header2 value2" etc
                // where -u ".../loginSuccess/" is the destination page after login
                const command = `npm run cli -- -c website -u "https://authenticationtest.com/loginSuccess/" -p 1 -k "Your Name:email@domain.com" -m "${formattedCookies}"`;
                console.log(`Executing OobeeA11y scan command:\n> ${command}\n`);
                runOobeeA11yScan(command);
            })
            .catch(err => {
                console.error('Error:', err);
            });
    };

    runScript();

</details>

<details>
    <summary>Click here to see an example automated web crawler login (typescript)</summary>
<code>automated-web-crawler-login.ts</code>:
   
    import { chromium, Browser, Page, Cookie } from 'playwright';
    import { exec } from 'child_process';

    const loginAndCaptureHeaders = async (url: string, email: string, password: string): Promise<string> => {
        const browser: Browser = await chromium.launch({ headless: true });
        const page: Page = await browser.newPage();

        await page.goto(url);
        await page.fill('input[name="email"]', email);
        await page.fill('input[name="password"]', password);

        const [response] = await Promise.all([
            page.waitForNavigation(),
            page.click('input[type="submit"]'),
        ]);

        // Format cookie retrieved from page
        const formatCookies = (cookies: Cookie[]): string => {
            return cookies.map(cookie => `cookie ${cookie.name}=${cookie.value}`).join('; ');
        };

        // Retrieve cookies after login
        let cookies: Cookie[] = await page.context().cookies();
        const formattedCookies: string = formatCookies(cookies);

        // Close browser
        await browser.close();

        return formattedCookies;
    };

    const runOobeeA11yScan = (command: string): void => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(stderr);
            }
            console.log(stdout);
        });
    };

    const runScript = (): void => {
        loginAndCaptureHeaders(
            // Test example with authenticationtest.com
            'https://authenticationtest.com/simpleFormAuth/',
            'simpleForm@authenticationtest.com',
            'pa$$w0rd',
        )
            .then((formattedCookies: string) => {
                console.log('Cookies retrieved.\n');
                // where -m "..." are the headers needed in the format "header1 value1, header2 value2" etc
                // where -u ".../loginSuccess/" is the destination page after login
                const command: string = `npm run cli -- -c website -u "https://authenticationtest.com/loginSuccess/" -p 1 -k "Your Name:email@domain.com" -m "${formattedCookies}"`;
                console.log(`Executing OobeeA11y scan command:\n> ${command}\n`);
                runOobeeA11yScan(command);
            })
            .catch((err: Error) => {
                console.error('Error:', err);
            });
    };

    runScript();

</details>
