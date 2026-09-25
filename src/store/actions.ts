import { useUI } from './ui';
import { usePlayer } from './player';
import { useSettings } from './settings';
import { usePlayback } from '../player/playback';

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
