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

const REPO = 'TheLoop705/nova-iptv';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
/** release assets must come from this repo's releases */
const DOWNLOADS = `https://github.com/${REPO}/releases/download/`;
const RECHECK_MS = 12 * 3600 * 1000;

export interface Update {
  version: string;
  notes: string;
  url: string;
  size: number;
}

type Status = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error';

interface UpdaterState {
  status: Status;
  update?: Update;
  /** download progress 0–1 */
  progress: number;
  error?: string;
  checkedAt?: number;
  check: () => Promise<Update | null>;
  install: () => Promise<void>;
}

export const updatesSupported = Platform.OS === 'android' && !!AppUpdater;
export const installedVersion = () => AppUpdater?.version() ?? '';

/** "1.10.0" > "1.9.2" */
export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map((n) => parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** The 32-bit Fire TV build on Amazon devices, the universal (arm64 + armv7) build everywhere else. */
function assetName(): string {
  const maker = (Platform.constants as { Manufacturer?: string }).Manufacturer ?? '';
  return /amazon/i.test(maker) ? 'Nova-firetv.apk' : 'Nova-universal.apk';
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: 'idle',
  progress: 0,

  check: async () => {
    if (!updatesSupported || get().status === 'downloading' || get().status === 'installing') return get().update ?? null;
    set({ status: 'checking', error: undefined });
    try {
      const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
      const rel = (await res.json()) as { tag_name?: string; body?: string; assets?: { name: string; browser_download_url: string; size: number }[] };
      const version = String(rel.tag_name ?? '').replace(/^v/i, '');
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const asset = assets.find((a) => a.name === assetName()) ?? assets.find((a) => a.name === 'Nova-universal.apk');
      const url = String(asset?.browser_download_url ?? '');
      if (!version || !asset || !url.startsWith(DOWNLOADS) || !isNewer(version, installedVersion())) {
        set({ status: 'current', update: undefined, checkedAt: Date.now() });
        return null;
      }
      const update: Update = { version, notes: String(rel.body ?? ''), url, size: Number(asset.size) || 0 };
      set({ status: 'available', update, checkedAt: Date.now() });
      return update;
    } catch (e) {
      set({ status: 'error', error: message(e), checkedAt: Date.now() });
      return null;
    }
  },

  install: async () => {
    const u = get().update;
    if (!u || !AppUpdater || get().status === 'downloading') return;
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
      if (usePlayer.getState().fullscreen || useUI.getState().sheet) useUI.getState().showToast(`Nova ${u.version} is available — Settings → Update`);
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
