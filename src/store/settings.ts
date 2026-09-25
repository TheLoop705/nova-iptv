import { create } from 'zustand';
import { Platform } from 'react-native';
import type { Episode, Playlist, SeriesItem, VodItem } from '../types';
import { getItem, onRemoteChange, setItem } from '../services/storage';
import { applyOps, type Doc } from '../utils/docPatch';

export interface Prefs {
  clock24: boolean;
  /** Xtream live output format */
  streamFormat: 'auto' | 'ts' | 'm3u8';
  userAgent: string;
  startWithLastChannel: boolean;
  epgRefreshHours: number;
  epgPastDays: number;
  epgFutureDays: number;
  showChannelNumbers: boolean;
  previewInGuide: boolean;
  /** iPhone/iPad engine: auto = AVPlayer for HLS/MP4, VLC for MKV/AVI/TS and AVPlayer failures */
  iosPlayer: 'auto' | 'vlc' | 'native';
  /** series: start the next episode after a countdown */
  autoplayNext: boolean;
}

export const defaultPrefs: Prefs = {
  clock24: true,
  streamFormat: 'auto',
  userAgent: '',
  startWithLastChannel: false,
  epgRefreshHours: 12,
  epgPastDays: 2,
  epgFutureDays: 3,
  showChannelNumbers: true,
  previewInGuide: true,
  iosPlayer: 'auto',
  autoplayNext: true,
};

export type VodFav = { kind: 'movie'; item: VodItem } | { kind: 'series'; item: SeriesItem };

export interface VodProgress {
  /** resume position in seconds (0 once finished) */
  pos: number;
  dur: number;
  at: number;
  /** watched to the end at least once */
  done?: boolean;
}

/** Something watched, for Home's "Recently watched" row. One entry per channel, movie or series. */
export type WatchEntry =
  | { kind: 'live'; id: string; channelId: string; at: number }
  | { kind: 'movie'; id: string; item: VodItem; at: number }
  | { kind: 'episode'; id: string; series: SeriesItem; episode: Episode; at: number };

export const watchId = {
  live: (channelId: string) => `live:${channelId}`,
  movie: (movieId: string) => `movie:${movieId}`,
  /** a series keeps only its latest episode */
  series: (seriesId: string) => `series:${seriesId}`,
};

const HISTORY_MAX = 40;

/** Counts as watched once the remaining time is under 5% (at least the last minute: credits). */
export const isFinished = (pos: number, dur: number) => dur > 0 && pos >= dur - Math.max(60, dur * 0.05);

interface Persisted {
  playlists: Playlist[];
  activeId?: string;
  favorites: Record<string, string[]>;
  recents: Record<string, string[]>;
  lastChannel: Record<string, string>;
  lastGroup: Record<string, string>;
  hiddenGroups: Record<string, string[]>;
  vodProgress: Record<string, VodProgress>;
  vodFavorites: Record<string, VodFav[]>;
  recentMovies: Record<string, VodItem[]>;
  /** per playlist, newest first */
  history: Record<string, WatchEntry[]>;
  prefs: Prefs;
}

interface SettingsState extends Persisted {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addPlaylist: (p: Playlist) => void;
  updatePlaylist: (p: Playlist) => void;
  removePlaylist: (id: string) => void;
  setActive: (id: string) => void;
  toggleFavorite: (playlistId: string, channelId: string) => void;
  pushRecent: (playlistId: string, channelId: string) => void;
  setLastGroup: (playlistId: string, groupId: string) => void;
  toggleHiddenGroup: (playlistId: string, groupId: string) => void;
  saveVodProgress: (key: string, pos: number, dur: number) => void;
  /** mark a movie/episode as watched (or not) by hand */
  setWatched: (key: string, done: boolean) => void;
  pushHistory: (playlistId: string, entry: WatchEntry) => void;
  removeHistory: (playlistId: string, id: string) => void;
  toggleVodFavorite: (playlistId: string, fav: VodFav) => void;
  pushRecentMovie: (playlistId: string, item: VodItem) => void;
  setPrefs: (p: Partial<Prefs>) => void;
}

const initial: Persisted = {
  playlists: [],
  activeId: undefined,
  favorites: {},
  recents: {},
  lastChannel: {},
  lastGroup: {},
  hiddenGroups: {},
  vodProgress: {},
  vodFavorites: {},
  recentMovies: {},
  history: {},
  prefs: defaultPrefs,
};

const toggle = (list: string[] | undefined, id: string) =>
  list?.includes(id) ? list.filter((x) => x !== id) : [...(list ?? []), id];

