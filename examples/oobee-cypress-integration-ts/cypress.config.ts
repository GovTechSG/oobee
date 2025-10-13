import { defineConfig } from "cypress";
import oobeeA11yInit from "@govtechsg/oobee";

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
const resultsZipName: string = "oobee-scan-results.zip";

// Initialize oobee instance variable - will be set lazily
let oobeeA11y: any = null;

const initOobeeIfNeeded = async () => {
    if (!oobeeA11y) {
        oobeeA11y = await oobeeA11yInit({
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
            ruleset: ["enable-wcag-aaa"], // add "disable-oobee" to disable Oobee custom checks
            specifiedMaxConcurrency: undefined,
            followRobots: undefined,
        });
    }
    return oobeeA11y;
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
                    const instance = await initOobeeIfNeeded();
                    return instance.getAxeScript();
                },
                async getOobeeA11yScripts(): Promise<string> {
                    const instance = await initOobeeIfNeeded();
                    return instance.getOobeeFunctions();
                },
                async gradeReadability(sentences: string[]): Promise<string> {
                    const instance = await initOobeeIfNeeded();
                    return instance.gradeReadability(sentences);
                },
                async pushOobeeA11yScanResults({res, metadata, elementsToClick}: { res: any, metadata: any, elementsToClick: any[] }): Promise<{ mustFix: number, goodToFix: number }> {
                    const instance = await initOobeeIfNeeded();
                    return await instance.pushScanResults(res, metadata, elementsToClick);
                },
                async returnResultsDir(): Promise<string> {
                    const instance = await initOobeeIfNeeded();
                    return `results/${instance.randomToken}_${instance.scanDetails.urlsCrawled.scanned.length}pages/reports/report.html`;
                },
                async finishOobeeA11yTestCase(): Promise<null> {
                    const instance = await initOobeeIfNeeded();
                    instance.testThresholds();
                    return null;
                },
                async terminateOobeeA11y(): Promise<string> {
                    const instance = await initOobeeIfNeeded();
                    return await instance.terminate();
                },
            });
        },
        supportFile: 'dist/cypress/support/e2e.js',
        specPattern: 'dist/cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    },
});