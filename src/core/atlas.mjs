import {
  createImage,
  cloneImage,
  extendEdges,
  blitImage,
  resampleArea,
  bleedTransparentRGB,
  alphaBounds,
  rotate90,
  premulDiff,
  clampInt,
} from './rgba.mjs';
import { MaxRectsPacker, assertNoOverlap } from './packer.mjs';

export class AtlasError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AtlasError';
    this.code = code;
    this.details = details;
  }
}

export const DEFAULT_OPTIONS = Object.freeze({
  padding: 16,
  pageLimit: 1024,
  budgetBytes: 16 * 1024 * 1024,
  allowRotation: true,
  mode: 'guarded',
  minPage: 128,
  maxLevel: 10,
});

const PAGE_SIZES = [128, 256, 512, 1024, 2048, 4096];
const MAX_SOURCE_DIM = 4096;

function normalizeOptions(options) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  if (!(o.padding >= 1)) throw new AtlasError('INVALID_OPTIONS', 'padding 必须至少为 1 像素');
  if (!(o.pageLimit >= 128)) throw new AtlasError('INVALID_OPTIONS', 'pageLimit 必须至少为 128');
  if (!(o.budgetBytes > 0)) throw new AtlasError('INVALID_OPTIONS', 'budgetBytes 必须为正数');
  if (o.mode !== 'guarded' && o.mode !== 'naive') {
    throw new AtlasError('INVALID_OPTIONS', `未知模式 ${o.mode}`);
  }
  return o;
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AtlasError('EMPTY_ATLAS', '至少需要一个图块');
  }
  const seen = new Set();
  for (const item of items) {
    if (!item || !item.id || !item.image) {
      throw new AtlasError('INVALID_ITEM', '图块缺少 id 或图像数据');
    }
    if (seen.has(item.id)) throw new AtlasError('DUPLICATE_ID', `重复图块 id: ${item.id}`);
    seen.add(item.id);
    const { width, height, data } = item.image;
    if (!(width > 0) || !(height > 0) || data.length !== width * height * 4) {
      throw new AtlasError('INVALID_IMAGE', `${item.id} 的图像尺寸与缓冲区不一致`);
    }
    if (width > MAX_SOURCE_DIM || height > MAX_SOURCE_DIM) {
      throw new AtlasError('TILE_TOO_LARGE', `${item.id} 超过单块上限 ${MAX_SOURCE_DIM}px`, {
        item: item.id,
        width,
        height,
      });
    }
  }
}

function pageSizesUpTo(limit, minPage) {
  return PAGE_SIZES.filter((s) => s >= minPage && s <= limit);
}

function packAttempt(order, pageSize, pad, allowRotation) {
  const packer = new MaxRectsPacker(pageSize, pageSize);
  const items = order.map((item) => ({
    id: item.id,
    w: item.image.width,
    h: item.image.height,
    pad,
    allowRotate: allowRotation,
  }));
  return packer.insert(items);
}

