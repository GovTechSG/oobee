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
    const results = await scanHTML(
      htmlContent, 
      {
        name: "Your Name",
        email: "email@domain.com",
      }
    );
    console.log(JSON.stringify(results, null, 2));

    console.log(`\nScan Complete.`);

  } catch (error) {
    console.error("Error during scan:", error);
  }
})();
