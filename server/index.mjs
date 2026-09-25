#!/usr/bin/env node
// Nova web server: serves the exported web app (dist/) and a streaming proxy at /api/proxy.
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

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
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
    if (size > limit) throw new Error('Playlist too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---- proxy -----------------------------------------------------------------------------

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
    res.writeHead(status, {
      ...CORS,
      'content-type': isHls ? 'application/vnd.apple.mpegurl' : ctype || 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
      'x-final-url': finalUrl.href,
    });
    return res.end(isHls ? rewriteHls(text, finalUrl.href, params.get('ua')) : text);
  }

  const out = { ...CORS, 'x-final-url': finalUrl.href };
  for (const h of PASS_HEADERS) if (upstream.headers[h]) out[h] = upstream.headers[h];
  res.writeHead(status, out);
  if (req.method === 'HEAD') {
    upstream.destroy();
    return res.end();
  }
  upstream.on('error', () => res.destroy());
  upstream.pipe(res);
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
  const immutable = /\/_expo\/static\//.test(pathname);
  res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Nova"' });
    return res.end('Authentication required');
  }
  const { pathname, searchParams } = new URL(req.url, 'http://local');
  try {
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
