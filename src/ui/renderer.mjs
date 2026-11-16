// WebGL2 exhibit wall. Every tile is a real 3D quad with perspective sampling;
// textures are uploaded as explicit per-level images (never generateMipmap).
// Modes: guarded, naive, diff. Manual LOD uses the per-level UV map when the
// atlas provides one, so rotated tiles stay aligned at every reduction.

const VERT = `#version 300 es
in vec2 aCorner;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat3 uUv;
uniform mat3 uUvN;
out vec2 vUv;
out vec2 vUvN;
out vec2 vLocal;
void main() {
  // Texture row 0 is the image top; the quad's local y=0 is its bottom, so
  // flip v when converting to source uv.
  vec2 corner = vec2(aCorner.x, 1.0 - aCorner.y);
  vUv = (uUv * vec3(corner, 1.0)).xy;
  vUvN = (uUvN * vec3(corner, 1.0)).xy;
  vLocal = aCorner;
  gl_Position = uViewProj * uModel * vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vUvN;
in vec2 vLocal;
uniform sampler2D uGuarded;
uniform sampler2D uNaive;
uniform int uMode;
uniform float uAlphaView;
uniform float uLod;
uniform float uManual;
uniform float uBias;
uniform float uShowBounds;
uniform float uGlow;
out vec4 outColor;

vec4 sampleG() {
  if (uManual >= 0.0) return textureLod(uGuarded, vUv, uManual);
  return texture(uGuarded, vUv, uBias);
}
vec4 sampleN() {
  if (uManual >= 0.0) return textureLod(uNaive, vUvN, uManual);
  return texture(uNaive, vUvN, uBias);
}

void main() {
  if (uAlphaView > 0.5) {
    vec4 c = uMode == 1 ? sampleN() : sampleG();
    outColor = vec4(vec3(c.a), 1.0);
    return;
  }
  if (uMode == 2) {
    vec4 cg = sampleG();
    vec4 cn = sampleN();
    vec3 pg = cg.rgb * cg.a;
    vec3 pn = cn.rgb * cn.a;
    vec3 d = abs(pg - pn) + vec3(abs(cg.a - cn.a));
    vec3 amped = clamp(d * uGlow, 0.0, 1.0);
    outColor = vec4(amped, 1.0);
    return;
  }
  vec4 c = uMode == 1 ? sampleN() : sampleG();
  if (uShowBounds > 0.5) {
    float edge = min(min(vLocal.x, vLocal.y), min(1.0 - vLocal.x, 1.0 - vLocal.y));
    float aa = fwidth(edge);
    float line = 1.0 - smoothstep(0.0, aa * 1.5, edge);
    c.rgb = mix(c.rgb, vec3(1.0, 0.95, 0.2), line * 0.55);
  }
  outColor = vec4(c.rgb * c.a, c.a);
}`;

const BG_VERT = `#version 300 es
in vec2 aPos;
out vec2 vPos;
void main() {
  vPos = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BG_FRAG = `#version 300 es
precision highp float;
in vec2 vPos;
uniform vec2 uRes;
uniform float uAlphaView;
out vec4 outColor;
void main() {
  if (uAlphaView > 0.5) {
    outColor = vec4(0.08, 0.09, 0.11, 1.0);
    return;
  }
  vec2 p = (vPos * 0.5 + 0.5) * uRes / 28.0;
  float c = mod(floor(p.x) + floor(p.y), 2.0);
  vec3 col = mix(vec3(0.16, 0.17, 0.2), vec3(0.24, 0.25, 0.29), c);
  outColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function mat4Identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      out[i * 4 + j] = s;
    }
  }
  return out;
}

