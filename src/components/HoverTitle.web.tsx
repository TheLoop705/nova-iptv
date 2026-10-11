import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { HoverTitleProps } from './HoverTitle';

/** Browser compositor animation: no JS frame loop and no extra title copies. */
export function HoverTitle({ text, active = false, style, containerStyle }: HoverTitleProps) {
  const box = useRef<View>(null);
  const label = useRef<Text>(null);
  const [hovered, setHovered] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const moving = (active || hovered) && !reduced;
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const viewport = box.current as unknown as HTMLElement;
    const title = label.current as unknown as HTMLElement;
    if (!viewport || !title) return;
    // A tooltip would cover the moving text; use it only as the reduced-motion fallback.
    if (reduced) viewport.title = text;
    else viewport.removeAttribute('title');
    if (!moving) return;
    let animation: Animation | undefined;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      animation?.cancel();
      delete viewport.dataset.scrolling;
      const distance = title.scrollWidth - viewport.clientWidth;
      if (!moving || distance <= 1) return;
      const duration = distance / 35 * 1000 + 1600;
      const pause = 800 / duration;
      animation = title.animate([
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: pause },
        { transform: `translateX(-${distance}px)`, offset: 1 - pause },
        { transform: `translateX(-${distance}px)`, offset: 1 },
      ], { duration, delay: 600, iterations: Infinity, direction: 'alternate', easing: 'linear' });
      viewport.dataset.scrolling = 'true';
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(title);
    void document.fonts.ready.then(measure);
    return () => { alive = false; observer.disconnect(); animation?.cancel(); delete viewport.dataset.scrolling; };
  }, [text, moving, reduced]);
  return (
    <View ref={box} testID="hover-title" style={[containerStyle, { minWidth: 0, overflow: 'hidden' }]}
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      <Text ref={label} numberOfLines={moving ? undefined : 1}
        style={[style, { whiteSpace: 'nowrap', width: moving ? 'max-content' : '100%' } as object]}>{text}</Text>
    </View>
  );
}
