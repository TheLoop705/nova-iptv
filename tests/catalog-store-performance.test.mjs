import test from 'node:test';
import assert from 'node:assert/strict';
import { appModule } from './helpers/load-app-module.mjs';

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const channel = { id: 'x1', streamId: 1, num: 1, name: 'One', group: 'Live', url: '' };
const series = { id: 's1', seriesId: 1, name: 'Series', categoryId: '1' };
const movie = (id = 'v1', categoryId = '1') => ({ id, streamId: Number(id.slice(1)), name: id, categoryId });
const account = { formats: ['ts'] };
const info = { seasons: [{ season: 1, name: 'Season 1', episodes: [{ id: '1', season: 1, episode: 1, title: 'Pilot', url: 'https://example.test/1.mp4' }, { id: '2', season: 1, episode: 2, title: 'Next', url: 'https://example.test/2.mp4' }] }] };
globalThis.__catalogSettings = { playlists: [], prefs: { epgRefreshHours: 12, epgPastDays: 1, epgFutureDays: 2 }, vodProgress: {}, history: {} };
globalThis.__catalogApi = {};
const storage = new Map();
globalThis.__catalogStorage = { getItem: async (key) => storage.get(key) ?? null, setItem: async (key, value) => { storage.set(key, value); }, removeItem: async (key) => { storage.delete(key); }, removeByPrefix: async (prefix) => { for (const key of storage.keys()) if (key.startsWith(prefix)) storage.delete(key); } };
globalThis.__catalogPlayer = { playVod() {} };
globalThis.__catalogHttp = { streamCalls: 0 };
const apiNames = ['xtreamLogin', 'xtreamLive', 'xtreamEpgUrl', 'xtreamMovies', 'xtreamSeries', 'xtreamVodCategories', 'xtreamSeriesCategories', 'xtreamShortEpg', 'xtreamMovieInfo', 'xtreamSeriesInfo', 'xtreamMovieUrl', 'xtreamEpisodeUrl'];
const mocks = {
  'react-native': 'export const Platform = { OS: "web" };',
  'src/services/storage': 'export const getItem = (...a) => globalThis.__catalogStorage.getItem(...a); export const setItem = (...a) => globalThis.__catalogStorage.setItem(...a); export const removeItem = (...a) => globalThis.__catalogStorage.removeItem(...a); export const removeByPrefix = (...a) => globalThis.__catalogStorage.removeByPrefix(...a);',
  'src/store/settings': 'export const useSettings = { getState: () => globalThis.__catalogSettings }; export const favCatKey = (...a) => a.join(":"); export const watchId = { series: id => id, movie: id => id };',
  'src/services/xtream': 'export class AuthError extends Error {}\n' + apiNames.map((name) => `export const ${name} = (...a) => globalThis.__catalogApi.${name}(...a);`).join('\n'),
  'src/services/http': 'export const fetchText = async () => ""; export const streamText = async (_url, _opts, onText) => { globalThis.__catalogHttp.streamCalls++; await onText("<tv/>"); };',
  'src/store/player': 'export const usePlayer = { getState: () => globalThis.__catalogPlayer };',
  'src/store/ui': 'export const useUI = { getState: () => ({ showToast() {}, setDetail() {} }) };',
};
const { useLibrary } = await appModule('src/store/library.ts', mocks);
const vod = await appModule('src/services/vod.ts');
const { writePlaylistCache } = await appModule('src/services/playlistCache.ts');
const { writeEpgCache } = await appModule('src/services/epgCache.ts');
const { playlistSource } = await appModule('src/services/playlistSource.ts');

