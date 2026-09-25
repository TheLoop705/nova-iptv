import { Platform } from 'react-native';
import { create } from 'zustand';
import type { Channel, PlayItem, Program } from '../types';
import { useLibrary } from './library';
import { useSettings } from './settings';
import { preferredLiveExt, xtreamCatchupUrl, xtreamLiveUrl } from '../services/xtream';
import { m3uCatchupUrl } from '../services/catchup';
import { DEFAULT_UA } from '../services/http';

export interface Source {
  uri: string;
  userAgent: string;
  isLive: boolean;
  /** alternate URL to try if the first fails (e.g. .ts <-> .m3u8) */
  fallback?: string;
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
    set({
      item: { kind: 'live', channelId },
      prevChannelId: prev,
      groupId: opts.groupId ?? get().groupId,
      fullscreen: opts.fullscreen ?? get().fullscreen,
      resumeAt: undefined,
    });
  },

  playCatchup: (channelId, program) =>
    set({ item: { kind: 'catchup', channelId, program }, fullscreen: true, resumeAt: undefined }),

  playVod: (item, resumeAt) => set({ item, fullscreen: true, resumeAt }),

  setFullscreen: (v) => set({ fullscreen: v }),

  stop: () => set({ item: null, fullscreen: false }),

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

  if (item.kind === 'vod') return { uri: item.url, userAgent: item.userAgent || baseUA, isLive: false };

  const ch = lib.byId[item.channelId];
  if (!ch || !playlist) return null;
  const ua = ch.userAgent || baseUA;

  if (item.kind === 'live') {
    if (playlist.type === 'xtream' && ch.streamId) {
      const ext = preferredLiveExt(settings.prefs.streamFormat, lib.account?.formats ?? []);
      const uri = xtreamLiveUrl(playlist, ch.streamId, ext);
      return { uri, userAgent: ua, isLive: true, fallback: swapExt(uri) };
    }
    return { uri: ch.url, userAgent: ua, isLive: true, fallback: undefined };
  }

  // catch-up
  const p = item.program;
  if (playlist.type === 'demo') return { uri: ch.url, userAgent: ua, isLive: false };
  if (playlist.type === 'xtream' && ch.streamId) {
    // Panels support timeshift as MPEG-TS most reliably; iOS plays it through VLC
    const ext = Platform.OS === 'web' ? 'm3u8' : 'ts';
    const uri = xtreamCatchupUrl(playlist, ch.streamId, p, lib.account?.timezone, ext);
    return { uri, userAgent: ua, isLive: false, fallback: swapExt(uri) };
  }
  const uri = m3uCatchupUrl(ch, p);
  return uri ? { uri, userAgent: ua, isLive: false } : null;
}
