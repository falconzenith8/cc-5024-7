// CPU renderers for headless evidence images. They use the SAME bilinear
// sampler the studio UI uses (sampleBilinearPage), so the committed PNGs are
// exactly what a user would see on screen, without needing a browser.
import { createImage, compositeOverChecker } from '../../src/core/rgba.mjs';
import { sampleBilinearPage } from '../../src/core/atlas.mjs';
import { PNG } from 'pngjs';
import fs from 'node:fs';

export function writePng(file, image) {
  const png = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

export function checkerComposite(image, cell = 12) {
  const out = createImage(image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const [r, g, b] = compositeOverChecker(
        image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3], x, y, cell,
      );
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

// Nearest-neighbour upscale so individual texels stay readable in evidence
// strips. Keeps straight alpha and composites over a dark checker.
export function upscale(image, factor) {
  const out = createImage(image.width * factor, image.height * factor);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(image.width - 1, (x / factor) | 0);
      const sy = Math.min(image.height - 1, (y / factor) | 0);
      const si = (sy * image.width + sx) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di] = image.data[si];
      out.data[di + 1] = image.data[si + 1];
      out.data[di + 2] = image.data[si + 2];
      out.data[di + 3] = image.data[si + 3];
    }
  }
  return out;
}

// Place images side by side into one strip with an 8px dark gutter.
export function hStrip(images, gutter = 8, bg = [10, 12, 16]) {
  const h = Math.max(...images.map((i) => i.height));
  const w = images.reduce((s, i) => s + i.width, 0) + gutter * (images.length - 1);
  const out = createImage(w, h);
  out.data.fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out.data[i] = bg[0];
      out.data[i + 1] = bg[1];
      out.data[i + 2] = bg[2];
    }
  }
  let x0 = 0;
  for (const img of images) {
    for (let y = 0; y < img.height; y++) {
      const si = y * img.width * 4;
      const di = (y * w + x0) * 4;
      out.data.set(img.data.subarray(si, si + img.width * 4), di);
    }
    x0 += img.width + gutter;
  }
  return out;
}

// Render a whole mip level through the bilinear sampler at a given canvas
// size (a "wall" view). Alpha composites over the same dark checker the UI
// uses, so transparent hairlines stay visible.
export function renderLevelView(levelImage, canvasW, canvasH) {
  const out = createImage(canvasW, canvasH);
  for (let y = 0; y < canvasH; y++) {
    for (let x = 0; x < canvasW; x++) {
      const u = (x + 0.5) / canvasW;
      const v = (y + 0.5) / canvasH;
      const c = sampleBilinearPage(levelImage, u, v);
      const di = (y * canvasW + x) * 4;
      const light = (((x / 10) | 0) + ((y / 10) | 0)) % 2 === 0;
      const bg = light ? 42 : 26;
      const a = c[3] / 255;
      out.data[di] = Math.round(c[0] * a + bg * (1 - a));
      out.data[di + 1] = Math.round(c[1] * a + (bg + 3) * (1 - a));
      out.data[di + 2] = Math.round(c[2] * a + (bg + 7) * (1 - a));
      out.data[di + 3] = 255;
    }
  }
  return out;
}

// Crop a rect from an image (clamped).
export function crop(image, x, y, w, h) {
  const out = createImage(w, h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const sx = Math.max(0, Math.min(image.width - 1, x + col));
      const sy = Math.max(0, Math.min(image.height - 1, y + row));
      const si = (sy * image.width + sx) * 4;
      const di = (row * w + col) * 4;
      out.data[di] = image.data[si];
      out.data[di + 1] = image.data[si + 1];
      out.data[di + 2] = image.data[si + 2];
      out.data[di + 3] = image.data[si + 3];
    }
  }
  return out;
}

export function sampleAt(image, x, y) {
  return sampleBilinearPage(image, (x - 0.5) / image.width, (y - 0.5) / image.height);
}
