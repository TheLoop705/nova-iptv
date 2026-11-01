import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { colors, fonts, radius, useLayout } from '../theme';
import { useSettings, type Prefs } from '../store/settings';
import { cueTextAt } from '../services/subtitleCore';
import { usePlayback } from './playback';
import { useSubtitles } from './subtitles';

const SIZE: Record<Prefs['subtitleSize'], number> = { small: 19, medium: 24, large: 29, xlarge: 35 };
const EMPTY = { text: '', italic: false };

/**
 * Draws downloaded subtitles over the picture. Engines report the position about once a second
 * (ExoPlayer) to four times a second (VLC, web), so the clock runs on between reports while playing.
 */
export function SubtitleOverlay({ bottom, side }: { bottom: number; side: number }) {
  const external = useSubtitles((s) => s.external);
  const on = useSubtitles((s) => s.on);
  const delay = useSubtitles((s) => s.delay);
  const size = useSettings((s) => s.prefs.subtitleSize ?? 'medium');
  const box = useSettings((s) => s.prefs.subtitleBackground ?? false);
  const { player: k } = useLayout();
  const [cue, setCue] = useState(EMPTY);

  useEffect(() => {
    if (!external || !on) {
      setCue(EMPTY);
      return;
    }
    let base = { pos: usePlayback.getState().position, at: Date.now() };
    const unsub = usePlayback.subscribe((st, prev) => {
      if (st.position !== prev.position) base = { pos: st.position, at: Date.now() };
    });
    const tick = () => {
      const st = usePlayback.getState();
      const drift = st.status === 'playing' ? Math.min(1.5, (Date.now() - base.at) / 1000) * st.rate : 0;
      const next = cueTextAt(external.cues, base.pos + drift - delay);
      setCue((prev) => (prev.text === next.text && prev.italic === next.italic ? prev : next));
    };
    tick();
    const iv = setInterval(tick, 100);
    return () => {
      unsub();
      clearInterval(iv);
    };
  }, [external, on, delay]);

  if (!cue.text) return null;
  const fontSize = k(SIZE[size] ?? SIZE.medium);
  return (
    <View testID="subtitle-overlay" pointerEvents="none" style={{ position: 'absolute', left: side, right: side, bottom, alignItems: 'center' }}>
      <Text
        style={[
          {
            color: colors.onVideo,
            fontSize,
            lineHeight: Math.round(fontSize * 1.28),
            fontWeight: '600',
            fontFamily: fonts.regular,
            fontStyle: cue.italic ? 'italic' : 'normal',
            textAlign: 'center',
          },
          box
            ? { backgroundColor: colors.videoScrim, paddingHorizontal: k(10), paddingVertical: k(3), borderRadius: k(radius.sm) }
            : { textShadowColor: colors.video, textShadowOffset: { width: 0, height: Math.max(1, k(1.5)) }, textShadowRadius: k(5) },
        ]}
      >
        {cue.text}
      </Text>
    </View>
  );
}
