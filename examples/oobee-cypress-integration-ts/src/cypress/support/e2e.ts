/// <reference types="cypress" />

import { OobeeScanOptions } from "../../../cypress.d";

Cypress.Commands.add("injectOobeeA11yScripts", () => {
    cy.task("getAxeScript").then((s: string) => {
        cy.window().then((win) => {
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
    cy.task("getOobeeA11yScripts").then((s: string) => {
        cy.window().then((win) => {
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

Cypress.Commands.add("runOobeeA11yScan", (items: OobeeScanOptions = {}) => {
    cy.window().then(async (win) => {
        const { elementsToScan, elementsToClick, metadata } = items;

        // extract text from the page for readability grading
        const sentences = win.extractText();
        // run readability grading separately as it cannot be done within the browser context
        cy.task("gradeReadability", sentences).then(
            async (gradingReadabilityFlag: string) => {
                // passing the grading flag to runA11yScan to inject violation as needed
                const res = await win.runA11yScan(
                    elementsToScan,
                    gradingReadabilityFlag,
                );
                cy.task("pushOobeeA11yScanResults", {
                    res,
                    metadata,
                    elementsToClick,
                }).then((count) => {
                     return count;
                });
            },
        );
        cy.task("finishOobeeA11yTestCase"); // test the accumulated number of issue occurrences against specified thresholds. If exceed, terminate oobeeA11y instance.
    });
});

Cypress.Commands.add("terminateOobeeA11y", () => {
    cy.task("terminateOobeeA11y");
});

// Suppress ResizeObserver errors and cross-origin security errors
Cypress.on('uncaught:exception', (err, runnable) => {
    if (err.message.includes('ResizeObserver loop completed with undelivered notifications')) {
        return false; // prevents Cypress from failing the test
    }
    if (err.message.includes('SecurityError') && err.message.includes('cross-origin frame')) {
        return false; // prevents Cypress from failing due to cross-origin frame access
    }
    if (err.message.includes("Failed to read a named property 'eval' from 'Window'")) {
        return false; // prevents Cypress from failing due to eval access on cross-origin frames
    }
    if (err.message.includes('Minified React error')) {
        return false; // prevents Cypress from failing due to React errors
    }
    if (err.message.includes('https://reactjs.org/docs/error-decoder.html')) {
        return false; // prevents Cypress from failing due to React errors
    }
    return true;
});