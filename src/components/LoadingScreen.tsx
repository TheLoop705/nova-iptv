import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Text, View } from 'react-native';
import { colors, radius, useLayout } from '../theme';
import { useActivePlaylist } from '../store/settings';
import { useLibrary } from '../store/library';
import { NovaMark } from './NovaMark';

const nativeDriver = Platform.OS !== 'web';

/**
 * Nova's loading banner: the mark, the playlist's name, what's happening ("Loading channels… 4.2 MB") and a
 * moving bar. With a saved library it's gone in a blink, so everything but the mark fades in after a beat
 * instead of flashing.
 */
export function LoadingScreen({ message }: { message?: string }) {
  const { k, type } = useLayout();
  const playlist = useActivePlaylist();
  const libMessage = useLibrary((st) => st.message);
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 300, delay: 250, useNativeDriver: nativeDriver }).start();
    const loop = Animated.loop(Animated.timing(slide, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.cubic), useNativeDriver: nativeDriver }));
    loop.start();
    const t = setTimeout(() => setSlow(true), 8000);
    return () => {
      loop.stop();
      clearTimeout(t);
    };
  }, [fade, slide]);

  const trackW = k(240);
  const segW = trackW * 0.34;
  const x = slide.interpolate({ inputRange: [0, 1], outputRange: [-segW, trackW] });

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }} accessibilityRole="progressbar" accessibilityLabel="Loading">
      <NovaMark size={k(64)} />
      <Animated.View style={{ alignItems: 'center', opacity: fade }}>
        <Text numberOfLines={1} style={[type('title'), { color: colors.text, marginTop: k(20) }]}>
          {playlist?.name ?? 'Nova'}
        </Text>
        <View style={{ width: trackW, height: k(4), borderRadius: radius.pill, backgroundColor: colors.surface3, overflow: 'hidden', marginTop: k(16) }}>
          <Animated.View style={{ width: segW, height: '100%', borderRadius: radius.pill, backgroundColor: colors.accent, transform: [{ translateX: x }] }} />
        </View>
        <Text style={[type('caption'), { color: colors.textDim, marginTop: k(10), fontVariant: ['tabular-nums'] }]}>{libMessage ?? message ?? 'Loading…'}</Text>
        {slow ? (
          <Text style={[type('caption'), { color: colors.muted, marginTop: k(18), textAlign: 'center', maxWidth: k(380) }]}>
            Big playlists take a while the first time. Nova keeps a copy, so the next start is quick.
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

/** Before settings are read: just the mark, centred like the splash screen it replaces. */
export function BootScreen() {
  const { k } = useLayout();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <NovaMark size={k(64)} />
    </View>
  );
}
