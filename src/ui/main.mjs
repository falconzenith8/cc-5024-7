import { createImage, compositeOverChecker, cropImage, resampleArea, rotate90, alphaBounds } from '../core/rgba.mjs';
import { buildAtlas, makeManifest, AtlasError, levelUvTransform, findTilePage } from '../core/atlas.mjs';
import { sampleBilinearPage } from '../core/atlas.mjs';
import { decodePng, encodePng, downloadBlob } from './png.mjs';
import { createZip } from './zip.mjs';
import { WallRenderer } from './renderer.mjs';

const SAMPLE_SOURCES = ['poster', 'banner', 'stamp', 'placard', 'plate', 'label'];
const state = {
  items: [],
  atlas: null,
  selectedId: null,
  viewMode: 0,
  alphaView: false,
  lodManual: -1,
  bias: 0,
  atlasLevel: 0,
  previewLevel: 0,
  previewZoom: 1,
  options: { padding: 16, pageLimit: 1024, budgetBytes: 16 * 1048576, allowRotation: true },
  pageIndex: 0,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let renderer = null;

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), isError ? 5200 : 2800);
}

function showError(err) {
  const dialog = $('#error-dialog');
  $('#error-message').textContent = err.message;
  $('#error-details').textContent = err.details ? JSON.stringify(err.details, null, 2) : '';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else toast(err.message, true);
}

function fmtBytes(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

async function loadSampleItems() {
  const items = [];
  for (const id of SAMPLE_SOURCES) {
    const res = await fetch(`./assets/sources/${id}.png`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`无法加载示例素材 ${id}.png（${res.status}）`);
    const img = await decodePng(await res.blob());
    items.push({ id, name: `${id}.png`, image: img });
  }
  return items;
}

function newItemId(base, existing) {
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  existing.add(id);
  return id;
}

function drawImageToCanvas(canvas, image, { checker = true, cell = 12, fit = true } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cw = canvas.width;
  const ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);
  if (checker) {
    const bg = ctx.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const light = (((x / cell) | 0) + ((y / cell) | 0)) % 2 === 0;
        const v = light ? 52 : 34;
        const i = (y * cw + x) * 4;
        bg.data[i] = v;
        bg.data[i + 1] = v + 3;
        bg.data[i + 2] = v + 7;
        bg.data[i + 3] = 255;
      }
    }
    ctx.putImageData(bg, 0, 0);
  }
  const scale = fit ? Math.min(cw / image.width, ch / image.height) : 1;
  const dw = Math.max(1, Math.round(image.width * scale));
  const dh = Math.max(1, Math.round(image.height * scale));
  const dx = Math.floor((cw - dw) / 2);
  const dy = Math.floor((ch - dh) / 2);
  const tmp = document.createElement('canvas');
  tmp.width = image.width;
  tmp.height = image.height;
  const tctx = tmp.getContext('2d');
  const id = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  tctx.putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, dx, dy, dw, dh);
}

