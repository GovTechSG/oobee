import type { PageHandler, PageHandlerContext } from './types.js';

export interface SearchSGPageHandlerConfig {
  startingUrl: string;
  scrapeType: string;
  agencyName?: string;
  agencyAcronym?: string;
}

export function isSingpassLoginPage(url: string): boolean {
  return url.includes('auth.singpass.gov.sg/main') || url.includes('login.id.singpass.gov.sg/main');
}

export function isGoGovForwarderUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'go.gov.sg' && !parsed.pathname.startsWith('/#/');
  } catch {
    return false;
  }
}

export function createSearchSGPageHandler(config: SearchSGPageHandlerConfig): PageHandler {
  const { startingUrl, scrapeType, agencyName = '', agencyAcronym = '' } = config;

  return async ({ page, request, response, dataset }: PageHandlerContext) => {
    const url = request.url;
    const loadedUrl = page.url();
    const statusCode = response?.status() ?? 0;

    const httpResponseHeaders: Record<string, string> = {};
    if (response) {
      for (const [key, value] of Object.entries(response.headers())) {
        httpResponseHeaders[key.toLowerCase()] = value;
      }
    }

    // Extract WOGAA RSID
    let wogaaRsid = '';
    try {
      wogaaRsid = await page.evaluate(
        () => document.querySelector('meta[name="wogaa_rsid"]')?.getAttribute('content') || ''
      ) || '';
    } catch { /* ignore */ }

    const timeOfScrape = new Date().toISOString();

    // Handle Singpass login redirect
    if (isSingpassLoginPage(loadedUrl)) {
      const urlFinalPath = new URL(url).pathname.split('/').pop() || '';
      const title = urlFinalPath.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      await dataset.pushData({
        foundIn: scrapeType,
        timeOfScrape,
        startingUrl,
        wogaaRsid,
        agencyName,
        agencyAcronym,
        url,
        loadedUrl: url,
        statusCode,
        originalTitle: title,
        title,
        description: '',
        httpResponseHeaders,
        rawHtml: `<div>Login via Singpass to access the ${title} service</div>`,
        requires_login: 1,
      });
      return;
    }

    const rawHtml = await page.content();
    const title = await page.title();

    const result: Record<string, unknown> = {
      foundIn: scrapeType,
      timeOfScrape,
      startingUrl,
      wogaaRsid,
      agencyName,
      agencyAcronym,
      url,
      loadedUrl,
      statusCode,
      originalTitle: title,
      title,
      description: '',
      httpResponseHeaders,
      rawHtml,
      requires_login: 0,
    };

    // Handle go.gov.sg forwarder URLs
    if (isGoGovForwarderUrl(url)) {
      try {
        await page.waitForSelector('#url', { timeout: 30000 });
        const eventualUrl = await page.evaluate(
          () => document.querySelector('#url')?.getAttribute('data-href') || null
        );
        if (eventualUrl) result.eventualUrl = eventualUrl;
      } catch {
        const currPageUrl = page.url();
        if (currPageUrl !== url) result.eventualUrl = currPageUrl;
      }
    }

    await dataset.pushData(result);
  };
}
