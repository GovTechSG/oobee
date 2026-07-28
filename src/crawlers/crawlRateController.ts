import { consoleLogger } from '../logs.js';

export class CrawlRateController {
  private scannedCount = 0;
  private readonly maxPages: number;
  private consecutiveFailures = 0;
  private successesSinceReduction = 0;
  private readonly maxConsecutiveFailures: number;
  private readonly originalMaxConcurrency: number;
  private static readonly RECOVERY_INTERVAL = 10;
  private static readonly RECOVERY_STEP = 2;

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

    if (!pool || pool.maxConcurrency >= this.originalMaxConcurrency) {
      return;
    }

    this.successesSinceReduction++;
    if (this.successesSinceReduction >= CrawlRateController.RECOVERY_INTERVAL) {
      pool.maxConcurrency = Math.min(
        pool.maxConcurrency + CrawlRateController.RECOVERY_STEP,
        this.originalMaxConcurrency,
      );
      this.successesSinceReduction = 0;
      consoleLogger.info(`Recovering concurrency to ${pool.maxConcurrency}`);
    }
  }

  onFailure(
    httpStatus: number | undefined,
    pool?: { maxConcurrency: number },
    options?: { skipConcurrencyReduction?: boolean },
  ): boolean {
    this.consecutiveFailures++;

    if (
      !options?.skipConcurrencyReduction &&
      typeof httpStatus === 'number' &&
      httpStatus >= 400 &&
      pool &&
      pool.maxConcurrency > 1
    ) {
      pool.maxConcurrency = Math.max(1, Math.floor(pool.maxConcurrency / 2));
      this.successesSinceReduction = 0;
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
