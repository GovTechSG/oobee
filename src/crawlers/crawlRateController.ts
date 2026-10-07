import { consoleLogger } from '../logs.js';

export interface ConcurrencyPool {
  maxConcurrency: number;
  minConcurrency?: number;
  desiredConcurrency?: number;
}

// Owns the crawl's concurrency. The pool is pinned (min = desired = max) to an
// effective target, so Crawlee's generic "system overloaded" heuristic (which
// also trips on memory snapshots and event-loop lag on shared CI runners) can't
// silently drop a `-t 10` scan to 1. Only two signals lower the target:
//   - 403/429 from the site (rateCap, halved per hit, fast recovery)
//   - pages whose main thread never went idle, i.e. real CPU starvation (cpuCap)
export class CrawlRateController {
  private scannedCount = 0;
  private readonly maxPages: number;
  private consecutiveFailures = 0;
  private successesSinceReduction = 0;
  // Halvings since the last full recovery to the ceiling; bounds a
  // halve-recover-halve loop when OOBEE_MAX_RATCHET_CYCLES is set.
  private ratchetCycles = 0;
  private readonly maxConsecutiveFailures: number;
  private readonly maxRatchetCycles: number;
  private readonly originalMaxConcurrency: number;
  private rateCap: number;
  private cpuCap: number;
  private recentBusy: boolean[] = [];
  private pagesSinceCpuChange = 0;

  static readonly RECOVERY_INTERVAL = Number(process.env.OOBEE_RATE_RECOVERY_INTERVAL) || 5;
  static readonly CPU_WINDOW = 10;
  static readonly CPU_BUSY_DOWN = 4;
  static readonly CPU_BUSY_UP = 1;

  constructor(maxRequestsPerCrawl: number, maxConcurrency: number) {
    this.maxPages = maxRequestsPerCrawl;
    // 0 = disabled (default), so long scans survive transient WAF bursts.
    this.maxConsecutiveFailures = Number(process.env.OOBEE_CONSECUTIVE_MAX_RETRIES) || 0;
    this.maxRatchetCycles = Number(process.env.OOBEE_MAX_RATCHET_CYCLES) || 0;
    this.originalMaxConcurrency = maxConcurrency;
    this.rateCap = maxConcurrency;
    this.cpuCap = maxConcurrency;
  }

  get target(): number {
    return Math.max(1, Math.min(this.rateCap, this.cpuCap));
  }

  get state(): { rateCap: number; cpuCap: number; ceiling: number; ratchetCycles: number } {
    return {
      rateCap: this.rateCap,
      cpuCap: this.cpuCap,
      ceiling: this.originalMaxConcurrency,
      ratchetCycles: this.ratchetCycles,
    };
  }

  apply(pool?: ConcurrencyPool): void {
    if (!pool) return;
    const t = this.target;
    // Lower min before max (and raise max before min) so min <= max holds throughout.
    if (typeof pool.minConcurrency === 'number' && pool.minConcurrency > t) pool.minConcurrency = t;
    pool.maxConcurrency = t;
    if (typeof pool.minConcurrency === 'number') pool.minConcurrency = t;
    if (typeof pool.desiredConcurrency === 'number') pool.desiredConcurrency = t;
  }

  claimSlot(): boolean {
    if (this.scannedCount >= this.maxPages) {
      return false;
    }
    this.scannedCount++;
    return true;
  }

  onSuccess(pool?: ConcurrencyPool): void {
    this.consecutiveFailures = 0;

    if (this.rateCap >= this.originalMaxConcurrency) {
      this.ratchetCycles = 0;
      return;
    }

    // Fast recovery: double the rate cap every RECOVERY_INTERVAL successes.
    // A site that 403s once in a while is back at full speed in a few dozen
    // pages instead of the ~hundred the old +2/10 step took.
    this.successesSinceReduction++;
    if (this.successesSinceReduction >= CrawlRateController.RECOVERY_INTERVAL) {
      this.rateCap = Math.min(this.rateCap * 2, this.originalMaxConcurrency);
      this.successesSinceReduction = 0;
      this.apply(pool);
      consoleLogger.info(
        `Recovering concurrency to ${this.target} (rate cap ${this.rateCap}, cpu cap ${this.cpuCap}, ceiling ${this.originalMaxConcurrency})`,
      );
      if (this.rateCap >= this.originalMaxConcurrency) {
        this.ratchetCycles = 0;
      }
    }
  }

