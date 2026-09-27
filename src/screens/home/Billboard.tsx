import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { VodItem } from '../../types';
import { colors, radius, useLayout } from '../../theme';
import { useSettings } from '../../store/settings';
import { episodeKey, loadMovieInfo, movieKey, peekMovieInfo } from '../../services/vod';
import { imageUrl } from '../../services/http';
import { Button } from '../../components/Button';
import { Skeleton } from '../../components/Skeleton';
import { Icon } from '../../components/Icon';
import { Poster } from '../../components/Logo';
import type { HomeEntry } from './rows';

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
  meta: string[];
  plot?: string;
  backdrop?: string;
  poster?: string;
  /** where you are: "S1 E2 · Sintel · 25 min left" */
  status?: string;
  fraction?: number;
}

/** Movie details for the billboard, fetched once focus has rested on a title for a moment. */
function useMovieInfo(item: VodItem | undefined) {
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
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [item, known]);
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

const rating = (r?: string) => (r && Number(r) > 0 ? `★ ${Number(r).toFixed(1)}` : undefined);

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
  if (entry.type === 'movie') {
    const it = entry.item;
    return {
      isTitle: true,
      overline: 'MOVIE',
      title: it.name,
      meta: [info?.year || it.year, info?.genre, prettyDuration(info?.duration), rating(info?.rating || it.rating)].filter(Boolean) as string[],
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
    title: it.name,
    meta: [it.year, it.genre, rating(it.rating)].filter(Boolean) as string[],
    plot: it.plot,
    backdrop: it.backdrop,
    poster: it.poster,
    status: ep ? [`S${ep.season} E${ep.episode} · ${ep.title}`, where].filter(Boolean).join(' · ') : undefined,
    fraction,
  };
}

/** The focused title's artwork, top right, fading into the page. Drawn behind the billboard and the rows. */
export function BillboardArt({ hero, width, height }: { hero?: Hero; width: number; height: number }) {
  const { s } = useLayout();
  const artW = Math.min(width * 0.7, (height * 16) / 9);
  const posterH = height * 0.78;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, right: 0, width: artW, height }}>
      {hero?.backdrop ? (
        <Image source={{ uri: imageUrl(hero.backdrop) }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={hero.backdrop} transition={300} />
      ) : hero?.isTitle ? (
        // No wide artwork: the poster itself (or its title card) standing on the right
        <View style={{ position: 'absolute', right: s(40), top: s(16), borderRadius: radius.md, overflow: 'hidden' }}>
          <Poster key={hero.poster ?? hero.title} uri={hero.poster} name={hero.title} width={posterH / 1.5} />
        </View>
      ) : null}
      <LinearGradient start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} colors={[colors.bg, colors.bgVeil, colors.bgClear]} locations={[0, 0.28, 0.62]} style={StyleSheet.absoluteFill} />
      <LinearGradient colors={[colors.bgClear, colors.bgClear, colors.bg]} locations={[0, 0.55, 1]} style={StyleSheet.absoluteFill} />
    </View>
  );
}

/** TV and desktop: the focused title's name, details and actions above the rows. */
export function Billboard({ hero, actions, focusedAction, height, width }: { hero?: Hero; actions: HeroAction[]; focusedAction: number; height: number; width: number }) {
  const { s, type } = useLayout();
  return (
    <View style={{ height, justifyContent: 'flex-end', paddingLeft: s(28), paddingBottom: s(10) }}>
      <View style={{ width: Math.max(s(320), width * 0.5) }}>
        {hero ? (
          <>
            <Text style={[type('overline'), { color: colors.accent }]}>{hero.overline}</Text>
            <Text numberOfLines={2} style={[type('display'), { color: colors.text, marginTop: s(4) }]}>
              {hero.title}
            </Text>
            {hero.meta.length ? (
              <Text numberOfLines={1} style={[type('body'), { color: colors.textDim, marginTop: s(5) }]}>
                {hero.meta.join('  ·  ')}
              </Text>
            ) : null}
            {hero.status ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: s(8) }}>
                {hero.fraction !== undefined ? (
                  <View style={{ width: s(110), height: s(4), borderRadius: radius.pill, backgroundColor: colors.surface3, marginRight: s(10) }}>
                    <View style={{ width: `${Math.min(100, hero.fraction * 100)}%`, height: '100%', borderRadius: radius.pill, backgroundColor: colors.accent }} />
                  </View>
                ) : null}
                <Text numberOfLines={1} style={[type('label'), { color: colors.text, flexShrink: 1 }]}>
                  {hero.status}
                </Text>
              </View>
            ) : null}
            {hero.plot ? (
              <Text numberOfLines={3} style={[type('body'), { color: colors.textDim, marginTop: s(8), maxWidth: s(470) }]}>
                {hero.plot}
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Skeleton style={{ width: s(70), height: s(10), borderRadius: s(radius.xs) }} />
            <Skeleton style={{ width: s(280), height: s(28), borderRadius: s(radius.sm), marginTop: s(8) }} />
            <Skeleton style={{ width: s(200), height: s(12), borderRadius: s(radius.xs), marginTop: s(10) }} />
          </>
        )}
        <View style={{ flexDirection: 'row', gap: s(10), marginTop: s(14), minHeight: s(36) }}>
          {hero
            ? actions.map((a, i) => <Button key={a.id} label={a.label} icon={a.icon} primary={a.primary} focused={i === focusedAction} onPress={a.run} testID={`home-${a.id}`} />)
            : null}
        </View>
      </View>
    </View>
  );
}

/** Phones: one featured title as a big poster card with its actions, above the rows. */
export function FeaturedCard({ hero, actions }: { hero: Hero; actions: HeroAction[] }) {
  const { width, k, type } = useLayout();
  const w = Math.min(width - 32, 560);
  const h = Math.min(w * 1.3, 620);
  const art = hero.poster || hero.backdrop;
  return (
    <View style={{ width: w, height: h, alignSelf: 'center', borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
      {art ? <Image source={{ uri: imageUrl(art) }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={art} transition={200} /> : null}
      <LinearGradient colors={[colors.bgClear, colors.bgClear, colors.bgVeil, colors.bg]} locations={[0, 0.42, 0.68, 1]} style={StyleSheet.absoluteFill} />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, alignItems: 'center' }}>
        <Text style={[type('overline'), { color: colors.accent }]}>{hero.overline}</Text>
        <Text numberOfLines={2} style={[type('title'), { color: colors.text, textAlign: 'center', marginTop: 4 }]}>
          {hero.title}
        </Text>
        {hero.meta.length ? (
          <Text numberOfLines={1} style={[type('caption'), { color: colors.textDim, marginTop: 4 }]}>
            {hero.meta.join('  ·  ')}
          </Text>
        ) : null}
        {hero.status ? (
          <Text numberOfLines={1} style={[type('label'), { color: colors.text, marginTop: 6 }]}>
            {hero.status}
          </Text>
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
