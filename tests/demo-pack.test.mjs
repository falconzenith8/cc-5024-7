import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createImage } from '../src/core/rgba.mjs';
import { buildAtlas, sampleBilinearPage } from '../src/core/atlas.mjs';
import { buildCaseImages, CASE_RECIPES } from '../scripts/generate-cases.mjs';
import { PACK_PARAMS } from '../scripts/build-demo-pack.mjs';
import { tileOwnPatch, evaluateProbe } from '../scripts/lib/evidence.mjs';

const root = path.resolve(import.meta.dirname, '..');
const packDir = path.join(root, 'packs', 'demo-pack');
const read = (rel) => JSON.parse(readFileSync(path.join(packDir, rel), 'utf8'));

function caseItems() {
  return buildCaseImages().map((c) => ({
    id: c.id,
    name: c.file,
    image: createImage(c.width, c.height, new Uint8ClampedArray(c.image.data)),
  }));
}

test('demo pack physically exists with sources, atlas levels, scenes and edge strips', () => {
  for (const rel of [
    'pack-params.json', 'evidence.json', 'atlas/manifest.json', 'sources/sources.json',
    'scenes/near-guarded.png', 'scenes/near-naive.png',
    'scenes/far-guarded-l2.png', 'scenes/far-naive-l2.png', 'README.md',
  ]) {
    assert.ok(existsSync(path.join(packDir, rel)), `缺少 ${rel}`);
  }
  const params = read('pack-params.json');
  for (const recipe of CASE_RECIPES) {
    const file = `sources/${recipe[1]}`;
    assert.ok(existsSync(path.join(packDir, file)), `缺少来源 ${file}`);
    assert.ok(params.sources.some((s) => s.id === recipe[0]), `参数清单缺少 ${recipe[0]}`);
  }
});

