import { chromium } from "playwright";
import oobeeA11yInit from "@govtechsg/oobee";
import { extractText } from "@govtechsg/oobee/dist/crawlers/custom/extractText.js";

// viewport used in tests to optimise screenshots
const viewportSettings = { width: 1920, height: 1040 };
// specifies the number of occurrences before error is thrown for test failure
const thresholds = { mustFix: 20, goodToFix: 25 };
// additional information to include in the "Scan About" section of the report
const scanAboutMetadata = { browser: 'Chrome (Desktop)' };
// name of the generated zip of the results at the end of scan
const resultsZipName = "oobee-scan-results.zip";

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
  const browser = await chromium.launch({
    headless: false,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const runOobeeA11yScan = async (elementsToScan, gradingReadabilityFlag) => {
    const scanRes = await page.evaluate(
      async ({ elementsToScan, gradingReadabilityFlag }) => await runA11yScan(elementsToScan, gradingReadabilityFlag),
      { elementsToScan, gradingReadabilityFlag },
    );
    await oobeeA11y.pushScanResults(scanRes);
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
