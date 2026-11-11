import { BackHandler, Platform } from 'react-native';
import type { SeriesItem, VodItem } from '../types';
import { RemoteKeys } from '../../modules/remote-keys';
import { useUI } from './ui';
import { usePlayer } from './player';
import { flushSettings, useSettings, watchId } from './settings';
import { useLibrary } from './library';
import { usePlayback } from '../player/playback';
import { episodeKey, movieKey, seriesProgressKeys } from '../services/vod';

/**
 * Jump to Search from anywhere with the text field focused, so the system keyboard is up.
 * On Fire TV that's what enables voice: holding the remote's mic types into the open keyboard.
 */
export function openSearch() {
  const ui = useUI.getState();
  ui.closeSheet();
  const player = usePlayer.getState();
  if (player.item && player.fullscreen) {
    if (player.item.kind === 'live') player.setFullscreen(false);
    else {
      if (player.item.kind === 'vod') {
        const { position, duration } = usePlayback.getState();
        if (position > 0) useSettings.getState().saveVodProgress(player.item.key, position, duration);
      }
      player.stop();
    }
  }
  ui.setScreen('search');
  ui.focusSearch();
}

/** The Windows app: the web build inside the desktop host, which can close its own window. */
const isDesktop = Platform.OS === 'web' && process.env.EXPO_PUBLIC_DESKTOP === '1';
/** A browser tab cannot close itself and iOS apps never quit themselves. */
export const canExitApp = Platform.OS === 'android' || isDesktop;

/**
 * Really closes the app. Android's default only moves the task to the background, which keeps the
 * JS heap, the decoder and the provider connection: release the player, save, then end the task and process.
 */
export async function exitApp() {
  const player = usePlayer.getState();
  if (player.item?.kind === 'vod') {
    const { position, duration } = usePlayback.getState();
    if (position > 0 && duration > 0) useSettings.getState().saveVodProgress(player.item.key, position, duration);
  }
  // VideoLayer unmounts: the player is released and its playback service unbound, so native can stop it
  player.stop();
  if (Platform.OS === 'web') {
    // the desktop host saves settings in its close handler before destroying the window
    if (isDesktop && typeof window !== 'undefined') window.close();
    return;
  }
  // Nothing may change settings after this save: the process ends right after it
  try {
    await flushSettings();
  } catch {}
  // Let React commit the unmount. Timers still run here because the app is in the foreground.
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    if (RemoteKeys?.exitApp) await RemoteKeys.exitApp();
    else BackHandler.exitApp();
  } catch {
    BackHandler.exitApp();
  }
}

/** Something that can be in the watch history. */
export type Watched = { kind: 'live'; channelId: string } | { kind: 'movie'; item: VodItem } | { kind: 'series'; item: SeriesItem };

const historyIdOf = (w: Watched) => (w.kind === 'live' ? watchId.live(w.channelId) : w.kind === 'movie' ? watchId.movie(w.item.id) : watchId.series(w.item.id));

/** Whether "Remove from history" applies: it's in the history, a recently watched list, or has watch progress. */
export function hasWatched(w: Watched): boolean {
  const pid = useLibrary.getState().playlistId;
  if (!pid) return false;
  const st = useSettings.getState();
  if (st.history[pid]?.some((h) => h.id === historyIdOf(w))) return true;
  if (w.kind === 'live') return !!st.recents[pid]?.includes(w.channelId);
  if (w.kind === 'movie') return !!st.recentMovies[pid]?.some((m) => m.id === w.item.id) || !!st.vodProgress[movieKey(w.item)];
  return false; // a series' episode progress needs its episode list: the history entry decides
}

/**
 * "Remove from history": forget having watched it, so it leaves the recently watched lists (Home, Movies,
 * Live TV), and its resume points and Watched marks go too (a series forgets every episode).
 */
export async function removeFromHistory(w: Watched) {
  const pid = useLibrary.getState().playlistId;
  if (!pid) return;
  const st = useSettings.getState();
  const historyId = historyIdOf(w);
  const last = st.history[pid]?.find((h) => h.id === historyId);
  st.forgetWatched(pid, {
    historyId,
    channelId: w.kind === 'live' ? w.channelId : undefined,
    movieId: w.kind === 'movie' ? w.item.id : undefined,
    progressKeys: w.kind === 'movie' ? [movieKey(w.item)] : last?.kind === 'episode' ? [episodeKey(last.episode)] : [],
  });
  useUI.getState().showToast('Removed from your history');
  // the rest of a series' episodes, once its episode list is at hand
  if (w.kind === 'series') {
    const progressKeys = await seriesProgressKeys(w.item);
    if (useLibrary.getState().playlistId === pid) useSettings.getState().forgetWatched(pid, { historyId, progressKeys });
  }
}
