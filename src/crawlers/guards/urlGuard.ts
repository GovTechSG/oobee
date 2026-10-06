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

  // For file:// scan entries we permit navigation to exactly the entry URL (self-loops
  // during restoration), but block navigation to any other file:// URL — this prevents a
  // hostile local HTML file from redirecting the driven browser to e.g. file:///etc/passwd
  // and exfiltrating its contents from the same file:// origin.
  let entryFileUrl: string | undefined;
  try {
    if (fallbackUrl) {
      const fbObj = new URL(String(fallbackUrl));
      if (fbObj.protocol === 'file:') entryFileUrl = fbObj.href;
    }
  } catch {
    // fallbackUrl not parseable; entryFileUrl stays undefined
  }

  const attachGuardsToPage = page => {
    if (!lastAllowedUrlByPage.has(page) && fallbackUrl) {
      lastAllowedUrlByPage.set(page, String(fallbackUrl));
    }

    page
      .addInitScript(
        (config: { entryFileUrl?: string }) => {
          const entryFile = config && config.entryFileUrl;

          const isAllowedProtocol = (value: unknown) => {
            try {
              const s = value instanceof URL ? value.toString() : String(value);
              const resolved = new URL(s, window.location.href);
              if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return true;
              // Permit navigation only to the exact scan-entry file:// URL.
              if (entryFile && resolved.href === entryFile) return true;
              return false;
            } catch {
              return false;
            }
          };

          const win = window;

          // Wrap window.open (existing behaviour)
          const openOriginal = win.open;
          win.open = function (targetUrl, ...args) {
            if (targetUrl != null && !isAllowedProtocol(targetUrl)) return null;
            return openOriginal.call(this, targetUrl, ...args);
          };

          // Wrap Location.assign, Location.replace, and the Location.href setter
          // — these bypass Playwright's route() interception because location
          // assignments to non-http(s) schemes (javascript:, data:, file://)
          // generate no interceptable network request.
          try {
            const LocProto = Location.prototype as any;
            const origAssign = LocProto.assign;
            const origReplace = LocProto.replace;
            if (typeof origAssign === 'function') {
              LocProto.assign = function (u: unknown) {
                if (!isAllowedProtocol(u)) return undefined;
                return origAssign.call(this, u);
              };
            }
            if (typeof origReplace === 'function') {
              LocProto.replace = function (u: unknown) {
                if (!isAllowedProtocol(u)) return undefined;
                return origReplace.call(this, u);
              };
            }
            const hrefDesc = Object.getOwnPropertyDescriptor(LocProto, 'href');
            if (hrefDesc && typeof hrefDesc.set === 'function' && typeof hrefDesc.get === 'function') {
              const origSetter = hrefDesc.set;
              Object.defineProperty(LocProto, 'href', {
                configurable: true,
                enumerable: !!hrefDesc.enumerable,
                get: hrefDesc.get,
                set(u: unknown) {
                  if (!isAllowedProtocol(u)) return;
                  origSetter.call(this, u);
                },
              });
            }
          } catch {
            // Location wrapping is best-effort; fall through to other guards.
          }

          // Attempt to also intercept the assignment forms `window.location = x`,
          // `document.location = x`, and the bare global `location = x`. Per the
          // HTML spec, Window's and Document's `location` attribute is
          // [Unforgeable]: its own-property descriptor is non-configurable, so
          // `Object.defineProperty` on it will throw (or be a no-op) in
          // spec-compliant browsers, and assigning to it invokes the internal
          // Location-object-setter directly rather than the JS-visible
          // Location.prototype.href setter wrapped above. This means the
          // override below is best-effort only and is NOT expected to take
          // effect in modern browsers/Playwright — it is kept in case a given
          // engine does expose a configurable descriptor. The `framenavigated`
          // listener registered in attachGuardsToPage (see below) is the
          // authoritative guard for this sink: it fires once the navigation has
          // landed and restores the main frame (or resets the subframe) to a
          // safe URL. Do not remove or delay that listener on the assumption
          // this init-script layer covers `window.location=`/`document.location=`.
          const guardLocationProperty = (obj: unknown) => {
            try {
              const desc = Object.getOwnPropertyDescriptor(obj as object, 'location');
              if (!desc || !desc.configurable || typeof desc.get !== 'function') return;
              const origGet = desc.get;
              const origSet = desc.set;
              Object.defineProperty(obj as object, 'location', {
                configurable: true,
                enumerable: !!desc.enumerable,
                get: origGet,
                set(u: unknown) {
                  if (!isAllowedProtocol(u)) return;
                  if (typeof origSet === 'function') {
                    origSet.call(this, u);
                  } else {
                    // No native setter exposed on this engine; forward through
                    // the (already-guarded) Location.prototype.href setter.
                    (origGet.call(this) as any).href = u;
                  }
                },
              });
            } catch {
              // `location` is non-configurable on this engine; best-effort only,
              // the framenavigated listener remains the authoritative guard.
            }
          };
          guardLocationProperty(window);
          guardLocationProperty(document);

          // Block anchor clicks and form submits pointing at disallowed schemes.
          const onClick = (e: Event) => {
            let el: any = e.target;
            while (el && el !== document) {
              if (el.tagName === 'A' && el.href && !isAllowedProtocol(el.href)) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              el = el.parentNode;
            }
          };
          const onSubmit = (e: Event) => {
            const form: any = e.target;
            if (form && form.action && !isAllowedProtocol(form.action)) {
              e.preventDefault();
              e.stopPropagation();
            }
          };
          document.addEventListener('click', onClick, true);
          document.addEventListener('submit', onSubmit, true);

          // Neutralise <meta http-equiv="refresh" content="0;url=javascript:...">
          const stripBadRefresh = () => {
            try {
              const nodes = document.querySelectorAll('meta[http-equiv]');
              nodes.forEach((m: Element) => {
                const eq = (m.getAttribute('http-equiv') || '').toLowerCase();
                if (eq !== 'refresh') return;
                const content = m.getAttribute('content') || '';
                const match = /url\s*=\s*(.+)$/i.exec(content);
                if (match && !isAllowedProtocol(match[1].trim())) {
                  m.setAttribute('content', '');
                }
              });
            } catch {
              // best-effort
            }
          };
          if (document.readyState !== 'loading') {
            stripBadRefresh();
          } else {
            document.addEventListener('DOMContentLoaded', stripBadRefresh);
          }
          try {
            const obs = new MutationObserver(stripBadRefresh);
            obs.observe(document.documentElement || document, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['content', 'http-equiv'],
            });
          } catch {
            // MutationObserver not available; skip
          }
        },
        { entryFileUrl },
      )
      .catch(() => {
        // page may have closed before addInitScript completed; safe to ignore
      });

    const restoreToSafeUrl = async (page, attemptedUrl) => {
      const rawSafe = lastAllowedUrlByPage.get(page) || fallbackUrl || 'about:blank';
      let restoreTo = String(rawSafe);
      try {
        const safeObj = new URL(restoreTo);
        // Restore to http(s) URLs directly. For file:// entries, restore to the specific
        // scan-entry file URL (per-URL sandboxing — no directory traversal). Anything
        // else falls back to about:blank so we do not leave the browser on an
        // attacker-directed non-http(s) page.
        if (!ALLOWED_PROTOCOLS.has(safeObj.protocol)) {
          if (safeObj.protocol === 'file:' && entryFileUrl && safeObj.href === entryFileUrl) {
            restoreTo = entryFileUrl;
          } else {
            restoreTo = 'about:blank';
          }
        }
      } catch {
        restoreTo = 'about:blank';
      }
      // Avoid navigation storms when the current URL already matches the restore target.
      if (attemptedUrl === restoreTo) return;
      try {
        await page.goto(restoreTo, { waitUntil: 'domcontentloaded' });
      } catch {
        // page might be closing; ignore
      }
    };

    // Fires for every frame, not just the main frame. Subframes navigating to
    // dangerous schemes can still exfiltrate parent-context data via
    // postMessage or credential-attaching requests, so we react to them too.
    //
    // This listener is also the *authoritative* (not merely secondary) guard
    // against `window.location = x` / `document.location = x` / bare
    // `location = x` assignments: those invoke the [Unforgeable] Window/Document
    // `location` accessor's internal setter directly, which cannot be wrapped
    // from page script (see guardLocationProperty above), so the init-script
    // allow-list layer cannot reliably prevent that sink. Do not remove, delay,
    // or gate this listener behind the init-script layer succeeding.
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

      // Permit navigation to the exact scan-entry file:// URL when the scan was
      // started against a local file. Any *other* file:// URL is still treated as
      // disallowed and will trigger restoration.
      if (entryFileUrl && urlObj.href === entryFileUrl) return;

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
