import { create } from 'zustand';
import { Platform } from 'react-native';
import type { Category, Channel, Group, Playlist, Program, SeriesItem, VodItem } from '../types';
import { parseM3UAsync } from '../services/m3u';
import { fetchText, streamText } from '../services/http';
import { getItem, removeByPrefix, removeItem, setItem } from '../services/storage';
import { readPlaylistCache, removePlaylistCache, writePlaylistCache, type PlaylistCache } from '../services/playlistCache';
import { buildEpgIndexAsync } from '../services/epg';
import { readEpgCache, removeEpgCache, writeEpgCache } from '../services/epgCache';
import { createCheckpoint, throwIfAborted } from '../utils/cooperative';
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
import { groupCatalog } from '../services/catalog';
import { playlistSource, samePlaylistSource, type PlaylistSource } from '../services/playlistSource';
import { withCacheLock } from '../utils/cacheQueue';
import { favCatKey, useSettings } from './settings';

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface LibraryState {
  playlistId?: string;
  status: Status;
  message?: string;
  error?: string;
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
  /** Exact totals from a complete listing; undefined while browsing category by category. */
  movieCount?: number;
  seriesCount?: number;
  moviesAllLoaded: boolean;
  seriesAllLoaded: boolean;

  load: (p: Playlist, opts?: { force?: boolean }) => Promise<void>;
  wantChannels: () => void;
  loadChannels: (opts?: { force?: boolean }) => Promise<void>;
  wantEpg: (force?: boolean) => void;
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

function progressMsg(label: string, onMsg: (m: string) => void) {
  let last = 0;
  return (bytes: number) => {
    if (Date.now() - last < 250) return;
    last = Date.now();
    onMsg(`${label} ${(bytes / 1048576).toFixed(1)} MB`);
  };
}

async function fetchPlaylist(p: Playlist, onMsg: (m: string) => void, signal?: AbortSignal, signedIn?: XtreamAccount): Promise<PlaylistCache> {
  const generation = libraryGeneration;
  if (playlistFetch?.generation === generation && !playlistFetch.signal?.aborted) return playlistFetch.promise;
  const entry = { generation, signal, promise: fetchPlaylistData(p, onMsg, signal, signedIn) };
  playlistFetch = entry;
  void entry.promise.finally(() => { if (playlistFetch === entry) playlistFetch = undefined; }).catch(() => {});
  return entry.promise;
}

async function fetchPlaylistData(p: Playlist, onMsg: (m: string) => void, signal?: AbortSignal, signedIn?: XtreamAccount): Promise<PlaylistCache> {
  throwIfAborted(signal);
  if (p.type === 'demo') {
    return { channels: demoChannels(), movies: [], epgUrls: [], fetchedAt: Date.now(), source: playlistSource(p) };
  }
  if (p.type === 'xtream') {
    onMsg('Signing in…');
    const account = signedIn ?? await xtreamLogin(p, signal);
    onMsg('Loading channels…');
    const channels = await xtreamLive(p, signal, progressMsg('Loading channels…', onMsg));
    return { channels, movies: [], epgUrls: [xtreamEpgUrl(p)], account, fetchedAt: Date.now(), source: playlistSource(p) };
  }
  onMsg('Downloading playlist…');
  const text = p.inline ? ((await getItem<string>('m3u:' + p.id)) ?? '') : await fetchText(p.url!, { ua: p.userAgent, timeoutMs: 120000, signal, onProgress: progressMsg('Downloading playlist…', onMsg) });
  throwIfAborted(signal);
  if (!/#EXTM3U|#EXTINF/.test(text.slice(0, 5000))) throw new Error('This does not look like an M3U playlist.');
  onMsg('Reading channels…');
  const res = await parseM3UAsync(text, signal);
  return { channels: res.channels, movies: res.movies, epgUrls: res.epgUrls, fetchedAt: Date.now(), source: playlistSource(p) };
}

const shortEpgTried = new Set<string>();
let channelsWanted = false;
let epgWanted = false;
let epgStarted = false;
let epgForce = false;
let channelJob: { generation: number; controller: AbortController; promise: Promise<void> } | undefined;
let sourceReadiness: { generation: number; promise: Promise<boolean> } | undefined;
let playlistFetch: { generation: number; signal?: AbortSignal; promise: Promise<PlaylistCache> } | undefined;
let playlistController: AbortController | undefined;
let stalePlaylistController: AbortController | undefined;
let libraryGeneration = 0;
export const getLibraryGeneration = () => libraryGeneration;
let epgJob: { generation: number; controller: AbortController; promise: Promise<void> } | undefined;
const shortEpgControllers = new Map<string, AbortController>();

function cancelLibraryWork() {
  playlistController?.abort();
  stalePlaylistController?.abort();
  channelJob?.controller.abort();
  channelJob = undefined;
  epgJob?.controller.abort();
  epgJob = undefined;
  for (const controller of shortEpgControllers.values()) controller.abort();
  shortEpgControllers.clear();
  shortEpgTried.clear();
}

const catalogRequests = new Map<string, { generation: number; promise: Promise<void> }>();

const PLAYLIST_TTL = 24 * 3600000;
const VOD_TTL = 12 * 3600000;
const vodPrefix = (id: string) => `vod:${id}:`;
interface VodCache { source: PlaylistSource; at: number; token: string; pages: number }
const vodPageKey = (key: string, cache: VodCache, page: number) => `${key}:${cache.token}:${page}`;

/** Cache lists in bounded pages, so native JSON work never grows with a whole catalogue. */
async function readVod<T>(p: Playlist, part: string, signal: AbortSignal): Promise<{ at: number; v: T[] } | null> {
  return withCacheLock(vodPrefix(p.id), async () => {
    const key = vodPrefix(p.id) + part;
    const cache = await getItem<VodCache>(key);
    throwIfAborted(signal);
    if (!cache || !cache.source || !samePlaylistSource(cache.source, p) || !Number.isInteger(cache.pages)) return null;
    const v: T[] = [];
    const checkpoint = createCheckpoint(signal);
    for (let page = 0; page < cache.pages; page++) {
      const rows = await getItem<T[]>(vodPageKey(key, cache, page));
      throwIfAborted(signal);
      if (!Array.isArray(rows)) return null;
      v.push(...rows);
      const pause = checkpoint();
      if (pause) await pause;
    }
    return { at: cache.at, v };
  });
}

async function writeVod<T>(p: Playlist, part: string, list: T[], signal: AbortSignal) {
  return withCacheLock(vodPrefix(p.id), async () => {
    throwIfAborted(signal);
    const key = vodPrefix(p.id) + part;
    const old = await getItem<VodCache>(key);
    const cache: VodCache = { source: playlistSource(p), at: Date.now(), token: Math.random().toString(36).slice(2), pages: 0 };
    const checkpoint = createCheckpoint(signal);
    try {
      for (let start = 0; start < list.length; start += 128) {
        throwIfAborted(signal);
        await setItem(vodPageKey(key, cache, cache.pages), list.slice(start, start + 128));
        cache.pages++;
        const pause = checkpoint();
        if (pause) await pause;
      }
      throwIfAborted(signal);
      await setItem(key, cache);
    } catch (error) {
      for (let page = 0; page < cache.pages; page++) await removeItem(vodPageKey(key, cache, page));
      throw error;
    }
    if (old?.token) for (let page = 0; page < old.pages; page++) {
      await removeItem(vodPageKey(key, old, page));
      const pause = checkpoint();
      if (pause) await pause;
    }
  });
}

async function cachedVod<T>(p: Playlist, part: string, signal: AbortSignal, isCurrent: () => boolean,
  fetch: () => Promise<T[]>, apply: (v: T[]) => Promise<void> | void, ttl = VOD_TTL) {
  const saved = await readVod<T>(p, part, signal);
  if (!isCurrent()) return;
  if (saved) await apply(saved.v);
  if (saved && Date.now() - saved.at < ttl) return;
  try {
    const list = await fetch();
    if (!isCurrent()) return;
    if (!list.length && saved?.v.length) return;
    await apply(list);
    if (isCurrent()) await writeVod(p, part, list, signal).catch(() => {});
  } catch (error) {
    throwIfAborted(signal);
    if (!saved) throw error;
  }
}

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
    epgWanted = epgStarted = epgForce = channelsWanted = false;
    set({ ...EMPTY });
  },

  load: async (p, opts = {}) => {
    const switching = get().playlistId !== p.id;
    if (!switching && !opts.force && get().catalogStatus === 'loading') return;
    if (switching || opts.force) {
      libraryGeneration++;
      cancelLibraryWork();
    }
    if (switching) {
      epgWanted = epgStarted = epgForce = channelsWanted = false;
      set({ ...EMPTY, playlistId: p.id });
    } else if (opts.force) {
      epgStarted = false;
      set({ movieCats: null, seriesCats: null, movies: {}, series: {}, vodStatus: {},
        movieCount: undefined, seriesCount: undefined, moviesAllLoaded: false,
        seriesAllLoaded: false, vodAllLoaded: false });
    }
    const generation = libraryGeneration;
    const controller = new AbortController();
    playlistController = controller;
    const signal = controller.signal;
    const isCurrent = () => !signal.aborted && libraryGeneration === generation && get().playlistId === p.id;
    let sourceChecked!: (ready: boolean) => void;
    sourceReadiness = { generation, promise: new Promise((resolve) => { sourceChecked = resolve; }) };
    set({ catalogStatus: 'loading', catalogError: undefined });
    try {
      // Check only the tiny identity record/manifest before reading any channel pages.
      const source = await getItem<PlaylistSource>('library-source:' + p.id);
      const legacy = source ? null : await getItem<{ source?: PlaylistSource }>('pl-parts:' + p.id)
        ?? (Platform.OS === 'web' ? await getItem<{ source?: PlaylistSource }>('pl:' + p.id) : null);
      throwIfAborted(signal);
      const mismatch = source ? !samePlaylistSource(source, p) : !legacy?.source || !samePlaylistSource(legacy.source, p);
      if (mismatch) set({ channels: [], byId: {}, groups: [], status: 'idle', account: undefined });
      if (opts.force || mismatch) {
        await Promise.all([
          withCacheLock(vodPrefix(p.id), () => removeByPrefix(vodPrefix(p.id))),
          removeItem('plvod:' + p.id),
          ...(mismatch || !channelsWanted ? [removePlaylistCache(p.id)] : []),
          ...(mismatch ? [removeEpgCache(p.id)] : []),
        ]);
        if (!isCurrent()) return;
        if (mismatch) {
          epgStarted = false;
          epgForce = true;
          set({ epg: {}, epgStatus: 'idle', epgFetchedAt: undefined, epgMessage: undefined, epgVersion: get().epgVersion + 1 });
        }
      }
      await withCacheLock(vodPrefix(p.id), async () => {
        throwIfAborted(signal);
        await setItem('library-source:' + p.id, playlistSource(p));
      });
      if (!isCurrent()) return;
      sourceChecked(true);
      if (p.type === 'xtream') {
        // Home needs categories, but Live and the potentially huge guide wait for first use.
        void xtreamLogin(p, signal).then(
          (account) => { if (isCurrent()) set({ account }); },
          (error) => { if (isCurrent() && error instanceof AuthError) set({ catalogStatus: 'error', catalogError: error.message }); }
        );
        void get().loadMovieCats();
        void get().loadSeriesCats();
        set({ catalogStatus: 'ready' });
      } else if (p.type === 'demo') {
        await applyMovies(p, demoMovies(), signal, isCurrent);
        if (isCurrent()) set({ catalogStatus: 'ready' });
      } else {
        await cachedVod<VodItem>(p, 'm3uMovies', signal, isCurrent, async () => {
          const data = await fetchPlaylist(p, (m) => { if (isCurrent()) set({ message: m }); }, signal);
          if (isCurrent()) await writePlaylistCache(p.id, data, signal).catch(() => {});
          return data.movies;
        }, (movies) => applyMovies(p, movies, signal, isCurrent), PLAYLIST_TTL);
        if (isCurrent()) set({ catalogStatus: 'ready', message: undefined });
      }
      if (isCurrent() && channelsWanted) void get().loadChannels({ force: !!opts.force || mismatch });
    } catch (error: any) {
      if (isCurrent()) set({ catalogStatus: 'error', catalogError: error?.message ?? String(error), message: undefined });
    } finally { sourceChecked(false); }
  },

  wantChannels: () => {
    channelsWanted = true;
    if (get().status === 'idle') void get().loadChannels();
  },

  loadChannels: (opts = {}) => {
    const p = current();
    if (!p) return Promise.resolve();
    const generation = libraryGeneration;
    if (channelJob?.generation === generation) return channelJob.promise;
    if (!opts.force && get().status === 'ready') return Promise.resolve();
    channelsWanted = true;
    const controller = new AbortController();
    const signal = controller.signal;
    const isCurrent = () => !signal.aborted && libraryGeneration === generation && get().playlistId === p.id;
    const entry = { generation, controller, promise: Promise.resolve() };
    entry.promise = Promise.resolve().then(run).catch((error: any) => {
      if (isCurrent()) set({ status: 'error', error: error?.message ?? String(error), message: undefined });
    }).finally(() => { if (channelJob === entry) channelJob = undefined; });
    channelJob = entry;
    return entry.promise;

    async function run() {
      set({ status: 'loading', error: undefined, message: 'Loading channels…' });
      if (sourceReadiness?.generation === generation && !await sourceReadiness.promise) {
        if (isCurrent()) set({ status: 'error', error: get().catalogError ?? 'Could not read the playlist source.', message: undefined });
        return;
      }
      if (!isCurrent()) return;
      let data = opts.force || p!.type === 'demo' ? null : await readPlaylistCache(p!.id, signal, p);
      if (!isCurrent()) return;
      if (data && (!data.source || !samePlaylistSource(data.source, p!))) {
        await Promise.all([removePlaylistCache(p!.id), removeEpgCache(p!.id)]);
        if (!isCurrent()) return;
        data = null;
        epgForce = true;
      }
      const stale = !!data && Date.now() - data.fetchedAt > PLAYLIST_TTL;
      if (!data) {
        data = await fetchPlaylist(p!, (m) => { if (isCurrent()) set({ message: m }); }, signal, get().account);
        if (!isCurrent()) return;
        if (p!.type !== 'demo') await writePlaylistCache(p!.id, data, signal).catch(() => {});
        if (p!.type === 'm3u') await writeVod(p!, 'm3uMovies', data.movies, signal).catch(() => {});
      }
      await applyChannels(data, signal, isCurrent);
      if (!isCurrent()) return;
      set({ status: 'ready', message: undefined });
      if (epgWanted) {
        const force = !!opts.force || epgForce;
        epgForce = false;
        void get().refreshEpg(force);
      }
      if (stale && !opts.force && p!.type !== 'demo') {
        stalePlaylistController = new AbortController();
        const staleSignal = stalePlaylistController.signal;
        void fetchPlaylist(p!, () => {}, staleSignal, get().account).then(async (fresh) => {
          if (!isCurrent() || staleSignal.aborted) return;
          await writePlaylistCache(p!.id, fresh, staleSignal).catch(() => {});
          if (!isCurrent() || staleSignal.aborted) return;
          await applyChannels(fresh, staleSignal, isCurrent);
          if (p!.type === 'm3u') {
            await applyMovies(p!, fresh.movies, staleSignal, isCurrent);
            await writeVod(p!, 'm3uMovies', fresh.movies, staleSignal).catch(() => {});
          }
        }).catch(() => {});
      }
    }
  },

  wantEpg: (force = false) => {
    epgWanted = true;
    if (force) epgForce = true;
    if (get().status !== 'ready' || (epgStarted && !epgForce)) return;
    const refresh = epgForce;
    epgForce = false;
    void get().refreshEpg(refresh);
  },
  refreshEpg: (force = false) => {
    const selected = current();
    if (!selected) return Promise.resolve();
    const p: Playlist = selected;
    const pid = p.id;
    const generation = libraryGeneration;
    if (epgJob?.generation === generation) return epgJob.promise;
    epgStarted = true;
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
        await cachedVod<Category>(p, 'movieCats', signal, isCurrent, () => xtreamVodCategories(p, signal), (cats) => {
          if (isCurrent()) set((s) => ({ movieCats: cats, vodStatus: { ...s.vodStatus, movieCats: 'ready' } }));
        });
      } catch (error: any) {
        if (isCurrent()) set((s) => ({ catalogError: error?.message, vodStatus: { ...s.vodStatus, movieCats: 'error' } }));
      }
    });
  },

  loadSeriesCats: async () => {
    const p = current();
    if (!p || p.type !== 'xtream' || get().seriesCats) return;
    return catalogRequest('seriesCats', async (signal, isCurrent) => {
      set((s) => ({ vodStatus: { ...s.vodStatus, seriesCats: 'loading' } }));
      try {
        await cachedVod<Category>(p, 'seriesCats', signal, isCurrent, () => xtreamSeriesCategories(p, signal), (cats) => {
          if (isCurrent()) set((s) => ({ seriesCats: cats, vodStatus: { ...s.vodStatus, seriesCats: 'ready' } }));
        });
      } catch (error: any) {
        if (isCurrent()) set((s) => ({ catalogError: error?.message, vodStatus: { ...s.vodStatus, seriesCats: 'error' } }));
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
        await cachedVod<VodItem>(p, key, signal, isCurrent, () => xtreamMovies(p, categoryId, signal), (list) => {
          if (isCurrent()) set((s) => ({ movies: s.moviesAllLoaded ? s.movies : { ...s.movies, [categoryId]: list }, vodStatus: { ...s.vodStatus, [key]: 'ready' } }));
        });
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
        await cachedVod<SeriesItem>(p, key, signal, isCurrent, () => xtreamSeries(p, categoryId, signal), (list) => {
          if (isCurrent()) set((s) => ({ series: s.seriesAllLoaded ? s.series : { ...s.series, [categoryId]: list }, vodStatus: { ...s.vodStatus, [key]: 'ready' } }));
        });
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
          await cachedVod<VodItem>(p, 'allMovies', signal, isCurrent, () => xtreamMovies(p, undefined, signal), async (list) => {
            const data = await groupCatalog(list, signal);
            if (isCurrent()) set({ movies: data.byCategory, movieCount: data.count, moviesAllLoaded: true });
          });
        } catch { if (!isCurrent()) return; }
      }
      if (!get().seriesAllLoaded) {
        try {
          await cachedVod<SeriesItem>(p, 'allSeries', signal, isCurrent, () => xtreamSeries(p, undefined, signal), async (list) => {
            const data = await groupCatalog(list, signal);
            if (isCurrent()) set({ series: data.byCategory, seriesCount: data.count, seriesAllLoaded: true });
          });
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
      withCacheLock(vodPrefix(playlistId), async () => {
        await removeByPrefix(vodPrefix(playlistId));
        await removeItem('library-source:' + playlistId);
        await removeItem('plvod:' + playlistId);
      }),
      ...(opts.removeSource ? [removeItem('m3u:' + playlistId)] : []),
    ]);
  },
}));

