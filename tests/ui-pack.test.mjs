import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

// Headless verification of the graphical pack-loading flow. A real browser is
// unavailable in this environment, so we provide the minimal DOM/fetch/canvas
// surface the studio touches and drive the SAME functions the buttons call via
// window.__atlasStudio. PNG decoding uses real PNG bytes decoded by pngjs.
const root = path.resolve(import.meta.dirname, '..');

function makeEl(id) {
  const listeners = new Map();
  return {
    id,
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    className: '',
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(event) {
      (listeners.get(event.type) ?? []).forEach((fn) => fn(event));
    },
    getContext() {
      return {
        clearRect() {}, fillRect() {}, putImageData() {}, drawImage() {},
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        set fillStyle(_) {}, set font(_) {}, set textAlign(_) {}, set globalAlpha(_) {},
        set lineWidth(_) {}, set strokeStyle(_) {}, set lineDash(_) {},
        fillText() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        setLineDash() {}, save() {}, restore() {}, scale() {}, translate() {},
      };
    },
    insertAdjacentHTML() {},
    append() {}, appendChild() {}, remove() {},
    querySelectorAll: () => [],
    addEventListener2: listeners,
  };
}

// A no-op WebGL2 surface: every method is a no-op function, constants are
// numbers, locations/handles are plain objects. It lets WallRenderer initialise
// and run its loop without a GPU while the CPU-side atlas/diagnostics stay real.
function makeGlStub() {
  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && /^[A-Z][A-Z0-9_]+$/.test(prop)) return 1;
      const noop = () => {};
      target[prop] = noop;
      return noop;
    },
  };
  const gl = new Proxy({
    canvas: null,
    getParameter: () => 'WebGL2 (headless stub)',
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    createShader: () => ({}),
    createProgram: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    checkFramebufferStatus: () => 0x8cd5,
  }, handler);
  return gl;
}

async function loadStudio() {
  const ids = [
    'toast', 'error-dialog', 'error-message', 'error-details', 'tile-list', 'btn-rebuild',
    'build-note', 'source-canvas', 'preview-canvas', 'preview-caption', 'preview-level-out',
    'preview-level', 'preview-zoom', 'tile-meta', 'level-strip', 'page-tabs', 'atlas-canvas',
    'atlas-note', 'contam-table', 'diag-list', 'stat-bytes', 'stat-budget', 'stat-pages',
    'stat-lod', 'stat-tiles', 'stat-rotated', 'splice-canvas', 'probe-readout', 'edge-canvas',
    'edge-title', 'gl-canvas', 'opt-bounds', 'opt-padding', 'opt-pagelimit', 'opt-budget',
    'opt-rotate', 'opt-alpha', 'opt-bias', 'bias-out', 'lod-auto', 'btn-reset', 'btn-add',
    'btn-export', 'btn-download-manifest', 'btn-download-diag', 'btn-try-split', 'btn-reset-view',
    'file-input', 'btn-load-pack', 'pack-status', 'pack-status-text', 'pack-status-dot',
    'anomaly-banner',
  ];
  const els = new Map(ids.map((id) => [id, makeEl(id)]));
  const glEl = els.get('gl-canvas');
  glEl.clientWidth = 800;
  glEl.clientHeight = 600;
  glEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  const glStub = makeGlStub();
  glEl.getContext = (kind) => (kind === 'webgl2' ? glStub : makeEl('ctx').getContext());
  const canvasNoop = () => ({ width: 256, height: 256, getContext: glEl.getContext });
  const documentStub = {
    querySelector: (sel) => els.get(sel.replace('#', '')) ?? makeEl(sel),
    querySelectorAll: () => [],
    createElement: () => makeEl('dynamic'),
    documentElement: makeEl('html'),
  };
  const fetchStub = async (url) => {
    const rel = url.replace(/^\.\//, '');
    const full = path.join(root, rel);
    const buf = fs.readFileSync(full);
    return { ok: true, status: 200, blob: async () => new Blob([buf]), json: async () => JSON.parse(buf.toString('utf8')) };
  };
  // decodePng uses createImageBitmap + OffscreenCanvas; decode real PNG via pngjs.
  const createImageBitmapStub = async (blob) => {
    const buf = Buffer.from(await blob.arrayBuffer());
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data, close() {} };
  };
  class OffscreenCanvasStub {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() {
      let bmp = null;
      return {
        clearRect() {}, drawImage(b) { bmp = b; },
        getImageData(x, y, w, h) {
          return { width: w, height: h, data: new Uint8ClampedArray(bmp.data) };
        },
      };
    }
  }
  const win = {
    __ATLAS_SKIP_BOOT__: true,
    document: documentStub,
    fetch: fetchStub,
    createImageBitmap: createImageBitmapStub,
    OffscreenCanvas: OffscreenCanvasStub,
    setTimeout, clearTimeout,
    devicePixelRatio: 1,
    addEventListener() {},
  };
  win.window = win;
  globalThis.window = win;
  globalThis.document = documentStub;
  globalThis.fetch = fetchStub;
  globalThis.createImageBitmap = createImageBitmapStub;
  globalThis.OffscreenCanvas = OffscreenCanvasStub;
  globalThis.Blob = Blob;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
  };
  const mod = await import(pathToFileURL(path.join(root, 'src', 'ui', 'main.mjs')).href + `?t=${Date.now()}`);
  return { studio: win.__atlasStudio, els, win };
}

