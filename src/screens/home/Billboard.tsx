import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { VodItem } from '../../types';
import { colors, radius, useLayout } from '../../theme';
import { useSettings } from '../../store/settings';
import { episodeKey, loadMovieInfo, movieKey, peekMovieInfo } from '../../services/vod';
import { imageUrl } from '../../services/http';
import { cleanTitle, formatClock } from '../../utils/format';
import { useNow } from '../../utils/hooks';
import { Button } from '../../components/Button';
import { Skeleton } from '../../components/Skeleton';
import { Icon } from '../../components/Icon';
import { NovaMark } from '../../components/NovaMark';
import { Poster } from '../../components/Logo';
import { Focusable } from '../../components/Focusable';
import type { HomeEntry, HomeFilter } from './rows';

const nativeDriver = Platform.OS !== 'web';
/** "New" on titles the provider added in the last two weeks */
const NEW_FOR = 14 * 86400000;

export interface HeroAction {
  id: string;
  label: string;
  icon: string;
  primary?: boolean;
  run: () => void;
}

export interface Hero {
  /** a movie or series (a category's "See all" card has no artwork) */
  isTitle: boolean;
  overline: string;
  title: string;
  /** year, genre, running time */
  meta: string[];
  rating?: string;
  isNew?: boolean;
  plot?: string;
  backdrop?: string;
  poster?: string;
  /** where you are: "S1 E2 · Sintel · 25 min left" */
  status?: string;
  fraction?: number;
}

/** Movie details for the billboard, fetched once focus has rested on a title for a moment. */
export function useMovieInfo(item: VodItem | undefined, delay = 350) {
  const [, bump] = useState(0);
  const known = item ? peekMovieInfo(item) : null;
  useEffect(() => {
    if (!item || known !== undefined) return;
    let alive = true;
    const t = setTimeout(() => {
      loadMovieInfo(item).then(
        () => alive && bump((n) => n + 1),
        () => {}
      );
    }, delay);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [item, known, delay]);
  return known ?? undefined;
}

/** "01:32:10" → "1h 32m"; anything else as the provider wrote it. */
function prettyDuration(d?: string) {
  const m = d && /^(\d+):(\d{2})(?::\d{2})?$/.exec(d.trim());
  if (!m) return d || undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!h && !min) return undefined;
  return h ? `${h}h ${min}m` : `${min}m`;
}

const rating = (r?: string) => (r && Number(r) > 0 ? Number(r).toFixed(1) : undefined);
/** the first two genres: "Horror, Thriller, Kriegsfilm" → "Horror · Thriller" */
const genres = (g?: string) =>
  g
    ? g
        .split(/\s*[,/|]\s*/)
        .filter(Boolean)
        .slice(0, 2)
        .join(' · ') || undefined
    : undefined;

/** What the billboard says about a card. */
export function useHero(entry: HomeEntry | undefined): Hero | undefined {
  const info = useMovieInfo(entry?.type === 'movie' ? entry.item : undefined);
  const key = entry?.type === 'movie' ? movieKey(entry.item) : entry?.type === 'series' && entry.episode ? episodeKey(entry.episode) : undefined;
  const pr = useSettings((st) => (key ? st.vodProgress[key] : undefined));
  if (!entry) return undefined;
  if (entry.type === 'more') {
    return { isTitle: false, overline: entry.kind === 'movies' ? 'MOVIES' : 'SERIES', title: entry.title, meta: [`${entry.total} titles`], plot: `Everything in ${entry.title}, in ${entry.kind === 'movies' ? 'Movies' : 'Series'}.` };
  }
  const resume = pr && pr.pos > 0 && pr.dur > 0 ? pr : undefined;
  const where = resume ? `${Math.max(1, Math.round((resume.dur - resume.pos) / 60))} min left` : pr?.done ? 'Watched' : undefined;
  const fraction = resume ? resume.pos / resume.dur : undefined;
  const name = cleanTitle(entry.item.name);
  if (entry.type === 'movie') {
    const it = entry.item;
    return {
      isTitle: true,
      overline: 'MOVIE',
      title: name.title,
      meta: [info?.year || it.year || name.year, genres(info?.genre), prettyDuration(info?.duration)].filter(Boolean) as string[],
      rating: rating(info?.rating || it.rating),
      isNew: !!it.added && Date.now() - it.added < NEW_FOR,
      plot: info?.plot,
      backdrop: info?.backdrop,
      poster: info?.poster || it.poster,
      status: where,
      fraction,
    };
  }
  const it = entry.item;
  const ep = entry.episode;
  return {
    isTitle: true,
    overline: 'SERIES',
    title: name.title,
    meta: [it.year || name.year, genres(it.genre)].filter(Boolean) as string[],
    rating: rating(it.rating),
    plot: it.plot,
    backdrop: it.backdrop,
    poster: it.poster,
    status: ep ? [`S${ep.season} E${ep.episode}`, where].filter(Boolean).join(' · ') : undefined,
    fraction,
  };
}