async function applyMovies(p: Playlist, list: VodItem[], signal: AbortSignal, isCurrent: () => boolean) {
  const grouped = await groupCatalog(list, signal);
  const series = await groupCatalog(p.type === 'demo' ? demoSeries() : [], signal);
  if (!isCurrent()) return;
  useLibrary.setState({ movieCats: p.type === 'demo' ? demoMovieCats : Object.keys(grouped.byCategory).map((id) => ({ id, name: id })),
    seriesCats: p.type === 'demo' ? demoSeriesCats : [], movies: grouped.byCategory, series: series.byCategory,
    movieCount: grouped.count, seriesCount: series.count, moviesAllLoaded: true, seriesAllLoaded: true, vodAllLoaded: true,
    catalogStatus: 'ready' });
}

async function applyChannels(data: PlaylistCache, signal: AbortSignal, isCurrent: () => boolean) {
  const byId: Record<string, Channel> = Object.create(null);
  const checkpoint = createCheckpoint(signal);
  for (const channel of data.channels) {
    byId[channel.id] = channel;
    const pause = checkpoint();
    if (pause) await pause;
  }
  const groups = await buildGroups(data.channels, signal);
  if (isCurrent()) useLibrary.setState((s) => ({ channels: data.channels, byId, groups, epgUrls: data.epgUrls,
    account: s.account ?? data.account, fetchedAt: data.fetchedAt }));
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
