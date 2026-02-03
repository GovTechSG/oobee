import { defineConfig } from "cypress";
import oobeeA11yInit from "@govtechsg/oobee";
import * as fs from 'fs';
import * as path from 'path';

// viewport used in tests to optimise screenshots
const viewportSettings = { width: 1920, height: 1040 };
// specifies the number of occurrences before error is thrown for test failure
const thresholds = { mustFix: 20, goodToFix: 25 };
// additional information to include in the "Scan About" section of the report
const scanAboutMetadata = { browser: 'Chrome (Desktop)' };
// name of the generated zip of the results at the end of scan
const resultsZipName = "oobee-scan-results.zip";

const oobeeA11y = await oobeeA11yInit({
  entryUrl: "https://govtechsg.github.io/purple-banner-embeds/purple-integrated-scan-example.htm", // initial url to start scan
  testLabel: "Demo Cypress Scan", // label for test
  name: "Your Name",
  email: "email@domain.com",
  includeScreenshots: true, // include screenshots of affected elements in the report
  viewportSettings,
  thresholds,
  scanAboutMetadata,
  zip: resultsZipName,
  deviceChosen: "E2E Test Device",
  strategy: undefined,
  ruleset: ["enable-wcag-aaa"], // add "disable-oobee" to disable Oobee custom checks
  specifiedMaxConcurrency: undefined,
  followRobots: undefined,
});

export default defineConfig({
  taskTimeout: 120000, // need to extend as screenshot function requires some time
  viewportHeight: viewportSettings.height,
  viewportWidth: viewportSettings.width,
  e2e: {
    setupNodeEvents(on, _config) {
      on("task", {
        getAxeScript() {
          return oobeeA11y.getAxeScript();
        },
        getOobeeA11yScripts() {
          return oobeeA11y.getOobeeFunctions();
        },
        gradeReadability(sentences) {
          return oobeeA11y.gradeReadability(sentences);
        },
        async pushOobeeA11yScanResults({ res, metadata, elementsToClick }) {
          if (oobeeA11y.scanDetails.isIncludeScreenshots) {
              const moveScreenshots = (items) => {
                  if (!items) return;
                  items.forEach(item => {
                      item.nodes.forEach((node) => {
                          if (node.screenshotFilename) {
                              const searchDir = 'cypress/screenshots';
                              
                              const findFile = (dir, name) => {
                                   if (!fs.existsSync(dir)) return null;
                                   const files = fs.readdirSync(dir);
                                   for (const file of files) {
                                       const filePath = path.join(dir, file);
                                       if (fs.statSync(filePath).isDirectory()) {
                                           const found = findFile(filePath, name);
                                           if (found) return found;
                                       } else if (file === name) {
                                           return filePath;
                                       }
                                   }
                                   return null;
                              }

                              const srcPath = findFile(searchDir, node.screenshotFilename);
                              if (srcPath) {
                                  const destDir = `results/${oobeeA11y.randomToken}/screenshots`;
                                  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                                  const destPath = path.join(destDir, node.screenshotFilename);
                                  fs.copyFileSync(srcPath, destPath);
                                  // Set screenshot path for Oobee report
                                  node.screenshotPath = node.screenshotFilename; 
                              }
                          }
                      })
                  })
              };
              
              moveScreenshots(res.axeScanResults.violations);
              moveScreenshots(res.axeScanResults.incomplete);
          }

          // Pass disableScreenshots=true to avoid opening a new Playwright browser
          return await oobeeA11y.pushScanResults(res, metadata, elementsToClick, undefined, true);
        },
        returnResultsDir() {
          return `results/${oobeeA11y.randomToken}_${oobeeA11y.scanDetails.urlsCrawled.scanned.length}pages/report.html`;
        },
        finishOobeeA11yTestCase() {
          oobeeA11y.testThresholds();
          return null;
        },
        async terminateOobeeA11y() {
          return await oobeeA11y.terminate();
        },
      });
    },
  },
});
