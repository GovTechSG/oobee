import type { BrowserContext, Page, Request, Response } from 'playwright';

const QUIET_MS = 1000;
const MAX_SETTLE_MS = 15000;
const MAX_META_REFRESH_SECONDS = 10;
const MAX_TIMER_MS = 5000;
const POLL_MS = 50;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const isNavigatingError = (error: unknown) =>
  /is navigating|navigation|Execution context was destroyed|frame was detached/i.test(
    (error as Error)?.message || '',
  );

const mainFramePage = (frame: { page: () => Page; parentFrame: () => unknown }): Page | null => {
  try {
    return frame.parentFrame() ? null : frame.page();
  } catch {
    return null;
  }
};

// Seconds until a <meta http-equiv="refresh"> that points elsewhere fires, or null.
const readMetaRefreshDelay = async (page: Page): Promise<number | null> => {
  try {
    const content = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="refresh" i]');
      return meta ? meta.getAttribute('content') : null;
    });
    if (!content) return null;
    const match = /^\s*(\d+(?:\.\d+)?)?\s*[;,]?\s*(?:url\s*=\s*)?(.*)$/i.exec(content);
    const target = match?.[2]?.trim().replace(/^['"]|['"]$/g, '');
    if (!target) return null; // self-refresh, not a redirect
    if (new URL(target, page.url()).href === page.url()) return null;
    return Number(match?.[1] || 0);
  } catch {
    return null;
  }
};

// Records due times of pending setTimeout callbacks so a delayed JS redirect is
// waited for deterministically rather than guessed at with a sleep.
const TIMER_TRACKER = `(() => {
  if (window.__oobeeTimers) return;
  const pending = new Map();
  window.__oobeeTimers = pending;
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  window.setTimeout = function (fn, ms, ...args) {
    const delay = Number(ms) || 0;
    const id = set(function () {
      pending.delete(id);
      return typeof fn === 'function' ? fn.apply(this, args) : undefined;
    }, delay);
    pending.set(id, Date.now() + delay);
    return id;
  };
  window.clearTimeout = function (id) { pending.delete(id); return clear(id); };
})();`;

// Latest due time (ms from now) of timers already pending, capped; null if none.
const readPendingTimerDelay = async (page: Page, maxMs: number): Promise<number | null> => {
  try {
    return await page.evaluate(limit => {
      const pending = (window as unknown as { __oobeeTimers?: Map<number, number> }).__oobeeTimers;
      if (!pending) return null;
      const now = Date.now();
      let latest: number | null = null;
      for (const due of pending.values()) {
        const wait = due - now;
        if (wait > 0 && wait <= limit) latest = Math.max(latest ?? 0, wait);
      }
      return latest;
    }, maxMs);
  } catch {
    return null;
  }
};

/**
 * Follows client-side redirects (meta refresh, location changes, window.open
 * popups) after page.goto() until the main frame has had no navigation for
 * QUIET_MS. Returns the page holding the final document, every main-frame
 * document response, and every main-frame navigation URL requested (including
 * ones that failed or were blocked) so callers can vet each hop.
 */
