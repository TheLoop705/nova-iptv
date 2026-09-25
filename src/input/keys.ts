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
  | 'digit';

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

// ---- raw key feed shared by platform sources: turns down/up pairs into select vs long-select ----

let selectDown = false;
let selectLong = false;

export function feedKey(key: KeyName, action: 'down' | 'up', repeat: number, digit?: number): boolean {
  if (key === 'select') {
    if (action === 'down') {
      if (repeat === 0) {
        selectDown = true;
        selectLong = false;
        return true;
      }
      if (selectDown && !selectLong && repeat >= 1) {
        selectLong = true;
        return dispatchKey({ key: 'select', repeat: 0, long: true });
      }
      return true;
    }
    const wasDown = selectDown;
    selectDown = false;
    if (wasDown && !selectLong) return dispatchKey({ key: 'select', repeat: 0 });
    return true;
  }
  if (action === 'up') return false;
  return dispatchKey({ key, repeat, digit });
}
