import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { create } from 'zustand';
import * as FileSystem from 'expo-file-system/legacy';
import { AppUpdater } from '../../modules/app-updater';
import { useUI } from '../store/ui';
import { usePlayer } from '../store/player';
import { getItem, setItem } from './storage';

// In-app updates for the sideloaded Android builds (Fire TV, Android TV, phones): the app checks its
// GitHub releases, downloads the matching APK and hands it to Android's installer — no Downloader
// app needed. Android only installs it over the current app if it carries the same signature.

import { apkUpdate, REPO, type Update, type UpdaterState } from './updateCore';
export { isNewer, type Update } from './updateCore';

const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const RECHECK_MS = 12 * 3600 * 1000;
export const updatesSupported = Platform.OS === 'android' && !!AppUpdater;
export const installedVersion = () => AppUpdater?.version() ?? '';
export const updateSource = 'Updates come from the GitHub releases';
let pending: Promise<Update | null> | undefined;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: 'idle',
  progress: 0,

  check: () => {
    if (pending) return pending;
    if (!updatesSupported || get().status === 'downloading' || get().status === 'installing') return Promise.resolve(get().update ?? null);
    set({ status: 'checking', error: undefined });
    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal });
        if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
        const manufacturer = (Platform.constants as { Manufacturer?: string }).Manufacturer ?? '';
        const update = apkUpdate(await res.json(), installedVersion(), manufacturer);
        set({ status: update ? 'available' : 'current', update: update ?? undefined, checkedAt: Date.now() });
        return update;
      } catch (e) {
        set({ status: 'error', error: message(e), checkedAt: Date.now() });
        return null;
      } finally {
        clearTimeout(timeout);
        pending = undefined;
      }
    })();
    return pending;
  },

  install: async () => {
    const u = get().update;
    if (!u || !AppUpdater || (get().status === 'downloading' || get().status === 'installing')) return;
    set({ status: 'downloading', progress: 0, error: undefined });
    try {
      const dir = `${FileSystem.cacheDirectory}updates/`;
      await FileSystem.deleteAsync(dir, { idempotent: true });
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const target = `${dir}Nova-${u.version}.apk`;
      const download = FileSystem.createDownloadResumable(u.url, target, {}, ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
        const total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : u.size;
        if (total > 0) set({ progress: Math.min(1, totalBytesWritten / total) });
      });
      const res = await download.downloadAsync();
      if (!res || res.status < 200 || res.status >= 300) throw new Error(`Download failed (HTTP ${res?.status ?? '—'})`);
      const info = await FileSystem.getInfoAsync(target);
      if (!info.exists || (u.size > 0 && info.size !== u.size)) throw new Error('The download was incomplete');
      set({ status: 'installing', progress: 1 });
      // Android's installer takes over from here; after "Install" Nova restarts on the new version
      await AppUpdater.install(target);
    } catch (e) {
      set({ status: 'error', error: message(e) });
      useUI.getState().showToast(`Update failed: ${message(e)}`);
    }
  },
}));

/** Release notes → a short line for the prompt: the first few bullet points. */
function summary(notes: string): string {
  const bullets = notes
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*] /.test(l))
    .map((l) => l.replace(/^[-*] /, '').replace(/\*\*/g, '').replace(/`/g, ''))
    .slice(0, 3);
  return bullets.join(' · ');
}

export function openUpdateSheet(u: Update) {
  const notes = summary(u.notes);
  useUI.getState().openSheet({
    title: `Nova ${u.version} is available`,
    subtitle: `You have ${installedVersion()}.${notes ? `\n\n${notes}` : ''}`,
    options: [
      { label: 'Update now', icon: 'download-circle-outline', detail: 'Downloads it and opens the installer', onSelect: () => void useUpdater.getState().install() },
      { label: 'Later', icon: 'clock-outline', detail: 'Settings → Check for updates', onSelect: () => {} },
    ],
  });
}

/**
 * Checks shortly after launch and again when the app comes back after 12 h. Each new version is
 * offered once; after that it waits in Settings. While something is playing fullscreen it's only a toast.
 */
export function useAutoUpdateCheck() {
  useEffect(() => {
    if (!updatesSupported) return;
    const offer = async () => {
      const u = await useUpdater.getState().check();
      if (!u) return;
      const seen = await getItem<{ version: string }>('update-offered');
      if (seen?.version === u.version) return;
      await setItem('update-offered', { version: u.version });
      if (usePlayer.getState().fullscreen || (useUI.getState().sheet || useUI.getState().editor)) useUI.getState().showToast(`Nova ${u.version} is available — Settings → Update`);
      else openUpdateSheet(u);
    };
    const t = setTimeout(offer, 6000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const st = useUpdater.getState();
      // the installer was closed without installing: offer it again from Settings
      if (st.status === 'installing') useUpdater.setState({ status: 'available' });
      else if (!st.checkedAt || Date.now() - st.checkedAt > RECHECK_MS) void offer();
    });
    return () => {
      clearTimeout(t);
      sub.remove();
    };
  }, []);
}
