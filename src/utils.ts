import path from 'path';
import fs from 'fs-extra';
import constants from './constants/constants.js';
import { consoleLogger, errorsTxtPath } from './logs.js';
import { getStoragePath } from './utils/index.js';
let __shuttingDown = false;
let __stopAllLock: Promise<void> | null = null;
let __softCloseHandler: (() => Promise<void>) | null = null;

export function registerSoftClose(handler: () => Promise<void>) {
  __softCloseHandler = handler;
}

export async function softCloseBrowserAndContext() {
  if (!__softCloseHandler) {
    consoleLogger.info(
      'softCloseBrowserAndContext: no handler registered (probably not a custom-flow scan)',
    );
    return;
  }

  try {
    consoleLogger.info('softCloseBrowserAndContext: calling registered handler...');
    await __softCloseHandler();
  } catch (e: any) {
    consoleLogger.warn(`softCloseBrowserAndContext error: ${e?.message || e}`);
  }
}

/**
 * Register a resource so it can be stopped later.
 * Supports Crawlee crawlers, Playwright BrowserContexts, and Browsers.
 */
export function register(resource: any) {
  const name = resource?.constructor?.name;

  if (name?.endsWith('Crawler')) {
    constants.resources.crawlers.add(resource);
  } else if (name === 'BrowserContext') {
    constants.resources.browserContexts.add(resource);
  } else if (name === 'Browser') {
    constants.resources.browsers.add(resource);
  }

  return resource;
}

/**
 * Stops or tears down all tracked resources.
 * @param mode "graceful" (finish in-flight), "abort" (drop in-flight), or "teardown" (close immediately)
 * @param timeoutMs Max time to wait before forcing shutdown
 */
export async function stopAll({ mode = 'graceful', timeoutMs = 10_000 } = {}) {
  if (__stopAllLock) return __stopAllLock; // prevent overlap
  __stopAllLock = (async () => {
    const timeout = (ms: number) => new Promise(res => setTimeout(res, ms));
    consoleLogger.info(`Stop browsers starting, mode=${mode}, timeoutMs=${timeoutMs}`);

    // --- Crawlers ---
    for (const c of [...constants.resources.crawlers]) {
      try {
        const pool = (c as any).autoscaledPool;
        if (pool && typeof pool.isRunning !== 'undefined' && !pool.isRunning) {
          consoleLogger.info('Skipping crawler (already stopped)');
          continue;
        }

        consoleLogger.info(`Closing crawler (${mode})...`);
        if (mode === 'graceful') {
          if (typeof c.stop === 'function') {
            await Promise.race([c.stop(), timeout(timeoutMs)]);
          }
        } else if (mode === 'abort') {
          pool?.abort?.();
        } else if (typeof c.teardown === 'function') {
          await Promise.race([c.teardown(), timeout(timeoutMs)]);
        }
        consoleLogger.info(`Crawler closed (${mode})`);
      } catch (err) {
        consoleLogger.warn(`Error stopping crawler: ${(err as Error).message}`);
      } finally {
        constants.resources.crawlers.delete(c);
      }
    }

    // --- BrowserContexts ---
    for (const ctx of [...constants.resources.browserContexts]) {
      // compute once so we can also use in finally
      const pagesArr = typeof ctx.pages === 'function' ? ctx.pages() : [];
      const hasOpenPages = Array.isArray(pagesArr) && pagesArr.length > 0;

      try {
        const browser = typeof ctx.browser === 'function' ? ctx.browser() : null;
        if (browser && (browser as any).isClosed?.()) {
          consoleLogger.info('Skipping BrowserContext (browser already closed)');
          continue;
        }

        // ➜ Graceful: don't kill contexts that are still doing work
        if (mode === 'graceful' && hasOpenPages) {
          consoleLogger.info(
            `Skipping BrowserContext in graceful (has ${pagesArr.length} open page(s))`,
          );
          continue; // leave it for the teardown pass
        }

        // (Optional speed-up) close pages first if any
        if (hasOpenPages) {
          consoleLogger.info(`Closing ${pagesArr.length} page(s) before context close...`);
          for (const p of pagesArr) {
            try {
              await Promise.race([p.close(), timeout(1500)]);
            } catch {}
          }
        }

        consoleLogger.info('Closing BrowserContext...');
        if (typeof ctx.close === 'function') {
          await Promise.race([ctx.close(), timeout(timeoutMs)]);
        }
        consoleLogger.info('BrowserContext closed');

        // also close its browser (persistent contexts)
        const b = browser;
        if (b && !(b as any).isClosed?.()) {
          consoleLogger.info('Closing Browser (from context.browser())...');
          if (typeof b.close === 'function') {
            await Promise.race([b.close(), timeout(timeoutMs)]);
          }
          consoleLogger.info('Browser closed (from context.browser())');
        }
      } catch (err) {
        consoleLogger.warn(`Error closing BrowserContext: ${(err as Error).message}`);
      } finally {
        // only delete from the set if we actually closed it (or tried to)
        if (!(mode === 'graceful' && hasOpenPages)) {
          constants.resources.browserContexts.delete(ctx);
        }
      }
    }

    // --- Browsers ---
    for (const b of [...constants.resources.browsers]) {
      try {
        if ((b as any).isClosed?.()) {
          consoleLogger.info('Skipping Browser (already closed)');
          continue;
        }

        consoleLogger.info('Closing Browser...');
        if (typeof b.close === 'function') {
          await Promise.race([b.close(), timeout(timeoutMs)]);
        }
        consoleLogger.info('Browser closed');
      } catch (err) {
        consoleLogger.warn(`Error closing Browser: ${(err as Error).message}`);
      } finally {
        constants.resources.browsers.delete(b);
      }
    }

    consoleLogger.info(`Stop browsers finished for mode=${mode}`);
  })();

  try {
    await __stopAllLock;
  } finally {
    __stopAllLock = null;
  }
}