/**
 * The shown title's artwork across the whole top of Home, fading into the page on the left and at the
 * bottom. Without wide artwork, the poster blurred into a colour wash with the poster itself on the right.
 */
export function BillboardArt({
  hero,
  width,
  height,
  heroH,
}: {
  hero?: Hero;
  width: number;
  height: Animated.AnimatedInterpolation<number> | Animated.Value | number;
  /** the billboard's height (without the fade under it), which the standing poster is sized to */
  heroH: number;
}) {
  const { s } = useLayout();
  const posterW = Math.round(Math.min(s(200), (heroH * 0.64) / 1.5));
  const wash = !hero?.backdrop && hero?.isTitle ? hero.poster : undefined;
  return (
    <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width, height, overflow: 'hidden' }}>
      {hero?.backdrop ? (
        <Image source={{ uri: imageUrl(hero.backdrop) }} style={StyleSheet.absoluteFill} contentFit="cover" contentPosition="top" cachePolicy="memory-disk" recyclingKey={hero.backdrop} transition={400} />
      ) : wash ? (
        <Image source={{ uri: imageUrl(wash) }} style={[StyleSheet.absoluteFill, { opacity: 0.55 }]} contentFit="cover" blurRadius={40} cachePolicy="memory-disk" recyclingKey={wash} transition={400} />
      ) : null}
      <LinearGradient start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} colors={[colors.bg, colors.bgVeil, colors.bgClear]} locations={[0.04, 0.36, 0.68]} style={StyleSheet.absoluteFill} />
      <LinearGradient colors={[colors.bgClear, colors.bgClear, colors.bgVeil, colors.bg]} locations={[0, 0.45, 0.75, 1]} style={StyleSheet.absoluteFill} />
      {hero?.isTitle && !hero.backdrop ? (
        // No wide artwork: the poster standing on the right of the wash
        <View style={{ position: 'absolute', right: s(64), top: Math.max(s(20), heroH - s(64) - posterW * 1.5), borderRadius: s(radius.lg), overflow: 'hidden', borderWidth: 1, borderColor: colors.glass }}>
          <Poster key={hero.poster ?? hero.title} uri={hero.poster} name={hero.title} width={posterW} />
        </View>
      ) : null}
    </Animated.View>
  );
}

/** Fades the billboard's text in whenever it changes title. */
function useFadeIn(key: string | undefined) {
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 280, useNativeDriver: nativeDriver }).start();
  }, [key, fade]);
  return fade;
}

/** Star rating, "New" and the facts in one line. */
function MetaLine({ hero, small }: { hero: Hero; small?: boolean }) {
  const { k, type } = useLayout();
  const pill = { borderRadius: k(radius.xs), paddingHorizontal: k(6), paddingVertical: k(1), marginRight: k(8) };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: small ? 'center' : 'flex-start' }}>
      {hero.isNew ? (
        <View style={[pill, { backgroundColor: colors.accentFill }]}>
          <Text style={[type('overline'), { color: colors.onAccent }]}>NEW</Text>
        </View>
      ) : null}
      {hero.rating ? (
        <View style={[pill, { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.glass }]}>
          <Icon name="star" size={k(12)} color={colors.star} />
          <Text style={[type('label'), { color: colors.text, marginLeft: k(3), fontVariant: ['tabular-nums'] }]}>{hero.rating}</Text>
        </View>
      ) : null}
      {hero.meta.length ? (
        <Text numberOfLines={1} style={[type(small ? 'caption' : 'body'), { color: colors.textDim, flexShrink: 1 }]}>
          {hero.meta.join('  ·  ')}
        </Text>
      ) : null}
    </View>
  );
}

