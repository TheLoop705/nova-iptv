import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

export interface RemoteKeyEvent {
  keyCode: number;
  action: 'down' | 'up';
  repeat: number;
}

interface RemoteKeysNative {
  /** When enabled, D-pad/media keys are captured before Android's focus system sees them. */
  setEnabled(enabled: boolean): void;
  addListener(event: 'onKey', listener: (e: RemoteKeyEvent) => void): EventSubscription;
}

// Android only; null on iOS and web.
export const RemoteKeys = requireOptionalNativeModule<RemoteKeysNative>('RemoteKeys');
