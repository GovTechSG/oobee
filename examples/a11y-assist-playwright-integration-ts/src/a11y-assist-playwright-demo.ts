import { Browser, BrowserContext, Page, chromium } from "playwright";
import a11yassistA11yInit from "@govtechsg/a11y-assist";
import { extractText } from "@govtechsg/a11y-assist/dist/crawlers/custom/extractText.js";

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
const resultsZipName: string = "a11y-assist-scan-results.zip";

const a11yassistA11y = await a11yassistA11yInit({
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

  const runA11yAssistA11yScan = async (elementsToScan?: string[], gradingReadabilityFlag?: string) => {
    const scanRes = await page.evaluate(
      async ({ elementsToScan, gradingReadabilityFlag }) => await runA11yScan(elementsToScan, gradingReadabilityFlag),
      { elementsToScan, gradingReadabilityFlag },
    );
    // Pass page object to allow screenshot reuse
    await a11yassistA11y.pushScanResults(scanRes, undefined, undefined, page);
    a11yassistA11y.testThresholds(); // test the accumulated number of issue occurrences against specified thresholds. If exceed, terminate a11yassistA11y instance.
  };

  await page.goto('https://govtechsg.github.io/purple-banner-embeds/purple-integrated-scan-example.htm');
  await page.evaluate(a11yassistA11y.getAxeScript());
  await page.evaluate(a11yassistA11y.getA11yAssistFunctions());

  const sentences = await page.evaluate(() => extractText());
  const gradingReadabilityFlag = await a11yassistA11y.gradeReadability(sentences);

  await runA11yAssistA11yScan([], gradingReadabilityFlag);

  await page.getByRole('button', { name: 'Click Me' }).click();
  // Run a scan on <input> and <button> elements
  await runA11yAssistA11yScan(['input', 'button'])

  // ---------------------
  await context.close();
  await browser.close();
  await a11yassistA11y.terminate();
})();