// Plan pages without ever shrinking a tile. Strategy:
//  1. find the smallest square page that holds everything;
//  2. otherwise split across pages of pageLimit;
//  3. if an individual tile cannot fit, fail loudly.
export function planPages(items, options) {
  const pad = options.mode === 'naive' ? 0 : options.padding;
  const order = [...items].sort((a, b) => {
    const aa = a.image.width * a.image.height;
    const bb = b.image.width * b.image.height;
    if (bb !== aa) return bb - aa;
    if (b.image.width !== a.image.width) return b.image.width - a.image.width;
    return a.id.localeCompare(b.id);
  });

  const candidates = pageSizesUpTo(options.pageLimit, options.minPage);
  if (candidates.length === 0) {
    throw new AtlasError('INVALID_OPTIONS', 'pageLimit 小于最小页尺寸');
  }

  const tooLarge = [];
  for (const item of order) {
    const w = item.image.width;
    const h = item.image.height;
    const variants = options.allowRotation ? [[w, h], [h, w]] : [[w, h]];
    const fits = variants.some(([qw, qh]) => qw + pad * 2 <= options.pageLimit && qh + pad * 2 <= options.pageLimit);
    if (!fits) tooLarge.push({ id: item.id, width: w, height: h });
  }
  if (tooLarge.length) {
    throw new AtlasError(
      'TILE_TOO_LARGE',
      `${tooLarge.map((t) => t.id).join(', ')} 在 ${options.pageLimit}px 页内放不下（padding ${pad}px，旋转${options.allowRotation ? '允许' : '不允许'}）`,
      { tiles: tooLarge, pageLimit: options.pageLimit, padding: pad },
    );
  }

  for (const size of candidates) {
    const attempt = packAttempt(order, size, pad, options.allowRotation);
    if (attempt.failed.length === 0) {
      return {
        pages: [{ size, placements: attempt.placed.sort((a, b) => a.id.localeCompare(b.id)) }],
        split: false,
        pad,
      };
    }
  }

  const pages = [];
  let remaining = order;
  while (remaining.length) {
    const attempt = packAttempt(remaining, options.pageLimit, pad, options.allowRotation);
    if (attempt.placed.length === 0) {
      throw new AtlasError(
        'PACK_FAILED',
        `无法在 ${options.pageLimit}px 页内放置剩余图块（不缩小图块）`,
        { remaining: attempt.failed.map((f) => f.id), pageLimit: options.pageLimit },
      );
    }
    pages.push({ size: options.pageLimit, placements: attempt.placed.sort((a, b) => a.id.localeCompare(b.id)) });
    const placedIds = new Set(attempt.placed.map((p) => p.id));
    remaining = remaining.filter((item) => !placedIds.has(item.id));
  }
  return { pages, split: pages.length > 1, pad };
}

function affineFromRotation({ x, y, w, h, pageW, pageH, rotationDeg }) {
  if (rotationDeg === 0) {
    return [w / pageW, 0, x / pageW, 0, h / pageH, y / pageH];
  }
  // 90° clockwise. Source uv (u,v) -> atlas uv:
  // u' = (x + (1 - v) * w) / pageW, v' = (y + u * h) / pageH
  return [0, -w / pageW, (x + w) / pageW, h / pageH, 0, y / pageH];
}

function invertAffine(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) throw new AtlasError('INVALID_TRANSFORM', 'UV 变换不可逆');
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  return [ia, ib, (b * f - e * c) / det, id, ie, (d * c - a * f) / det];
}

function mapPoint(m, u, v) {
  return [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]];
}

function opaqueBoundsInAtlas(opaque, rotationDeg, coreX, coreY) {
  if (!opaque) return null;
  if (rotationDeg === 0) {
    return { x: coreX + opaque.x, y: coreY + opaque.y, w: opaque.w, h: opaque.h };
  }
  // 90 CW: source (x,y) -> rotated (H-1-y, x)
  return {
    x: coreX + opaque.y,
    y: coreY + opaque.x,
    w: opaque.h,
    h: opaque.w,
  };
}

