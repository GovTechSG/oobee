import { scanHTML } from '../dist/npmIndex.js';

const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <title>Test Page</title>
</head>
<body>
    <h1>Accessibility Test</h1>
    <button></button>              <!-- Violation: button-name -->
    <img src="test.jpg" />         <!-- Violation: image-alt -->
    <div role="button">Fake</div>  <!-- Violation: role-button (if interactive) -->
</body>
</html>
`;

(async () => {
  console.log("Scanning HTML string...");
  try {
    // Run scanHTML without needing full Oobee init
    const results = await scanHTML(htmlContent);

    const mustFixCount = results.mustFix ? results.mustFix.totalItems : 0;
    const goodToFixCount = results.goodToFix ? results.goodToFix.totalItems : 0;

    console.log(`\nScan Complete.`);
    console.log(`Must Fix Issues: ${mustFixCount}`);
    console.log(`Good to Fix Issues: ${goodToFixCount}`);

    if (mustFixCount > 0) {
        console.log('\nViolations sample:', JSON.stringify(results.mustFix.rules, null, 2));
    }
  } catch (error) {
    console.error("Error during scan:", error);
  }
})();
