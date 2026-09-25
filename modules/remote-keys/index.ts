import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

export interface RemoteKeyEvent {
  keyCode: number;
  action: 'down' | 'up';
  repeat: number;
}

interface RemoteKeysNative {
  /** When enabled, D-pad/media keys are captured before Android's focus system sees them. */
  setEnabled(enabled: boolean): void;
  /** Shows the on-screen keyboard for the focused text field; resolves false if none is focused. */
  showKeyboard(): Promise<boolean>;
  addListener(event: 'onKey', listener: (e: RemoteKeyEvent) => void): EventSubscription;
}

// Android only; null on iOS and web.
export const RemoteKeys = requireOptionalNativeModule<RemoteKeysNative>('RemoteKeys');
