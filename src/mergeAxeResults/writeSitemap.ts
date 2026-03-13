import fs from 'fs-extra';
import path from 'path';
import { consoleLogger } from '../logs.js';
import type { PageInfo } from './types.js';

const writeSitemap = async (pagesScanned: PageInfo[], storagePath: string): Promise<void> => {
  const sitemapPath = path.join(storagePath, 'sitemap.txt');
  const content = pagesScanned.map(p => p.url).join('\n');
  await fs.writeFile(sitemapPath, content, { encoding: 'utf-8' });
  consoleLogger.info(`Sitemap written to ${sitemapPath}`);
};

export default writeSitemap;
