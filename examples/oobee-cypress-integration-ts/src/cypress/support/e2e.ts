/// <reference types="cypress" />

import { OobeeScanOptions } from "../../../cypress.d";

Cypress.Commands.add("injectOobeeA11yScripts", () => {
    cy.task("getOobeeA11yScripts").then((s: string) => {
        cy.window().then((win) => {
            win.eval(s);
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