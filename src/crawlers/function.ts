import { chromium } from 'playwright';
import { extractAndGradeText } from './custom/extractAndGradeText.js';

(async () => {
  // Launch the browser
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // Navigate to a test webpage
    await page.goto('https://www.tech.gov.sg/'); // Replace with the URL you want to test

    // Call the extractAndGradeText function
    const result = await extractAndGradeText(page);

    // Print the results
    console.log('Extracted Text Content:', result.textContent);
    console.log('Readability Score:', result.readabilityScore);
    if (result.error) {
      console.log('Error:', result.error);
    }
  } catch (error) {
    console.error('Error during page processing:', error);
  } finally {
    // Close the browser
    await browser.close();
  }
})();