function renderTileList() {
  const list = $('#tile-list');
  list.innerHTML = '';
  const audit = contaminationById();
  for (const item of state.items) {
    const tile = state.atlas?.tiles.find((t) => t.id === item.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `tile-card${state.selectedId === item.id ? ' active' : ''}`;
    card.dataset.id = item.id;
    const thumb = document.createElement('canvas');
    thumb.width = 38 * Math.min(2, window.devicePixelRatio || 1);
    thumb.height = thumb.width;
    drawImageToCanvas(thumb, item.image, { checker: true, cell: 8 });
    const meta = document.createElement('div');
    meta.className = 'meta';
    const strong = document.createElement('strong');
    strong.textContent = item.name;
    const span = document.createElement('span');
    span.textContent = `${item.image.width}×${item.image.height} px`;
    meta.append(strong, span);
    card.append(thumb, meta);
    if (tile) {
      const badge = document.createElement('span');
      const c = audit.get(item.id);
      if (tile.rotationDeg === 90) {
        badge.className = 'badge rot';
        badge.textContent = c ? `90° · ${c.contaminated}/${c.total}` : '旋转 90°';
      } else {
        badge.className = `badge${c && c.contaminated > 0 ? ' warn' : ''}`;
        badge.textContent = c ? `污染 ${c.contaminated}/${c.total}` : '已打包';
      }
      card.append(badge);
    }
    card.addEventListener('click', () => selectTile(item.id, true));
    list.append(card);
  }
}

function contaminationById() {
  const map = new Map();
  if (!state.atlas) return map;
  for (const c of state.atlas.diagnostics.contamination) map.set(c.id, c);
  return map;
}

function selectTile(id, syncView = false) {
  state.selectedId = id;
  renderer?.setSelected(id);
  renderTileList();
  renderSelectedPanel();
  renderContamTable();
  if (syncView) focusWallOnTile(id);
}

function focusWallOnTile(id) {
  if (!renderer) return;
  const t = renderer.tiles.find((x) => x.id === id);
  if (!t) return;
  // Frame the tile's larger side at ~85% of the viewport, using the same fov
  // and aspect the renderer uses, so selecting a tile never crops it.
  const canvas = renderer.canvas;
  const aspect = Math.max(0.5, canvas.width / Math.max(1, canvas.height));
  const vFov = (renderer.camera.fov * Math.PI) / 180;
  const need = Math.max(t.w / (Math.tan(vFov / 2) * aspect), t.h / Math.tan(vFov / 2));
  renderer.camera.distance = Math.max(1.1, (need * 1.35) / 2);
  renderer.camera.yaw = 0.1;
  renderer.camera.pitch = 0.08;
  renderer.camera.target = { x: t.model[12], y: t.model[13], z: 0 };
  renderer.selectedId = id;
  renderer.dirty = true;
}

function renderSelectedPanel() {
  const id = state.selectedId;
  const tile = state.atlas?.tiles.find((t) => t.id === id);
  const item = state.items.find((it) => it.id === id);
  $('#sel-id').textContent = id ?? '—';
  if (!tile || !item) return;

  drawImageToCanvas($('#source-canvas'), item.image, { checker: true, cell: 14 });
  renderPreview();
  renderMetaTable(tile, item);
}

function renderPreview() {
  const id = state.selectedId;
  const tile = state.atlas?.tiles.find((t) => t.id === id);
  if (!tile) return;
  const canvas = $('#preview-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cw = canvas.width;
  const ch = canvas.height;
  const page = state.atlas.guarded.pages[tile.pageIndex];
  const levelCount = tile.levels.filter((l) => l.x !== null).length;
  const levelIndex = Math.max(0, Math.min(state.previewLevel, levelCount - 1));
  const info = levelUvTransform(page, tile.id, levelIndex);
  if (!info) return;
  const img = ctx.createImageData(cw, ch);
  const bgCell = 13;
  const zoom = state.previewZoom;
  const m = info.transform;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const u = 0.5 + ((x + 0.5) / cw - 0.5) / zoom;
      const v = 0.5 + ((y + 0.5) / ch - 0.5) / zoom;
      const au = m[0] * u + m[1] * v + m[2];
      const av = m[3] * u + m[4] * v + m[5];
      const c = sampleBilinearPage(info.image, au, av);
      const di = (y * cw + x) * 4;
      if (u < 0 || u > 1 || v < 0 || v > 1) {
        img.data[di] = 20;
        img.data[di + 1] = 22;
        img.data[di + 2] = 28;
        img.data[di + 3] = 255;
        continue;
      }
      img.data[di] = c[0];
      img.data[di + 1] = c[1];
      img.data[di + 2] = c[2];
      img.data[di + 3] = 255;
      if (c[3] < 255) {
        const light = (((x / bgCell) | 0) + ((y / bgCell) | 0)) % 2 === 0;
        const bg = light ? 56 : 34;
        const a = c[3] / 255;
        img.data[di] = Math.round(c[0] * a + bg * (1 - a));
        img.data[di + 1] = Math.round(c[1] * a + (bg + 3) * (1 - a));
        img.data[di + 2] = Math.round(c[2] * a + (bg + 7) * (1 - a));
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  $('#preview-caption').textContent = `图集 L${levelIndex} · ${info.rect.w}×${info.rect.h} · ${zoom}×${tile.rotationDeg ? ' · 旋转还原' : ''}`;
  $('#preview-level-out').textContent = `L${levelIndex}`;
  const slider = $('#preview-level');
  slider.max = String(levelCount - 1);
}

function atlasLevelForPreview(tile) {
  const levels = tile.levels.filter((l) => l.x !== null);
  return levels[Math.max(0, Math.min(state.previewLevel, levels.length - 1))];
}

function renderMetaTable(tile, item) {
  const table = $('#tile-meta');
  const rows = [
    ['来源尺寸', `${tile.sourceWidth}×${tile.sourceHeight}`],
    ['图集核心', `x ${tile.atlasCore.x}, y ${tile.atlasCore.y}, ${tile.atlasCore.w}×${tile.atlasCore.h}`],
    ['含扩展区', `x ${tile.atlasPadded.x}, y ${tile.atlasPadded.y}, ${tile.atlasPadded.w}×${tile.atlasPadded.h}`],
    ['页', `${tile.pageId} @ ${tile.levels[0].width}px`],
    ['旋转', tile.rotationDeg ? `<span class="rot-tag">90° 顺时针</span>` : '无'],
    ['UV 矩形', `u ${tile.uv.x.toFixed(5)} · v ${tile.uv.y.toFixed(5)} · ${tile.uv.w.toFixed(5)}×${tile.uv.h.toFixed(5)}`],
    ['UV 3×3 矩阵', tile.uvTransform.map((n) => n.toFixed(6)).join(', ')],
    ['逆矩阵', tile.inverseUvTransform.map((n) => n.toFixed(6)).join(', ')],
    ['有效像素', tile.opaqueBounds ? `${tile.opaqueBounds.w}×${tile.opaqueBounds.h} @ (${tile.opaqueBounds.x},${tile.opaqueBounds.y})` : '全透明'],
    ['安全 LOD', `L${tile.levels.filter((l) => l.x !== null).length - 1}`],
  ];
  table.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  void item;
}

function renderLevelStrip() {
  const strip = $('#level-strip');
  strip.innerHTML = '';
  const page = state.atlas?.guarded.pages[state.pageIndex] ?? state.atlas?.guarded.pages[0];
  if (!page) return;
  for (const level of page.levels) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `level-pill${state.atlasLevel === level.level ? ' active' : ''}${level.level > state.atlas.diagnostics.safeLod ? ' muted' : ''}`;
    btn.textContent = `L${level.level} · ${level.width}px`;
    btn.addEventListener('click', () => {
      state.atlasLevel = level.level;
      renderLevelStrip();
      renderAtlasCanvas();
    });
    strip.append(btn);
  }
}

function renderPageTabs() {
  const wrap = $('#page-tabs');
  wrap.innerHTML = '';
  const pages = state.atlas?.guarded.pages ?? [];
  if (pages.length < 2) return;
  for (const page of pages) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `page-tab${state.pageIndex === page.index ? ' active' : ''}`;
    btn.textContent = `页 ${page.index + 1} · ${page.width}px · ${page.placements.length} 块`;
    btn.addEventListener('click', () => {
      state.pageIndex = page.index;
      if (renderer) renderer.setAtlas(state.atlas, page.index);
      renderLevelStrip();
      renderPageTabs();
      renderAtlasCanvas();
    });
    wrap.append(btn);
  }
}

function renderAtlasCanvas() {
  const canvas = $('#atlas-canvas');
  const page = state.atlas?.guarded.pages[state.pageIndex] ?? state.atlas?.guarded.pages[0];
  if (!page) return;
  const layout = arrangeAtlasLevel(page, state.atlasLevel);
  canvas.width = layout.width;
  canvas.height = layout.height;
  drawImageToCanvas(canvas, { width: layout.width, height: layout.height, data: layout.data }, { checker: false, fit: false });
  const note = $('#atlas-note');
  const level = page.levels.find((l) => l.level === state.atlasLevel);
  const next = page.levels.find((l) => l.level === state.atlasLevel + 1);
  const minCore = Math.min(...level.rects.flatMap((r) => [r.w, r.h]));
  const stop = state.atlas.diagnostics.mipStopReasons?.[page.id];
  const why = stop === 'padding-collision' ? '相邻扩展区重叠' : '图块小于 2px';
  const safe = state.atlas.diagnostics.safeLod;
  note.textContent = `L${state.atlasLevel} · 最小图块边 ${minCore}px · 安全上限 L${safe}（再缩一级${why}）。`;
}

// Build an RGBA image of the atlas at a level with explicit visual overlays:
// core rect, padded rect, and shared padding. Overlays are drawn only into the
// decoded copy for UI, never into the exported texture.
function arrangeAtlasLevel(page, levelIndex) {
  const level = page.levels.find((l) => l.level === levelIndex) ?? page.levels[0];
  const img = {
    width: level.width,
    height: level.height,
    data: new Uint8ClampedArray(level.image.data),
  };
  const ctx = document.createElement('canvas').getContext('2d');
  void ctx;
  const placed = page.placements;
  for (const p of placed) {
    const r = level.rects.find((rr) => rr.id === p.id);
    if (!r) continue;
    const pad = level.pad ?? Math.max(1, page.pad >> level.level);
    // tint the bleed ring
    for (let y = Math.max(0, r.y - pad); y < Math.min(level.height, r.y + r.h + pad); y++) {
      for (let x = Math.max(0, r.x - pad); x < Math.min(level.width, r.x + r.w + pad); x++) {
        const insideCore = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
        if (insideCore) continue;
        const i = (y * level.width + x) * 4;
        const mix = 0.35;
        img.data[i] = Math.round(img.data[i] * (1 - mix) + 110 * mix);
        img.data[i + 1] = Math.round(img.data[i + 1] * (1 - mix) + 128 * mix);
        img.data[i + 2] = Math.round(img.data[i + 2] * (1 - mix) + 160 * mix);
        img.data[i + 3] = Math.max(img.data[i + 3], 80);
      }
    }
    // 1px core outline
    const draw = (x, y) => {
      if (x < 0 || y < 0 || x >= level.width || y >= level.height) return;
      const i = (y * level.width + x) * 4;
      img.data[i] = 87;
      img.data[i + 1] = 217;
      img.data[i + 2] = 193;
      img.data[i + 3] = 255;
    };
    for (let x = r.x; x < r.x + r.w; x++) {
      draw(x, r.y);
      draw(x, r.y + r.h - 1);
    }
    for (let y = r.y; y < r.y + r.h; y++) {
      draw(r.x, y);
      draw(r.x + r.w - 1, y);
    }
  }
  return img;
}

function renderContamTable() {
  const wrap = $('#contam-table');
  wrap.innerHTML = '';
  const list = state.atlas?.diagnostics.contamination ?? [];
  const head = document.createElement('div');
  head.className = 'contam-row contam-head';
  head.innerHTML = '<span>图块</span><span class="n">ΔRGB</span><span class="n">Δα</span><span class="n">探针</span>';
  wrap.append(head);
  for (const c of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `contam-row${state.selectedId === c.id ? ' active' : ''}`;
    row.innerHTML = `
      <span class="id">${c.id}</span>
      <span class="n ${c.maxRgb > 8 ? 'bad' : 'good'}">${c.maxRgb.toFixed(0)}</span>
      <span class="n ${c.maxA > 8 ? 'bad' : 'good'}">${c.maxA.toFixed(0)}</span>
      <span class="n ${c.contaminated > 0 ? 'bad' : 'good'}">${c.contaminated}/${c.total}</span>`;
    row.addEventListener('click', () => selectTile(c.id, true));
    wrap.append(row);
  }
  renderSplice();
}

// Neighbourhood view: crops a fixed window of ATLAS space around the selected
// tile, so the pixels shown really include neighbouring exhibits, their edge
// extension rings and the shared gutter. Left = guarded chain, centre = naive
// whole-page chain, right = amplified difference of guarded vs naive sampling
// at the same atlas positions.
let spliceSignal = { maxDelta: 0, meanDelta: 0, probes: 0, contaminated: 0 };

function renderSplice() {
  const canvas = $('#splice-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tile = state.atlas?.tiles.find((t) => t.id === state.selectedId);
  if (!tile) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const edge = $('#edge-canvas');
    if (edge) edge.getContext('2d').clearRect(0, 0, edge.width, edge.height);
    spliceSignal = { maxDelta: 0, meanDelta: 0, probes: 0, contaminated: 0 };
    return;
  }
  const G = state.atlas.guarded.pages[tile.pageIndex];
  const N = state.atlas.naive.pages[0];
  const levelCount = tile.levels.filter((l) => l.x !== null).length;
  const level = Math.min(state.atlas.diagnostics.contaminationLevel, levelCount - 1);
  const gInfo = levelUvTransform(G, tile.id, level);
  const nInfo = levelUvTransform(N, tile.id, level);
  if (!gInfo || !nInfo) return;

  // Fixed atlas-space window: 1.7 x the tile core, clamped to the page.
  const gw = G.levels[level].width;
  const gh = G.levels[level].height;
  const nw = N.levels[level].width;
  const nh = N.levels[level].height;
  const winW = Math.min(gw, Math.round(gInfo.rect.w * 1.7));
  const winH = Math.min(gh, Math.round(gInfo.rect.h * 1.7));
  const gx0 = Math.max(0, Math.min(gw - winW, Math.round(gInfo.rect.x + gInfo.rect.w / 2 - winW / 2)));
  const gy0 = Math.max(0, Math.min(gh - winH, Math.round(gInfo.rect.y + gInfo.rect.h / 2 - winH / 2)));
  const nx0 = Math.round((gx0 / gw) * nw);
  const ny0 = Math.round((gy0 / gh) * nh);

  const W = canvas.width;
  const H = canvas.height;
  const gutter = 10;
  const panelW = Math.floor((W - gutter * 4) / 3);
  const panelH = H - 34;
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, W, H);

  const sampleAt = (image, x, y) =>
    sampleBilinearPage(image, (x - 0.5) / image.width, (y - 0.5) / image.height);
  const composite = (c, px, py) => {
    if (c[3] >= 250) return [c[0], c[1], c[2]];
    const light = (((px / 9) | 0) + ((py / 9) | 0)) % 2 === 0;
    const bg = light ? 58 : 36;
    const a = c[3] / 255;
    return [
      Math.round(c[0] * a + bg * (1 - a)),
      Math.round(c[1] * a + (bg + 4) * (1 - a)),
      Math.round(c[2] * a + (bg + 9) * (1 - a)),
    ];
  };

  let maxDelta = 0;
  let sumDelta = 0;
  let probes = 0;
  let contaminated = 0;
  // Only probes whose guarded and naive pixels cover the same source region are
  // comparable: the tile core, mapped through the level transform.
  const coreX0 = gInfo.rect.x;
  const coreY0 = gInfo.rect.y;
  const coreX1 = coreX0 + gInfo.rect.w;
  const coreY1 = coreY0 + gInfo.rect.h;

  const drawPanel = (index, title, color, fn) => {
    const x0 = gutter + index * (panelW + gutter);
    const id = ctx.createImageData(panelW, panelH);
    for (let py = 0; py < panelH; py++) {
      for (let px = 0; px < panelW; px++) {
        const out = fn(px, py);
        const di = (py * panelW + px) * 4;
        id.data[di] = out[0];
        id.data[di + 1] = out[1];
        id.data[di + 2] = out[2];
        id.data[di + 3] = 255;
      }
    }
    ctx.putImageData(id, x0, 22);
    ctx.fillStyle = color;
    ctx.font = '600 11px "Noto Sans SC", ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(title, x0, 15);
    const sx = (coreX0 - gx0) / winW;
    const sy = (coreY0 - gy0) / winH;
    const sw = (coreX1 - coreX0) / winW;
    const sh = (coreY1 - coreY0) / winH;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      x0 + sx * panelW + 0.5,
      22 + sy * panelH + 0.5,
      sw * panelW - 1,
      sh * panelH - 1,
    );
    ctx.globalAlpha = 1;
  };

  const gxOf = (px) => gx0 + (px / (panelW - 1)) * winW;
  const gyOf = (py) => gy0 + (py / (panelH - 1)) * winH;

  drawPanel(0, `守护 mip · 图集邻区 L${level}`, '#57d9c1', (px, py) => {
    return composite(sampleAt(G.levels[level].image, gxOf(px), gyOf(py)), px, py);
  });
  drawPanel(1, `整页滤波 · 同一邻区 L${level}`, '#ff6b6b', (px, py) => {
    const x = nx0 + (px / (panelW - 1)) * (winW * (nw / gw));
    const y = ny0 + (py / (panelH - 1)) * (winH * (nh / gh));
    return composite(sampleAt(N.levels[level].image, x, y), px, py);
  });
  // Content-aligned comparison: a guarded pixel inside the core is mapped to
  // source uv through the guarded level transform, then to atlas uv through the
  // naive level transform. Both transforms carry the tile's rotation, so the
  // two samples cover the same exhibit texel even though the layouts differ.
  const gInv = invertAffineLocal(gInfo.transform);
  const nFwd = nInfo.transform;
  const sampleNaiveOfGuarded = (gx, gy, ox = 0, oy = 0) => {
    const au = (gx + ox - 0.5) / G.levels[level].width;
    const av = (gy + oy - 0.5) / G.levels[level].height;
    const u = gInv[0] * au + gInv[1] * av + gInv[2];
    const v = gInv[3] * au + gInv[4] * av + gInv[5];
    const nu = nFwd[0] * u + nFwd[1] * v + nFwd[2];
    const nv = nFwd[3] * u + nFwd[4] * v + nFwd[5];
    return sampleBilinearPage(N.levels[level].image, nu, nv);
  };
  drawPanel(2, '采样差异 ×4', '#ffd166', (px, py) => {
    const gx = gxOf(px);
    const gy = gyOf(py);
    const insideCore = gx >= coreX0 && gx < coreX1 && gy >= coreY0 && gy < coreY1;
    const cg = sampleAt(G.levels[level].image, gx, gy);
    if (!insideCore) {
      return [Math.round(cg[0] * 0.24), Math.round(cg[1] * 0.24), Math.round(cg[2] * 0.24)];
    }
    const cn = sampleNaiveOfGuarded(gx, gy);
    const ga = cg[3] / 255;
    const na = cn[3] / 255;
    const dr = Math.abs(cg[0] * ga - cn[0] * na);
    const dg = Math.abs(cg[1] * ga - cn[1] * na);
    const db = Math.abs(cg[2] * ga - cn[2] * na);
    const da = Math.abs(cg[3] - cn[3]);
    const delta = Math.max(dr, dg, db, da);
    probes++;
    sumDelta += delta;
    maxDelta = Math.max(maxDelta, delta);
    if (delta > 8) contaminated++;
    const k = Math.min(1, delta / 64);
    return [
      Math.round(18 + 237 * k),
      Math.round(16 + 120 * k * k),
      Math.round(20 + 30 * k * k),
    ];
  });

  // Boundary profile: re-sample the left and top edges of the core at the
  // level-0 atlas for a fixed number of source texels. Each output cell shows
  // the real bilinear result, so a naive atlas shows a neighbour-coloured band
  // where the guarded one shows its own bleed ring.
  drawEdgeProfile(tile, G, N);

  spliceSignal = {
    maxDelta,
    meanDelta: probes ? sumDelta / probes : 0,
    probes,
    contaminated,
    level,
    edgeProfile: spliceSignal.edgeProfile,
    window: { x: gx0, y: gy0, w: winW, h: winH },
    neighbours: G.placements.filter((p) => p.id !== tile.id).filter((p) => {
      const r = G.levels[level].rects.find((rr) => rr.id === p.id);
      if (!r) return false;
      return r.x < gx0 + winW && r.x + r.w > gx0 && r.y < gy0 + winH && r.y + r.h > gy0;
    }).map((p) => p.id),
  };
  const readout = $('#probe-readout');
  if (readout) {
    const n = spliceSignal.neighbours.length;
    readout.textContent = `${tile.id} · 邻区 L${level} · 含 ${n} 个相邻图块 · 核心差异 ${maxDelta.toFixed(0)} · 污染 ${contaminated}/${probes}`;
  }
}


