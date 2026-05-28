import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { getDomain } from 'tldts';
import { normalizeUrl } from '@apify/utilities';
import constants from './constants/constants.js';
import { consoleLogger } from './logs.js';

export const getVersion = () => {
  const loadJSON = (filePath: string): { version: string } =>
    JSON.parse(fs.readFileSync(new URL(filePath, import.meta.url)).toString());
  const versionNum = loadJSON('../package.json').version;
  return versionNum;
};

export const getHost = (url: string): string => new URL(url).host;

export const isWhitelistedContentType = (contentType: string): boolean => {
  const whitelist = ['text/html'];
  return whitelist.filter(type => contentType.trim().startsWith(type)).length === 1;
};

export const getStoragePath = (randomToken: string): string => {
  if (constants.exportDirectory) {
    return constants.exportDirectory;
  }

  let storagePath = path.join(process.cwd(), 'results', randomToken);

  const isWritable = (() => {
    try {
      if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
      }
      fs.accessSync(storagePath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();

  if (!isWritable) {
    if (os.platform() === 'win32') {
      const documentsPath = path.join(process.env.USERPROFILE || process.env.HOMEPATH || '', 'Documents');
      storagePath = path.join(documentsPath, 'OobeeCrawler', randomToken);
    } else if (os.platform() === 'darwin') {
      const documentsPath = path.join(process.env.HOME || '', 'Documents');
      storagePath = path.join(documentsPath, 'OobeeCrawler', randomToken);
    } else {
      const homePath = process.env.HOME || '';
      storagePath = path.join(homePath, 'OobeeCrawler', randomToken);
    }
    consoleLogger.warn(`Warning: Cannot write to cwd, writing to ${storagePath}`);
  }

  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  constants.exportDirectory = storagePath;
  return storagePath;
};

export const randomThreeDigitNumberString = () => {
  const randomDecimal = Math.random();
  const scaledDecimal = randomDecimal * 900;
  const threeDigitNumber = Math.floor(scaledDecimal) + 100;
  return String(threeDigitNumber);
};

export const normUrl = (u: string): string => (u ? normalizeUrl(u) || u : '');

export const areLinksEqual = (link1: string, link2: string): boolean => {
  try {
    const format = (link: string): URL => {
      return new URL(link.replace(/www\./, ''));
    };
    const l1 = format(link1);
    const l2 = format(link2);

    const areHostEqual = l1.host === l2.host;
    const arePathEqual = l1.pathname === l2.pathname;

    return areHostEqual && arePathEqual;
  } catch {
    return link1 === link2;
  }
};

export const isFollowStrategy = (link1: string, link2: string, rule: string): boolean => {
  if (rule === 'all') return true;
  try {
    const parsedLink1 = new URL(link1);
    const parsedLink2 = new URL(link2);
    if (rule === 'same-origin') {
      return parsedLink1.origin === parsedLink2.origin;
    }
    if (rule === 'same-domain') {
      const link1Domain = getDomain(parsedLink1.hostname, { allowPrivateDomains: true }) || parsedLink1.hostname;
      const link2Domain = getDomain(parsedLink2.hostname, { allowPrivateDomains: true }) || parsedLink2.hostname;
      return link1Domain.toLowerCase() === link2Domain.toLowerCase();
    }
    // default: same-hostname
    return parsedLink1.hostname === parsedLink2.hostname;
  } catch {
    return false;
  }
};

let __stopAllLock: Promise<void> | null = null;

export function register(resource: any) {
  const name = resource?.constructor?.name;

  if (name?.endsWith('Crawler')) {
    constants.resources.crawlers.add(resource);
  } else if (name === 'BrowserContext') {
    constants.resources.browserContexts.add(resource);
  } else if (name === 'Browser') {
    constants.resources.browsers.add(resource);
  }

  return resource;
}

export async function stopAll({ mode = 'graceful', timeoutMs = 10_000 } = {}) {
  if (__stopAllLock) return __stopAllLock;
  __stopAllLock = (async () => {
    const timeout = (ms: number) => new Promise(res => setTimeout(res, ms));
    consoleLogger.info(`Stop browsers starting, mode=${mode}, timeoutMs=${timeoutMs}`);

    for (const c of [...constants.resources.crawlers]) {
      try {
        if (mode === 'graceful') {
          if (typeof c.stop === 'function') {
            await Promise.race([c.stop(), timeout(timeoutMs)]);
          }
        } else if (mode === 'abort') {
          (c as any).autoscaledPool?.abort?.();
        } else {
          if (typeof c.teardown === 'function') {
            await Promise.race([c.teardown(), timeout(timeoutMs)]);
          }
        }
      } catch (err) {
        consoleLogger.warn(`Error stopping crawler: ${(err as Error).message}`);
      } finally {
        constants.resources.crawlers.delete(c);
      }
    }

    for (const ctx of [...constants.resources.browserContexts]) {
      try {
        await Promise.race([ctx.close(), timeout(timeoutMs)]);
      } catch (err) {
        consoleLogger.warn(`Error closing browser context: ${(err as Error).message}`);
      } finally {
        constants.resources.browserContexts.delete(ctx);
      }
    }

    for (const browser of [...constants.resources.browsers]) {
      try {
        await Promise.race([browser.close(), timeout(timeoutMs)]);
      } catch (err) {
        consoleLogger.warn(`Error closing browser: ${(err as Error).message}`);
      } finally {
        constants.resources.browsers.delete(browser);
      }
    }
  })();
  return __stopAllLock;
}
