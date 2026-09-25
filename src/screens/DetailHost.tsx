import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { MovieInfo, SeriesInfo, SeriesItem, VodItem } from '../types';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radius, useLayout } from '../theme';
import { Chip } from '../components/Chip';
import { useUI } from '../store/ui';
import { useSettings } from '../store/settings';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { Layer, useKeys } from '../input/keys';
import { Poster } from '../components/Logo';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Focusable } from '../components/Focusable';
import { imageUrl } from '../services/http';
import { episodeKey, loadMovieInfo, loadSeriesInfo, movieKey, playEpisode, playMovie } from '../services/vod';
import { formatDuration } from '../utils/format';

/** Movie / series detail pages, shown over whichever screen opened them. */
export function DetailHost() {
  const detail = useUI((s) => s.detail);
  const playing = usePlayer((s) => !!s.item && s.fullscreen);
  if (!detail) return null;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
      {detail.kind === 'movie' ? <MovieDetail item={detail.item} active={!playing} /> : <SeriesDetail item={detail.item} active={!playing} />}
    </View>
  );
}

function Backdrop({ uri }: { uri?: string }) {
  if (!uri) return null;
  return (
    <>
      <Image source={{ uri: imageUrl(uri) }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={uri ? 18 : 0} cachePolicy="memory-disk" />
      <LinearGradient colors={['rgba(7,8,11,0.55)', 'rgba(7,8,11,0.92)', colors.bg]} style={StyleSheet.absoluteFill} />
    </>
  );
}

function Meta({ parts, k }: { parts: (string | undefined)[]; k: (n: number) => number }) {
  const list = parts.filter(Boolean) as string[];
  if (!list.length) return null;
  return <Text style={{ color: colors.textDim, fontSize: k(12), marginTop: k(6) }}>{list.join('  ·  ')}</Text>;
}

function useFav(kind: 'movie' | 'series', item: VodItem | SeriesItem) {
  const pid = useLibrary((s) => s.playlistId);
  const isFav = useSettings((s) => !!pid && !!s.vodFavorites[pid]?.some((f) => f.item.id === item.id));
  const toggle = useSettings((s) => s.toggleVodFavorite);
  return [isFav, () => pid && toggle(pid, { kind, item } as any)] as const;
}

function MovieDetail({ item, active }: { item: VodItem; active: boolean }) {
  const { s, mode } = useLayout();
  const insetTop = useSafeAreaInsets().top;
  const tv = mode === 'tv';
  const k = tv ? s : (n: number) => n * 1.1;
  const close = () => useUI.getState().setDetail(null);
  const [info, setInfo] = useState<MovieInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const progress = useSettings((st) => st.vodProgress[movieKey(item)]);
  const [isFav, toggleFav] = useFav('movie', item);
  const [btn, setBtn] = useState(0);

  useEffect(() => {
    let alive = true;
    loadMovieInfo(item)
      .then((i) => alive && setInfo(i))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [item]);

  const buttons = [
    { id: 'play', label: progress ? `Resume ${formatDuration(progress.pos)}` : 'Play', icon: 'play', primary: true, run: () => playMovie(item) },
    ...(progress ? [{ id: 'restart', label: 'Start over', icon: 'restart', primary: false, run: () => playMovie(item, true) }] : []),
    { id: 'fav', label: isFav ? 'Favorited' : 'Favorite', icon: isFav ? 'star' : 'star-outline', primary: false, run: toggleFav },
  ];

  useKeys(
    (e) => {
      if (e.key === 'left') return setBtn((b) => Math.max(0, b - 1));
      if (e.key === 'right') return setBtn((b) => Math.min(buttons.length - 1, b + 1));
      if (e.key === 'select') return buttons[btn]?.run();
      if (e.key === 'back') return close();
      return;
    },
    active,
    Layer.panel
  );

  const poster = info?.poster || item.poster;
  return (
    <View style={{ flex: 1 }}>
      <Backdrop uri={info?.backdrop || poster} />
      <ScrollView contentContainerStyle={{ padding: tv ? s(36) : 20, paddingTop: tv ? s(58) : 60 + insetTop, flexDirection: tv ? 'row' : 'column' }}>
        <Poster uri={poster} name={item.name} width={tv ? s(170) : 160} style={tv ? undefined : { alignSelf: 'center' }} />
        <View style={{ flex: tv ? 1 : undefined, marginLeft: tv ? s(28) : 0, marginTop: tv ? 0 : 18 }}>
          <Text style={{ color: colors.text, fontSize: k(26), lineHeight: k(31), fontWeight: '800', letterSpacing: -0.4, fontFamily: fonts.regular }}>{item.name}</Text>
          <Meta parts={[info?.year || item.year, info?.duration, info?.genre, (info?.rating || item.rating) && `★ ${Number(info?.rating || item.rating).toFixed(1)}`]} k={k} />
          {loading ? <ActivityIndicator color={colors.accent} style={{ alignSelf: 'flex-start', marginTop: k(14) }} /> : null}
          {info?.plot ? (
            <Text style={{ color: colors.textDim, fontSize: k(12.5), lineHeight: k(19), marginTop: k(12), maxWidth: k(620) }} numberOfLines={tv ? 6 : undefined}>
              {info.plot}
            </Text>
          ) : null}
          {info?.cast ? (
            <Text style={{ color: colors.muted, fontSize: k(11.5), marginTop: k(10) }} numberOfLines={2}>
              Cast: {info.cast}
            </Text>
          ) : null}
          {info?.director ? <Text style={{ color: colors.muted, fontSize: k(11.5), marginTop: k(3) }}>Director: {info.director}</Text> : null}
          {progress ? (
            <View style={{ height: k(4), width: k(220), backgroundColor: colors.surface3, borderRadius: radius.pill, marginTop: k(14) }}>
              <View style={{ height: '100%', width: `${(progress.pos / progress.dur) * 100}%`, backgroundColor: colors.accent, borderRadius: radius.pill }} />
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: k(10), marginTop: k(18) }}>
            {buttons.map((b, i) => (
              <Button key={b.id} label={b.label} icon={b.icon} primary={b.primary} focused={i === btn} onPress={b.run} testID={`detail-${b.id}`} />
            ))}
          </View>
        </View>
      </ScrollView>
      <CloseButton onPress={close} k={k} />
    </View>
  );
}

function SeriesDetail({ item, active }: { item: SeriesItem; active: boolean }) {
  const { s, mode } = useLayout();
  const insetTop = useSafeAreaInsets().top;
  const tv = mode === 'tv';
  const k = tv ? s : (n: number) => n * 1.1;
  const close = () => useUI.getState().setDetail(null);
  const [info, setInfo] = useState<SeriesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState(0);
  const [ep, setEp] = useState(0);
  const [zone, setZone] = useState<'fav' | 'seasons' | 'episodes'>('episodes');
  const [isFav, toggleFav] = useFav('series', item);
  const progress = useSettings((st) => st.vodProgress);
  const listRef = useRef<FlatList>(null);
  const epH = tv ? s(62) : 76;

  useEffect(() => {
    let alive = true;
    loadSeriesInfo(item)
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        if (!i?.seasons.length) setZone('fav');
      })
      .catch((e) => alive && setError(e?.message ?? 'Failed to load series'));
    return () => {
      alive = false;
    };
  }, [item]);

  const seasons = info?.seasons ?? [];
  const episodes = seasons[season]?.episodes ?? [];

  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: Math.max(0, (ep - 2) * epH), animated: true });
  }, [ep, epH]);

  useKeys(
    (e) => {
      if (e.key === 'back') return close();
      if (zone === 'fav') {
        if (e.key === 'select') {
          toggleFav();
          return;
        }
        if (e.key === 'down' && seasons.length) return setZone(tv ? 'seasons' : 'episodes');
        return;
      }
      if (zone === 'seasons') {
        if (e.key === 'up') return season > 0 ? setSeason(season - 1) : setZone('fav');
        if (e.key === 'down') return setSeason(Math.min(seasons.length - 1, season + 1));
        if (e.key === 'right' || e.key === 'select') {
          setEp(0);
          return setZone('episodes');
        }
        if (e.key === 'left') return;
        return;
      }
      // episodes
      if (e.key === 'up') return ep > 0 ? setEp(ep - 1) : setZone('fav');
      if (e.key === 'down') return setEp(Math.min(episodes.length - 1, ep + 1));
      if (e.key === 'left') return tv ? setZone('seasons') : undefined;
      if (e.key === 'select' && episodes[ep]) return playEpisode(item, episodes[ep], !!e.long);
      return undefined;
    },
    active,
    Layer.panel
  );

  const poster = info?.poster || item.poster;
  const header = (
    <View style={{ flexDirection: 'row', padding: tv ? s(28) : 18, paddingTop: tv ? s(50) : 60 + insetTop }}>
      <Poster uri={poster} name={item.name} width={tv ? s(110) : 100} />
      <View style={{ flex: 1, marginLeft: tv ? s(22) : 16 }}>
        <Text style={{ color: colors.text, fontSize: k(24), lineHeight: k(29), fontWeight: '800', letterSpacing: -0.3, fontFamily: fonts.regular }} numberOfLines={2}>
          {item.name}
        </Text>
        <Meta parts={[info?.year || item.year, info?.genre || item.genre, (info?.rating || item.rating) && `★ ${Number(info?.rating || item.rating).toFixed(1)}`, seasons.length ? `${seasons.length} season${seasons.length > 1 ? 's' : ''}` : undefined]} k={k} />
        {info?.plot || item.plot ? (
          <Text style={{ color: colors.textDim, fontSize: k(12), lineHeight: k(18), marginTop: k(10), maxWidth: k(640) }} numberOfLines={tv ? 3 : 5}>
            {info?.plot || item.plot}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', marginTop: k(12) }}>
          <Button label={isFav ? 'Favorited' : 'Favorite'} icon={isFav ? 'star' : 'star-outline'} small focused={zone === 'fav'} onPress={toggleFav} />
        </View>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <Backdrop uri={info?.backdrop || poster} />
      {header}
      {!info && !error ? <ActivityIndicator color={colors.accent} size="large" style={{ marginTop: k(30) }} /> : null}
      {error ? <Text style={{ color: colors.live, margin: k(28) }}>{error}</Text> : null}
      {info && !seasons.length ? <Text style={{ color: colors.muted, marginHorizontal: k(28) }}>No episodes available.</Text> : null}
      {seasons.length ? (
        <View style={{ flex: 1, flexDirection: tv ? 'row' : 'column', paddingHorizontal: tv ? s(28) : 0 }}>
          {tv ? (
            <View style={{ width: s(170) }}>
              {seasons.map((se, i) => (
                <Focusable
                  key={se.season}
                  focused={zone === 'seasons' && i === season}
                  onPress={() => {
                    setSeason(i);
                    setEp(0);
                  }}
                  style={{ height: s(34), borderRadius: s(radius.sm), paddingHorizontal: s(10), justifyContent: 'center', marginBottom: s(2), backgroundColor: i === season ? colors.accentSoft : 'transparent' }}
                  focusStyle={{ backgroundColor: colors.focus }}
                >
                  {({ focused }) => (
                    <Text style={{ color: focused ? colors.focusText : colors.text, fontWeight: i === season ? '700' : '500', fontSize: s(12.5) }}>
                      {se.name}
                    </Text>
                  )}
                </Focusable>
              ))}
            </View>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingBottom: 10 }}>
              {seasons.map((se, i) => (
                <Chip
                  key={se.season}
                  label={se.name}
                  selected={i === season}
                  onPress={() => {
                    setSeason(i);
                    setEp(0);
                  }}
                />
              ))}
            </ScrollView>
          )}
          <FlatList
            ref={listRef}
            style={{ flex: 1 }}
            data={episodes}
            keyExtractor={(e) => e.id}
            contentContainerStyle={{ paddingHorizontal: tv ? s(10) : 16, paddingBottom: 30 }}
            getItemLayout={(_d, i) => ({ length: epH, offset: epH * i, index: i })}
            renderItem={({ item: e, index: i }) => {
              const pr = progress[episodeKey(e)];
              return (
                <Focusable
                  focused={zone === 'episodes' && i === ep}
                  onPress={() => {
                    setEp(i);
                    playEpisode(item, e);
                  }}
                  onLongPress={() => playEpisode(item, e, true)}
                  style={{ height: epH - (tv ? s(6) : 8), borderRadius: tv ? s(radius.md) : radius.md, flexDirection: 'row', alignItems: 'center', paddingHorizontal: tv ? s(12) : 12, backgroundColor: colors.surface, marginBottom: tv ? s(6) : 8 }}
                  focusStyle={{ backgroundColor: colors.focus }}
                >
                  {({ focused }) => (
                    <>
                      <Text style={{ width: tv ? s(34) : 34, color: focused ? colors.focusDim : colors.muted, fontWeight: '800', fontSize: k(13), fontVariant: ['tabular-nums'] }}>{e.episode}</Text>
                      <View style={{ flex: 1 }}>
                        <Text numberOfLines={1} style={{ color: focused ? colors.focusText : colors.text, fontWeight: '700', fontSize: k(12.5) }}>
                          {e.title}
                        </Text>
                        {e.plot ? (
                          <Text numberOfLines={1} style={{ color: focused ? colors.focusDim : colors.muted, fontSize: k(11.5), marginTop: 2 }}>
                            {e.plot}
                          </Text>
                        ) : null}
                        {pr ? (
                          <View style={{ height: 3, backgroundColor: focused ? colors.focusDim : colors.surface3, borderRadius: radius.pill, marginTop: 5, width: '40%' }}>
                            <View style={{ height: '100%', width: `${(pr.pos / pr.dur) * 100}%`, backgroundColor: focused ? colors.accentFill : colors.accent, borderRadius: radius.pill }} />
                          </View>
                        ) : null}
                      </View>
                      {e.duration ? <Text style={{ color: focused ? colors.focusDim : colors.muted, fontSize: k(11.5), marginLeft: 8, fontVariant: ['tabular-nums'] }}>{e.duration}</Text> : null}
                      <Icon name="play-circle-outline" size={k(20)} color={focused ? colors.focusText : colors.textDim} style={{ marginLeft: 10 }} />
                    </>
                  )}
                </Focusable>
              );
            }}
          />
        </View>
      ) : null}
      <CloseButton onPress={close} k={k} />
    </View>
  );
}

function CloseButton({ onPress, k }: { onPress: () => void; k: (n: number) => number }) {
  const ins = useSafeAreaInsets();
  const { safe, mode } = useLayout();
  const size = mode === 'tv' ? k(34) : 44;
  return (
    <Pressable
      focusable={false}
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={{ position: 'absolute', top: k(14) + Math.max(ins.top, safe.y), left: k(14) + Math.max(ins.left, safe.x), width: size, height: size, borderRadius: radius.pill, backgroundColor: colors.videoScrim, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name="arrow-left" size={k(18)} color={colors.onVideo} />
    </Pressable>
  );
}