// Boundary profile: pick the core edge that actually has a neighbouring tile in
// the naive atlas (the atlas places tiles differently), then sample BOTH chains
// at the same texel offsets across that edge at mip level L. Outside the core
// the guarded chain reads its own edge extension, the naive chain reads the
// neighbour's filtered pixels, so the contamination band is measured, not drawn
// from constants.
function drawEdgeProfile(tile, G, N) {
  const canvas = $('#edge-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, W, H);
  const heading = $('#edge-title');
  spliceSignal.edgeProfile = null;

  const maxLevel = Math.min(G.levels.length, N.levels.length) - 1;
  const level = Math.max(0, Math.min(maxLevel, state.atlas.diagnostics.contaminationLevel));
  const gRect = G.levels[level]?.rects.find((r) => r.id === tile.id);
  const nRect = N.levels[level]?.rects.find((r) => r.id === tile.id);
  if (!gRect || !nRect) {
    if (heading) heading.textContent = '边界剖面 · 当前图块在此层级无对应矩形';
    return;
  }

  // Distance from each core edge of the naive tile to the nearest other tile,
  // measured in level-L texels. The smallest one is the edge that genuinely
  // abuts a neighbour and therefore shows filtering contamination.
  const others = N.levels[level].rects.filter((r) => r.id !== tile.id);
  const gap = (side) => {
    let best = { d: Infinity, id: null };
    for (const r of others) {
      const oy = r.y < nRect.y + nRect.h && r.y + r.h > nRect.y;
      const ox = r.x < nRect.x + nRect.w && r.x + r.w > nRect.x;
      let d = Infinity;
      if (side === 'left' && oy) d = nRect.x - (r.x + r.w);
      else if (side === 'right' && oy) d = r.x - (nRect.x + nRect.w);
      else if (side === 'top' && ox) d = nRect.y - (r.y + r.h);
      else if (side === 'bottom' && ox) d = r.y - (nRect.y + nRect.h);
      if (d >= 0 && d < best.d) best = { d, id: r.id };
    }
    return best;
  };
  const sides = ['left', 'right', 'top', 'bottom']
    .map((s) => ({ side: s, ...gap(s) }))
    .sort((a, b) => a.d - b.d);
  const { side, id: neighbour, d: sideGap } = sides[0];
  const sideName = { left: '左', right: '右', top: '上', bottom: '下' }[side];
  // Only the guarded bleed ring is meaningful outside the core; beyond it the
  // atlas gutter is shared with unrelated tiles. Span the ring exactly.
  const ringTexels = G.levels[level].pad ?? Math.max(1, G.pad >> level);
  const span = Math.max(2, Math.min(8, ringTexels));
  const label = neighbour
    ? `${sideName}边缘 · 邻接 ${neighbour}${sideGap === 0 ? '' : `（间隔 ${sideGap}）`} · 扩色带 ${ringTexels} texel`
    : `${sideName}边缘 · 无相邻图块 · 扩色带 ${ringTexels} texel`;

  if (heading) {
    heading.textContent = `边界剖面 · ${label} · L${level} · ±${span} texel（±${span << level} 源像素）`;
  }

  const bandH = 38;
  const alphaH = 7;
  const y1 = 13;
  const y2 = y1 + bandH + 2 + alphaH + 13;
  const composite = (c) => {
    const a = c[3] / 255;
    return [
      Math.round(c[0] * a + 26 * (1 - a)),
      Math.round(c[1] * a + 30 * (1 - a)),
      Math.round(c[2] * a + 38 * (1 - a)),
    ];
  };

  const drawRow = (img, rect, yBand, yAlpha) => {
    const band = ctx.createImageData(W, bandH);
    const alpha = ctx.createImageData(W, alphaH);
    const midX = rect.x + rect.w / 2;
    const midY = rect.y + rect.h / 2;
    for (let px = 0; px < W; px++) {
      const t = px / (W - 1);
      // Display runs outside -> inside; dOut is signed distance outward from the
      // core edge in level-texel units.
      const dOut = span - t * span * 2;
      let x = midX;
      let y = midY;
      if (side === 'left') x = rect.x - dOut;
      else if (side === 'right') x = rect.x + rect.w + dOut;
      else if (side === 'top') y = rect.y - dOut;
      else y = rect.y + rect.h + dOut;
      const c = sampleBilinearPage(img, (x + 0.5) / img.width, (y + 0.5) / img.height);
      const [r, g, b] = composite(c);
      for (let py = 0; py < bandH; py++) {
        const di = (py * W + px) * 4;
        band.data[di] = r;
        band.data[di + 1] = g;
        band.data[di + 2] = b;
        band.data[di + 3] = 255;
      }
      for (let py = 0; py < alphaH; py++) {
        const di = (py * W + px) * 4;
        alpha.data[di] = c[3];
        alpha.data[di + 1] = c[3];
        alpha.data[di + 2] = c[3];
        alpha.data[di + 3] = 255;
      }
    }
    ctx.putImageData(band, 0, yBand);
    ctx.putImageData(alpha, 0, yAlpha);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeRect(0.5, yBand + 0.5, W - 1, bandH - 1);
  };

  const titleY = y1 - 4;
  ctx.font = '600 10px "Noto Sans SC", ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#57d9c1';
  ctx.fillText('逐块 mip · 边缘扩色', 4, titleY);
  ctx.fillStyle = '#94a0b4';
  ctx.textAlign = 'right';
  ctx.fillText(label, W - 2, titleY);
  ctx.textAlign = 'left';
  drawRow(G.levels[level].image, gRect, y1, y1 + bandH + 2);

  const y2Title = y2 - 4;
  ctx.fillStyle = '#ff6b6b';
  ctx.fillText('整页滤波 · 邻图渗入', 4, y2Title);
  ctx.fillStyle = '#94a0b4';
  ctx.textAlign = 'right';
  ctx.fillText('同一源像素行（内容对齐）', W - 2, y2Title);
  ctx.textAlign = 'left';
  drawRow(N.levels[level].image, nRect, y2, y2 + bandH + 2);

  // Core edge marker at dOut = 0.
  const zeroX = (span / (span * 2)) * (W - 1);
  const yTop = y1 - 2;
  const yBottom = y2 + bandH + 2 + alphaH;
  ctx.strokeStyle = '#ffd166';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(zeroX, yTop);
  ctx.lineTo(zeroX, yBottom);
  ctx.stroke();
  ctx.setLineDash([]);

  // Ticks: outside -> edge -> inside, in level texels.
  const tickY = yBottom + 4;
  ctx.fillStyle = '#94a0b4';
  ctx.font = '9px "Noto Sans SC", ui-sans-serif, system-ui, sans-serif';
  for (const off of [-span, -span / 2, 0, span / 2, span]) {
    const t = (span - off) / (span * 2);
    const x = t * (W - 1);
    ctx.strokeStyle = off === 0 ? '#ffd166' : '#3a4556';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, tickY);
    ctx.lineTo(x + 0.5, tickY + 4);
    ctx.stroke();
    const text = off === 0 ? '边界' : `${off > 0 ? '外' : '内'} ${Math.abs(off)}`;
    ctx.textAlign = off === 0 ? 'center' : off > 0 ? 'left' : 'right';
    const tx = off === 0 ? x : off > 0 ? x + 2 : x - 2;
    ctx.fillStyle = off === 0 ? '#ffd166' : '#94a0b4';
    ctx.fillText(text, tx, tickY + 14);
  }
  ctx.textAlign = 'left';
  spliceSignal.edgeProfile = { side, level, neighbour, span, gap: sideGap };
}

