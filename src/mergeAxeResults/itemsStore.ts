import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
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
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(filePath, line, 'utf8');
  }

  async *readRuleItems(category: string, ruleId: string): AsyncGenerator<ItemsStoreEntry> {
    const filePath = this.getRuleFilePath(category, ruleId);
    if (!fs.existsSync(filePath)) return;

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (line.trim()) {
        yield JSON.parse(line) as ItemsStoreEntry;
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
    await fs.rm(this.basePath, { recursive: true, force: true });
  }
}
