import React, { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, useLayout } from '../theme';
import { useUI, type Screen } from '../store/ui';
import { useLibrary } from '../store/library';
import { useActivePlaylist } from '../store/settings';
import { usePlayer } from '../store/player';
import { Layer, useKeys } from '../input/keys';
import { Icon } from '../components/Icon';
import { Button } from '../components/Button';
import { Focusable } from '../components/Focusable';
import { GuideScreen } from './GuideScreen';
import { VodScreen } from './VodScreen';
import { SearchScreen } from './SearchScreen';
import { SettingsScreen } from './SettingsScreen';

const NAV: { id: Screen; label: string; icon: string }[] = [
  { id: 'guide', label: 'Live TV', icon: 'television-classic' },
  { id: 'movies', label: 'Movies', icon: 'movie-open-outline' },
  { id: 'series', label: 'Series', icon: 'television-play' },
  { id: 'search', label: 'Search', icon: 'magnify' },
  { id: 'settings', label: 'Settings', icon: 'cog-outline' },
];

export function Shell() {
  const { s, mode } = useLayout();
  const tv = mode === 'tv';
  const insets = useSafeAreaInsets();
  const screen = useUI((st) => st.screen);
  const setScreen = useUI((st) => st.setScreen);
  const menuFocused = useUI((st) => st.menuFocused);
  const setMenuFocused = useUI((st) => st.setMenuFocused);
  const openSheet = useUI((st) => st.openSheet);
  const detail = useUI((st) => !!st.detail);
  const editor = useUI((st) => !!st.editor);
  const fullscreen = usePlayer((st) => st.fullscreen && !!st.item);
  const [railIndex, setRailIndex] = useState(0);

  useEffect(() => {
    if (menuFocused) setRailIndex(Math.max(0, NAV.findIndex((n) => n.id === screen)));
  }, [menuFocused, screen]);

  const exitPrompt = () => {
    if (Platform.OS !== 'android') return false;
    openSheet({
      title: 'Exit Nova?',
      options: [
        { label: 'Exit', icon: 'exit-to-app', onSelect: () => BackHandler.exitApp() },
        { label: 'Cancel', icon: 'close', onSelect: () => {} },
      ],
    });
  };

  // Screens bubble "left" at their left edge and "back" at their root to here.
  useKeys(
    (e) => {
      if (e.key === 'left' || e.key === 'back') {
        if (!tv) return false;
        setMenuFocused(true);
        return;
      }
      return false;
    },
    !fullscreen && !detail && !editor,
    Layer.shell
  );

  useKeys(
    (e) => {
      switch (e.key) {
        case 'up':
          return setRailIndex((i) => Math.max(0, i - 1));
        case 'down':
          return setRailIndex((i) => Math.min(NAV.length - 1, i + 1));
        case 'select':
          if (NAV[railIndex].id === screen) return setMenuFocused(false);
          return setScreen(NAV[railIndex].id);
        case 'right':
          return setMenuFocused(false);
        case 'back':
          return exitPrompt() === false ? setMenuFocused(false) : undefined;
        default:
          return;
      }
    },
    menuFocused && !fullscreen && !detail && !editor,
    Layer.panel
  );

  const content = <Content screen={screen} />;

  if (!tv) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={{ flex: 1 }}>{content}</View>
        <View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.bgElevated, paddingBottom: Math.max(insets.bottom, 6), paddingTop: 6 }}>
          {NAV.map((n) => {
            const on = n.id === screen;
            return (
              <Pressable key={n.id} focusable={false} onPress={() => setScreen(n.id)} style={{ flex: 1, alignItems: 'center', paddingVertical: 4 }} testID={`tab-${n.id}`}>
                <Icon name={n.icon} size={22} color={on ? colors.accent : colors.muted} />
                <Text style={{ color: on ? colors.text : colors.muted, fontSize: 10.5, fontWeight: '600', marginTop: 2 }}>{n.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  const railW = s(62);
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <View style={{ width: railW }} />
      <View style={{ flex: 1 }}>{content}</View>
      {/* rail sits on top so it can expand over the content when focused */}
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: menuFocused ? s(210) : railW, backgroundColor: colors.bgElevated, borderRightWidth: 1, borderColor: colors.border, paddingTop: s(18), paddingHorizontal: s(8) }}>
        {menuFocused ? <LinearGradient colors={['rgba(76,141,255,0.10)', 'transparent']} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: s(160) }} /> : null}
        <View style={{ alignItems: menuFocused ? 'flex-start' : 'center', marginBottom: s(18), paddingLeft: menuFocused ? s(10) : 0, flexDirection: 'row' }}>
          <View style={{ width: s(30), height: s(30), borderRadius: s(9), backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="television-classic" size={s(17)} color="#fff" />
          </View>
          {menuFocused ? <Text style={{ color: colors.text, fontSize: s(17), fontWeight: '900', marginLeft: s(10), alignSelf: 'center' }}>Nova</Text> : null}
        </View>
        {NAV.map((n, i) => {
          const on = n.id === screen;
          return (
            <Focusable
              key={n.id}
              focused={menuFocused && i === railIndex}
              onPress={() => setScreen(n.id)}
              testID={`nav-${n.id}`}
              style={{ height: s(40), borderRadius: s(9), flexDirection: 'row', alignItems: 'center', justifyContent: menuFocused ? 'flex-start' : 'center', paddingHorizontal: menuFocused ? s(12) : 0, marginBottom: s(4), backgroundColor: on && !menuFocused ? colors.accentSoft : 'transparent' }}
              focusStyle={{ backgroundColor: colors.focus }}
            >
              {({ focused }) => (
                <>
                  <Icon name={n.icon} size={s(19)} color={focused ? colors.focusText : on ? colors.accent : colors.textDim} />
                  {menuFocused ? (
                    <Text style={{ marginLeft: s(12), color: focused ? colors.focusText : on ? colors.accent : colors.text, fontSize: s(13), fontWeight: '700' }}>{n.label}</Text>
                  ) : null}
                </>
              )}
            </Focusable>
          );
        })}
      </View>
    </View>
  );
}

function Content({ screen }: { screen: Screen }) {
  const status = useLibrary((st) => st.status);
  const hasChannels = useLibrary((st) => st.channels.length > 0);
  if (!hasChannels && (status === 'loading' || status === 'idle')) return <Loading />;
  if (!hasChannels && status === 'error' && screen !== 'settings') return <LoadError />;
  switch (screen) {
    case 'guide':
      return <GuideScreen />;
    case 'movies':
      return <VodScreen key="movies" kind="movies" />;
    case 'series':
      return <VodScreen key="series" kind="series" />;
    case 'search':
      return <SearchScreen />;
    case 'settings':
      return <SettingsScreen />;
  }
}

function Loading() {
  const { s, mode } = useLayout();
  const message = useLibrary((st) => st.message);
  const playlist = useActivePlaylist();
  const k = mode === 'tv' ? s : (n: number) => n;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color={colors.accent} />
      <Text style={{ color: colors.text, fontSize: k(15), fontWeight: '700', marginTop: k(14) }}>{playlist?.name}</Text>
      <Text style={{ color: colors.textDim, fontSize: k(12), marginTop: k(4) }}>{message ?? 'Loading…'}</Text>
    </View>
  );
}