function invertAffineLocal(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  return [ia, ib, (b * f - e * c) / det, id, ie, (d * c - a * f) / det];
}

function renderDiagnostics() {
  const wrap = $('#diag-list');
  wrap.innerHTML = '';
  if (!state.atlas) return;
  const d = state.atlas.diagnostics;
  const items = [
    ['纹理占用', `${fmtBytes(d.totalBytes)} / ${fmtBytes(d.budgetBytes)}（${(d.budgetUsedRatio * 100).toFixed(1)}%）`, d.budgetUsedRatio > 1 ? 'bad' : ''],
    ['基础层 / mip 增量', `${fmtBytes(d.baseBytes)} / ${fmtBytes(d.levelBytes)}`, ''],
    ['页数与拆分', `${d.pageCount} 页${d.split ? '（已拆分，图块未缩小）' : '（单页）'}`, d.split ? 'warn' : ''],
    ['安全 mip 上限', `L${d.safeLod}（继续缩小会丢失有效内容）`, d.safeLod < 3 ? 'warn' : ''],
    ['图块面积开销', `${(d.overheadRatio * 100).toFixed(0)}%（含扩展与留白）`, ''],
    ['朴素整页滤波占用', `${fmtBytes(d.naiveBytes)}（反例，含深层 mip）`, ''],
  ];
  for (const [label, value, cls] of items) {
    const el = document.createElement('div');
    el.className = `diag-item ${cls}`;
    el.innerHTML = `<strong>${label}</strong>${value}`;
    wrap.append(el);
  }
  for (const w of d.warnings) {
    const el = document.createElement('div');
    el.className = 'diag-item warn';
    el.innerHTML = `<strong>${w.code}</strong>${w.message}`;
    wrap.append(el);
  }
}

