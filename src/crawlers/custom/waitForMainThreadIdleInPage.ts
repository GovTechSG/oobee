// Runs in the page context. Self-contained (no imports / outer bindings) so it
// can be passed directly to page.evaluate or stringified and eval'd inside a
// larger evaluate (see runAxeScript).
//
// Resolves once the main thread has had `requiredIdle` consecutive idle
// periods (requestIdleCallback with real idle time and no longtask entries in
// between), or once `timeoutMs` has elapsed. A starved renderer (CPU
// contention) does not yield idle periods, so this cannot be satisfied until
// the page's pending JS has actually run — unlike a wall-clock sleep.
export function waitForMainThreadIdleInPage({
  requiredIdle,
  timeoutMs,
}: {
  requiredIdle: number;
  timeoutMs: number;
}): Promise<{ reason: string }> {
  return new Promise<{ reason: string }>(resolve => {
    // Idle periods shorter than this are treated as "busy" — e.g. a
    // renderer squeezing a sliver of idle time between long tasks.
    const MIN_IDLE_MS = 5;
    const RIC_TIMEOUT_MS = 1000;
    const startedAt = performance.now();

    let consecutive = 0;
    let everReset = false;
    let sawLongTask = false;
    let longTaskObserver: PerformanceObserver | undefined;
    try {
      longTaskObserver = new PerformanceObserver(list => {
        if (list.getEntries().length > 0) sawLongTask = true;
      });
      longTaskObserver.observe({ type: 'longtask' });
    } catch {
      // longtask entries unsupported — fall back to idle periods alone
    }

    const ric: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => unknown =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback.bind(window)
        : cb =>
            setTimeout(
              () => cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline),
              50,
            );

    const finish = (reason: string) => {
      longTaskObserver?.disconnect();
      resolve({ reason });
    };

    const tick = (deadline: IdleDeadline) => {
      const idle =
        !deadline.didTimeout && deadline.timeRemaining() >= MIN_IDLE_MS && !sawLongTask;
      sawLongTask = false;
      if (idle) {
        consecutive++;
      } else {
        consecutive = 0;
        everReset = true;
      }

      if (consecutive >= requiredIdle) {
        finish(everReset ? 'main thread idle after work' : 'main thread idle');
        return;
      }
      if (performance.now() - startedAt > timeoutMs) {
        finish('main thread busy');
        return;
      }
      ric(tick, { timeout: RIC_TIMEOUT_MS });
    };

    ric(tick, { timeout: RIC_TIMEOUT_MS });
  });
}
