#!/usr/bin/env node
// Offline rebuild + verification of the committed demo pack.
//
// It never invents parameters: every build argument is read back from the
// pack's own pack-params.json, and a missing/short file or any numeric
// disagreement with evidence.json fails the process with a non-zero exit.
// This is the script CI and reviewers run to prove the committed pack is the
// real output of the saved generator + parameters, not placeholder defaults.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { createImage } from '../src/core/rgba.mjs';
import { buildAtlas, makeManifest, analyzeContamination } from '../src/core/atlas.mjs';
import { buildCaseImages } from './generate-cases.mjs';
import { PACK_PARAMS } from './build-demo-pack.mjs';
import { tileOwnPatch, evaluateProbe, PROBE_POINTS } from './lib/evidence.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PACK_DIR = path.join(root, 'packs', 'demo-pack');
const failures = [];

function fail(msg) {
  failures.push(msg);
  console.error(`  ✗ ${msg}`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function requireFile(rel) {
  const full = path.join(PACK_DIR, rel);
  if (!fs.existsSync(full)) {
    fail(`缺少文件 ${rel}`);
    return null;
  }
  return full;
}

console.log('1) 读回保存的打包参数（不使用任何默认值）');
const paramsFile = requireFile('pack-params.json');
if (!paramsFile) process.exit(1);
const saved = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
const expectedParams = ['padding', 'pageLimit', 'budgetBytes', 'allowRotation', 'mode', 'minPage', 'maxLevel', 'contaminationThreshold'];
for (const key of expectedParams) {
  if (saved[key] !== PACK_PARAMS[key]) {
    fail(`参数 ${key} 被篡改：包内 ${JSON.stringify(saved[key])}，生成器约定 ${JSON.stringify(PACK_PARAMS[key])}`);
  }
}
if (saved.sources?.length !== buildCaseImages().length) fail('来源清单数量与生成器配方不一致');
else ok(`${expectedParams.length} 个打包参数与生成器约定一致，来源 ${saved.sources.length} 个`);

console.log('2) 重建来源并与包内 PNG 逐像素比对');
const generated = buildCaseImages();
const items = [];
for (const gen of generated) {
  const srcPath = requireFile(path.join('sources', gen.file));
  if (!srcPath) continue;
  const png = PNG.sync.read(fs.readFileSync(srcPath));
  const decoded = createImage(png.width, png.height, new Uint8ClampedArray(png.data));
  if (decoded.width !== gen.width || decoded.height !== gen.height ||
      !Buffer.from(decoded.data).equals(Buffer.from(gen.image.data))) {
    fail(`来源 ${gen.file} 与生成器输出像素不一致`);
  }
  const recorded = saved.sources.find((s) => s.id === gen.id);
  if (!recorded || recorded.sha256 !== sha256(srcPath)) fail(`${gen.file} 的 sha256 与 pack-params.json 记录不符`);
  items.push({ id: gen.id, name: gen.file, image: decoded });
}
if (!failures.length) ok(`全部 ${items.length} 个来源像素与哈希一致`);

console.log('3) 用保存参数重建图集并核对 manifest 与逐级贴图哈希');
const atlas = buildAtlas(items, {
  padding: saved.padding,
  pageLimit: saved.pageLimit,
  budgetBytes: saved.budgetBytes,
  allowRotation: saved.allowRotation,
  mode: saved.mode,
  minPage: saved.minPage,
  maxLevel: saved.maxLevel,
});
const manifest = JSON.parse(fs.readFileSync(requireFile('atlas/manifest.json'), 'utf8'));
const rebuiltManifest = makeManifest(atlas, (p, l) => `guarded_p${p}_l${l}.png`);
if (manifest.format !== rebuiltManifest.format || manifest.version !== rebuiltManifest.version) fail('manifest 格式/版本不一致');
if (manifest.tiles.length !== rebuiltManifest.tiles.length) fail('manifest 图块数量不一致');
if (manifest.sampler.maxLevel !== atlas.diagnostics.safeLod) fail('manifest sampler.maxLevel 与 safeLod 不符');
for (const page of atlas.guarded.pages) {
  for (const level of page.levels) {
    const rel = `atlas/guarded_p${page.index}_l${level.level}.png`;
    const full = requireFile(rel);
    if (!full) continue;
    const png = PNG.sync.read(fs.readFileSync(full));
    const got = createImage(png.width, png.height, new Uint8ClampedArray(png.data));
    if (got.width !== level.width || got.height !== level.height ||
        !Buffer.from(got.data).equals(Buffer.from(level.image.data))) {
      fail(`${rel} 与重建结果像素不一致`);
    }
  }
}
if (!failures.length) ok(`守护链 L0..L${atlas.diagnostics.safeLod} 全部与重建像素一致，manifest 自洽`);

console.log('4) 重算 mip 边缘证据并与 evidence.json 比对');
const evidencePath = requireFile('evidence.json');
const evidence = evidencePath ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : null;
if (evidence) {
  if (evidence.threshold !== saved.contaminationThreshold) fail('evidence 阈值与保存参数不符');
  const live = analyzeContamination(atlas.guarded, atlas.naive, atlas.diagnostics.contaminationLevel);
  const liveById = new Map(live.map((c) => [c.id, c]));
  for (const rec of evidence.contamination) {
    const now = liveById.get(rec.id);
    if (!now) { fail(`evidence 中存在未知图块 ${rec.id}`); continue; }
    if (Math.abs(now.maxRgb - rec.maxRgb) > 0.01 || now.maxA !== rec.maxAlpha || now.contaminated !== rec.contaminatedProbes) {
      fail(`污染诊断 ${rec.id} 重算结果与 evidence.json 不符`);
    }
  }
  // Re-derive the guarded sampled-colour probes with the SAME shared math the
  // builder uses, so the pass/fail contract is executable, not just stored text.
  const sourcesById = new Map(items.map((it) => [it.id, it.image]));
  let interiorChecked = 0;
  for (const tile of atlas.tiles) {
    const page = atlas.guarded.pages[tile.pageIndex];
    const placement = page.placements.find((p) => p.id === tile.id);
    const own = tileOwnPatch(tile, placement, page, sourcesById.get(tile.id));
    const stored = evidence.sampledColors.find((s) => s.id === tile.id);
    if (!stored) { fail(`evidence 缺少图块 ${tile.id} 的采样颜色记录`); continue; }
    for (const sp of stored.probes) {
      const lv = tile.levels[sp.level];
      if (!lv || lv.x === null) continue;
      const live = evaluateProbe(atlas, tile, placement, page, own, sp.level, sp.name, sp.uv[0], sp.uv[1]);
      if (live.interiorOpaque) {
        interiorChecked++;
        if (live.rgbDelta > 2) fail(`${tile.id} L${sp.level} 内部不透明探针 RGB Δ=${live.rgbDelta} 超过 2`);
      }
      // Re-check the stored RGBA against the same reference texel and rule.
      const storedRgbDelta = Math.max(
        Math.abs(sp.sampled[0] - live.ownPatchReference[0]),
        Math.abs(sp.sampled[1] - live.ownPatchReference[1]),
        Math.abs(sp.sampled[2] - live.ownPatchReference[2]),
      );
      const storedAlphaDelta = Math.abs(sp.sampled[3] - live.ownPatchReference[3]);
      const storedPass = sp.interiorOpaque
        ? storedRgbDelta <= 2
        : storedRgbDelta <= 12 && storedAlphaDelta <= 24;
      if (!storedPass) {
        fail(`${tile.id} L${sp.level} ${sp.name} 存档采样值不满足判定约定（RGB Δ=${storedRgbDelta}, α Δ=${storedAlphaDelta}）`);
      }
      if (sp.interiorOpaque !== live.interiorOpaque) fail(`${tile.id} L${sp.level} ${sp.name} 内部不透明标记无法复现`);
    }
    if (stored.probes.length !== PROBE_POINTS.length * 3) fail(`${tile.id} 探针数量应为 ${PROBE_POINTS.length * 3}`);
  }
  if (interiorChecked !== evidence.summary.interiorOpaqueProbes) {
    fail(`内部不透明探针数量不符：重算 ${interiorChecked}，存档 ${evidence.summary.interiorOpaqueProbes}`);
  }
  // Contract: the naive chain MUST show real contamination somewhere while the
  // guarded sampled-colour probes MUST all pass. Defaults cannot fake either.
  if (evidence.summary.totalContaminatedEdgeProbes <= 0) fail('约定失败：整页滤波反例未观测到任何边缘污染');
  if (evidence.summary.failedSampledColorProbes !== 0) fail('约定失败：守护链存在失败的采样颜色探针');
  if (!failures.length) ok(`边缘污染 ${evidence.summary.totalContaminatedEdgeProbes} 探针，守护链 ${interiorChecked} 个内部探针全部通过`);
}

console.log('5) 远近视图与 mip 边缘条带真实存在且为合法 PNG');
const requiredPngs = [
  'scenes/near-guarded.png', 'scenes/near-naive.png',
  'scenes/far-guarded-l2.png', 'scenes/far-naive-l2.png',
  'atlas/naive_p0_l0.png', 'atlas/naive_p0_l1.png', 'atlas/naive_p0_l2.png',
];
for (const tile of atlas.tiles) requiredPngs.push(`mip-edges/${tile.id}-edges.png`);
for (const rel of requiredPngs) {
  const full = requireFile(rel);
  if (!full) continue;
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail(`${rel} 不是合法 PNG`);
  if (buf.length < 64) fail(`${rel} 文件过小，疑似占位内容`);
}
if (!failures.length) ok(`${requiredPngs.length} 个证据 PNG 均为真实编码文件`);

if (failures.length) {
  console.error(`\n重建核验失败：${failures.length} 项不符。请运行 npm run pack 重新生成，勿用默认值掩盖。`);
  process.exit(1);
}
console.log(`\n重建核验通过：demo-pack 与保存的来源、参数、证据完全一致。`);