function updateTopStats() {
  if (!state.atlas) return;
  const d = state.atlas.diagnostics;
  $('#stat-bytes').textContent = fmtBytes(d.totalBytes);
  $('#stat-budget').textContent = `预算 ${fmtBytes(d.budgetBytes)}`;
  $('#stat-pages').textContent = `${d.pageCount} 页`;
  $('#stat-lod').textContent = `安全 L${d.safeLod}`;
  $('#stat-tiles').textContent = `${state.atlas.tiles.length} 块`;
  const rot = state.atlas.tiles.filter((t) => t.rotated).length;
  $('#stat-rotated').textContent = `${rot} 旋转 · ${state.atlas.tiles.length - rot} 正交`;
}

function makeUiAtlas(atlas, blobCache) {
  void blobCache;
  return atlas;
}

async function rebuild({ silent = false } = {}) {
  const btn = $('#btn-rebuild');
  btn.disabled = true;
  const note = $('#build-note');
  note.textContent = '构建中…';
  await new Promise((r) => setTimeout(r, 20));
  try {
    const atlas = buildAtlas(state.items, state.options);
    state.atlas = makeUiAtlas(atlas);
    state.atlasLevel = 0;
    if (state.pageIndex >= atlas.guarded.pages.length) state.pageIndex = 0;
    if (!state.selectedId || !state.items.some((it) => it.id === state.selectedId)) {
      state.selectedId = state.items[0]?.id ?? null;
    }
    const pageIndex = Math.min(state.pageIndex, state.atlas.guarded.pages.length - 1);
    state.pageIndex = pageIndex;
    ensureRenderer();
    if (renderer) {
      renderer.setSelected(state.selectedId);
      renderer.setAtlas(state.atlas, pageIndex);
      renderer.camera = defaultCamera(state.atlas);
    } else {
      $('#gl-canvas').insertAdjacentHTML('afterend', '<div class="hint" style="position:absolute;inset:12px auto auto 12px;background:#2a1414;padding:8px 10px;border-radius:8px;border:1px solid #6a3030;color:#ffb1b1">WebGL2 不可用：三维预览已停用，2D 图集、层级与污染诊断仍可查看。</div>');
    }
    renderTileList();
    renderLevelStrip();
    renderPageTabs();
    renderAtlasCanvas();
    renderSelectedPanel();
    renderContamTable();
    renderDiagnostics();
    updateTopStats();
    const slider = $('#preview-level');
    const tile = state.atlas.tiles.find((t) => t.id === state.selectedId);
    slider.max = String((tile?.levels.filter((l) => l.x !== null).length ?? 1) - 1);
    slider.value = '0';
    note.textContent = '';
    if (!silent) {
      toast(`图集已重建：${fmtBytes(state.atlas.diagnostics.totalBytes)}，安全 L${state.atlas.diagnostics.safeLod}`);
    }
  } catch (err) {
    note.textContent = '';
    if (err instanceof AtlasError) {
      showError(err);
    } else {
      console.error(err);
      toast(`构建失败：${err.message}`, true);
    }
    // keep the previous good atlas visible
  } finally {
    btn.disabled = false;
  }
}

