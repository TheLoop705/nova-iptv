import { create } from 'zustand';
import type { Category, Channel, Group, Playlist, Program, SeriesItem, VodItem } from '../types';
import { parseM3U } from '../services/m3u';
import { fetchText, streamText } from '../services/http';
import { getItem, removeByPrefix, removeItem, setItem } from '../services/storage';
import { buildEpgIndex } from '../services/epg';
import { emptyEpg, mergeEpg, XmltvParser, type EpgData } from '../services/xmltv';
import {
  AuthError,
  xtreamEpgUrl,
  xtreamLive,
  xtreamLogin,
  xtreamMovies,
  xtreamSeries,
  xtreamSeriesCategories,
  xtreamShortEpg,
  xtreamVodCategories,
  type XtreamAccount,
} from '../services/xtream';
import {
  demoChannels,
  demoEpg,
  demoMovieCats,
  demoMovies,
  demoSeries,
  demoSeriesCats,
} from '../services/demo';
import { normalizeName } from '../utils/format';
import { favCatKey, useSettings } from './settings';

interface PlaylistCache {
  channels: Channel[];
  /** M3U movies. Saved on their own (`plvod:`) so Home can read them without the channel list; older caches keep them here. */
  movies?: VodItem[];
  epgUrls: string[];
  account?: XtreamAccount;
  fetchedAt: number;
}

interface M3uVodCache {
  movies: VodItem[];
  fetchedAt: number;
}

const PLAYLIST_TTL = 24 * 3600000;

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface LibraryState {
  playlistId?: string;
  /** Live TV channels: loaded when Live TV (or Search) is opened, not at startup */
  status: Status;
  message?: string;
  error?: string;
  /** movies and series (and for Xtream, signing in): what Home, Movies and Series need */
  catalogStatus: Status;
  catalogError?: string;
  channels: Channel[];
  byId: Record<string, Channel>;
  groups: Group[];
  epgUrls: string[];
  account?: XtreamAccount;
  fetchedAt?: number;

  epg: Record<string, Program[]>;
  epgStatus: Status;
  epgMessage?: string;
  epgFetchedAt?: number;
  epgVersion: number;

  movieCats: Category[] | null;
  seriesCats: Category[] | null;
  movies: Record<string, VodItem[]>;
  series: Record<string, SeriesItem[]>;
  vodStatus: Record<string, Status>;

  /** opens a playlist: movies and series (and the channels too if Live TV is already in use) */
  load: (p: Playlist, opts?: { force?: boolean }) => Promise<void>;
  /** the channel list is needed now (Live TV, Search, starting with the last channel) */
  wantChannels: () => void;
  loadChannels: (opts?: { force?: boolean }) => Promise<void>;
  refreshEpg: (force?: boolean) => Promise<void>;
  /** the guide is needed now (Live TV, live playback, search): loads it once the channels are in */
  wantEpg: (force?: boolean) => void;
  loadMovieCats: () => Promise<void>;
  loadSeriesCats: () => Promise<void>;
  loadMovies: (categoryId: string) => Promise<void>;
  loadSeries: (categoryId: string) => Promise<void>;
  loadShortEpg: (channelId: string) => Promise<void>;
  /** Xtream: fetch every movie and series once (used by search) */
  loadAllVod: () => Promise<void>;
  vodAllLoaded: boolean;
  reset: () => void;
  clearCache: (playlistId: string) => Promise<void>;
}

const EMPTY = {
  playlistId: undefined,
  status: 'idle' as Status,
  message: undefined,
  error: undefined,
  catalogStatus: 'idle' as Status,
  catalogError: undefined,
  channels: [] as Channel[],
  byId: {} as Record<string, Channel>,
  groups: [] as Group[],
  epgUrls: [] as string[],
  account: undefined,
  fetchedAt: undefined,
  epg: {} as Record<string, Program[]>,
  epgStatus: 'idle' as Status,
  epgMessage: undefined,
  epgFetchedAt: undefined,
  epgVersion: 0,
  movieCats: null,
  seriesCats: null,
  movies: {} as Record<string, VodItem[]>,
  series: {} as Record<string, SeriesItem[]>,
  vodStatus: {} as Record<string, Status>,
  vodAllLoaded: false,
};

