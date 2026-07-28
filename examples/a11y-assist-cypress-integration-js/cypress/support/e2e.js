Cypress.Commands.add("injectA11yAssistA11yScripts", () => {
    cy.task("getAxeScript").then((s) => {
        cy.window().then((win) => {
            try {
                win.eval(s);
            }
            catch (error) {
                // If eval fails due to cross-origin issues, try alternative injection
                if (error.message.includes('SecurityError') || error.message.includes('cross-origin')) {
                    cy.log('Cross-origin error detected, attempting alternative script injection');
                    // Create a script tag as fallback
                    const script = win.document.createElement('script');
                    script.textContent = s;
                    win.document.head.appendChild(script);
                }
                else {
                    throw error;
                }
            }
        });
    });
    cy.task("getA11yAssistA11yScripts").then((s) => {
        cy.window().then((win) => {
            try {
                win.eval(s);
            }
            catch (error) {
                // If eval fails due to cross-origin issues, try alternative injection
                if (error.message.includes('SecurityError') || error.message.includes('cross-origin')) {
                    cy.log('Cross-origin error detected, attempting alternative script injection');
                    // Create a script tag as fallback
                    const script = win.document.createElement('script');
                    script.textContent = s;
                    win.document.head.appendChild(script);
                }
                else {
                    throw error;
                }
            }
        });
    });
});

Cypress.Commands.add("runA11yAssistA11yScan", (items = {}) => {
  cy.window().then(async (win) => {
    const { elementsToScan, elementsToClick, metadata } = items;

    // extract text from the page for readability grading
    const sentences = win.extractText();
    // run readability grading separately as it cannot be done within the browser context
    cy.task("gradeReadability", sentences).then(
      async (gradingReadabilityFlag) => {
        // passing the grading flag to runA11yScan to inject violation as needed
        const res = await win.runA11yScan(
          elementsToScan,
          gradingReadabilityFlag,
        );

        const processNodes = (nodes) => {
            if (!nodes) return;
            cy.wrap(nodes).each((node, index) => {
               if (node.target && node.target.length > 0) {
                   const selector = node.target[0];
                   // Generate a unique filename
                   const filename = `a11yassist-screenshot-${Date.now()}-${Math.floor(Math.random() * 1000)}-${index}.png`;
                   
                   // Check existence to prevent failure, then screenshot
                   cy.get("body").then($body => {
                       if ($body.find(selector).length) {
                           // We use capture: 'viewport' to be safe and overwrite true
                           cy.get(selector).first().scrollIntoView().screenshot(filename.replace('.png', ''), { capture: 'viewport', overwrite: true });
                           node.screenshotFilename = filename;
                       }
                   });
               }
            });
        };

        const violations = res.axeScanResults.violations;
        const incomplete = res.axeScanResults.incomplete;

        cy.wrap(violations).each((v) => processNodes(v.nodes));
        cy.wrap(incomplete).each((v) => processNodes(v.nodes));

        // Ensure screenshots are done before pushing results
        cy.then(() => {
            cy.task("pushA11yAssistA11yScanResults", {
              res,
              metadata,
              elementsToClick,
            }).then((count) => {
              return count;
            });
        });
      },
    );
    cy.task("finishA11yAssistA11yTestCase"); // test the accumulated number of issue occurrences against specified thresholds. If exceed, terminate a11yassistA11y instance.
  });
});

Cypress.Commands.add("terminateA11yAssistA11y", () => {
  cy.task("terminateA11yAssistA11y");
});
