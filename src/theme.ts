import { Platform, useWindowDimensions } from 'react-native';
import { useMemo } from 'react';

export const colors = {
  bg: '#07090D',
  bgElevated: '#0D1118',
  surface: '#131821',
  surface2: '#1A202B',
  surface3: '#232B38',
  border: '#232A36',
  text: '#EEF1F6',
  textDim: '#A7B0C0',
  muted: '#6B7486',
  accent: '#4C8DFF',
  accentSoft: 'rgba(76,141,255,0.18)',
  live: '#FF4D5E',
  focus: '#F4F6FA',
  focusText: '#0A0D12',
  nowCell: '#18202C',
  pastCell: '#0E131A',
  success: '#39C98B',
  warning: '#F5B849',
  scrim: 'rgba(4,6,10,0.72)',
};

export const fonts = {
  regular: Platform.select({ web: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', default: undefined }),
};

export type LayoutMode = 'tv' | 'compact';

export interface Layout {
  width: number;
  height: number;
  mode: LayoutMode;
  scale: number;
  s: (n: number) => number;
}

/**
 * The TV layout is designed on a 960x540 canvas (Android TV's logical size) and scaled to fit.
 * Portrait / narrow screens get the compact phone layout at native density.
 */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  return useMemo(() => {
    const mode: LayoutMode = width >= 700 && width > height * 1.1 ? 'tv' : 'compact';
    let scale = 1;
    if (mode === 'tv') {
      scale = Math.min(width / 960, height / 540);
      if (Platform.OS === 'web') scale *= 0.86;
      scale = Math.max(0.72, Math.min(scale, 2.6));
    }
    const s = (n: number) => Math.round(n * scale * 100) / 100;
    return { width, height, mode, scale, s };
  }, [width, height]);
}
