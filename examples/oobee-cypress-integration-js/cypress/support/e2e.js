import 'cypress-if';

Cypress.Commands.add('injectOobeeA11yScripts', () => {
  cy.task('getAxeScript').then(s => {
    cy.window().then(win => {
      try {
        win.eval(s);
      } catch (error) {
        // If eval fails due to cross-origin issues, try alternative injection
        if (error.message.includes('SecurityError') || error.message.includes('cross-origin')) {
          cy.log('Cross-origin error detected, attempting alternative script injection');
          // Create a script tag as fallback
          const script = win.document.createElement('script');
          script.textContent = s;
          win.document.head.appendChild(script);
        } else {
          throw error;
        }
      }
    });
  });
  cy.task('getOobeeA11yScripts').then(s => {
    cy.window().then(win => {
      try {
        win.eval(s);
      } catch (error) {
        // If eval fails due to cross-origin issues, try alternative injection
        if (error.message.includes('SecurityError') || error.message.includes('cross-origin')) {
          cy.log('Cross-origin error detected, attempting alternative script injection');
          // Create a script tag as fallback
          const script = win.document.createElement('script');
          script.textContent = s;
          win.document.head.appendChild(script);
        } else {
          throw error;
        }
      }
    });
  });
});

Cypress.Commands.add('runOobeeA11yScan', (items = {}, threshold = {}) => {
  cy.window().then(async win => {
    const { elementsToScan, elementsToClick, metadata } = items;

    // extract text from the page for readability grading
    const sentences = win.extractText();
    // run readability grading separately as it cannot be done within the browser context
    cy.task('gradeReadability', sentences).then(async gradingReadabilityFlag => {
      // passing the grading flag to runA11yScan to inject violation as needed
      const res = await win.runA11yScan(elementsToScan, gradingReadabilityFlag);

      const takeOobeeScreenshotsFromCypressForMustFix =
        Cypress.env('takeOobeeScreenshotsFromCypressForMustFix') || true;
      const takeOobeeScreenshotsFromCypressForGoodToFix =
        Cypress.env('takeOobeeScreenshotsFromCypressForGoodToFix') || true;

      let shouldTakeScreenshot;
      let oobeeReportPath;  

      // take screenshot and move to report dir
      cy.wrap()
        .then(() => {
          cy.task('returnOobeeRandomTokenAndPage').then(({ randomToken }) => {
            oobeeReportPath = randomToken;
          });
        })
        .then(() => {
          // Take screenshots based on flags and violation severity
          if (
            (takeOobeeScreenshotsFromCypressForMustFix ||
              takeOobeeScreenshotsFromCypressForGoodToFix) &&
            res.axeScanResults.violations.length > 0
          ) {
            const violations = res.axeScanResults.violations;
            violations.forEach(violation => {
              violation.nodes.forEach((node, nodeIndex) => {
                const selector = node.target && node.target[0];
                const timestamp = Date.now() * 1000000 + Math.floor(Math.random() * 1000000); // Epoch time in nanoseconds
                const screenshotFileName = `${node.impact}_${violation.id}_node_${nodeIndex}_${timestamp}`;
                const screenshotPath = `elemScreenshots/html/${screenshotFileName}`;
                const fullScreenshotPath = `${oobeeReportPath}/${screenshotPath}`;

                if (selector) {
                  // Determine if we should take screenshot based on impact level
                  shouldTakeScreenshot =
                    (takeOobeeScreenshotsFromCypressForMustFix &&
                      (node.impact === 'critical' || node.impact === 'serious')) ||
                    (takeOobeeScreenshotsFromCypressForGoodToFix &&
                      (node.impact === 'moderate' || node.impact === 'minor'));

                  if (shouldTakeScreenshot) {
                    takeScreenshotForHTMLElements(fullScreenshotPath, selector);
                    node.screenshotPath = screenshotPath + '.png';
                  }
                }
              });
            });
          }
        })
        .then(() => {
          // move screenshots to report dir
          if (
            takeOobeeScreenshotsFromCypressForMustFix ||
            takeOobeeScreenshotsFromCypressForGoodToFix
          ) {
            cy.task('returnOobeeRandomTokenAndPage').then(({ randomToken }) => {
              // const screenshotDir = `cypress/screenshots/${randomToken}/elemScreenshots/html`;
              const screenshotPattern = `cypress/screenshots/**/elemScreenshots/html/*.png`;
              const toReportDir = `results/${randomToken}/elemScreenshots/html`;
              cy.task('copyFiles', {
                fromPattern: screenshotPattern,
                toDir: toReportDir,
              });
            });
          }
        })
        .then(() => {
          cy.task('pushOobeeA11yScanResults', {
            res,
            metadata,
            elementsToClick,
          }).then(count => {
            // validate the count against the thresholds
            handleViolation(count, threshold);
            return count;
          });
        });
    });
    cy.task('finishOobeeA11yTestCase'); // test the accumulated number of issue occurrences against specified thresholds. If exceed, terminate oobeeA11y instance.
  });
});

Cypress.Commands.add('terminateOobeeA11y', () => {
  cy.task('terminateOobeeA11y');
});

const handleViolation = (scanResults = {}, threshold = {}) => {
  const assertIfConfigured = key => {
    if (threshold && typeof threshold[key] === 'number') {
      const actual = Number(scanResults[key] ?? 0);
      const limit = Number(threshold[key]);
      expect(
        actual,
        `The value of '${key}' (${actual}) should be less than or equal to the threshold (${limit}).`,
      ).to.be.at.most(limit);
    }
  };
  assertIfConfigured('mustFix');
  assertIfConfigured('goodToFix');
};

const takeScreenshotForHTMLElements = (screenshotPath, selector) => {
  try {
    cy.get(selector)
      .if()
      .then(el => {
        cy.wrap(el).first().invoke('css', 'border', '3px solid red'); // Highlight element with red border
        cy.wrap(el).first().parent();
        cy.wrap(el).first().screenshot(screenshotPath, {
          overwrite: true,
          capture: 'viewport',
        });
        cy.wrap(el).first().invoke('css', 'border', 'none'); // Remove highlight after screenshot
      });
  } catch (e) {
    cy.log('Error taking screenshot for element', selector, e);
  }
};