function buildMode(items, plan, options, modeLabel) {
  const pad = plan.pad;
  const pages = [];

  for (let pIdx = 0; pIdx < plan.pages.length; pIdx++) {
    const planned = plan.pages[pIdx];
    const size = planned.size;
    const base = createImage(size, size);
    const patches = new Map();
    const placements = [];

    for (const placement of planned.placements) {
      const item = items.find((it) => it.id === placement.id);
      let img = item.image;
      if (placement.rotated) img = rotate90(img);
      const srcW = item.image.width;
      const srcH = item.image.height;
      const rotatedSrc = img;
      // Dilate RGB into fully transparent texels at every level, including L0.
      // Without this, straight-alpha bilinear sampling darkens edges towards
      // black wherever the source had RGB=0 under alpha=0.
      // Guarded mode dilates transparent RGB so bilinear sampling does not pull
      // black in. Naive mode is deliberately left raw: that is the failure mode
      // this tool demonstrates, and it is never part of the delivered atlas.
      const patchSource = cloneImage(rotatedSrc);
      if (modeLabel !== 'naive') bleedTransparentRGB(patchSource);
      const patch = pad > 0 ? extendEdges(patchSource, pad, pad, pad, pad) : patchSource;
      blitImage(base, patch, placement.x - pad, placement.y - pad);
      patches.set(placement.id, {
        image: patch,
        coreW: placement.w,
        coreH: placement.h,
        pad,
        sourceW: srcW,
        sourceH: srcH,
        rotated: placement.rotated,
      });
      const opaque = alphaBounds(item.image, 0);
      placements.push({
        id: placement.id,
        x: placement.x,
        y: placement.y,
        w: placement.w,
        h: placement.h,
        rotated: placement.rotated,
        rotationDeg: placement.rotated ? 90 : 0,
        sourceWidth: srcW,
        sourceHeight: srcH,
        opaqueBounds: opaque,
        opaqueBoundsInAtlas: opaqueBoundsInAtlas(opaque, placement.rotated ? 90 : 0, placement.x, placement.y),
        uvTransform: affineFromRotation({
          x: placement.x,
          y: placement.y,
          w: placement.w,
          h: placement.h,
          pageW: size,
          pageH: size,
          rotationDeg: placement.rotated ? 90 : 0,
        }),
      });
    }

    assertNoOverlap(placements);

    const levels = [
      {
        level: 0,
        width: size,
        height: size,
        image: base,
        rects: placements.map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h })),
      },
    ];
    let stopReason = null;

    if (modeLabel === 'guarded') {
      for (let l = 1; l <= options.maxLevel; l++) {
        const pageW = size >> l;
        const pageH = size >> l;
        if (pageW < 2 || pageH < 2) break;
        const padL = Math.max(1, pad >> l);
        const targetRects = [];
        let blocked = false;
        for (const p of placements) {
          const w = p.w >> l;
          const h = p.h >> l;
          if (w < 2 || h < 2) {
            blocked = true;
            stopReason = 'tile-below-2px';
            break;
          }
          targetRects.push({
            id: p.id,
            x: p.x >> l,
            y: p.y >> l,
            w,
            h,
            pad: padL,
            source: patches.get(p.id),
          });
        }
        if (blocked) break;
        for (let i = 0; i < targetRects.length && !blocked; i++) {
          const a = targetRects[i];
          const ax0 = a.x - padL;
          const ay0 = a.y - padL;
          const ax1 = a.x + a.w + padL;
          const ay1 = a.y + a.h + padL;
          for (let j = i + 1; j < targetRects.length; j++) {
            const b = targetRects[j];
            const bx0 = b.x - padL;
            const by0 = b.y - padL;
            const bx1 = b.x + b.w + padL;
            const by1 = b.y + b.h + padL;
            if (ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0) {
              blocked = true;
              stopReason = 'padding-collision';
              break;
            }
          }
        }
        if (blocked) break;
        const levelImage = createImage(pageW, pageH);
        for (const r of targetRects) {
          const targetW = r.w + padL * 2;
          const targetH = r.h + padL * 2;
          const resampled = resampleArea(r.source.image, targetW, targetH);
          blitImage(levelImage, resampled, r.x - padL, r.y - padL);
        }
        levels.push({
          level: l,
          width: pageW,
          height: pageH,
          image: levelImage,
          rects: targetRects.map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h })),
          pad: padL,
        });
      }
    } else {
      // Explicitly naive comparison mode: filter the WHOLE atlas. This is the
      // failure mode the tool exists to expose; it is never the default.
      for (let l = 1; l <= options.maxLevel; l++) {
        const pageW = size >> l;
        const pageH = size >> l;
        if (pageW < 1 || pageH < 1) break;
        const levelImage = resampleArea(base, pageW, pageH);
        const rects = placements.map((p) => ({
          id: p.id,
          x: p.x >> l,
          y: p.y >> l,
          w: Math.max(1, p.w >> l),
          h: Math.max(1, p.h >> l),
        }));
        const everyTileVisible = rects.every((r) => r.w >= 1 && r.h >= 1);
        if (!everyTileVisible) break;
        levels.push({
          level: l,
          width: pageW,
          height: pageH,
          image: levelImage,
          rects,
        });
      }
    }

    pages.push({
      index: pIdx,
      id: `page-${pIdx}`,
      width: size,
      height: size,
      levels,
      placements,
      pad,
      stopReason,
    });
  }

  return {
    mode: modeLabel,
    pages,
    pad,
    safeLod: pages.reduce((m, p) => Math.min(m, p.levels.length - 1), Infinity),
  };
}

