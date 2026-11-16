#!/usr/bin/env node
// Headless build: reads assets/sources, writes dist/ atlas levels, per-level
// PNGs, manifest.json and diagnostics.json. This is the CLI form of exactly
// what the UI runs, using the same core module.
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { createImage, compositeOverChecker } from '../src/core/rgba.mjs';
import { buildAtlas, makeManifest, AtlasError } from '../src/core/atlas.mjs';

const root = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(root, 'assets', 'sources');
const OUT_DIR = path.join(root, 'dist');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(prefix)) return args[i].slice(prefix.length);
    if (args[i] === `--${name}`) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) return next;
    }
  }
  return fallback;
}
const flag = (name) => args.includes(`--${name}`);

const padding = Number(arg('padding', 16));
const pageLimit = Number(arg('page-limit', 1024));
const budgetMiB = Number(arg('budget-mib', 16));
const allowRotation = !flag('no-rotate');
const outDir = path.resolve(arg('out', OUT_DIR));

function listSources() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort()
    .map((f) => {
      const png = PNG.sync.read(readFileSync(path.join(SRC_DIR, f)));
      return {
        id: f.replace(/\.png$/i, ''),
        name: f,
        image: createImage(png.width, png.height, new Uint8ClampedArray(png.data)),
      };
    });
}

function writePng(file, image) {
  const png = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

function writeCheckerPng(file, image, cell = 16) {
  const out = createImage(image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const rgb = compositeOverChecker(image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3], x, y, cell);
      out.data[i] = rgb[0];
      out.data[i + 1] = rgb[1];
      out.data[i + 2] = rgb[2];
      out.data[i + 3] = 255;
    }
  }
  writePng(file, out);
}

const items = listSources();
if (items.length === 0) {
  console.error('dist 构建失败：assets/sources 中没有 PNG。请先运行 npm run assets。');
  process.exit(2);
}

try {
  const atlas = buildAtlas(items, {
    padding,
    pageLimit,
    budgetBytes: Math.round(budgetMiB * 1048576),
    allowRotation,
  });

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const srcOut = path.join(outDir, 'sources');
  fs.mkdirSync(srcOut, { recursive: true });
  for (const item of items) writePng(path.join(srcOut, `${item.id}.png`), item.image);

  const manifest = makeManifest(atlas, (pageIndex, level) => `atlas_p${pageIndex}_l${level}.png`);
  for (const page of atlas.guarded.pages) {
    for (const level of page.levels) {
      writePng(path.join(outDir, `atlas_p${page.index}_l${level.level}.png`), level.image);
      if (level.level === 0) {
        writeCheckerPng(path.join(outDir, `atlas_p${page.index}_l${level.level}_checker.png`), level.image);
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    budget: { requiredBytes: atlas.diagnostics.totalBytes, limitBytes: atlas.diagnostics.budgetBytes },
    pages: atlas.guarded.pages.map((p) => ({
      index: p.index,
      size: p.width,
      levels: p.levels.map((l) => ({ level: l.level, width: l.width, height: l.height })),
    })),
    tiles: atlas.tiles.map((t) => ({
      id: t.id,
      page: t.pageIndex,
      rotationDeg: t.rotationDeg,
      atlasCore: t.atlasCore,
      uv: t.uv,
      safeLod: t.levels.filter((l) => l.x !== null).length - 1,
    })),
    contamination: {
      level: atlas.diagnostics.contaminationLevel,
      tiles: atlas.diagnostics.contamination.map((c) => ({
        id: c.id,
        maxRgb: Number(c.maxRgb.toFixed(2)),
        maxAlpha: c.maxA,
        meanRgb: Number(c.meanRgb.toFixed(3)),
        contaminatedProbes: c.contaminated,
        probes: c.total,
      })),
    },
    warnings: atlas.diagnostics.warnings,
  };
  fs.writeFileSync(path.join(outDir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));

  console.log(`atlas OK -> ${path.relative(root, outDir)}`);
  console.log(`  pages: ${atlas.guarded.pages.length} x ${atlas.guarded.pages[0].width}px`);
  console.log(`  levels: ${atlas.guarded.pages[0].levels.length} (safeLod ${atlas.diagnostics.safeLod})`);
  console.log(`  bytes: ${(atlas.diagnostics.totalBytes / 1048576).toFixed(2)} MiB / ${budgetMiB} MiB`);
  for (const warning of atlas.diagnostics.warnings) console.log(`  ! ${warning.code}: ${warning.message}`);
  for (const c of diagnostics.contamination.tiles) {
    console.log(`  naive-bleed ${c.id}: maxRGB ${c.maxRgb}, maxAlpha ${c.maxAlpha}, probes ${c.contaminatedProbes}/${c.probes}`);
  }
} catch (err) {
  if (err instanceof AtlasError) {
    console.error(`atlas FAILED [${err.code}]: ${err.message}`);
    if (err.details && Object.keys(err.details).length) {
      console.error(`  details: ${JSON.stringify(err.details)}`);
    }
    process.exit(1);
  }
  throw err;
}
