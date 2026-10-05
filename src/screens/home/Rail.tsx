import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, radius, useLayout } from '../../theme';
import { useLibrary } from '../../store/library';
import { useSettings } from '../../store/settings';
import type { MenuAnchor } from '../../store/ui';
import { useKeyMode } from '../../input/keys';
import { episodeKey, movieKey } from '../../services/vod';
import { imageUrl } from '../../services/http';
import { cleanTitle } from '../../utils/format';
import { useMovieInfo } from './Billboard';
import { PosterCard } from '../../components/PosterCard';
import { Focusable } from '../../components/Focusable';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/Skeleton';
import type { HomeEntry, VodKind } from './rows';

export interface RailMetrics {
  tv: boolean;
  s: (n: number) => number;
  /** whole poster row: title + cards */
  rowH: number;
  /** whole row of landscape cards */
  wideRowH: number;
  titleH: number;
  posterW: number;
  /** poster image height including its focus border */
  artH: number;
  /** landscape card (Continue watching), 16:9 */
  wideW: number;
  wideH: number;
  gap: number;
  /** left/right inset of the cards, lined up with the billboard's text */
  padX: number;
  /** room above and below the cards for the focus zoom */
  padY: number;
  /** width the row is shown in */
  viewW: number;
}

interface Props {
  rowKey: string;
  title: string;
  kindLabel?: string;
  kind?: VodKind;
  categoryId?: string;
  entries: HomeEntry[];
  loading: boolean;
  /** landscape cards */
  wide?: boolean;
  /** card with the remote's focus, -1 when the focus is in another row */
  focusCol: number;
  /** TV: the row the remote is on */
  active: boolean;
  m: RailMetrics;
  onPress: (rowKey: string, col: number) => void;
  onMenu: (rowKey: string, col: number, anchor?: MenuAnchor) => void;
  /** desktop: the billboard follows the pointer */
  onHover?: (rowKey: string, col: number) => void;
}

