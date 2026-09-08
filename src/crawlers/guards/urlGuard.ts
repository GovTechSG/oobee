const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function addUrlGuardScript(context, opts = {}) {
  const { fallbackUrl, allowChromeErrors }: any = opts;

  const allowedProtocols = allowChromeErrors
    ? new Set([...ALLOWED_PROTOCOLS, 'chrome-error:'])
    : ALLOWED_PROTOCOLS;

  const lastAllowedUrlByPage = new WeakMap();

  // Block navigation requests to non-http(s) schemes BEFORE they are dispatched.
  // The framenavigated listener below is a fallback for in-page navigations
  // that don't hit the network (e.g. history.pushState), but route interception
  // is the primary gate because it fires before the destination page has a
  // chance to load any code.
  //
  // Guards every frame — not just the main frame — because a scripted <iframe>
  // pointed at `javascript:`, `data:`, or `file://` can be used to exfiltrate
  // credentials attached to the parent context.
  context
    .route('**/*', async (route, request) => {
      try {
        if (!request.isNavigationRequest()) {
          await route.fallback();
          return;
        }
        const target = new URL(request.url());
        if (!allowedProtocols.has(target.protocol)) {
          await route.abort('blockedbyclient');
          return;
        }
        await route.fallback();
      } catch {
        try { await route.abort('blockedbyclient'); } catch { /* route already resolved */ }
      }
    })
    .catch(() => {
      // context may have closed before route setup; safe to ignore
    });

  const attachGuardsToPage = page => {
    if (!lastAllowedUrlByPage.has(page) && fallbackUrl) {
      lastAllowedUrlByPage.set(page, String(fallbackUrl));
    }

    page
      .addInitScript(() => {
        const isAllowedProtocol = value => {
          try {
            const s = value instanceof URL ? value.toString() : String(value);
            const { protocol } = new URL(s, window.location.href);
            return protocol === 'http:' || protocol === 'https:';
          } catch {
            return false;
          }
        };

        const win = window;

        const openOriginal = win.open;
        win.open = function (targetUrl, ...args) {
          if (!isAllowedProtocol(targetUrl)) return null;
          return openOriginal.call(this, targetUrl, ...args);
        };
      })
      .catch(() => {
        // page may have closed before addInitScript completed; safe to ignore
      });

    const restoreToSafeUrl = async (page, attemptedUrl) => {
      const safeUrl = lastAllowedUrlByPage.get(page) || fallbackUrl || 'about:blank';
      // Only redirect if the safe URL is itself an allowed (http/https) URL.
      // If the entry URL is file:// (e.g. scanning a local HTML file), the
      // fallback is also file://, and redirecting would create an infinite loop:
      //   file:// → restoreToSafeUrl → file:// → framenavigated → restoreToSafeUrl → …
      try {
        const safeObj = new URL(safeUrl);
        if (!ALLOWED_PROTOCOLS.has(safeObj.protocol)) return;
      } catch {
        return;
      }
      try {
        await page.goto(safeUrl, { waitUntil: 'domcontentloaded' });
      } catch {
        // page might be closing; ignore
      }
    };

    // Fires for every frame, not just the main frame. Subframes navigating to
    // dangerous schemes can still exfiltrate parent-context data via
    // postMessage or credential-attaching requests, so we react to them too.
    page.on('framenavigated', async frame => {
      const urlStr = frame.url();
      const isMainFrame = frame === page.mainFrame();

      let urlObj;
      try {
        urlObj = new URL(urlStr);
      } catch {
        if (isMainFrame) return restoreToSafeUrl(page, urlStr);
        return;
      }

      if (allowedProtocols.has(urlObj.protocol)) {
        if (isMainFrame) lastAllowedUrlByPage.set(page, urlObj.toString());
        return;
      }

      // Skip browser-internal transitional states (about:blank, about:srcdoc, etc.).
      // page.goto() navigates through about:blank before loading the target URL.
      // Redirecting from about: creates an infinite loop:
      //   restoreToSafeUrl → page.goto(safeUrl) → about:blank → restoreToSafeUrl → …
      if (urlObj.protocol === 'about:') return;

      if (isMainFrame) {
        await restoreToSafeUrl(page, urlStr);
        return;
      }

      // Subframe reached a disallowed scheme after route interception
      // (e.g. via document.write) — best-effort detach.
      try {
        await frame.evaluate(() => {
          const el = window.frameElement as HTMLIFrameElement | null;
          if (el) el.src = 'about:blank';
        });
      } catch {
        // frame may already be detached
      }
    });
  };

  // Guard existing and future pages
  for (const page of context.pages()) attachGuardsToPage(page);
  context.on('page', attachGuardsToPage);
}

export default addUrlGuardScript;
