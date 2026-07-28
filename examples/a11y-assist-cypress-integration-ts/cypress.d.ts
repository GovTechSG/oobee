/// <reference types="cypress" />

export interface A11yAssistScanOptions {
  elementsToScan?: string[];
  elementsToClick?: string[];
  metadata?: string;
}

declare global {
  namespace Cypress {
    interface Chainable<Subject = any> {
      injectA11yAssistA11yScripts(): Chainable<void>;
      runA11yAssistA11yScan(options?: A11yAssistScanOptions): Chainable<void>;
      terminateA11yAssistA11y(): Chainable<any>;
    }
  }

  interface Window {
    runA11yScan: (elementsToScan?: string[], gradingReadabilityFlag?: string) => Promise<any>;
    extractText: () => string[];
  }
}