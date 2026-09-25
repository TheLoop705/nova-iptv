import { Platform, useWindowDimensions, type TextStyle } from 'react-native';
import { useMemo } from 'react';

/**
 * Nova Night — the design system's tokens. Mirrors tokens.json in the Nova IPTV design system:
 * change a value there and here together.
 */
export const colors = {
  // grounds
  bg: '#07080B',
  bgElevated: '#0E1015',
  surface: '#161A22',
  surface2: '#1C212B',
  surface3: '#252B37',
  hover: '#202634',
  border: '#2A3140',
  borderStrong: '#3A4254',
  // text
  text: '#F3F5F9',
  textDim: '#B7BFCC',
  muted: '#8B93A3',
  // brand
  accent: '#6FA8FF',
  accentFill: '#2F6BEA',
  onAccent: '#FFFFFF',
  accentSoft: 'rgba(111,168,255,0.16)',
  star: '#FFC74D',
  // signals
  live: '#FF6470',
  liveFill: '#D7303F',
  onLive: '#FFFFFF',
  success: '#4ED39A',
  warning: '#FFC74D',
  // focus: the one white thing on screen
  focus: '#F3F5F9',
  focusText: '#0B0D12',
  focusDim: '#4A5263',
  // guide
  nowCell: '#1A2130',
  pastCell: '#0E1015',
  // overlays
  scrim: 'rgba(5,6,9,0.74)',
  video: '#000000',
  onVideo: '#FFFFFF',
  videoScrim: 'rgba(0,0,0,0.78)',
  glass: 'rgba(255,255,255,0.14)',
};

/** Monogram grounds for channel logos and poster fallbacks (white initials hold ≥7:1 on each). */
export const monogram = ['#27385A', '#3B2D5C', '#1F4F45', '#5A4526', '#5A2A3A', '#23495A', '#3E5226', '#4A2B5A'];

/** Spacing steps. TV values are 960×540 canvas units (pass through `s`), touch values are points. */
export const space = { xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24, xxxl: 32 } as const;

export const radius = { xs: 4, sm: 6, md: 10, lg: 14, xl: 20, pill: 999 } as const;

export const fonts = {
  regular: Platform.select({ web: 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif', default: undefined }),
};

export type TypeName = 'display' | 'title' | 'heading' | 'body' | 'label' | 'caption' | 'overline' | 'numeral';

interface TypeSpec {
  /** [fontSize, lineHeight] on the 960×540 TV canvas */
  tv: [number, number];
  /** [fontSize, lineHeight] in points for phones, tablets and pointer layouts */
  touch: [number, number];
  weight: TextStyle['fontWeight'];
  letterSpacing?: number;
  tabular?: boolean;
}

/** Type scale. TV sizes never go under 11 canvas px (22px on a 1080p panel) so text reads at 3 m. */
export const typeScale: Record<TypeName, TypeSpec> = {
  display: { tv: [30, 34], touch: [32, 38], weight: '800', letterSpacing: -0.6 },
  title: { tv: [22, 27], touch: [26, 32], weight: '800', letterSpacing: -0.3 },
  heading: { tv: [16, 21], touch: [18, 23], weight: '700' },
  body: { tv: [13, 18], touch: [15, 21], weight: '500' },
  label: { tv: [12.5, 16], touch: [14, 18], weight: '700' },
  caption: { tv: [11, 14], touch: [12.5, 16], weight: '500' },
  overline: { tv: [11, 13], touch: [11.5, 14], weight: '800', letterSpacing: 1.1 },
  numeral: { tv: [15, 18], touch: [16, 20], weight: '700', tabular: true },
};

export type LayoutMode = 'tv' | 'compact';
/** tv = 10-foot remote UI (Fire TV / Android TV); desktop = the same layout under a mouse; tablet/phone = touch. */
export type Device = 'tv' | 'desktop' | 'tablet' | 'phone';

export interface Layout {
  width: number;
  height: number;
  mode: LayoutMode;
  device: Device;
  scale: number;
  /** scale a TV canvas value */
  s: (n: number) => number;
  /** size for the current mode: canvas-scaled on TV layouts, points (×1.1 on tablets) on touch */
  k: (n: number) => number;
  /** title-safe inset for TV panels that overscan (0 elsewhere) */
  safe: { x: number; y: number };
  /** minimum hit target edge */
  hit: number;
  type: (name: TypeName) => TextStyle;
}

/**
 * The TV layout is designed on a 960x540 canvas (Android TV's logical size) and scaled to fit.
 * Portrait / narrow screens get the compact phone layout at native density.
 */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  return useMemo(() => {
    const mode: LayoutMode = width >= 700 && width > height * 1.1 ? 'tv' : 'compact';
    const device: Device = Platform.isTV ? 'tv' : mode === 'tv' ? (Platform.OS === 'web' ? 'desktop' : 'tablet') : Math.min(width, height) >= 600 ? 'tablet' : 'phone';
    let scale = 1;
    if (mode === 'tv') {
      scale = Math.min(width / 960, height / 540);
      if (Platform.OS === 'web') scale *= 0.86;
      scale = Math.max(0.72, Math.min(scale, 2.6));
    }
    const s = (n: number) => Math.round(n * scale * 100) / 100;
    const touchK = device === 'tablet' && mode === 'compact' ? 1.1 : 1;
    const k = mode === 'tv' ? s : (n: number) => Math.round(n * touchK * 100) / 100;
    const safe = device === 'tv' ? { x: s(20), y: s(12) } : { x: 0, y: 0 };
    const hit = mode === 'tv' ? s(34) : 44;
    const type = (name: TypeName): TextStyle => {
      const t = typeScale[name];
      const [size, lh] = mode === 'tv' ? [s(t.tv[0]), s(t.tv[1])] : [k(t.touch[0]), k(t.touch[1])];
      return {
        fontSize: size,
        lineHeight: lh,
        fontWeight: t.weight,
        letterSpacing: t.letterSpacing,
        fontFamily: fonts.regular,
        fontVariant: t.tabular ? ['tabular-nums'] : undefined,
      };
    };
    return { width, height, mode, device, scale, s, k, safe, hit, type };
  }, [width, height]);
}
