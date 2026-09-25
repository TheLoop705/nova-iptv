import { create } from 'zustand';
import type { Category, Channel, Group, Playlist, Program, SeriesItem, VodItem } from '../types';
import { parseM3U } from '../services/m3u';
import { fetchText, streamText } from '../services/http';
import { getItem, removeItem, setItem } from '../services/storage';
import { buildEpgIndex } from '../services/epg';
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
import { useSettings } from './settings';

interface PlaylistCache {
  channels: Channel[];
  movies: VodItem[];
  epgUrls: string[];
  account?: XtreamAccount;
  fetchedAt: number;
}

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
  clearCache: (playlistId: string) => Promise<void>;
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

async function fetchPlaylist(p: Playlist, onMsg: (m: string) => void): Promise<PlaylistCache> {
  if (p.type === 'demo') {
    return { channels: demoChannels(), movies: [], epgUrls: [], fetchedAt: Date.now() };
  }
  if (p.type === 'xtream') {
    onMsg('Signing in…');
    const account = await xtreamLogin(p);
    onMsg('Loading channels…');
    const channels = await xtreamLive(p);
    return { channels, movies: [], epgUrls: [xtreamEpgUrl(p)], account, fetchedAt: Date.now() };
  }
  onMsg('Downloading playlist…');
  const text = p.inline ? ((await getItem<string>('m3u:' + p.id)) ?? '') : await fetchText(p.url!, { ua: p.userAgent, timeoutMs: 120000 });
  if (!/#EXTM3U|#EXTINF/.test(text.slice(0, 5000))) throw new Error('This does not look like an M3U playlist.');
  onMsg('Reading channels…');
  const res = parseM3U(text);
  return { channels: res.channels, movies: res.movies, epgUrls: res.epgUrls, fetchedAt: Date.now() };
}

const shortEpgTried = new Set<string>();

export const useLibrary = create<LibraryState>((set, get) => ({
  ...EMPTY,

  reset: () => set({ ...EMPTY }),

  load: async (p, opts = {}) => {
    const switching = get().playlistId !== p.id;
    if (switching) {
      shortEpgTried.clear();
      set({ ...EMPTY, playlistId: p.id });
    }
    set({ status: 'loading', error: undefined, message: 'Loading playlist…' });
    const cacheKey = 'pl:' + p.id;
    try {
      let data = opts.force ? null : await getItem<PlaylistCache>(cacheKey);
      const stale = !!data && Date.now() - data.fetchedAt > 24 * 3600000;
      if (data && p.type === 'demo') data = null; // always regenerate demo
      if (!data) {
        data = await fetchPlaylist(p, (m) => set({ message: m }));
        if (p.type !== 'demo') await setItem(cacheKey, data);
      }
      if (get().playlistId !== p.id) return;
      applyPlaylist(data);
      set({ status: 'ready', message: undefined });
      void get().refreshEpg(!!opts.force);
      // Background refresh of a stale cache
      if (stale && !opts.force && p.type !== 'demo') {
        fetchPlaylist(p, () => {})
          .then(async (fresh) => {
            await setItem(cacheKey, fresh);
            if (get().playlistId === p.id) applyPlaylist(fresh);
          })
          .catch(() => {});
      }
    } catch (e: any) {
      if (get().playlistId !== p.id) return;
      set({ status: 'error', error: e?.message ?? String(e), message: undefined });
    }

    function applyPlaylist(data: PlaylistCache) {
      const byId: Record<string, Channel> = {};
      for (const c of data.channels) byId[c.id] = c;
      const movieCats =
        p.type === 'demo'
          ? demoMovieCats
          : p.type === 'm3u'
            ? [...new Set(data.movies.map((m) => m.categoryId))].map((c) => ({ id: c, name: c }))
            : get().movieCats;
      const movies: Record<string, VodItem[]> = p.type === 'xtream' ? get().movies : {};
      if (p.type === 'm3u') {
        for (const m of data.movies) (movies[m.categoryId] ??= []).push(m);
      } else if (p.type === 'demo') {
        for (const m of demoMovies()) (movies[m.categoryId] ??= []).push(m);
      }
      const series: Record<string, SeriesItem[]> = p.type === 'xtream' ? get().series : {};
      if (p.type === 'demo') for (const s of demoSeries()) (series[s.categoryId] ??= []).push(s);
      set({
        channels: data.channels,
        byId,
        groups: buildGroups(data.channels),
        epgUrls: data.epgUrls,
        account: data.account,
        fetchedAt: data.fetchedAt,
        movieCats,
        seriesCats: p.type === 'demo' ? demoSeriesCats : p.type === 'm3u' ? [] : get().seriesCats,
        movies,
        series,
      });
    }
  },

  refreshEpg: async (force = false) => {
    const p = current();
    if (!p) return;
    const pid = p.id;
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
      set({ epgStatus: 'ready' });
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
    if (!p || p.type !== 'xtream' || get().movieCats) return;
    try {
      set({ movieCats: await xtreamVodCategories(p) });
    } catch (e: any) {
      set({ movieCats: [], vodStatus: { ...get().vodStatus, movieCats: 'error' } });
    }
  },

  loadSeriesCats: async () => {
    const p = current();
    if (!p || p.type !== 'xtream' || get().seriesCats) return;
    try {
      set({ seriesCats: await xtreamSeriesCategories(p) });
    } catch {
      set({ seriesCats: [], vodStatus: { ...get().vodStatus, seriesCats: 'error' } });
    }
  },

  loadMovies: async (categoryId) => {
    const p = current();
    const key = 'm:' + categoryId;
    if (!p || p.type !== 'xtream' || get().movies[categoryId] || get().vodStatus[key] === 'loading') return;
    set({ vodStatus: { ...get().vodStatus, [key]: 'loading' } });
    try {
      const list = await xtreamMovies(p, categoryId);
      set((s) => ({ movies: { ...s.movies, [categoryId]: list }, vodStatus: { ...s.vodStatus, [key]: 'ready' } }));
    } catch {
      set((s) => ({ vodStatus: { ...s.vodStatus, [key]: 'error' } }));
    }
  },

  loadSeries: async (categoryId) => {
    const p = current();
    const key = 's:' + categoryId;
    if (!p || p.type !== 'xtream' || get().series[categoryId] || get().vodStatus[key] === 'loading') return;
    set({ vodStatus: { ...get().vodStatus, [key]: 'loading' } });
    try {
      const list = await xtreamSeries(p, categoryId);
      set((s) => ({ series: { ...s.series, [categoryId]: list }, vodStatus: { ...s.vodStatus, [key]: 'ready' } }));
    } catch {
      set((s) => ({ vodStatus: { ...s.vodStatus, [key]: 'error' } }));
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
    await Promise.all([removeItem('pl:' + playlistId), removeItem('epg:' + playlistId), removeItem('m3u:' + playlistId)]);
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
  const channels = useLibrary((s) => s.channels);
  return useMemoGroups(groups, byId, channels, favs, recents, hidden);
}

let memo: { key: unknown[]; value: Group[] } | null = null;
function useMemoGroups(
  groups: Group[],
  byId: Record<string, Channel>,
  channels: Channel[],
  favs?: string[],
  recents?: string[],
  hidden?: string[]
): Group[] {
  const key = [groups, byId, channels, favs, recents, hidden];
  if (memo && memo.key.every((k, i) => k === key[i])) return memo.value;
  const out: Group[] = [];
  const fav = (favs ?? []).filter((id) => byId[id]);
  if (fav.length) out.push({ id: FAV, name: 'Favorites', channelIds: fav, virtual: true });
  const rec = (recents ?? []).filter((id) => byId[id]);
  if (rec.length) out.push({ id: RECENT, name: 'Recently watched', channelIds: rec, virtual: true });
  out.push({ id: ALL, name: 'All channels', channelIds: channels.map((c) => c.id), virtual: true });
  const hide = new Set(hidden ?? []);
  for (const g of groups) if (!hide.has(g.id)) out.push(g);
  memo = { key, value: out };
  return out;
}