function LoadError() {
  const { s, mode } = useLayout();
  const k = mode === 'tv' ? s : (n: number) => n * 1.1;
  const error = useLibrary((st) => st.error);
  const playlist = useActivePlaylist();
  const openEditor = useUI((st) => st.openEditor);
  const setScreen = useUI((st) => st.setScreen);
  const editor = useUI((st) => !!st.editor);
  const [btn, setBtn] = useState(0);
  const actions = [
    () => playlist && useLibrary.getState().load(playlist, { force: true }),
    () => playlist && playlist.type !== 'demo' && openEditor(playlist),
    () => setScreen('settings'),
  ];
  useKeys(
    (e) => {
      if (e.key === 'left') return btn === 0 ? false : setBtn(btn - 1);
      if (e.key === 'right') return setBtn(Math.min(2, btn + 1));
      if (e.key === 'select') return void actions[btn]();
      return false;
    },
    !editor
  );
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Icon name="alert-circle-outline" size={k(40)} color={colors.live} />
      <Text style={{ color: colors.text, fontSize: k(17), fontWeight: '800', marginTop: k(12) }}>Couldn't load “{playlist?.name}”</Text>
      <Text style={{ color: colors.textDim, fontSize: k(12.5), marginTop: k(6), textAlign: 'center', maxWidth: k(520) }}>{error}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: k(10), marginTop: k(20) }}>
        <Button label="Retry" icon="refresh" primary focused={btn === 0} onPress={actions[0]} />
        <Button label="Edit playlist" icon="pencil-outline" focused={btn === 1} onPress={actions[1]} />
        <Button label="Settings" icon="cog-outline" focused={btn === 2} onPress={actions[2]} />
      </View>
    </View>
  );
}
