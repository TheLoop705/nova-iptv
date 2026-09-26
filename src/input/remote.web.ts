import { feedKey, type KeyName, useInputMode } from './keys';

const MAP: Record<string, KeyName> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  NumpadEnter: 'select',
  Escape: 'back',
  Backspace: 'back',
  BrowserBack: 'back',
  GoBack: 'back',
  ContextMenu: 'menu',
  PageUp: 'chup',
  PageDown: 'chdown',
  ChannelUp: 'chup',
  ChannelDown: 'chdown',
  MediaPlayPause: 'playpause',
  MediaFastForward: 'ff',
  MediaRewind: 'rw',
  MediaTrackNext: 'ff',
  MediaTrackPrevious: 'rw',
  ' ': 'playpause',
  // YouTube-standard player shortcuts
  k: 'playpause',
  j: 'rw',
  l: 'ff',
  m: 'mute',
  f: 'fullscreen',
  c: 'captions',
  '>': 'faster',
  '<': 'slower',
  p: 'pip',
  o: 'menu',
  '/': 'search',
  BrowserSearch: 'search',
  i: 'info',
  g: 'guide',
  '+': 'volup',
  '=': 'volup',
  '-': 'voldown',
};

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);
}

export function startRemote(): () => void {
  if (typeof window === 'undefined') return () => {};

  const onKey = (ev: KeyboardEvent, action: 'down' | 'up') => {
    // Ctrl+K / ⌘K: search from anywhere, even while typing
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      ev.stopPropagation();
      if (action === 'down' && !ev.repeat) feedKey('search', 'down', 0);
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const active = document.activeElement;
    if (isTextField(active)) {
      // While typing, only escape/arrow up-down leave the field; everything else is text input
      if (action === 'down' && (ev.key === 'Escape' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        (active as HTMLElement).blur();
        if (ev.key !== 'Escape') feedKey(ev.key === 'ArrowUp' ? 'up' : 'down', 'down', 0);
        ev.preventDefault();
      }
      return;
    }
    let key = MAP[ev.key];
    let digit: number | undefined;
    if (!key && /^[0-9]$/.test(ev.key)) {
      key = 'digit';
      digit = Number(ev.key);
    }
    if (!key) return;
    // We own navigation keys: stop them reaching DOM-focused buttons (which would "click" them)
    ev.preventDefault();
    ev.stopPropagation();
    feedKey(key, action, ev.repeat ? 1 : 0, digit);
  };
  const down = (ev: KeyboardEvent) => onKey(ev, 'down');
  const up = (ev: KeyboardEvent) => onKey(ev, 'up');
  const pointer = () => useInputMode.getState().setMode('pointer');
  // Clicked buttons keep DOM focus; drop it so Enter/Space only go through the key router
  const blur = () => {
    const el = document.activeElement as HTMLElement | null;
    if (el && !isTextField(el) && el !== document.body) el.blur();
  };

  window.addEventListener('keydown', down, true);
  window.addEventListener('keyup', up, true);
  window.addEventListener('mousemove', pointer, { passive: true });
  window.addEventListener('touchstart', pointer, { passive: true });
  window.addEventListener('pointerup', blur, true);
  return () => {
    window.removeEventListener('keydown', down, true);
    window.removeEventListener('keyup', up, true);
    window.removeEventListener('mousemove', pointer);
    window.removeEventListener('touchstart', pointer);
    window.removeEventListener('pointerup', blur, true);
  };
}
