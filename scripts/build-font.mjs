#!/usr/bin/env node
// Rebuild the bundled Noto Sans SC subset from characters actually used in the
// UI and core diagnostics, so the app renders correctly on machines without a
// CJK system font. Run after adding Chinese text: npm run font.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'index.html',
  'src/ui/main.mjs',
  'src/ui/renderer.mjs',
  'src/ui/app.css',
  'src/core/atlas.mjs',
  'scripts/build-atlas.mjs',
];
const chars = new Set();
for (const rel of files) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const ch of text) {
    if (/[　-〿一-鿿＀-￯]/.test(ch)) chars.add(ch);
  }
}
// Print a few common punctuation marks and digits used in canvas labels.
for (const ch of '·×→—…“”‘’（）【】') chars.add(ch);
const text = [...chars].sort().join('');
const outDir = path.join(root, 'assets', 'fonts');
fs.mkdirSync(outDir, { recursive: true });

const cssUrl =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700&display=swap&text=' +
  encodeURIComponent(text);
const css = await (await fetch(cssUrl, { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
const faces = [...css.matchAll(/font-weight: (\d+);[^}]*?src: url\((https:[^)]+)\)/gs)];
const weights = new Map();
for (const [, weight, url] of faces) if (!weights.has(weight)) weights.set(weight, url);
if (weights.size === 0) {
  console.error('no font faces returned; keeping existing subset');
  process.exit(1);
}
for (const [weight, url] of weights) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`font download ${weight} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const out = path.join(outDir, `NotoSansSC-${weight}.woff2`);
  fs.writeFileSync(out, buf);
  console.log(`wrote ${path.relative(root, out)} ${buf.length} bytes`);
}
console.log(`glyph subset size: ${text.length}`);