function buildGroups(channels: Channel[]): Group[] {
  const map = new Map<string, Group>();
  for (const c of channels) {
    let g = map.get(c.group);
    if (!g) {
      g = { id: 'g:' + c.group, name: c.group, channelIds: [] };
      map.set(c.group, g);
    }
    g.channelIds.push(c.id);
  }
  return [...map.values()];
}

const current = () => useSettings.getState().playlists.find((p) => p.id === useLibrary.getState().playlistId);

/** "Loading channels… 4.2 MB", at most a few times a second */
function progressMsg(label: string, onMsg: (m: string) => void) {
  let last = 0;
  return (bytes: number) => {
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    onMsg(`${label} ${(bytes / 1048576).toFixed(1)} MB`);
  };
}

/** `account`: Xtream already signed in (at startup), so fetching the channels doesn't sign in again. */
async function fetchPlaylist(p: Playlist, onMsg: (m: string) => void, account?: XtreamAccount): Promise<PlaylistCache> {
  if (p.type === 'demo') {
    return { channels: demoChannels(), movies: [], epgUrls: [], fetchedAt: Date.now() };
  }
  if (p.type === 'xtream') {
    onMsg(account ? 'Loading channels…' : 'Signing in…');
    // Sign in and download the channel list at the same time; a wrong password still reports the sign-in error
    const live = xtreamLive(p, progressMsg('Loading channels…', onMsg));
    live.catch(() => {});
    const signedIn = account ?? (await xtreamLogin(p));
    const channels = await live;
    return { channels, movies: [], epgUrls: [xtreamEpgUrl(p)], account: signedIn, fetchedAt: Date.now() };
  }
  onMsg('Downloading playlist…');
  const text = p.inline
    ? ((await getItem<string>('m3u:' + p.id)) ?? '')
    : await fetchText(p.url!, { ua: p.userAgent, timeoutMs: 120000, onProgress: progressMsg('Downloading playlist…', onMsg) });
  if (!/#EXTM3U|#EXTINF/.test(text.slice(0, 5000))) throw new Error('This does not look like an M3U playlist.');
  onMsg('Reading channels…');
  const res = parseM3U(text);
  return { channels: res.channels, movies: res.movies, epgUrls: res.epgUrls, fetchedAt: Date.now() };
}

const shortEpgTried = new Set<string>();

// The guide is loaded on first use instead of at startup: its cache alone can take seconds to read on a
// Fire TV stick, and Home (movies and series) doesn't need it.
let epgWanted = false;
let epgStarted = false;
let epgForce = false;
// Live TV has been opened for this playlist: a "Refresh now" reloads its channels too
let channelsWanted = false;

// Xtream movie and series lists are cached per category and shown at once on the next start. Anything
// older than this is fetched again in the background.
const VOD_TTL = 12 * 3600000;
const vodPrefix = (playlistId: string) => `vod:${playlistId}:`;

/**
 * Cache first, then network: applies the saved copy right away and refreshes it when it's old. An empty
 * answer never replaces a saved list (overloaded panels sometimes answer with nothing) and isn't saved.
 */
async function cachedVod<T extends unknown[]>(playlistId: string, part: string, fetch: () => Promise<T>, apply: (v: T) => void): Promise<void> {
  const key = vodPrefix(playlistId) + part;
  const alive = () => useLibrary.getState().playlistId === playlistId;
  const saved = await getItem<{ at: number; v: T }>(key);
  if (!alive()) return;
  if (saved) apply(saved.v);
  if (saved && Date.now() - saved.at < VOD_TTL) return;
  try {
    const v = await fetch();
    if (!alive()) return;
    if (!v.length && saved?.v.length) return;
    apply(v);
    if (v.length) setItem(key, { at: Date.now(), v }).catch(() => {});
  } catch (e) {
    if (!saved) throw e;
  }
}

export const useLibrary = create<LibraryState>((set, get) => ({
  ...EMPTY,

  reset: () => {
    epgWanted = epgStarted = epgForce = channelsWanted = false;
    set({ ...EMPTY });
  },

  load: async (p, opts = {}) => {
    const switching = get().playlistId !== p.id;
    if (switching) {
      shortEpgTried.clear();
      epgWanted = epgStarted = epgForce = channelsWanted = false;
      set({ ...EMPTY, playlistId: p.id });
    }
    const alive = () => get().playlistId === p.id;
    if (opts.force) {
      // "Refresh now" re-reads everything; a channel list not in use is fetched fresh when Live TV opens
      set({ movieCats: null, seriesCats: null, movies: {}, series: {}, vodStatus: {}, vodAllLoaded: false });
      await Promise.all([removeByPrefix(vodPrefix(p.id)), removeItem('plvod:' + p.id), ...(channelsWanted ? [] : [removeItem('pl:' + p.id)])]);
    }
    set({ catalogStatus: 'loading', catalogError: undefined });
    if (channelsWanted) void get().loadChannels({ force: opts.force });
    const fail = (e: unknown) => alive() && set({ catalogStatus: 'error', catalogError: (e as Error)?.message ?? String(e), message: undefined });

    if (p.type === 'demo') {
      applyMovies(demoMovies());
      set({ catalogStatus: 'ready' });
      return;
    }

    if (p.type === 'xtream') {
      // Movies and series load per category as they're shown (cache first). Signing in runs alongside: it
      // gets the account details and catches a wrong password or an expired account, which a saved
      // library would otherwise hide. A network hiccup here stays quiet.
      xtreamLogin(p).then(
        (account) => alive() && set({ account }),
        (e) => e instanceof AuthError && fail(e)
      );
      void get().loadMovieCats();
      void get().loadSeriesCats();
      set({ catalogStatus: 'ready' });
      return;
    }

    // M3U: the movies come from the playlist file
    try {
      const vodKey = 'plvod:' + p.id;
      let vod = opts.force ? null : await getItem<M3uVodCache>(vodKey);
      if (!vod && !opts.force) {
        // saved before movies were kept apart: read the old copy once
        const legacy = await getItem<PlaylistCache>('pl:' + p.id);
        if (legacy?.movies) {
          vod = { movies: legacy.movies, fetchedAt: legacy.fetchedAt };
          setItem(vodKey, vod).catch(() => {});
        }
      }
      if (!alive()) return;
      if (vod) {
        applyMovies(vod.movies);
        set({ catalogStatus: 'ready' });
        if (Date.now() - vod.fetchedAt > PLAYLIST_TTL) {
          fetchPlaylist(p, () => {})
            .then((fresh) => savePlaylist(p, fresh))
            .catch(() => {});
        }
        return;
      }
      const data = await fetchPlaylist(p, (m) => alive() && set({ message: m }));
      await savePlaylist(p, data);
      if (alive()) set({ catalogStatus: 'ready', message: undefined });
    } catch (e) {
      fail(e);
    }
  },

  wantChannels: () => {
    channelsWanted = true;
    if (get().status === 'idle') void get().loadChannels();
  },

  loadChannels: async (opts = {}) => {
    const p = current();
    if (!p) return;
    if (!opts.force && (get().status === 'loading' || get().status === 'ready')) return;
    channelsWanted = true;
    const alive = () => get().playlistId === p.id;
    set({ status: 'loading', error: undefined, message: 'Loading channels…' });
    const cacheKey = 'pl:' + p.id;
    try {
      let data = opts.force || p.type === 'demo' ? null : await getItem<PlaylistCache>(cacheKey);
      const stale = !!data && Date.now() - data.fetchedAt > PLAYLIST_TTL;
      if (!data) {
        data = await fetchPlaylist(p, (m) => alive() && set({ message: m }), get().account);
        await savePlaylist(p, data);
      }
      if (!alive()) return;
      applyChannels(data);
      set({ status: 'ready', message: undefined });
      if (opts.force || epgWanted) {
        const force = !!opts.force || epgForce;
        epgForce = false;
        void get().refreshEpg(force);
      }
      // Background refresh of a stale cache
      if (stale && !opts.force && p.type !== 'demo') {
        fetchPlaylist(p, () => {}, get().account)
          .then((fresh) => savePlaylist(p, fresh))
          .catch(() => {});
      }
    } catch (e: any) {
      if (alive()) set({ status: 'error', error: e?.message ?? String(e), message: undefined });
    }
  },

  wantEpg: (force = false) => {
    epgWanted = true;
    if (force) epgForce = true;
    if (get().status !== 'ready' || (epgStarted && !epgForce)) return;
    const f = epgForce;
    epgForce = false;
    void get().refreshEpg(f);
  },

  refreshEpg: async (force = false) => {
    const p = current();
    if (!p) return;
    epgStarted = true;
    const pid = p.id;
    // Reading a big saved guide takes a moment: say so (this also holds off per-channel guide requests)
    if (get().epgStatus !== 'ready') set({ epgStatus: 'loading', epgMessage: 'Loading TV guide…' });
    const { prefs } = useSettings.getState();
    const channels = get().channels;
    const apply = (data: EpgData) => {
      if (get().playlistId !== pid) return;
      set((s) => ({
        epg: buildEpgIndex(channels, data),
        epgFetchedAt: data.fetchedAt,
        epgVersion: s.epgVersion + 1,
      }));
    };

    if (p.type === 'demo') {
      apply(demoEpg(channels, prefs.epgPastDays, prefs.epgFutureDays));
      set({ epgStatus: 'ready' });
      return;
    }

    const urls = p.epgUrl ? p.epgUrl.split(/[\s,]+/).filter(Boolean) : get().epgUrls;
    const cacheKey = 'epg:' + pid;
    const cached = await getItem<EpgData>(cacheKey);
    if (cached) apply(cached);
    const fresh = cached && Date.now() - cached.fetchedAt < prefs.epgRefreshHours * 3600000;
    if (fresh && !force) {
      set({ epgStatus: 'ready', epgMessage: undefined });
      return;
    }
    if (!urls.length) {
      set({ epgStatus: cached ? 'ready' : 'idle', epgMessage: 'No EPG source' });
      return;
    }

    set({ epgStatus: 'loading', epgMessage: 'Downloading TV guide…' });
    const filter = {
      ids: new Set(channels.filter((c) => c.tvgId).flatMap((c) => [c.tvgId!.toLowerCase(), c.tvgId!.split('@')[0].toLowerCase()])),
      names: new Set(channels.flatMap((c) => [normalizeName(c.name), c.tvgName ? normalizeName(c.tvgName) : '']).filter(Boolean)),
      from: Date.now() - prefs.epgPastDays * 86400000,
      to: Date.now() + prefs.epgFutureDays * 86400000,
    };
    let merged: EpgData | null = null;
    const errors: string[] = [];
    for (const url of urls) {
      try {
        const parser = new XmltvParser(filter);
        let lastUpdate = 0;
        await streamText(url, { ua: p.userAgent, timeoutMs: 300000 }, (chunk) => parser.push(chunk), (bytes) => {
          const now = Date.now();
          if (now - lastUpdate > 500) {
            lastUpdate = now;
            set({ epgMessage: `Downloading TV guide… ${(bytes / 1048576).toFixed(1)} MB` });
          }
        });
        const data = parser.finish();
        merged = merged ? mergeEpg(merged, data) : data;
      } catch (e: any) {
        errors.push(e?.message ?? String(e));
      }
    }
    if (get().playlistId !== pid) return;
    if (merged && Object.keys(merged.programs).length) {
      apply(merged);
      set({ epgStatus: 'ready', epgMessage: undefined });
      setItem(cacheKey, merged).catch(() => {});
    } else {
      set({
        epgStatus: cached ? 'ready' : 'error',
        epgMessage: errors[0] ?? 'The TV guide had no programmes matching this playlist.',
      });
      if (!merged) apply(cached ?? emptyEpg());
    }
  },

  loadShortEpg: async (channelId) => {
    const p = current();
    const ch = get().byId[channelId];
    if (!p || p.type !== 'xtream' || !ch?.streamId || get().epg[channelId]?.length) return;
    if (shortEpgTried.has(channelId)) return;
    shortEpgTried.add(channelId);
    try {
      const list = await xtreamShortEpg(p, ch.streamId);
      if (!list.length) return;
      set((s) => ({ epg: { ...s.epg, [channelId]: list }, epgVersion: s.epgVersion + 1 }));
    } catch {
      // guide stays empty for this channel
    }
  },

  loadMovieCats: async () => {
    const p = current();
    if (!p || p.type !== 'xtream' || get().movieCats || get().vodStatus.movieCats === 'loading') return;
    const alive = () => get().playlistId === p.id;
    set((s) => ({ vodStatus: { ...s.vodStatus, movieCats: 'loading' } }));
    try {
      await cachedVod(p.id, 'movieCats', () => xtreamVodCategories(p), (movieCats) => set({ movieCats }));
      if (alive()) set((s) => ({ movieCats: s.movieCats ?? [], vodStatus: { ...s.vodStatus, movieCats: 'ready' } }));
    } catch (e: any) {
      if (alive()) set((s) => ({ movieCats: [], catalogError: s.catalogError ?? e?.message, vodStatus: { ...s.vodStatus, movieCats: 'error' } }));
    }
  },

  loadSeriesCats: async () => {
    const p = current();
    if (!p || p.type !== 'xtream' || get().seriesCats || get().vodStatus.seriesCats === 'loading') return;
    const alive = () => get().playlistId === p.id;
    set((s) => ({ vodStatus: { ...s.vodStatus, seriesCats: 'loading' } }));
    try {
      await cachedVod(p.id, 'seriesCats', () => xtreamSeriesCategories(p), (seriesCats) => set({ seriesCats }));
      if (alive()) set((s) => ({ seriesCats: s.seriesCats ?? [], vodStatus: { ...s.vodStatus, seriesCats: 'ready' } }));
    } catch (e: any) {
      if (alive()) set((s) => ({ seriesCats: [], catalogError: s.catalogError ?? e?.message, vodStatus: { ...s.vodStatus, seriesCats: 'error' } }));
    }
  },

  loadMovies: async (categoryId) => {
    const p = current();
    const key = 'm:' + categoryId;
    if (!p || p.type !== 'xtream' || get().movies[categoryId] || get().vodStatus[key] === 'loading') return;
    set({ vodStatus: { ...get().vodStatus, [key]: 'loading' } });
    try {
      await cachedVod(p.id, key, () => xtreamMovies(p, categoryId), (list) =>
        set((s) => ({ movies: { ...s.movies, [categoryId]: list }, vodStatus: { ...s.vodStatus, [key]: 'ready' } }))
      );
    } catch {
      if (get().playlistId === p.id) set((s) => ({ vodStatus: { ...s.vodStatus, [key]: 'error' } }));
    }
  },

  loadSeries: async (categoryId) => {
    const p = current();
    const key = 's:' + categoryId;
    if (!p || p.type !== 'xtream' || get().series[categoryId] || get().vodStatus[key] === 'loading') return;
    set({ vodStatus: { ...get().vodStatus, [key]: 'loading' } });
    try {
      await cachedVod(p.id, key, () => xtreamSeries(p, categoryId), (list) =>
        set((s) => ({ series: { ...s.series, [categoryId]: list }, vodStatus: { ...s.vodStatus, [key]: 'ready' } }))
      );
    } catch {
      if (get().playlistId === p.id) set((s) => ({ vodStatus: { ...s.vodStatus, [key]: 'error' } }));
    }
  },

  loadAllVod: async () => {
    const p = current();
    if (!p || p.type !== 'xtream' || get().vodAllLoaded || get().vodStatus.all === 'loading') return;
    set({ vodStatus: { ...get().vodStatus, all: 'loading' } });
    try {
      const [movies, series] = await Promise.all([xtreamMovies(p).catch(() => []), xtreamSeries(p).catch(() => [])]);
      const m: Record<string, VodItem[]> = {};
      for (const it of movies) (m[it.categoryId] ??= []).push(it);
      const sr: Record<string, SeriesItem[]> = {};
      for (const it of series) (sr[it.categoryId] ??= []).push(it);
      set((st) => ({
        movies: { ...m, ...st.movies },
        series: { ...sr, ...st.series },
        vodAllLoaded: true,
        vodStatus: { ...st.vodStatus, all: 'ready' },
      }));
    } catch {
      set((st) => ({ vodStatus: { ...st.vodStatus, all: 'error' } }));
    }
  },

  clearCache: async (playlistId) => {
    await Promise.all([
      removeItem('pl:' + playlistId),
      removeItem('plvod:' + playlistId),
      removeItem('epg:' + playlistId),
      removeItem('m3u:' + playlistId),
      removeByPrefix(vodPrefix(playlistId)),
    ]);
  },
}));

// ---- applying loaded data ----

/** Movies (and series) that come with the playlist itself: M3U VOD entries, the demo. */
function applyMovies(list: VodItem[]) {
  const p = current();
  const movies: Record<string, VodItem[]> = {};
  for (const m of list) (movies[m.categoryId] ??= []).push(m);
  const series: Record<string, SeriesItem[]> = {};
  if (p?.type === 'demo') for (const s of demoSeries()) (series[s.categoryId] ??= []).push(s);
  useLibrary.setState({
    movieCats: p?.type === 'demo' ? demoMovieCats : Object.keys(movies).map((c) => ({ id: c, name: c })),
    seriesCats: p?.type === 'demo' ? demoSeriesCats : [],
    movies,
    series,
  });
}

function applyChannels(data: PlaylistCache) {
  const byId: Record<string, Channel> = {};
  for (const c of data.channels) byId[c.id] = c;
  useLibrary.setState((s) => ({
    channels: data.channels,
    byId,
    groups: buildGroups(data.channels),
    epgUrls: data.epgUrls,
    // a fresh sign-in beats the account saved with the channels
    account: s.account ?? data.account,
    fetchedAt: data.fetchedAt,
  }));
}

/**
 * Saves a freshly fetched playlist. M3U keeps its movies apart from the channels, so opening the app reads
 * only the movies. Whatever of it is already on screen is updated.
 */
async function savePlaylist(p: Playlist, data: PlaylistCache) {
  if (p.type === 'm3u') {
    const { movies = [], ...channels } = data;
    await Promise.all([setItem('pl:' + p.id, channels), setItem('plvod:' + p.id, { movies, fetchedAt: data.fetchedAt })]);
  } else if (p.type === 'xtream') {
    await setItem('pl:' + p.id, data);
  }
  const lib = useLibrary.getState();
  if (lib.playlistId !== p.id) return;
  if (p.type === 'm3u') applyMovies(data.movies ?? []);
  if (lib.status === 'ready') applyChannels(data);
}


// ---- derived groups, including virtual ones (Favorites / Recent / All) ----

export const FAV = 'fav';
export const RECENT = 'recent';
export const ALL = 'all';

export function useAllGroups(): Group[] {
  const groups = useLibrary((s) => s.groups);
  const byId = useLibrary((s) => s.byId);
  const pid = useLibrary((s) => s.playlistId);
  const favs = useSettings((s) => (pid ? s.favorites[pid] : undefined));
  const recents = useSettings((s) => (pid ? s.recents[pid] : undefined));
  const hidden = useSettings((s) => (pid ? s.hiddenGroups[pid] : undefined));
  const favCats = useSettings((s) => (pid ? s.favCategories[favCatKey(pid, 'live')] : undefined));
  const channels = useLibrary((s) => s.channels);
  return useMemoGroups(groups, byId, channels, favs, recents, hidden, favCats);
}

let memo: { key: unknown[]; value: Group[] } | null = null;
function useMemoGroups(
  groups: Group[],
  byId: Record<string, Channel>,
  channels: Channel[],
  favs?: string[],
  recents?: string[],
  hidden?: string[],
  favCats?: string[]
): Group[] {
  const key = [groups, byId, channels, favs, recents, hidden, favCats];
  if (memo && memo.key.every((k, i) => k === key[i])) return memo.value;
  const out: Group[] = [];
  const fav = (favs ?? []).filter((id) => byId[id]);
  if (fav.length) out.push({ id: FAV, name: 'Favorites', channelIds: fav, virtual: true });
  const rec = (recents ?? []).filter((id) => byId[id]);
  if (rec.length) out.push({ id: RECENT, name: 'Recently watched', channelIds: rec, virtual: true });
  out.push({ id: ALL, name: 'All channels', channelIds: channels.map((c) => c.id), virtual: true });
  const hide = new Set(hidden ?? []);
  // favourite categories right after the built-in ones, in playlist order
  const favCat = new Set(favCats ?? []);
  for (const g of groups) if (!hide.has(g.id) && favCat.has(g.id)) out.push({ ...g, favorite: true });
  for (const g of groups) if (!hide.has(g.id) && !favCat.has(g.id)) out.push(g);
  memo = { key, value: out };
  return out;
}
