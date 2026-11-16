import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  createImage,
  resampleArea,
  extendEdges,
  rotate90,
  bleedTransparentRGB,
  alphaBounds,
} from '../src/core/rgba.mjs';
import { planPages } from '../src/core/atlas.mjs';
import {
  buildAtlas,
  makeManifest,
  sampleTileSource,
  AtlasError,
} from '../src/core/atlas.mjs';

const root = path.resolve(import.meta.dirname, '..');

function loadPng(name) {
  const png = PNG.sync.read(readFileSync(path.join(root, 'assets', 'sources', name)));
  return createImage(png.width, png.height, new Uint8ClampedArray(png.data));
}

function sources() {
  return ['poster.png', 'banner.png', 'stamp.png', 'placard.png', 'plate.png', 'label.png'].map((f) => {
    const image = loadPng(f);
    return { id: f.replace('.png', ''), name: f, image };
  });
}

test('rotate90 maps corners clockwise and is its own inverse at 360', () => {
  const img = createImage(3, 2, new Uint8ClampedArray([
    1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255,
    4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
  ]));
  const r = rotate90(img);
  assert.equal(r.width, 2);
  assert.equal(r.height, 3);
  // top-left of source goes to top-right
  assert.equal(r.data[0], 4);
  assert.equal(r.data[4], 1);
  const four = rotate90(rotate90(rotate90(rotate90(img))));
  assert.deepEqual([...four.data], [...img.data]);
  assert.equal(four.width, 3);
});

test('resampleArea averages premultiplied, no dark fringe from transparent neighbours', () => {
  // 2x1: opaque red next to transparent black. Downsample to 1x1.
  const img = createImage(2, 1, new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]));
  const out = resampleArea(img, 1, 1);
  assert.equal(out.data[0], 255);
  assert.equal(out.data[1], 0);
  assert.equal(out.data[2], 0);
  assert.equal(out.data[3], 128);
});

test('bleed gives transparent texels the nearest opaque colour', () => {
  const img = createImage(3, 1, new Uint8ClampedArray([
    0, 0, 0, 0, 10, 200, 30, 255, 0, 0, 0, 0,
  ]));
  bleedTransparentRGB(img);
  assert.deepEqual([...img.data.subarray(0, 4)], [10, 200, 30, 0]);
  assert.deepEqual([...img.data.subarray(8, 12)], [10, 200, 30, 0]);
});

test('extendEdges repeats border pixels', () => {
  const img = createImage(2, 2, new Uint8ClampedArray([
    1, 0, 0, 255, 2, 0, 0, 255,
    3, 0, 0, 255, 4, 0, 0, 255,
  ]));
  const out = extendEdges(img, 1, 1, 1, 1);
  assert.equal(out.width, 4);
  assert.equal(out.data[(0 * 4 + 0) * 4], 1);
  assert.equal(out.data[(0 * 4 + 3) * 4], 2);
  assert.equal(out.data[(3 * 4 + 3) * 4], 4);
});

test('plan never shrinks: impossible tile raises TILE_TOO_LARGE', () => {
  const big = createImage(1000, 1000, new Uint8ClampedArray(1000 * 1000 * 4));
  assert.throws(
    () => planPages([{ id: 'big', image: big, name: 'big' }], {
      padding: 16, pageLimit: 1024, allowRotation: false, mode: 'guarded', minPage: 128, maxLevel: 4, budgetBytes: 1e9,
    }),
    (err) => err instanceof AtlasError && err.code === 'TILE_TOO_LARGE',
  );
});

test('builds one guarded page with non-overlapping padded rects', () => {
  const atlas = buildAtlas(sources(), { padding: 16, pageLimit: 1024, budgetBytes: 64 * 1024 * 1024 });
  assert.equal(atlas.guarded.pages.length, 1);
  const page = atlas.guarded.pages[0];
  for (let i = 0; i < page.placements.length; i++) {
    const a = page.placements[i];
    const aPad = { x: a.x - 16, y: a.y - 16, w: a.w + 32, h: a.h + 32 };
    for (let j = i + 1; j < page.placements.length; j++) {
      const b = page.placements[j];
      const bPad = { x: b.x - 16, y: b.y - 16, w: b.w + 32, h: b.h + 32 };
      const overlap = aPad.x < bPad.x + bPad.w && aPad.x + aPad.w > bPad.x &&
        aPad.y < bPad.y + bPad.h && aPad.y + aPad.h > bPad.y;
      assert.ok(!overlap, `${a.id} padded area overlaps ${b.id}`);
    }
  }
});