export function sampleBilinearPage(img, u, v) {
  const x = u * img.width - 0.5;
  const y = v * img.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const out = [0, 0, 0, 0];
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const sx = clampInt(x0 + i, 0, img.width - 1);
      const sy = clampInt(y0 + j, 0, img.height - 1);
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      if (w === 0) continue;
      const si = (sy * img.width + sx) * 4;
      out[0] += img.data[si] * w;
      out[1] += img.data[si + 1] * w;
      out[2] += img.data[si + 2] * w;
      out[3] += img.data[si + 3] * w;
    }
  }
  return out.map((c) => clampInt(Math.round(c), 0, 255));
}

function tileAtLevel(page, tileId, level) {
  const lv = page.levels[level];
  if (!lv) return null;
  return lv.rects.find((r) => r.id === tileId) ?? null;
}

function probeLocalGrid(rect) {
  const us = [0, 0.5 / rect.w, 1 / rect.w, 0.5, 1 - 1 / rect.w, 1 - 0.5 / rect.w, 1];
  const vs = [0, 0.5 / rect.h, 1 / rect.h, 0.5, 1 - 1 / rect.h, 1 - 0.5 / rect.h, 1];
  const set = new Map();
  for (const u of us) for (const v of vs) set.set(`${u.toFixed(6)},${v.toFixed(6)}`, { u, v });
  return [...set.values()];
}

function probeTilePair(gPage, gTile, nPage, nTile, level) {
  const gLevel = gPage.levels[level];
  const nLevel = nPage.levels[level];
  if (!gLevel || !nLevel || !gTile || !nTile) return null;
  const probes = [];
  let maxRgb = 0;
  let maxA = 0;
  let sumRgb = 0;
  let sumA = 0;
  let over = 0;
  const local = probeLocalGrid(gTile);
  for (const { u, v } of local) {
    const gU = (gTile.x + u * gTile.w) / gLevel.width;
    const gV = (gTile.y + v * gTile.h) / gLevel.height;
    const nU = (nTile.x + u * nTile.w) / nLevel.width;
    const nV = (nTile.y + v * nTile.h) / nLevel.height;
    const g = sampleBilinearPage(gLevel.image, gU, gV);
    const n = sampleBilinearPage(nLevel.image, nU, nV);
    const diff = premulDiff(n, 0, g, 0);
    const rgb = Math.max(diff.r, diff.g, diff.b);
    const a = diff.a;
    probes.push({ u, v, guarded: g, naive: n, delta: { r: diff.r, g: diff.g, b: diff.b, a } });
    maxRgb = Math.max(maxRgb, rgb);
    maxA = Math.max(maxA, a);
    sumRgb += rgb;
    sumA += a;
    if (rgb > 8 || a > 8) over++;
  }
  return {
    probes,
    maxRgb,
    maxA,
    meanRgb: sumRgb / probes.length,
    meanA: sumA / probes.length,
    contaminated: over,
    total: probes.length,
  };
}

// Compare the naive whole-atlas mips against the per-tile mip-safe reference at
// the same local UV positions. All numbers come from generated pixels.
export function analyzeContamination(guarded, naive, level) {
  const results = [];
  for (const gPage of guarded.pages) {
    const nPage = naive.pages.find((p) => p.placements.some((pl) => gPage.placements.some((gp) => gp.id === pl.id)));
    if (!nPage) continue;
    for (const gTile of gPage.placements) {
      const nTile = nPage.placements.find((p) => p.id === gTile.id);
      if (!nTile) continue;
      const r = probeTilePair(gPage, gTile, nPage, nTile, level);
      if (r) results.push({ id: gTile.id, page: gPage.index, ...r });
    }
  }
  return results;
}

