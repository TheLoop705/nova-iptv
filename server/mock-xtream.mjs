#!/usr/bin/env node
// Development fixture. Public playback redirects are optional; tests stay entirely local.
import http from 'node:http';
import { once } from 'node:events';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';

const HLS = [
  'https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8',
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
];
const pad = (n) => String(n).padStart(2, '0');
const xmlTime = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const number = (value, fallback, max) => Math.max(0, Math.min(max, Math.floor(Number(value ?? fallback)) || 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function mockOptions(env = process.env) {
  const stress = env.MOCK_PROFILE === 'stress';
  return {
    channels: number(env.MOCK_CHANNELS, stress ? 3000 : 14, 20000),
    movies: number(env.MOCK_MOVIES, stress ? 25000 : 4, 100000),
    series: number(env.MOCK_SERIES, stress ? 10000 : 1, 50000),
    programmes: number(env.MOCK_PROGRAMMES_PER_CHANNEL, stress ? 144 : 120, 672),
    apiDelayMs: number(env.MOCK_API_DELAY_MS, 0, 30000),
    xmlChunkDelayMs: number(env.MOCK_XML_CHUNK_DELAY_MS, stress ? 10 : 0, 1000),
    xmlMode: env.MOCK_XMLTV_MODE || 'normal',
    xmlGzip: env.MOCK_XMLTV_GZIP !== '0',
    streamMode: env.MOCK_STREAM_MODE || 'redirect',
    clock: number(env.MOCK_NOW, Date.now(), Number.MAX_SAFE_INTEGER),
  };
}

export function createMockPanel(overrides = {}) {
  const options = { ...mockOptions({}), ...overrides };
  const liveCats = [
    { category_id: '1', category_name: 'UK | Entertainment', parent_id: 0 },
    { category_id: '2', category_name: 'UK | Sports', parent_id: 0 },
    { category_id: '3', category_name: 'DE | Nachrichten', parent_id: 0 },
  ];
  const names = ['BBC One HD', 'ITV 1', 'Channel 4', 'Sky Max', 'Dave', 'Sky Sports Main Event', 'Sky Sports F1', 'TNT Sports 1', 'Premier Sports 1', 'Das Erste', 'ZDF', 'n-tv', 'WELT', 'tagesschau24'];
  const live = Array.from({ length: options.channels }, (_, i) => ({
    num: i + 1, name: names[i] || `Performance Channel ${String(i + 1).padStart(5, '0')}`,
    stream_type: 'live', stream_id: 1000 + i, stream_icon: '', epg_channel_id: `mock.channel.${i + 1}`,
    added: '1700000000', category_id: String(i % 3 + 1), tv_archive: i % 2, tv_archive_duration: i % 2 ? 7 : 0,
  }));
  const vodCats = [{ category_id: '10', category_name: 'Movies | Action' }, { category_id: '11', category_name: 'Movies | Animation' }];
  const vod = Array.from({ length: options.movies }, (_, i) => ({
    stream_id: 5001 + i, name: ['Tears of Steel', 'Angel One', 'Big Buck Bunny', 'BipBop'][i] || `Performance Movie ${String(i + 1).padStart(6, '0')}`,
    category_id: String(10 + i % 2), rating: '7.2', container_extension: options.streamMode === 'fixture' ? 'mp4' : 'm3u8', stream_type: 'movie', stream_icon: '', added: '1700000000',
  }));
  const seriesCats = [{ category_id: '20', category_name: 'Series | Demo' }, { category_id: '21', category_name: 'Series | Drama' }];
  const series = Array.from({ length: options.series }, (_, i) => ({
    series_id: 7001 + i, name: i === 0 ? 'Stream Lab' : `Performance Series ${String(i + 1).padStart(6, '0')}`,
    cover: '', plot: 'A test series.', genre: 'Tech', releaseDate: '2021-01-01', rating: '7', category_id: String(20 + i % 2),
  }));
  const episodes = {
    1: [
      { id: '9001', episode_num: 1, title: 'Pilot', container_extension: 'm3u8', info: { plot: 'First episode', duration: '00:10:00' } },
      { id: '9002', episode_num: 2, title: 'Second', container_extension: 'm3u8', info: { plot: 'Second episode', duration: '00:12:00' } },
    ],
    2: [{ id: '9003', episode_num: 1, title: 'Return', container_extension: 'm3u8', info: { plot: 'Season two', duration: '00:09:00' } }],
  };
  if (options.streamMode === 'fixture') for (const list of Object.values(episodes)) for (const episode of list) episode.container_extension = 'mp4';
  const stats = { requests: {}, activeXmltv: 0, completedXmltv: 0, cancelledXmltv: 0, xmlBytes: 0 };
  const count = (key) => { stats.requests[key] = (stats.requests[key] || 0) + 1; };
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(value));
  };
  function media(req, res, name) {
    if (!/^[a-zA-Z0-9_.-]+\.(mp4|ts|mpegts|m3u8)$/.test(name)) { res.writeHead(404); return res.end(); }
    const file = fileURLToPath(new URL('../tests/fixtures/' + name, import.meta.url));
    if (!existsSync(file)) { res.writeHead(404); return res.end('Playback fixture not generated'); }
    const size = statSync(file).size;
    const headers = { 'content-type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : /\.(ts|mpegts)$/.test(name) ? 'video/mp2t' : 'video/mp4', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
    let start = 0, end = size - 1, status = 200;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || (!range[1] && !range[2])) { res.writeHead(416, { ...headers, 'content-range': 'bytes */' + size }); return res.end(); }
      if (!range[1]) start = Math.max(0, size - Number(range[2]));
      else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      if (start >= size || start > end) { res.writeHead(416, { ...headers, 'content-range': 'bytes */' + size }); return res.end(); }
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const fileStream = createReadStream(file, { start, end });
    res.on('close', () => fileStream.destroy());
    fileStream.pipe(res);
  }
  async function guide(res) {
    stats.activeXmltv++;
    let complete = false;
    res.on('close', () => {
      stats.activeXmltv--;
      if (complete) stats.completedXmltv++;
      else stats.cancelledXmltv++;
    });
    if (options.xmlMode === 'fail') { complete = true; res.writeHead(503); return res.end('Fixture guide unavailable'); }
    res.writeHead(200, { 'content-type': options.xmlGzip ? 'application/octet-stream' : 'application/xml', 'access-control-allow-origin': '*' });
    if (options.xmlMode === 'stall') return res.flushHeaders();
    const output = options.xmlGzip ? createGzip() : res;
    if (options.xmlGzip) output.pipe(res);
    const closed = new Promise((r) => res.once('close', r));
    const write = async (text) => {
      stats.xmlBytes += Buffer.byteLength(text);
      if (!output.write(text)) await Promise.race([once(output, 'drain'), closed]);
    };
    try {
      await write('<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="nova-fixture">\n');
      if (options.xmlMode !== 'empty') {
        for (const channel of live) await write(`<channel id="${channel.epg_channel_id}"><display-name>${esc(channel.name)}</display-name></channel>\n`);
        const start = Math.floor(options.clock / 3600000) * 3600000 - 2 * 86400000;
        for (let index = 0; index < live.length && !res.destroyed; index++) {
          const channel = live[index];
          let text = '';
          for (let p = 0; p < options.programmes; p++) {
            const time = start + p * 3600000;
            text += `<programme start="${xmlTime(time)}" stop="${xmlTime(time + 3600000)}" channel="${channel.epg_channel_id}"><title>Mock Show ${p % 12} &amp; News</title><desc>Listing ${p} for ${esc(channel.name)}.</desc><category>Mock</category></programme>\n`;
          }
          await write(text);
          if (options.xmlChunkDelayMs) await wait(options.xmlChunkDelayMs);
          else if (index % 16 === 0) await new Promise((r) => setImmediate(r));
        }
      }
      if (!res.destroyed) { await write('</tv>\n'); complete = true; output.end(); }
      else if (options.xmlGzip) output.destroy();
    } catch {
      if (options.xmlGzip) output.destroy();
      if (!res.destroyed) res.destroy();
    }
  }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fixture.local');
    const q = u.searchParams;
    if (u.pathname === '/__test/stats') return json(res, { ...stats, sizes: { channels: live.length, movies: vod.length, series: series.length, programmes: options.programmes } });
    if (u.pathname === '/__test/health') return json(res, { ok: true });
    if (options.streamMode === 'fixture' && u.pathname.startsWith('/fixtures/')) return media(req, res, u.pathname.slice('/fixtures/'.length));
    const authed = q.get('username') === 'demo' && q.get('password') === 'demo';
    if (u.pathname === '/player_api.php') {
      if (!authed) return json(res, { user_info: { auth: 0 } });
      const action = q.get('action');
      const category = q.get('category_id');
      count(action ? `${action}${category ? ':category' : ':all'}` : 'login');
      if (options.apiDelayMs) await wait(options.apiDelayMs);
      if (res.destroyed) return;
      switch (action) {
        case null: return json(res, {
          user_info: { username: 'demo', auth: 1, status: 'Active', exp_date: String(Math.floor(options.clock / 1000) + 90 * 86400), max_connections: '2', active_cons: '0', allowed_output_formats: options.streamMode === 'fixture' ? ['m3u8'] : ['m3u8', 'ts'] },
          server_info: { url: 'localhost', port: String(server.address()?.port || 8790), timezone: 'UTC', timestamp_now: Math.floor(options.clock / 1000) },
        });
        case 'get_live_categories': return json(res, liveCats);
        case 'get_live_streams': return json(res, category ? live.filter((s) => s.category_id === category) : live);
        case 'get_vod_categories': return json(res, vodCats);
        case 'get_vod_streams': return json(res, category ? vod.filter((s) => s.category_id === category) : vod);
        case 'get_vod_info': {
          const movie = vod.find((s) => String(s.stream_id) === q.get('vod_id'));
          return json(res, { info: { plot: `${movie?.name || 'Movie'} — mock movie.`, genre: 'Test', duration: '00:12:14', releasedate: '2012-09-26', rating: movie?.rating }, movie_data: movie });
        }
        case 'get_series_categories': return json(res, seriesCats);
        case 'get_series': return json(res, category ? series.filter((s) => s.category_id === category) : series);
        case 'get_series_info': return json(res, {
          info: { ...(series.find((s) => String(s.series_id) === q.get('series_id')) || series[0]), backdrop_path: [] },
          seasons: [{ season_number: 1, name: 'Season 1' }, { season_number: 2, name: 'Season 2' }],
          episodes: Object.fromEntries(Object.entries(episodes).map(([season, list]) => [season, list.map((e) => ({ ...e, season: Number(season) }))])),
        });
        case 'get_simple_data_table': return json(res, { epg_listings: [] });
        default: return json(res, []);
      }
    }
    if (u.pathname === '/xmltv.php') {
      count('xmltv');
      if (!authed) { res.writeHead(401); return res.end(); }
      return void guide(res);
    }
    if (/^\/(live|movie|series|timeshift)\//.test(u.pathname)) {
      count('stream');
      if (options.streamMode === 'fixture') {
        if (u.pathname.startsWith('/live/') || u.pathname.startsWith('/timeshift/')) {
          res.writeHead(302, { location: 'http://' + req.headers.host + '/fixtures/playback.m3u8' });
          return res.end();
        }
        return media(req, res, 'playback.mp4');
      }
      if (options.streamMode === 'unavailable') { res.writeHead(503); return res.end('Fixture playback disabled'); }
      const id = Number(/(\d+)\.\w+$/.exec(u.pathname)?.[1] || 0);
      res.writeHead(302, { location: HLS[id % HLS.length] });
      return res.end();
    }
    res.writeHead(404); res.end('not found');
  });
  return { server, stats, options };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, options } = createMockPanel(mockOptions());
  const port = Number(process.env.PORT || 8790);
  const host = process.env.MOCK_HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Mock Xtream on http://${host}:${server.address().port} (demo/demo), ${options.channels} channels / ${options.movies} movies / ${options.series} series`));
}