test('case textures cover adjacent colour blocks and transparent 1px hairlines', () => {
  const byId = new Map(buildCaseImages().map((c) => [c.id, c]));
  // abut-blocks: pure red and cyan quadrants are genuinely adjacent.
  const abut = byId.get('abut-blocks').image;
  const at = (img, x, y) => {
    const i = (y * img.w + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };
  assert.deepEqual(at(abut, 10, 10), [237, 28, 36, 255]);
  assert.deepEqual(at(abut, 180, 10), [0, 229, 255, 255]);
  // hairline: a fully transparent column inside an opaque body.
  const hair = byId.get('hairline').image;
  assert.equal(at(hair, 64, 128)[3], 0);
  assert.equal(at(hair, 63, 128)[3], 255);
  assert.equal(at(hair, 65, 128)[3], 255);
  // transparent outer margin keeps a strong-contrast inner edge.
  assert.equal(at(hair, 0, 128)[3], 0);
  // ring: transparent ring texels sit between saturated red and yellow.
  const ring = byId.get('ring').image;
  assert.equal(at(ring, 72, 72 - 50)[3], 0);
  // aspect ratios really differ.
  const aspects = CASE_RECIPES.map(([, , fn]) => {
    const img = fn();
    return img.w / img.h;
  });
  assert.ok(Math.min(...aspects) < 0.25, '需要细长素材');
  assert.ok(Math.max(...aspects) > 3, '需要超宽素材');
});

test('guarded per-tile mips keep the tile own colours; naive whole-page filtering contaminates', () => {
  const items = caseItems();
  const atlas = buildAtlas(items, {
    padding: PACK_PARAMS.padding,
    pageLimit: PACK_PARAMS.pageLimit,
    budgetBytes: PACK_PARAMS.budgetBytes,
    allowRotation: PACK_PARAMS.allowRotation,
    mode: PACK_PARAMS.mode,
    minPage: PACK_PARAMS.minPage,
    maxLevel: PACK_PARAMS.maxLevel,
  });
  const sourcesById = new Map(items.map((it) => [it.id, it.image]));
  let interior = 0;
  for (const tile of atlas.tiles) {
    const page = atlas.guarded.pages[tile.pageIndex];
    const placement = page.placements.find((p) => p.id === tile.id);
    const own = tileOwnPatch(tile, placement, page, sourcesById.get(tile.id));
    for (const level of [0, 1, 2]) {
      if (!tile.levels[level] || tile.levels[level].x === null) continue;
      const probe = evaluateProbe(atlas, tile, placement, page, own, level, 'center', 0.5, 0.5);
      if (probe.interiorOpaque) {
        interior++;
        assert.ok(probe.rgbDelta <= 2, `${tile.id} L${level} 守护链中心混入异色 Δ=${probe.rgbDelta}`);
      }
    }
  }
  assert.ok(interior >= 10, '应至少有 10 个内部不透明中心探针');
  // The diagnostic failure mode must be real and present in the naive chain.
  // Core-local probes catch it where tiles abut; edge probes (evidence.json)
  // catch it on every tile because the gutter disappears under whole-page mips.
  const contaminated = atlas.diagnostics.contamination.filter((c) => c.contaminated > 0);
  assert.ok(contaminated.length >= 3, '整页滤波反例应在相邻图块上产生可测污染');
  const evidence = read('evidence.json');
  assert.equal(
    evidence.summary.tilesWithNaiveContamination, atlas.tiles.length,
    '边缘探针应在每个图块上观测到整页滤波污染',
  );
});

test('committed evidence.json numbers reproduce from generated pixels', () => {
  const evidence = read('evidence.json');
  const items = caseItems();
  const atlas = buildAtlas(items, {
    padding: PACK_PARAMS.padding,
    pageLimit: PACK_PARAMS.pageLimit,
    budgetBytes: PACK_PARAMS.budgetBytes,
    allowRotation: PACK_PARAMS.allowRotation,
    mode: PACK_PARAMS.mode,
    minPage: PACK_PARAMS.minPage,
    maxLevel: PACK_PARAMS.maxLevel,
  });
  const sourcesById = new Map(items.map((it) => [it.id, it.image]));
  assert.equal(evidence.threshold, PACK_PARAMS.contaminationThreshold);
  assert.equal(evidence.summary.failedSampledColorProbes, 0);
  assert.ok(evidence.summary.totalContaminatedEdgeProbes > 0);
  for (const record of evidence.sampledColors) {
    const tile = atlas.tiles.find((t) => t.id === record.id);
    assert.ok(tile, `evidence 含未知图块 ${record.id}`);
    const page = atlas.guarded.pages[tile.pageIndex];
    const placement = page.placements.find((p) => p.id === tile.id);
    const own = tileOwnPatch(tile, placement, page, sourcesById.get(tile.id));
    for (const sp of record.probes) {
      const live = evaluateProbe(atlas, tile, placement, page, own, sp.level, sp.name, sp.uv[0], sp.uv[1]);
      assert.equal(live.interiorOpaque, sp.interiorOpaque);
      const storedRgb = Math.max(
        Math.abs(sp.sampled[0] - live.ownPatchReference[0]),
        Math.abs(sp.sampled[1] - live.ownPatchReference[1]),
        Math.abs(sp.sampled[2] - live.ownPatchReference[2]),
      );
      const storedAlpha = Math.abs(sp.sampled[3] - live.ownPatchReference[3]);
      const pass = sp.interiorOpaque ? storedRgb <= 2 : storedRgb <= 12 && storedAlpha <= 24;
      assert.ok(pass, `${record.id} L${sp.level} ${sp.name} 存档采样违反判定约定`);
    }
  }
});

test('committed guarded level PNGs byte-match a fresh build through the saved parameters', () => {
  const items = caseItems();
  const atlas = buildAtlas(items, {
    padding: PACK_PARAMS.padding,
    pageLimit: PACK_PARAMS.pageLimit,
    budgetBytes: PACK_PARAMS.budgetBytes,
    allowRotation: PACK_PARAMS.allowRotation,
    mode: PACK_PARAMS.mode,
    minPage: PACK_PARAMS.minPage,
    maxLevel: PACK_PARAMS.maxLevel,
  });
  for (const page of atlas.guarded.pages) {
    for (const level of page.levels) {
      const file = path.join(packDir, 'atlas', `guarded_p${page.index}_l${level.level}.png`);
      const png = PNG.sync.read(readFileSync(file));
      const decoded = createImage(png.width, png.height, new Uint8ClampedArray(png.data));
      assert.equal(decoded.width, level.width);
      assert.ok(Buffer.from(decoded.data).equals(Buffer.from(level.image.data)), `L${level.level} 像素不一致`);
    }
  }
});

test('mip edge strips and far/near scene PNGs are valid and non-placeholder', () => {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const pngs = [
    'scenes/near-guarded.png', 'scenes/near-naive.png',
    'scenes/far-guarded-l2.png', 'scenes/far-naive-l2.png',
  ];
  for (const id of CASE_RECIPES.map((r) => r[0])) pngs.push(`mip-edges/${id}-edges.png`);
  for (const rel of pngs) {
    const buf = readFileSync(path.join(packDir, rel));
    assert.ok(buf.subarray(0, 8).equals(sig), `${rel} PNG 签名错误`);
    assert.ok(buf.length > 64, `${rel} 疑似占位文件`);
  }
  // far naive and far guarded must actually differ: contamination is visible.
  const g = PNG.sync.read(readFileSync(path.join(packDir, 'scenes/far-guarded-l2.png')));
  const n = PNG.sync.read(readFileSync(path.join(packDir, 'scenes/far-naive-l2.png')));
  assert.equal(g.width, n.width);
  let diff = 0;
  for (let i = 0; i < g.data.length; i += 4) {
    if (Math.abs(g.data[i] - n.data[i]) + Math.abs(g.data[i + 1] - n.data[i + 1]) > 40) diff++;
  }
  assert.ok(diff > 20, '远景守护/反例视图应存在肉眼可辨的颜色差异');
  void sampleBilinearPage;
});