function translation(x, y, z) {
  const m = mat4Identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function scaling(x, y, z) {
  const m = mat4Identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

function rotationX(a) {
  const m = mat4Identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

function rotationY(a) {
  const m = mat4Identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export class WallRenderer {
  constructor(canvas, overlayCanvas) {
    this.canvas = canvas;
    this.overlay = overlayCanvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.prog = program(gl, VERT, FRAG);
    this.bgProg = program(gl, BG_VERT, BG_FRAG);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    this.bgBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.locs = {
      aCorner: gl.getAttribLocation(this.prog, 'aCorner'),
      uViewProj: gl.getUniformLocation(this.prog, 'uViewProj'),
      uModel: gl.getUniformLocation(this.prog, 'uModel'),
      uUv: gl.getUniformLocation(this.prog, 'uUv'),
      uUvN: gl.getUniformLocation(this.prog, 'uUvN'),
      uGuarded: gl.getUniformLocation(this.prog, 'uGuarded'),
      uNaive: gl.getUniformLocation(this.prog, 'uNaive'),
      uMode: gl.getUniformLocation(this.prog, 'uMode'),
      uAlphaView: gl.getUniformLocation(this.prog, 'uAlphaView'),
      uManual: gl.getUniformLocation(this.prog, 'uManual'),
      uBias: gl.getUniformLocation(this.prog, 'uBias'),
      uShowBounds: gl.getUniformLocation(this.prog, 'uShowBounds'),
      uGlow: gl.getUniformLocation(this.prog, 'uGlow'),
    };
    this.bgLocs = {
      aPos: gl.getAttribLocation(this.bgProg, 'aPos'),
      uRes: gl.getUniformLocation(this.bgProg, 'uRes'),
      uAlphaView: gl.getUniformLocation(this.bgProg, 'uAlphaView'),
    };
    this.textures = { guarded: [], naive: [] };
    this.pageSize = { guarded: 1024, naive: 1024 };
    this.tiles = [];
    this.camera = { distance: 3.2, pitch: 0.28, yaw: 0.32, fov: 45, target: { x: 0, y: 0, z: 0 } };
    this.params = { mode: 0, alphaView: 0, manual: -1, bias: 0, showBounds: 1, glow: 8 };
    this.selectedId = null;
    this.sceneScale = 1;
    this._raf = null;
    this.dirty = true;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
  }

  setAtlas(atlas, pageIndex) {
    this.atlas = atlas;
    this.pageIndex = pageIndex;
    this.uploadTextures();
    this.layoutTiles();
    this.dirty = true;
  }

  setSelected(id) {
    this.selectedId = id;
    this.dirty = true;
  }

  setParams(next) {
    Object.assign(this.params, next);
    this.dirty = true;
  }

  orbit(dx, dy) {
    this.camera.yaw += dx * 0.006;
    this.camera.pitch = Math.max(-0.9, Math.min(0.9, this.camera.pitch + dy * 0.006));
    this.dirty = true;
  }

  zoom(delta) {
    this.camera.distance = Math.max(0.9, Math.min(20, this.camera.distance * (1 + delta * 0.0007)));
    this.dirty = true;
  }

  uploadTextures() {
    const gl = this.gl;
    for (const key of ['guarded', 'naive']) {
      for (const t of this.textures[key]) gl.deleteTexture(t);
      this.textures[key] = [];
    }
    if (!this.atlas) return;
    const atlasPage = this.atlas.guarded.pages[this.pageIndex];
    const naivePage = this.naivePageFor(atlasPage);
    this.pageSize.guarded = atlasPage.width;
    this.pageSize.naive = naivePage ? naivePage.width : atlasPage.width;
    this.uploadChain(this.textures.guarded, atlasPage, this.atlas.diagnostics.safeLod);
    if (naivePage) {
      this.uploadChain(this.textures.naive, naivePage, this.atlas.diagnostics.safeLod);
    }
    this.naivePage = naivePage;
  }

  naivePageFor(guardedPage) {
    return this.atlas.naive.pages[0] ?? null;
  }

  uploadChain(out, page, maxLevel) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const levels = page.levels.filter((lv) => lv.level <= maxLevel);
    for (const lv of levels) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        lv.level,
        gl.RGBA,
        lv.width,
        lv.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(lv.image.data.buffer, lv.image.data.byteOffset, lv.image.data.byteLength),
      );
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, Math.max(0, levels.length - 1));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    out.push(tex);
  }

  layoutTiles() {
    this.tiles = [];
    if (!this.atlas) return;
    const page = this.atlas.guarded.pages[this.pageIndex];
    const ids = page.placements.map((p) => p.id);
    const order = this.atlas.tiles.filter((t) => ids.includes(t.id));
    const cols = 3;
    const rows = Math.ceil(order.length / cols);
    const cell = 1.6;
    const worldH = rows * cell;
    const worldW = cols * cell;
    order.forEach((tile, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const avail = cell * 0.84;
      const aspect = tile.sourceWidth / tile.sourceHeight;
      let w = avail;
      let h = avail;
      if (aspect > 1) h = avail / aspect;
      else w = avail * aspect;
      const cx = (col + 0.5) * cell - worldW / 2;
      const cy = worldH / 2 - (row + 0.5) * cell;
      const guardedTransform = tile.levels[0].uvTransform;
      const naiveTile = this.naivePage?.placements.find((p) => p.id === tile.id);
      const naiveTransform = naiveTile
        ? uvMatrixFor(naiveTile, this.naivePage.width, this.naivePage.height)
        : guardedTransform;
      this.tiles.push({
        id: tile.id,
        tile,
        model: multiply(translation(cx, cy, 0), scaling(w / 2, h / 2, 1)),
        guardedTransform,
        naiveTransform,
        w,
        h,
      });
    });
    this.world = { w: worldW, h: worldH };
  }

  cameraMatrix() {
    const { distance, pitch, yaw, fov } = this.camera;
    const t = this.camera.target ?? { x: 0, y: 0, z: 0 };
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const proj = perspective((fov * Math.PI) / 180, aspect, 0.05, 100);
    const view = translation(0, 0, -distance);
    const rot = multiply(rotationX(pitch), rotationY(yaw));
    const center = translation(-t.x, -t.y, -t.z);
    return multiply(proj, multiply(view, multiply(rot, center)));
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.dirty = true;
    }
    if (this.overlay) {
      const ow = Math.max(1, Math.round(this.overlay.clientWidth * dpr));
      const oh = Math.max(1, Math.round(this.overlay.clientHeight * dpr));
      if (this.overlay.width !== ow || this.overlay.height !== oh) {
        this.overlay.width = ow;
        this.overlay.height = oh;
      }
    }
  }

  frame() {
    this.resize();
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.1, 0.11, 0.13, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.bgProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
    gl.enableVertexAttribArray(this.bgLocs.aPos);
    gl.vertexAttribPointer(this.bgLocs.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.bgLocs.uRes, W, H);
    gl.uniform1f(this.bgLocs.uAlphaView, this.params.alphaView);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);

    if (!this.atlas || this.textures.guarded.length === 0) return;
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.locs.aCorner);
    gl.vertexAttribPointer(this.locs.aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.guarded[0]);
    gl.uniform1i(this.locs.uGuarded, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.naive[0] ?? this.textures.guarded[0]);
    gl.uniform1i(this.locs.uNaive, 1);
    gl.uniformMatrix4fv(this.locs.uViewProj, false, this.cameraMatrix());
    gl.uniform1i(this.locs.uMode, this.params.mode);
    gl.uniform1f(this.locs.uAlphaView, this.params.alphaView);
    gl.uniform1f(this.locs.uManual, this.params.manual);
    gl.uniform1f(this.locs.uBias, this.params.bias);
    gl.uniform1f(this.locs.uShowBounds, this.params.showBounds);
    gl.uniform1f(this.locs.uGlow, this.params.glow);

    for (const t of this.tiles) {
      const isSel = !this.selectedId || this.selectedId === t.id;
      gl.uniformMatrix4fv(this.locs.uModel, false, t.model);
      gl.uniformMatrix3fv(this.locs.uUv, false, affine3(t.guardedTransform));
      gl.uniformMatrix3fv(this.locs.uUvN, false, affine3(t.naiveTransform));
      gl.uniform1f(this.locs.uShowBounds, this.params.showBounds * (isSel ? 1 : 0.35));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    this.dirty = false;
  }

  renderLoop() {
    const tick = () => {
      if (this.dirty) this.frame();
      this._raf = requestAnimationFrame(tick);
    };
    if (this._raf) cancelAnimationFrame(this._raf);
    tick();
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    const gl = this.gl;
    for (const key of ['guarded', 'naive']) {
      for (const t of this.textures[key]) gl.deleteTexture(t);
    }
    gl.deleteProgram(this.prog);
    gl.deleteProgram(this.bgProg);
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.bgBuf);
  }
}

// 2D affine [a,b,c,d,e,f] -> column-major mat3 used by uUv.
function affine3(m) {
  return new Float32Array([m[0], m[3], 0, m[1], m[4], 0, m[2], m[5], 1]);
}

export function uvMatrixFor(rect, pageW, pageH) {
  return [rect.w / pageW, 0, rect.x / pageW, 0, rect.h / pageH, rect.y / pageH];
}