export function buildAtlas(items, options = {}) {
  const opts = normalizeOptions(options);
  validateItems(items);

  const guardedPlan = planPages(items, { ...opts, mode: 'guarded' });
  const guarded = buildMode(items, guardedPlan, opts, 'guarded');

  // Naive comparison atlas uses no padding and whole-page filtering. It is a
  // diagnostic artifact, not part of the deliverable or budget.
  const naivePlan = planPages(items, { ...opts, mode: 'naive', allowRotation: true });
  const naive = buildMode(items, naivePlan, { ...opts, padding: 0 }, 'naive');

  const totalBytes = guarded.pages.reduce(
    (sum, p) => sum + p.levels.reduce((s, l) => s + l.width * l.height * 4, 0),
    0,
  );
  const baseBytes = guarded.pages.reduce((sum, p) => sum + p.width * p.height * 4, 0);
  const levelBytes = totalBytes - baseBytes;

  const warnings = [];
  if (guardedPlan.split) {
    warnings.push({
      code: 'SPLIT_ATLAS',
      message: `单页 ${opts.pageLimit}px 放不下全部图块，已拆分为 ${guarded.pages.length} 页（未缩小任何图块）`,
      pages: guarded.pages.length,
    });
  }
  const smallest = items.reduce((m, it) => Math.min(m, it.image.width, it.image.height), Infinity);
  if (guarded.safeLod < 3) {
    warnings.push({
      code: 'LOW_SAFE_LOD',
      message: `安全 mip 上限仅 ${guarded.safeLod}，远距观察请增大 padding 或缩小图块数量`,
      safeLod: guarded.safeLod,
    });
  }

  if (totalBytes > opts.budgetBytes) {
    throw new AtlasError(
      'BUDGET_EXCEEDED',
      `纹理预算超限：需要 ${(totalBytes / 1048576).toFixed(2)} MiB，预算 ${(opts.budgetBytes / 1048576).toFixed(2)} MiB。已停止，未缩小任何图块。可提高预算或减少图块。`,
      {
        requiredBytes: totalBytes,
        budgetBytes: opts.budgetBytes,
        requiredMiB: totalBytes / 1048576,
        budgetMiB: opts.budgetBytes / 1048576,
        baseBytes,
        levelBytes,
        pages: guarded.pages.length,
      },
    );
  }

  // UV + rect metadata is computed from level 0; per-level rects are recorded
  // for diagnostics and for engines that page through mip atlases manually.
  const tiles = [];
  for (const page of guarded.pages) {
    for (const p of page.placements) {
      const inv = invertAffine(p.uvTransform);
      const uv = {
        x: p.x / page.width,
        y: p.y / page.height,
        w: p.w / page.width,
        h: p.h / page.height,
      };
      const paddedUv = {
        x: (p.x - guarded.pad) / page.width,
        y: (p.y - guarded.pad) / page.height,
        w: (p.w + guarded.pad * 2) / page.width,
        h: (p.h + guarded.pad * 2) / page.height,
      };
      const levels = page.levels.map((lv) => {
        const r = lv.rects.find((rr) => rr.id === p.id);
        const levelTransform = r
          ? affineFromRotation({
              x: r.x,
              y: r.y,
              w: r.w,
              h: r.h,
              pageW: lv.width,
              pageH: lv.height,
              rotationDeg: p.rotationDeg,
            })
          : null;
        return {
          level: lv.level,
          width: lv.width,
          height: lv.height,
          x: r?.x ?? null,
          y: r?.y ?? null,
          w: r?.w ?? null,
          h: r?.h ?? null,
          uvTransform: levelTransform,
          inverseUvTransform: levelTransform ? invertAffine(levelTransform) : null,
        };
      });
      tiles.push({
        id: p.id,
        name: items.find((it) => it.id === p.id)?.name ?? p.id,
        pageIndex: page.index,
        pageId: page.id,
        sourceWidth: p.sourceWidth,
        sourceHeight: p.sourceHeight,
        atlasCore: { x: p.x, y: p.y, w: p.w, h: p.h },
        atlasPadded: {
          x: p.x - guarded.pad,
          y: p.y - guarded.pad,
          w: p.w + guarded.pad * 2,
          h: p.h + guarded.pad * 2,
        },
        uv,
        paddedUv,
        rotationDeg: p.rotationDeg,
        rotated: p.rotated,
        uvTransform: p.uvTransform,
        inverseUvTransform: inv,
        opaqueBounds: p.opaqueBounds,
        opaqueBoundsInAtlas: p.opaqueBoundsInAtlas,
        levels,
      });
    }
  }
  tiles.sort((a, b) => items.findIndex((it) => it.id === a.id) - items.findIndex((it) => it.id === b.id));

  const compareMaxLevel = Math.min(guarded.safeLod, naive.pages.reduce((m, p) => Math.min(m, p.levels.length - 1), Infinity));
  // Level 2 shows neighbours clearly while still exposing mip bleed. Deeper
  // levels are checked by selfCheckLevel, but their neighbourhoods collapse.
  const contaminationLevel = Math.max(0, Math.min(compareMaxLevel, 2));
  const contamination = analyzeContamination(guarded, naive, contaminationLevel);

  const diagnostics = {
    safeLod: guarded.safeLod,
    compareMaxLevel,
    contaminationLevel,
    contamination,
    totalBytes,
    baseBytes,
    levelBytes,
    budgetBytes: opts.budgetBytes,
    budgetUsedRatio: totalBytes / opts.budgetBytes,
    paddingTexels: guarded.pad,
    pageCount: guarded.pages.length,
    split: guardedPlan.split,
    overheadRatio: baseBytes / Math.max(1, items.reduce((s, it) => s + it.image.width * it.image.height * 4, 0)),
    naiveBytes: naive.pages.reduce(
      (sum, p) => sum + p.levels.reduce((s, l) => s + l.width * l.height * 4, 0),
      0,
    ),
    warnings,
    mipStopReasons: Object.fromEntries(
      guarded.pages.map((p) => [p.id, p.stopReason ?? (p.levels.length > opts.maxLevel ? 'max-level' : 'level-min-size')]),
    ),
  };

  return {
    options: opts,
    items: items.map((it) => ({
      id: it.id,
      name: it.name ?? it.id,
      width: it.image.width,
      height: it.image.height,
      opaqueBounds: alphaBounds(it.image, 0),
    })),
    guarded,
    naive,
    tiles,
    diagnostics,
  };
}

