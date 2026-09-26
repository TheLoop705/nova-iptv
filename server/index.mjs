#!/usr/bin/env node
// Nova web server: serves the exported web app (dist/), a streaming proxy at /api/proxy and the
// web app's saved playlists/settings at /api/kv (SQLite).
//
// Browsers can't talk to most IPTV servers directly (no CORS headers, plain http on an https
// page, providers that require a specific User-Agent), so the web build routes playlist, EPG,
// API and stream requests through here. HLS playlists are rewritten so every segment/key/
// variant URL also flows through the proxy.
//
// Env:
//   PORT          listen port (default 8787)
//   HOST          bind address (default 0.0.0.0)
//   DIST          directory with the exported web app (default ../dist)
//   BASIC_AUTH    "user:password" — protects the app and the proxy. Set this before exposing
//                 the server outside your LAN, otherwise it's an open proxy.
//   ALLOW_PRIVATE "1" lets the proxy reach loopback/LAN/link-local addresses (e.g. a TVHeadend
//                 box on your network). Off by default so the proxy can't be used to probe
//                 internal services or cloud metadata endpoints.
//   ALLOWED_HOSTS optional comma-separated list of upstream hosts (a host also allows its
//                 subdomains). When set, every other host is refused.
//   NOVA_DB       SQLite file for the web app's playlists, favourites and settings
//                 (default ~/.nova-iptv/nova.db). Contains playlist credentials.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { createGunzip, createGzip, createInflate, createBrotliDecompress, gzipSync } from 'node:zlib';
import os from 'node:os';
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DIST = resolve(process.env.DIST || join(here, '..', 'dist'));
const BASIC_AUTH = process.env.BASIC_AUTH || '';
const DEFAULT_UA = 'Nova/1.0 (Linux; Android 12) ExoPlayerLib/2.19.1';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const MAX_REDIRECTS = 5;
const DB_PATH = resolve(process.env.NOVA_DB || join(os.homedir(), '.nova-iptv', 'nova.db'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range, content-type',
  'access-control-expose-headers': 'content-length, content-range, content-type, accept-ranges, x-final-url',
};

function authorized(req) {
  if (!BASIC_AUTH) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  return Buffer.from(h.slice(6), 'base64').toString() === BASIC_AUTH;
}

function proxied(url, ua) {
  let out = `/api/proxy?url=${encodeURIComponent(url)}`;
  if (ua) out += `&ua=${encodeURIComponent(ua)}`;
  return out;
}

/** Rewrites every URI in an HLS playlist so it resolves back through this proxy. */
export function rewriteHls(text, base, ua) {
  const abs = (u) => {
    try {
      return new URL(u, base).href;
    } catch {
      return u;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxied(abs(u), ua)}"`);
      return proxied(abs(t), ua);
    })
    .join('\n');
}

// ---- SSRF guard -------------------------------------------------------------------------

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT / Tailscale
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

