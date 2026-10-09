import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import { consoleLogger } from '../logs.js';
import type { ItemsInfo } from './types.js';

export interface ItemsStoreEntry {
  url: string;
  pageTitle: string;
  items: ItemsInfo[];
  filePath?: string;
  pageIndex?: number;
  pageImagePath?: string;
  metadata?: string;
}

export class ItemsStore {
  private basePath: string;
  private ensuredDirs = new Set<string>();
  private fileWriteQueues = new Map<string, Promise<void>>();

  constructor(storagePath: string) {
    this.basePath = path.join(storagePath, 'tmp-items');
  }

  private sanitizeRuleId(ruleId: string): string {
    return ruleId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private getRuleFilePath(category: string, ruleId: string): string {
    return path.join(this.basePath, category, `${this.sanitizeRuleId(ruleId)}.jsonl`);
  }

  private async ensureDir(category: string): Promise<void> {
    const dirPath = path.join(this.basePath, category);
    if (!this.ensuredDirs.has(dirPath)) {
      await fs.ensureDir(dirPath);
      this.ensuredDirs.add(dirPath);
    }
  }

  async appendPageItems(category: string, ruleId: string, entry: ItemsStoreEntry): Promise<void> {
    await this.ensureDir(category);
    const filePath = this.getRuleFilePath(category, ruleId);
    let line = JSON.stringify(entry);

    // readline also splits on U+2028/U+2029, which JSON.stringify leaves unescaped
    // (e.g. in page titles), so escape every line terminator readline recognises.
    line = line.replace(/[\n\r\u2028\u2029]/g, (match) => {
      if (match === '\n') return '\\n';
      if (match === '\r') return '\\r';
      return match === '\u2028' ? '\\u2028' : '\\u2029';
    });
    line += '\n';

    // Serialize writes per rule file to avoid concurrent append interleaving/truncation.
    const previous = this.fileWriteQueues.get(filePath) ?? Promise.resolve();
    const next = previous.then(() => fs.appendFile(filePath, line, 'utf8'));
    this.fileWriteQueues.set(
      filePath,
      next.catch(() => {
        // Keep queue alive for subsequent writes.
      }),
    );

    await next;
  }

  async *readRuleItems(category: string, ruleId: string): AsyncGenerator<ItemsStoreEntry> {
    const filePath = this.getRuleFilePath(category, ruleId);
    if (!fs.existsSync(filePath)) return;

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber += 1;
      if (!line.trim()) continue;

      try {
        yield JSON.parse(line) as ItemsStoreEntry;
      } catch (error) {
        // Tolerate malformed/truncated JSONL lines (e.g. interrupted append) so report generation can continue.
        const preview = line.slice(0, 200);
        consoleLogger.warn(
          `Skipping malformed itemsStore JSONL line ${lineNumber} in ${filePath}: ${(error as Error).message}. Content preview: ${preview}`,
        );
      }
    }
  }

  async readRuleItemsMap(category: string, ruleId: string): Promise<Map<string, ItemsStoreEntry>> {
    const map = new Map<string, ItemsStoreEntry>();
    for await (const entry of this.readRuleItems(category, ruleId)) {
      const key = entry.pageIndex != null ? String(entry.pageIndex) : entry.url;
      map.set(key, entry);
    }
    return map;
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.fileWriteQueues.values());
    await fs.rm(this.basePath, { recursive: true, force: true });
  }
}