function seed(id = 'a') {
  const p = { id, name: id, type: 'xtream', server: 'https://example.test', username: 'test', password: 'test', createdAt: 1 };
  globalThis.__catalogSettings.playlists = [p];
  useLibrary.setState({ playlistId: id, status: 'ready', channels: [channel], byId: { x1: channel } });
  return p;
}
test.beforeEach(() => {
  useLibrary.getState().reset();
  storage.clear();
  globalThis.__catalogHttp.streamCalls = 0;
  globalThis.__catalogSettings.vodProgress = {};
  globalThis.__catalogSettings.history = {};
  globalThis.__catalogSettings.pushHistory = () => {};
  globalThis.__catalogPlayer.playVod = () => {};
  globalThis.__catalogApi = { xtreamLogin: async () => account, xtreamLive: async () => [channel], xtreamEpgUrl: () => '', xtreamMovies: async () => [], xtreamSeries: async () => [], xtreamVodCategories: async () => [], xtreamSeriesCategories: async () => [], xtreamShortEpg: async () => [], xtreamMovieInfo: async () => ({}), xtreamSeriesInfo: async () => info, xtreamMovieUrl: () => 'https://example.test/movie.mp4', xtreamEpisodeUrl: (p, id, ext) => `${p.server}/series/${encodeURIComponent(p.username)}/${encodeURIComponent(p.password)}/${id}.${ext}` };
});
test.afterEach(() => useLibrary.getState().reset());

test('concurrent category consumers share one request and wait for its result', async () => {
  seed();
  let calls = 0;
  globalThis.__catalogApi.xtreamVodCategories = async () => { calls++; await pause(5); return [{ id: '1', name: 'Movies' }]; };
  await Promise.all([useLibrary.getState().loadMovieCats(), useLibrary.getState().loadMovieCats(), useLibrary.getState().loadMovieCats()]);
  assert.equal(calls, 1);
  assert.equal(useLibrary.getState().vodStatus.movieCats, 'ready');
  assert.equal(useLibrary.getState().movieCats[0].id, '1');
});

test('prototype-like provider category IDs are loaded as ordinary categories', async () => {
  seed();
  const categories = [];
  globalThis.__catalogApi.xtreamMovies = async (_p, category) => { categories.push(category); return [movie('v1', category)]; };
  await useLibrary.getState().loadMovies('ordinary');
  for (const id of ['constructor', '__proto__', 'toString']) await useLibrary.getState().loadMovies(id);
  assert.deepEqual(categories, ['ordinary', 'constructor', '__proto__', 'toString']);
});

test('full listings coalesce, retain a successful half and retry only a failed half', async () => {
  seed();
  let movies = 0, seriesCalls = 0;
  globalThis.__catalogApi.xtreamMovies = async () => { movies++; await pause(5); return [movie(), movie('v1', '2')]; };
  globalThis.__catalogApi.xtreamSeries = async () => { if (++seriesCalls === 1) throw Error('Unavailable'); return [series]; };
  await Promise.all([useLibrary.getState().loadAllVod(), useLibrary.getState().loadAllVod()]);
  assert.equal(movies, 1);
  assert.equal(seriesCalls, 1);
  assert.equal(useLibrary.getState().movieCount, 1);
  assert.equal(useLibrary.getState().vodAllLoaded, false);
  assert.equal(useLibrary.getState().vodStatus.all, 'error');
  await useLibrary.getState().loadAllVod();
  assert.equal(movies, 1);
  assert.equal(seriesCalls, 2);
  assert.equal(useLibrary.getState().seriesCount, 1);
  assert.equal(useLibrary.getState().vodAllLoaded, true);
});

test('category results cannot cross a reset or an A-to-B-to-A playlist switch', async () => {
  seed();
  let finish, networkSignal;
  globalThis.__catalogApi.xtreamMovies = (_p, _category, signal) => { networkSignal = signal; return new Promise((resolve) => { finish = resolve; }); };
  const pending = useLibrary.getState().loadMovies('1');
  await pause();
  useLibrary.getState().reset();
  seed('b');
  useLibrary.getState().reset();
  seed('a');
  assert.equal(networkSignal.aborted, true);
  finish([movie()]);
  await pending;
  assert.deepEqual(useLibrary.getState().movies, {});
  assert.deepEqual(useLibrary.getState().vodStatus, {});
});

test('a late category response cannot replace a newer complete catalog or its exact count', async () => {
  seed();
  let finishCategory;
  globalThis.__catalogApi.xtreamMovies = (_p, category) => category ? new Promise((resolve) => { finishCategory = resolve; }) : Promise.resolve([movie('v2')]);
  const category = useLibrary.getState().loadMovies('1');
  await pause();
  await useLibrary.getState().loadAllVod();
  finishCategory([movie('v1')]);
  await category;
  assert.equal(useLibrary.getState().movieCount, 1);
  assert.deepEqual(useLibrary.getState().movies['1'].map((m) => m.id), ['v2']);
});

