import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import safe from 'safe-regex';
import { devices } from 'playwright';
import { consoleLogger, silentLogger } from './logs.js';
import { fileURLToPath } from 'url';
import { proxy } from './constants/constants.js';

// Do NOT remove. These import statements will be used when the custom flow scan is run from the GUI app
import { chromium } from 'playwright';
import { createCrawleeSubFolders, runAxeScript } from '#root/crawlers/commonCrawlerFunc.js';
import { generateArtifacts } from '#root/mergeAxeResults.js';
import {
  createAndUpdateResultsFolders,
  createDetailsAndLogs,
  createScreenshotsFolder,
  cleanUp,
} from '#root/utils.js';
import constants, {
  getIntermediateScreenshotsPath,
  getExecutablePath,
  removeQuarantineFlag,
} from '#root/constants/constants.js';
import { isSkippedUrl, submitFormViaPlaywright } from '#root/constants/common.js';
import { spawnSync } from 'child_process';
import { getDefaultChromeDataDir, getDefaultEdgeDataDir } from './constants/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// only to be used for string values
const formatScriptStringVar = val => {
  if (val === undefined || val === null) {
    return val;
  }

  // JSON stringify used here to avoid eval of escape characters
  return JSON.stringify(val);
};

const playwrightAxeGenerator = async data => {
  const blacklistedPatternsFilename = 'exclusions.txt';
  let blacklistedPatterns = null;

  if (fs.existsSync(blacklistedPatternsFilename)) {
    blacklistedPatterns = fs.readFileSync(blacklistedPatternsFilename).toString().split('\n');

    let unsafe = blacklistedPatterns.filter(function (pattern) {
      return !safe(pattern);
    });

    if (unsafe.length > 0) {
      let unsafeExpressionsError =
        "Unsafe expressions detected: '" +
        unsafe +
        "' Please revise " +
        blacklistedPatternsFilename;
      consoleLogger.error(unsafeExpressionsError);
      silentLogger.error(unsafeExpressionsError);
      process.exit(1);
    }
  }

  let {
    isHeadless,
    randomToken,
    deviceChosen,
    customDevice,
    viewportWidth,
    customFlowLabel,
    needsReviewItems,
  } = data;
  // these will be appended to the generated script if the scan is run from CLI/index.
  // this is so as the final generated script can be rerun after the scan.
  const importStatements = `
    import { chromium, devices, webkit } from 'playwright';
    import { getComparator } from 'playwright-core/lib/utils';
    import { createCrawleeSubFolders, runAxeScript } from '#root/crawlers/commonCrawlerFunc.js';
    import { generateArtifacts } from '#root/mergeAxeResults.js';
    import { createAndUpdateResultsFolders, createDetailsAndLogs, createScreenshotsFolder, cleanUp, getStoragePath } from '#root/utils.js';
    import constants, {
        getIntermediateScreenshotsPath,
        getExecutablePath, removeQuarantineFlag
    } from '#root/constants/constants.js';
    import fs from 'fs';
    import path from 'path';
    import printMessage from 'print-message';
    import { isSkippedUrl, submitFormViaPlaywright } from '#root/constants/common.js';
    import { spawnSync } from 'child_process';
    import safe from 'safe-regex';
    import { consoleLogger, silentLogger } from '#root/logs.js';

  `;
  const block1 = `const blacklistedPatternsFilename = 'exclusions.txt';

// checks and delete datasets path if it already exists
await cleanUp(${formatScriptStringVar(randomToken)});

process.env.CRAWLEE_STORAGE_DIR = ${formatScriptStringVar(randomToken)};

const scanDetails = {
    startTime: new Date().getTime(),
    crawlType: 'Custom Flow',
    requestUrl: ${formatScriptStringVar(data.url)},
};
    
const urlsCrawled = { ...constants.urlsCrawledObj };
const { dataset } = await createCrawleeSubFolders(${formatScriptStringVar(randomToken)});

let blacklistedPatterns = null;

if (fs.existsSync(blacklistedPatternsFilename)) {
  blacklistedPatterns = fs.readFileSync(blacklistedPatternsFilename).toString().split('\\n');

  let unsafe = blacklistedPatterns.filter(function (pattern) {
    return !safe(pattern);
  });
  
  if (unsafe.length > 0) {
    let unsafeExpressionsError =
      "Unsafe expressions detected: '" +
      unsafe +
      "' Please revise " +
      blacklistedPatternsFilename;
    consoleLogger.error(unsafeExpressionsError);
    silentLogger.error(unsafeExpressionsError);
    process.exit(1);
  }
}

var index = 1;
var urlImageDictionary = {};
let pageUrl;

const intermediateScreenshotsPath = getIntermediateScreenshotsPath(
  ${formatScriptStringVar(randomToken)}
);

const checkIfScanRequired = async page => {
  const imgPath = intermediateScreenshotsPath + '/PHScan-screenshot' + index.toString() + '.png';

index += 1;

const fullPageSize = await page.evaluate(() => {
  return {
    width: Math.max(
      document.body.scrollWidth,
      document.documentElement.scrollWidth,
      document.body.offsetWidth,
      document.documentElement.offsetWidth,
      document.body.clientWidth,
      document.documentElement.clientWidth,
    ),
    height: Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight,
      document.body.clientHeight,
      document.documentElement.clientHeight,
    ),
  };
});


const originalSize = page.viewportSize();

const usesInfiniteScroll = async () => {
  const prevHeight = await page.evaluate(() => document.body.scrollHeight);

  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });

  const isLoadMoreContent = async () => {
    return new Promise((resolve) => {
      setTimeout(async () => {
        await page.waitForLoadState('domcontentloaded'); 

        const result = await page.evaluate((prevHeight) => {
            const currentHeight = document.body.scrollHeight;
            return (currentHeight > prevHeight);
        }, prevHeight);

        resolve(result);
      }, 2500);
    });
  }

  const result = await isLoadMoreContent();
  return result;
};

let screenshotBuff;

await usesInfiniteScroll();

// scroll back to top of page for screenshot
await page.evaluate(() => {
  window.scrollTo(0, 0);
});

pageUrl = page.url();
consoleLogger.info(\`Screenshot page at: \${pageUrl}\`);
silentLogger.info(\`Screenshot page at: \${pageUrl}\`);

screenshotBuff = await page.screenshot({
  path: imgPath,
  clip: {
    x: 0,
    y: 0,
    width: fullPageSize.width,
    height: 5400
  },
  fullPage: true,
  scale: 'css',
});

if (originalSize) await page.setViewportSize(originalSize);

var isSimilarPage = true;

if (!urlImageDictionary[pageUrl]) {
  urlImageDictionary[pageUrl] = [imgPath];

  consoleLogger.info(\`Process page at: \${page.url()} , Scan required? true\`);
  silentLogger.info(\`Process page at: \${page.url()} , Scan required? true\`);
  
  return true;
} else {
    try {
      const currImg = screenshotBuff;
      const prevImgIdx = urlImageDictionary[pageUrl].length - 1;
      const prevImg = fs.readFileSync(urlImageDictionary[pageUrl][prevImgIdx]);
      const comparator = getComparator('image/png');
      console.time('Time taken');
      const isDiff = comparator(currImg, prevImg, { maxDiffPixelRatio: 0.04 });

      if (isDiff && isDiff.errorMessage && isDiff.errorMessage.includes("ratio")) {
          urlImageDictionary[pageUrl].push(imgPath)
          isSimilarPage = false;
      } else {
        // Delete screenshot
        fs.unlink(imgPath, err => {
          if (err) throw err;
        });

        isSimilarPage = true;
      }

      consoleLogger.info(\`Process page at: \${page.url()} , Scan required? \${!isSimilarPage}\`);
      silentLogger.info(\`Process page at: \${page.url()} , Scan required? \${!isSimilarPage}\`);
      
      console.timeEnd('Time taken');

    } catch (error) {
      console.error('error: ', error);
    }

  return !isSimilarPage;
}
};

const runAxeScan = async (needsReviewItems, page) => {
  const result = await runAxeScript(needsReviewItems, page);
  await dataset.pushData(result);
  urlsCrawled.scanned.push({ url: page.url(), pageTitle: result.pageTitle });
}


const processPage = async page => {
  try {
		await page.waitForLoadState('networkidle', {'timeout': 10000 });
  } catch (e) {
    consoleLogger.info('Unable to detect networkidle');
    silentLogger.info('Unable to detect networkidle');
  }
  
  if (blacklistedPatterns && isSkippedUrl(page, blacklistedPatterns)) {
	return;
  } else {
	const scanRequired = await checkIfScanRequired(page);
	
	if (scanRequired) {
    if (process.env.RUNNING_FROM_PH_GUI) {
      console.log("Electron crawling::", urlsCrawled.scanned.length, "::scanned::", page.url());
    }
		await runAxeScan(${needsReviewItems}, page);
	}
  }

};

const clickFunc = async (elem,page) => {
  const numElems = await elem.count(); 

  const waitForElemIsVisible = async (elem, duration) => {
    try {
      await elem.waitFor({state: "visible", timeout: duration});
      return true;
    } catch (e) {
      return false;
    }
  }

  const hoverParentAndClickElem = async (nth,page) => {
    
    let attempts = 20;
    let parent = nth;

    if (! await parent.isVisible()) {

      while (attempts > 0) {
        parent = parent.locator('xpath=..');
        if (await parent.isVisible()) {
          await parent.hover({force: true});

          if (await waitForElemIsVisible(nth, 500)) {
            await processPage(page);
            await nth.click();
            return;
          }

        }
        attempts--;
      }
    }
  }

  if (numElems === 0 && ! await waitForElemIsVisible(elem, 60000)) {
    await hoverParentAndClickElem(elem, page);
  
  } else if (numElems === 0) {
      await elem.click();

  } else for (let index = 0; index < numElems; index++) {
      const nth = await elem.nth(index); 
      if (! await nth.isVisible()) {
        await hoverParentAndClickElem(nth, page);
      } else {
        await nth.click();
      }
  }

};
`;

  const block2 = ` 
    if (process.env.RUNNING_FROM_PH_GUI) {
      console.log('Electron scan completed');
    }
    return urlsCrawled
      } catch (e) {
        console.error('Error: ', e);
        process.exit(1);
      }
        })().then(async (urlsCrawled) => {
            scanDetails.endTime = new Date().getTime();
            scanDetails.urlsCrawled = urlsCrawled;
            await createDetailsAndLogs(scanDetails, ${formatScriptStringVar(randomToken)});
            await createAndUpdateResultsFolders(${formatScriptStringVar(randomToken)});
            createScreenshotsFolder(${formatScriptStringVar(randomToken)});
            const basicFormHTMLSnippet = await generateArtifacts(
              ${formatScriptStringVar(randomToken)},
              ${formatScriptStringVar(data.url)},
              'Customized',
              ${formatScriptStringVar(
                viewportWidth
                  ? `CustomWidth_${viewportWidth}px`
                  : customDevice || deviceChosen || 'Desktop',
              )}, 
              urlsCrawled.scanned, 
              ${formatScriptStringVar(customFlowLabel)}
            );

  await submitFormViaPlaywright(
    ${formatScriptStringVar(data.browser)},
    ${formatScriptStringVar(data.userDataDirectory)},
    ${formatScriptStringVar(data.url)},
    ${formatScriptStringVar(data.type)},
    // nameEmail = name:email
    ${formatScriptStringVar(data.nameEmail.split(':')[1])}, 
    ${formatScriptStringVar(data.nameEmail.split(':')[0])},
    JSON.stringify(basicFormHTMLSnippet),
    urlsCrawled.scanned.length,
  );

  if (process.env.RUNNING_FROM_PH_GUI) {
    printMessage([getStoragePath(${formatScriptStringVar(randomToken)})]); 
    process.exit(0);
  }
});
`;

  // const block2 = process.env.RUNNING_FROM_PH_GUI
  //   ? block2Code + `\nprintMessage([getStoragePath('${randomToken}')])\nprocess.exit(0);\n});`
  //   : block2Code + `\n});`

  let tmpDir;
  const appPrefix = 'purple-hats';

  let customFlowScripts = './custom_flow_scripts';
  // if (process.env.RUNNING_FROM_PH_GUI && os.platform() === 'darwin') {
  //   customFlowScripts = './Purple HATS Backend/purple-hats/custom_flow_scripts';
  // } else {
  //   customFlowScripts = './custom_flow_scripts'
  // }

  if (!fs.existsSync(`${customFlowScripts}`)) {
    fs.mkdirSync(`${customFlowScripts}`);
  }

  const generatedScriptName = `generatedScript-${randomToken}.js`;
  const generatedScript = `${customFlowScripts}/${generatedScriptName}`;

  console.log(
    ` ℹ️  A new browser will be launched shortly.\n Navigate and record custom steps for ${data.url} in the new browser.\n Close the browser when you are done recording your steps.`,
  );

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), appPrefix));

    let browser = 'chromium';
    let channel = 'chrome';
    let userAgentOpts = null;
    let viewportHeight = 720;

    // use webkit for recording due to flaky codegen on mobile / specify viewports
    if (os.platform() === 'darwin') {
      browser = 'webkit';
      channel = '';
    } else {
      // Windows
      if (!getDefaultChromeDataDir()) {
        channel = 'msedge';
      }
    }

    if (deviceChosen === 'Mobile') {
      customDevice = 'iPhone 11';
    }

    if (customDevice && !viewportWidth) {
      viewportWidth = devices[customDevice].viewport.width;
      viewportHeight = devices[customDevice].viewport.height;
      userAgentOpts = `--user-agent \"${devices[customDevice].userAgent}\"`;
    }

    if (os.platform() === 'win32' && getDefaultChromeDataDir()) {
      channel = 'chrome';
    }

    let escapedUrl;
    if (os.platform() === 'win32' && data.url.includes('&')) {
      escapedUrl = data.url.replaceAll('&', '^&');
    } else {
      escapedUrl = data.url;
    }

    let codegenCmd = `npx playwright codegen --target javascript -o "${tmpDir}/intermediateScript.js" "${escapedUrl}"`;
    let extraCodegenOpts = `${userAgentOpts} --browser ${browser} --block-service-workers --ignore-https-errors ${
      channel && `--channel ${channel}`
    }`;

    if (viewportWidth || customDevice === 'Specify viewport') {
      codegenCmd = `${codegenCmd} --viewport-size=\"${viewportWidth},${viewportHeight}\" ${extraCodegenOpts}`;
    } else {
      codegenCmd = `${codegenCmd} ${extraCodegenOpts}`;
    }

    const codegenResult = execSync(codegenCmd, { cwd: __dirname });

    if (codegenResult.toString()) {
      console.error(`Error running Codegen: ${codegenResult.toString()}`);
    }

    const fileStream = fs.createReadStream(`${tmpDir}/intermediateScript.js`);

    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const appendToGeneratedScript = data => {
      fs.appendFileSync(generatedScript, `${data}\n`);
    };

    let firstGoToUrl = false;
    let lastGoToUrl;
    let nextStepNeedsProcessPage = false;

    // used when running a scan on a machine with proxy
    let awaitingProxyLogin = false;
    let secondGotoMicrosoftLoginSeen = false;

    if (!process.env.RUNNING_FROM_PH_GUI) {
      appendToGeneratedScript(importStatements);
    }
    // if (!process.env.RUNNING_FROM_PH_GUI || (process.env.RUNNING_FROM_PH_GUI && os.platform() === 'darwin')) {
    // appendToGeneratedScript(importStatements);
    // } else {
    //   appendToGeneratedScript(importStatementsForWin);
    // }

    for await (let line of rl) {
      // remove invalid characters
      var re =
        /[\uFFFD\uE949\0-\x1F\x7F-\x9F\xAD\u0378\u0379\u037F-\u0383\u038B\u038D\u03A2\u0528-\u0530\u0557\u0558\u0560\u0588\u058B-\u058E\u0590\u05C8-\u05CF\u05EB-\u05EF\u05F5-\u0605\u061C\u061D\u06DD\u070E\u070F\u074B\u074C\u07B2-\u07BF\u07FB-\u07FF\u082E\u082F\u083F\u085C\u085D\u085F-\u089F\u08A1\u08AD-\u08E3\u08FF\u0978\u0980\u0984\u098D\u098E\u0991\u0992\u09A9\u09B1\u09B3-\u09B5\u09BA\u09BB\u09C5\u09C6\u09C9\u09CA\u09CF-\u09D6\u09D8-\u09DB\u09DE\u09E4\u09E5\u09FC-\u0A00\u0A04\u0A0B-\u0A0E\u0A11\u0A12\u0A29\u0A31\u0A34\u0A37\u0A3A\u0A3B\u0A3D\u0A43-\u0A46\u0A49\u0A4A\u0A4E-\u0A50\u0A52-\u0A58\u0A5D\u0A5F-\u0A65\u0A76-\u0A80\u0A84\u0A8E\u0A92\u0AA9\u0AB1\u0AB4\u0ABA\u0ABB\u0AC6\u0ACA\u0ACE\u0ACF\u0AD1-\u0ADF\u0AE4\u0AE5\u0AF2-\u0B00\u0B04\u0B0D\u0B0E\u0B11\u0B12\u0B29\u0B31\u0B34\u0B3A\u0B3B\u0B45\u0B46\u0B49\u0B4A\u0B4E-\u0B55\u0B58-\u0B5B\u0B5E\u0B64\u0B65\u0B78-\u0B81\u0B84\u0B8B-\u0B8D\u0B91\u0B96-\u0B98\u0B9B\u0B9D\u0BA0-\u0BA2\u0BA5-\u0BA7\u0BAB-\u0BAD\u0BBA-\u0BBD\u0BC3-\u0BC5\u0BC9\u0BCE\u0BCF\u0BD1-\u0BD6\u0BD8-\u0BE5\u0BFB-\u0C00\u0C04\u0C0D\u0C11\u0C29\u0C34\u0C3A-\u0C3C\u0C45\u0C49\u0C4E-\u0C54\u0C57\u0C5A-\u0C5F\u0C64\u0C65\u0C70-\u0C77\u0C80\u0C81\u0C84\u0C8D\u0C91\u0CA9\u0CB4\u0CBA\u0CBB\u0CC5\u0CC9\u0CCE-\u0CD4\u0CD7-\u0CDD\u0CDF\u0CE4\u0CE5\u0CF0\u0CF3-\u0D01\u0D04\u0D0D\u0D11\u0D3B\u0D3C\u0D45\u0D49\u0D4F-\u0D56\u0D58-\u0D5F\u0D64\u0D65\u0D76-\u0D78\u0D80\u0D81\u0D84\u0D97-\u0D99\u0DB2\u0DBC\u0DBE\u0DBF\u0DC7-\u0DC9\u0DCB-\u0DCE\u0DD5\u0DD7\u0DE0-\u0DF1\u0DF5-\u0E00\u0E3B-\u0E3E\u0E5C-\u0E80\u0E83\u0E85\u0E86\u0E89\u0E8B\u0E8C\u0E8E-\u0E93\u0E98\u0EA0\u0EA4\u0EA6\u0EA8\u0EA9\u0EAC\u0EBA\u0EBE\u0EBF\u0EC5\u0EC7\u0ECE\u0ECF\u0EDA\u0EDB\u0EE0-\u0EFF\u0F48\u0F6D-\u0F70\u0F98\u0FBD\u0FCD\u0FDB-\u0FFF\u10C6\u10C8-\u10CC\u10CE\u10CF\u1249\u124E\u124F\u1257\u1259\u125E\u125F\u1289\u128E\u128F\u12B1\u12B6\u12B7\u12BF\u12C1\u12C6\u12C7\u12D7\u1311\u1316\u1317\u135B\u135C\u137D-\u137F\u139A-\u139F\u13F5-\u13FF\u169D-\u169F\u16F1-\u16FF\u170D\u1715-\u171F\u1737-\u173F\u1754-\u175F\u176D\u1771\u1774-\u177F\u17DE\u17DF\u17EA-\u17EF\u17FA-\u17FF\u180F\u181A-\u181F\u1878-\u187F\u18AB-\u18AF\u18F6-\u18FF\u191D-\u191F\u192C-\u192F\u193C-\u193F\u1941-\u1943\u196E\u196F\u1975-\u197F\u19AC-\u19AF\u19CA-\u19CF\u19DB-\u19DD\u1A1C\u1A1D\u1A5F\u1A7D\u1A7E\u1A8A-\u1A8F\u1A9A-\u1A9F\u1AAE-\u1AFF\u1B4C-\u1B4F\u1B7D-\u1B7F\u1BF4-\u1BFB\u1C38-\u1C3A\u1C4A-\u1C4C\u1C80-\u1CBF\u1CC8-\u1CCF\u1CF7-\u1CFF\u1DE7-\u1DFB\u1F16\u1F17\u1F1E\u1F1F\u1F46\u1F47\u1F4E\u1F4F\u1F58\u1F5A\u1F5C\u1F5E\u1F7E\u1F7F\u1FB5\u1FC5\u1FD4\u1FD5\u1FDC\u1FF0\u1FF1\u1FF5\u1FFF\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2072\u2073\u208F\u209D-\u209F\u20BB-\u20CF\u20F1-\u20FF\u218A-\u218F\u23F4-\u23FF\u2427-\u243F\u244B-\u245F\u2700\u2B4D-\u2B4F\u2B5A-\u2BFF\u2C2F\u2C5F\u2CF4-\u2CF8\u2D26\u2D28-\u2D2C\u2D2E\u2D2F\u2D68-\u2D6E\u2D71-\u2D7E\u2D97-\u2D9F\u2DA7\u2DAF\u2DB7\u2DBF\u2DC7\u2DCF\u2DD7\u2DDF\u2E3C-\u2E7F\u2E9A\u2EF4-\u2EFF\u2FD6-\u2FEF\u2FFC-\u2FFF\u3040\u3097\u3098\u3100-\u3104\u312E-\u3130\u318F\u31BB-\u31BF\u31E4-\u31EF\u321F\u32FF\u4DB6-\u4DBF\u9FCD-\u9FFF\uA48D-\uA48F\uA4C7-\uA4CF\uA62C-\uA63F\uA698-\uA69E\uA6F8-\uA6FF\uA78F\uA794-\uA79F\uA7AB-\uA7F7\uA82C-\uA82F\uA83A-\uA83F\uA878-\uA87F\uA8C5-\uA8CD\uA8DA-\uA8DF\uA8FC-\uA8FF\uA954-\uA95E\uA97D-\uA97F\uA9CE\uA9DA-\uA9DD\uA9E0-\uA9FF\uAA37-\uAA3F\uAA4E\uAA4F\uAA5A\uAA5B\uAA7C-\uAA7F\uAAC3-\uAADA\uAAF7-\uAB00\uAB07\uAB08\uAB0F\uAB10\uAB17-\uAB1F\uAB27\uAB2F-\uABBF\uABEE\uABEF\uABFA-\uABFF\uD7A4-\uD7AF\uD7C7-\uD7CA\uD7FC-\uF8FF\uFA6E\uFA6F\uFADA-\uFAFF\uFB07-\uFB12\uFB18-\uFB1C\uFB37\uFB3D\uFB3F\uFB42\uFB45\uFBC2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDEF\uFDFE\uFDFF\uFE1A-\uFE1F\uFE27-\uFE2F\uFE53\uFE67\uFE6C-\uFE6F\uFE75\uFEFD-\uFF00\uFFBF-\uFFC1\uFFC8\uFFC9\uFFD0\uFFD1\uFFD8\uFFD9\uFFDD-\uFFDF\uFFE7\uFFEF-\uFFFB\uFFFE\uFFFF]/g;
      line = line.replace(re, '').trim();
      if (/page\d.close\(\)/.test(line.trim())) {
        const handleUndefinedPageBlock = `try{
            ${line}
          } catch(err){
            console.log(err)
          }`;
        appendToGeneratedScript(handleUndefinedPageBlock);
        continue;
      }

      if (
        line.trim() === `const { chromium } = require('playwright');` ||
        line.trim() === `const { webkit } = require('playwright');` ||
        line.trim() === `const { chromium, devices } = require('playwright');` ||
        line.trim() === `const { webkit, devices } = require('playwright');`
      ) {
        appendToGeneratedScript(block1);
        continue;
      }
      if (line.trim() === `headless: false`) {
        if (proxy) {
          appendToGeneratedScript(`slowMo: 100,`);
          if (proxy.type === 'autoConfig') {
            appendToGeneratedScript(`args: ['--proxy-pac-url=${proxy.url}'],`);
          } else {
            appendToGeneratedScript(`args: ['--proxy-server=${proxy.url}'],`);
          }
        }
        if (!proxy && isHeadless) {
          appendToGeneratedScript(`headless: true`);
          continue;
        }
      }
      //for Mac/Win custom flow scan
      if (
        !(viewportWidth || customDevice) &&
        (line.trim() === `const browser = await webkit.launch({` ||
          line.trim() === `const browser = await chromium.launch({`)
      ) {
        appendToGeneratedScript(`
  const browser = await ${browser}.launch({
    args:['--window-size=1920,1040'],`);
        continue;
      }
      //for Mac/Win custom flow scan
      if (line.trim() === `const browser = await ${browser}.launch({`) {
        appendToGeneratedScript(`  const browser = await ${browser}.launch({`);

        continue;
      }

      if (
        !(viewportWidth || customDevice) &&
        line.trim() === `const context = await browser.newContext({`
      ) {
        appendToGeneratedScript(`
  const context = await browser.newContext({
    viewport: null,`);
        continue;
      }

      if (line.trim() === `(async () => {`) {
        appendToGeneratedScript(`await (async () => {`);
        appendToGeneratedScript(`try {`);
        appendToGeneratedScript(`let elem;`);
        continue;
      }
      if (line.trim() === `const page = await context.newPage();`) {
        if (deviceChosen === 'Mobile') {
          appendToGeneratedScript(line);
          appendToGeneratedScript(
            `  const pageHeight = page.viewportSize().height
            await page.setViewportSize({
                      width: 360,
                      height: pageHeight,
                      isMobile: true,
                    });`,
          );
        } else if (viewportWidth) {
          appendToGeneratedScript(line);
          appendToGeneratedScript(
            `const pageHeight = page.viewportSize().height
            await page.setViewportSize({
            width: ${viewportWidth},
            height: pageHeight,
            isMobile: true,
          });`,
          );
        } else {
          appendToGeneratedScript(line);
        }
        continue;
      }

      let pageObj = 'page';

      if (line.trim().startsWith(`await page`)) {
        const regexPageObj = /(?<=await )(.*?)(?=\.)/;
        pageObj = line.match(regexPageObj)[0];
      }

      if (proxy && line.trim().startsWith(`await page.goto('https://login.microsoftonline.com/`)) {
        if (!awaitingProxyLogin) {
          awaitingProxyLogin = true;
          continue;
        } else if (!secondGotoMicrosoftLoginSeen) {
          secondGotoMicrosoftLoginSeen = true;
          continue;
        }
      }

      if (awaitingProxyLogin) {
        if (line.trim().startsWith(`await page.goto('${data.url}`)) {
          awaitingProxyLogin = false;
        } else {
          continue;
        }
      }

      if (line.trim().includes(`.goto(`)) {
        if (!firstGoToUrl) {
          if (line.trim().startsWith(`await page.goto('https://login.singpass.gov.sg`)) {
            continue;
          }
          firstGoToUrl = true;
          const firstGoToAddress = line.split(`('`)[1].split(`')`)[0];
          appendToGeneratedScript(
            `${line}
            await page.waitForURL('${firstGoToAddress}', {timeout: 60000});
             await processPage(page);
            `,
          );
          continue;
        } else {
          const regexURL = /(?<=goto\(\')(.*?)(?=\'\))/;
          const foundURL = line.match(regexURL)[0];
          const withoutParamsURL = foundURL.split('?')[0];
          lastGoToUrl = withoutParamsURL;
          continue;
        }
      } else if (lastGoToUrl) {
        appendToGeneratedScript(`
          await ${pageObj}.waitForURL('${lastGoToUrl}**',{timeout: 60000});
          await processPage(page);
        `);

        lastGoToUrl = null;
      } else if (nextStepNeedsProcessPage) {
        appendToGeneratedScript(`await processPage(page);`);
        nextStepNeedsProcessPage = false;
      }

      if (line.trim().includes('.getByRole(') && line.trim().includes('.click()')) {
        // add includeHidden: true to getByRole options
        const paramsStartIdx = line.indexOf('getByRole(') + 'getByRole('.length;
        const paramsEndIdx = line.indexOf(')', paramsStartIdx);
        const paramsStr = line.substring(paramsStartIdx, paramsEndIdx);

        let [firstParam, ...options] = paramsStr.split("',");
        firstParam = firstParam + "'";
        options = options.join("',");

        if (options) {
          // falsy if there are no options
          options = options.trim().replace('}', ', includeHidden: true }');
          line = line.replace(`getByRole(${paramsStr})`, `getByRole(${firstParam}, ${options})`);
        }
      }

      if (line.trim().includes('.fill(')) {
        let lastIndex = line.lastIndexOf('.');
        if (line.trim().includes('getByPlaceholder')) {
          lastIndex = line.lastIndexOf('.fill(');
        }
        const locator = line.substring(0, lastIndex);
        appendToGeneratedScript(line);
        appendToGeneratedScript(`await ${locator}.focus()`);
        appendToGeneratedScript(`await page.keyboard.up('Shift')`);
        continue;
      }

      const isClick = line.trim().includes('click()');

      if ((line.trim().includes('getBy') && !line.trim().includes('getByPlaceholder')) || isClick) {
        const lastIndex = line.lastIndexOf('.');
        const locator = line.substring(0, lastIndex);
        isClick && appendToGeneratedScript(`elem = ${locator}`);
        appendToGeneratedScript(isClick ? `await clickFunc(elem, page)` : line);

        nextStepNeedsProcessPage = true;
        continue;
      } else {
        nextStepNeedsProcessPage = false;
      }

      if (line.trim() === `await browser.close();`) {
        appendToGeneratedScript(line);
        appendToGeneratedScript(block2);
        break;
      }

      appendToGeneratedScript(line);
    }

    fileStream.destroy();
    if (process.env.RUNNING_FROM_PH_GUI) {
      console.log(generatedScriptName);
      // printMessage([generatedScriptName]);
      process.exit(0);
      // const genScriptString = fs.readFileSync(generatedScript, 'utf-8');
      // const genScriptCompleted = new Promise((resolve, reject) => {
      //   eval(`(async () => {
      //       try {
      //         ${genScriptString}
      //         resolve();
      //       } catch (e) {
      //         reject(e)
      //       }
      //     })();`);
      // });
      // await genScriptCompleted;
    } else {
      console.log(` Browser closed. Replaying steps and running accessibility scan...\n`);
      await import(generatedScript);
    }
  } catch (e) {
    console.error(`Error: ${e}`);
    throw e;
  } finally {
    try {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(
        `An error has occurred while removing the temp folder at ${tmpDir}. Please remove it manually. Error: ${e}`,
      );
    }

    if (!process.env.RUNNING_FROM_PH_GUI) {
      console.log(
        `\n You may re-run the recorded steps by executing:\n\tnode ${generatedScript} \n`,
      );
    }
  }
};

export default playwrightAxeGenerator;
