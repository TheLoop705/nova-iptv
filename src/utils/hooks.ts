import { useEffect, useState } from 'react';
import { create } from 'zustand';

/** Current time, re-rendering on a fixed interval aligned to the wall clock. */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs) + 50);
    };
    timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs) + 50);
    return () => clearTimeout(timer);
  }, [intervalMs]);
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
