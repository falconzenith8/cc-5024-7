#!/usr/bin/env node
// Builds the committed exhibit-atlas demo pack from the case probe textures.
//
// Outputs (all real files under packs/demo-pack/):
//   sources/            regenerated source PNGs + provenance (recipe + palette)
//   atlas/              per-page per-level guarded PNGs, naive L0..L2, manifest
//   scenes/             near/far wall renders for guarded and naive chains
//   mip-edges/          per-tile edge strips across mip levels
//   pack-params.json    the exact parameters used (no build-time defaults)
//   evidence.json       mip edge colours + sampled colours with pass/fail rules
//   README.md
//
// Every number in evidence.json comes from generated pixels through the same
// core sampler the WebGL studio uses. There are no baked constants.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { createImage } from '../src/core/rgba.mjs';
import {
  buildAtlas, makeManifest,
} from '../src/core/atlas.mjs';
import { buildCaseImages } from './generate-cases.mjs';
import {
  writePng, checkerComposite, upscale, hStrip, renderLevelView, crop, sampleAt,
} from './lib/render.mjs';
import { sampledColorEvidence } from './lib/evidence.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PACK_DIR = path.join(root, 'packs', 'demo-pack');

// Fixed build contract. Rebuild scripts read this back instead of inventing
// defaults, so a missing or mutated parameter fails loudly.
export const PACK_PARAMS = Object.freeze({
  packId: 'demo-pack',
  packVersion: 1,
  generator: 'scripts/build-demo-pack.mjs',
  sourceGenerator: 'scripts/generate-cases.mjs',
  padding: 12,
  pageLimit: 1024,
  budgetMiB: 16,
  budgetBytes: 16 * 1024 * 1024,
  allowRotation: true,
  mode: 'guarded',
  minPage: 128,
  maxLevel: 10,
  contaminationThreshold: 8,
  farLevels: [0, 2],
  scene: {
    nearCanvas: [768, 768],
    farCanvas: [256, 256],
    checkerCell: 10,
    description: '近景渲染 L0 全尺寸墙；远景渲染 L2 缩小墙，用于肉眼判断串色',
  },
});

