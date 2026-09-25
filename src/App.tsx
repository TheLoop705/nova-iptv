import React, { useEffect, useRef } from 'react';
import { Platform, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors, useLayout } from './theme';
import { useActivePlaylist, useSettings } from './store/settings';
import { useLibrary } from './store/library';
import { usePlayer } from './store/player';
import { useUI } from './store/ui';
import { startRemote } from './input/remote';
import { Shell } from './screens/Shell';
import { Onboarding } from './screens/Onboarding';
import { PlaylistEditor } from './screens/PlaylistEditor';
import { DetailHost } from './screens/DetailHost';
import { VideoLayer } from './player/VideoLayer';
import { PlayerOverlay } from './player/PlayerOverlay';
import { SheetHost, Toast } from './components/SheetHost';
import { usePlayback } from './player/playback';

if (__DEV__ && Platform.OS === 'web' && typeof window !== 'undefined') {
  // handy for poking at state from the browser console while developing
  (window as any).__nova = { useSettings, useLibrary, usePlayer, useUI, usePlayback };
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const { mode } = useLayout();
  const hydrated = useSettings((s) => s.hydrated);
  const hasPlaylists = useSettings((s) => s.playlists.length > 0);
  const active = useActivePlaylist();
  const editor = useUI((s) => !!s.editor);
  const fullscreen = usePlayer((s) => s.fullscreen && !!s.item);

  useEffect(() => {
    void useSettings.getState().hydrate();
    return startRemote();
  }, []);

  // (Re)load the library whenever the active playlist changes
  useEffect(() => {
    if (!hydrated) return;
    if (active) void useLibrary.getState().load(active);
    else useLibrary.getState().reset();
  }, [hydrated, active?.id]);

  // Phones: fullscreen video goes landscape, the guide follows the device again afterwards
  useEffect(() => {
    if (Platform.OS === 'web' || Platform.isTV) return;
    if (fullscreen) void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    else void ScreenOrientation.unlockAsync().catch(() => {});
  }, [fullscreen]);

  // Optionally resume the last channel once channels are available
  const autoStarted = useRef(false);
  const ready = useLibrary((s) => s.status === 'ready' && s.channels.length > 0);
  useEffect(() => {
    if (!ready || autoStarted.current || !active) return;
    autoStarted.current = true;
    const st = useSettings.getState();
    const last = st.lastChannel[active.id];
    if (st.prefs.startWithLastChannel && last && useLibrary.getState().byId[last]) {
      usePlayer.getState().playChannel(last, { fullscreen: true });
    }
  }, [ready, active]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" hidden={mode === 'tv' || fullscreen} />
      {!hydrated ? null : hasPlaylists ? <Shell /> : <Onboarding />}
      <DetailHost />
      {editor ? <PlaylistEditor /> : null}
      <VideoLayer />
      {fullscreen ? <PlayerOverlay /> : null}
      <SheetHost />
      <Toast />
      {Platform.OS === 'web' ? <WebStyles /> : null}
    </View>
  );
}

/** Web-only global CSS: hide scrollbars on TV-style lists, remove focus outlines. */
function WebStyles() {
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = `
      html, body, #root { background: ${colors.bg}; overscroll-behavior: none; }
      *:focus { outline: none; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-thumb { background: #2a3140; border-radius: 4px; }
      ::-webkit-scrollbar-track { background: transparent; }
      input { caret-color: ${colors.accent}; }
    `;
    document.head.appendChild(el);
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap';
    document.head.appendChild(font);
    return () => {
      el.remove();
      font.remove();
    };
  }, []);
  return null;
}
