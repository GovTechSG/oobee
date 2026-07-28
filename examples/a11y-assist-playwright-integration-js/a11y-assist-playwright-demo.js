import { chromium } from "playwright";
import a11yassistA11yInit from "@govtechsg/a11y-assist";
import { extractText } from "@govtechsg/a11y-assist/dist/crawlers/custom/extractText.js";

// viewport used in tests to optimise screenshots
const viewportSettings = { width: 1920, height: 1040 };
// specifies the number of occurrences before error is thrown for test failure
const thresholds = { mustFix: 20, goodToFix: 25 };
// additional information to include in the "Scan About" section of the report
const scanAboutMetadata = { browser: 'Chrome (Desktop)' };
// name of the generated zip of the results at the end of scan
const resultsZipName = "a11y-assist-scan-results.zip";

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
  const browser = await chromium.launch({
    headless: false,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const runA11yAssistA11yScan = async (elementsToScan, gradingReadabilityFlag) => {
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