test('graphical load-demo-pack flow builds the pack and exposes run status + anomalies', async () => {
  const { studio, els } = await loadStudio();
  assert.ok(studio && typeof studio.loadDemoPack === 'function');
  await studio.loadDemoPack();
  const s = studio.state;
  assert.equal(s.items.length, 7);
  assert.equal(s.activePack.id, 'demo-pack');
  assert.equal(s.options.padding, 12);
  assert.ok(s.atlas, '图集应已构建');
  // option controls reflect the SAVED pack parameters, not defaults
  assert.equal(els.get('opt-padding').value, '12');
  const status = studio.packStatus();
  assert.match(status.className, /pack/);
  assert.match(status.text, /demo-pack/);
  assert.match(status.text, /运行正常/);
  // anomaly banner is visible and names the neighbourhood/pollution abnormality
  assert.equal(status.bannerHidden, false);
  const bad = s.atlas.diagnostics.contamination.filter((c) => c.contaminated > 0).length;
  if (bad > 0) {
    assert.match(status.bannerHtml, /采样污染异常/);
    assert.match(status.bannerHtml, new RegExp(s.atlas.diagnostics.contamination
      .filter((c) => c.contaminated > 0)
      .reduce((m, c) => (c.maxRgb > m.maxRgb ? c : m), { maxRgb: -1, id: '' }).id));
  }
  // selecting a tile drives the downscale preview path without throwing
  await studio.select('ring');
  assert.equal(s.selectedId, 'ring');
});

test('missing pack parameter is rejected instead of silently defaulted', async () => {
  const { studio, win } = await loadStudio();
  // Intercept global fetch (the module calls bare `fetch`, resolved at call time).
  const realFetch = win.fetch;
  const tamperedFetch = async (url) => {
    if (url.endsWith('pack-params.json')) {
      const res = await realFetch(url);
      const j = await res.json();
      delete j.padding;
      return { ok: true, status: 200, blob: async () => new Blob([JSON.stringify(j)]), json: async () => j };
    }
    return realFetch(url);
  };
  win.fetch = tamperedFetch;
  globalThis.fetch = tamperedFetch;
  await studio.loadDemoPack();
  const status = studio.packStatus();
  assert.match(status.className, /error/);
  assert.match(status.text, /padding/);
  assert.equal(studio.state.activePack, null);
});