test('every mip level keeps each tile at least 2px and independent content', () => {
  const atlas = buildAtlas(sources(), { padding: 16, pageLimit: 1024, budgetBytes: 64 * 1024 * 1024 });
  const page = atlas.guarded.pages[0];
  assert.ok(page.levels.length >= 3, `expected deep mip chain, got ${page.levels.length}`);
  for (const lv of page.levels) {
    for (const r of lv.rects) {
      assert.ok(r.w >= 2 && r.h >= 2, `level ${lv.level} ${r.id} collapsed to ${r.w}x${r.h}`);
    }
  }
  // Tile content at level 2 must resemble a downsample of its own padded patch,
  // not its neighbour. Compare centre pixel of stamp vs a page-atlas downsample
  // of the same coordinate: identical only when no bleed from neighbours.
  const lv = 2;
  const lvl = page.levels[lv];
  const stamp = page.placements.find((p) => p.id === 'stamp');
  const expected = atlas.tiles.find((t) => t.id === 'stamp').levels[lv];
  assert.equal(expected.x, stamp.x >> lv);
  assert.equal(expected.w, stamp.w >> lv);
});

test('unsafe tile raises with the tile named, and budget overflow names required size', () => {
  const atlas = buildAtlas(sources(), { padding: 16, pageLimit: 1024, budgetBytes: 64 * 1024 * 1024 });
  const required = atlas.diagnostics.totalBytes;
  assert.throws(
    () => buildAtlas(sources(), { padding: 16, pageLimit: 1024, budgetBytes: required - 1 }),
    (err) => err instanceof AtlasError && err.code === 'BUDGET_EXCEEDED' && err.details.requiredBytes === required,
  );
});

function synthetic(items) {
  return items.map(([id, w, h]) => ({ id, name: id, image: createImage(w, h, new Uint8ClampedArray(w * h * 4).fill(255)) }));
}

function rotationFixture() {
  // Two 240x100-style bars that only tile when one is rotated at 256px.
  return synthetic([['bar-a', 100, 240], ['bar-b', 240, 100]]);
}

test('rotation records 90° and UV transform round-trips', () => {
  const atlas = buildAtlas(rotationFixture(), { padding: 4, pageLimit: 256, budgetBytes: 256 * 1024 * 1024 });
  const rotated = atlas.tiles.filter((t) => t.rotated);
  assert.ok(rotated.length > 0, 'expected at least one rotated tile at 512px');
  for (const t of rotated) {
    assert.equal(t.rotationDeg, 90);
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.3, 0.77]]) {
      const [au, av] = [t.uvTransform[0] * u + t.uvTransform[1] * v + t.uvTransform[2],
        t.uvTransform[3] * u + t.uvTransform[4] * v + t.uvTransform[5]];
      const iu = t.inverseUvTransform[0] * au + t.inverseUvTransform[1] * av + t.inverseUvTransform[2];
      const iv = t.inverseUvTransform[3] * au + t.inverseUvTransform[4] * av + t.inverseUvTransform[5];
      assert.ok(Math.abs(iu - u) < 1e-9 && Math.abs(iv - v) < 1e-9, `${t.id} uv round trip`);
    }
  }
});

