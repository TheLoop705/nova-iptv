import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

export type PairedPlaylist = {
  kind: 'm3u' | 'xtream';
  name: string;
  url: string;
  server: string;
  username: string;
  password: string;
  epgUrl: string;
  userAgent: string;
};

export type PairingSession = {
  /** One-time, unguessable URL served directly by this device on the local network. */
  url: string;
  expiresAt: number;
};

interface PlaylistPairingNative {
  start(): Promise<PairingSession>;
  stop(): void;
  addListener(event: 'onPlaylist', listener: (playlist: PairedPlaylist) => void): EventSubscription;
}

// Android only. The editor also limits this to TV layouts, where phone entry is useful.
export const PlaylistPairing = requireOptionalNativeModule<PlaylistPairingNative>('PlaylistPairing');
