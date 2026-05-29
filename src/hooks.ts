import type { PlaywrightHook } from './types.js';
import crawlConfig from './crawl-config.json' with { type: 'json' };

const { blockExtensions: BLOCK_EXTENSIONS, blockExceptionMap: BLOCK_EXCEPTION_MAP } = crawlConfig;

export function createResourceBlockingHook(startingUrl: string): PlaywrightHook {
  const domain = new URL(startingUrl).hostname;
  const exceptions = Object.entries(BLOCK_EXCEPTION_MAP).find(([d]) => domain.includes(d))?.[1] || [];
  const extensionsToBlock = BLOCK_EXTENSIONS.filter(ext => !exceptions.includes(ext));

  return async ({ page }) => {
    await page.route('**/*', async (route) => {
      const url = route.request().url().toLowerCase();
      const shouldBlock = extensionsToBlock.some(ext => url.includes(ext));
      if (shouldBlock) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
  };
}

export function createCookieHook(startingUrl: string): PlaywrightHook | null {
  if (!startingUrl.includes('mom.gov.sg')) return null;
  return async ({ page }) => {
    await page.context().addCookies([{
      name: '_gaexp',
      value: 'GAX1.3.YSM3vuw7Qtmq8cWooeKS4Q.19422.0',
      domain: 'www.mom.gov.sg',
      path: '/',
    }]);
  };
}

export type CloudflareSignFn = (url: string) => Record<string, string>;

export function createCloudflareHook(signFn: CloudflareSignFn): PlaywrightHook {
  return async ({ page }) => {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.resourceType() === 'document') {
        const headers = { ...request.headers(), ...signFn(request.url()) };
        await route.continue({ headers });
      } else {
        await route.continue();
      }
    });
  };
}