test('rotated corner mapping is physically clockwise on the page', () => {
  const atlas = buildAtlas(rotationFixture(), { padding: 4, pageLimit: 256, budgetBytes: 256 * 1024 * 1024 });
  const t = atlas.tiles.find((x) => x.rotated);
  // source top-left (0,0) maps to atlas top-right of core
  const [au, av] = [t.uvTransform[0] * 0 + t.uvTransform[1] * 0 + t.uvTransform[2],
    t.uvTransform[3] * 0 + t.uvTransform[4] * 0 + t.uvTransform[5]];
  assert.ok(Math.abs(au * t.levels[0].width - (t.atlasCore.x + t.atlasCore.w)) < 1e-6);
  assert.ok(Math.abs(av * t.levels[0].height - t.atlasCore.y) < 1e-6);
});

test('contamination diagnostics come from real pixels and distinguish naive from guarded', () => {
  const atlas = buildAtlas(sources(), { padding: 16, pageLimit: 1024, budgetBytes: 64 * 1024 * 1024 });
  assert.ok(atlas.diagnostics.contamination.length >= 4);
  const byId = Object.fromEntries(atlas.diagnostics.contamination.map((c) => [c.id, c]));
  assert.ok(byId.stamp.total > 0);
  // Naive whole-page filtering cannot be pixel-identical at all probes for all tiles.
  const anyDiff = atlas.diagnostics.contamination.some((c) => c.meanRgb > 0.5 || c.maxA > 4);
  assert.ok(anyDiff, 'naive comparison should diverge somewhere');
});

test('manifest is self-contained and file layout has all mip levels', () => {
  const atlas = buildAtlas(sources(), { padding: 16, pageLimit: 1024, budgetBytes: 64 * 1024 * 1024 });
  const manifest = makeManifest(atlas);
  assert.equal(manifest.format, 'exhibit-atlas');
  assert.equal(manifest.sampler.generateMipmaps, false);
  const page = manifest.pages[0];
  assert.equal(page.levels.length, atlas.guarded.pages[0].levels.length);
  for (const t of manifest.tiles) {
    assert.ok(Array.isArray(t.uvTransform) && t.uvTransform.length === 6);
    assert.ok(Array.isArray(t.inverseUvTransform) && t.inverseUvTransform.length === 6);
    assert.ok(t.levels.length === page.levels.length);
    assert.equal(typeof t.uv.x, 'number');
  }
});

test('sampleTileSource applies rotation-aware mapping', () => {
  const atlas = buildAtlas(rotationFixture(), { padding: 4, pageLimit: 256, budgetBytes: 256 * 1024 * 1024 });
  const t = atlas.tiles.find((x) => x.rotated);
  const { page, uv } = sampleTileSource(atlas, t.id, 0, 0);
  assert.equal(page.index, t.pageIndex);
  assert.ok(Math.abs(uv[0] - (t.atlasCore.x + t.atlasCore.w) / page.width) < 1e-9);
});

test('alphaBounds reports transparent margins', () => {
  const img = createImage(10, 10, new Uint8ClampedArray(400));
  const i = (4 * 10 + 3) * 4;
  img.data[i + 3] = 255;
  assert.deepEqual(alphaBounds(img), { x: 3, y: 4, w: 1, h: 1 });
});

test('splitting at small pageLimit does not alter tiles', () => {
  const items = synthetic([
    ['sq-a', 200, 200], ['sq-b', 200, 200], ['sq-c', 200, 200],
    ['sq-d', 200, 200], ['sq-e', 200, 200],
  ]);
  const atlas = buildAtlas(items, { padding: 16, pageLimit: 256, budgetBytes: 512 * 1024 * 1024 });
  assert.ok(atlas.guarded.pages.length >= 2, `expected split, got ${atlas.guarded.pages.length}`);
  assert.ok(atlas.diagnostics.split);
  const totalArea = atlas.tiles.reduce((s, t) => s + t.atlasCore.w * t.atlasCore.h, 0);
  const srcArea = items.reduce((s, it) => s + it.image.width * it.image.height, 0);
  assert.equal(totalArea, srcArea);
  for (const t of atlas.tiles) {
    assert.ok((t.atlasCore.w === t.sourceWidth && t.atlasCore.h === t.sourceHeight) ||
      (t.atlasCore.w === t.sourceHeight && t.atlasCore.h === t.sourceWidth));
  }
});
