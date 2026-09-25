#!/usr/bin/env node
// Writes Brotli (.br) and gzip (.gz) copies of every compressible file in dist/, so the Nova
// server can send them compressed without spending CPU on each request. Run after `expo export`.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const DIST = resolve(process.argv[2] || 'dist');
const COMPRESSIBLE = /\.(js|css|html|json|svg|ttf|otf|ico|map|txt|webmanifest)$/;

let before = 0;
let after = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (COMPRESSIBLE.test(name) && statSync(file).size > 1024) compress(file);
  }
}

function compress(file) {
  const data = readFileSync(file);
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  const gz = gzipSync(data, { level: 9 });
  if (br.length < data.length) writeFileSync(file + '.br', br);
  if (gz.length < data.length) writeFileSync(file + '.gz', gz);
  before += data.length;
  after += Math.min(br.length, data.length);
}

walk(DIST);
console.log(`Precompressed ${DIST}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB (brotli)`);
