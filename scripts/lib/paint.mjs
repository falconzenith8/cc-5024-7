// Deterministic pixel-painting helpers shared by every source generator.
// No randomness, no external art: every output PNG is reproducible bit-for-bit.

export function make(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

export function px(img, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

export function rect(img, x0, y0, x1, y1, color, alpha = 255) {
  const [r, g, b] = color;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
      px(img, x, y, r, g, b, alpha);
    }
  }
}

export function disc(img, cx, cy, rad, color, alpha = 255, inner = 0) {
  const [r, g, b] = color;
  for (let y = cy - rad; y <= cy + rad; y++) {
    for (let x = cx - rad; x <= cx + rad; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rad && d >= inner) px(img, x, y, r, g, b, alpha);
    }
  }
}

export function line(img, x0, y0, x1, y1, color, width = 1, alpha = 255) {
  const [r, g, b] = color;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const cx = Math.round(x0 + (x1 - x0) * t);
    const cy = Math.round(y0 + (y1 - y0) * t);
    disc(img, cx, cy, width / 2, [r, g, b], alpha);
  }
}

export function checker(img, cell, a, b, alpha = 255, onlyEmpty = false) {
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

export function frame(img, color, inset = 0) {
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

// Punch a fully transparent 1px vertical seam through existing artwork.
export function transparentColumn(img, x) {
  for (let y = 0; y < img.h; y++) px(img, x, y, 0, 0, 0, 0);
}

// Punch a fully transparent 1px horizontal seam through existing artwork.
export function transparentRow(img, y) {
  for (let x = 0; x < img.w; x++) px(img, x, y, 0, 0, 0, 0);
}