/** Expands an IPv6 string (incl. "::" and a trailing dotted quad) into 8 16-bit groups. */
function ipv6Groups(ip) {
  let v = ip.toLowerCase().split('%')[0];
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (quad) {
    const n = ipv4ToInt(quad[1]);
    v = v.slice(0, -quad[1].length) + ((n >>> 16).toString(16) + ':' + (n & 0xffff).toString(16));
  }
  const [head, tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
}

const v4FromGroups = (g, i) => `${g[i] >> 8}.${g[i] & 255}.${g[i + 1] >> 8}.${g[i + 1] & 255}`;

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses (v4 and v6). */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (!net.isIPv6(ip)) return true;
  const g = ipv6Groups(ip);
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && g[7] === 1) return true; // ::1
  // IPv4 embedded forms: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return isPrivateAddress(v4FromGroups(g, 6));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateAddress(v4FromGroups(g, 6));
  if (g[0] === 0x2002) return isPrivateAddress(v4FromGroups(g, 1));
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function hostAllowed(hostname) {
  if (!ALLOWED_HOSTS.length) return true;
  const h = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

class BlockedError extends Error {}

/** DNS lookup that refuses internal addresses. Runs at connect time, so DNS rebinding can't dodge it. */
export function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!ALLOW_PRIVATE) {
      const bad = addresses.find((a) => isPrivateAddress(a.address));
      if (bad) return callback(new BlockedError(`Refusing to connect to internal address ${bad.address}`));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Validates a URL before any request is made to it (initial URL and every redirect hop). */
function checkTarget(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedError('Only http(s) URLs can be proxied');
  if (url.username || url.password) throw new BlockedError('Credentials in proxied URLs are not supported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostAllowed(host)) throw new BlockedError(`Host ${host} is not in ALLOWED_HOSTS`);
  // IP literals skip DNS, so check them here
  if (net.isIP(host) && !ALLOW_PRIVATE && isPrivateAddress(host)) throw new BlockedError(`Refusing to connect to internal address ${host}`);
  if (!ALLOW_PRIVATE && /^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new BlockedError(`Refusing to connect to ${host}`);
}

function requestOnce(url, headers, signal) {
  return new Promise((resolvePromise, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', headers, lookup: guardedLookup, signal, timeout: 30000 }, resolvePromise);
    req.on('timeout', () => req.destroy(new Error('Upstream timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** GET with redirects followed manually so every hop goes through checkTarget + guardedLookup. */
async function fetchUpstream(url, headers, signal) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkTarget(current);
    const res = await requestOnce(current, headers, signal);
    const status = res.statusCode ?? 502;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current);
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new BlockedError('Too many redirects');
}

function decoded(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip());
  if (enc === 'deflate') return res.pipe(createInflate());
  if (enc === 'br') return res.pipe(createBrotliDecompress());
  return res;
}

async function readText(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('Too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---- proxy -----------------------------------------------------------------------------

// Playlists, EPG and Xtream API responses are large, highly compressible text that IPTV panels
// often send uncompressed. Media (video segments, images) is never recompressed.
const COMPRESSIBLE = /json|xml|text\/|mpegurl|javascript/;
const acceptsGzip = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-encoding', 'last-modified', 'etag', 'cache-control', 'expires'];

async function handleProxy(req, res, params) {
  const target = params.get('url');
  const ua = params.get('ua') || DEFAULT_UA;
  let url;
  try {
    url = new URL(target);
  } catch {
    res.writeHead(400, { ...CORS, 'content-type': 'text/plain' });
    return res.end('Invalid url');
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const headers = { 'user-agent': ua, accept: '*/*' };
  if (req.headers.range) headers.range = req.headers.range;

  let upstream;
  let finalUrl;
  try {
    ({ res: upstream, finalUrl } = await fetchUpstream(url, headers, controller.signal));
  } catch (e) {
    if (controller.signal.aborted) return;
    const blocked = e instanceof BlockedError;
    res.writeHead(blocked ? 403 : 502, { ...CORS, 'content-type': 'text/plain' });
    return res.end(blocked ? e.message : `Upstream error: ${e?.code || e?.message || e}`);
  }

  const status = upstream.statusCode ?? 502;
  const ctype = String(upstream.headers['content-type'] || '').toLowerCase();
  const path = finalUrl.pathname.toLowerCase();
  const looksHls = ctype.includes('mpegurl') || path.endsWith('.m3u8');
  const small = Number(upstream.headers['content-length'] || 0) < 2_000_000;

  // HLS media/master playlists get rewritten; IPTV channel lists (also #EXTM3U) pass through untouched.
  if ((looksHls || path.endsWith('.m3u')) && small && status >= 200 && status < 300) {
    let text;
    try {
      text = await readText(decoded(upstream), 8_000_000);
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { ...CORS, 'content-type': 'text/plain' });
      return res.end(`Upstream error: ${e?.message || e}`);
    }
    const isHls = text.includes('#EXT-X-');
    const body = isHls ? rewriteHls(text, finalUrl.href, params.get('ua')) : text;
    const gzip = body.length > 1024 && acceptsGzip(req);
    res.writeHead(status, {
      ...CORS,
      'content-type': isHls ? 'application/vnd.apple.mpegurl' : ctype || 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
      'x-final-url': finalUrl.href,
      ...(gzip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : null),
    });
    return res.end(gzip ? gzipSync(body, { level: 5 }) : body);
  }

  const out = { ...CORS, 'x-final-url': finalUrl.href };
  for (const h of PASS_HEADERS) if (upstream.headers[h]) out[h] = upstream.headers[h];
  const gzip = status === 200 && req.method !== 'HEAD' && !out['content-encoding'] && !out['content-range'] && COMPRESSIBLE.test(ctype) && acceptsGzip(req);
  if (gzip) {
    delete out['content-length'];
    out['content-encoding'] = 'gzip';
    out.vary = 'accept-encoding';
  }
  res.writeHead(status, out);
  if (req.method === 'HEAD') {
    upstream.destroy();
    return res.end();
  }
  upstream.on('error', () => res.destroy());
  if (!gzip) return upstream.pipe(res);
  const z = createGzip({ level: 5 });
  z.on('error', () => res.destroy());
  upstream.pipe(z).pipe(res);
}

// ---- saved data ------------------------------------------------------------------------

// Playlists, favourites, progress and settings (`settings`) plus uploaded M3U files (`m3u:<id>`),
// shared by every browser that opens this server. Values are JSON. `settings` is updated with
// field-level ops (PATCH) so two devices editing different things don't overwrite each other.
const KV_KEY = /^(settings|m3u:[\w.-]{1,100})$/;
const KV_MAX_BYTES = 64_000_000;
let kvStore;

async function kv() {
  if (!kvStore) {
    const { DatabaseSync } = await import('node:sqlite');
    // Holds playlist credentials: owner-only. SQLite gives the -wal/-shm files the database's mode.
    mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
    closeSync(openSync(DB_PATH, 'a', 0o600));
    for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    kvStore = {
      get: db.prepare('SELECT value FROM kv WHERE key = ?'),
      put: db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'),
      del: db.prepare('DELETE FROM kv WHERE key = ?'),
    };
  }
  return kvStore;
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const safeKey = (k) => typeof k === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';

/** Applies field-level ops from the web app (src/utils/docPatch.ts) to a stored document. */
export function applyOps(doc, ops) {
  if (!Array.isArray(ops)) throw new TypeError('ops must be an array');
  const out = isObject(doc) ? doc : {};
  for (const op of ops) {
    const path = op?.path;
    if (!Array.isArray(path) || path.length < 1 || path.length > 2 || !path.every(safeKey)) throw new TypeError('Invalid op path');
    let target = out;
    if (path.length === 2) {
      if (!isObject(out[path[0]])) out[path[0]] = {};
      target = out[path[0]];
    }
    const key = path[path.length - 1];
    if (op.delete) delete target[key];
    else target[key] = op.value;
  }
  return out;
}

/** The app is same-origin; only the dev server on localhost may call this cross-origin. */
function kvCors(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  try {
    const { hostname } = new URL(origin);
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') return {};
  } catch {
    return {};
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  };
}

async function handleKv(req, res, key) {
  const headers = { ...kvCors(req), 'content-type': 'application/json', 'cache-control': 'no-store' };
  const send = (status, body) => {
    res.writeHead(status, headers);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }
  if (!KV_KEY.test(key)) return send(400, { error: 'Unknown key' });
  const store = await kv();

  if (req.method === 'GET') {
    const row = store.get.get(key);
    return send(200, `{"value":${row ? row.value : 'null'}}`); // stored text is already JSON
  }
  if (req.method === 'DELETE') {
    store.del.run(key);
    return send(200, { ok: true });
  }
  if (req.method !== 'PUT' && req.method !== 'PATCH') return send(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(await readText(req, KV_MAX_BYTES));
  } catch (e) {
    return send(e?.message === 'Too large' ? 413 : 400, { error: 'Body must be JSON' });
  }
  if (req.method === 'PUT') {
    store.put.run(key, JSON.stringify(body), Date.now());
    return send(200, { ok: true });
  }
  // PATCH: read-modify-write is atomic here — node:sqlite is synchronous and nothing awaits in between
  if (key !== 'settings') return send(405, { error: 'PATCH is only supported for settings' });
  const row = store.get.get(key);
  let doc;
  try {
    doc = applyOps(row ? JSON.parse(row.value) : {}, body?.ops);
  } catch (e) {
    return send(400, { error: e.message });
  }
  const text = JSON.stringify(doc);
  store.put.run(key, text, Date.now());
  return send(200, `{"value":${text}}`);
}

function serveStatic(req, res, pathname) {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Nova proxy is running. Build the web app with `npm run build:web` to serve it here.');
  }
  let file = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end();
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const idx = join(file, 'index.html');
    file = existsSync(idx) ? idx : join(DIST, 'index.html'); // SPA fallback
  }
  const type = MIME[extname(file)] || 'application/octet-stream';
  // Bundles and assets carry a content hash in their name, so they can be cached forever
  const immutable = /\/_expo\/static\//.test(pathname) || /\.[0-9a-f]{20,}\.\w+$/.test(file);
  const stat = statSync(file);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', etag, vary: 'accept-encoding' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  // Precompressed copies written by scripts/compress-dist.mjs (npm run build:web)
  const accept = String(req.headers['accept-encoding'] || '');
  let body = file;
  for (const [enc, ext] of [['br', '.br'], ['gzip', '.gz']]) {
    if (accept.includes(enc) && existsSync(file + ext)) {
      headers['content-encoding'] = enc;
      body = file + ext;
      break;
    }
  }
  headers['content-length'] = statSync(body).size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(body).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://local');
  let kvKey = null;
  if (pathname.startsWith('/api/kv/')) {
    try {
      kvKey = decodeURIComponent(pathname.slice(8));
    } catch {
      kvKey = ''; // malformed escape: rejected as an unknown key
    }
  }
  if (req.method === 'OPTIONS' && kvKey === null) {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (!authorized(req) && req.method !== 'OPTIONS') {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Nova"' });
    return res.end('Authentication required');
  }
  try {
    if (kvKey !== null) return await handleKv(req, res, kvKey);
    if (pathname === '/api/proxy') return await handleProxy(req, res, searchParams);
    if (pathname === '/api/health') {
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  server.listen(PORT, HOST, () => {
    console.log(`Nova server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (dist: ${DIST})`);
    if (!BASIC_AUTH) console.log('Tip: set BASIC_AUTH=user:pass before exposing this server to the internet.');
  });
}
