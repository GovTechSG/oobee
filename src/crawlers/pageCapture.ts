import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { Page, devices } from 'playwright';
import { getStoragePath } from '../utils.js';

const MOBILE_VIEWPORT_WIDTH = devices['iPhone 11'].viewport.width;
const MOBILE_VIEWPORT_HEIGHT = devices['iPhone 11'].viewport.height;

export interface PageCaptureEntry {
  url: string;
  hash: string;
  desktopDom?: string;
  mobileDom?: string;
  desktopScreenshot?: string;
  mobileScreenshot?: string;
  errors: string[];
}

const captureEntries: Map<string, PageCaptureEntry> = new Map();

export function getUrlHash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 7);
}

function getTruncatedPath(url: string): string {
  try {
    const parsed = new URL(url);
    let pathStr = parsed.pathname + (parsed.search || '');
    pathStr = pathStr.replace(/^\//, '').replace(/\//g, '_').replace(/[^a-zA-Z0-9\-_.]/g, '_');
    if (pathStr.length > 80) {
      pathStr = pathStr.slice(0, 80);
    }
    return pathStr || 'index';
  } catch {
    return 'unknown';
  }
}

function getPageDomsDir(randomToken: string): string {
  const storagePath = getStoragePath(randomToken);
  return path.join(storagePath, 'pageDOMs');
}

async function getUniqueFilePath(dir: string, baseName: string, ext: string): Promise<string> {
  let candidate = path.join(dir, `${baseName}${ext}`);
  if (!await fs.pathExists(candidate)) return candidate;

  let counter = 2;
  while (await fs.pathExists(candidate)) {
    candidate = path.join(dir, `${baseName}-${counter}${ext}`);
    counter++;
  }
  return candidate;
}

function getRelativeName(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, '/');
}

export function isSaveDomEnabled(): boolean {
  return process.env.OOBEE_SAVE_DOM === '1' || process.env.OOBEE_SAVE_DOM === 'true';
}

export function isSavePageScreenshotEnabled(): boolean {
  return (
    process.env.OOBEE_SAVE_PAGE_SCREENSHOT === '1' ||
    process.env.OOBEE_SAVE_PAGE_SCREENSHOT === 'true'
  );
}

export function isPageCaptureEnabled(): boolean {
  return isSaveDomEnabled() || isSavePageScreenshotEnabled();
}

export async function capturePageData(
  page: Page,
  url: string,
  randomToken: string,
): Promise<void> {
  if (!isPageCaptureEnabled()) return;

  const hash = getUrlHash(url);
  const truncatedPath = getTruncatedPath(url);
  const fileName = `${hash}-${truncatedPath}`;
  const pageDomsDir = getPageDomsDir(randomToken);

  const desktopDomDir = path.join(pageDomsDir, 'desktopPageDOMs');
  const mobileDomDir = path.join(pageDomsDir, 'mobilePageDOMs');
  const desktopScreenshotDir = path.join(pageDomsDir, 'desktopPageScreenshots');
  const mobileScreenshotDir = path.join(pageDomsDir, 'mobilePageScreenshots');

  const entry: PageCaptureEntry = {
    url,
    hash,
    errors: [],
  };

  if (isSaveDomEnabled()) {
    try {
      await fs.ensureDir(desktopDomDir);
      const domContent = await page.content();
      const domFilePath = await getUniqueFilePath(desktopDomDir, fileName, '.html');
      await fs.writeFile(domFilePath, domContent, 'utf-8');
      entry.desktopDom = `pageDOMs/desktopPageDOMs/${getRelativeName(domFilePath, desktopDomDir)}`;
    } catch (err) {
      entry.errors.push(
        `Desktop DOM save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (isSavePageScreenshotEnabled()) {
    try {
      await fs.ensureDir(desktopScreenshotDir);
      const desktopPath = await getUniqueFilePath(desktopScreenshotDir, fileName, '.png');
      await page.screenshot({ path: desktopPath, fullPage: true });
      entry.desktopScreenshot = `pageDOMs/desktopPageScreenshots/${getRelativeName(desktopPath, desktopScreenshotDir)}`;
    } catch (err) {
      entry.errors.push(
        `Desktop screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const currentViewport = page.viewportSize();
  try {
    await page.setViewportSize({
      width: MOBILE_VIEWPORT_WIDTH,
      height: MOBILE_VIEWPORT_HEIGHT,
    });
    await page.waitForTimeout(500);

    if (isSaveDomEnabled()) {
      try {
        await fs.ensureDir(mobileDomDir);
        const domContent = await page.content();
        const domFilePath = await getUniqueFilePath(mobileDomDir, fileName, '.html');
        await fs.writeFile(domFilePath, domContent, 'utf-8');
        entry.mobileDom = `pageDOMs/mobilePageDOMs/${getRelativeName(domFilePath, mobileDomDir)}`;
      } catch (err) {
        entry.errors.push(
          `Mobile DOM save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (isSavePageScreenshotEnabled()) {
      try {
        await fs.ensureDir(mobileScreenshotDir);
        const mobilePath = await getUniqueFilePath(mobileScreenshotDir, fileName, '.png');
        await page.screenshot({ path: mobilePath, fullPage: true });
        entry.mobileScreenshot = `pageDOMs/mobilePageScreenshots/${getRelativeName(mobilePath, mobileScreenshotDir)}`;
      } catch (err) {
        entry.errors.push(
          `Mobile screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    entry.errors.push(
      `Mobile viewport switch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (currentViewport) {
      try {
        await page.setViewportSize(currentViewport);
      } catch (err) {
        entry.errors.push(
          `Viewport restore failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  captureEntries.set(url, entry);
}

export async function writeManifest(randomToken: string): Promise<void> {
  if (!isPageCaptureEnabled()) return;
  if (captureEntries.size === 0) return;

  const pageDomsDir = getPageDomsDir(randomToken);
  await fs.ensureDir(pageDomsDir);

  const manifest = {
    generatedAt: new Date().toISOString(),
    pages: Array.from(captureEntries.values()).map(entry => ({
      url: entry.url,
      hash: entry.hash,
      ...(entry.desktopDom && { desktopDom: entry.desktopDom }),
      ...(entry.mobileDom && { mobileDom: entry.mobileDom }),
      ...(entry.desktopScreenshot && { desktopScreenshot: entry.desktopScreenshot }),
      ...(entry.mobileScreenshot && { mobileScreenshot: entry.mobileScreenshot }),
      errors: entry.errors,
    })),
  };

  const manifestPath = path.join(pageDomsDir, 'domManifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

export function resetCaptureEntries(): void {
  captureEntries.clear();
}