/** Where you are in a title: a progress bar and "S1 E6 · 12 min left". */
function StatusLine({ hero }: { hero: Hero }) {
  const { k, type } = useLayout();
  if (!hero.status) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {hero.fraction !== undefined ? (
        <View style={{ width: k(110), height: k(4), borderRadius: radius.pill, backgroundColor: colors.glass, marginRight: k(10) }}>
          <View style={{ width: `${Math.min(100, hero.fraction * 100)}%`, height: '100%', borderRadius: radius.pill, backgroundColor: colors.accent }} />
        </View>
      ) : null}
      <Text numberOfLines={1} style={[type('label'), { color: colors.text, flexShrink: 1 }]}>
        {hero.status}
      </Text>
    </View>
  );
}

export interface Slides {
  count: number;
  index: number;
  onSelect: (i: number) => void;
}

/** TV and desktop: the shown title's name, details and actions over its artwork, above the rows. */
export function Billboard({
  hero,
  actions,
  focusedAction,
  height,
  width,
  expanded,
  slides,
}: {
  hero?: Hero;
  actions: HeroAction[];
  focusedAction: number;
  height: Animated.Value | number;
  width: number;
  /** the spotlight at the top of Home (more room, the full plot, the slide dots) */
  expanded: boolean;
  slides?: Slides;
}) {
  const { s, type } = useLayout();
  const fade = useFadeIn(hero?.title);
  return (
    <Animated.View style={{ height, justifyContent: 'flex-end', paddingLeft: s(28), paddingRight: s(28), paddingBottom: s(12) }}>
      <Animated.View style={{ width: Math.min(s(500), Math.max(s(320), width * 0.52)), opacity: fade }}>
        {hero ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <NovaMark size={s(15)} />
              <Text style={[type('overline'), { color: colors.textDim, marginLeft: s(7) }]}>{hero.overline}</Text>
            </View>
            <Text numberOfLines={2} style={[type('display'), { color: colors.text, marginTop: s(6), fontSize: s(38), lineHeight: s(42), letterSpacing: -1 }]}>
              {hero.title}
            </Text>
            <View style={{ marginTop: s(8) }}>
              <MetaLine hero={hero} />
            </View>
            {hero.status ? (
              <View style={{ marginTop: s(9) }}>
                <StatusLine hero={hero} />
              </View>
            ) : null}
            {hero.plot ? (
              <Text numberOfLines={expanded ? 3 : 2} style={[type('body'), { color: colors.textDim, marginTop: s(9), maxWidth: s(440) }]}>
                {hero.plot}
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Skeleton style={{ width: s(70), height: s(10), borderRadius: s(radius.xs) }} />
            <Skeleton style={{ width: s(300), height: s(34), borderRadius: s(radius.sm), marginTop: s(8) }} />
            <Skeleton style={{ width: s(200), height: s(12), borderRadius: s(radius.xs), marginTop: s(10) }} />
          </>
        )}
      </Animated.View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: s(14), minHeight: s(36) }}>
        <View style={{ flexDirection: 'row', gap: s(10), flex: 1 }}>
          {hero
            ? actions.map((a, i) => <Button key={a.id} label={a.label} icon={a.icon} primary={a.primary} focused={i === focusedAction} onPress={a.run} testID={`home-${a.id}`} />)
            : null}
        </View>
        {expanded && slides && slides.count > 1 ? <Dots slides={slides} /> : null}
      </View>
    </Animated.View>
  );
}

export const FILTERS: { id: HomeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'movies', label: 'Movies' },
  { id: 'series', label: 'Series' },
];

/** TV and desktop: Home's filter (when the playlist has movies and series) and the clock, across the top. */
export function TopBar({ filter, focusedTab, showFilter, onSelect }: { filter: HomeFilter; focusedTab: number; showFilter: boolean; onSelect: (f: HomeFilter) => void }) {
  const { s, type } = useLayout();
  const clock24 = useSettings((st) => st.prefs.clock24);
  const now = useNow();
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: s(56), flexDirection: 'row', alignItems: 'center', paddingHorizontal: s(28) }}>
      <View style={{ flexDirection: 'row', gap: s(8), flex: 1 }}>
        {showFilter
          ? FILTERS.map((f, i) => {
              const active = f.id === filter;
              return (
                <Focusable
                  key={f.id}
                  focused={i === focusedTab}
                  onPress={() => onSelect(f.id)}
                  accessibilityLabel={f.label}
                  testID={`home-filter-${f.id}`}
                  style={{ height: s(28), paddingHorizontal: s(14), borderRadius: radius.pill, justifyContent: 'center', backgroundColor: active ? colors.glass : 'transparent', borderWidth: 1, borderColor: active ? 'transparent' : colors.glass }}
                  hoverStyle={{ backgroundColor: colors.glass }}
                  focusStyle={{ backgroundColor: colors.focus, borderColor: colors.focus, transform: [{ scale: 1.05 }] }}
                >
                  {({ focused }) => <Text style={[type('label'), { color: focused ? colors.focusText : active ? colors.text : colors.textDim }]}>{f.label}</Text>}
                </Focusable>
              );
            })
          : null}
      </View>
      <Text style={[type('numeral'), { color: colors.text }]}>{formatClock(now, clock24)}</Text>
    </View>
  );
}

