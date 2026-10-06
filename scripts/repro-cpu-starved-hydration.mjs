// Reproduces load-dependent axe results caused by CPU starvation (e.g. two
// concurrent scans on a 2 vCPU container) by throttling the renderer via CDP
// Emulation.setCPUThrottlingRate, then checks whether waitForPageLoaded
// released before or after the page hydrated.
//
// Usage: npm run build && node scripts/repro-cpu-starved-hydration.mjs
//   RATES=1,4,8,12  CPU slowdown factors to test (default 1,4,8)
//   RUNS=3          runs per rate
//   ITER=2000000    work per hydration chunk (20 chunks)
import { chromium } from 'playwright';
import { waitForPageLoaded } from '../dist/constants/common.js';

// SSR markup + deferred hydration. After `load` the "framework" runs 20 chunks
// of FIXED work (iteration count, not wall-clock, so CDP CPU throttling makes
// it proportionally slower — just like a starved renderer), yielding between
// chunks with no DOM mutations, then hydrates the tablist.
const ITER = Number(process.env.ITER || 2_000_000);
const html = `<html><body><div id=app><div class=tabs>Tab A Tab B</div></div><script>
  addEventListener('load', () => {
    const t0 = performance.now(); let n = 0;
    (function chunk() {
      let x = 0; for (let k = 0; k < ${ITER}; k++) x += Math.sqrt(x + k);
      window.__sink = x;
      if (++n < 20) return setTimeout(chunk, 0);
      window.__hydMs = performance.now() - t0;
      document.getElementById('app').innerHTML =
        '<div role="tablist"><button role="tab">A</button><button role="tab">B</button></div>';
    })();
  });</script></body></html>`;

const rates = (process.env.RATES || '1,4,8').split(',').map(Number);
const runs = Number(process.env.RUNS || 3);
const browser = await chromium.launch({ headless: true });
for (const rate of rates) {
  let hydrated = 0;
  const waits = [];
  for (let i = 0; i < runs; i++) {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.setContent(html, { waitUntil: 'commit' });
    const t = Date.now();
    await waitForPageLoaded(page);
    const ok = (await page.locator('[role=tab]').count()) > 0;
    if (ok) hydrated++;
    waits.push(`${Date.now() - t}${ok ? '' : '(MISS)'}`);
    await page.close();
  }
  console.log(`rate ${rate}x: hydrated-at-scan ${hydrated}/${runs}  waitForPageLoaded ms ${waits.join(',')}`);
}
// Calibration: how long hydration actually takes at each rate (no oobee wait).
for (const rate of rates) {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__hydMs !== undefined, null, { timeout: 120000 });
  console.log(`calib rate ${rate}x: hydration completes ${Math.round(await page.evaluate(() => window.__hydMs))}ms after load`);
  await page.close();
}
await browser.close();
