import { consoleLogger } from '../logs.js';

export class CrawlRateController {
  private scannedCount = 0;
  private readonly maxPages: number;
  private consecutiveFailures = 0;
  private successesSinceReduction = 0;
  // Counts how many times concurrency has been halved without ever recovering
  // back to the original ceiling in between. Resets only when concurrency
  // returns to originalMaxConcurrency. Bounds the ratchet-recovery-ratchet
  // cycle that would otherwise let a permanently hostile site keep the scan
  // alive indefinitely at low concurrency.
  private ratchetCycles = 0;
  private readonly maxConsecutiveFailures: number;
  private readonly maxRatchetCycles: number;
  private readonly originalMaxConcurrency: number;
  private static readonly RECOVERY_INTERVAL = 10;
  private static readonly RECOVERY_STEP = 2;

  constructor(maxRequestsPerCrawl: number, maxConcurrency: number) {
    this.maxPages = maxRequestsPerCrawl;
    this.maxConsecutiveFailures = Number(process.env.OOBEE_CONSECUTIVE_MAX_RETRIES) || 100;
    this.maxRatchetCycles = Number(process.env.OOBEE_MAX_RATCHET_CYCLES) || 5;
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
      // Full recovery — clear the ratchet counter so the site gets a clean slate.
      this.ratchetCycles = 0;
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

      if (pool.maxConcurrency >= this.originalMaxConcurrency) {
        this.ratchetCycles = 0;
      }
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
      this.ratchetCycles++;
      consoleLogger.info(
        `Rate limited (HTTP ${httpStatus}) — reducing concurrency to ${pool.maxConcurrency} (ratchet cycle ${this.ratchetCycles}/${this.maxRatchetCycles})`,
      );
    }

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      return true;
    }

    if (this.ratchetCycles >= this.maxRatchetCycles) {
      consoleLogger.info(
        `Concurrency has been reduced ${this.ratchetCycles} times without recovering to ${this.originalMaxConcurrency} — treating site as permanently hostile.`,
      );
      return true;
    }

    return false;
  }

  isLimitReached(): boolean {
    return this.scannedCount >= this.maxPages;
  }
}
