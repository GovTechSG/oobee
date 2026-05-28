/**
 * Details Output Demo
 *
 * Runs scanPage against intentionally non-compliant test pages to capture the
 * enriched Details messages for: color-contrast, color-contrast-enhanced,
 * target-size, valid-lang, and oobee-grading-text-contents.
 *
 * Usage: node examples/details-runner.js
 */
import { chromium } from 'playwright';
import { scanPage } from '../dist/npmIndex.js';
import { gradeReadability } from '../dist/crawlers/custom/gradeReadability.js';

// --- Test HTML pages ---

const colorContrastHTML = `
<!DOCTYPE html>
<html lang="en">
<head><title>Color Contrast Test</title></head>
<body style="background-color: #ffffff;">
  <h1>Color Contrast Violations</h1>
  <p style="color: #999999; font-size: 14px;">This light gray text on white background fails AA contrast</p>
  <p style="color: #aaaaaa; font-size: 14px; background-color: #f0f0f0;">Very light gray on light gray</p>
  <button style="background-color: #55aa99; color: #e8ffe8; font-size: 12px;">Low contrast button</button>
</body>
</html>
`;

const colorContrastEnhancedHTML = `
<!DOCTYPE html>
<html lang="en">
<head><title>Color Contrast Enhanced Test</title></head>
<body style="background-color: #ffffff;">
  <h1>Color Contrast Enhanced AAA Violations</h1>
  <p style="color: #757575; font-size: 14px;">This text passes AA but fails AAA needs 7 to 1</p>
  <p style="color: #6b6b6b; font-size: 12px;">Small text needs 7 to 1 for AAA</p>
</body>
</html>
`;

const targetSizeHTML = `
<!DOCTYPE html>
<html lang="en">
<head><title>Target Size Test</title>
<style>
body { font-family: sans-serif; padding: 40px; }
.icon-link {
  display: inline-block;
  width: 16px;
  height: 16px;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  text-decoration: none;
  color: #333;
  overflow: hidden;
}
</style>
</head>
<body>
<main>
<h1>Icon-sized interactive targets</h1>
<a href="/a" class="icon-link" style="width: 16px; height: 16px;">A</a>
<a href="/b" class="icon-link" style="width: 16px; height: 16px;">B</a>
<a href="/c" class="icon-link" style="width: 16px; height: 16px;">C</a>
</main>
</body>
</html>
`;

const validLangHTML = `
<!DOCTYPE html>
<html lang="x-sindarin">
<head><title>Valid Lang Test</title></head>
<body>
  <main>
  <h1>Valid Lang Violation</h1>
  <p>This page uses a private-use language subtag that is not valid according to BCP 47.</p>
  <div lang="x-klingon">This section also has an invalid private-use lang tag with some sample text content for context.</div>
  </main>
</body>
</html>
`;

const readabilityHTML = `
<!DOCTYPE html>
<html lang="en">
<head><title>Readability Test</title></head>
<body>
  <main>
  <h1>Building Safety Standards</h1>
  <p>The committee reviewed the proposed changes to the building safety standards last Thursday. Members noted that the current regulations do not address modern construction materials adequately. Several technical amendments were suggested to improve clarity for contractors and inspectors. The revised standards will require additional testing for fire resistance in commercial properties. Public consultation on these proposed changes will remain open until the end of next quarter. Building owners should review the draft guidelines to understand potential compliance requirements.</p>
  </main>
</body>
</html>
`;

// --- Helpers ---

function extractMessages(result, ruleId) {
  const messages = [];
  for (const category of ['mustFix', 'goodToFix', 'needsReview']) {
    const rules = result?.[category]?.rules;
    if (rules && rules[ruleId]) {
      const rule = rules[ruleId];
      messages.push({
        category,
        rule: rule.rule || ruleId,
        description: rule.description,
        totalItems: rule.totalItems,
        items: rule.items?.map(item => ({
          html: item.html || item.element,
          message: item.message,
        })),
      });
    }
  }
  return messages;
}

// --- Main ---

(async () => {
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const output = {};

  // 1. Color Contrast (AA)
  console.log("Scanning: color-contrast...");
  try {
    const page = await browser.newPage();
    await page.setContent(colorContrastHTML);
    const result = await scanPage(page, {
      name: "Test", email: "test@test.com", pageTitle: "Color Contrast Test",
    });
    output['color-contrast'] = extractMessages(result, 'color-contrast');
    await page.close();
  } catch (e) { console.error("color-contrast error:", e.message); }

  // 2. Color Contrast Enhanced (AAA)
  console.log("Scanning: color-contrast-enhanced...");
  try {
    const page = await browser.newPage();
    await page.setContent(colorContrastEnhancedHTML);
    const result = await scanPage(page, {
      name: "Test", email: "test@test.com", pageTitle: "Color Contrast Enhanced Test",
      ruleset: ['default', 'enable-wcag-aaa'],
    });
    output['color-contrast-enhanced'] = extractMessages(result, 'color-contrast-enhanced');
    await page.close();
  } catch (e) { console.error("color-contrast-enhanced error:", e.message); }

  // 3. Target Size
  console.log("Scanning: target-size...");
  try {
    const page = await browser.newPage();
    await page.setContent(targetSizeHTML);
    const result = await scanPage(page, {
      name: "Test", email: "test@test.com", pageTitle: "Target Size Test",
    });
    output['target-size'] = extractMessages(result, 'target-size');
    await page.close();
  } catch (e) { console.error("target-size error:", e.message); }

  // 4. Valid Lang
  console.log("Scanning: valid-lang...");
  try {
    const page = await browser.newPage();
    await page.setContent(validLangHTML);
    const result = await scanPage(page, {
      name: "Test", email: "test@test.com", pageTitle: "Valid Lang Test",
    });
    output['valid-lang'] = extractMessages(result, 'valid-lang');
    await page.close();
  } catch (e) { console.error("valid-lang error:", e.message); }

  // 5. Readability (oobee-grading-text-contents)
  console.log("Scanning: oobee-grading-text-contents...");
  try {
    const page = await browser.newPage();
    await page.setContent(readabilityHTML);

    // Simulate what the crawler does: extract text, grade readability
    const textContent = readabilityHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const sentences = textContent.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    const flag = gradeReadability(sentences);
    console.log(`  Readability flag: "${flag}"`);

    if (flag) {
      const score = parseFloat(flag);
      let interpretation = '';
      if (score > 30) interpretation = 'It is targeted for junior college (JC) level comprehension and above.';
      else interpretation = 'It is targeted for university graduate level comprehension and above.';

      output['oobee-grading-text-contents'] = [{
        category: 'needsReview',
        rule: 'oobee-grading-text-contents',
        description: 'Page content must use clear, plain language',
        items: [{
          html: '<html lang="en">...</html>',
          message: `Text content is potentially difficult to read. It scored ${flag} out of 50 on the Flesch-Kincaid Readability Test. ${interpretation}`,
        }],
      }];
    } else {
      console.log("  Score filtered out (<=0 or >50). No violation triggered.");
    }
    await page.close();
  } catch (e) { console.error("readability error:", e.message); }

  await browser.close();

  // Print results
  console.log("\n" + JSON.stringify(output, null, 2));
})();
