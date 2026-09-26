import React, { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, useLayout } from '../theme';
import { useUI, type Screen } from '../store/ui';
import { useLibrary } from '../store/library';
import { useActivePlaylist } from '../store/settings';
import { usePlayer } from '../store/player';
import { Layer, useKeys } from '../input/keys';
import { openSearch } from '../store/actions';
import { Icon } from '../components/Icon';
import { Button } from '../components/Button';
import { Focusable } from '../components/Focusable';
import { NovaMark } from '../components/NovaMark';
import { GuideScreen } from './GuideScreen';
import { HomeScreen } from './HomeScreen';
import { VodScreen } from './VodScreen';
import { SearchScreen } from './SearchScreen';
import { SettingsScreen } from './SettingsScreen';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Keyboard shortcuts shown in the rail's hover hints (web). */
const SHORTCUTS: Partial<Record<Screen, string>> = { search: isMac ? '⌘K' : 'Ctrl K' };

const NAV: { id: Screen; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home-outline' },
  { id: 'guide', label: 'Live TV', icon: 'television-classic' },
  { id: 'movies', label: 'Movies', icon: 'movie-open-outline' },
  { id: 'series', label: 'Series', icon: 'television-play' },
  { id: 'search', label: 'Search', icon: 'magnify' },
  { id: 'settings', label: 'Settings', icon: 'cog-outline' },
];