/** Which spotlight title is showing; a pointer can pick one. */
function Dots({ slides }: { slides: Slides }) {
  const { s } = useLayout();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(6) }}>
      {Array.from({ length: slides.count }, (_, i) => (
        <Pressable key={i} focusable={false} onPress={() => slides.onSelect(i)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Title ${i + 1} of ${slides.count}`}>
          <View style={{ width: i === slides.index ? s(18) : s(6), height: s(6), borderRadius: radius.pill, backgroundColor: i === slides.index ? colors.text : colors.glass }} />
        </Pressable>
      ))}
    </View>
  );
}

/** Phones: one featured title as a big poster card with its actions, above the rows. */
export function FeaturedCard({ hero, actions }: { hero: Hero; actions: HeroAction[] }) {
  const { width, k, type } = useLayout();
  const w = Math.min(width - 32, 560);
  const h = Math.min(w * 1.35, 640);
  const art = hero.poster || hero.backdrop;
  return (
    <View style={{ width: w, height: h, alignSelf: 'center', borderRadius: radius.xl, overflow: 'hidden', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.glass }}>
      {art ? <Image source={{ uri: imageUrl(art) }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={art} transition={200} /> : null}
      <LinearGradient colors={[colors.bgClear, colors.bgClear, colors.bgVeil, colors.bg]} locations={[0, 0.45, 0.7, 1]} style={StyleSheet.absoluteFill} />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <NovaMark size={14} />
          <Text style={[type('overline'), { color: colors.textDim, marginLeft: 6 }]}>{hero.overline}</Text>
        </View>
        <Text numberOfLines={2} style={[type('title'), { color: colors.text, textAlign: 'center', marginTop: 6 }]}>
          {hero.title}
        </Text>
        <View style={{ marginTop: 6 }}>
          <MetaLine hero={hero} small />
        </View>
        {hero.status ? (
          <View style={{ marginTop: 8 }}>
            <StatusLine hero={hero} />
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: k(22), marginTop: 14 }}>
          {actions.map((a) =>
            a.primary ? (
              <Button key={a.id} label={a.label} icon={a.icon} primary onPress={a.run} testID={`home-${a.id}`} />
            ) : (
              // secondary actions: icon over a caption, so all three fit on the narrowest phone
              <Pressable key={a.id} focusable={false} onPress={a.run} hitSlop={8} accessibilityRole="button" accessibilityLabel={a.label} testID={`home-${a.id}`} style={({ pressed }) => ({ alignItems: 'center', minWidth: 56, opacity: pressed ? 0.6 : 1 })}>
                <Icon name={a.icon} size={24} color={colors.text} />
                <Text style={[type('caption'), { color: colors.textDim, marginTop: 2 }]}>{a.label}</Text>
              </Pressable>
            )
          )}
        </View>
      </View>
    </View>
  );
}

/** Phones: the featured title's poster, blurred into a colour wash behind the top of Home. */
export function AmbientWash({ uri, height }: { uri?: string; height: number }) {
  if (!uri) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height, overflow: 'hidden' }}>
      <Image source={{ uri: imageUrl(uri) }} style={[StyleSheet.absoluteFill, { opacity: 0.5 }]} contentFit="cover" blurRadius={50} cachePolicy="memory-disk" recyclingKey={uri} transition={300} />
      <LinearGradient colors={[colors.bgClear, colors.bgVeil, colors.bg]} locations={[0, 0.6, 1]} style={StyleSheet.absoluteFill} />
    </View>
  );
}
