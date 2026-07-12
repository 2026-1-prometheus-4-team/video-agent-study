#!/usr/bin/env node
// Measure scatter quality per frame.
// For each PNG argument: identify "letter" pixels (R+G+B above a threshold)
// against a dark background, then report:
//   - bbox of all letter pixels as % of frame dims
//   - rough count of distinct letter pieces via 4-connected flood fill
//
// Usage: node measure-scatter.mjs <png> [<png> ...]
// Bright-pixel threshold assumes white text on dark background.

import fs from "fs";
import zlib from "zlib";

function readPng(buf) {
  let p = 8;
  let width = 0, height = 0, ctype = 0;
  const ids = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); p += 4;
    const type = buf.slice(p, p + 4).toString("ascii"); p += 4;
    const data = buf.slice(p, p + len); p += len + 4;
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); ctype = data[9]; }
    else if (type === "IDAT") ids.push(data);
    else if (type === "IEND") break;
  }
  const raw = zlib.inflateSync(Buffer.concat(ids));
  const bpp = ctype === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let rp = 0, wp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    const row = Buffer.from(raw.slice(rp, rp + stride));
    rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      if (f === 0) v = row[x];
      else if (f === 1) v = (row[x] + a) & 0xff;
      else if (f === 2) v = (row[x] + b) & 0xff;
      else if (f === 3) v = (row[x] + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const p1 = a + b - c;
        const pa = Math.abs(p1 - a), pb = Math.abs(p1 - b), pc = Math.abs(p1 - c);
        const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        v = (row[x] + pr) & 0xff;
      } else throw new Error("filter " + f);
      row[x] = v;
    }
    for (let x = 0; x < width; x++) {
      out[wp++] = row[x * bpp];
      out[wp++] = row[x * bpp + 1];
      out[wp++] = row[x * bpp + 2];
      out[wp++] = bpp === 4 ? row[x * bpp + 3] : 255;
    }
    prev = row;
  }
  return { width, height, data: out };
}

// Bright-pixel mask: R+G+B above threshold AND saturation low (so the bg
// gradient blobs don't trigger). Returns a Uint8Array of 0/1.
function buildMask(png, brightness = 480) {
  const { width, height, data } = png;
  const mask = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    mask[j] = (r + g + b) >= brightness ? 1 : 0;
  }
  return mask;
}

function bbox(mask, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
  }
  if (count === 0) return null;
  return {
    minX, minY, maxX, maxY, count,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}

// 4-connected flood fill, returns number of components above minArea pixels.
// minArea filters out specks/aliasing dust.
function countPieces(mask, width, height, minArea = 60) {
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let pieces = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!mask[idx] || visited[idx]) continue;
      let top = 0;
      stack[top++] = idx;
      visited[idx] = 1;
      let area = 0;
      while (top > 0) {
        const cur = stack[--top];
        area++;
        const cx = cur % width;
        const cy = (cur - cx) / width;
        if (cx > 0) {
          const n = cur - 1;
          if (mask[n] && !visited[n]) { visited[n] = 1; stack[top++] = n; }
        }
        if (cx < width - 1) {
          const n = cur + 1;
          if (mask[n] && !visited[n]) { visited[n] = 1; stack[top++] = n; }
        }
        if (cy > 0) {
          const n = cur - width;
          if (mask[n] && !visited[n]) { visited[n] = 1; stack[top++] = n; }
        }
        if (cy < height - 1) {
          const n = cur + width;
          if (mask[n] && !visited[n]) { visited[n] = 1; stack[top++] = n; }
        }
      }
      if (area >= minArea) pieces++;
    }
  }
  return pieces;
}

function pct(num, den) {
  return ((num / den) * 100).toFixed(1) + "%";
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node measure-scatter.mjs <png> [<png> ...]");
  process.exit(1);
}

console.log("file                      | bbox W%  | bbox H% | pieces | pixels");
console.log("--------------------------|----------|---------|--------|--------");
for (const f of files) {
  const png = readPng(fs.readFileSync(f));
  const mask = buildMask(png);
  const bb = bbox(mask, png.width, png.height);
  if (!bb) {
    console.log(`${f.padEnd(25)} | empty`);
    continue;
  }
  const pieces = countPieces(mask, png.width, png.height);
  const name = f.split("/").pop();
  console.log(
    `${name.padEnd(25)} | ${pct(bb.w, png.width).padStart(8)} | ${pct(bb.h, png.height).padStart(7)} | ${String(pieces).padStart(6)} | ${String(bb.count).padStart(6)}`
  );
}