/** One Home row: its title and a sideways list of posters. */
export const Rail = memo(function Rail({ rowKey, title, kindLabel, kind, categoryId, entries, loading, wide, focusCol, active, m, onPress, onMenu, onHover }: Props) {
  const { type } = useLayout();
  const listRef = useRef<FlatList<HomeEntry>>(null);
  const cardW = wide ? m.wideW : m.posterW;
  const cardH = wide ? m.wideH : m.artH;
  const step = cardW + m.gap;

  // A category's titles load when its row comes near the screen
  useEffect(() => {
    if (!loading || !kind || !categoryId) return;
    const lib = useLibrary.getState();
    void (kind === 'movies' ? lib.loadMovies(categoryId) : lib.loadSeries(categoryId));
  }, [loading, kind, categoryId]);

  // The focused card sits at the left edge and the row slides under it, as far as the row goes
  useEffect(() => {
    if (focusCol < 0) return;
    const max = Math.max(0, m.padX * 2 + entries.length * step - m.gap - m.viewW);
    listRef.current?.scrollToOffset({ offset: Math.min(max, focusCol * step), animated: true });
  }, [focusCol, entries.length, step, m.padX, m.gap, m.viewW]);

  // Mouse: arrows at the row's ends page through it
  const keyMode = useKeyMode();
  const [hovered, setHovered] = useState(false);
  const [edges, setEdges] = useState({ start: true, end: false });
  const offset = useRef(0);
  const overflows = m.padX * 2 + entries.length * step - m.gap > m.viewW;
  const pagers = Platform.OS === 'web' && m.tv && !keyMode && hovered && !loading && overflows;
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      offset.current = contentOffset.x;
      const start = contentOffset.x <= 2;
      const end = contentOffset.x + layoutMeasurement.width >= contentSize.width - 2;
      setEdges((p) => (p.start === start && p.end === end ? p : { start, end }));
    },
    []
  );
  const page = (dir: 1 | -1) => listRef.current?.scrollToOffset({ offset: Math.max(0, offset.current + dir * Math.floor((m.viewW - m.padX * 2) / step) * step), animated: true });

  const renderItem = ({ item: e, index }: { item: HomeEntry; index: number }) => (
    <View style={{ marginRight: m.gap }}>{renderCard(e, index)}</View>
  );
  const renderCard = (e: HomeEntry, index: number) =>
    e.type === 'more' ? (
      <MoreCard entry={e} m={m} width={cardW} height={cardH} focused={index === focusCol} onPress={() => onPress(rowKey, index)} onHoverIn={onHover && (() => onHover(rowKey, index))} />
    ) : wide ? (
      <WideCard
        entry={e}
        m={m}
        focused={index === focusCol}
        onPress={() => onPress(rowKey, index)}
        onMenu={(anchor) => onMenu(rowKey, index, anchor)}
        onHoverIn={onHover && (() => onHover(rowKey, index))}
      />
    ) : (
      <HomePoster
        entry={e}
        m={m}
        focused={index === focusCol}
        onPress={() => onPress(rowKey, index)}
        onMenu={(anchor) => onMenu(rowKey, index, anchor)}
        onHoverIn={onHover && (() => onHover(rowKey, index))}
      />
    );

  const body = (
    <>
      <View style={{ height: m.titleH, flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: m.padX }}>
        <Text numberOfLines={1} style={[type('heading'), { flexShrink: 1, color: !m.tv || active ? colors.text : colors.textDim }]}>
          {title}
        </Text>
        {kindLabel ? <Text style={[type('caption'), { color: colors.muted, marginLeft: m.s(8), marginBottom: m.tv ? m.s(2) : 2 }]}>{kindLabel}</Text> : null}
      </View>
      {loading ? (
        <View style={{ flexDirection: 'row', paddingHorizontal: m.padX, paddingVertical: m.padY, gap: m.gap, overflow: 'hidden' }}>
          {Array.from({ length: Math.ceil(m.viewW / step) }, (_, i) => (
            <Skeleton key={i} style={{ width: cardW, height: cardH, borderRadius: m.tv ? m.s(radius.md) : radius.md }} />
          ))}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          horizontal
          data={entries}
          keyExtractor={(e) => e.key}
          renderItem={renderItem}
          extraData={focusCol}
          getItemLayout={(_d, i) => ({ length: step, offset: m.padX + step * i, index: i })}
          ListHeaderComponent={<View style={{ width: m.padX }} />}
          ListFooterComponent={<View style={{ width: m.padX - m.gap }} />}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ paddingVertical: m.padY }}
          showsHorizontalScrollIndicator={false}
          initialNumToRender={Math.ceil(m.viewW / step) + 1}
          maxToRenderPerBatch={8}
          windowSize={3}
          // only the web's pagers need to know where the row is
          onScroll={Platform.OS === 'web' ? onScroll : undefined}
          scrollEventThrottle={64}
        />
      )}
      {pagers && !edges.start ? <Pager side="left" m={m} height={cardH} onPress={() => page(-1)} /> : null}
      {pagers && !edges.end ? <Pager side="right" m={m} height={cardH} onPress={() => page(1)} /> : null}
    </>
  );
  // Web: pointer enter/leave on the row itself (a Pressable's hover would end whenever the pointer is over a poster)
  const hover = Platform.OS === 'web' ? { onPointerEnter: () => setHovered(true), onPointerLeave: () => setHovered(false) } : null;
  return (
    <View style={{ height: wide ? m.wideRowH : m.rowH }} accessibilityRole="list" accessibilityLabel={title} {...hover}>
      {body}
    </View>
  );
});

