import { useEffect } from 'react';
import { create } from 'zustand';
import appJson from '../../app.json';
import { useUI } from '../store/ui';
import { usePlayer } from '../store/player';
import { flushSettings } from '../store/settings';
import { webUpdate, type Update, type UpdaterState } from './updateCore';

export { isNewer, type Update } from './updateCore';
export const updatesSupported = true;
export const installedVersion = () => appJson.expo.version;
export const updateSource = 'Updates are loaded from this Nova server';
let pending: Promise<Update | null> | undefined;

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: 'idle', progress: 0,
  check: () => {
    if (pending) return pending;
    if (get().status === 'installing') return Promise.resolve(get().update ?? null);
    set({ status: 'checking', error: undefined });
    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch('/version.json', { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error(`Update check failed (HTTP ${res.status})`);
        const bundle = Array.from(document.scripts).map((s) => new URL(s.src, location.href).pathname).find((p) => p.startsWith('/_expo/static/js/web/')) ?? '';
        const update = webUpdate(await res.json(), installedVersion(), bundle);
        set({ status: update ? 'available' : 'current', update: update ?? undefined, checkedAt: Date.now() });
        return update;
      } catch (e) {
        set({ status: 'error', error: e instanceof Error ? e.message : String(e), checkedAt: Date.now() });
        return null;
      } finally {
        clearTimeout(timeout);
        pending = undefined;
      }
    })();
    return pending;
  },
  install: async () => {
    if (!get().update || get().status === 'installing') return;
    set({ status: 'installing', progress: 1 });
    try {
      await flushSettings();
      window.location.reload();
    } catch {
      set({ status: 'error', error: 'Could not save your settings. Please try again.' });
      useUI.getState().showToast('Could not save your settings. Please try again before reloading.');
    }
  },
}));

export function openUpdateSheet(update: Update) {
  useUI.getState().openSheet({
    title: `Nova ${update.version} is ready`,
    subtitle: 'Reload to use the latest version deployed to this server. Playback will stop; your saved playlists and settings stay.',
    options: [
      { label: 'Reload and update', icon: 'refresh', onSelect: () => void useUpdater.getState().install() },
      { label: 'Later', icon: 'clock-outline', detail: 'Settings → Check for updates', onSelect: () => {} },
    ],
  });
}

export function useAutoUpdateCheck() {
  useEffect(() => {
    let active = true;
    let offered = '';
    const offer = async () => {
      const update = await useUpdater.getState().check();
      if (!active || !update || offered === update.build) return;
      offered = update.build ?? update.version;
      const ui = useUI.getState();
      if (usePlayer.getState().fullscreen || ui.sheet || ui.editor) ui.showToast(`Nova ${update.version} is available — Settings → Check for updates`);
      else openUpdateSheet(update);
    };
    const timer = setTimeout(() => void offer(), 6000);
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void offer(); }, 5 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - (useUpdater.getState().checkedAt ?? 0) > 60000) void offer();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
