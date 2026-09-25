import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TextInput, View } from 'react-native';
import { colors, fonts, useLayout } from '../theme';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { useUI } from '../store/ui';
import { useKeys, type KeyEvt } from '../input/keys';
import { Focusable } from '../components/Focusable';
import { Logo, Poster } from '../components/Logo';
import { Icon } from '../components/Icon';
import { programAt } from '../services/epg';
import type { SeriesItem, VodItem } from '../types';

interface Result {
  key: string;
  type: 'channel' | 'movie' | 'series';
  title: string;
  subtitle?: string;
  image?: string;
  run: () => void;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');

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

  const [q, setQ] = useState('');
  const [zone, setZone] = useState<'input' | 'results'>('input');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<Result>>(null);
  const rowH = tv ? s(50) : 64;

  useEffect(() => {
    if (q.trim().length >= 2) void loadAllVod();
  }, [q, loadAllVod]);

  const results = useMemo<Result[]>(() => {
    const term = norm(q.trim());
    if (term.length < 2) return [];
    const out: Result[] = [];
    const now = Date.now();
    for (const c of channels) {
      if (!norm(c.name).includes(term)) continue;
      const p = programAt(epg[c.id], now);
      out.push({
        key: 'c' + c.id,
        type: 'channel',
        title: c.name,
        subtitle: p ? `Now: ${p.title}` : c.group,
        image: c.logo,
        run: () => playChannel(c.id, { groupId: 'all', fullscreen: true }),
      });
      if (out.length >= 60) break;
    }
    const seen = new Set<string>();
    let mCount = 0;
    for (const list of Object.values(movies)) {
      for (const m of list as VodItem[]) {
        if (mCount >= 60 || seen.has(m.id) || !norm(m.name).includes(term)) continue;
        seen.add(m.id);
        mCount++;
        out.push({ key: 'm' + m.id, type: 'movie', title: m.name, subtitle: ['Movie', m.year].filter(Boolean).join(' · '), image: m.poster, run: () => setDetail({ kind: 'movie', item: m }) });
      }
    }
    let sCount = 0;
    for (const list of Object.values(series)) {
      for (const sr of list as SeriesItem[]) {
        if (sCount >= 60 || seen.has(sr.id) || !norm(sr.name).includes(term)) continue;
        seen.add(sr.id);
        sCount++;
        out.push({ key: 's' + sr.id, type: 'series', title: sr.name, subtitle: ['Series', sr.year].filter(Boolean).join(' · '), image: sr.poster, run: () => setDetail({ kind: 'series', item: sr }) });
      }
    }
    return out;
  }, [q, channels, movies, series, epg, playChannel, setDetail]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    if (zone === 'results') listRef.current?.scrollToOffset({ offset: Math.max(0, (idx - 3) * rowH), animated: true });
  }, [idx, zone, rowH]);

  const onKey = (e: KeyEvt): boolean | void => {
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
      <Text style={{ color: colors.text, fontSize: k(22), fontWeight: '800', marginBottom: k(12) }}>Search</Text>
      <Focusable
        focused={zone === 'input'}
        onPress={() => inputRef.current?.focus()}
        style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderRadius: k(10), paddingHorizontal: k(12), height: k(42), borderWidth: 2, borderColor: 'transparent' }}
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
      </Focusable>

      {q.trim().length >= 2 && !results.length ? (
        <Text style={{ color: colors.muted, fontSize: k(13), marginTop: k(20) }}>No results for “{q.trim()}”.</Text>
      ) : null}
      {q.trim().length < 2 ? (
        <Text style={{ color: colors.muted, fontSize: k(12), marginTop: k(16) }}>Type at least two letters. On a TV remote, press OK to open the keyboard.</Text>
      ) : null}

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
            style={{ height: rowH - k(4), marginBottom: k(4), borderRadius: k(8), flexDirection: 'row', alignItems: 'center', paddingHorizontal: k(10), backgroundColor: colors.surface }}
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
                    <Text numberOfLines={1} style={{ color: focused ? '#3A4252' : colors.muted, fontSize: k(11), marginTop: 2 }}>
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
