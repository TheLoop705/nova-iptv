import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, Easing, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

export interface HoverTitleProps {
  text: string;
  active?: boolean;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}

// One reduce-motion answer for every title, instead of a native call and a listener per instance.
let reduceMotion = true; // until the platform answers
let started = false;
const subscribers = new Set<() => void>();
const setReduceMotion = (value: boolean) => {
  if (value === reduceMotion) return;
  reduceMotion = value;
  subscribers.forEach((notify) => notify());
};
const subscribeReduceMotion = (notify: () => void) => {
  if (!started) {
    started = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
  }
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
};
const noSubscription = () => () => {};
const getReduceMotion = () => reduceMotion;

export function HoverTitle({ text, active = false, style, containerStyle }: HoverTitleProps) {
  const [viewport, setViewport] = useState(0);
  const viewportRef = useRef(0);
  const [label, setLabel] = useState({ text: '', width: 0 });
  // Only a focused title needs the answer or its own width: the rest render once and stay out of it.
  const reduced = useSyncExternalStore(active ? subscribeReduceMotion : noSubscription, getReduceMotion);
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (active) setViewport(viewportRef.current);
  }, [active]);
  const width = label.text === text ? label.width : 0;
  const distance = Math.max(0, width - viewport);
  const moving = active && !reduced && viewport > 0 && distance > 1;
  useEffect(() => {
    x.setValue(0);
    if (!moving) return;
    const duration = distance / 35 * 1000;
    const animation = Animated.loop(Animated.sequence([
      Animated.delay(1000),
      Animated.timing(x, { toValue: -distance, duration, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
      Animated.delay(1000),
      Animated.timing(x, { toValue: 0, duration, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
    ]));
    animation.start();
    return () => { animation.stop(); x.setValue(0); };
  }, [text, moving, distance, x]);
  return (
    <View testID="hover-title" accessibilityLabel={text}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        viewportRef.current = w;
        if (active) setViewport(w);
      }}
      style={[containerStyle, { minWidth: 0, overflow: 'hidden' }]}>
      {active && !reduced ? (
        <Text key={text} accessible={false} pointerEvents="none" numberOfLines={1}
          onTextLayout={(e) => {
            const measured = e.nativeEvent.lines[0]?.width ?? 0;
            setLabel((old) => old.text === text && old.width === measured ? old : { text, width: measured });
          }}
          // Measure one unwrapped line without expanding the visible viewport.
          style={[style, { position: 'absolute', width: 100000, opacity: 0 }]}>{text}</Text>
      ) : null}
      <Animated.View style={{ width: moving ? Math.ceil(width) + 1 : undefined, transform: [{ translateX: x }] }}>
        <Text numberOfLines={1} style={style}>{text}</Text>
      </Animated.View>
    </View>
  );
}
