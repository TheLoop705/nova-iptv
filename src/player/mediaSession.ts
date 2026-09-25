import type { Source } from '../store/player';

export interface MediaSessionInput {
  source: Source | null;
  isLive: boolean;
}

// Native: expo-video publishes Now Playing / the Android media session itself (see VideoSurface),
// and the VLC view publishes MPNowPlayingInfoCenter on iOS.
export function useMediaSession(_input: MediaSessionInput) {}