// Manifest is intentionally renderer-agnostic and contains everything needed
// to load the delivered PNGs without this code: page/level files, sampler
// state, per-tile rects, rotation, UV matrix and its inverse.
export function makeManifest(atlas, fileFor) {
  const files = fileFor ?? ((pageIndex, level) => `atlas_p${pageIndex}_l${level}.png`);
  return {
    format: 'exhibit-atlas',
    version: 1,
    generatedAt: new Date().toISOString(),
    sampler: {
      wrapS: 'CLAMP_TO_EDGE',
      wrapT: 'CLAMP_TO_EDGE',
      magFilter: 'LINEAR',
      minFilter: 'LINEAR_MIPMAP_LINEAR',
      generateMipmaps: false,
      maxLevel: atlas.diagnostics.safeLod,
      note: '逐块生成 mip，切勿对整页调用 generateMipmap；远距采样不得超过 maxLevel。',
    },
    options: {
      padding: atlas.options.padding,
      pageLimit: atlas.options.pageLimit,
      budgetBytes: atlas.options.budgetBytes,
      budgetMiB: atlas.options.budgetBytes / 1048576,
      allowRotation: atlas.options.allowRotation,
    },
    budget: {
      totalBytes: atlas.diagnostics.totalBytes,
      baseBytes: atlas.diagnostics.baseBytes,
      mipBytes: atlas.diagnostics.levelBytes,
      limitBytes: atlas.diagnostics.budgetBytes,
    },
    diagnostics: {
      safeLod: atlas.diagnostics.safeLod,
      paddingTexels: atlas.diagnostics.paddingTexels,
      pageCount: atlas.diagnostics.pageCount,
      split: atlas.diagnostics.split,
      warnings: atlas.diagnostics.warnings,
    },
    pages: atlas.guarded.pages.map((page) => ({
      id: page.id,
      index: page.index,
      width: page.width,
      height: page.height,
      levels: page.levels.map((lv) => ({
        level: lv.level,
        width: lv.width,
        height: lv.height,
        file: files(page.index, lv.level),
        bytes: lv.width * lv.height * 4,
      })),
    })),
    tiles: atlas.tiles.map((t) => ({
      id: t.id,
      name: t.name,
      pageId: t.pageId,
      pageIndex: t.pageIndex,
      source: {
        width: t.sourceWidth,
        height: t.sourceHeight,
        opaqueBounds: t.opaqueBounds,
      },
      atlas: {
        core: t.atlasCore,
        padded: t.atlasPadded,
        opaqueBounds: t.opaqueBoundsInAtlas,
      },
      rotationDeg: t.rotationDeg,
      uv: t.uv,
      paddedUv: t.paddedUv,
      uvTransform: t.uvTransform,
      inverseUvTransform: t.inverseUvTransform,
      levels: t.levels,
    })),
  };
}

