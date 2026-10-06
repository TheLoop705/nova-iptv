import React, { useEffect } from 'react';
import { Animated, Easing, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '../theme';

// One shared pulse drives every placeholder on screen, started while at least one is mounted.
const pulse = new Animated.Value(0);
let users = 0;
let loop: Animated.CompositeAnimation | null = null;

function usePulse() {
  useEffect(() => {
    if (users++ === 0) {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
        ])
      );
      loop.start();
    }
    return () => {
      if (--users === 0) {
        loop?.stop();
        loop = null;
      }
    };
  }, []);
}

const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] });

/** A softly pulsing placeholder block shown where content is still loading. */
export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  usePulse();
  return <Animated.View style={[{ backgroundColor: colors.surface2, opacity }, style]} />;
}
