import { chromium } from 'playwright';

const base = process.env.BASE ?? 'http://localhost:4173/';
const ldp = '/tmp/deps/root/usr/lib/aarch64-linux-gnu:/tmp/deps/root/lib/aarch64-linux-gnu';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  env: { ...process.env, LD_LIBRARY_PATH: `${ldp}:${process.env.LD_LIBRARY_PATH ?? ''}` },
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__atlasStudio?.state?.atlas, null, { timeout: 30000 });
await page.waitForTimeout(900);

const report = await page.evaluate(() => {
  const s = window.__atlasStudio.state;
  const a = s.atlas;
  const gl = document.querySelector('#gl-canvas');
  return {
    tiles: a.tiles.length,
    pages: a.diagnostics.pageCount,
    safeLod: a.diagnostics.safeLod,
    bytes: a.diagnostics.totalBytes,
    rotated: a.tiles.filter((t) => t.rotated).map((t) => t.id),
    selected: s.selectedId,
    contamination: a.diagnostics.contamination.map((c) => ({ id: c.id, maxRgb: +c.maxRgb.toFixed(1), maxA: c.maxA, bad: c.contaminated })),
    glSize: [gl.width, gl.height],
    canvasCenter: (() => {
      const c = document.querySelector('#gl-canvas');
      return c.toDataURL().length;
    })(),
    tileCards: document.querySelectorAll('.tile-card').length,
    levels: document.querySelectorAll('.level-pill').length,
    metaRows: document.querySelectorAll('#tile-meta tr').length,
    splice: window.__atlasStudio.lastSpliceSignal(),
  };
});
console.log(JSON.stringify(report, null, 2));
console.log('ERRORS:', errors.length ? errors : 'none');

// screenshot baseline
await page.screenshot({ path: 'tests/artifacts/ui-baseline.png', fullPage: false });
await browser.close();
