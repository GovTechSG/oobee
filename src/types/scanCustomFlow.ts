import type { EnqueueStrategy } from 'crawlee';
import type { BrowserTypes, RuleFlags } from '../constants/constants.js';

export type UnknownRecord = Record<string, unknown>;

export type CustomFlowOverlayScope = 'all' | 'same-domain' | 'same-origin';

export type ScanItemsPage = UnknownRecord & {
  items?: UnknownRecord[];
  url?: string;
  pageTitle?: string;
};

export type ScanItemsRule = UnknownRecord & {
  rule?: string;
  id?: string;
  description?: string;
  pagesAffected?: ScanItemsPage[];
};

export type ScanItemsCategory = UnknownRecord & {
  rules?: ScanItemsRule[];
};

export type NormalizedScanItemsRule = ScanItemsRule & {
  items: UnknownRecord[];
};

export type ScanPageCategory = Omit<ScanItemsCategory, 'rules'> & {
  rules: Record<string, NormalizedScanItemsRule>;
};

export type ScanPageResults = {
  mustFix: ScanPageCategory;
  goodToFix: ScanPageCategory;
  needsReview: ScanPageCategory;
};

export type ScanCustomFlowConfig = {
  url: string;
  name: string;
  email: string;
  browser?: BrowserTypes;
  deviceChosen?: string;
  customDevice?: string;
  viewportWidth?: number;
  playwrightDeviceDetailsObject?: UnknownRecord;
  includeScreenshots?: boolean;
  customFlowLabel?: string;
  ruleset?: RuleFlags[];
  strategy?: EnqueueStrategy;
  followRobots?: boolean;
  blacklistedPatterns?: string[] | null;
  extraHTTPHeaders?: Record<string, string>;
  zip?: string;
  metadata?: string;
  randomToken?: string;
  cleanupArtifacts?: boolean;
  waitForResultSubmission?: boolean;
  maxPagesToScan?: number;
  scanSource?: string;
  overlayScope?: CustomFlowOverlayScope;
  useExtensionOverlayUi?: boolean;
  extensionSessionOrigin?: string;
  onReady?: () => void | Promise<void>;
};

export type ScanCustomFlowResult = {
  customFlowLabel?: string;
  scanData: unknown;
  scanItems: unknown;
  results: ScanPageResults;
  resultDirectory?: string;
  artifacts?: {
    reportHtmlPath: string;
    summaryPdfPath: string;
    zipPath: string;
    scanDetailsCsvPath: string;
  };
};

export type ScanCustomFlowSession = {
  ready: Promise<void>;
  result: Promise<ScanCustomFlowResult>;
  stop: () => Promise<void>;
  focus: () => Promise<void>;
};
