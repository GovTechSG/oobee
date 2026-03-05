export type ItemsInfo = {
  html: string;
  message: string;
  screenshotPath: string;
  xpath: string;
  displayNeedsReview?: boolean;
};

export type PageInfo = {
  items?: ItemsInfo[];
  itemsCount?: number;
  pageTitle: string;
  url: string;
  actualUrl: string;
  pageImagePath?: string;
  pageIndex?: number;
  metadata?: string;
  httpStatusCode?: number;
};

export type HtmlGroupItem = {
  html: string;
  xpath: string;
  message: string;
  screenshotPath: string;
  displayNeedsReview?: boolean;
  pageUrls: string[];
};

export type HtmlGroups = {
  [htmlKey: string]: HtmlGroupItem;
};

export type RuleInfo = {
  totalItems: number;
  pagesAffected: PageInfo[];
  pagesAffectedCount: number;
  rule: string;
  description: string;
  axeImpact: string;
  conformance: string[];
  helpUrl: string;
  htmlGroups?: HtmlGroups;
};

type Category = {
  description: string;
  totalItems: number;
  totalRuleIssues: number;
  rules: RuleInfo[];
};

export type AllIssues = {
  storagePath: string;
  oobeeAi: {
    htmlETL: any;
    rules: string[];
  };
  siteName: string;
  startTime: Date;
  endTime: Date;
  urlScanned: string;
  scanType: string;
  deviceChosen: string;
  formatAboutStartTime: (dateString: any) => string;
  isCustomFlow: boolean;
  pagesScanned: PageInfo[];
  pagesNotScanned: PageInfo[];
  totalPagesScanned: number;
  totalPagesNotScanned: number;
  totalItems: number;
  topFiveMostIssues: Array<any>;
  topTenPagesWithMostIssues: Array<any>;
  topTenIssues: Array<any>;
  wcagViolations: string[];
  customFlowLabel: string;
  oobeeAppVersion: string;
  items: {
    mustFix: Category;
    goodToFix: Category;
    needsReview: Category;
    passed: Category;
  };
  cypressScanAboutMetadata: {
    browser?: string;
    viewport?: { width: number; height: number };
  };
  wcagLinks: { [key: string]: string };
  wcagClauses: { [key: string]: string };
  [key: string]: any;
  advancedScanOptionsSummaryItems: { [key: string]: boolean };
  scanPagesDetail: {
    pagesAffected: any[];
    pagesNotAffected: any[];
    scannedPagesCount: number;
    pagesNotScanned: any[];
    pagesNotScannedCount: number;
  };
};
