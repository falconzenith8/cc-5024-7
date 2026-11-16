#!/usr/bin/env node
// Probe exhibits for contamination testing. These are real, usable exhibit
// textures (not synthetic unit fixtures): each one stresses a specific mip /
// filtering failure while still rendering as gallery content.
//
// Deterministic by construction. The recipe table below is the saved source
// of truth; build-demo-pack.mjs copies it verbatim into the pack manifest so
// every committed PNG can be rebuilt and compared byte-for-byte.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { make, px, rect, disc, line, checker, frame, transparentColumn, transparentRow } from './lib/paint.mjs';

// Fully saturated, maximally separated neighbour colours. When a naive
// whole-page filter borrows a texel across the gutter, the contamination is
// visible at a glance and unambiguous in the numeric probes.
const INK = [12, 14, 22];
const RED = [237, 28, 36];
const CYAN = [0, 229, 255];
const YELLOW = [255, 230, 0];
const BLUE = [20, 40, 220];
const GREEN = [0, 200, 90];
const MAGENTA = [255, 0, 180];
const ORANGE = [255, 130, 0];
const WHITE = [255, 255, 255];

// 1) Abutting colour blocks. Red/cyan and yellow/blue blocks meet along
// internal 1px seams, with a black 1px frame at the outer edge: any colour
// pulled from an adjacent atlas tile shows up against these pure primaries.
function abutBlocks() {
  const img = make(192, 192);
  rect(img, 0, 0, 96, 96, RED);
  rect(img, 96, 0, 192, 96, CYAN);
  rect(img, 0, 96, 96, 192, YELLOW);
  rect(img, 96, 96, 192, 192, BLUE);
  // internal high-contrast 1px seams
  for (let y = 0; y < img.h; y++) px(img, 95, y, ...INK);
  for (let x = 0; x < img.w; x++) px(img, x, 95, ...INK);
  frame(img, INK);
  return img;
}

// 2) Transparent 1px hairlines: a fully transparent vertical seam inside an
// opaque body and a transparent outer margin, so edge dilation behaviour is
// observable at every mip level.
function hairline() {
  const img = make(128, 256);
  rect(img, 0, 0, 128, 256, GREEN);
  rect(img, 8, 8, 120, 248, [8, 60, 30]);
  for (let y = 8; y < 248; y++) {
    px(img, 40, y, ...MAGENTA);
    px(img, 87, y, ...WHITE);
  }
  transparentColumn(img, 64);
  // transparent 1px outer frame (margin): leaves a strong-contrast inner edge
  transparentColumn(img, 0);
  transparentColumn(img, 127);
  transparentRow(img, 0);
  transparentRow(img, 255);
  return img;
}

// 3) Ultra-wide ribbon, different aspect ratio (~3.2:1), colour running to the
// last texel so the long edges are the riskiest part of the atlas gutter.
function ribbon() {
  const img = make(320, 96);
  const bands = [MAGENTA, ORANGE, CYAN, BLUE, YELLOW];
  const bw = img.w / bands.length;
  bands.forEach((c, i) => rect(img, Math.round(i * bw), 0, Math.round((i + 1) * bw), img.h, c));
  for (let i = 1; i < bands.length; i++) {
    const x = Math.round(i * bw) - 1;
    for (let y = 0; y < img.h; y++) px(img, x, y, ...INK);
  }
  line(img, 0, 48, 319, 48, WHITE, 2);
  frame(img, INK);
  return img;
}

// 4) Tall slender pole (~1:5), mostly opaque with punched transparent notches
// along both long edges: exercises padding on a tile whose short side is only
// a few texels once mip levels shrink.
function pole() {
  const img = make(48, 240);
  rect(img, 0, 0, 48, 240, ORANGE);
  for (let y = 16; y < 240; y += 32) {
    disc(img, 0, y, 9, INK, 0);
    disc(img, 47, y, 9, INK, 0);
  }
  rect(img, 12, 0, 36, 240, [60, 24, 0]);
  frame(img, WHITE);
  return img;
}