export function Shell() {
  const { s, mode, safe, type } = useLayout();
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
          if (NAV[railIndex].id === 'search') return openSearch();
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
      <View style={{ flex: 1, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
        <View style={{ flex: 1 }}>{content}</View>
        <View
          accessibilityRole="tablist"
          style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.bgElevated, paddingBottom: Math.max(insets.bottom, 8), paddingTop: 6 }}
        >
          {NAV.map((n) => {
            const on = n.id === screen;
            return (
              <Pressable
                key={n.id}
                focusable={false}
                onPress={() => setScreen(n.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={n.label}
                style={{ flex: 1, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}
                testID={`tab-${n.id}`}
              >
                <View style={{ width: 56, height: 30, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.accentSoft : 'transparent' }}>
                  <Icon name={n.icon} size={22} color={on ? colors.accent : colors.muted} />
                </View>
                <Text style={[type('caption'), { fontSize: 11, lineHeight: 14, fontWeight: on ? '700' : '600', color: on ? colors.text : colors.muted, marginTop: 2 }]}>{n.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  const railW = s(64);
  const openW = s(220);
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <View style={{ width: railW }} />
      <View style={{ flex: 1, paddingTop: safe.y, paddingBottom: safe.y, paddingRight: safe.x }}>{content}</View>
      {menuFocused ? <Pressable focusable={false} onPress={() => setMenuFocused(false)} style={{ position: 'absolute', left: openW, right: 0, top: 0, bottom: 0, backgroundColor: colors.scrim }} /> : null}
      {/* rail sits on top so it can expand over the content when focused */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: menuFocused ? openW : railW,
          backgroundColor: colors.bgElevated,
          borderRightWidth: 1,
          borderColor: menuFocused ? colors.borderStrong : colors.border,
          paddingTop: s(18) + safe.y,
          paddingHorizontal: s(10),
        }}
      >
        <View style={{ alignItems: 'center', marginBottom: s(22), paddingLeft: menuFocused ? s(6) : 0, flexDirection: 'row', justifyContent: menuFocused ? 'flex-start' : 'center' }}>
          <NovaMark size={s(32)} />
          {menuFocused ? <Text style={[type('heading'), { color: colors.text, fontWeight: '800', marginLeft: s(10), letterSpacing: -0.2 }]}>Nova</Text> : null}
        </View>
        {NAV.map((n, i) => {
          const on = n.id === screen;
          return (
            <Focusable
              key={n.id}
              focused={menuFocused && i === railIndex}
              onPress={() => (n.id === 'search' ? openSearch() : setScreen(n.id))}
              testID={`nav-${n.id}`}
              accessibilityLabel={n.label}
              style={{
                height: s(40),
                borderRadius: s(radius.md),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: menuFocused ? 'flex-start' : 'center',
                paddingHorizontal: menuFocused ? s(12) : 0,
                marginBottom: s(4),
                backgroundColor: on ? colors.accentSoft : 'transparent',
              }}
              focusStyle={{ backgroundColor: colors.focus, transform: [{ scale: 1.03 }] }}
            >
              {({ focused, hovered }) => (
                <>
                  {on && !focused ? <View style={{ position: 'absolute', left: -s(10), top: s(10), bottom: s(10), width: s(3), borderRadius: s(2), backgroundColor: colors.accent }} /> : null}
                  <Icon name={n.icon} size={s(19)} color={focused ? colors.focusText : on || hovered ? colors.accent : colors.textDim} />
                  {menuFocused ? (
                    <Text style={[type('label'), { fontSize: s(13.5), marginLeft: s(12), color: focused ? colors.focusText : on ? colors.text : colors.textDim }]}>{n.label}</Text>
                  ) : null}
                  {hovered && !menuFocused ? <RailHint label={n.label} shortcut={SHORTCUTS[n.id]} /> : null}
                </>
              )}
            </Focusable>
          );
        })}
        {menuFocused ? (
          <Text style={[type('caption'), { position: 'absolute', left: s(16), right: s(12), bottom: s(14) + safe.y, color: colors.muted }]}>Back to exit · → to return</Text>
        ) : null}
      </View>
    </View>
  );
}

/** Hover hint next to a collapsed rail icon (mouse): the section's name and its shortcut. */
function RailHint({ label, shortcut }: { label: string; shortcut?: string }) {
  const { s, type } = useLayout();
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: '100%', marginLeft: s(14), flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface3, borderRadius: s(radius.sm), borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: s(10), paddingVertical: s(5) }}
    >
      <Text style={[type('label'), { color: colors.text, whiteSpace: 'nowrap' } as object]}>{label}</Text>
      {shortcut ? (
        <View style={{ marginLeft: s(10), borderRadius: s(radius.xs), borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: s(5), paddingVertical: s(1) }}>
          <Text style={[type('caption'), { color: colors.textDim, fontWeight: '700' }]}>{shortcut}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Content({ screen }: { screen: Screen }) {
  const status = useLibrary((st) => st.status);
  const hasChannels = useLibrary((st) => st.channels.length > 0);
  if (!hasChannels && (status === 'loading' || status === 'idle')) return <Loading />;
  if (!hasChannels && status === 'error' && screen !== 'settings') return <LoadError />;
  switch (screen) {
    case 'home':
      return <HomeScreen />;
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
  const { k, type } = useLayout();
  const message = useLibrary((st) => st.message);
  const playlist = useActivePlaylist();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color={colors.accent} />
      <Text style={[type('heading'), { color: colors.text, marginTop: k(16) }]}>{playlist?.name}</Text>
      <Text style={[type('caption'), { color: colors.textDim, marginTop: k(4) }]}>{message ?? 'Loading…'}</Text>
    </View>
  );
}

function LoadError() {
  const { k, type } = useLayout();
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
      <Text style={[type('heading'), { color: colors.text, marginTop: k(12), textAlign: 'center' }]}>Couldn't load “{playlist?.name}”</Text>
      <Text style={[type('body'), { color: colors.textDim, marginTop: k(6), textAlign: 'center', maxWidth: k(520) }]}>{error}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: k(10), marginTop: k(20) }}>
        <Button label="Retry" icon="refresh" primary focused={btn === 0} onPress={actions[0]} />
        <Button label="Edit playlist" icon="pencil-outline" focused={btn === 1} onPress={actions[1]} />
        <Button label="Settings" icon="cog-outline" focused={btn === 2} onPress={actions[2]} />
      </View>
    </View>
  );
}
