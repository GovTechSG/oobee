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

interface AbortableCrawler {
  autoscaledPool?: { abort: () => Promise<void> };
}

let currentCrawler: AbortableCrawler | null = null;
let handlerInstalled = false;
let shutdownRequested = false;
let receivedSignal: NodeJS.Signals | null = null;

export function registerCrawler(crawler: AbortableCrawler): void {
  currentCrawler = crawler;
}

export function unregisterCrawler(crawler: AbortableCrawler): void {
  if (currentCrawler === crawler) {
    currentCrawler = null;
  }
}

export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

export function getShutdownSignal(): NodeJS.Signals | null {
  return receivedSignal;
}

export function initShutdownHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;

  const handleShutdown = (signal: NodeJS.Signals) => {
    if (shutdownRequested) {
      // A second signal while we're already shutting down — the user (or the
      // container) really wants us out. Exit immediately.
      consoleLogger.warn(`Received second ${signal} — exiting immediately.`);
      process.exit(143);
    }
    shutdownRequested = true;
    receivedSignal = signal;
    consoleLogger.warn(
      `Received ${signal} — aborting current crawler and finalizing partial report.`,
    );
    if (currentCrawler?.autoscaledPool) {
      Promise.resolve(currentCrawler.autoscaledPool.abort()).catch(err => {
        consoleLogger.error(`Error aborting crawler pool on ${signal}: ${err}`);
      });
    } else {
      consoleLogger.info(`No active crawler to abort on ${signal}.`);
    }
  };

  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}