export const useSettings = create<SettingsState>((set, get) => ({
  ...initial,
  hydrated: false,

  hydrate: async () => {
    const [saved, device] = await Promise.all([getItem<Partial<Persisted>>('settings'), getItem<Pick<Persisted, 'activeId'>>('device')]);
    set({
      ...initial,
      ...(saved ?? {}),
      // older saves kept the active playlist in the shared settings
      activeId: device?.activeId ?? saved?.activeId,
      prefs: { ...defaultPrefs, ...(saved?.prefs ?? {}) },
      hydrated: true,
    });
    if (!device && saved?.activeId) await setItem('device', { activeId: saved.activeId }).catch(() => {});
  },

  addPlaylist: (p) => set((s) => ({ playlists: [...s.playlists, p], activeId: p.id })),
  updatePlaylist: (p) => set((s) => ({ playlists: s.playlists.map((x) => (x.id === p.id ? p : x)) })),
  removePlaylist: (id) =>
    set((s) => {
      const playlists = s.playlists.filter((x) => x.id !== id);
      return { playlists, activeId: s.activeId === id ? playlists[0]?.id : s.activeId };
    }),
  setActive: (id) => set({ activeId: id }),

  toggleFavorite: (pid, cid) => set((s) => ({ favorites: { ...s.favorites, [pid]: toggle(s.favorites[pid], cid) } })),
  pushRecent: (pid, cid) =>
    set((s) => ({
      recents: { ...s.recents, [pid]: [cid, ...(s.recents[pid] ?? []).filter((x) => x !== cid)].slice(0, 30) },
      lastChannel: { ...s.lastChannel, [pid]: cid },
    })),
  setLastGroup: (pid, gid) => set((s) => ({ lastGroup: { ...s.lastGroup, [pid]: gid } })),
  toggleHiddenGroup: (pid, gid) =>
    set((s) => ({ hiddenGroups: { ...s.hiddenGroups, [pid]: toggle(s.hiddenGroups[pid], gid) } })),
  saveVodProgress: (key, pos, dur) =>
    set((s) => {
      const prev = s.vodProgress[key];
      const vodProgress = { ...s.vodProgress };
      const at = Date.now();
      if (isFinished(pos, dur)) vodProgress[key] = { pos: 0, dur, at, done: true };
      else if (pos < 15) {
        // barely started: nothing to resume, but keep a "watched" mark from an earlier viewing
        if (prev?.done) vodProgress[key] = { pos: 0, dur: prev.dur, at: prev.at, done: true };
        else delete vodProgress[key];
      } else vodProgress[key] = { pos, dur, at, ...(prev?.done ? { done: true } : null) };
      return { vodProgress };
    }),
  setWatched: (key, done) =>
    set((s) => {
      const prev = s.vodProgress[key];
      const vodProgress = { ...s.vodProgress };
      if (done) vodProgress[key] = { pos: 0, dur: prev?.dur ?? 0, at: Date.now(), done: true };
      else delete vodProgress[key];
      return { vodProgress };
    }),
  pushHistory: (pid, entry) =>
    set((s) => ({
      history: { ...s.history, [pid]: [entry, ...(s.history[pid] ?? []).filter((e) => e.id !== entry.id)].slice(0, HISTORY_MAX) },
    })),
  removeHistory: (pid, id) => set((s) => ({ history: { ...s.history, [pid]: (s.history[pid] ?? []).filter((e) => e.id !== id) } })),
  toggleVodFavorite: (pid, fav) =>
    set((s) => {
      const list = s.vodFavorites[pid] ?? [];
      const exists = list.some((f) => f.item.id === fav.item.id);
      return { vodFavorites: { ...s.vodFavorites, [pid]: exists ? list.filter((f) => f.item.id !== fav.item.id) : [fav, ...list] } };
    }),
  pushRecentMovie: (pid, item) =>
    set((s) => ({
      recentMovies: { ...s.recentMovies, [pid]: [item, ...(s.recentMovies[pid] ?? []).filter((m) => m.id !== item.id)].slice(0, 40) },
    })),
  setPrefs: (p) => set((s) => ({ prefs: { ...s.prefs, ...p } })),
}));

// Everything but the active playlist is shared: on web it syncs across browsers through the Nova
// server, so each device keeps its own `activeId` under a separate key.
const SHARED = (Object.keys(initial) as (keyof Persisted)[]).filter((k) => k !== 'activeId');

function sharedDoc(s: Persisted): Doc {
  const data: Doc = {};
  for (const k of SHARED) data[k] = s[k];
  return data;
}

// Persist (debounced) whenever persisted fields change
let timer: ReturnType<typeof setTimeout> | null = null;
const save = () => {
  timer = null;
  setItem('settings', sharedDoc(useSettings.getState())).catch((e) => console.warn('Failed to save settings', e));
};
useSettings.subscribe((s, prev) => {
  if (!s.hydrated || !prev.hydrated) return;
  if (s.activeId !== prev.activeId) setItem('device', { activeId: s.activeId }).catch((e) => console.warn('Failed to save settings', e));
  if (timer) clearTimeout(timer);
  timer = setTimeout(save, 400);
});

/** Saves pending changes now instead of after the debounce (page about to unload). */
export function flushSettings() {
  if (!timer) return;
  clearTimeout(timer);
  save();
}

// Web: a refresh or closed tab must not drop the last changes (watch progress, history)
if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('pagehide', flushSettings);

// Changes made in another tab or on another device
onRemoteChange('settings', (ops) => {
  const shared = ops.filter((op) => (SHARED as string[]).includes(op.path[0]));
  if (!shared.length) return;
  const next = applyOps(sharedDoc(useSettings.getState()), shared) as Partial<Persisted>;
  useSettings.setState({ ...next, prefs: { ...defaultPrefs, ...next.prefs } });
});

export const useActivePlaylist = () =>
  useSettings((s) => s.playlists.find((p) => p.id === s.activeId) ?? s.playlists[0]);
