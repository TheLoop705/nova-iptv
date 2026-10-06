import { create } from 'zustand';
import type { Category, Channel, Group, Playlist, Program, SeriesItem, VodItem } from '../types';
import { parseM3UAsync } from '../services/m3u';
import { fetchText, streamText } from '../services/http';
import { getItem, removeItem } from '../services/storage';
import { readPlaylistCache, removePlaylistCache, writePlaylistCache, type PlaylistCache } from '../services/playlistCache';
import { buildEpgIndexAsync } from '../services/epg';
import { readEpgCache, removeEpgCache, writeEpgCache } from '../services/epgCache';
import { createCheckpoint, throwIfAborted } from '../utils/cooperative';
import { emptyEpg, mergeEpg, XmltvParser, type EpgData } from '../services/xmltv';
import {
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
import { groupCatalog } from '../services/catalog';
import { playlistSource, samePlaylistSource } from '../services/playlistSource';
import { favCatKey, useSettings } from './settings';

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface LibraryState {
  playlistId?: string;
  status: Status;
  message?: string;
  error?: string;
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
  /** Exact totals from a complete listing; undefined while browsing category by category. */
  movieCount?: number;
  seriesCount?: number;
  moviesAllLoaded: boolean;
  seriesAllLoaded: boolean;

  load: (p: Playlist, opts?: { force?: boolean }) => Promise<void>;
  refreshEpg: (force?: boolean) => Promise<void>;
  loadMovieCats: () => Promise<void>;
  loadSeriesCats: () => Promise<void>;
  loadMovies: (categoryId: string) => Promise<void>;
  loadSeries: (categoryId: string) => Promise<void>;
  loadShortEpg: (channelId: string) => Promise<void>;
  /** Xtream: fetch every movie and series once (used by search) */
  loadAllVod: () => Promise<void>;
  vodAllLoaded: boolean;
  reset: () => void;
  clearCache: (playlistId: string, opts?: { removeSource?: boolean }) => Promise<void>;
}

const EMPTY = {
  playlistId: undefined,
  status: 'idle' as Status,
  message: undefined,
  error: undefined,
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
  movieCount: undefined as number | undefined,
  seriesCount: undefined as number | undefined,
  moviesAllLoaded: false,
  seriesAllLoaded: false,
  vodAllLoaded: false,
};

async function buildGroups(channels: Channel[], signal?: AbortSignal): Promise<Group[]> {
  const map = new Map<string, Group>();
  const checkpoint = createCheckpoint(signal);
  for (const c of channels) {
    let g = map.get(c.group);
    if (!g) {
      g = { id: 'g:' + c.group, name: c.group, channelIds: [] };
      map.set(c.group, g);
    }
    g.channelIds.push(c.id);
    const pause = checkpoint();
    if (pause) await pause;
  }
  return [...map.values()];
}

const current = () => useSettings.getState().playlists.find((p) => p.id === useLibrary.getState().playlistId);

async function fetchPlaylist(p: Playlist, onMsg: (m: string) => void, signal?: AbortSignal): Promise<PlaylistCache> {
  throwIfAborted(signal);
  if (p.type === 'demo') {
    return { channels: demoChannels(), movies: [], epgUrls: [], fetchedAt: Date.now(), source: playlistSource(p) };
  }
  if (p.type === 'xtream') {
    onMsg('Signing in…');
    const account = await xtreamLogin(p, signal);
    onMsg('Loading channels…');
    const channels = await xtreamLive(p, signal);
    return { channels, movies: [], epgUrls: [xtreamEpgUrl(p)], account, fetchedAt: Date.now(), source: playlistSource(p) };
  }
  onMsg('Downloading playlist…');
  const text = p.inline ? ((await getItem<string>('m3u:' + p.id)) ?? '') : await fetchText(p.url!, { ua: p.userAgent, timeoutMs: 120000, signal });
  throwIfAborted(signal);
  if (!/#EXTM3U|#EXTINF/.test(text.slice(0, 5000))) throw new Error('This does not look like an M3U playlist.');
  onMsg('Reading channels…');
  const res = await parseM3UAsync(text, signal);
  return { channels: res.channels, movies: res.movies, epgUrls: res.epgUrls, fetchedAt: Date.now(), source: playlistSource(p) };
}

const shortEpgTried = new Set<string>();
let playlistController: AbortController | undefined;
let stalePlaylistController: AbortController | undefined;
let libraryGeneration = 0;
export const getLibraryGeneration = () => libraryGeneration;
let epgJob: { generation: number; controller: AbortController; promise: Promise<void> } | undefined;
const shortEpgControllers = new Map<string, AbortController>();

function cancelLibraryWork() {
  playlistController?.abort();
  stalePlaylistController?.abort();
  epgJob?.controller.abort();
  epgJob = undefined;
  for (const controller of shortEpgControllers.values()) controller.abort();
  shortEpgControllers.clear();
  shortEpgTried.clear();
}

const catalogRequests = new Map<string, { generation: number; promise: Promise<void> }>();

/** Share one request and cancel background catalog work on a library switch/reload. */
function catalogRequest(key: string, work: (signal: AbortSignal, isCurrent: () => boolean) => Promise<void>): Promise<void> {
  const generation = getLibraryGeneration();
  const existing = catalogRequests.get(key);
  if (existing && existing.generation === generation) return existing.promise;
  const controller = new AbortController();
  const isCurrent = () => getLibraryGeneration() === generation && !controller.signal.aborted;
  const unsubscribe = useLibrary.subscribe(() => { if (!isCurrent()) controller.abort(); });
  const entry = { generation, promise: Promise.resolve() };
  entry.promise = Promise.resolve().then(() => isCurrent() ? work(controller.signal, isCurrent) : undefined).finally(() => {
    unsubscribe();
    if (catalogRequests.get(key) === entry) catalogRequests.delete(key);
  });
  catalogRequests.set(key, entry);
  return entry.promise;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  ...EMPTY,

  reset: () => {
    libraryGeneration++;
    cancelLibraryWork();
    set({ ...EMPTY });
  },

  load: async (p, opts = {}) => {
    const switching = get().playlistId !== p.id;
    if (!switching && !opts.force && get().status === 'loading') return;
    if (switching || opts.force) {
      libraryGeneration++;
      cancelLibraryWork();
    }
    const generation = libraryGeneration;
    const controller = new AbortController();
    playlistController = controller;
    const signal = controller.signal;
    const isCurrent = () => !signal.aborted && libraryGeneration === generation && get().playlistId === p.id;
    if (switching) {
      shortEpgTried.clear();
      set({ ...EMPTY, playlistId: p.id });
    } else if (opts.force) {
      // Cancelled jobs cannot publish into this generation. Clear their status
      // and cached catalog so an explicit refresh can actually load it again.
      set({ movieCats: null, seriesCats: null, movies: {}, series: {}, vodStatus: {},
        movieCount: undefined, seriesCount: undefined, moviesAllLoaded: false,
        seriesAllLoaded: false, vodAllLoaded: false });
    }
    set({ status: 'loading', error: undefined, message: 'Loading playlist…' });
    try {
      let data = opts.force ? null : await readPlaylistCache(p.id, signal, p);
      if (!isCurrent()) return;
      if (data && (!data.source || !samePlaylistSource(data.source, p))) {
        // An inactive source can be edited from another device. Its same ID
        // does not make this browser's channels or guide valid for the new login.
        // Legacy caches without source identity receive one fresh download.
        const clearing = get().clearCache(p.id);
        const clearedGeneration = libraryGeneration;
        try { await clearing; } catch (error: unknown) {
          if (libraryGeneration === clearedGeneration) set({ playlistId: p.id, status: 'error',
            error: error instanceof Error ? error.message : 'Could not clear the previous playlist cache.' });
          return;
        }
        if (libraryGeneration !== clearedGeneration) return;
        return get().load(p, { force: true });
      }
      const stale = !!data && Date.now() - data.fetchedAt > 24 * 3600000;
      if (data && p.type === 'demo') data = null; // always regenerate demo
      if (!data) {
        data = await fetchPlaylist(p, (m) => { if (isCurrent()) set({ message: m }); }, signal);
        if (!isCurrent()) return;
        if (p.type !== 'demo') await writePlaylistCache(p.id, data, signal).catch(() => {});
      }
      if (!isCurrent()) return;
      await applyPlaylist(data);
      if (!isCurrent()) return;
      set({ status: 'ready', message: undefined });
      void get().refreshEpg(!!opts.force);
      // Background refresh of a stale cache
      if (stale && !opts.force && p.type !== 'demo') {
        stalePlaylistController = new AbortController();
        const staleSignal = stalePlaylistController.signal;
        fetchPlaylist(p, () => {}, staleSignal)
          .then(async (fresh) => {
            if (!isCurrent()) return;
            await writePlaylistCache(p.id, fresh, staleSignal).catch(() => {});
            if (isCurrent()) await applyPlaylist(fresh);
          })
          .catch(() => {});
      }
    } catch (e: any) {
      if (!isCurrent()) return;
      set({ status: 'error', error: e?.message ?? String(e), message: undefined });
    }

    async function applyPlaylist(data: PlaylistCache) {
      const checkpoint = createCheckpoint(signal);
      const byId: Record<string, Channel> = {};
      for (const c of data.channels) {
        byId[c.id] = c;
        const pause = checkpoint();
        if (pause) await pause;
      }
      const groups = await buildGroups(data.channels, signal);
      const movieCategories = new Set<string>();
      const movieIds = new Set<string>();
      const seriesIds = new Set<string>();
      for (const movie of data.movies) {
        movieCategories.add(movie.categoryId);
        const pause = checkpoint();
        if (pause) await pause;
      }
      const movieCats =
        p.type === 'demo'
          ? demoMovieCats
          : p.type === 'm3u'
            ? [...movieCategories].map((c) => ({ id: c, name: c }))
            : get().movieCats;
      const movies: Record<string, VodItem[]> = p.type === 'xtream' ? get().movies : Object.create(null);
      if (p.type === 'm3u') {
        for (const m of data.movies) {
          (movies[m.categoryId] ??= []).push(m);
          movieIds.add(m.id);
          const pause = checkpoint();
          if (pause) await pause;
        }
      } else if (p.type === 'demo') {
        for (const m of demoMovies()) { (movies[m.categoryId] ??= []).push(m); movieIds.add(m.id); }
      }
      const series: Record<string, SeriesItem[]> = p.type === 'xtream' ? get().series : Object.create(null);
      if (p.type === 'demo') for (const s of demoSeries()) { (series[s.categoryId] ??= []).push(s); seriesIds.add(s.id); }
      if (!isCurrent()) return;
      set({
        channels: data.channels,
        byId,
        groups,
        epgUrls: data.epgUrls,
        account: data.account,
        fetchedAt: data.fetchedAt,
        movieCats,
        seriesCats: p.type === 'demo' ? demoSeriesCats : p.type === 'm3u' ? [] : get().seriesCats,
        movies,
        series,
        movieCount: p.type === 'xtream' ? get().movieCount : movieIds.size,
        seriesCount: p.type === 'xtream' ? get().seriesCount : seriesIds.size,
        moviesAllLoaded: p.type !== 'xtream' || get().moviesAllLoaded,
        seriesAllLoaded: p.type !== 'xtream' || get().seriesAllLoaded,
        vodAllLoaded: p.type !== 'xtream' || get().vodAllLoaded,
      });
    }
  },

  refreshEpg: (force = false) => {
    const selected = current();
    if (!selected) return Promise.resolve();
    const p: Playlist = selected;
    const pid = p.id;
    const generation = libraryGeneration;
    if (epgJob?.generation === generation) return epgJob.promise;
    if (force) {
      // An explicit refresh retries completed negative results once. Requests
      // already running still own their channel, so they cannot be duplicated.
      shortEpgTried.clear();
      for (const channelId of shortEpgControllers.keys()) shortEpgTried.add(channelId);
    }
    const controller = new AbortController();
    const signal = controller.signal;
    const isCurrent = () => !signal.aborted && generation === libraryGeneration && get().playlistId === pid;
    const entry = { generation, controller, promise: Promise.resolve() };
    entry.promise = Promise.resolve().then(run).catch((error: unknown) => {
      if (isCurrent()) set({
        epgStatus: Object.keys(get().epg).length ? 'ready' : 'error',
        epgMessage: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => { if (epgJob === entry) epgJob = undefined; });
    epgJob = entry;
    return entry.promise;

    async function run() {
      throwIfAborted(signal);
      const { prefs } = useSettings.getState();
      const channels = get().channels;
      const apply = async (data: EpgData) => {
        const index = await buildEpgIndexAsync(get().channels, data, signal);
        if (!isCurrent()) return;
        set((s) => ({
          epg: index,
          epgFetchedAt: data.fetchedAt,
          epgVersion: s.epgVersion + 1,
        }));
      };

      if (p.type === 'demo') {
        await apply(demoEpg(channels, prefs.epgPastDays, prefs.epgFutureDays));
        if (isCurrent()) set({ epgStatus: 'ready', epgMessage: undefined });
        return;
      }

      const urls = [...new Set(p.epgUrl ? p.epgUrl.split(/[\s,]+/).filter(Boolean) : get().epgUrls)];
      set({ epgStatus: 'loading', epgMessage: 'Reading TV guide…' });
      const cached = await readEpgCache(pid, signal);
      throwIfAborted(signal);
      if (cached) await apply(cached);
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
        ids: new Set<string>(),
        names: new Set<string>(),
        from: Date.now() - prefs.epgPastDays * 86400000,
        to: Date.now() + prefs.epgFutureDays * 86400000,
      };
      const checkpoint = createCheckpoint(signal);
      for (const channel of channels) {
        if (channel.tvgId) {
          filter.ids.add(channel.tvgId.toLowerCase());
          filter.ids.add(channel.tvgId.split('@')[0].toLowerCase());
        }
        for (const name of [channel.name, channel.tvgName]) {
          if (name) filter.names.add(normalizeName(name));
        }
        const pause = checkpoint();
        if (pause) await pause;
      }
      let merged: EpgData | null = null;
      const errors: string[] = [];
      for (const url of urls) {
        throwIfAborted(signal);
        try {
          const parser = new XmltvParser(filter);
          let lastUpdate = 0;
          await streamText(url, { ua: p.userAgent, timeoutMs: 300000, signal }, (chunk) => parser.push(chunk), (bytes) => {
            const now = Date.now();
            if (isCurrent() && now - lastUpdate > 500) {
              lastUpdate = now;
              set({ epgMessage: `Downloading TV guide… ${(bytes / 1048576).toFixed(1)} MB` });
            }
          });
          if (isCurrent()) set({ epgMessage: 'Preparing TV guide…' });
          const data = await parser.finishAsync(signal);
          merged = merged ? mergeEpg(merged, data) : data;
        } catch (e: any) {
          throwIfAborted(signal);
          errors.push(e?.message ?? String(e));
        }
      }
      if (!isCurrent()) return;
      if (merged && Object.keys(merged.programs).length) {
        await apply(merged);
        if (!isCurrent()) return;
        set({ epgStatus: 'ready', epgMessage: undefined });
        await writeEpgCache(pid, merged, signal).catch(() => {});
      } else {
        set({
          epgStatus: cached ? 'ready' : 'error',
          epgMessage: errors[0] ?? 'The TV guide had no programmes matching this playlist.',
        });
        if (!merged) await apply(cached ?? emptyEpg());
        // A valid guide with no matching programmes is still a completed fetch.
        // Remember it so reopening the playlist doesn't repeatedly download it.
        if (merged && !Object.keys(cached?.programs ?? {}).length) {
          await writeEpgCache(pid, merged, signal).catch(() => {});
        }
      }
    }
  },

  loadShortEpg: async (channelId) => {
    const p = current();
    const ch = get().byId[channelId];
    if (!p || p.type !== 'xtream' || !ch?.streamId || get().epg[channelId]?.length) return;
    if (shortEpgTried.has(channelId)) return;
    shortEpgTried.add(channelId);
    const generation = libraryGeneration;
    const controller = new AbortController();
    shortEpgControllers.set(channelId, controller);
    try {
      const list = await xtreamShortEpg(p, ch.streamId, controller.signal);
      if (!list.length || controller.signal.aborted || libraryGeneration !== generation || get().playlistId !== p.id) return;
      // A full-guide refresh may have supplied the row while this request ran.
      if (get().epg[channelId]?.length) return;
      set((s) => ({ epg: { ...s.epg, [channelId]: list }, epgVersion: s.epgVersion + 1 }));
    } catch {
      // guide stays empty for this channel
    } finally {
      if (shortEpgControllers.get(channelId) === controller) shortEpgControllers.delete(channelId);
    }
  },

  loadMovieCats: async () => {
    const p = current();
    if (!p || p.type !== 'xtream' || get().movieCats) return;
    return catalogRequest('movieCats', async (signal, isCurrent) => {
      set((s) => ({ vodStatus: { ...s.vodStatus, movieCats: 'loading' } }));
      try {
        const cats = await xtreamVodCategories(p, signal);
        if (isCurrent()) set((s) => ({ movieCats: cats, vodStatus: { ...s.vodStatus, movieCats: 'ready' } }));
      } catch {
        if (isCurrent()) set((s) => ({ vodStatus: { ...s.vodStatus, movieCats: 'error' } }));
      }
    });
  },

  loadSeriesCats: async () => {
    const p = current();
    if (!p || p.type !== 'xtream' || get().seriesCats) return;
    return catalogRequest('seriesCats', async (signal, isCurrent) => {
      set((s) => ({ vodStatus: { ...s.vodStatus, seriesCats: 'loading' } }));
      try {
        const cats = await xtreamSeriesCategories(p, signal);
        if (isCurrent()) set((s) => ({ seriesCats: cats, vodStatus: { ...s.vodStatus, seriesCats: 'ready' } }));
      } catch {
        if (isCurrent()) set((s) => ({ vodStatus: { ...s.vodStatus, seriesCats: 'error' } }));
      }
    });
  },

  loadMovies: async (categoryId) => {
    const p = current();
    const key = 'm:' + categoryId;
    if (!p || p.type !== 'xtream' || Array.isArray(get().movies[categoryId]) || get().moviesAllLoaded) return;
    if (get().vodStatus.all === 'loading') return get().loadAllVod();
    return catalogRequest(key, async (signal, isCurrent) => {
      set((s) => ({ vodStatus: { ...s.vodStatus, [key]: 'loading' } }));
      try {
        const list = await xtreamMovies(p, categoryId, signal);
        if (isCurrent()) set((s) => ({ movies: s.moviesAllLoaded ? s.movies : { ...s.movies, [categoryId]: list }, vodStatus: { ...s.vodStatus, [key]: 'ready' } }));
      } catch {
        if (isCurrent()) set((s) => ({ vodStatus: { ...s.vodStatus, [key]: 'error' } }));
      }
    });
  },

  loadSeries: async (categoryId) => {
    const p = current();
    const key = 's:' + categoryId;
    if (!p || p.type !== 'xtream' || Array.isArray(get().series[categoryId]) || get().seriesAllLoaded) return;
    if (get().vodStatus.all === 'loading') return get().loadAllVod();
    return catalogRequest(key, async (signal, isCurrent) => {
      set((s) => ({ vodStatus: { ...s.vodStatus, [key]: 'loading' } }));
      try {
        const list = await xtreamSeries(p, categoryId, signal);
        if (isCurrent()) set((s) => ({ series: s.seriesAllLoaded ? s.series : { ...s.series, [categoryId]: list }, vodStatus: { ...s.vodStatus, [key]: 'ready' } }));
      } catch {
        if (isCurrent()) set((s) => ({ vodStatus: { ...s.vodStatus, [key]: 'error' } }));
      }
    });
  },

  loadAllVod: async () => {
    const p = current();
    if (!p || p.type !== 'xtream' || get().vodAllLoaded) return;
    return catalogRequest('all', async (signal, isCurrent) => {
      set((s) => ({ vodStatus: { ...s.vodStatus, all: 'loading' } }));
      // Process one collection at a time: a Fire TV should not retain both raw
      // provider responses plus their normalized copies at once.
      if (!get().moviesAllLoaded) {
        try {
          const data = await groupCatalog(await xtreamMovies(p, undefined, signal), signal);
          if (!isCurrent()) return;
          set({ movies: data.byCategory, movieCount: data.count, moviesAllLoaded: true });
        } catch { if (!isCurrent()) return; }
      }
      if (!get().seriesAllLoaded) {
        try {
          const data = await groupCatalog(await xtreamSeries(p, undefined, signal), signal);
          if (!isCurrent()) return;
          set({ series: data.byCategory, seriesCount: data.count, seriesAllLoaded: true });
        } catch { if (!isCurrent()) return; }
      }
      if (!isCurrent()) return;
      const complete = get().moviesAllLoaded && get().seriesAllLoaded;
      set((s) => ({ vodAllLoaded: complete, vodStatus: { ...s.vodStatus, all: complete ? 'ready' : 'error' } }));
    });
  },

  clearCache: async (playlistId, opts = {}) => {
    if (get().playlistId === playlistId) get().reset();
    await Promise.all([
      removePlaylistCache(playlistId), removeEpgCache(playlistId),
      ...(opts.removeSource ? [removeItem('m3u:' + playlistId)] : []),
    ]);
  },
}));

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