function defaultCamera(atlas) {
  const rows = Math.ceil((atlas?.tiles.length ?? 6) / 3);
  const worldH = rows * 1.6;
  const worldW = 3 * 1.6;
  const vFov = (45 * Math.PI) / 180;
  const aspect = Math.max(0.6, ($('#gl-canvas').clientWidth || 800) / ($('#gl-canvas').clientHeight || 600));
  const distV = (worldH * 0.5) / Math.tan(vFov / 2);
  const distH = (worldW * 0.5) / (Math.tan(vFov / 2) * aspect);
  const distance = Math.max(distV, distH) * 1.04;
  return { distance: Math.min(20, distance), pitch: 0.14, yaw: 0.2, fov: 45, target: { x: 0, y: 0, z: 0 } };
}

function ensureRenderer() {
  if (renderer) return;
  try {
    renderer = new WallRenderer($('#gl-canvas'), null);
    renderer.renderLoop();
    renderer.canvas.addEventListener('pointerdown', onPointerDown);
    renderer.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      renderer.zoom(e.deltaY);
    }, { passive: false });
    renderer.canvas.addEventListener('pointermove', (e) => {
      if (drag.active) {
        renderer.orbit(e.movementX ?? 0, e.movementY ?? 0);
      }
      const pos = pointerToTile(e);
      if (pos) {
        $('#probe-readout').textContent = `采样 ${pos.tile.id} · 局部 uv ${pos.u.toFixed(3)}, ${pos.v.toFixed(3)} · 纹理 L${renderer.params.manual < 0 ? 'auto' : renderer.params.manual}`;
      }
    });
    renderer.canvas.addEventListener('pointerup', () => { drag.active = false; });
    renderer.canvas.addEventListener('pointerleave', () => { drag.active = false; });
    window.addEventListener('resize', () => renderer.resize());
    applyRendererParams();
  } catch (err) {
    console.error(err);
    toast(`WebGL2 初始化失败：${err.message}`, true);
  }
}