// 5) Thin transparent ring inside a saturated disc: the ring's RGB must be
// dilated from the disc, never from a neighbouring tile, after downsampling.
function ring() {
  const img = make(144, 144);
  disc(img, 72, 72, 70, RED);
  disc(img, 72, 72, 52, [0, 0, 0], 0);
  disc(img, 72, 72, 46, YELLOW);
  disc(img, 72, 72, 20, BLUE);
  frame(img, INK);
  return img;
}

// 6) Tiny 1px-outlined chip: smallest tile in the pack, forces the guarded
// mip chain to stop early and exposes whole-page filter bleed at deep LODs.
function chip() {
  const img = make(64, 64);
  checker(img, 16, WHITE, INK);
  rect(img, 6, 6, 58, 58, CYAN);
  rect(img, 14, 14, 50, 30, [4, 40, 48]);
  frame(img, MAGENTA);
  return img;
}

// 7) Letterboxed exhibit: opaque artwork inside a transparent 1px letterbox on
// all four sides, plus a diagonal transparent cut, so both axis-aligned and
// diagonal alpha edges appear in one tile.
function letterbox() {
  const img = make(224, 128);
  rect(img, 1, 1, 223, 127, [40, 24, 80]);
  checker(img, 24, [90, 40, 160], [240, 240, 250], 255, true);
  rect(img, 16, 20, 208, 60, [255, 170, 0]);
  line(img, 16, 108, 208, 20, INK, 4);
  for (let i = -2; i <= 2; i++) {
    for (let t = 0; t <= 100; t++) {
      const x = Math.round(16 + (208 - 16) * (t / 100));
      const y = Math.round(108 + (20 - 108) * (t / 100));
      px(img, x + i, y, 0, 0, 0, 0);
    }
  }
  transparentColumn(img, 0);
  transparentColumn(img, 223);
  transparentRow(img, 0);
  transparentRow(img, 127);
  return img;
}

// id -> [filename, builder, human description of the failure mode it probes]
export const CASE_RECIPES = [
  ['abut-blocks', 'abut-blocks.png', abutBlocks, '紧邻高对比色块与内部 1px 接缝'],
  ['hairline', 'hairline.png', hairline, '不透明主体内透明 1px 竖缝与透明外沿'],
  ['ribbon', 'ribbon.png', ribbon, '3.3:1 超宽长宽比，颜色延伸到最后一个像素'],
  ['pole', 'pole.png', pole, '1:5 细长长宽比，长边透明缺口'],
  ['ring', 'ring.png', ring, '饱和圆盘内的透明细环，检验透明区扩色来源'],
  ['chip', 'chip.png', chip, '最小图块与 1px 描边，压测深层 mip 下限'],
  ['letterbox', 'letterbox.png', letterbox, '四周 1px 透明信箱边与对角透明切线'],
];

export function buildCaseImages() {
  return CASE_RECIPES.map(([id, file, fn, probe]) => {
    const img = fn();
    return { id, file, probe, width: img.w, height: img.h, image: img };
  });
}

// Run directly: regenerate the committed sources and their provenance record.
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invoked) {
  const OUT = path.resolve(import.meta.dirname, '..', 'assets', 'cases');
  fs.mkdirSync(OUT, { recursive: true });
  const records = [];
  for (const item of buildCaseImages()) {
    const png = new PNG({ width: item.width, height: item.height });
    Buffer.from(item.image.data.buffer, item.image.data.byteOffset, item.image.data.byteLength).copy(png.data);
    fs.writeFileSync(path.join(OUT, item.file), PNG.sync.write(png));
    records.push({ id: item.id, file: item.file, width: item.width, height: item.height, probe: item.probe });
    console.log(`wrote ${item.file} ${item.width}x${item.height}`);
  }
  const provenance = {
    generator: 'scripts/generate-cases.mjs',
    deterministic: true,
    seed: 'fixed-primaries-v1',
    palette: { INK, RED, CYAN, YELLOW, BLUE, GREEN, MAGENTA, ORANGE, WHITE },
    recipes: records,
  };
  fs.writeFileSync(path.join(OUT, 'sources.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`wrote sources.json (${records.length} recipes)`);
}
