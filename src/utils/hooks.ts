import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

/** Current time, re-rendering on a fixed interval aligned to the wall clock. `active: false` pauses the ticks (hidden screens); the value refreshes as soon as it is active again. */
export function useNow(intervalMs = 30000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  const paused = useRef(false);
  useEffect(() => {
    if (!active) {
      paused.current = true;
      return;
    }
    // Catch up after a pause; never runs on a first mount that starts active
    if (paused.current) {
      paused.current = false;
      setNow(Date.now());
    }
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs) + 50);
    };
    timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs) + 50);
    return () => clearTimeout(timer);
  }, [intervalMs, active]);
  return now;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the guide wants the preview video drawn (window coordinates). */
export const useVideoRect = create<{ rect: Rect | null; setRect: (r: Rect | null) => void }>((set) => ({
  rect: null,
  setRect: (rect) => set({ rect }),
}));
