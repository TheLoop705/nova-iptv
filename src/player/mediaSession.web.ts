import { useEffect } from 'react';
import type { Source } from '../store/player';
import { zapChannel } from '../store/player';
import { imageUrl } from '../services/http';
import { usePlayback } from './playback';

export interface MediaSessionInput {
  source: Source | null;
  isLive: boolean;
}

/**
 * Browser Media Session API: title/artwork in the OS media overlay and hardware media keys
 * (play/pause, ±10 s, and previous/next track = previous/next channel while watching live TV).
 */
export function useMediaSession({ source, isLive }: MediaSessionInput) {
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms || typeof MediaMetadata === 'undefined') return;
    if (!source) {
      ms.metadata = null;
      return;
    }
    const art = imageUrl(source.artwork);
    ms.metadata = new MediaMetadata({
      title: source.title ?? 'Nova',
      artist: source.subtitle ?? '',
      album: isLive ? 'Live TV' : 'Nova',
      artwork: art ? [{ src: art, sizes: '512x512' }] : [],
    });
    const cmd = () => usePlayback.getState().cmd;
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['play', () => cmd().play()],
      ['pause', () => cmd().pause()],
      ['seekbackward', (d) => cmd().seekBy(-(d.seekOffset ?? 10))],
      ['seekforward', (d) => cmd().seekBy(d.seekOffset ?? 10)],
      ['seekto', isLive ? null : (d) => d.seekTime != null && cmd().seekTo(d.seekTime)],
      ['previoustrack', isLive ? () => zapChannel(-1) : null],
      ['nexttrack', isLive ? () => zapChannel(1) : null],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // action not supported by this browser
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [source, isLive]);

  // keep the OS scrubber in sync for movies and catch-up
  const position = usePlayback((s) => s.position);
  const duration = usePlayback((s) => s.duration);
  const rate = usePlayback((s) => s.rate);
  const status = usePlayback((s) => s.status);
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms) return;
    ms.playbackState = status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none';
    if (isLive || !(duration > 0) || position > duration) return;
    try {
      ms.setPositionState({ duration, position, playbackRate: rate || 1 });
    } catch {
      // ignore invalid states while loading
    }
  }, [position, duration, rate, status, isLive]);
}