/** A poster in a row, with its own watch progress (so progress updates redraw one card, not the row). */
const HomePoster = memo(function HomePoster({
  entry,
  m,
  focused,
  onPress,
  onMenu,
  onHoverIn,
}: {
  entry: Extract<HomeEntry, { type: 'movie' | 'series' }>;
  m: RailMetrics;
  focused: boolean;
  onPress: () => void;
  onMenu: (anchor?: MenuAnchor) => void;
  onHoverIn?: () => void;
}) {
  const ep = entry.type === 'series' ? entry.episode : undefined;
  const key = entry.type === 'movie' ? movieKey(entry.item) : ep ? episodeKey(ep) : undefined;
  const pr = useSettings((st) => (key ? st.vodProgress[key] : undefined));
  const resume = !!pr && pr.pos > 0 && pr.dur > 0;
  const caption = ep ? `S${ep.season} E${ep.episode}` : entry.historyId && resume ? `${Math.max(1, Math.round((pr!.dur - pr!.pos) / 60))} min left` : undefined;
  return (
    <PosterCard
      item={entry.item}
      width={m.posterW}
      focused={focused}
      progress={resume ? pr!.pos / pr!.dur : 0}
      watched={!!pr?.done}
      caption={caption}
      tv={m.tv}
      s={m.s}
      bare
      onPress={onPress}
      onMenu={onMenu}
      onHoverIn={onHoverIn}
    />
  );
});

/** Continue watching: the title's wide artwork with where you are in it. */
const WideCard = memo(function WideCard({
  entry,
  m,
  focused,
  onPress,
  onMenu,
  onHoverIn,
}: {
  entry: Extract<HomeEntry, { type: 'movie' | 'series' }>;
  m: RailMetrics;
  focused: boolean;
  onPress: () => void;
  onMenu: (anchor?: MenuAnchor) => void;
  onHoverIn?: () => void;
}) {
  const { type } = useLayout();
  const k = m.tv ? m.s : (n: number) => n;
  const ep = entry.type === 'series' ? entry.episode : undefined;
  const key = entry.type === 'movie' ? movieKey(entry.item) : ep ? episodeKey(ep) : undefined;
  const pr = useSettings((st) => (key ? st.vodProgress[key] : undefined));
  // movies only have wide artwork in their details
  const info = useMovieInfo(entry.type === 'movie' ? entry.item : undefined, 600);
  const backdrop = entry.type === 'movie' ? info?.backdrop : entry.item.backdrop;
  const poster = (entry.type === 'movie' && info?.poster) || entry.item.poster;
  const resume = !!pr && pr.pos > 0 && pr.dur > 0;
  const left = resume ? `${Math.max(1, Math.round((pr.dur - pr.pos) / 60))} min left` : pr?.done ? 'Watched' : undefined;
  const sub = [ep ? `S${ep.season} E${ep.episode}` : undefined, left].filter(Boolean).join(' · ');
  const border = m.tv ? m.s(2.5) : 2;
  // without wide artwork: the poster on the right of its own blurred colours
  const thumbW = backdrop || !poster ? 0 : (m.wideH - border * 2) / 1.5;
  return (
    <Focusable
      focused={focused}
      onPress={onPress}
      onLongPress={() => onMenu()}
      onContextMenu={onMenu}
      onHoverIn={onHoverIn}
      accessibilityLabel={entry.item.name}
      style={{ width: m.wideW, height: m.wideH, borderRadius: k(radius.md) }}
      hoverStyle={{ transform: [{ scale: 1.03 }] }}
      focusStyle={{ transform: [{ scale: 1.06 }] }}
    >
      {({ focused: f, hovered }) => (
        <View style={{ flex: 1, borderRadius: k(radius.md), borderWidth: border, borderColor: f ? colors.focus : hovered ? colors.borderStrong : 'transparent', overflow: 'hidden', backgroundColor: colors.surface2 }}>
          {backdrop ? (
            <Image source={{ uri: imageUrl(backdrop) }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={backdrop} transition={200} />
          ) : poster ? (
            <Image source={{ uri: imageUrl(poster) }} style={[StyleSheet.absoluteFill, { opacity: 0.6 }]} contentFit="cover" blurRadius={24} cachePolicy="memory-disk" recyclingKey={poster} transition={200} />
          ) : null}
          <LinearGradient colors={[colors.bgClear, colors.bgVeil, colors.bg]} locations={[0.25, 0.65, 1]} style={StyleSheet.absoluteFill} />
          {thumbW ? (
            <Image source={{ uri: imageUrl(poster!) }} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: thumbW }} contentFit="cover" cachePolicy="memory-disk" recyclingKey={poster} transition={200} />
          ) : null}
          {f || hovered ? (
            <View style={{ position: 'absolute', top: k(8), left: k(8), width: k(26), height: k(26), borderRadius: radius.pill, backgroundColor: colors.focus, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="play" size={k(17)} color={colors.focusText} />
            </View>
          ) : null}
          <View style={{ position: 'absolute', left: k(9), right: thumbW + k(8), bottom: k(10) }}>
            <Text numberOfLines={1} style={[type('label'), { color: colors.text }]}>
              {cleanTitle(entry.item.name).title}
            </Text>
            {sub ? (
              <Text numberOfLines={1} style={[type('caption'), { color: colors.textDim }]}>
                {sub}
              </Text>
            ) : null}
          </View>
          {resume ? (
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: k(3), backgroundColor: colors.glass }}>
              <View style={{ width: `${Math.min(100, (pr.pos / pr.dur) * 100)}%`, height: '100%', backgroundColor: colors.accent }} />
            </View>
          ) : null}
        </View>
      )}
    </Focusable>
  );
});