const drag = { active: false, x: 0, y: 0 };
function onPointerDown(e) {
  drag.active = true;
  drag.x = e.clientX;
  drag.y = e.clientY;
  renderer.canvas.setPointerCapture?.(e.pointerId);
}

function pointerToTile(e) {
  if (!renderer) return null;
  const rect = renderer.canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  const vp = renderer.cameraMatrix();
  let best = null;
  for (const t of renderer.tiles) {
    const m = t.model;
    const cu = (m[12] + 0) * 0;
    void cu;
    // corners in world space
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy]) => {
      const wx = m[0] * cx + m[4] * cy + m[12];
      const wy = m[1] * cx + m[5] * cy + m[13];
      const wz = m[2] * cx + m[6] * cy + m[14];
      const clip = applyMat4(vp, wx, wy, wz, 1);
      return [clip[0] / clip[3], clip[1] / clip[3]];
    });
    const inside = pointInQuad(x, y, corners);
    if (inside) {
      const uv = quadUv(x, y, corners);
      if (uv) best = { tile: t.tile, u: uv[0], v: uv[1] };
    }
  }
  return best;
}

function applyMat4(m, x, y, z, w) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

function pointInQuad(px, py, q) {
  const signs = [];
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % 4];
    signs.push((px - x1) * (y2 - y1) - (py - y1) * (x2 - x1));
  }
  return signs.every((s) => s >= 0) || signs.every((s) => s <= 0);
}

function quadUv(px, py, q) {
  // find local barycentric uv of a bilinear quad by searching two triangles
  const tri = (a, b, c, ua, ub, uc) => {
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(d) < 1e-9) return null;
    const w1 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / d;
    const w2 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / d;
    const w3 = 1 - w1 - w2;
    if (w1 < -0.01 || w2 < -0.01 || w3 < -0.01) return null;
    return [ua[0] * w1 + ub[0] * w2 + uc[0] * w3, ua[1] * w1 + ub[1] * w2 + uc[1] * w3];
  };
  const hit = tri(q[0], q[1], q[2], [0, 1], [1, 1], [0, 0]) ?? tri(q[1], q[3], q[2], [1, 1], [1, 0], [0, 0]);
  return hit;
}

function applyRendererParams() {
  if (!renderer) return;
  renderer.setParams({
    mode: state.viewMode,
    alphaView: state.alphaView ? 1 : 0,
    manual: state.lodManual,
    bias: state.bias,
    showBounds: $('#opt-bounds').checked ? 1 : 0,
  });
}

function bindUi() {
  $('#btn-rebuild').addEventListener('click', () => rebuild());
  $('#btn-add').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const existing = new Set(state.items.map((i) => i.id));
    for (const file of files) {
      try {
        const img = await decodePng(file);
        const base = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '-').toLowerCase() || 'tile';
        const id = newItemId(base, existing);
        const image = img;
        if (image.width > 4096 || image.height > 4096) {
          toast(`${file.name} 超过 4096px 单边上限，已跳过`, true);
          continue;
        }
        state.items.push({ id, name: file.name, image });
      } catch (err) {
        toast(`无法读取 ${file.name}: ${err.message}`, true);
      }
    }
    e.target.value = '';
    void rebuild();
  });
  $('#btn-reset').addEventListener('click', async () => {
    try {
      state.items = await loadSampleItems();
      state.selectedId = state.items[0].id;
      await rebuild();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#opt-padding').addEventListener('change', (e) => {
    state.options.padding = Number(e.target.value);
    rebuild();
  });
  $('#opt-pagelimit').addEventListener('change', (e) => {
    state.options.pageLimit = Number(e.target.value);
    rebuild();
  });
  $('#opt-budget').addEventListener('change', (e) => {
    state.options.budgetBytes = Number(e.target.value) * 1048576;
    rebuild();
  });
  $('#opt-rotate').addEventListener('change', (e) => {
    state.options.allowRotation = e.target.checked;
    rebuild();
  });
  $('#btn-try-split').addEventListener('click', () => {
    const prev = state.options.pageLimit;
    state.options.pageLimit = 640;
    $('#opt-pagelimit').value = '640';
    rebuild({ silent: true }).then(() => {
      if (state.atlas) {
        toast(state.atlas.diagnostics.pageCount > 1
          ? `已拆分 ${state.atlas.diagnostics.pageCount} 页（640px 上限），所有图块尺寸保持原样`
          : '当前素材在 640px 上限内仍可单页容纳');
      }
      setTimeout(() => {
        state.options.pageLimit = prev;
        $('#opt-pagelimit').value = String(prev);
        rebuild({ silent: true });
      }, 2800);
    });
  });

  $$('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      if (btn.dataset.mode !== undefined) {
        $$('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
        state.viewMode = Number(btn.dataset.mode);
      } else if (btn.dataset.lod !== undefined) {
        $$('[data-lod]').forEach((b) => b.classList.toggle('active', b === btn));
        state.lodManual = Number(btn.dataset.lod);
        state.bias = 0;
        $('#opt-bias').value = '0';
        $('#bias-out').textContent = '0.0';
        $('#lod-auto').classList.remove('active');
      } else if (btn.id === 'lod-auto') {
        $$('[data-lod]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.lodManual = -1;
      }
      applyRendererParams();
    });
  });
  $('#opt-alpha').addEventListener('change', (e) => {
    state.alphaView = e.target.checked;
    applyRendererParams();
  });
  $('#opt-bounds').addEventListener('change', applyRendererParams);
  $('#btn-reset-view').addEventListener('click', () => {
    if (renderer) {
      renderer.camera = defaultCamera(state.atlas);
      renderer.dirty = true;
    }
  });
  $('#opt-bias').addEventListener('input', (e) => {
    state.bias = Number(e.target.value);
    $('#bias-out').textContent = state.bias.toFixed(1);
    state.lodManual = -1;
    $('#lod-auto').classList.add('active');
    $$('[data-lod]').forEach((b) => b.classList.remove('active'));
    applyRendererParams();
  });
  $('#preview-level').addEventListener('input', (e) => {
    state.previewLevel = Number(e.target.value);
    renderPreview();
  });
  $('#preview-zoom').addEventListener('change', (e) => {
    state.previewZoom = Number(e.target.value);
    renderPreview();
  });
  $('#btn-export').addEventListener('click', () => exportBundle());
  $('#btn-download-manifest').addEventListener('click', () => {
    if (!state.atlas) return;
    const manifest = makeManifest(state.atlas);
    downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), 'manifest.json');
  });
  $('#btn-download-diag').addEventListener('click', () => {
    if (!state.atlas) return;
    const d = state.atlas.diagnostics;
    const payload = {
      generatedAt: new Date().toISOString(),
      budget: { requiredBytes: d.totalBytes, limitBytes: d.budgetBytes },
      safeLod: d.safeLod,
      paddingTexels: d.paddingTexels,
      pages: d.pageCount,
      split: d.split,
      overheadRatio: d.overheadRatio,
      contaminationLevel: d.contaminationLevel,
      contamination: d.contamination.map((c) => ({
        id: c.id, maxRgb: c.maxRgb, maxAlpha: c.maxA, meanRgb: c.meanRgb,
        contaminatedProbes: c.contaminated, probes: c.total,
      })),
      warnings: d.warnings,
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'diagnostics.json');
  });

  $$('.level-pill').forEach((b) => b.addEventListener('click', () => {
    state.atlasLevel = Number(b.dataset.level);
    renderLevelStrip();
  }));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'a' || e.key === 'A') {
      const cb = $('#opt-alpha');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    }
  });
}

