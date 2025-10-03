/// <reference types="cypress" />

export interface OobeeScanOptions {
  elementsToScan?: string[];
  elementsToClick?: string[];
  metadata?: string;
}

declare global {
  namespace Cypress {
    interface Chainable<Subject = any> {
      injectOobeeA11yScripts(): Chainable<void>;
      runOobeeA11yScan(options?: OobeeScanOptions): Chainable<void>;
      terminateOobeeA11y(): Chainable<any>;
    }
  }

  interface Window {
    runA11yScan: (elementsToScan?: string[], gradingReadabilityFlag?: string) => Promise<any>;
    extractText: () => string[];
  }
}