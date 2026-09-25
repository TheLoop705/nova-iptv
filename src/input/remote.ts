import { BackHandler, Platform } from 'react-native';
import { RemoteKeys } from '../../modules/remote-keys';
import { dispatchKey, feedKey, type KeyName, useInputMode } from './keys';

// Android keycodes (android.view.KeyEvent)
const CODES: Record<number, KeyName> = {
  19: 'up',
  20: 'down',
  21: 'left',
  22: 'right',
  23: 'select',
  66: 'select',
  160: 'select',
  96: 'select', // gamepad A
  82: 'menu',
  85: 'playpause',
  126: 'playpause',
  127: 'playpause',
  89: 'rw',
  90: 'ff',
  92: 'chup',
  93: 'chdown',
  166: 'chup',
  167: 'chdown',
  165: 'info',
  172: 'guide',
  84: 'search', // KEYCODE_SEARCH (some Android TV remotes' mic/search button)
  219: 'search', // KEYCODE_ASSIST
  231: 'search', // KEYCODE_VOICE_ASSIST
};

export function startRemote(): () => void {
  const subs: { remove: () => void }[] = [];

  // Hardware back (Fire TV remote / Android phones) goes through the same key router.
  subs.push(
    BackHandler.addEventListener('hardwareBackPress', () => dispatchKey({ key: 'back', repeat: 0 }))
  );

  if (Platform.OS === 'android' && RemoteKeys) {
    if (Platform.isTV) useInputMode.getState().lock('key');
    subs.push(
      RemoteKeys.addListener('onKey', (e) => {
        let key = CODES[e.keyCode];
        let digit: number | undefined;
        if (!key && e.keyCode >= 7 && e.keyCode <= 16) {
          key = 'digit';
          digit = e.keyCode - 7;
        }
        if (!key) return;
        feedKey(key, e.action, e.repeat, digit);
      })
    );
    RemoteKeys.setEnabled(true);
  }

  return () => {
    subs.forEach((s) => s.remove());
    if (Platform.OS === 'android') RemoteKeys?.setEnabled(false);
  };
}
