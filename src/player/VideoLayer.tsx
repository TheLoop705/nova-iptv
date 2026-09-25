import React, { useEffect, useMemo, useRef } from 'react';
import { AppState, Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { usePlayer, resolveSource } from '../store/player';
import { useUI } from '../store/ui';
import { useSettings, watchId } from '../store/settings';
import { useLibrary } from '../store/library';
import { useVideoRect } from '../utils/hooks';
import { VideoSurface } from './VideoSurface';
import { usePlayback } from './playback';
import { useMediaSession } from './mediaSession';

const RECONNECT_DELAYS = [2000, 4000, 8000];
const STALL_MS = 20000;

/**
 * The one video surface in the app. It stays mounted while moving between the guide's preview
 * slot and fullscreen, so switching views never restarts the stream.
 */
export function VideoLayer() {
  const item = usePlayer((s) => s.item);
  const fullscreen = usePlayer((s) => s.fullscreen);
  const nonce = usePlayer((s) => s.nonce);
  const resumeAt = usePlayer((s) => s.resumeAt);
  const stop = usePlayer((s) => s.stop);
  const setFullscreen = usePlayer((s) => s.setFullscreen);
  const screen = useUI((s) => s.screen);
  const previewInGuide = useSettings((s) => s.prefs.previewInGuide);
  const rect = useVideoRect((s) => s.rect);

  const source = useMemo(() => (item ? resolveSource(item) : null), [item]);

  // Nothing to show the preview in: stop instead of playing audio in the background
  useEffect(() => {
    if (item && !fullscreen && (screen !== 'guide' || !previewInGuide)) stop();
  }, [item, fullscreen, screen, previewInGuide, stop]);

  useEffect(() => {
    if (item && !source) usePlayback.getState().set({ status: 'error', error: 'This stream has no playable URL.' });
  }, [item, source]);

  useMediaSession({ source, isLive: item?.kind === 'live' });
  useLiveRecovery(item);
  useReturnToLiveEdge();
  useLiveHistory(item);

  if (!item || !source) return null;

  const style: ViewStyle = fullscreen
    ? (StyleSheet.absoluteFill as ViewStyle)
    : rect
      ? { position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderRadius: 8, overflow: 'hidden' }
      : { position: 'absolute', left: -10, top: -10, width: 1, height: 1, opacity: 0 };

  return (
    <View style={[style, { backgroundColor: '#000' }]} pointerEvents={fullscreen ? 'none' : 'auto'}>
      <VideoSurface source={source} nonce={nonce} resumeAt={resumeAt} style={StyleSheet.absoluteFill} />
      {!fullscreen ? (
        <Pressable focusable={false} style={StyleSheet.absoluteFill} onPress={() => setFullscreen(true)} accessibilityLabel="Open fullscreen" />
      ) : null}
    </View>
  );
}

/**
 * Live TV self-heals like dedicated IPTV players: a dropped or stalled stream is reloaded
 * up to three times (2 s, 4 s, 8 s) before the error screen appears.
 */
function useLiveRecovery(item: ReturnType<typeof usePlayer.getState>['item']) {
  const attempts = useRef(0);
  const playedOnce = useRef(false);
  const loadingSince = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    attempts.current = 0;
    playedOnce.current = false;
    loadingSince.current = 0;
    usePlayback.getState().set({ reconnect: 0 });
  }, [item]);

  useEffect(() => {
    const unsub = usePlayback.subscribe((st, prev) => {
      if (usePlayer.getState().item?.kind !== 'live') return;
      if (st.status === 'loading' && prev.status !== 'loading') loadingSince.current = Date.now();
      if (st.status === 'playing' && prev.status !== 'playing') {
        attempts.current = 0;
        playedOnce.current = true;
        if (st.reconnect) st.set({ reconnect: 0 });
      }
      if (st.status === 'error' && prev.status !== 'error') {
        if (attempts.current < RECONNECT_DELAYS.length) {
          const n = ++attempts.current;
          st.set({ status: 'loading', error: undefined, reconnect: n });
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => usePlayer.getState().retry(), RECONNECT_DELAYS[n - 1]);
        } else if (st.reconnect) {
          st.set({ reconnect: 0 }); // gave up: the error screen takes over
        }
      }
    });
    // Stall watchdog: buffering for too long after the stream had been playing
    const iv = setInterval(() => {
      const st = usePlayback.getState();
      if (usePlayer.getState().item?.kind !== 'live' || !playedOnce.current) return;
      if (st.status === 'loading' && !st.reconnect && loadingSince.current && Date.now() - loadingSince.current > STALL_MS) {
        st.set({ status: 'error', error: 'The stream stalled' });
      }
    }, 5000);
    return () => {
      unsub();
      clearInterval(iv);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
}

const LIVE_HISTORY_MS = 10000;

/** A live channel joins "Recently watched" once it has actually played for 10 s, so zapping doesn't flood it. */
function useLiveHistory(item: ReturnType<typeof usePlayer.getState>['item']) {
  const channelId = item?.kind === 'live' ? item.channelId : undefined;
  useEffect(() => {
    if (!channelId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const record = () => {
      const pid = useLibrary.getState().playlistId;
      const cur = usePlayer.getState().item;
      if (pid && cur?.kind === 'live' && cur.channelId === channelId) {
        useSettings.getState().pushHistory(pid, { kind: 'live', id: watchId.live(channelId), channelId, at: Date.now() });
      }
    };
    const check = (status: string) => {
      if (status === 'playing' && !timer) timer = setTimeout(record, LIVE_HISTORY_MS);
    };
    check(usePlayback.getState().status);
    const unsub = usePlayback.subscribe((st) => check(st.status));
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [channelId]);
}

/**
 * Engines pause when the app is backgrounded (expo-video / the VLC view). Coming back to a
 * live channel reloads it at the live edge instead of resuming a stale buffer.
 */
function useReturnToLiveEdge() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let hiddenAt = 0;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') hiddenAt = Date.now();
      else if (state === 'active' && hiddenAt) {
        const away = Date.now() - hiddenAt;
        hiddenAt = 0;
        if (usePlayer.getState().item?.kind === 'live' && !usePlayback.getState().pip && away > 3000) usePlayer.getState().retry();
      }
    });
    return () => sub.remove();
  }, []);
}
