import { useEffect } from 'react';
import type { Source } from '../store/player';
import { zapChannel } from '../store/player';
import { imageUrl } from '../services/http';
import { dispatchKey } from '../input/keys';
import { usePlayback } from './playback';

export interface MediaSessionInput {
  source: Source | null;
  isLive: boolean;
  /** an episode with one before / after it */
  hasPrev?: boolean;
  hasNext?: boolean;
}

/**
 * Browser Media Session API: title/artwork in the OS media overlay and hardware media keys
 * (play/pause, ±10 s, and previous/next track = previous/next channel while watching live TV, or the
 * episode before / after).
 */
export function useMediaSession({ source, isLive, hasPrev, hasNext }: MediaSessionInput) {
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
      ['previoustrack', isLive ? () => zapChannel(-1) : hasPrev ? () => dispatchKey({ key: 'prevtrack', repeat: 0 }) : null],
      ['nexttrack', isLive ? () => zapChannel(1) : hasNext ? () => dispatchKey({ key: 'nexttrack', repeat: 0 }) : null],
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
  }, [source, isLive, hasPrev, hasNext]);

  // keep the OS scrubber in sync for movies and catch-up, without re-rendering VideoLayer on every tick
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms) return;
    type PB = ReturnType<typeof usePlayback.getState>;
    let sentAt = 0;
    const sync = (st: PB, prev?: PB) => {
      if (!prev || st.status !== prev.status) ms.playbackState = st.status === 'playing' ? 'playing' : st.status === 'paused' ? 'paused' : 'none';
      if (isLive || !(st.duration > 0) || st.position > st.duration) return;
      // the browser extrapolates from playbackRate: only push on a discontinuity, or every few seconds
      const jump = !prev || st.status !== prev.status || st.rate !== prev.rate || st.duration !== prev.duration || Math.abs(st.position - prev.position) > 2;
      if (!jump && Date.now() - sentAt < 5000) return;
      sentAt = Date.now();
      try {
        ms.setPositionState({ duration: st.duration, position: st.position, playbackRate: st.rate || 1 });
      } catch {
        // ignore invalid states while loading
      }
    };
    sync(usePlayback.getState());
    return usePlayback.subscribe(sync);
  }, [isLive]);
}