export const settleClientRedirects = async (
  context: BrowserContext,
  page: Page,
  navigate: () => Promise<Response | null>,
): Promise<{
  page: Page;
  finalResponse: Response | null;
  responses: Response[];
  requestedUrls: string[];
  failedNavigation: string | null;
}> => {
  let current = page;
  const tracked = new Set<Page>([page]);
  const inflight = new Set<Request>();
  const responses: Response[] = [];
  const requestedUrls = new Set<string>();
  let failedNavigation: string | null = null;
  const lastResponse = new Map<Page, Response>();
  let lastActivity = Date.now();
  let metaChecked = false;
  let holdUntil = 0;

  const activity = () => {
    lastActivity = Date.now();
    metaChecked = false;
    holdUntil = 0;
  };
  const trackedMainFrameRequest = (request: Request) => {
    try {
      if (!request.isNavigationRequest()) return false;
      const owner = mainFramePage(request.frame());
      return !!owner && tracked.has(owner);
    } catch {
      return false;
    }
  };
  // eslint-disable-next-line prefer-const
  let onFrameNavigated: (frame: { page: () => Page; parentFrame: () => unknown }) => void;
  const onPopup = (popup: Page) => {
    tracked.add(popup);
    popup.on('popup', onPopup);
    popup.on('framenavigated', onFrameNavigated);
    current = popup;
    activity();
  };
  const onRequest = (request: Request) => {
    if (!trackedMainFrameRequest(request)) return;
    inflight.add(request);
    requestedUrls.add(request.url());
    activity();
  };
  const onRequestDone = (request: Request) => {
    if (!inflight.delete(request)) return;
    failedNavigation = request.failure()?.errorText ?? null;
    activity();
  };
  const onResponse = (response: Response) => {
    const request = response.request();
    if (!trackedMainFrameRequest(request)) return;
    // Redirect (3xx) responses are reachable via redirectedFrom() of the next one.
    if (response.status() >= 300 && response.status() < 400 && response.headers().location) return;
    responses.push(response);
    lastResponse.set(mainFramePage(request.frame()), response);
  };
  onFrameNavigated = frame => {
    const owner = mainFramePage(frame);
    if (owner && tracked.has(owner)) activity();
  };

  await context.addInitScript(TIMER_TRACKER);
  page.on('popup', onPopup);
  context.on('request', onRequest);
  context.on('requestfinished', onRequestDone);
  context.on('requestfailed', onRequestDone);
  context.on('response', onResponse);
  page.on('framenavigated', onFrameNavigated);

  try {
    try {
      await navigate();
    } catch (error) {
      // An immediate client redirect can interrupt goto(); keep following it.
      if (!/interrupted by another navigation/i.test((error as Error)?.message || '')) throw error;
    }

    const deadline = Date.now() + MAX_SETTLE_MS;
    while (Date.now() < deadline) {
      if (current.isClosed()) {
        const open = [...tracked].filter(p => !p.isClosed());
        if (!open.length) break;
        current = open[open.length - 1];
        activity();
      }
      if (inflight.size === 0 && Date.now() - lastActivity >= QUIET_MS) {
        if (!metaChecked) {
          metaChecked = true;
          // Redirects scheduled from onload only start once load fires.
          await current.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
          if (Date.now() - lastActivity < QUIET_MS) continue;
          // Snapshot once per quiet period, so polling loops that keep
          // re-arming timers cannot extend the wait.
          const metaDelay = await readMetaRefreshDelay(current);
          const timerMs = await readPendingTimerDelay(current, MAX_TIMER_MS);
          const waitMs = Math.max(
            metaDelay !== null && metaDelay <= MAX_META_REFRESH_SECONDS ? metaDelay * 1000 : -1,
            timerMs ?? -1,
          );
          if (waitMs >= 0) holdUntil = Date.now() + waitMs + QUIET_MS;
          continue;
        }
        if (Date.now() >= holdUntil) break;
      }
      await sleep(POLL_MS);
    }

    await current.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return {
      page: current,
      finalResponse: lastResponse.get(current) ?? null,
      responses,
      requestedUrls: [...requestedUrls],
      failedNavigation,
    };
  } finally {
    context.off('request', onRequest);
    context.off('requestfinished', onRequestDone);
    context.off('requestfailed', onRequestDone);
    context.off('response', onResponse);
    for (const p of tracked) {
      p.off('popup', onPopup);
      p.off('framenavigated', onFrameNavigated);
    }
  }
};

// page.content() throws while a navigation is committing; wait it out and retry.
export const readSettledContent = async (page: Page, attempts = 5): Promise<string> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return await page.content();
    } catch (error) {
      if (attempt >= attempts || !isNavigatingError(error)) throw error;
      await sleep(250);
    }
  }
};
