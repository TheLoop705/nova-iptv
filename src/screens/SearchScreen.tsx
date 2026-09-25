import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { colors, fonts, radius, useLayout } from '../theme';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { useUI } from '../store/ui';
import { useKeyMode, useKeys, type KeyEvt } from '../input/keys';
import { Focusable } from '../components/Focusable';
import { Logo, Poster } from '../components/Logo';
import { Icon } from '../components/Icon';
import { programAt } from '../services/epg';
import { compactTitle, matchScore, queryWords } from '../services/searchMatch';
import { speechAvailable, startListening } from '../services/speech';
import type { SeriesItem, VodItem } from '../types';
import { RemoteKeys } from '../../modules/remote-keys';

interface Result {
  key: string;
  type: 'channel' | 'movie' | 'series';
  title: string;
  subtitle?: string;
  image?: string;
  run: () => void;
}

export function SearchScreen() {
  const { s, mode } = useLayout();
  const tv = mode === 'tv';
  const k = tv ? s : (n: number) => n * 1.1;
  const channels = useLibrary((st) => st.channels);
  const movies = useLibrary((st) => st.movies);
  const series = useLibrary((st) => st.series);
  const epg = useLibrary((st) => st.epg);
  const vodAll = useLibrary((st) => st.vodStatus.all);
  const loadAllVod = useLibrary((st) => st.loadAllVod);
  const menuFocused = useUI((st) => st.menuFocused);
  const detail = useUI((st) => st.detail);
  const setDetail = useUI((st) => st.setDetail);
  const playChannel = usePlayer((st) => st.playChannel);
  const searchNonce = useUI((st) => st.searchNonce);
  const keyMode = useKeyMode();

  const [q, setQ] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const stopVoice = useRef<(() => void) | null>(null);
  const canListen = useMemo(() => speechAvailable(), []);
  const [zone, setZone] = useState<'input' | 'results'>('input');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<Result>>(null);
  const rowH = tv ? s(50) : 64;

  useEffect(() => {
    if (q.trim().length >= 2) void loadAllVod();
  }, [q, loadAllVod]);

  // Voice-search shortcut (hold Menu / Search key / "/") and remote users: open the keyboard right away.
  // On Fire TV the open keyboard is what lets the remote's mic button dictate into the field.
  const focusInput = () => {
    setZone('input');
    setTimeout(() => inputRef.current?.focus(), 120);
    // Focusing alone doesn't raise the Android TV keyboard, so ask for it explicitly — once now,
    // and again after the shortcut key (held Menu) has been released.
    if (Platform.OS === 'android') {
      for (const ms of [300, 900]) {
        setTimeout(() => {
          inputRef.current?.focus();
          RemoteKeys?.showKeyboard().catch(() => {});
        }, ms);
      }
    }
  };
  useEffect(() => {
    // Shortcut = new search: clear the old query so dictation doesn't append to it
    if (searchNonce > 0) {
      setQ('');
      focusInput();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchNonce]);
  useEffect(() => {
    if (Platform.isTV || keyMode || Platform.OS === 'web') focusInput();
    return () => stopVoice.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleVoice = () => {
    if (listening) {
      stopVoice.current?.();
      setListening(false);
      return;
    }
    setVoiceError(null);
    setListening(true);
    stopVoice.current = startListening(
      (text) => setQ(text),
      (err) => {
        setListening(false);
        stopVoice.current = null;
        if (err) setVoiceError(err);
      }
    );
  };

  const results = useMemo<Result[]>(() => {
    const words = queryWords(q.trim());
    if (q.trim().length < 2 || !words.length) return [];
    const now = Date.now();
    const scored: { r: Result; score: number; kind: number }[] = [];
    let cCount = 0;
    for (const c of channels) {
      const score = matchScore(words, compactTitle(c.name));
      if (!score) continue;
      const p = programAt(epg[c.id], now);
      scored.push({
        score,
        kind: 0,
        r: {
          key: 'c' + c.id,
          type: 'channel',
          title: c.name,
          subtitle: p ? `Now: ${p.title}` : c.group,
          image: c.logo,
          run: () => playChannel(c.id, { groupId: 'all', fullscreen: true }),
        },
      });
      if (++cCount >= 80) break;
    }
    const seen = new Set<string>();
    let mCount = 0;
    for (const list of Object.values(movies)) {
      for (const m of list as VodItem[]) {
        if (mCount >= 60 || seen.has(m.id)) continue;
        const score = matchScore(words, compactTitle(m.name));
        if (!score) continue;
        seen.add(m.id);
        mCount++;
        scored.push({ score, kind: 1, r: { key: 'm' + m.id, type: 'movie', title: m.name, subtitle: ['Movie', m.year].filter(Boolean).join(' · '), image: m.poster, run: () => setDetail({ kind: 'movie', item: m }) } });
      }
    }
    let sCount = 0;
    for (const list of Object.values(series)) {
      for (const sr of list as SeriesItem[]) {
        if (sCount >= 60 || seen.has(sr.id)) continue;
        const score = matchScore(words, compactTitle(sr.name));
        if (!score) continue;
        seen.add(sr.id);
        sCount++;
        scored.push({ score, kind: 2, r: { key: 's' + sr.id, type: 'series', title: sr.name, subtitle: ['Series', sr.year].filter(Boolean).join(' · '), image: sr.poster, run: () => setDetail({ kind: 'series', item: sr }) } });
      }
    }
    // Best matches first; channels before movies before series on ties
    scored.sort((a, b) => b.score - a.score || a.kind - b.kind);
    return scored.map((x) => x.r);
  }, [q, channels, movies, series, epg, playChannel, setDetail]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    if (zone === 'results') listRef.current?.scrollToOffset({ offset: Math.max(0, (idx - 3) * rowH), animated: true });
  }, [idx, zone, rowH]);

  const onKey = (e: KeyEvt): boolean | void => {
    if (e.key === 'search') return focusInput();
    if (zone === 'input') {
      if (e.key === 'select') return inputRef.current?.focus();
      if (e.key === 'down' && results.length) return setZone('results');
      if (e.key === 'left' || e.key === 'back') return false;
      return;
    }
    switch (e.key) {
      case 'up':
        return idx === 0 ? setZone('input') : setIdx(idx - 1);
      case 'down':
        return setIdx(Math.min(results.length - 1, idx + 1));
      case 'select':
        return results[idx]?.run();
      case 'back':
        return setZone('input');
      case 'left':
        return false;
      default:
        return;
    }
  };
  useKeys(onKey, !menuFocused && !detail);

  return (
    <View style={{ flex: 1, padding: tv ? s(22) : 16 }}>
      <Text style={{ color: colors.text, fontSize: tv ? s(22) : 28, fontWeight: '800', letterSpacing: -0.3, fontFamily: fonts.regular, marginBottom: k(12) }}>Search</Text>
      <Focusable
        focused={zone === 'input'}
        onPress={() => inputRef.current?.focus()}
        style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderRadius: k(radius.md), paddingHorizontal: k(12), height: tv ? s(42) : 48, borderWidth: 2, borderColor: colors.border }}
        hoverStyle={{ borderColor: colors.borderStrong }}
        focusStyle={{ borderColor: colors.focus }}
      >
        <Icon name="magnify" size={k(18)} color={colors.textDim} />
        <TextInput
          ref={inputRef}
          value={q}
          onChangeText={setQ}
          placeholder="Channels, movies, series…"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onFocus={() => setZone('input')}
          onSubmitEditing={() => results.length && setZone('results')}
          style={{ flex: 1, color: colors.text, fontSize: k(14), marginLeft: k(8), height: '100%', fontFamily: fonts.regular, outlineStyle: 'none' } as any}
          testID="search-input"
        />
        {vodAll === 'loading' ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        {canListen ? (
          <Pressable
            focusable={false}
            onPress={toggleVoice}
            accessibilityLabel={listening ? 'Stop voice search' : 'Search by voice'}
            testID="search-mic"
            style={{ marginLeft: k(8), width: k(30), height: k(30), borderRadius: k(15), alignItems: 'center', justifyContent: 'center', backgroundColor: listening ? colors.liveFill : 'transparent' }}
          >
            <Icon name={listening ? 'microphone' : 'microphone-outline'} size={k(18)} color={listening ? colors.onLive : colors.textDim} />
          </Pressable>
        ) : null}
      </Focusable>
      {listening ? <Text style={{ color: colors.live, fontSize: k(12), marginTop: k(8), fontWeight: '600' }}>Listening… say a channel, movie or show</Text> : null}
      {voiceError ? <Text style={{ color: colors.star, fontSize: k(12), marginTop: k(8) }}>{voiceError}</Text> : null}

      {q.trim().length >= 2 && !results.length ? (
        <Text style={{ color: colors.muted, fontSize: k(13), marginTop: k(20) }}>No results for “{q.trim()}”.</Text>
      ) : null}
      {q.trim().length < 2 && !listening ? <VoiceHint k={k} canListen={canListen} /> : null}

      <FlatList
        ref={listRef}
        data={results}
        keyExtractor={(r) => r.key}
        style={{ marginTop: k(12) }}
        keyboardShouldPersistTaps="handled"
        getItemLayout={(_d, i) => ({ length: rowH, offset: rowH * i, index: i })}
        renderItem={({ item: r, index }) => (
          <Focusable
            focused={zone === 'results' && index === idx}
            onPress={r.run}
            style={{ height: rowH - k(4), marginBottom: k(4), borderRadius: k(radius.md), flexDirection: 'row', alignItems: 'center', paddingHorizontal: k(10), backgroundColor: colors.surface }}
            focusStyle={{ backgroundColor: colors.focus }}
          >
            {({ focused }) => (
              <>
                {r.type === 'channel' ? (
                  <Logo uri={r.image} name={r.title} size={k(26)} />
                ) : (
                  <View style={{ width: k(42), alignItems: 'center' }}>
                    <Poster uri={r.image} name={r.title} width={k(28)} />
                  </View>
                )}
                <View style={{ flex: 1, marginLeft: k(12) }}>
                  <Text numberOfLines={1} style={{ color: focused ? colors.focusText : colors.text, fontWeight: '700', fontSize: k(13) }}>
                    {r.title}
                  </Text>
                  {r.subtitle ? (
                    <Text numberOfLines={1} style={{ color: focused ? colors.focusDim : colors.muted, fontSize: k(11.5), marginTop: 2 }}>
                      {r.subtitle}
                    </Text>
                  ) : null}
                </View>
                <Icon name={r.type === 'channel' ? 'television-classic' : r.type === 'movie' ? 'movie-open-outline' : 'television-play'} size={k(16)} color={focused ? colors.focusText : colors.muted} />
              </>
            )}
          </Focusable>
        )}
      />
    </View>
  );
}

/** How to search by voice on this device. */
function VoiceHint({ k, canListen }: { k: (n: number) => number; canListen: boolean }) {
  const tip = (icon: string, text: string) => (
    <View key={text} style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: k(10) }}>
      <Icon name={icon} size={k(16)} color={colors.accent} style={{ marginTop: k(1), marginRight: k(10) }} />
      <Text style={{ flex: 1, color: colors.textDim, fontSize: k(12.5), lineHeight: k(18) }}>{text}</Text>
    </View>
  );
  let tips: React.ReactNode[];
  if (Platform.OS === 'android' && Platform.isTV) {
    tips = [
      tip('microphone', 'Voice search: while the keyboard is open, press and hold the microphone button on your remote and say a channel, movie or show.'),
      tip('menu', 'Shortcut: hold the ☰ Menu button anywhere in Nova to jump straight here with the keyboard open.'),
    ];
  } else if (Platform.OS === 'web') {
    tips = [
      canListen
        ? tip('microphone', 'Click the microphone to search by voice.')
        : tip('microphone-off', 'Voice search in the browser needs HTTPS (or localhost). On a plain http:// address, type instead.'),
      tip('keyboard-outline', 'Press / anywhere in Nova to jump straight here.'),
    ];
  } else {
    tips = [tip('microphone', 'Tap the microphone on your keyboard to search by voice.')];
  }
  return (
    <View style={{ marginTop: k(14), padding: k(14), borderRadius: k(10), backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
      <Text style={{ color: colors.text, fontSize: k(13), fontWeight: '700' }}>Search channels, movies and series</Text>
      {tips}
    </View>
  );
}
