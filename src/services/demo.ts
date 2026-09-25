import type { Category, Channel, Episode, Program, SeriesInfo, SeriesItem, VodItem } from '../types';
import type { EpgData } from './xmltv';

// A built-in playlist of public test streams, with a generated guide,
// so every platform can be tried without an IPTV subscription.

const LIVE = [
  'https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8',
  'https://fcc3ddae59ed.us-west-2.playback.live-video.net/api/video/v1/us-west-2.893648527354.channel.DmumNckWFTqz.m3u8',
  'https://demo.unified-streaming.com/k8s/live/stable/scte35.isml/.m3u8',
];
const VOD = {
  bunny: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  tears: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
  tos: 'https://test-streams.mux.dev/tos_ismc/main.m3u8',
  bipbop: 'https://d2zihajmogu5jn.cloudfront.net/bipbop-advanced/bipbop_16x9_variant.m3u8',
  bipbop43: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8',
  angel: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8',
  blender: 'https://ireplay.tv/test/blender.m3u8',
  wowza: 'https://playertest.longtailvideo.com/adaptive/wowzaid3/playlist.m3u8',
  deltatre: 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8',
};
const V = Object.values(VOD);

const GROUPS: { name: string; channels: string[]; shows: string[] }[] = [
  {
    name: 'News',
    channels: ['Nova News 24', 'World Report', 'Business Live', 'Metro News'],
    shows: ['Morning Briefing', 'World Tonight', 'Markets Now', 'Headline Hour', 'Weather Watch', 'Global Affairs', 'The Newsroom', 'Late Edition'],
  },
  {
    name: 'Sports',
    channels: ['Arena Sports 1', 'Arena Sports 2', 'Motor TV', 'Goal Channel'],
    shows: ['Matchday Live', 'Premier Highlights', 'Grand Prix Qualifying', 'Tennis Masters', 'Sports Centre', 'Fight Night', 'Classic Matches', 'Transfer Talk'],
  },
  {
    name: 'Movies',
    channels: ['Cinema One', 'Cinema Action', 'Classic Films', 'Indie Screen'],
    shows: ['Tears of Steel', 'Big Buck Bunny', 'Sintel', 'The Last Frontier', 'Midnight Express', 'City of Echoes', 'Northern Lights', 'The Long Road'],
  },
  {
    name: 'Documentary',
    channels: ['Planet Docs', 'History Vault', 'Science Plus'],
    shows: ['Ocean Giants', 'Engineering Marvels', 'Ancient Empires', 'Cosmos Explained', 'Wild Africa', 'How It\'s Made', 'Secrets of the Deep'],
  },
  {
    name: 'Kids',
    channels: ['Kids Zone', 'Cartoon Club', 'Junior'],
    shows: ['Bunny Adventures', 'Space Rangers', 'Puzzle Pals', 'Dino Days', 'Art Attack', 'Story Time', 'The Robo Friends'],
  },
  {
    name: 'Music',
    channels: ['Hits Music', 'Rock Arena', 'Chill FM TV'],
    shows: ['Top 40 Countdown', 'Unplugged Sessions', 'Rock Legends', 'Late Night Lounge', 'Festival Live', 'Video Hits'],
  },
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function demoChannels(): Channel[] {
  const out: Channel[] = [];
  let n = 1;
  let v = 0;
  GROUPS.forEach((g, gi) => {
    g.channels.forEach((name, ci) => {
      const live = gi === 0 && ci < LIVE.length ? LIVE[ci] : undefined;
      out.push({
        id: 'demo' + n,
        num: n,
        name,
        group: g.name,
        url: live ?? V[v++ % V.length],
        tvgId: 'demo' + n,
        catchup: ci % 2 === 0 ? { type: 'demo', days: 3 } : undefined,
      });
      n++;
    });
  });
  return out;
}

export function demoEpg(channels: Channel[], pastDays: number, futureDays: number): EpgData {
  const programs: Record<string, Program[]> = {};
  const hour = 3600000;
  const now = Date.now();
  const from = Math.floor((now - pastDays * 86400000) / hour) * hour;
  const to = now + futureDays * 86400000;
  channels.forEach((ch, i) => {
    const group = GROUPS.find((g) => g.name === ch.group)!;
    const r = rng(i * 7919 + 17);
    const list: Program[] = [];
    let t = from;
    let k = Math.floor(r() * group.shows.length);
    while (t < to) {
      const len = [30, 30, 45, 60, 60, 90, 120][Math.floor(r() * 7)] * 60000;
      const title = group.shows[k++ % group.shows.length];
      const ep = 1 + Math.floor(r() * 20);
      list.push({
        start: t,
        end: t + len,
        title,
        desc: `${title} — episode ${ep}. A demo programme generated for the built-in test playlist so the guide, catch-up and reminders can be explored without a subscription.`,
        category: group.name,
      });
      t += len;
    }
    programs[ch.tvgId!] = list;
  });
  return { programs, names: {}, icons: {}, fetchedAt: now };
}

export const demoMovieCats: Category[] = [
  { id: 'anim', name: 'Animation' },
  { id: 'scifi', name: 'Sci-Fi' },
  { id: 'test', name: 'Test Streams' },
];

export function demoMovies(): VodItem[] {
  const m = (id: string, name: string, cat: string, url: string, year: string, rating: string, poster?: string): VodItem => ({
    id: 'dm_' + id,
    name,
    categoryId: cat,
    url,
    year,
    rating,
    poster,
  });
  return [
    m('bunny', 'Big Buck Bunny', 'anim', VOD.bunny, '2008', '7.2'),
    m('sintel', 'Sintel', 'anim', VOD.blender, '2010', '7.4', 'https://upload.wikimedia.org/wikipedia/commons/8/8f/Sintel_poster.jpg'),
    m('tears', 'Tears of Steel', 'scifi', VOD.tears, '2012', '6.6'),
    m('tos4k', 'Tears of Steel (Mux)', 'scifi', VOD.tos, '2012', '6.6'),
    m('angel', 'Angel One', 'scifi', VOD.angel, '2015', '6.1'),
    m('bipbop', 'BipBop Advanced', 'test', VOD.bipbop, '2017', '5.0'),
    m('bipbop43', 'BipBop 4:3', 'test', VOD.bipbop43, '2012', '5.0'),
    m('wowza', 'Wowza ID3 Test', 'test', VOD.wowza, '2016', '4.8'),
    m('deltatre', 'Discontinuity Test', 'test', VOD.deltatre, '2019', '4.5'),
  ];
}

export const demoSeriesCats: Category[] = [{ id: 'shorts', name: 'Open Movie Shorts' }];

export function demoSeries(): SeriesItem[] {
  return [
    {
      id: 'ds_open',
      seriesId: 1,
      name: 'Open Movie Project',
      categoryId: 'shorts',
      year: '2008',
      rating: '7.0',
      plot: 'Blender Foundation open movies collected as a demo series.',
      genre: 'Animation',
    },
    {
      id: 'ds_tests',
      seriesId: 2,
      name: 'Stream Lab',
      categoryId: 'shorts',
      year: '2020',
      rating: '6.0',
      plot: 'A series of streaming test patterns — handy for checking playback on every device.',
      genre: 'Technology',
    },
  ];
}

export function demoSeriesInfo(seriesId: number): SeriesInfo {
  const ep = (id: string, season: number, episode: number, title: string, url: string): Episode => ({
    id,
    season,
    episode,
    title,
    ext: 'm3u8',
    url,
    plot: `${title} — demo episode.`,
  });
  if (seriesId === 1) {
    return {
      plot: 'Blender Foundation open movies collected as a demo series.',
      genre: 'Animation',
      year: '2008',
      rating: '7.0',
      seasons: [
        { season: 1, name: 'Season 1', episodes: [ep('o1', 1, 1, 'Big Buck Bunny', VOD.bunny), ep('o2', 1, 2, 'Sintel', VOD.blender)] },
        { season: 2, name: 'Season 2', episodes: [ep('o3', 2, 1, 'Tears of Steel', VOD.tears), ep('o4', 2, 2, 'Tears of Steel (alt)', VOD.tos)] },
      ],
    };
  }
  return {
    plot: 'A series of streaming test patterns.',
    genre: 'Technology',
    year: '2020',
    rating: '6.0',
    seasons: [
      {
        season: 1,
        name: 'Season 1',
        episodes: [ep('t1', 1, 1, 'BipBop', VOD.bipbop), ep('t2', 1, 2, 'BipBop 4:3', VOD.bipbop43), ep('t3', 1, 3, 'Angel One', VOD.angel)],
      },
    ],
  };
}