/** The last card of a long row: opens the whole category. */
function MoreCard({
  entry,
  m,
  width,
  height,
  focused,
  onPress,
  onHoverIn,
}: {
  entry: Extract<HomeEntry, { type: 'more' }>;
  m: RailMetrics;
  width: number;
  height: number;
  focused: boolean;
  onPress: () => void;
  onHoverIn?: () => void;
}) {
  const { type } = useLayout();
  const k = m.tv ? m.s : (n: number) => n;
  return (
    <Focusable
      focused={focused}
      onPress={onPress}
      onHoverIn={onHoverIn}
      accessibilityLabel={`See all of ${entry.title}`}
      style={{ width, height, borderRadius: k(radius.md), backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', padding: k(8) }}
      hoverStyle={{ backgroundColor: colors.surface2, borderColor: colors.borderStrong }}
      focusStyle={{ backgroundColor: colors.focus, borderColor: colors.focus, transform: [{ scale: 1.07 }] }}
    >
      {({ focused: f }) => (
        <>
          <View style={{ width: k(40), height: k(40), borderRadius: k(20), alignItems: 'center', justifyContent: 'center', backgroundColor: f ? colors.focusText : colors.accentFill }}>
            <Icon name="arrow-right" size={k(22)} color={f ? colors.focus : colors.onAccent} />
          </View>
          <Text style={[type('label'), { color: f ? colors.focusText : colors.text, marginTop: k(10) }]}>See all</Text>
          <Text style={[type('caption'), { color: f ? colors.focusDim : colors.textDim, marginTop: k(2) }]}>{entry.total} titles</Text>
        </>
      )}
    </Focusable>
  );
}

/** Mouse arrow at a row's end. */
function Pager({ side, m, height, onPress }: { side: 'left' | 'right'; m: RailMetrics; height: number; onPress: () => void }) {
  return (
    <Pressable
      focusable={false}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={side === 'left' ? 'Scroll back' : 'Scroll on'}
      style={(state) => ({
        position: 'absolute',
        left: side === 'left' ? 0 : undefined,
        right: side === 'right' ? 0 : undefined,
        top: m.titleH + m.padY,
        height,
        width: m.s(34),
        alignItems: 'center',
        justifyContent: 'center',
        // react-native-web reports hover in the pressable state
        backgroundColor: (state as { hovered?: boolean }).hovered ? colors.videoScrim : colors.scrim,
      })}
    >
      <Icon name={side === 'left' ? 'chevron-left' : 'chevron-right'} size={m.s(28)} color={colors.onVideo} />
    </Pressable>
  );
}
