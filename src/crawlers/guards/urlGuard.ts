const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function addUrlGuardScript(context, opts = {}) {
  const { fallbackUrl }: any = opts;

  const lastAllowedUrlByPage = new WeakMap();

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
      try {
        const safeUrl = lastAllowedUrlByPage.get(page) || fallbackUrl || 'about:blank';
        await page.goto(safeUrl, { waitUntil: 'domcontentloaded' });
      } catch {
        // page might be closing; ignore
      }
    };

    page.on('framenavigated', async frame => {
      if (frame !== page.mainFrame()) return;

      const urlStr = frame.url();
      let urlObj;
      try {
        urlObj = new URL(urlStr);
      } catch {
        return restoreToSafeUrl(page, urlStr);
      }

      if (ALLOWED_PROTOCOLS.has(urlObj.protocol)) {
        lastAllowedUrlByPage.set(page, urlObj.toString());
        return;
      }
      await restoreToSafeUrl(page, urlStr);
    });
  };

  // Guard existing and future pages
  for (const page of context.pages()) attachGuardsToPage(page);
  context.on('page', attachGuardsToPage);
}

export default addUrlGuardScript;