export const cleanUp = async (randomToken?: string, isError: boolean = false): Promise<void> => {
  if (isError) {
    await stopAll({ mode: 'graceful', timeoutMs: 8000 });
    await stopAll({ mode: 'teardown', timeoutMs: 4000 });
  }

  if (randomToken === undefined && constants.randomToken) {
    randomToken = constants.randomToken;
  }

  if (constants.userDataDirectory)
    try {
      fs.rmSync(constants.userDataDirectory, { recursive: true, force: true });
    } catch (error) {
      consoleLogger.warn(`Unable to force remove userDataDirectory: ${error.message}`);
    }

  if (randomToken !== undefined) {
    const storagePath = getStoragePath(randomToken);

    try {
      fs.rmSync(path.join(storagePath, 'crawlee'), { recursive: true, force: true });
    } catch (error) {
      consoleLogger.warn(`Unable to force remove crawlee folder: ${error.message}`);
    }

    try {
      fs.rmSync(path.join(storagePath, 'pdfs'), { recursive: true, force: true });
    } catch (error) {
      consoleLogger.warn(`Unable to force remove pdfs folder: ${error.message}`);
    }

    let deleteErrorLogFile = true;

    if (isError) {
      let logsPath = storagePath;

      if (process.env.OOBEE_LOGS_PATH) {
        logsPath = process.env.OOBEE_LOGS_PATH;
      }

      if (fs.existsSync(errorsTxtPath)) {
        try {
          const logFilePath = path.join(logsPath, `logs-${randomToken}.txt`);
          fs.copyFileSync(errorsTxtPath, logFilePath);
          console.log(`An error occured. Log file is located at: ${logFilePath}`);
        } catch (copyError) {
          consoleLogger.error(`Error copying errors file during cleanup: ${copyError.message}`);
          console.log(`An error occured. Log file is located at: ${errorsTxtPath}`);
          deleteErrorLogFile = false; // Do not delete the log file if copy failed
        }

        if (deleteErrorLogFile && fs.existsSync(errorsTxtPath)) {
          try {
            fs.unlinkSync(errorsTxtPath);
          } catch (error) {
            consoleLogger.warn(`Unable to delete log file ${errorsTxtPath}: ${error.message}`);
          }
        }
      }
    }

    if (fs.existsSync(storagePath) && fs.readdirSync(storagePath).length === 0) {
      try {
        fs.rmdirSync(storagePath);
        consoleLogger.info(`Deleted empty storage path: ${storagePath}`);
      } catch (error) {
        consoleLogger.warn(`Error deleting empty storage path ${storagePath}: ${error.message}`);
      }
    }

    consoleLogger.info(`Clean up completed for: ${randomToken}`);
  }
};

export const cleanUpAndExit = async (
  exitCode: number,
  randomToken?: string,
  isError: boolean = false,
): Promise<void> => {
  if (__shuttingDown) {
    consoleLogger.info('Cleanup already in progress; ignoring duplicate exit request.');
    return;
  }
  __shuttingDown = true;

  try {
    await cleanUp(randomToken, isError); // runs stopAll inside cleanUp
  } catch (e: any) {
    consoleLogger.warn(`Cleanup error: ${e?.message || e}`);
  }

  consoleLogger.info(`Exiting with code: ${exitCode}`);
  process.exit(exitCode); // explicit exit after cleanup completes
};

// Clean up listeners for process signals (e.g. parent process wants to stop Oobee scan mid-point)
// Necessary to remove residual userDataDirectory and crawlee files generated by Chrome/Edge browser on each run, so that storage does not baloon up on the server
export const listenForCleanUp = (randomToken: string): void => {
  consoleLogger.info(`PID: ${process.pid}`);

  // SIGINT signal happens when the user presses Ctrl+C in the terminal
  process.on('SIGINT', async () => {
    // ← keep handler installed
    consoleLogger.info('SIGINT received. Cleaning up and exiting.');
    await cleanUpAndExit(130, randomToken, true);
  });

  // SIGTERM signal happens when the process is terminated (by another process or system shutdown)
  process.on('SIGTERM', async () => {
    // ← keep handler installed
    consoleLogger.info('SIGTERM received. Cleaning up and exiting.');
    await cleanUpAndExit(143, randomToken, true);
  });

  // Note: user-defined signal reserved for application-specific use.
  // SIGUSR1 for handling closing playwright browser and continue generate artifacts etc
  process.on('SIGUSR1', async () => {
    consoleLogger.info('SIGUSR1 received. Soft-closing browser/context only.');
    await softCloseBrowserAndContext();
  });
};
