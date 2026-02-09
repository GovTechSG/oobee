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

const htmlContent2 = `
<!DOCTYPE html>
<html lang="en">
<head>
    <title>Test Page 2</title>
</head>
<body>
    <h1>Accessibility Test 2</h1>
    <a href="#">Click me</a>       <!-- Violation: link-name (if vague) or empty href issues -->
    <input type="text" />          <!-- Violation: label -->
</body>
</html>
`;

(async () => {
  console.log("Scanning HTML string...");
  try {
    // Run scanHTML without needing full Oobee init
    // Pass an array of HTML strings to demonstrate batch scanning
    const results = await scanHTML(
      [htmlContent, htmlContent2], 
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
