import { requireOptionalNativeModule } from 'expo-modules-core';

export interface FrameRateMatch {
  /** frame rate of the video, e.g. 25 or 23.976 */
  fps: number;
  /** the display's refresh rate for it, e.g. 50 */
  refreshRate: number;
  /** whether the display had to change mode */
  switched: boolean;
}

interface DisplayModeNative {
  /** Measures the playing video's frame rate and switches the display to a matching refresh rate */
  matchVideo(): Promise<FrameRateMatch | null>;
  /** Returns the display to its default mode */
  reset(): Promise<void>;
  /** Refresh rates offered at the current resolution, e.g. [50, 60] */
  refreshRates(): number[];
}

// Android only (Android TV / Fire TV frame-rate matching); null on iOS and web.
export const DisplayMode = requireOptionalNativeModule<DisplayModeNative>('DisplayMode');
