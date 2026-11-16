#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 4173);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const full = path.normalize(path.join(root, pathname));
  if (!full.startsWith(root + path.sep) && full !== root) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
    });
    fs.createReadStream(full).pipe(res);
  });
});

server.listen(port, () => {
  console.log(`Exhibit Atlas Studio: http://localhost:${port}/`);
  console.log(`Serving ${root}`);
});