function rmk(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Image(image) {
  return createHash('sha256').update(Buffer.from(image.data)).digest('hex');
}

function loadCommittedCasePngs() {
  const dir = path.join(root, 'assets', 'cases');
  return buildCaseImages().map((item) => {
    const file = path.join(dir, item.file);
    const png = PNG.sync.read(fs.readFileSync(file));
    return {
      id: item.id,
      name: item.file,
      probe: item.probe,
      image: createImage(png.width, png.height, new Uint8ClampedArray(png.data)),
    };
  });
}

// --- mip edge evidence -----------------------------------------------------
// For every tile, at every level that still exists, sample just OUTSIDE the
// core edge (the guarded bleed ring) and just inside it. The guarded ring must
// carry the tile's own border colour; the naive chain at the same source
// position can carry a neighbour's colour, which is the contamination this
// pack exists to demonstrate.
function edgeEvidence(atlas) {
  const threshold = PACK_PARAMS.contaminationThreshold;
  const tiles = [];
  for (const tile of atlas.tiles) {
    const gPage = atlas.guarded.pages[tile.pageIndex];
    const nPage = atlas.naive.pages[0];
    const perLevel = [];
    const maxLevel = Math.min(
      tile.levels.filter((l) => l.x !== null).length - 1,
      nPage.levels.length - 1,
    );
    for (let level = 0; level <= maxLevel; level++) {
      const gLv = gPage.levels[level];
      const nLv = nPage.levels[level];
      const gRect = gLv.rects.find((r) => r.id === tile.id);
      const nRect = nLv.rects.find((r) => r.id === tile.id);
      if (!gRect || !nRect) continue;
      const samples = [];
      // Three points on the left edge at 25/50/75% height; outside = one
      // level-texel beyond the core, inside = one texel within.
      for (const fy of [0.25, 0.5, 0.75]) {
        const gy = Math.round(gRect.y + gRect.h * fy);
        const gOutside = sampleAt(gLv.image, gRect.x - 1, gy);
        const gInside = sampleAt(gLv.image, gRect.x, gy);
        const ny = Math.round(nRect.y + nRect.h * fy);
        const nOutside = sampleAt(nLv.image, nRect.x - 1, ny);
        const nInside = sampleAt(nLv.image, nRect.x, ny);
        const premul = (c) => [c[0] * (c[3] / 255), c[1] * (c[3] / 255), c[2] * (c[3] / 255), c[3]];
        const gp = premul(gOutside);
        const np = premul(nOutside);
        const delta = Math.max(
          Math.abs(gp[0] - np[0]), Math.abs(gp[1] - np[1]),
          Math.abs(gp[2] - np[2]), Math.abs(gp[3] - np[3]),
        );
        samples.push({
          edge: 'left',
          fy: Number(fy.toFixed(2)),
          level,
          guardedOutside: gOutside,
          guardedInside: gInside,
          naiveOutside: nOutside,
          naiveInside: nInside,
          outsideDelta: Number(delta.toFixed(2)),
          naiveContaminated: delta > threshold,
        });
      }
      perLevel.push({ level, samples });
    }
    const worst = Math.max(0, ...perLevel.flatMap((l) => l.samples.map((s) => s.outsideDelta)));
    const contaminatedProbes = perLevel
      .flatMap((l) => l.samples)
      .filter((s) => s.naiveContaminated).length;
    tiles.push({
      id: tile.id,
      probe: tile.name,
      safeLod: tile.levels.filter((l) => l.x !== null).length - 1,
      worstOutsideDelta: Number(worst.toFixed(2)),
      contaminatedProbes,
      totalProbes: perLevel.reduce((s, l) => s + l.samples.length, 0),
      levels: perLevel,
    });
  }
  return tiles;
}

// Sampled-colour evidence lives in scripts/lib/evidence.mjs so the rebuild
// verifier runs the identical math.

function build() {
  rmk(PACK_DIR);
  const srcOut = path.join(PACK_DIR, 'sources');
  const atlasOut = path.join(PACK_DIR, 'atlas');
  const sceneOut = path.join(PACK_DIR, 'scenes');
  const edgeOut = path.join(PACK_DIR, 'mip-edges');
  fs.mkdirSync(srcOut, { recursive: true });
  fs.mkdirSync(atlasOut, { recursive: true });
  fs.mkdirSync(sceneOut, { recursive: true });
  fs.mkdirSync(edgeOut, { recursive: true });

  // 1) Regenerate sources in-memory and verify they match the committed PNGs
  // pixel-for-pixel (PNG byte hashes are compression-dependent, so the guard
  // compares decoded RGBA, not file bytes).
  const generated = buildCaseImages();
  const committed = loadCommittedCasePngs();
  const sourceChecks = [];
  for (const gen of generated) {
    const com = committed.find((c) => c.id === gen.id);
    const same = Buffer.from(gen.image.data).equals(Buffer.from(com.image.data))
      && gen.width === com.image.width && gen.height === com.image.height;
    if (!same) {
      throw new Error(`来源素材不一致：${gen.id}（生成器与 assets/cases 下的 PNG 不匹配，请先运行 npm run cases）`);
    }
    const target = path.join(srcOut, gen.file);
    const normalized = createImage(gen.width, gen.height, new Uint8ClampedArray(gen.image.data));
    writePng(target, normalized);
    sourceChecks.push({
      id: gen.id, file: gen.file, width: gen.width, height: gen.height,
      sha256: sha256File(target), probe: gen.probe,
    });
  }
  fs.copyFileSync(
    path.join(root, 'assets', 'cases', 'sources.json'),
    path.join(srcOut, 'sources.json'),
  );

  // 2) Build the atlas strictly from the saved parameters.
  const items = committed;
  const atlas = buildAtlas(items, {
    padding: PACK_PARAMS.padding,
    pageLimit: PACK_PARAMS.pageLimit,
    budgetBytes: PACK_PARAMS.budgetBytes,
    allowRotation: PACK_PARAMS.allowRotation,
    mode: PACK_PARAMS.mode,
    minPage: PACK_PARAMS.minPage,
    maxLevel: PACK_PARAMS.maxLevel,
  });

  // 3) Guarded per-level PNGs + manifest.
  const manifest = makeManifest(atlas, (p, l) => `guarded_p${p}_l${l}.png`);
  const levelFiles = [];
  for (const page of atlas.guarded.pages) {
    for (const level of page.levels) {
      const name = `guarded_p${page.index}_l${level.level}.png`;
      writePng(path.join(atlasOut, name), level.image);
      levelFiles.push({ name, page: page.index, level: level.level, width: level.width, height: level.height, sha256: sha256File(path.join(atlasOut, name)) });
      if (level.level === 0) {
        writePng(path.join(atlasOut, `guarded_p${page.index}_l0_checker.png`), checkerComposite(level.image, 16));
      }
    }
  }
  // Naive comparison chain (diagnostic only), L0..L2.
  const naiveFiles = [];
  const naivePage = atlas.naive.pages[0];
  for (const level of naivePage.levels.slice(0, 3)) {
    const name = `naive_p0_l${level.level}.png`;
    writePng(path.join(atlasOut, name), level.image);
    naiveFiles.push({ name, level: level.level, width: level.width, height: level.height, sha256: sha256File(path.join(atlasOut, name)) });
  }
  fs.writeFileSync(path.join(atlasOut, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // 4) Near / far wall renders through the bilinear sampler.
  const [nearW, nearH] = PACK_PARAMS.scene.nearCanvas;
  const [farW, farH] = PACK_PARAMS.scene.farCanvas;
  const guardedL0 = atlas.guarded.pages[0].levels[0];
  const guardedL2 = atlas.guarded.pages[0].levels[2] ?? atlas.guarded.pages[0].levels.at(-1);
  const naiveL0 = naivePage.levels[0];
  const naiveL2 = naivePage.levels[2] ?? naivePage.levels.at(-1);
  const scenes = [
    ['near-guarded.png', renderLevelView(guardedL0.image, nearW, nearH)],
    ['near-naive.png', renderLevelView(naiveL0.image, nearW, nearH)],
    ['far-guarded-l2.png', renderLevelView(guardedL2.image, farW, farH)],
    ['far-naive-l2.png', renderLevelView(naiveL2.image, farW, farH)],
  ];
  for (const [name, img] of scenes) writePng(path.join(sceneOut, name), img);

  // 5) Per-tile mip edge strips: the tile core + its ring at L0/L1/L2, for
  // both chains, upscaled so individual texels are inspectable.
  const edgeIndex = [];
  for (const tile of atlas.tiles) {
    const strips = [];
    const gPage = atlas.guarded.pages[tile.pageIndex];
    for (const level of [0, 1, 2]) {
      const gLv = gPage.levels[level];
      const nLv = naivePage.levels[level];
      const gRect = gLv?.rects.find((r) => r.id === tile.id);
      const nRect = nLv?.rects.find((r) => r.id === tile.id);
      if (!gRect || !nRect) continue;
      const pad = gLv.pad ?? Math.max(1, gPage.pad >> level);
      const gCrop = crop(gLv.image, Math.max(0, gRect.x - pad), Math.max(0, gRect.y - pad),
        Math.min(gLv.width - Math.max(0, gRect.x - pad), gRect.w + pad * 2),
        Math.min(gLv.height - Math.max(0, gRect.y - pad), gRect.h + pad * 2));
      const nCrop = crop(nLv.image, Math.max(0, nRect.x - pad), Math.max(0, nRect.y - pad),
        Math.min(nLv.width - Math.max(0, nRect.x - pad), nRect.w + pad * 2),
        Math.min(nLv.height - Math.max(0, nRect.y - pad), nRect.h + pad * 2));
      const factor = level === 0 ? 2 : 6;
      strips.push(upscale(checkerComposite(gCrop, 4), factor));
      strips.push(upscale(checkerComposite(nCrop, 4), factor));
    }
    if (!strips.length) continue;
    const strip = hStrip(strips, 6);
    const name = `${tile.id}-edges.png`;
    writePng(path.join(edgeOut, name), strip);
    edgeIndex.push({ tile: tile.id, file: `mip-edges/${name}`, width: strip.width, height: strip.height });
  }

  // 6) Evidence from generated pixels.
  const edges = edgeEvidence(atlas);
  const sourcesById = new Map(items.map((it) => [it.id, it.image]));
  const sampled = sampledColorEvidence(atlas, sourcesById);
  const contamination = atlas.diagnostics.contamination;
  const evidence = {
    packId: PACK_PARAMS.packId,
    generatedAt: new Date().toISOString(),
    threshold: PACK_PARAMS.contaminationThreshold,
    contaminationLevel: atlas.diagnostics.contaminationLevel,
    safeLod: atlas.diagnostics.safeLod,
    summary: {
      tiles: atlas.tiles.length,
      guardedPages: atlas.guarded.pages.length,
      guardedLevels: atlas.guarded.pages[0].levels.length,
      tilesWithNaiveContamination: edges.filter((e) => e.contaminatedProbes > 0).length,
      totalContaminatedEdgeProbes: edges.reduce((s, e) => s + e.contaminatedProbes, 0),
      failedSampledColorProbes: sampled.reduce(
        (s, t) => s + t.probes.filter((p) => !p.pass).length, 0,
      ),
      interiorOpaqueProbes: sampled.reduce(
        (s, t) => s + t.probes.filter((p) => p.interiorOpaque).length, 0,
      ),
    },
    mipEdges: edges,
    sampledColors: sampled,
    contamination: contamination.map((c) => ({
      id: c.id,
      maxRgb: Number(c.maxRgb.toFixed(2)),
      maxAlpha: c.maxA,
      meanRgb: Number(c.meanRgb.toFixed(3)),
      contaminatedProbes: c.contaminated,
      total: c.total,
    })),
  };
  fs.writeFileSync(path.join(PACK_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  // 7) Saved parameters, explicit and complete.
  const paramsFile = {
    ...PACK_PARAMS,
    sha256: crypto.createHash('sha256').update(JSON.stringify(PACK_PARAMS)).digest('hex'),
    sources: sourceChecks,
  };
  fs.writeFileSync(path.join(PACK_DIR, 'pack-params.json'), `${JSON.stringify(paramsFile, null, 2)}\n`);

  // 8) Pack README.
  fs.writeFileSync(path.join(PACK_DIR, 'README.md'), `${readme(atlas, evidence)}\n`);

  console.log(`demo pack -> ${path.relative(root, PACK_DIR)}`);
  console.log(`  tiles ${atlas.tiles.length} · page ${atlas.guarded.pages[0].width}px · levels L0..L${atlas.diagnostics.safeLod}`);
  console.log(`  naive edge contamination on ${evidence.summary.tilesWithNaiveContamination}/${atlas.tiles.length} tiles`);
  console.log(`  guarded failed sampled-colour probes: ${evidence.summary.failedSampledColorProbes}`);
  return { atlas, evidence, params: paramsFile };
}

function readme(atlas, evidence) {
  return [
    '# 展品图集示范素材包 demo-pack',
    '',
    '本目录由 `npm run pack` 整体生成，可直接在展品纹理图集工作室（图形入口 `index.html`）',
    '通过「载入示范素材包」按钮加载，也可用 `npm run rebuild-pack` 离线重建并核验。',
    '',
    '## 目录',
    '- `sources/`：自制展品来源 PNG 与 `sources.json`（配方、调色板、每个素材的检验目标）',
    '- `atlas/`：守护式逐级贴图 `guarded_p0_l*.png`、反例 `naive_p0_l*.png`、`manifest.json`',
    '- `scenes/`：近景 L0 与远景 L2 墙渲染（守护链与整页滤波反例各一张）',
    '- `mip-edges/`：每个图块 L0/L1/L2 核心+扩色环的放大条带，左守护右反例',
    '- `pack-params.json`：打包参数（padding/页上限/预算/旋转/场景），重建时逐字读回',
    '- `evidence.json`：mip 边缘与采样颜色的逐探针 RGBA 数值及判定',
    '',
    '## 打包参数',
    `- padding: ${PACK_PARAMS.padding}px`,
    `- pageLimit: ${PACK_PARAMS.pageLimit}px`,
    `- budget: ${PACK_PARAMS.budgetMiB} MiB`,
    `- allowRotation: ${PACK_PARAMS.allowRotation}`,
    `- safeLod: L${atlas.diagnostics.safeLod}`,
    '',
    '## 判定约定（阈值见 evidence.json）',
    `- 守护链内部不透明探针必须与图块自身补丁重采样结果一致（RGB Δ ≤ 2）`,
    `- 整页滤波反例在边缘探针上的预乘色差 > ${PACK_PARAMS.contaminationThreshold} 即标记为采样污染`,
    `- 本包实测：污染边缘探针 ${evidence.summary.totalContaminatedEdgeProbes} 个，守护链失败探针 ${evidence.summary.failedSampledColorProbes} 个`,
    '',
    '图形入口见仓库根目录 `docs/usage.md`；命令行仅用于辅助重建与核验。',
  ].join('\n');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invoked) build();
