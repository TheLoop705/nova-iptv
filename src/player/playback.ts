import { create } from 'zustand';

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error' | 'ended';

export interface Track {
  id: string;
  label: string;
}

export type Fit = 'contain' | 'cover' | 'fill';

export interface PlaybackCommands {
  play: () => void;
  pause: () => void;
  seekTo: (sec: number) => void;
  seekBy: (sec: number) => void;
  setAudio: (index: number) => void;
  setSubtitle: (index: number) => void;
  setRate: (rate: number) => void;
  setMuted: (muted: boolean) => void;
  /** 0–1; raising it above 0 also unmutes */
  setVolume: (volume: number) => void;
  /** index into `qualities`, -1 = automatic (ABR) */
  setQuality: (index: number) => void;
  togglePip: () => void;
  /** browser fullscreen (web only) */
  toggleFullscreen: () => void;
}

/** What the active engine can do on this platform; the player UI only offers these. */
export interface Capabilities {
  speed: boolean;
  mute: boolean;
  /** an in-app volume slider (web); TVs and phones use their own volume keys */
  volume: boolean;
  quality: boolean;
  pip: boolean;
  airplay: boolean;
  fullscreen: boolean;
}

export const NO_CAPS: Capabilities = { speed: false, mute: false, volume: false, quality: false, pip: false, airplay: false, fullscreen: false };

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

interface PlaybackState {
  status: PlaybackStatus;
  error?: string;
  position: number;
  duration: number;
  audioTracks: Track[];
  subtitleTracks: Track[];
  audioIndex: number;
  subtitleIndex: number;
  fit: Fit;
  rate: number;
  muted: boolean;
  /** 0–1 */
  volume: number;
  qualities: Track[];
  /** -1 = automatic */
  qualityIndex: number;
  /** label of the rendition ABR picked, e.g. "720p" */
  autoQuality?: string;
  pip: boolean;
  engine: 'native' | 'vlc' | 'web';
  caps: Capabilities;
  /** live auto-reconnect attempt in progress (0 = none) */
  reconnect: number;
  cmd: PlaybackCommands;
  set: (p: Partial<Omit<PlaybackState, 'set'>>) => void;
}

const noop = () => {};

/** Shared state between the (platform-specific) video surface and the player UI. */
export const usePlayback = create<PlaybackState>((set) => ({
  status: 'idle',
  position: 0,
  duration: 0,
  audioTracks: [],
  subtitleTracks: [],
  audioIndex: -1,
  subtitleIndex: -1,
  fit: 'contain',
  rate: 1,
  muted: false,
  volume: 1,
  qualities: [],
  qualityIndex: -1,
  pip: false,
  engine: 'native',
  caps: NO_CAPS,
  reconnect: 0,
  cmd: {
    play: noop,
    pause: noop,
    seekTo: noop,
    seekBy: noop,
    setAudio: noop,
    setSubtitle: noop,
    setRate: noop,
    setMuted: noop,
    setVolume: noop,
    setQuality: noop,
    togglePip: noop,
    toggleFullscreen: noop,
  },
  set: (p) => set(p),
}));

export function guessContentType(uri: string): 'hls' | 'dash' | 'progressive' | 'auto' {
  const u = uri.toLowerCase().split('#')[0];
  const path = u.split('?')[0];
  if (path.endsWith('.m3u8') || path.endsWith('.m3u') || /[?&](type|format|output)=m3u8/.test(u) || path.endsWith('.isml/.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (/\.(ts|mp4|mkv|m4v|mov|avi|webm|mp3|aac)$/.test(path)) return 'progressive';
  return 'auto';
}

/**
 * iOS only: should this URL go straight to VLC instead of AVPlayer?
 * AVPlayer handles HLS and MP4/MOV; containers like MKV, AVI and raw MPEG-TS it can't open at all.
 */
export function preferVlc(uri: string): boolean {
  const path = uri.toLowerCase().split('#')[0].split('?')[0];
  if (guessContentType(uri) === 'hls') return false;
  if (/\.(mp4|m4v|mov|m4a|mp3|aac|wav)$/.test(path)) return false;
  if (/\.(mkv|avi|ts|m2ts|mts|flv|wmv|asf|mpg|mpeg|vob|divx|xvid|webm|ogv|ogg|3gp|rmvb|rm|mka)$/.test(path)) return true;
  // Extension-less IPTV links (http://host/user/pass/123) are almost always MPEG-TS
  return !/\.[a-z0-9]{2,5}$/.test(path);
}