async function exportBundle() {
  if (!state.atlas) {
    toast('尚未构建图集', true);
    return;
  }
  const btn = $('#btn-export');
  btn.disabled = true;
  btn.textContent = '打包中…';
  try {
    const manifest = makeManifest(state.atlas);
    const entries = [];
    for (const page of state.atlas.guarded.pages) {
      for (const level of page.levels) {
        const blob = await encodePng(level.width, level.height, level.image.data);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        entries.push({ name: `atlas_p${page.index}_l${level.level}.png`, bytes });
      }
    }
    entries.push({
      name: 'manifest.json',
      bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    });
    const diag = {
      generatedAt: new Date().toISOString(),
      budget: { requiredBytes: state.atlas.diagnostics.totalBytes, limitBytes: state.atlas.diagnostics.budgetBytes },
      safeLod: state.atlas.diagnostics.safeLod,
      paddingTexels: state.atlas.diagnostics.paddingTexels,
      contaminationLevel: state.atlas.diagnostics.contaminationLevel,
      contamination: state.atlas.diagnostics.contamination.map((c) => ({
        id: c.id, maxRgb: c.maxRgb, maxAlpha: c.maxA, meanRgb: c.meanRgb,
        contaminatedProbes: c.contaminated, probes: c.total,
      })),
      warnings: state.atlas.diagnostics.warnings,
      mipStopReasons: state.atlas.diagnostics.mipStopReasons,
    };
    entries.push({ name: 'diagnostics.json', bytes: new TextEncoder().encode(JSON.stringify(diag, null, 2)) });
    entries.push({ name: 'README.txt', bytes: new TextEncoder().encode(exportReadme()) });
    const zip = createZip(entries);
    downloadBlob(new Blob([zip], { type: 'application/zip' }), 'exhibit-atlas.zip');
    toast(`已导出 exhibit-atlas.zip（${entries.length} 个文件，逐级 PNG + 清单）`);
  } catch (err) {
    console.error(err);
    toast(`导出失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '导出纹理包';
  }
}

function exportReadme() {
  const a = state.atlas;
  return [
    'Exhibit Atlas package',
    '',
    `padding: ${a.options.padding}px`,
    `page limit: ${a.options.pageLimit}px`,
    `pages: ${a.guarded.pages.length}`,
    `safe mip levels: L0..L${a.diagnostics.safeLod}`,
    '',
    'Per page, atlas_pN_lM.png is mip level M. Do NOT call generateMipmap on these',
    'images; upload each level with texImage2D(..., level, ...), set',
    'TEXTURE_MAX_LEVEL to the safe LOD, wrap CLAMP_TO_EDGE, mag LINEAR,',
    'min LINEAR_MIPMAP_LINEAR.',
    '',
    'For each tile in manifest.json use uvTransform to map source uv -> atlas uv.',
    'A 90 degree rotation is encoded in that 3x3 matrix; inverseUvTransform is',
    'provided for picking. levels[] lists per-level rects and transforms.',
    'Atlas mip chains are generated per tile so no neighbour colours bleed in;',
    'this is why each level image already contains the tile content and why you',
    'must not re-filter the whole page.',
  ].join('\n');
}

async function boot() {
  bindUi();
  try {
    state.items = await loadSampleItems();
    state.selectedId = state.items[0].id;
  } catch (err) {
    toast(err.message, true);
    return;
  }
  ensureRenderer();
  await rebuild({ silent: true });
  const note = $('#atlas-note');
  if (note && state.atlas) {
    note.textContent += ' 所有层级均由图集核心逐块生成。';
  }
}

boot();

// Expose a tiny, honest API for automated UI checks. Everything routes through
// the same functions the buttons use.
window.__atlasStudio = {
  state,
  rebuild,
  select: (id) => selectTile(id, true),
  setDistance: (d) => { if (renderer) { renderer.camera.distance = d; renderer.dirty = true; } },
  focus: (id) => focusWallOnTile(id),
  setMode: (m) => { state.viewMode = m; $$('[data-mode]').forEach((b) => b.classList.toggle('active', Number(b.dataset.mode) === m)); applyRendererParams(); },
  setLod: (l) => { state.lodManual = l; applyRendererParams(); },
  setAlpha: (v) => { state.alphaView = v; applyRendererParams(); },
  renderSplice: () => renderSplice(),
  lastSpliceSignal: () => spliceSignal,
};
