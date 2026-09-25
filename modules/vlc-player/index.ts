import type { ComponentType, Ref } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeView } from 'expo';

export type VlcStatus = 'opening' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface VlcTrack {
  id: number;
  label: string;
}

export interface VlcSource {
  uri: string;
  userAgent?: string;
  isLive?: boolean;
  /** change to force a reload of the same uri */
  nonce?: number;
  /** lock screen / Control Center metadata */
  title?: string;
  subtitle?: string;
}

export interface VlcPlayerRef {
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(seconds: number): Promise<void>;
  seekBy(seconds: number): Promise<void>;
  setAudioTrack(id: number): Promise<void>;
  setSubtitleTrack(id: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
}

export interface VlcPlayerViewProps {
  ref?: Ref<VlcPlayerRef>;
  source: VlcSource | null;
  fit?: 'contain' | 'cover' | 'fill';
  style?: StyleProp<ViewStyle>;
  onStatus?: (e: { nativeEvent: { status: VlcStatus; error?: string } }) => void;
  onProgress?: (e: { nativeEvent: { position: number; duration: number } }) => void;
  onTracks?: (e: { nativeEvent: { audio: VlcTrack[]; subtitles: VlcTrack[]; audioId: number; subtitleId: number } }) => void;
}

// iOS only (MobileVLCKit). Android uses ExoPlayer, which already handles MKV/TS.
export const VlcPlayerView: ComponentType<VlcPlayerViewProps> | null =
  Platform.OS === 'ios' ? requireNativeView<VlcPlayerViewProps>('VlcPlayer') : null;
