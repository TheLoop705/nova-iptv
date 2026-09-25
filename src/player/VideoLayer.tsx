import React, { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { usePlayer, resolveSource } from '../store/player';
import { useUI } from '../store/ui';
import { useSettings } from '../store/settings';
import { useVideoRect } from '../utils/hooks';
import { VideoSurface } from './VideoSurface';
import { usePlayback } from './playback';

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
