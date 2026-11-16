#!/usr/bin/env node
// Deterministic source images for the exhibit atlas. No external art needed.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const OUT = path.resolve(import.meta.dirname, '..', 'assets', 'sources');

function make(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

function px(img, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

function rect(img, x0, y0, x1, y1, color, alpha = 255) {
  const [r, g, b] = color;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
      px(img, x, y, r, g, b, alpha);
    }
  }
}

function disc(img, cx, cy, rad, color, alpha = 255, inner = 0) {
  const [r, g, b] = color;
  for (let y = cy - rad; y <= cy + rad; y++) {
    for (let x = cx - rad; x <= cx + rad; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rad && d >= inner) px(img, x, y, r, g, b, alpha);
    }
  }
}

function line(img, x0, y0, x1, y1, color, width = 1, alpha = 255) {
  const [r, g, b] = color;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const cx = Math.round(x0 + (x1 - x0) * t);
    const cy = Math.round(y0 + (y1 - y0) * t);
    disc(img, cx, cy, width / 2, [r, g, b], alpha);
  }
}

function checker(img, cell, a, b, alpha = 255, onlyEmpty = false) {
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const c = ((x / cell) | 0) + ((y / cell) | 0);
      const col = c % 2 === 0 ? a : b;
      const i = (y * img.w + x) * 4;
      if (onlyEmpty && img.data[i + 3] !== 0) continue;
      px(img, x, y, col[0], col[1], col[2], alpha);
    }
  }
}

function frame(img, color, inset = 0) {
  const [r, g, b] = color;
  for (let x = inset; x < img.w - inset; x++) {
    px(img, x, inset, r, g, b, 255);
    px(img, x, img.h - 1 - inset, r, g, b, 255);
  }
  for (let y = inset; y < img.h - inset; y++) {
    px(img, inset, y, r, g, b, 255);
    px(img, img.w - 1 - inset, y, r, g, b, 255);
  }
}

// A poster: portrait, high contrast checker, opaque core with transparent
// scalloped corners and transparent pinstripes crossing the edges.
function poster() {
  const img = make(256, 384);
  checker(img, 32, [230, 40, 55], [250, 220, 40]);
  rect(img, 16, 16, 240, 368, [20, 24, 40]);
  checker(img, 28, [255, 255, 255], [20, 24, 40]);
  rect(img, 16, 16, 240, 60, [0, 230, 210]);
  for (let i = 0; i < 8; i++) {
    line(img, 24 + i * 26, 372, 232, 372 - i * 26, [255, 60, 190], 2, 255);
  }
  // transparent pinstripes cut clean through the artwork
  for (let x = 40; x < img.w; x += 54) {
    for (let y = 0; y < img.h; y++) px(img, x, y, 0, 0, 0, 0);
    for (let y = 0; y < img.h; y++) px(img, x + 1, y, 0, 0, 0, 0);
  }
  // scalloped transparent corners
  disc(img, 0, 0, 26, [0, 0, 0], 0);
  disc(img, img.w - 1, img.h - 1, 26, [0, 0, 0], 0);
  frame(img, [255, 255, 255]);
  return img;
}

// Wide banner: transparent letterbox, line art and blocks to the last pixel.
function banner() {
  const img = make(512, 160);
  rect(img, 0, 0, 512, 160, [10, 180, 120]);
  rect(img, 0, 0, 512, 20, [240, 30, 160]);
  rect(img, 0, 140, 512, 160, [240, 30, 160]);
  for (let i = 0; i < 9; i++) {
    const x = 20 + i * 56;
    rect(img, x, 40, x + 34, 118, i % 2 ? [10, 20, 50] : [255, 245, 220]);
  }
  for (let i = 0; i < 4; i++) {
    line(img, 0, 48 + i * 22, 511, 18 + i * 22, [255, 255, 0], 3);
  }
  // punched transparent holes near the top and bottom edges
  for (let i = 0; i < 5; i++) {
    disc(img, 60 + i * 100, 8, 7, [0, 0, 0], 0);
    disc(img, 60 + i * 100, 151, 7, [0, 0, 0], 0);
  }
  frame(img, [255, 255, 255]);
  return img;
}

// Wax stamp: circular alpha over a transparent square.
function stamp() {
  const img = make(128, 128);
  disc(img, 64, 64, 62, [245, 210, 40]);
  disc(img, 64, 64, 56, [190, 30, 50]);
  disc(img, 64, 64, 44, [245, 210, 40]);
  rect(img, 22, 58, 106, 70, [30, 20, 40]);
  line(img, 40, 40, 88, 88, [30, 20, 40], 3);
  line(img, 88, 40, 40, 88, [30, 20, 40], 3);
  for (let a = 0; a < 360; a += 12) {
    const rad = (a * Math.PI) / 180;
    line(img, 64 + Math.cos(rad) * 47, 64 + Math.sin(rad) * 47, 64 + Math.cos(rad) * 54, 64 + Math.sin(rad) * 54, [30, 20, 40], 2);
  }
  return img;
}

// Tall thin placard: strong vertical stripes and a 1px white frame.
function placard() {
  const img = make(96, 320);
  for (let y = 0; y < 320; y++) {
    const c = Math.floor(y / 16) % 2 ? [255, 255, 255] : [30, 70, 190];
    for (let x = 0; x < 96; x++) px(img, x, y, c[0], c[1], c[2], 255);
  }
  for (let y = 0; y < 320; y += 32) {
    for (let x = 0; x < 96; x++) px(img, x, y, 0, 0, 0, 0);
    for (let x = 0; x < 96; x++) px(img, x, y + 1, 240, 60, 20, 255);
  }
  frame(img, [0, 255, 255]);
  return img;
}

// Landscape plate with alpha gradient horns and a transparent centre window.
function plate() {
  const img = make(384, 224);
  checker(img, 16, [120, 20, 160], [250, 250, 250]);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const dx = Math.min(x, img.w - 1 - x);
      const dy = Math.min(y, img.h - 1 - y);
      const d = Math.min(dx, dy);
      if (d < 24) {
        const i = (y * img.w + x) * 4;
        img.data[i + 3] = Math.round((d / 24) * 255);
      }
      if (Math.hypot(x - img.w / 2, y - img.h / 2) < 46) {
        const i = (y * img.w + x) * 4;
        img.data[i + 3] = 0;
      }
    }
  }
  rect(img, 8, 8, 376, 34, [30, 220, 90]);
  rect(img, 8, 190, 376, 216, [30, 220, 90]);
  line(img, 8, 8, 375, 215, [255, 255, 255], 2);
  line(img, 375, 8, 8, 215, [255, 255, 255], 2);
  return img;
}

// Tiny label: stresses padding overhead and mip reduction.
function label() {
  const img = make(160, 64);
  rect(img, 0, 0, 160, 64, [250, 250, 250]);
  rect(img, 0, 0, 160, 8, [220, 20, 40]);
  rect(img, 0, 56, 160, 64, [220, 20, 40]);
  for (let x = 10; x < 160; x += 22) rect(img, x, 20, Math.min(160, x + 12), 44, [20, 30, 70]);
  return img;
}

const recipes = [
  ['poster.png', poster],
  ['banner.png', banner],
  ['stamp.png', stamp],
  ['placard.png', placard],
  ['plate.png', plate],
  ['label.png', label],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, fn] of recipes) {
  const img = fn();
  const png = new PNG({ width: img.w, height: img.h });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(png.data);
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png));
  console.log(`wrote ${name} ${img.w}x${img.h}`);
}
