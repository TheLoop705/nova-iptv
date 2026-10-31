import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

export interface HoverTitleProps {
  text: string;
  active?: boolean;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}

export function HoverTitle({ text, active = false, style, containerStyle }: HoverTitleProps) {
  const [viewport, setViewport] = useState(0);
  const [label, setLabel] = useState({ text: '', width: 0 });
  const [reduced, setReduced] = useState(true);
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (alive) setReduced(value); }).catch(() => {});
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { alive = false; listener.remove(); };
  }, []);
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
      onLayout={(e) => setViewport(e.nativeEvent.layout.width)}
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
