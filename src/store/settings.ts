import { create } from 'zustand';
import type { Playlist, SeriesItem, VodItem } from '../types';
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
  pos: number;
  dur: number;
  at: number;
}

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
      const vodProgress = { ...s.vodProgress };
      // Finished (or barely started) items drop out of "continue watching"
      if (dur > 0 && (pos > dur - 60 || pos < 15)) delete vodProgress[key];
      else vodProgress[key] = { pos, dur, at: Date.now() };
      return { vodProgress };
    }),
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
useSettings.subscribe((s, prev) => {
  if (!s.hydrated || !prev.hydrated) return;
  if (s.activeId !== prev.activeId) setItem('device', { activeId: s.activeId }).catch((e) => console.warn('Failed to save settings', e));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    setItem('settings', sharedDoc(useSettings.getState())).catch((e) => console.warn('Failed to save settings', e));
  }, 400);
});

// Changes made in another tab or on another device
onRemoteChange('settings', (ops) => {
  const shared = ops.filter((op) => (SHARED as string[]).includes(op.path[0]));
  if (!shared.length) return;
  const next = applyOps(sharedDoc(useSettings.getState()), shared) as Partial<Persisted>;
  useSettings.setState({ ...next, prefs: { ...defaultPrefs, ...next.prefs } });
});

export const useActivePlaylist = () =>
  useSettings((s) => s.playlists.find((p) => p.id === s.activeId) ?? s.playlists[0]);
