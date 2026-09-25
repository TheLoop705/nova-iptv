import { create } from 'zustand';
import type { Playlist, SeriesItem, VodItem } from '../types';

export type Screen = 'home' | 'guide' | 'movies' | 'series' | 'search' | 'settings';

export interface SheetOption {
  label: string;
  icon?: string;
  detail?: string;
  selected?: boolean;
  destructive?: boolean;
  onSelect: () => void;
}

export interface Sheet {
  title: string;
  subtitle?: string;
  options: SheetOption[];
}

export type Detail = { kind: 'movie'; item: VodItem } | { kind: 'series'; item: SeriesItem };

interface UIState {
  screen: Screen;
  detail: Detail | null;
  /** playlist editor: `true` for a new playlist */
  editor: { playlist?: Playlist } | null;
  setDetail: (d: Detail | null) => void;
  openEditor: (playlist?: Playlist) => void;
  closeEditor: () => void;
  /** bumps whenever search should open with the keyboard ready (voice search shortcut) */
  searchNonce: number;
  focusSearch: () => void;
  /** main menu rail has key focus */
  menuFocused: boolean;
  sheet: Sheet | null;
  toast: { text: string; id: number } | null;
  setScreen: (s: Screen) => void;
  setMenuFocused: (v: boolean) => void;
  openSheet: (s: Sheet) => void;
  closeSheet: () => void;
  showToast: (text: string) => void;
}

export const useUI = create<UIState>((set) => ({
  screen: 'home',
  detail: null,
  editor: null,
  setDetail: (detail) => set({ detail }),
  openEditor: (playlist) => set({ editor: { playlist } }),
  closeEditor: () => set({ editor: null }),
  searchNonce: 0,
  focusSearch: () => set((s) => ({ searchNonce: s.searchNonce + 1 })),
  menuFocused: false,
  sheet: null,
  toast: null,
  setScreen: (screen) => set({ screen, menuFocused: false, detail: null }),
  setMenuFocused: (menuFocused) => set({ menuFocused }),
  openSheet: (sheet) => set({ sheet }),
  closeSheet: () => set({ sheet: null }),
  showToast: (text) => set({ toast: { text, id: Date.now() } }),
}));
