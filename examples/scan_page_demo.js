import { chromium } from 'playwright';
import { scanPage } from '../dist/npmIndex.js';

(async () => {
  console.log("Launching browser...");
  const browser = await chromium.launch({ 
    headless: false,
    channel: 'chrome' // Use Chrome instead of Chromium
  }); 
  const page = await browser.newPage();

  console.log("Navigating to test page...");
  // Using a sample page that likely has accessibility issues
  await page.goto('https://govtechsg.github.io/purple-banner-embeds/purple-integrated-scan-example.htm');

  console.log("Scanning page...");
  try {
    // Run scanPage using the existing Playwright page
    const results = await scanPage(page);

    const mustFixCount = results.mustFix ? results.mustFix.totalItems : 0;
    const goodToFixCount = results.goodToFix ? results.goodToFix.totalItems : 0;

    console.log(`\nScan Complete.`);
    console.log(`Must Fix Issues: ${mustFixCount}`);
    console.log(`Good to Fix Issues: ${goodToFixCount}`);

    if (mustFixCount > 0) {
        // results.mustFix.rules is likely an object where keys are rule IDs
        const violations = Object.values(results.mustFix.rules);
        console.log('\nViolations sample:', JSON.stringify(violations.slice(0, 2), null, 2));
    }
  } catch (error) {
    console.error("Error during scan:", error);
  } finally {
    await browser.close();
  }
})();
