#!/usr/bin/env node
// Development-only fake Xtream Codes panel backed by public test streams.
// Lets you exercise login, live categories, XMLTV (gzipped), catch-up, movies and series
// without a real subscription:  node server/mock-xtream.mjs  → http://localhost:8790
// Login with username "demo" / password "demo".

import http from 'node:http';
import { gzipSync } from 'node:zlib';

const PORT = Number(process.env.PORT || 8790);
const USER = 'demo';
const PASS = 'demo';

const HLS = [
  'https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8',
  'https://fcc3ddae59ed.us-west-2.playback.live-video.net/api/video/v1/us-west-2.893648527354.channel.DmumNckWFTqz.m3u8',
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
  'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
  'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8',
];

const liveCats = [
  { category_id: '1', category_name: 'UK | Entertainment', parent_id: 0 },
  { category_id: '2', category_name: 'UK | Sports', parent_id: 0 },
  { category_id: '3', category_name: 'DE | Nachrichten', parent_id: 0 },
];
const names = [
  ['BBC One HD', 'ITV 1', 'Channel 4', 'Sky Max', 'Dave'],
  ['Sky Sports Main Event', 'Sky Sports F1', 'TNT Sports 1', 'Premier Sports 1'],
  ['Das Erste', 'ZDF', 'n-tv', 'WELT', 'tagesschau24'],
];
const live = [];
let sid = 1000;
names.forEach((list, ci) =>
  list.forEach((name) => {
    const id = sid++;
    live.push({
      num: live.length + 1,
      name,
      stream_type: 'live',
      stream_id: id,
      stream_icon: '',
      epg_channel_id: name.toLowerCase().replace(/[^a-z0-9]+/g, '.') + 'uk',
      added: '1700000000',
      category_id: liveCats[ci].category_id,
      tv_archive: id % 2,
      tv_archive_duration: id % 2 ? 7 : 0,
    });
  })
);

const vodCats = [
  { category_id: '10', category_name: 'Movies | Action' },
  { category_id: '11', category_name: 'Movies | Animation' },
];
const vod = [
  { stream_id: 5001, name: 'Tears of Steel', category_id: '10', rating: '6.6', container_extension: 'm3u8', url: HLS[4] },
  { stream_id: 5002, name: 'Angel One', category_id: '10', rating: '6.1', container_extension: 'm3u8', url: HLS[5] },
  { stream_id: 5003, name: 'Big Buck Bunny', category_id: '11', rating: '7.2', container_extension: 'm3u8', url: HLS[2] },
  { stream_id: 5004, name: 'BipBop', category_id: '11', rating: '5.0', container_extension: 'm3u8', url: HLS[3] },
];
const seriesCats = [{ category_id: '20', category_name: 'Series | Demo' }];
const series = [{ series_id: 7001, name: 'Stream Lab', cover: '', plot: 'A test series.', genre: 'Tech', releaseDate: '2021-01-01', rating: '7', category_id: '20' }];
const episodes = {
  1: [
    { id: '9001', episode_num: 1, title: 'Pilot', container_extension: 'm3u8', info: { plot: 'First episode', duration: '00:10:00' }, url: HLS[2] },
    { id: '9002', episode_num: 2, title: 'Second', container_extension: 'm3u8', info: { plot: 'Second episode', duration: '00:12:00' }, url: HLS[4] },
  ],
  2: [{ id: '9003', episode_num: 1, title: 'Return', container_extension: 'm3u8', info: { plot: 'Season two', duration: '00:09:00' }, url: HLS[5] }],
};

