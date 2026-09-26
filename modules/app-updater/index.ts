import { requireOptionalNativeModule } from 'expo-modules-core';

interface AppUpdaterNative {
  /** versionName of the installed build, e.g. "1.5.0" */
  version(): string;
  /** Android 8+: whether "Install unknown apps" is allowed for Nova (Android asks when it isn't) */
  canInstall(): boolean;
  /** Opens the "Install unknown apps" setting for Nova; resolves false if the device has no such screen */
  openInstallSettings(): Promise<boolean>;
  /** Hands an APK in the app's cache to Android's package installer */
  install(path: string): Promise<void>;
}

// Android only (sideloaded Fire TV / Android TV / phone builds); null on iOS and web.
export const AppUpdater = requireOptionalNativeModule<AppUpdaterNative>('AppUpdater');