test('forced refresh clears cancelled loading flags and loaded totals', async () => {
  const p = seed();
  let finish, networkSignal;
  globalThis.__catalogApi.xtreamMovies = (_p, _category, signal) => { networkSignal = signal; return new Promise((resolve) => { finish = resolve; }); };
  const pending = useLibrary.getState().loadAllVod();
  await pause();
  assert.equal(useLibrary.getState().vodStatus.all, 'loading');
  await useLibrary.getState().load(p, { force: true });
  assert.equal(networkSignal.aborted, true);
  assert.equal(useLibrary.getState().vodStatus.all, undefined);
  assert.equal(useLibrary.getState().movieCount, undefined);
  finish([movie()]);
  await pending;
  assert.deepEqual(useLibrary.getState().movies, {});
});

test('series details reuse downloads and provider IDs cannot contaminate a second playlist', async () => {
  seed();
  let calls = 0;
  globalThis.__catalogApi.xtreamSeriesInfo = async () => { calls++; await pause(5); return info; };
  await Promise.all([vod.loadSeriesInfo(series), vod.loadSeriesInfo(series)]);
  await vod.loadSeriesInfo(series);
  assert.equal(calls, 1);
  assert.equal(vod.nextEpisode(series, info.seasons[0].episodes[0]).id, '2');
  useLibrary.getState().reset();
  seed('b');
  assert.equal(vod.nextEpisode(series, info.seasons[0].episodes[0]), undefined);
  await vod.loadSeriesInfo(series);
  assert.equal(calls, 2);
});

test('playlist switches cancel metadata requests even if the provider resolves after cancellation', async () => {
  seed();
  let finish, networkSignal;
  globalThis.__catalogApi.xtreamSeriesInfo = (_p, _id, signal) => { networkSignal = signal; return new Promise((resolve) => { finish = resolve; }); };
  const pending = vod.loadSeriesInfo(series);
  await pause();
  useLibrary.getState().reset();
  seed('b');
  assert.equal(networkSignal.aborted, true);
  finish(info);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(vod.nextEpisode(series, info.seasons[0].episodes[0]), undefined);
});

test('an asynchronous Home resume cannot start the old provider after a playlist switch', async () => {
  seed();
  let finish;
  let plays = 0;
  globalThis.__catalogPlayer.playVod = () => plays++;
  globalThis.__catalogApi.xtreamSeriesInfo = () => new Promise((resolve) => { finish = resolve; });
  const pending = vod.resumeEpisode(series, info.seasons[0].episodes[0]);
  await pause();
  useLibrary.getState().reset();
  seed('b');
  finish(info);
  await pending;
  assert.equal(plays, 0);
});

test('clearing derived caches preserves an imported playlist so it can be refreshed', async () => {
  const p = { id: 'file', name: 'Import', type: 'm3u', inline: true, sourceRevision: 'first', createdAt: 1 };
  const text = '#EXTM3U\n#EXTINF:-1 tvg-id="import" group-title="Live",Imported channel\nhttps://example.test/live.ts';
  globalThis.__catalogSettings.playlists = [p];
  storage.set('m3u:file', text);
  await useLibrary.getState().load(p);
  await pause();
  await writeEpgCache(p.id, { fetchedAt: Date.now(), programs: { import: [{ start: 1, end: 2, title: 'Guide' }] }, names: {}, icons: {} });
  assert.equal(storage.has('pl-parts:file'), true);
  assert.equal(storage.has('epg-parts:file'), true);
  await useLibrary.getState().clearCache(p.id);
  assert.equal(storage.get('m3u:file'), text);
  assert.equal(storage.has('pl-parts:file'), false);
  assert.equal(storage.has('epg-parts:file'), false);
  await useLibrary.getState().load(p, { force: true });
  await useLibrary.getState().loadChannels();
  assert.equal(useLibrary.getState().status, 'ready');
  assert.equal(useLibrary.getState().channels[0].name, 'Imported channel');
  await useLibrary.getState().clearCache(p.id, { removeSource: true });
  assert.equal(storage.has('m3u:file'), false);
});

