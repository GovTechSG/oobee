import { defineConfig } from "cypress";
import a11yassistA11yInit from "@govtechsg/a11y-assist";
import * as fs from 'fs';
import * as path from 'path';

interface ViewportSettings {
    width: number;
    height: number;
}

interface Thresholds {
    mustFix: number;
    goodToFix: number;
}

interface ScanAboutMetadata {
    browser: string;
}

// viewport used in tests to optimise screenshots
const viewportSettings: ViewportSettings = { width: 1920, height: 1040 };
// specifies the number of occurrences before error is thrown for test failure
const thresholds: Thresholds = { mustFix: 20, goodToFix: 60 };
// additional information to include in the "Scan About" section of the report
const scanAboutMetadata: ScanAboutMetadata = { browser: 'Chrome (Desktop)' };
// name of the generated zip of the results at the end of scan
const resultsZipName: string = "a11y-assist-scan-results.zip";

// Initialize a11yassist instance variable - will be set lazily
let a11yassistA11y: any = null;

const initA11yAssistIfNeeded = async () => {
    if (!a11yassistA11y) {
        a11yassistA11y = await a11yassistA11yInit({
            entryUrl: "https://govtechsg.github.io/purple-banner-embeds/purple-integrated-scan-example.htm", // initial url to start scan
            testLabel: "Demo Cypress Scan", // label for test
            name: "Your Name", 
            email: "email@domain.com",
            includeScreenshots: true, // include screenshots of affected elements in the report
            viewportSettings,
            thresholds: { mustFix: undefined, goodToFix: undefined },
            scanAboutMetadata: scanAboutMetadata as any,
            zip: resultsZipName,
            deviceChosen: "E2E Test Device",
            strategy: undefined,
            ruleset: ["enable-wcag-aaa"], // add "disable-a11yassist" to disable A11y Assist custom checks
            specifiedMaxConcurrency: undefined,
            followRobots: undefined,
        });
    }
    return a11yassistA11y;
};

export default defineConfig({
    taskTimeout: 120000, // need to extend as screenshot function requires some time
    viewportHeight: viewportSettings.height,
    viewportWidth: viewportSettings.width,
    chromeWebSecurity: false, // Disable web security to handle cross-origin frames
    e2e: {
        setupNodeEvents(on, _config) {
            on("task", {
                async getAxeScript(): Promise<string> {
                    const instance = await initA11yAssistIfNeeded();
                    return instance.getAxeScript();
                },
                async getA11yAssistA11yScripts(): Promise<string> {
                    const instance = await initA11yAssistIfNeeded();
                    return instance.getA11yAssistFunctions();
                },
                async gradeReadability(sentences: string[]): Promise<string> {
                    const instance = await initA11yAssistIfNeeded();
                    return instance.gradeReadability(sentences);
                },
                async pushA11yAssistA11yScanResults({res, metadata, elementsToClick}: { res: any, metadata: any, elementsToClick: any[] }): Promise<{ mustFix: number, goodToFix: number }> {
                    const instance = await initA11yAssistIfNeeded();

                    if (instance.scanDetails.isIncludeScreenshots) {
                        const moveScreenshots = (items: any[]) => {
                            if (!items) return;
                            items.forEach(item => {
                                item.nodes.forEach((node: any) => {
                                    if (node.screenshotFilename) {
                                        const searchDir = 'cypress/screenshots';
                                        
                                        const findFile = (dir: string, name: string): string | null => {
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
                                            const destDir = `results/${instance.randomToken}/screenshots`;
                                            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                                            const destPath = path.join(destDir, node.screenshotFilename);
                                            fs.copyFileSync(srcPath, destPath);
                                            // Set screenshot path for A11y Assist report
                                            node.screenshotPath = node.screenshotFilename; 
                                        }
                                    }
                                })
                            })
                        };
                        
                        moveScreenshots(res.axeScanResults.violations);
                        moveScreenshots(res.axeScanResults.incomplete);
                    }

                    // Cypress task runs in Node.js and does not have access to the browser Page object
                    // Pass disableScreenshots=true to avoid opening a new Playwright browser
                    return await instance.pushScanResults(res, metadata, elementsToClick, undefined, true);
                },
                async returnResultsDir(): Promise<string> {
                    const instance = await initA11yAssistIfNeeded();
                    return `results/${instance.randomToken}_${instance.scanDetails.urlsCrawled.scanned.length}pages/reports/report.html`;
                },
                async finishA11yAssistA11yTestCase(): Promise<null> {
                    const instance = await initA11yAssistIfNeeded();
                    instance.testThresholds();
                    return null;
                },
                async terminateA11yAssistA11y(): Promise<string> {
                    const instance = await initA11yAssistIfNeeded();
                    return await instance.terminate();
                },
            });
        },
        supportFile: 'dist/cypress/support/e2e.js',
        specPattern: 'dist/cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    },
});