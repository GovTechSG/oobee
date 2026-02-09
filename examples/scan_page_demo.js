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
    const results = await scanPage(
      page, 
      {
        name: "Your Name",
        email: "email@domain.com",
      }
    );

   // console.log(JSON.stringify(results, null, 2));

    console.log(`\nScan Complete.`);

  } catch (error) {
    console.error("Error during scan:", error);
  } finally {
    await browser.close();
  }
})();