test('same-ID source invalidation cancels an old download before replacing its cached channels', async () => {
  const original = seed();
  let finishOld, oldSignal, calls = 0;
  globalThis.__catalogApi.xtreamLive = (_p, signal) => {
    calls++;
    if (calls === 1) {
      oldSignal = signal;
      return new Promise((resolve) => { finishOld = resolve; });
    }
    return Promise.resolve([{ ...channel, id: 'x2', name: 'New provider' }]);
  };
  await useLibrary.getState().load(original, { force: true });
  const oldLoad = useLibrary.getState().loadChannels({ force: true });
  await pause();
  const updated = { ...original, password: 'replacement' };
  globalThis.__catalogSettings.playlists = [updated];
  await useLibrary.getState().clearCache(updated.id);
  assert.equal(oldSignal.aborted, true);
  await useLibrary.getState().load(updated, { force: true });
  await useLibrary.getState().loadChannels();
  finishOld([{ ...channel, name: 'Stale provider' }]);
  await oldLoad;
  assert.equal(calls, 2);
  assert.equal(useLibrary.getState().channels[0].name, 'New provider');
  const manifest = storage.get('pl-parts:a');
  assert.equal(storage.get(`pl-parts:a:${manifest.token}:channels:0`)[0].name, 'New provider');
});

test('clearing another playlist preserves the active generation and removes only its derived cache', async () => {
  seed('a');
  storage.set('m3u:b', '#EXTM3U');
  await writePlaylistCache('b', { fetchedAt: Date.now(), channels: [channel], movies: [], epgUrls: [] });
  await useLibrary.getState().clearCache('b');
  assert.equal(useLibrary.getState().playlistId, 'a');
  assert.equal(useLibrary.getState().status, 'ready');
  assert.equal(storage.get('m3u:b'), '#EXTM3U');
  assert.equal(storage.has('pl-parts:b'), false);
});

test('an inactive source edited on another device refreshes channels and rejects its former fresh guide', async () => {
  const original = { ...seed('b'), epgUrl: 'https://example.test/guide.xml' };
  const oldChannel = { ...channel, tvgId: 'guide1', name: 'Old provider' };
  await writePlaylistCache('b', { fetchedAt: Date.now(), channels: [oldChannel], movies: [], epgUrls: [original.epgUrl], source: playlistSource(original) });
  await writeEpgCache('b', { fetchedAt: Date.now(), programs: { guide1: [{ start: Date.now() - 1000, end: Date.now() + 60000, title: 'Stale guide' }] }, names: {}, icons: {} });
  useLibrary.getState().reset();
  seed('a');
  const updated = { ...original, password: 'remote replacement' };
  globalThis.__catalogSettings.playlists.push(updated);
  let liveCalls = 0;
  globalThis.__catalogApi.xtreamLive = async () => { liveCalls++; return [{ ...oldChannel, name: 'New provider' }]; };
  const published = [];
  const unsubscribe = useLibrary.subscribe((state) => {
    for (const rows of Object.values(state.epg)) for (const program of rows) published.push(program.title);
  });
  await useLibrary.getState().load(updated);
  await useLibrary.getState().loadChannels();
  await useLibrary.getState().refreshEpg();
  unsubscribe();
  assert.equal(liveCalls, 1);
  assert.equal(useLibrary.getState().channels[0].name, 'New provider');
  assert.equal(published.includes('Stale guide'), false);
  assert.equal(globalThis.__catalogHttp.streamCalls, 1);
  assert.deepEqual(storage.get('pl-parts:b').source, playlistSource(updated));
  useLibrary.getState().reset();
  await useLibrary.getState().load({ ...updated, name: 'Renamed remotely' });
  await useLibrary.getState().loadChannels();
  await useLibrary.getState().refreshEpg();
  assert.equal(liveCalls, 1, 'display-only edits keep a matching channel cache');
  assert.equal(globalThis.__catalogHttp.streamCalls, 1, 'matching source keeps its completed guide cache');
});

