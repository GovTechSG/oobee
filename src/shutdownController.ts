import { consoleLogger } from './logs.js';

// A shared shutdown controller so combine.ts can install a single SIGTERM/SIGINT
// handler and the currently running crawler can be aborted from that handler.
// Without this, a container/runner sending SIGTERM (e.g. GitHub Actions job
// timeout, `docker stop`) leaves Crawlee running until SIGKILL lands mid-write,
// which is the "corrupted results.zip" symptom observed in production.
//
// The handler triggers the same autoscaledPool.abort() path used by the idle
// watchdog, so finalization (writeManifest → generateArtifacts → submitForm →
// S3 upload) runs the same way it does for an idle abort.

// Minimal shape we need from a Crawlee crawler — only the pool's abort() is
// actually called. Kept narrow so we don't couple the shutdown module to
// Crawlee's full crawler surface.
interface AbortableCrawler {
  autoscaledPool?: { abort: () => Promise<void> };
}

// The single active crawler for this process. Only one crawl phase runs at a
// time (sitemap OR domain OR click-pass iteration), so a scalar is enough —
// the current phase registers itself in registerCrawler and the previous
// phase has already unregistered by then.
let currentCrawler: AbortableCrawler | null = null;
// Guards against installing the SIGTERM/SIGINT handlers twice if
// initShutdownHandler() is called more than once (e.g. combineRun invoked
// multiple times in a long-lived process).
let handlerInstalled = false;
// Latched true the first time a shutdown signal arrives. Never cleared —
// once we decide to shut down, downstream code (crawler post-run checks)
// should stay on the abort path even if the pool.abort() promise resolves.
let shutdownRequested = false;
// The signal that triggered shutdown, exposed for callers that want to log
// or branch on SIGTERM vs SIGINT.
let receivedSignal: NodeJS.Signals | null = null;

// Called by each crawler right before crawler.run() so that if a signal
// arrives mid-run, the handler knows which pool to abort.
export function registerCrawler(crawler: AbortableCrawler): void {
  currentCrawler = crawler;
}

// Called after crawler.run() returns. The identity check prevents a stale
// unregister call from clobbering a newer registration — belt-and-braces for
// the sequential-phases pattern in crawlDomain's click-pass loop.
export function unregisterCrawler(crawler: AbortableCrawler): void {
  if (currentCrawler === crawler) {
    currentCrawler = null;
  }
}

// Post-run branches in crawlSitemap/crawlDomain call this to decide whether
// to treat the completed run as a normal finish or a signal-triggered abort
// (in which case they set their local isAbortingScan flag so downstream
// finalization writes a partial report).
export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

export function getShutdownSignal(): NodeJS.Signals | null {
  return receivedSignal;
}

export function initShutdownHandler(): void {
  // Idempotent — safe to call more than once.
  if (handlerInstalled) return;
  handlerInstalled = true;

  const handleShutdown = (signal: NodeJS.Signals) => {
    if (shutdownRequested) {
      // A second signal while we're already shutting down means the caller
      // (usually the container escalating toward SIGKILL) has given up on
      // graceful exit. Exit immediately with 128 + SIGTERM(15) = 143, the
      // conventional exit code for termination-by-SIGTERM.
      consoleLogger.warn(`Received second ${signal} — exiting immediately.`);
      process.exit(143);
    }
    // Latch the shutdown state before doing any async work. Any signal that
    // arrives during pool.abort() will now take the "second signal" branch.
    shutdownRequested = true;
    receivedSignal = signal;
    consoleLogger.warn(
      `Received ${signal} — aborting current crawler and finalizing partial report.`,
    );
    if (currentCrawler?.autoscaledPool) {
      // abort() returns a Promise. We can't await here (signal handlers are
      // sync), so fire-and-forget with a catch to log rejections. Crawler
      // exit + finalization happens via the awaited crawler.run() in the
      // caller — this pool.abort() just unblocks that await.
      Promise.resolve(currentCrawler.autoscaledPool.abort()).catch(err => {
        consoleLogger.error(`Error aborting crawler pool on ${signal}: ${err}`);
      });
    } else {
      // Signal arrived between crawl phases (or before the first phase
      // started). Nothing to abort — the shutdownRequested flag will still
      // cause the next phase's post-run check to bail.
      consoleLogger.info(`No active crawler to abort on ${signal}.`);
    }
  };

  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}
