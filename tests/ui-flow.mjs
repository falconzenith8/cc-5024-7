import { chromium } from 'playwright';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ldp = '/tmp/deps/root/usr/lib/aarch64-linux-gnu:/tmp/deps/root/lib/aarch64-linux-gnu';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  env: { ...process.env, LD_LIBRARY_PATH: ldp },
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(`console: ${m.text()}`); });

const outDir = path.resolve('tests/artifacts');
mkdirSync(outDir, { recursive: true });

await page.goto(process.env.BASE ?? 'http://localhost:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__atlasStudio?.state?.atlas, null, { timeout: 30000 });
await page.waitForTimeout(700);

const baseline = await page.evaluate(() => ({
  tiles: window.__atlasStudio.state.atlas.tiles.length,
  pages: window.__atlasStudio.state.atlas.diagnostics.pageCount,
  safeLod: window.__atlasStudio.state.atlas.diagnostics.safeLod,
  bytes: window.__atlasStudio.state.atlas.diagnostics.totalBytes,
  rotated: window.__atlasStudio.state.atlas.tiles.filter((t) => t.rotated).map((t) => t.id),
  splice: window.__atlasStudio.lastSpliceSignal(),
}));
console.log('BASELINE', JSON.stringify(baseline));

// 1) LOD buttons update renderer state
await page.click('[data-lod="3"]');
const lodState = await page.evaluate(() => window.__atlasStudio.state.lodManual);
console.log('LOD manual =', lodState);
await page.screenshot({ path: 'tests/artifacts/ui-lod3.png' });

// 2) Mode buttons
await page.click('#lod-auto');
await page.click('[data-mode="1"]');
const mode = await page.evaluate(() => window.__atlasStudio.state.viewMode);
console.log('mode =', mode);
await page.screenshot({ path: 'tests/artifacts/ui-naive.png' });
await page.click('[data-mode="2"]');
await page.screenshot({ path: 'tests/artifacts/ui-diff.png' });
await page.click('[data-mode="0"]');

// 3) Alpha view
await page.check('#opt-alpha');
await page.screenshot({ path: 'tests/artifacts/ui-alpha.png' });
await page.uncheck('#opt-alpha');

// 4) select a rotated tile and verify preview + meta
await page.evaluate(() => window.__atlasStudio.select('plate'));
await page.waitForTimeout(350);
const rotatedMeta = await page.evaluate(() => ({
  meta: [...document.querySelectorAll('#tile-meta tr')].map((tr) => tr.innerText.replace(/\n/g, ' ')),
  caption: document.querySelector('#preview-caption').textContent,
  splice: window.__atlasStudio.lastSpliceSignal(),
}));
console.log('ROTATED', JSON.stringify(rotatedMeta));
await page.screenshot({ path: 'tests/artifacts/ui-rotated.png' });

// 5) preview level slider
await page.fill('#preview-level', '3');
await page.dispatchEvent('#preview-level', 'input');
const previewLevel = await page.evaluate(() => document.querySelector('#preview-caption').textContent);
console.log('PREVIEW', previewLevel);

// 6) budget failure shows dialog, does not silently shrink
await page.selectOption('#opt-budget', '4');
await page.waitForTimeout(300);
await page.waitForTimeout(800);
const dialogOpen = await page.evaluate(() => document.querySelector('#error-dialog')?.open);
const stillTiles = await page.evaluate(() => window.__atlasStudio.state.atlas.tiles.map((t) => [t.id, t.atlasCore.w, t.atlasCore.h]));
console.log('budget dialog open =', dialogOpen, 'tiles intact =', JSON.stringify(stillTiles));

// 7) split demo: 640 page limit forces a real split without resizing any tile
await page.evaluate(() => { const d = document.querySelector('#error-dialog'); if (d?.open) d.close(); });
await page.selectOption('#opt-budget', '32');
await page.selectOption('#opt-pagelimit', '640');
await page.waitForTimeout(900);
const split = await page.evaluate(() => ({
  pages: window.__atlasStudio.state.atlas.diagnostics.pageCount,
  split: window.__atlasStudio.state.atlas.diagnostics.split,
  sizes: window.__atlasStudio.state.atlas.tiles.map((t) => [t.id, t.atlasCore.w, t.atlasCore.h]),
  warnings: window.__atlasStudio.state.atlas.diagnostics.warnings,
  pageTabs: document.querySelectorAll('.page-tab').length,
}));
console.log('SPLIT', JSON.stringify(split));
await page.screenshot({ path: 'tests/artifacts/ui-split.png' });

// 8) download manifest and the texture bundle; verify zip contents
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.click('#btn-export'),
]);
const zipPath = path.join(outDir, 'export.zip');
await dl.saveAs(zipPath);
console.log('DOWNLOAD', dl.suggestedFilename());

// 9) reset to standard and screenshot final
await page.selectOption('#opt-pagelimit', '1024');
await page.selectOption('#opt-budget', '16');
await page.waitForTimeout(900);
await page.screenshot({ path: 'tests/artifacts/ui-final.png' });

console.log('ERRORS', errors.length ? errors : 'none');
await browser.close();

const zipList = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
console.log(zipList);
const tmp = '/tmp/atlas-zip-extract';
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
execFileSync('unzip', ['-q', zipPath, '-d', tmp]);
const manifest = JSON.parse(readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
console.log('MANIFEST', JSON.stringify({
  format: manifest.format,
  pages: manifest.pages.length,
  levels: manifest.pages[0].levels.length,
  tiles: manifest.tiles.length,
  sampler: manifest.sampler,
  firstTile: manifest.tiles[0],
}, null, 2));
const level0 = readFileSync(path.join(tmp, 'atlas_p0_l0.png'));
console.log('PNG signature ok:', level0.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'bytes', level0.length);
