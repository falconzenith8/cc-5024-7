// RGBA image helpers. All buffers are straight-alpha RGBA8, row-major, top-left origin.

export function createImage(width, height, data) {
  return {
    width,
    height,
    data: data ?? new Uint8ClampedArray(width * height * 4),
  };
}

export function cloneImage(img) {
  return createImage(img.width, img.height, new Uint8ClampedArray(img.data));
}

export function cropImage(img, x, y, w, h) {
  const out = createImage(w, h);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * img.width + x) * 4;
    out.data.set(img.data.subarray(src, src + w * 4), row * w * 4);
  }
  return out;
}

// Rotate 90 degrees clockwise: dest(x, y) = src(y, H - 1 - x).
export function rotate90(img) {
  const out = createImage(img.height, img.width);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const sx = y;
      const sy = img.height - 1 - x;
      const si = (sy * img.width + sx) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

export function alphaBounds(img, threshold = 0) {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function hasOpaqueContent(img) {
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] > 0) return true;
  }
  return false;
}

// Nearest-visible-colour dilation. Transparent texels keep alpha 0 but receive
// the colour of the nearest visible texel, so bilinear filtering cannot pull
// black/undefined RGB into alpha edges. Multi-source BFS, O(width*height).
export function bleedTransparentRGB(img) {
  const { width, height, data } = img;
  const n = width * height;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] > 0) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  }
  if (tail === 0) return img;
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx / width) | 0;
    const src = idx * 4;
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x + 1 < width ? idx + 1 : -1,
      y > 0 ? idx - width : -1,
      y + 1 < height ? idx + width : -1,
    ];
    for (const nIdx of neighbors) {
      if (nIdx < 0 || seen[nIdx]) continue;
      seen[nIdx] = 1;
      const di = nIdx * 4;
      if (data[di + 3] === 0) {
        data[di] = data[src];
        data[di + 1] = data[src + 1];
        data[di + 2] = data[src + 2];
      }
      queue[tail++] = nIdx;
    }
  }
  return img;
}

// Area resample with alpha-correct (premultiplied) integration, then
// un-premultiplied straight RGBA and colour dilation of fully transparent
// texels. srcRect defaults to the whole image.
export function resampleArea(src, dstW, dstH, srcRect = null) {
  dstW = Math.max(1, Math.round(dstW));
  dstH = Math.max(1, Math.round(dstH));
  const rect = srcRect ?? { x: 0, y: 0, w: src.width, h: src.height };
  const out = createImage(dstW, dstH);
  const sxScale = rect.w / dstW;
  const syScale = rect.h / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = rect.y + dy * syScale;
    const sy1 = rect.y + (dy + 1) * syScale;
    const iy0 = Math.max(rect.y, Math.floor(sy0));
    const iy1 = Math.min(rect.y + rect.h, Math.ceil(sy1));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = rect.x + dx * sxScale;
      const sx1 = rect.x + (dx + 1) * sxScale;
      const ix0 = Math.max(rect.x, Math.floor(sx0));
      const ix1 = Math.min(rect.x + rect.w, Math.ceil(sx1));
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumW = 0;
      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const si = (sy * src.width + sx) * 4;
          const a = src.data[si + 3] / 255;
          sumA += a * w;
          sumR += src.data[si] * a * w;
          sumG += src.data[si + 1] * a * w;
          sumB += src.data[si + 2] * a * w;
          sumW += w;
        }
      }
      const di = (dy * dstW + dx) * 4;
      if (sumW === 0 || sumA === 0) {
        out.data[di + 3] = 0;
      } else {
        out.data[di] = clamp255(sumR / sumA);
        out.data[di + 1] = clamp255(sumG / sumA);
        out.data[di + 2] = clamp255(sumB / sumA);
        out.data[di + 3] = clamp255((sumA / sumW) * 255);
      }
    }
  }
  bleedTransparentRGB(out);
  return out;
}

export function extendEdges(src, left, top, right, bottom) {
  const out = createImage(src.width + left + right, src.height + top + bottom);
  for (let y = 0; y < out.height; y++) {
    const sy = clampInt(y - top, 0, src.height - 1);
    for (let x = 0; x < out.width; x++) {
      const sx = clampInt(x - left, 0, src.width - 1);
      const si = (sy * src.width + sx) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

export function blitImage(dst, src, x, y) {
  const sx0 = Math.max(0, -x);
  const sy0 = Math.max(0, -y);
  const dx0 = Math.max(0, x);
  const dy0 = Math.max(0, y);
  const copyW = Math.min(src.width - sx0, dst.width - dx0);
  const copyH = Math.min(src.height - sy0, dst.height - dy0);
  if (copyW <= 0 || copyH <= 0) return;
  for (let row = 0; row < copyH; row++) {
    const si = ((sy0 + row) * src.width + sx0) * 4;
    const di = ((dy0 + row) * dst.width + dx0) * 4;
    dst.data.set(src.data.subarray(si, si + copyW * 4), di);
  }
}

// Fill a rect with transparent black.
export function clearRect(img, x, y, w, h) {
  for (let row = Math.max(0, y); row < Math.min(img.height, y + h); row++) {
    const di = (row * img.width + Math.max(0, x)) * 4;
    img.data.fill(0, di, di + Math.max(0, Math.min(w, img.width - x)) * 4);
  }
}

export function makeRect(x, y, w, h) {
  return { x, y, w, h };
}

export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function expandRect(r, p, maxW = Infinity, maxH = Infinity) {
  const x = Math.max(0, r.x - p);
  const y = Math.max(0, r.y - p);
  const x2 = Math.min(maxW, r.x + r.w + p);
  const y2 = Math.min(maxH, r.y + r.h + p);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

export function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// Alpha-weighted RGBA difference, comparing premultiplied colour + alpha.
export function premulDiff(a, ai, b, bi) {
  const aa = a[ai + 3] / 255;
  const ba = b[bi + 3] / 255;
  return {
    r: Math.abs(a[ai] * aa - b[bi] * ba),
    g: Math.abs(a[ai + 1] * aa - b[bi + 1] * ba),
    b: Math.abs(a[ai + 2] * aa - b[bi + 2] * ba),
    a: Math.abs(a[ai + 3] - b[bi + 3]),
  };
}

export function compositeOverChecker(r, g, b, a, cellX, cellY, cell = 8) {
  const light = (((cellX / cell) | 0) + ((cellY / cell) | 0)) % 2 === 0;
  const bg = light ? 218 : 150;
  const af = a / 255;
  return [
    Math.round(r * af + bg * (1 - af)),
    Math.round(g * af + bg * (1 - af)),
    Math.round(b * af + bg * (1 - af)),
    255,
  ];
}
