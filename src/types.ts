import type { Page, Response as PlaywrightResponse } from 'playwright';
import type { EnqueueLinksOptions } from 'crawlee';

export type PageInfo = {
  url: string;
  pageTitle: string;
  actualUrl: string;
  metadata?: string;
  httpStatusCode?: number;
};

export type PageHandlerContext = {
  page: Page;
  request: { url: string };
  response: PlaywrightResponse | null;
  enqueueLinks: (options?: EnqueueLinksOptions) => Promise<any>;
};

export type PageHandler = (context: PageHandlerContext) => Promise<void>;

export class ViewportSettingsClass {
  deviceChosen: string;
  customDevice: string;
  viewportWidth: number;
  playwrightDeviceDetailsObject: any;

  constructor(
    deviceChosen: string,
    customDevice: string,
    viewportWidth: number,
    playwrightDeviceDetailsObject: any,
  ) {
    this.deviceChosen = deviceChosen;
    this.customDevice = customDevice;
    this.viewportWidth = viewportWidth;
    this.playwrightDeviceDetailsObject = playwrightDeviceDetailsObject;
  }
}

export class UrlsCrawled {
  siteName: string;
  toScan: string[] = [];
  scanned: PageInfo[] = [];
  invalid: PageInfo[] = [];
  scannedRedirects: { fromUrl: string; toUrl: string }[] = [];
  notScannedRedirects: { fromUrl: string; toUrl: string }[] = [];
  outOfDomain: PageInfo[] = [];
  blacklisted: PageInfo[] = [];
  error: PageInfo[] = [];
  exceededRequests: PageInfo[] = [];
  forbidden: PageInfo[] = [];
  userExcluded: PageInfo[] = [];
  everything: string[] = [];

  constructor(urlsCrawled?: Partial<UrlsCrawled>) {
    if (urlsCrawled) {
      Object.assign(this, urlsCrawled);
    }
  }
}

export enum FileTypes {
  All = 'all',
  PdfOnly = 'pdf-only',
  HtmlOnly = 'html-only',
}

export enum BrowserTypes {
  CHROMIUM = 'chromium',
  CHROME = 'chrome',
  EDGE = 'msedge',
}

export const STATUS_CODE_METADATA: Record<number, string> = {
  0: 'Page Excluded',
  1: 'Not A Supported Document',
  2: 'Web Crawler Errored',
  599: 'Uncommon Response Status Code Received',
  200: 'Unable to scan page due to access restrictions or compatibility issues',
  300: '300 - Multiple Choices',
  301: '301 - Moved Permanently',
  302: '302 - Found',
  303: '303 - See Other',
  304: '304 - Not Modified',
  307: '307 - Temporary Redirect',
  308: '308 - Permanent Redirect',
  400: '400 - Bad Request',
  401: '401 - Unauthorized',
  403: '403 - Forbidden',
  404: '404 - Not Found',
  405: '405 - Method Not Allowed',
  408: '408 - Request Timeout',
  429: '429 - Too Many Requests',
  500: '500 - Internal Server Error',
  502: '502 - Bad Gateway',
  503: '503 - Service Unavailable',
  504: '504 - Gateway Timeout',
};
