import { Browser, BrowserContext, Page, chromium } from "playwright";
import oobeeA11yInit from "@govtechsg/oobee";
import { extractText } from "@govtechsg/oobee/dist/crawlers/custom/extractText.js";

declare const runA11yScan: (
  elementsToScan?: string[],
  gradingReadabilityFlag?: string,
) => Promise<any>;

interface ViewportSettings {
  width: number;
  height: number;
}

interface Thresholds {
  mustFix: number;
  goodToFix: number;
}

interface ScanAboutMetadata {
  browser: string;
}

// viewport used in tests to optimise screenshots
const viewportSettings: ViewportSettings = { width: 1920, height: 1040 };
// specifies the number of occurrences before error is thrown for test failure
const thresholds: Thresholds = { mustFix: 20, goodToFix: 25 };
// additional information to include in the "Scan About" section of the report
const scanAboutMetadata: ScanAboutMetadata = { browser: 'Chrome (Desktop)' };
// name of the generated zip of the results at the end of scan
const resultsZipName: string = "oobee-scan-results.zip";

const oobeeA11y = await oobeeA11yInit({
  entryUrl: "https://govtechsg.github.io", // initial url to start scan
  testLabel: "Demo Playwright Scan", // label for test
  name: "Your Name",
  email: "email@domain.com",
  includeScreenshots: true, // include screenshots of affected elements in the report
  viewportSettings,
  thresholds,
  scanAboutMetadata,
  zip: resultsZipName,
  deviceChosen: "E2E Test Device",
  strategy: undefined,
  ruleset: ["enable-wcag-aaa"],
  specifiedMaxConcurrency: undefined,
  followRobots: undefined,
});

(async () => {
  const browser: Browser = await chromium.launch({
    headless: false,
  });
  const context: BrowserContext = await browser.newContext();
  const page: Page = await context.newPage();

  const runOobeeA11yScan = async (elementsToScan?: string[], gradingReadabilityFlag?: string) => {
    const scanRes = await page.evaluate(
      async ({ elementsToScan, gradingReadabilityFlag }) => await runA11yScan(elementsToScan, gradingReadabilityFlag),
      { elementsToScan, gradingReadabilityFlag },
    );
    // Pass page object to allow screenshot reuse
    await oobeeA11y.pushScanResults(scanRes, undefined, undefined, page);
    oobeeA11y.testThresholds(); // test the accumulated number of issue occurrences against specified thresholds. If exceed, terminate oobeeA11y instance.
  };

  await page.goto('https://govtechsg.github.io/purple-banner-embeds/purple-integrated-scan-example.htm');
  await page.evaluate(oobeeA11y.getAxeScript());
  await page.evaluate(oobeeA11y.getOobeeFunctions());

  const sentences = await page.evaluate(() => extractText());
  const gradingReadabilityFlag = await oobeeA11y.gradeReadability(sentences);

  await runOobeeA11yScan([], gradingReadabilityFlag);

  await page.getByRole('button', { name: 'Click Me' }).click();
  // Run a scan on <input> and <button> elements
  await runOobeeA11yScan(['input', 'button'])

  // ---------------------
  await context.close();
  await browser.close();
  await oobeeA11y.terminate();
})();