  // Feed one waitForPageLoaded outcome. Steps cpuCap down when most recent
  // pages never reached main-thread idle, and back up once they do again.
  onPageLoad(mainThreadBusy: boolean, pool?: ConcurrencyPool): void {
    this.recentBusy.push(mainThreadBusy);
    if (this.recentBusy.length > CrawlRateController.CPU_WINDOW) this.recentBusy.shift();
    this.pagesSinceCpuChange++;
    // Wait a full window after each change so the new level is what's measured.
    if (
      this.recentBusy.length < CrawlRateController.CPU_WINDOW ||
      this.pagesSinceCpuChange < CrawlRateController.CPU_WINDOW
    ) {
      return;
    }
    const busy = this.recentBusy.filter(Boolean).length;
    let next = this.cpuCap;
    if (busy >= CrawlRateController.CPU_BUSY_DOWN && this.cpuCap > 1) {
      next = Math.max(1, Math.floor(this.cpuCap * 0.75));
    } else if (busy <= CrawlRateController.CPU_BUSY_UP && this.cpuCap < this.originalMaxConcurrency) {
      next = Math.min(this.originalMaxConcurrency, this.cpuCap + Math.max(1, Math.ceil(this.cpuCap * 0.25)));
    }
    if (next === this.cpuCap) return;
    const direction = next < this.cpuCap ? 'reducing' : 'recovering';
    this.cpuCap = next;
    this.pagesSinceCpuChange = 0;
    this.apply(pool);
    consoleLogger.info(
      `CPU starvation (${busy}/${CrawlRateController.CPU_WINDOW} recent pages main-thread busy) — ${direction} concurrency to ${this.target} (cpu cap ${this.cpuCap}, rate cap ${this.rateCap})`,
    );
  }

  onFailure(
    httpStatus: number | undefined,
    pool?: ConcurrencyPool,
    options?: { skipConcurrencyReduction?: boolean },
  ): boolean {
    this.consecutiveFailures++;

    if (
      !options?.skipConcurrencyReduction &&
      typeof httpStatus === 'number' &&
      httpStatus >= 400 &&
      this.rateCap > 1
    ) {
      this.rateCap = Math.max(1, Math.floor(this.rateCap / 2));
      this.successesSinceReduction = 0;
      this.ratchetCycles++;
      this.apply(pool);
      consoleLogger.info(
        `Rate limited (HTTP ${httpStatus}) — reducing concurrency to ${this.target} (ratchet cycle ${this.ratchetCycles}/${this.maxRatchetCycles})`,
      );
    } else if (typeof httpStatus === 'number' && httpStatus >= 400) {
      // Already at the floor: further 403s shouldn't let recovery progress carry over.
      this.successesSinceReduction = 0;
    }

    if (this.maxConsecutiveFailures > 0 && this.consecutiveFailures >= this.maxConsecutiveFailures) {
      return true;
    }

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

// Re-pins the live pool to the controller's target (each crawler.run() builds a
// fresh AutoscaledPool from the static options) and, when OOBEE_AUTOSCALE_DEBUG=1
// or OOBEE_VERBOSE=1, logs Crawlee's overload snapshot so CI logs show which
// metric (mem/cpu/event loop/client) it thinks is overloaded.
export const startConcurrencyEnforcer = (
  label: string,
  getPool: () => any,
  controller: CrawlRateController,
): (() => void) => {
  const debug = process.env.OOBEE_AUTOSCALE_DEBUG === '1' || process.env.OOBEE_VERBOSE === '1';
  const debugEveryMs = Number(process.env.OOBEE_AUTOSCALE_DEBUG_INTERVAL_MS) || 60000;
  const tickMs = 5000;
  let sinceLog = debugEveryMs;
  const fmt = (i: any) =>
    i ? `${i.isOverloaded ? 'OVER' : 'ok'}(${Number(i.actualRatio ?? 0).toFixed(2)}/${i.limitRatio})` : 'n/a';
  const timer = setInterval(() => {
    const pool = getPool();
    if (!pool) return;
    if (pool.minConcurrency !== controller.target || pool.maxConcurrency !== controller.target) {
      controller.apply(pool);
    }
    sinceLog += tickMs;
    if (!debug || sinceLog < debugEveryMs) return;
    sinceLog = 0;
    let hist: any;
    let cur: any;
    try {
      hist = pool.systemStatus?.getHistoricalStatus();
      cur = pool.systemStatus?.getCurrentStatus();
    } catch {
      // systemStatus is internal; tolerate shape changes across Crawlee versions
    }
    const s = controller.state;
    consoleLogger.info(
      `[autoscale ${label}] current=${pool.currentConcurrency} desired=${pool.desiredConcurrency} ` +
        `min=${pool.minConcurrency} max=${pool.maxConcurrency} | target=${controller.target} rateCap=${s.rateCap} ` +
        `cpuCap=${s.cpuCap} ceiling=${s.ceiling} | crawlee hist idle=${hist?.isSystemIdle} ` +
        `mem=${fmt(hist?.memInfo)} cpu=${fmt(hist?.cpuInfo)} loop=${fmt(hist?.eventLoopInfo)} client=${fmt(hist?.clientInfo)} ` +
        `| now mem=${fmt(cur?.memInfo)} cpu=${fmt(cur?.cpuInfo)}`,
    );
  }, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
};
