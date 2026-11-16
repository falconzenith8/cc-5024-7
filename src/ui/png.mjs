// Minimal PNG codec in the browser. Decoding uses the platform decoder to get
// exact RGBA (no colour management surprises); encoding uses CompressionStream
// for an actual, independently loadable PNG file per level.
export async function decodePng(blobOrBuffer) {
  const blob = blobOrBuffer instanceof Blob ? blobOrBuffer : new Blob([blobOrBuffer], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(data.data.buffer) };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeU32(arr, off, v) {
  arr[off] = (v >>> 24) & 0xff;
  arr[off + 1] = (v >>> 16) & 0xff;
  arr[off + 2] = (v >>> 8) & 0xff;
  arr[off + 3] = v & 0xff;
}

// Encode straight-alpha RGBA to PNG. Uses filter type 1 (Sub) to help deflate.
export async function encodePng(width, height, rgba) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 1;
    const srcRow = y * width * 4;
    for (let x = 0; x < width * 4; x++) {
      const cur = rgba[srcRow + x];
      const left = x >= 4 ? rgba[srcRow + x - 4] : 0;
      raw[rowStart + 1 + x] = (cur - left) & 0xff;
    }
  }
  const compressed = await deflate(raw);
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [signature, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))];
  return new Blob(chunks, { type: 'image/png' });
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