const pad = (n) => String(n).padStart(2, '0');
const xmltvTime = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function xmltv() {
  const shows = ['Morning News', 'Quiz & Win', 'Premier Live', 'Documentary: Oceans', 'Late Film', 'Tagesschau', 'Weather', 'Comedy Hour'];
  const hour = 3600000;
  const start = Math.floor((Date.now() - 2 * 86400000) / hour) * hour;
  const end = Date.now() + 3 * 86400000;
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="mock">\n';
  for (const c of live) out += `  <channel id="${c.epg_channel_id}"><display-name>${esc(c.name)}</display-name></channel>\n`;
  live.forEach((c, i) => {
    let t = start;
    let k = i;
    while (t < end) {
      const len = [30, 60, 90][k % 3] * 60000;
      const title = shows[k++ % shows.length];
      out += `  <programme start="${xmltvTime(t)}" stop="${xmltvTime(t + len)}" channel="${c.epg_channel_id}"><title lang="en">${esc(title)}</title><desc lang="en">${esc(title)} on ${esc(c.name)} — mock listing.</desc><category>Mock</category></programme>\n`;
      t += len;
    }
  });
  return out + '</tv>\n';
}

const json = (res, data) => {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data));
};

http
  .createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const q = u.searchParams;
    console.log(req.method, u.pathname, q.get('action') || '');
    const authed = q.get('username') === USER && q.get('password') === PASS;

    if (u.pathname === '/player_api.php') {
      if (!authed) return json(res, { user_info: { auth: 0 } });
      const action = q.get('action');
      const cat = q.get('category_id');
      switch (action) {
        case null:
          return json(res, {
            user_info: { username: USER, auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 90 * 86400), max_connections: '2', active_cons: '0', allowed_output_formats: ['m3u8', 'ts'] },
            server_info: { url: 'localhost', port: String(PORT), timezone: 'Europe/London', timestamp_now: Math.floor(Date.now() / 1000) },
          });
        case 'get_live_categories':
          return json(res, liveCats);
        case 'get_live_streams':
          return json(res, cat ? live.filter((s) => s.category_id === cat) : live);
        case 'get_vod_categories':
          return json(res, vodCats);
        case 'get_vod_streams':
          return json(res, (cat ? vod.filter((s) => s.category_id === cat) : vod).map(({ url, ...s }) => ({ ...s, stream_type: 'movie', stream_icon: '' })));
        case 'get_vod_info': {
          const v = vod.find((x) => String(x.stream_id) === q.get('vod_id'));
          return json(res, { info: { plot: `${v?.name} — a mock movie for testing.`, genre: 'Test', duration: '00:12:14', releasedate: '2012-09-26', rating: v?.rating }, movie_data: v });
        }
        case 'get_series_categories':
          return json(res, seriesCats);
        case 'get_series':
          return json(res, series);
        case 'get_series_info':
          return json(res, {
            info: { ...series[0], backdrop_path: [] },
            seasons: [
              { season_number: 1, name: 'Season 1' },
              { season_number: 2, name: 'Season 2' },
            ],
            episodes: Object.fromEntries(Object.entries(episodes).map(([k, list]) => [k, list.map(({ url, ...e }) => ({ ...e, season: Number(k) }))])),
          });
        case 'get_simple_data_table':
          return json(res, { epg_listings: [] });
        default:
          return json(res, []);
      }
    }

    if (u.pathname === '/xmltv.php') {
      if (!authed) {
        res.writeHead(401);
        return res.end();
      }
      const body = gzipSync(xmltv());
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      return res.end(body);
    }

    // stream endpoints: redirect to public test streams
    const m = /^\/(live|movie|series|timeshift)\/([^/]+)\/([^/]+)\/(?:\d+\/[^/]+\/)?(\d+)\.(\w+)$/.exec(u.pathname);
    if (m) {
      const [, kind, , , idStr] = m;
      const id = Number(idStr);
      let target = HLS[id % HLS.length];
      if (kind === 'movie') target = vod.find((v) => v.stream_id === id)?.url ?? target;
      if (kind === 'series') target = Object.values(episodes).flat().find((e) => e.id === idStr)?.url ?? target;
      if (kind === 'live') target = HLS[live.findIndex((l) => l.stream_id === id) % 2];
      res.writeHead(302, { location: target });
      return res.end();
    }

    res.writeHead(404);
    res.end('not found');
  })
  .listen(PORT, () => console.log(`Mock Xtream panel on http://localhost:${PORT} (user demo / pass demo)`));