export function findTilePage(pages, tileId) {
  return pages.find((p) => p.placements.some((pl) => pl.id === tileId)) ?? null;
}

// Per-level source-uv -> atlas-uv transform for any tile on any page, using
// the actual rect at that level. Returns null when the level has no rect.
export function levelUvTransform(page, tileId, level) {
  const lv = page.levels[level];
  if (!lv) return null;
  const rect = lv.rects.find((r) => r.id === tileId);
  const placement = page.placements.find((p) => p.id === tileId);
  if (!rect || !placement) return null;
  const transform = affineFromRotation({
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    pageW: lv.width,
    pageH: lv.height,
    rotationDeg: placement.rotationDeg,
  });
  return { rect, transform, image: lv.image, level: lv };
}

export function sampleTileSource(atlas, tileId, u, v) {
  const tile = atlas.tiles.find((t) => t.id === tileId);
  if (!tile) throw new AtlasError('UNKNOWN_TILE', `未知图块 ${tileId}`);
  const m = tile.uvTransform;
  const [au, av] = mapPoint(m, u, v);
  const page = atlas.guarded.pages[tile.pageIndex];
  return { page, uv: [au, av], tile };
}

// Bilinear sample a tile at a given mip level via its level-specific UV
// transform, so rotation is applied consistently at every level.
export function sampleTileAtLevel(atlas, tileId, level, u, v) {
  const tile = atlas.tiles.find((t) => t.id === tileId);
  if (!tile) throw new AtlasError('UNKNOWN_TILE', `未知图块 ${tileId}`);
  const lv = tile.levels[level];
  if (!lv || !lv.uvTransform) return null;
  const page = atlas.guarded.pages[tile.pageIndex].levels[level];
  const m = lv.uvTransform;
  const au = m[0] * u + m[1] * v + m[2];
  const av = m[3] * u + m[4] * v + m[5];
  return sampleBilinearPage(page.image, au, av);
}

// Regression check owners are expected to run: at each level, every tile's
// correct content is its own level-0 core region resampled, NOT a resample of
// the whole page. Returns worst premultiplied delta per tile.
export function selfCheckLevel(atlas, level) {
  const out = [];
  for (const tile of atlas.tiles) {
    const page0 = atlas.guarded.pages[tile.pageIndex].levels[0];
    const lv = tile.levels[level];
    if (!lv || !lv.uvTransform) continue;
    const core = tile.atlasCore;
    const ref = resampleArea(page0.image, Math.max(1, lv.w), Math.max(1, lv.h), core);
    let max = 0;
    for (let y = 1; y < ref.height - 1; y += 3) {
      for (let x = 1; x < ref.width - 1; x += 3) {
        const u = (x + 0.5) / ref.width;
        const v = (y + 0.5) / ref.height;
        const got = sampleTileAtLevel(atlas, tile.id, level, u, v);
        if (!got) continue;
        const ri = (y * ref.width + x) * 4;
        const d = premulDiff(ref.data, ri, got, 0);
        max = Math.max(max, d.r, d.g, d.b, d.a);
      }
    }
    out.push({ id: tile.id, level, maxDelta: max });
  }
  return out;
}
