import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
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
//   - renderer crashes / sustained container memory pressure (memCap)
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
  private memCap: number;
  private lastMemChange = 0;
  private memHighSince = 0;
  private memLowSince = 0;
  private recentBusy: boolean[] = [];
  private pagesSinceCpuChange = 0;

  static readonly RECOVERY_INTERVAL = Number(process.env.OOBEE_RATE_RECOVERY_INTERVAL) || 5;
  static readonly CPU_WINDOW = 10;
  static readonly CPU_BUSY_DOWN = 4;
  static readonly CPU_BUSY_UP = 1;
  static readonly MEM_HIGH = Number(process.env.OOBEE_MEM_PRESSURE_HIGH) || 0.9;
  static readonly MEM_LOW = Number(process.env.OOBEE_MEM_PRESSURE_LOW) || 0.75;
  static readonly MEM_HOLD_MS = 60000;
  static readonly CRASH_COOLDOWN_MS = 15000;
  static readonly CRASH_FREE_RECOVERY_MS = 120000;

  constructor(maxRequestsPerCrawl: number, maxConcurrency: number) {
    this.maxPages = maxRequestsPerCrawl;
    // 0 = disabled (default), so long scans survive transient WAF bursts.
    this.maxConsecutiveFailures = Number(process.env.OOBEE_CONSECUTIVE_MAX_RETRIES) || 0;
    this.maxRatchetCycles = Number(process.env.OOBEE_MAX_RATCHET_CYCLES) || 0;
    this.originalMaxConcurrency = maxConcurrency;
    this.rateCap = maxConcurrency;
    this.cpuCap = maxConcurrency;
    this.memCap = maxConcurrency;
  }

  get target(): number {
    return Math.max(1, Math.min(this.rateCap, this.cpuCap, this.memCap));
  }

  get state(): { rateCap: number; cpuCap: number; memCap: number; ceiling: number; ratchetCycles: number } {
    return {
      rateCap: this.rateCap,
      cpuCap: this.cpuCap,
      memCap: this.memCap,
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

  // A renderer crash is almost always OOM: halve immediately. Concurrent pages
  // usually crash together, so one halving per cooldown, not one per page.
  onRendererCrash(pool?: ConcurrencyPool, url?: string): void {
    const now = Date.now();
    if (now - this.lastMemChange < CrawlRateController.CRASH_COOLDOWN_MS || this.memCap <= 1) return;
    this.memCap = Math.max(1, Math.floor(Math.min(this.memCap, this.target) / 2));
    this.lastMemChange = now;
    this.memLowSince = 0;
    this.apply(pool);
    consoleLogger.info(
      `Renderer crashed (likely out of memory)${url ? ` on ${url}` : ''} — reducing concurrency to ${this.target} (mem cap ${this.memCap})`,
    );
  }

  // Container memory usage ratio (0..1). Steps memCap down after sustained
  // high pressure and back up after sustained headroom.
  onMemorySample(ratio: number, pool?: ConcurrencyPool): void {
    if (!Number.isFinite(ratio)) return;
    const now = Date.now();
    if (ratio >= CrawlRateController.MEM_HIGH) {
      this.memLowSince = 0;
      this.memHighSince ||= now;
      if (
        this.memCap > 1 &&
        now - this.memHighSince >= CrawlRateController.MEM_HOLD_MS &&
        now - this.lastMemChange >= CrawlRateController.MEM_HOLD_MS
      ) {
        this.memCap = Math.max(1, Math.floor(Math.min(this.memCap, this.target) * 0.75));
        this.lastMemChange = now;
        this.apply(pool);
        consoleLogger.info(
          `Memory pressure (${(ratio * 100).toFixed(0)}% of container limit) — reducing concurrency to ${this.target} (mem cap ${this.memCap})`,
        );
      }
    } else if (ratio <= CrawlRateController.MEM_LOW) {
      this.memHighSince = 0;
      this.memLowSince ||= now;
      if (
        this.memCap < this.originalMaxConcurrency &&
        now - this.memLowSince >= CrawlRateController.MEM_HOLD_MS &&
        now - this.lastMemChange >= CrawlRateController.MEM_HOLD_MS
      ) {
        this.memCap = Math.min(this.originalMaxConcurrency, this.memCap + 1);
        this.lastMemChange = now;
        this.apply(pool);
        consoleLogger.info(
          `Memory headroom (${(ratio * 100).toFixed(0)}% of container limit) — recovering concurrency to ${this.target} (mem cap ${this.memCap})`,
        );
      }
    } else {
      this.memHighSince = 0;
      this.memLowSince = 0;
    }
  }

  // No memory reading on this platform: recover memCap by 1 after each
  // crash-free CRASH_FREE_RECOVERY_MS so a crash doesn't cap the rest of the scan.
  onNoMemorySample(pool?: ConcurrencyPool): void {
    if (this.memCap >= this.originalMaxConcurrency) return;
    const now = Date.now();
    if (now - this.lastMemChange < CrawlRateController.CRASH_FREE_RECOVERY_MS) return;
    this.memCap = Math.min(this.originalMaxConcurrency, this.memCap + 1);
    this.lastMemChange = now;
    this.apply(pool);
    consoleLogger.info(
      `No renderer crash for ${CrawlRateController.CRASH_FREE_RECOVERY_MS / 1000}s — recovering concurrency to ${this.target} (mem cap ${this.memCap})`,
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

// Real memory usage vs the container limit (cgroup v2, then v1), else host RAM.
// Not Crawlee's memInfo: that compares against availableMemoryRatio (25% of the
// limit by default) and reads 100% overloaded on any busy shared runner.
const readNum = (f: string): number | undefined => {
  try {
    const v = fs.readFileSync(f, 'utf8').trim();
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
};
const readCgroupInactiveFile = (f: string, key: string): number => {
  try {
    const m = fs.readFileSync(f, 'utf8').match(new RegExp(`^${key} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
};
export const readMemoryPressure = (): number | undefined => {
  const hostTotal = os.totalmem();
  const v2Limit = readNum('/sys/fs/cgroup/memory.max');
  const v2Used = readNum('/sys/fs/cgroup/memory.current');
  if (v2Limit && v2Used && v2Limit < hostTotal * 4) {
    // Page cache is reclaimable; counting it would read as constant pressure.
    const used = v2Used - readCgroupInactiveFile('/sys/fs/cgroup/memory.stat', 'inactive_file');
    return Math.min(1, Math.max(0, used / Math.min(v2Limit, hostTotal)));
  }
  const v1Limit = readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const v1Used = readNum('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (v1Limit && v1Used && v1Limit < hostTotal * 4) {
    const used = v1Used - readCgroupInactiveFile('/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file');
    return Math.min(1, Math.max(0, used / Math.min(v1Limit, hostTotal)));
  }
  return readHostMemoryPressure(hostTotal);
};

const clampRatio = (n: number): number | undefined =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;

// Linux without a cgroup limit (e.g. Fargate with only a task-level size, or
// bare metal): MemAvailable counts reclaimable cache; os.freemem() does not.
const readLinuxMemAvailable = (hostTotal: number): number | undefined => {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
    return m ? clampRatio(1 - (Number(m[1]) * 1024) / hostTotal) : undefined;
  } catch {
    return undefined;
  }
};

// macOS: os.freemem() is only truly free pages, so it reads ~100% used on any
// Mac. vm_stat's inactive/speculative/purgeable pages are reclaimable. vm_stat
// is a subprocess, so it is sampled in the background and the last value used.
let darwinRatio: number | undefined;
let darwinSampling = false;
const sampleDarwin = (hostTotal: number): void => {
  if (darwinSampling) return;
  darwinSampling = true;
  execFile('vm_stat', { timeout: 3000 }, (err, stdout) => {
    darwinSampling = false;
    if (err) return;
    const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1]) || 4096;
    const pages = (label: string) => Number(stdout.match(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, 'm'))?.[1]) || 0;
    const reclaimable = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
    darwinRatio = clampRatio(1 - (reclaimable * pageSize) / hostTotal);
  });
};

const readHostMemoryPressure = (hostTotal: number): number | undefined => {
  if (process.platform === 'linux') {
    return readLinuxMemAvailable(hostTotal) ?? clampRatio(1 - os.freemem() / hostTotal);
  }
  if (process.platform === 'darwin') {
    sampleDarwin(hostTotal);
    return darwinRatio;
  }
  // Windows: os.freemem() is ullAvailPhys, which already includes standby cache.
  return clampRatio(1 - os.freemem() / hostTotal);
};

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
    const memRatio = readMemoryPressure();
    if (memRatio !== undefined) controller.onMemorySample(memRatio, pool);
    else controller.onNoMemorySample(pool);
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
        `cpuCap=${s.cpuCap} memCap=${s.memCap} ceiling=${s.ceiling} | crawlee hist idle=${hist?.isSystemIdle} ` +
        `mem=${fmt(hist?.memInfo)} cpu=${fmt(hist?.cpuInfo)} loop=${fmt(hist?.eventLoopInfo)} client=${fmt(hist?.clientInfo)} ` +
        `| now mem=${fmt(cur?.memInfo)} cpu=${fmt(cur?.cpuInfo)} | container mem=${memRatio === undefined ? 'n/a' : `${(memRatio * 100).toFixed(0)}%`}`,
    );
  }, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
};
