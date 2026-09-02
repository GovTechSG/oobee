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
    // Default 0 = disabled. Any positive value enables the corresponding abort
    // trigger. This lets long-running scans survive extended bursts of 403s
    // (e.g. from transient WAF rate-limiting) without being aborted early.
    this.maxConsecutiveFailures = Number(process.env.OOBEE_CONSECUTIVE_MAX_RETRIES) || 0;
    this.maxRatchetCycles = Number(process.env.OOBEE_MAX_RATCHET_CYCLES) || 0;
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
    // Any success breaks a streak of failures, regardless of whether we're
    // running at reduced concurrency or not.
    this.consecutiveFailures = 0;

    // Two "already recovered" cases: caller didn't pass a pool (nothing to
    // recover), or the pool is already at (or above) the original ceiling.
    // In both, we're not in a reduced state, so clear the ratchet counter
    // to give the site a clean slate for the next hostile burst.
    if (!pool || pool.maxConcurrency >= this.originalMaxConcurrency) {
      this.ratchetCycles = 0;
      return;
    }

    // Concurrency is currently below original — we're partially recovering.
    // Count successes; every RECOVERY_INTERVAL of them earns +RECOVERY_STEP
    // back on the pool's maxConcurrency, capped at the original ceiling.
    this.successesSinceReduction++;
    if (this.successesSinceReduction >= CrawlRateController.RECOVERY_INTERVAL) {
      pool.maxConcurrency = Math.min(
        pool.maxConcurrency + CrawlRateController.RECOVERY_STEP,
        this.originalMaxConcurrency,
      );
      this.successesSinceReduction = 0;
      consoleLogger.info(`Recovering concurrency to ${pool.maxConcurrency}`);

      // Only a *full* recovery back to the original ceiling clears the ratchet.
      // Partial recovery (e.g. 2→4 when original was 10) keeps the counter so
      // a site that halves-recovers-halves indefinitely still hits the abort
      // threshold. This is the whole point of ratchetCycles — without it, the
      // recovery mechanism would let a permanently hostile site keep the
      // crawler alive at reduced concurrency forever.
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
    // Every failure adds to the consecutive streak; a single success resets it
    // (see onSuccess). This is the coarser of two abort triggers — it catches
    // outright dead sites where nothing ever works.
    this.consecutiveFailures++;

    // Halve concurrency on 4xx/5xx, but only when the caller hasn't opted out
    // and we're not already at the floor. Halving at 1 would be a no-op and
    // would burn a ratchet cycle for nothing.
    if (
      !options?.skipConcurrencyReduction &&
      typeof httpStatus === 'number' &&
      httpStatus >= 400 &&
      pool &&
      pool.maxConcurrency > 1
    ) {
      pool.maxConcurrency = Math.max(1, Math.floor(pool.maxConcurrency / 2));
      // Reset the recovery counter — the halving invalidates any partial
      // progress the site had made toward earning concurrency back.
      this.successesSinceReduction = 0;
      // Increment the ratchet. Only cleared by a *full* recovery in onSuccess.
      this.ratchetCycles++;
      consoleLogger.info(
        `Rate limited (HTTP ${httpStatus}) — reducing concurrency to ${pool.maxConcurrency} (ratchet cycle ${this.ratchetCycles}/${this.maxRatchetCycles})`,
      );
    }

    // First abort trigger: too many failures in a row with no successes in
    // between. Catches sites that never respond OK. maxConsecutiveFailures
    // <= 0 means this trigger is disabled (OOBEE_CONSECUTIVE_MAX_RETRIES=0 is
    // the default, so long scans don't abort just from a burst of 403s).
    if (this.maxConsecutiveFailures > 0 && this.consecutiveFailures >= this.maxConsecutiveFailures) {
      return true;
    }

    // Second abort trigger: the halve-recover-halve cycle happened too many
    // times without a full recovery. Catches sites that let just enough
    // requests through to keep the crawler alive but never enough to reach
    // original concurrency. This is the case that was hanging 12h scans.
    // maxRatchetCycles <= 0 means this trigger is disabled (default).
    if (this.maxRatchetCycles > 0 && this.ratchetCycles >= this.maxRatchetCycles) {
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