test('legacy source-less caches refresh once and subsequently use the identified source cache', async () => {
  const p = seed();
  storage.set('pl:a', { fetchedAt: Date.now(), channels: [{ ...channel, name: 'Legacy provider' }], movies: [], epgUrls: [] });
  let calls = 0;
  globalThis.__catalogApi.xtreamLive = async () => { calls++; return [channel]; };
  await useLibrary.getState().load(p);
  await useLibrary.getState().loadChannels();
  assert.equal(calls, 1);
  assert.equal(useLibrary.getState().channels[0].name, 'One');
  assert.deepEqual(storage.get('pl-parts:a').source, playlistSource(p));
  useLibrary.getState().reset();
  await useLibrary.getState().load(p);
  await useLibrary.getState().loadChannels();
  assert.equal(calls, 1);
});

test('failed invalidation leaves a retryable error instead of exposing a mismatched source cache', async () => {
  const p = seed();
  storage.set('pl:a', { fetchedAt: Date.now(), channels: [channel], movies: [], epgUrls: [] });
  const remove = globalThis.__catalogStorage.removeItem;
  globalThis.__catalogStorage.removeItem = async () => { throw Error('Cache unavailable'); };
  try {
    await useLibrary.getState().load(p);
    assert.equal(useLibrary.getState().catalogStatus, 'error');
    assert.equal(useLibrary.getState().playlistId, p.id);
    assert.equal(useLibrary.getState().catalogError, 'Cache unavailable');
    assert.deepEqual(useLibrary.getState().channels, []);
  } finally { globalThis.__catalogStorage.removeItem = remove; }
  await useLibrary.getState().load(p);
  assert.equal(useLibrary.getState().catalogStatus, 'ready');
});

test('same-ID source edits resume Home and detail episodes with fresh metadata and current credentials', async () => {
  const original = seed();
  const played = [];
  globalThis.__catalogPlayer.playVod = (item, position) => played.push({ item, position });
  await vod.loadSeriesInfo(series);
  vod.playEpisode(series, info.seasons[0].episodes[0]);
  const staleNext = played[0].item.next;
  useLibrary.getState().reset();
  const updated = { ...original, server: 'https://replacement.test', username: 'new user', password: 'new/pass' };
  globalThis.__catalogSettings.playlists = [updated];
  useLibrary.setState({ playlistId: updated.id, status: 'ready', channels: [channel], byId: { x1: channel } });
  globalThis.__catalogSettings.vodProgress['a:ep:1'] = { pos: 45, dur: 100 };
  const fresh = { seasons: [{ season: 1, name: 'Season 1', episodes: info.seasons[0].episodes.map((ep) => ({ ...ep, ext: 'mp4', title: 'Fresh ' + ep.title, url: 'https://stale.example/old-user/old-pass/' + ep.id })) }] };
  globalThis.__catalogApi.xtreamSeriesInfo = async () => fresh;
  played.length = 0;
  const saved = { ...info.seasons[0].episodes[0], url: 'https://old.example/old-user/old-pass/1.mp4' };
  await vod.resumeEpisode(series, saved);
  assert.equal(played[0].position, 45);
  assert.equal(played[0].item.url, 'https://replacement.test/series/new%20user/new%2Fpass/1.mp4');
  assert.match(played[0].item.subtitle, /Fresh Pilot/);
  assert.equal(played[0].item.next.url, 'https://replacement.test/series/new%20user/new%2Fpass/2.mp4');
  vod.playNextItem(staleNext);
  assert.equal(played.length, 1, 'a prior generation cannot autoplay even when episode IDs still exist');
  vod.playNextItem(played[0].item.next);
  assert.equal(played.length, 2);
  assert.equal(played[1].item.url, 'https://replacement.test/series/new%20user/new%2Fpass/2.mp4');
  vod.playEpisode(series, saved);
  assert.equal(played[2].item.url, played[0].item.url, 'detail actions also resolve the current episode URL');
  await vod.continueSeries(series, saved);
  assert.equal(played[3].item.url, played[0].item.url);
});

