import { Platform } from 'react-native';
import { create } from 'zustand';
import type { Channel, PlayItem, Program } from '../types';
import { ALL, FAV, RECENT, useLibrary } from './library';
import { useSettings } from './settings';
import { preferredLiveExt, xtreamCatchupUrl, xtreamLiveUrl } from '../services/xtream';
import { m3uCatchupUrl } from '../services/catchup';
import { DEFAULT_UA } from '../services/http';
import { usePlayback } from '../player/playback';

/** A new item starts from a clean slate: never let it inherit the previous item's "ended" or position. */
const resetPlayback = (status: 'loading' | 'idle') => usePlayback.getState().set({ status, position: 0, duration: 0, error: undefined });

export interface Source {
  uri: string;
  userAgent: string;
  isLive: boolean;
  /** alternate URL to try if the first fails (e.g. .ts <-> .m3u8) */
  fallback?: string;
  /** Now Playing / lock screen / Alexa / browser media session metadata */
  title?: string;
  subtitle?: string;
  artwork?: string;
}

interface PlayerState {
  item: PlayItem | null;
  fullscreen: boolean;
  /** group used for channel up/down while watching live TV */
  groupId: string;
  prevChannelId?: string;
  /** bumps to force a reload of the same source */
  nonce: number;
  resumeAt?: number;

  playChannel: (channelId: string, opts?: { groupId?: string; fullscreen?: boolean }) => void;
  playCatchup: (channelId: string, program: Program) => void;
  playVod: (item: Extract<PlayItem, { kind: 'vod' }>, resumeAt?: number) => void;
  setFullscreen: (v: boolean) => void;
  stop: () => void;
  retry: () => void;
  recall: () => void;
}

export const usePlayer = create<PlayerState>((set, get) => ({
  item: null,
  fullscreen: false,
  groupId: 'all',
  nonce: 0,

  playChannel: (channelId, opts = {}) => {
    const cur = get().item;
    const prev = cur?.kind === 'live' && cur.channelId !== channelId ? cur.channelId : get().prevChannelId;
    const pid = useLibrary.getState().playlistId;
    if (pid) useSettings.getState().pushRecent(pid, channelId);
    if (cur?.kind !== 'live' || cur.channelId !== channelId) resetPlayback('loading');
    set({
      item: { kind: 'live', channelId },
      prevChannelId: prev,
      groupId: opts.groupId ?? get().groupId,
      fullscreen: opts.fullscreen ?? get().fullscreen,
      resumeAt: undefined,
    });
  },

  playCatchup: (channelId, program) => {
    resetPlayback('loading');
    set({ item: { kind: 'catchup', channelId, program }, fullscreen: true, resumeAt: undefined });
  },

  playVod: (item, resumeAt) => {
    resetPlayback('loading');
    set({ item, fullscreen: true, resumeAt });
  },

  setFullscreen: (v) => set({ fullscreen: v }),

  stop: () => {
    resetPlayback('idle');
    set({ item: null, fullscreen: false });
  },

  retry: () => set((s) => ({ nonce: s.nonce + 1 })),

  recall: () => {
    const prev = get().prevChannelId;
    if (prev && useLibrary.getState().byId[prev]) get().playChannel(prev);
  },
}));

export function currentChannel(): Channel | undefined {
  const item = usePlayer.getState().item;
  if (!item || item.kind === 'vod') return undefined;
  return useLibrary.getState().byId[item.channelId];
}

function swapExt(url: string): string | undefined {
  if (/\.ts(\?|$)/.test(url)) return url.replace(/\.ts(\?|$)/, '.m3u8$1');
  if (/\.m3u8(\?|$)/.test(url)) return url.replace(/\.m3u8(\?|$)/, '.ts$1');
  return undefined;
}

export function resolveSource(item: PlayItem): Source | null {
  const settings = useSettings.getState();
  const lib = useLibrary.getState();
  const playlist = settings.playlists.find((p) => p.id === lib.playlistId);
  const baseUA = playlist?.userAgent || settings.prefs.userAgent || DEFAULT_UA;

  if (item.kind === 'vod') {
    return { uri: item.url, userAgent: item.userAgent || baseUA, isLive: false, title: item.title, subtitle: item.subtitle, artwork: item.poster };
  }

  const ch = lib.byId[item.channelId];
  if (!ch || !playlist) return null;
  const ua = ch.userAgent || baseUA;
  const meta = { title: ch.name, subtitle: item.kind === 'catchup' ? item.program.title : playlist.name, artwork: ch.logo };

  if (item.kind === 'live') {
    if (playlist.type === 'xtream' && ch.streamId) {
      const ext = preferredLiveExt(settings.prefs.streamFormat, lib.account?.formats ?? []);
      const uri = xtreamLiveUrl(playlist, ch.streamId, ext);
      return { uri, userAgent: ua, isLive: true, fallback: swapExt(uri), ...meta };
    }
    return { uri: ch.url, userAgent: ua, isLive: true, fallback: undefined, ...meta };
  }

  // catch-up
  const p = item.program;
  if (playlist.type === 'demo') return { uri: ch.url, userAgent: ua, isLive: false, ...meta };
  if (playlist.type === 'xtream' && ch.streamId) {
    // Panels support timeshift as MPEG-TS most reliably; iOS plays it through VLC
    const ext = Platform.OS === 'web' ? 'm3u8' : 'ts';
    const uri = xtreamCatchupUrl(playlist, ch.streamId, p, lib.account?.timezone, ext);
    return { uri, userAgent: ua, isLive: false, fallback: swapExt(uri), ...meta };
  }
  const uri = m3uCatchupUrl(ch, p);
  return uri ? { uri, userAgent: ua, isLive: false, ...meta } : null;
}

/** Channel ids of a guide group (including the virtual Favorites / Recent / All groups). */
export function groupChannelIds(groupId: string): string[] {
  const lib = useLibrary.getState();
  const pid = lib.playlistId;
  const st = useSettings.getState();
  if (groupId === FAV) return (pid ? st.favorites[pid] ?? [] : []).filter((id) => lib.byId[id]);
  if (groupId === RECENT) return (pid ? st.recents[pid] ?? [] : []).filter((id) => lib.byId[id]);
  const g = groupId === ALL ? undefined : lib.groups.find((x) => x.id === groupId);
  return g ? g.channelIds : lib.channels.map((c) => c.id);
}

/** Previous/next channel in the current group — used by media keys, Alexa and the browser media session. */
export function zapChannel(delta: number) {
  const pl = usePlayer.getState();
  if (pl.item?.kind !== 'live') return;
  const ids = groupChannelIds(pl.groupId);
  if (!ids.length) return;
  const i = Math.max(0, ids.indexOf(pl.item.channelId));
  pl.playChannel(ids[(((i + delta) % ids.length) + ids.length) % ids.length]);
}
