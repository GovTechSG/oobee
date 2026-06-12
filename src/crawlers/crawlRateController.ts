import { consoleLogger } from '../logs.js';

export class CrawlRateController {
  private scannedCount = 0;
  private readonly maxPages: number;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private readonly maxConsecutiveFailures: number;
  private readonly originalMaxConcurrency: number;
  private static readonly RECOVERY_INTERVAL = 20;

  constructor(maxRequestsPerCrawl: number, maxConcurrency: number) {
    this.maxPages = maxRequestsPerCrawl;
    this.maxConsecutiveFailures = Number(process.env.OOBEE_CONSECUTIVE_MAX_RETRIES) || 100;
    this.originalMaxConcurrency = maxConcurrency;
  }

  claimSlot(): boolean {
    if (this.scannedCount >= this.maxPages) {
      return false;
    }
    this.scannedCount++;
    return true;
  }

  onSuccess(pool?: { maxConcurrency: number }): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;

    if (pool && this.consecutiveSuccesses % CrawlRateController.RECOVERY_INTERVAL === 0) {
      if (pool.maxConcurrency < this.originalMaxConcurrency) {
        pool.maxConcurrency = Math.min(pool.maxConcurrency + 1, this.originalMaxConcurrency);
        consoleLogger.info(`Recovering concurrency to ${pool.maxConcurrency}`);
      }
    }
  }

  onFailure(httpStatus: number | undefined, pool?: { maxConcurrency: number }): boolean {
    if (typeof httpStatus !== 'number' || httpStatus < 400) {
      return false;
    }

    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;

    if (pool && pool.maxConcurrency > 1) {
      pool.maxConcurrency = Math.max(1, Math.floor(pool.maxConcurrency / 2));
      consoleLogger.info(
        `Rate limited (HTTP ${httpStatus}) — reducing concurrency to ${pool.maxConcurrency}`,
      );
    }

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      return true;
    }

    return false;
  }

  isLimitReached(): boolean {
    return this.scannedCount >= this.maxPages;
  }
}