test('removed episodes fall back to available metadata and an unavailable series cannot resume or autoplay', async () => {
  seed();
  const played = [];
  globalThis.__catalogPlayer.playVod = (item, position) => played.push({ item, position });
  const saved = { ...info.seasons[0].episodes[0], url: 'https://old.example/private/removed.mp4' };
  globalThis.__catalogSettings.vodProgress['a:ep:1'] = { pos: 45, dur: 100 };
  globalThis.__catalogApi.xtreamSeriesInfo = async () => ({ seasons: [{ season: 1, name: 'Season 1', episodes: [{ ...saved, id: 'new', episode: 3, ext: 'mp4', title: 'Available episode' }] }] });
  await vod.resumeEpisode(series, saved);
  assert.equal(played[0].item.url, 'https://example.test/series/test/test/new.mp4');
  assert.equal(played[0].position, undefined, 'removed-episode resume position does not transfer to another episode');
  assert.equal(played[0].item.next, undefined);
  assert.deepEqual(globalThis.__catalogSettings.vodProgress['a:ep:1'], { pos: 45, dur: 100 }, 'watch progress is retained');
  useLibrary.getState().reset();
  seed();
  globalThis.__catalogApi.xtreamSeriesInfo = async () => ({ seasons: [] });
  await vod.resumeEpisode(series, saved);
  await vod.continueSeries(series, saved);
  vod.playNextItem({ ...played[0].item, key: 'a:ep:removed', url: 'https://old.example/private/autoplay.mp4' });
  assert.equal(played.length, 1);
});

test('Home startup loads categories without live channels or guide; repeated Live visits share one download', async () => {
  const p = seed();
  useLibrary.getState().reset();
  let calls = 0, release;
  globalThis.__catalogApi.xtreamLive = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  await useLibrary.getState().load(p);
  await pause();
  assert.equal(useLibrary.getState().catalogStatus, 'ready');
  assert.equal(useLibrary.getState().status, 'idle');
  assert.equal(calls, 0);
  assert.equal(globalThis.__catalogHttp.streamCalls, 0);
  useLibrary.getState().wantChannels();
  useLibrary.getState().wantChannels();
  useLibrary.getState().wantEpg();
  await pause();
  assert.equal(calls, 1);
  release([channel]);
  await useLibrary.getState().loadChannels();
  assert.equal(useLibrary.getState().status, 'ready');
  useLibrary.getState().wantChannels();
  useLibrary.getState().wantEpg();
  await pause();
  assert.equal(calls, 1);
});

test('paged category cache survives restart and a same-ID provider edit cannot reuse its movies', async () => {
  const p = seed();
  let calls = 0;
  globalThis.__catalogApi.xtreamMovies = async () => { calls++; return [movie()]; };
  await useLibrary.getState().loadMovies('1');
  useLibrary.getState().reset();
  seed();
  await useLibrary.getState().loadMovies('1');
  assert.equal(calls, 1);
  useLibrary.getState().reset();
  seed();
  globalThis.__catalogSettings.playlists = [{ ...p, password: 'new-account' }];
  await useLibrary.getState().loadMovies('1');
  assert.equal(calls, 2);
});

test('startup channel intent waits for source invalidation before publishing a cached old provider', async () => {
  const p = seed();
  await writePlaylistCache(p.id, { fetchedAt: Date.now(), channels: [{ ...channel, name: 'Old provider' }], movies: [], epgUrls: [], source: playlistSource(p) });
  useLibrary.getState().reset();
  const updated = { ...p, password: 'new-account' };
  globalThis.__catalogSettings.playlists = [updated];
  const published = [];
  const unsubscribe = useLibrary.subscribe((state) => published.push(...state.channels.map((c) => c.name)));
  const loading = useLibrary.getState().load(updated);
  useLibrary.getState().wantChannels();
  await loading;
  await useLibrary.getState().loadChannels();
  unsubscribe();
  assert.equal(published.includes('Old provider'), false);
  assert.equal(useLibrary.getState().channels[0].name, 'One');
});

test('previous episode playback retains both links and resumes progress using current metadata', async () => {
  seed();
  await vod.loadSeriesInfo(series);
  const played = [];
  globalThis.__catalogPlayer.playVod = (item, at) => played.push({ item, at });
  globalThis.__catalogSettings.vodProgress['a:ep:1'] = { pos: 35, duration: 100, done: false, at: 2 };
  vod.playEpisode(series, info.seasons[0].episodes[1]);
  assert.equal(played[0].item.prev.key, 'a:ep:1');
  vod.playNextItem(played[0].item.prev, true);
  assert.equal(played[1].at, 35);
  assert.equal(played[1].item.next.key, 'a:ep:2');
  assert.equal(vod.seriesResumePoint(series, info).episode.id, '1');
});
