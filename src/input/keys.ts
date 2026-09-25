import { useEffect, useRef } from 'react';
import { create } from 'zustand';

export type KeyName =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'select'
  | 'back'
  | 'menu'
  | 'playpause'
  | 'ff'
  | 'rw'
  | 'chup'
  | 'chdown'
  | 'info'
  | 'guide'
  | 'digit'
  /** voice/search shortcut: hold Menu, a remote's Search/Assistant key, or "/" on the web */
  | 'search'
  // player shortcuts (web keyboard, remotes with dedicated keys)
  | 'mute'
  | 'fullscreen'
  | 'captions'
  | 'faster'
  | 'slower'
  | 'pip';

export interface KeyEvt {
  key: KeyName;
  /** 0 for the first press, >0 while the key is held */
  repeat: number;
  /** long-press of select */
  long?: boolean;
  digit?: number;
}

/** Return `false` to let the event bubble to lower layers; anything else marks it handled. */
export type KeyHandler = (e: KeyEvt) => boolean | void;

export const Layer = {
  shell: -10,
  screen: 0,
  panel: 10,
  player: 20,
  sheet: 30,
  dialog: 40,
} as const;

interface Entry {
  id: number;
  layer: number;
  ref: { current: KeyHandler };
}

let seq = 0;
const entries: Entry[] = [];

export function dispatchKey(e: KeyEvt): boolean {
  useInputMode.getState().setMode('key');
  const ordered = [...entries].sort((a, b) => b.layer - a.layer || b.id - a.id);
  for (const h of ordered) {
    if (h.ref.current(e) !== false) return true;
  }
  return false;
}

/**
 * Registers a key handler while `enabled`. Higher layers get events first; within a layer,
 * the most recently mounted handler wins (so nested panels naturally take over).
 */
export function useKeys(handler: KeyHandler, enabled = true, layer: number = Layer.screen) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const entry: Entry = { id: ++seq, layer, ref };
    entries.push(entry);
    return () => {
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
    };
  }, [enabled, layer]);
}

// ---- input mode: focus rings only render while navigating with keys/remote ----

type Mode = 'key' | 'pointer';
interface InputModeState {
  mode: Mode;
  locked: boolean;
  setMode: (m: Mode) => void;
  lock: (m: Mode) => void;
}

export const useInputMode = create<InputModeState>((set, get) => ({
  mode: 'pointer',
  locked: false,
  setMode: (m) => {
    if (get().locked || get().mode === m) return;
    set({ mode: m });
  },
  lock: (m) => set({ mode: m, locked: true }),
}));

export const useKeyMode = () => useInputMode((s) => s.mode === 'key');

// ---- raw key feed shared by platform sources: turns down/up pairs into press vs long-press ----
// OK: short = select, held = select+long (context menu). Menu: short = menu, held = search.

let heldKey: KeyName | null = null;
let heldLong = false;

export function feedKey(key: KeyName, action: 'down' | 'up', repeat: number, digit?: number): boolean {
  if (key === 'select' || key === 'menu') {
    if (action === 'down') {
      if (repeat === 0) {
        heldKey = key;
        heldLong = false;
        return true;
      }
      if (heldKey === key && !heldLong && repeat >= 1) {
        heldLong = true;
        return key === 'select' ? dispatchKey({ key: 'select', repeat: 0, long: true }) : dispatchKey({ key: 'search', repeat: 0 });
      }
      return true;
    }
    const wasHeld = heldKey === key;
    heldKey = null;
    if (wasHeld && !heldLong) return dispatchKey({ key, repeat: 0 });
    return true;
  }
  if (action === 'up') return false;
  return dispatchKey({ key, repeat, digit });
}
