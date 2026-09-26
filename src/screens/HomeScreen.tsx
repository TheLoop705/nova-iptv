import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { Channel } from '../types';
import { colors, fonts, radius, useLayout } from '../theme';
import { useLibrary, ALL } from '../store/library';
import { useActivePlaylist, useSettings, watchId, type VodProgress, type WatchEntry } from '../store/settings';
import { usePlayer } from '../store/player';
import { useUI, type MenuAnchor, type SheetOption } from '../store/ui';
import { Layer, useKeys } from '../input/keys';
import { programAt } from '../services/epg';
import { continueSeries, episodeKey, movieKey, playMovie, resumeEpisode } from '../services/vod';
import { imageUrl } from '../services/http';
import { formatClock, formatDuration } from '../utils/format';
import { useNow } from '../utils/hooks';
import { Focusable } from '../components/Focusable';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { Icon } from '../components/Icon';

const MAX_RECENT = 24;

interface Row {
  id: string;
  title: string;
  entries: WatchEntry[];
}

/** Home: pick up whatever you watched last — live channels, movies and series — plus favourite channels. */
export function HomeScreen() {
  const { s, mode, type } = useLayout();
  const tv = mode === 'tv';
  const k = tv ? s : (n: number) => n;
  const pid = useLibrary((st) => st.playlistId);
  const byId = useLibrary((st) => st.byId);
  const epg = useLibrary((st) => st.epg);
  const history = useSettings((st) => (pid ? st.history[pid] : undefined));
  const recents = useSettings((st) => (pid ? st.recents[pid] : undefined));
  const recentMovies = useSettings((st) => (pid ? st.recentMovies[pid] : undefined));
  const favorites = useSettings((st) => (pid ? st.favorites[pid] : undefined));
  const progress = useSettings((st) => st.vodProgress);
  const clock24 = useSettings((st) => st.prefs.clock24);
  const playlist = useActivePlaylist();
  const menuFocused = useUI((st) => st.menuFocused);
  const detailOpen = useUI((st) => !!st.detail);
  const sheetOpen = useUI((st) => !!st.sheet);
  const fullscreen = usePlayer((st) => st.fullscreen && !!st.item);
  const now = useNow(30000);

  // Recently watched: the history (newest first), topped up with channels and movies watched before
  // history existed so the row isn't empty after an update.
  const recent = useMemo(() => {
    const out: WatchEntry[] = [];
    const seen = new Set<string>();
    const add = (e: WatchEntry) => {
      if (seen.has(e.id) || out.length >= MAX_RECENT) return;
      if (e.kind === 'live' && !byId[e.channelId]) return;
      seen.add(e.id);
      out.push(e);
    };
    (history ?? []).forEach(add);
    (recents ?? []).forEach((channelId) => add({ kind: 'live', id: watchId.live(channelId), channelId, at: 0 }));
    (recentMovies ?? []).forEach((item) => add({ kind: 'movie', id: watchId.movie(item.id), item, at: 0 }));
    return out;
  }, [history, recents, recentMovies, byId]);

  const favChannels = useMemo(
    () => (favorites ?? []).filter((id) => byId[id]).map((channelId): WatchEntry => ({ kind: 'live', id: watchId.live(channelId), channelId, at: 0 })),
    [favorites, byId]
  );

  const rows: Row[] = useMemo(
    () =>
      [
        { id: 'recent', title: 'Recently watched', entries: recent },
        { id: 'fav', title: 'Favorite channels', entries: favChannels },
      ].filter((r) => r.entries.length),
    [recent, favChannels]
  );

  // ---- actions ----
  const play = useCallback((e: WatchEntry) => {
    if (e.kind === 'live') return usePlayer.getState().playChannel(e.channelId, { groupId: ALL, fullscreen: true });
    if (e.kind === 'movie') return playMovie(e.item);
    void continueSeries(e.series, e.episode);
  }, []);

  const openOptions = useCallback(
    (e: WatchEntry, anchor?: MenuAnchor) => {
      const ui = useUI.getState();
      const st = useSettings.getState();
      const remove: SheetOption = { label: 'Remove from recently watched', icon: 'close-circle-outline', onSelect: () => pid && st.removeHistory(pid, e.id) };
      if (e.kind === 'live') {
        const ch = byId[e.channelId];
        return ui.openSheet({ anchor, title: ch ? `${ch.num}  ${ch.name}` : 'Channel', options: [{ label: 'Watch', icon: 'play-circle-outline', onSelect: () => play(e) }, remove] });
      }
      const key = e.kind === 'movie' ? movieKey(e.item) : episodeKey(e.episode);
      const pr = st.vodProgress[key];
      const resume = pr && pr.pos > 0;
      const watched: SheetOption = pr?.done
        ? { label: 'Mark as unwatched', icon: 'check-circle-outline', onSelect: () => st.setWatched(key, false) }
        : { label: 'Mark as watched', icon: 'check-circle', onSelect: () => st.setWatched(key, true) };
      if (e.kind === 'movie') {
        return ui.openSheet({
          anchor,
          title: e.item.name,
          subtitle: e.item.year,
          options: [
            { label: resume ? `Resume ${formatDuration(pr.pos)}` : 'Play', icon: 'play', onSelect: () => playMovie(e.item) },
            ...(resume ? [{ label: 'Play from the beginning', icon: 'restart', onSelect: () => playMovie(e.item, true) }] : []),
            watched,
            { label: 'Movie details', icon: 'information-outline', onSelect: () => ui.setDetail({ kind: 'movie', item: e.item }) },
            remove,
          ],
        });
      }
      const ep = e.episode;
      return ui.openSheet({
        anchor,
        title: e.series.name,
        subtitle: `S${ep.season} E${ep.episode} · ${ep.title}`,
        options: [
          { label: resume ? `Resume ${formatDuration(pr.pos)}` : pr?.done ? 'Play next episode' : 'Play', icon: 'play', onSelect: () => play(e) },
          { label: `Play S${ep.season} E${ep.episode} from the beginning`, icon: 'restart', onSelect: () => void resumeEpisode(e.series, ep, true) },
          watched,
          { label: 'Series details', icon: 'information-outline', onSelect: () => ui.setDetail({ kind: 'series', item: e.series }) },
          remove,
        ],
      });
    },
    [byId, pid, play]
  );

  // ---- remote ----
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);
  const listRefs = useRef<Record<string, FlatList<WatchEntry> | null>>({});
  const scrollRef = useRef<ScrollView>(null);
  const rowY = useRef<Record<string, number>>({});
  const cardW = tv ? s(208) : 232;
  const gap = tv ? s(14) : 12;

  useEffect(() => {
    if (row >= rows.length) setRow(Math.max(0, rows.length - 1));
    else if (rows[row] && col >= rows[row].entries.length) setCol(Math.max(0, rows[row].entries.length - 1));
  }, [rows, row, col]);

  useEffect(() => {
    const r = rows[row];
    if (!r) return;
    listRefs.current[r.id]?.scrollToOffset({ offset: Math.max(0, (col - 1) * (cardW + gap)), animated: true });
    const y = rowY.current[r.id];
    if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - (tv ? s(80) : 80)), animated: true });
  }, [row, col, rows, cardW, gap, tv, s]);

  const keysEnabled = !menuFocused && !detailOpen && !sheetOpen && !fullscreen;
  useKeys(
    (e) => {
      const r = rows[row];
      switch (e.key) {
        case 'up':
          return setRow((i) => Math.max(0, i - 1));
        case 'down':
          return setRow((i) => Math.min(rows.length - 1, i + 1));
        case 'left':
          if (col === 0) return false; // to the menu
          return setCol(col - 1);
        case 'right':
          return r ? setCol(Math.min(r.entries.length - 1, col + 1)) : undefined;
        case 'select':
          if (!r?.entries[col]) return;
          return e.long ? openOptions(r.entries[col]) : play(r.entries[col]);
        case 'menu':
          return r?.entries[col] ? openOptions(r.entries[col]) : undefined;
        default:
          return false;
      }
    },
    keysEnabled && rows.length > 0,
    Layer.screen
  );

  const hour = new Date(now).getHours();
  const greeting = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: tv ? s(24) : 16, paddingBottom: tv ? s(40) : 32 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: tv ? s(28) : 16, marginBottom: tv ? s(20) : 16 }}>
        <View style={{ flex: 1 }}>
          <Text style={[type('display'), { color: colors.text }]}>{greeting}</Text>
          <Text style={[type('body'), { color: colors.textDim, marginTop: k(2) }]}>{playlist?.name}</Text>
        </View>
        {tv ? <Text style={[type('title'), { color: colors.text, fontVariant: ['tabular-nums'] }]}>{formatClock(now, clock24)}</Text> : null}
      </View>

      {rows.length === 0 ? <EmptyHome tv={tv} k={k} enabled={keysEnabled} /> : null}

      {rows.map((r, ri) => (
        <View key={r.id} onLayout={(e) => (rowY.current[r.id] = e.nativeEvent.layout.y)} style={{ marginBottom: tv ? s(22) : 20 }}>
          <Text style={[type('heading'), { color: ri === row && tv ? colors.text : colors.textDim, paddingHorizontal: tv ? s(28) : 16, marginBottom: tv ? s(10) : 10 }]}>{r.title}</Text>
          <FlatList
            ref={(el) => {
              listRefs.current[r.id] = el;
            }}
            horizontal
            data={r.entries}
            keyExtractor={(e) => e.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: tv ? s(28) : 16, gap, paddingVertical: tv ? s(8) : 4 }}
            getItemLayout={(_d, i) => ({ length: cardW + gap, offset: (cardW + gap) * i, index: i })}
            renderItem={({ item: e, index: ci }) => (
              <WatchCard
                entry={e}
                channel={e.kind === 'live' ? byId[e.channelId] : undefined}
                epg={e.kind === 'live' ? epg[e.channelId] : undefined}
                progress={e.kind === 'movie' ? progress[movieKey(e.item)] : e.kind === 'episode' ? progress[episodeKey(e.episode)] : undefined}
                width={cardW}
                focused={ri === row && ci === col}
                now={now}
                clock24={clock24}
                tv={tv}
                k={k}
                onPress={() => {
                  setRow(ri);
                  setCol(ci);
                  play(e);
                }}
                onLongPress={(anchor) => openOptions(e, anchor)}
              />
            )}
          />
        </View>
      ))}
    </ScrollView>
  );
}

function WatchCard({
  entry,
  channel,
  epg,
  progress,
  width,
  focused,
  now,
  clock24,
  tv,
  k,
  onPress,
  onLongPress,
}: {
  entry: WatchEntry;
  channel?: Channel;
  epg?: ReturnType<typeof useLibrary.getState>['epg'][string];
  progress?: VodProgress;
  width: number;
  focused: boolean;
  now: number;
  clock24: boolean;
  tv: boolean;
  k: (n: number) => number;
  onPress: () => void;
  onLongPress: (anchor?: MenuAnchor) => void;
}) {
  const imgH = Math.round((width * 9) / 16);
  let image: string | undefined;
  let badge: { label: string; tone: 'live' | 'catchup' | 'neutral' };
  let title: string;
  let line1: string | undefined;
  let line2: string | undefined;
  let fraction = 0;
  let done = false;

  if (entry.kind === 'live') {
    const p = programAt(epg, now);
    badge = { label: 'LIVE', tone: 'live' };
    title = channel ? channel.name : 'Channel';
    line1 = p?.title || (channel ? `Channel ${channel.num}` : undefined);
    line2 = p ? `${formatClock(p.start, clock24)} – ${formatClock(p.end, clock24)}` : undefined;
    fraction = p ? (now - p.start) / (p.end - p.start) : 0;
  } else {
    const resume = progress && progress.pos > 0 && progress.dur > 0;
    done = !!progress?.done && !resume;
    fraction = resume ? progress!.pos / progress!.dur : 0;
    const left = resume ? `${Math.max(1, Math.round((progress!.dur - progress!.pos) / 60))} min left` : undefined;
    if (entry.kind === 'movie') {
      image = entry.item.poster;
      badge = { label: 'MOVIE', tone: 'neutral' };
      title = entry.item.name;
      line1 = left ?? (done ? 'Watched' : entry.item.year);
    } else {
      image = entry.episode.image || entry.series.poster;
      badge = { label: 'SERIES', tone: 'catchup' };
      title = entry.series.name;
      line1 = `S${entry.episode.season} E${entry.episode.episode} · ${entry.episode.title}`;
      line2 = left ?? (done ? 'Watched · next episode' : undefined);
    }
  }

  return (
    <Focusable
      focused={focused}
      onPress={onPress}
      onLongPress={() => onLongPress()}
      onContextMenu={onLongPress}
      accessibilityLabel={title}
      style={{ width, borderRadius: radius.md, padding: 0 }}
      hoverStyle={{ transform: [{ scale: 1.03 }] }}
      focusStyle={{ transform: [{ scale: 1.05 }] }}
    >
      {({ focused: f, hovered }) => (
        <View>
          <View
            style={{
              height: imgH,
              borderRadius: k(radius.md),
              borderWidth: tv ? k(2.5) : 2,
              borderColor: f ? colors.focus : hovered ? colors.borderStrong : 'transparent',
              backgroundColor: colors.surface2,
              overflow: 'hidden',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {entry.kind === 'live' ? (
              channel ? <Logo uri={channel.logo} name={channel.name} size={imgH * 0.36} rounded={k(6)} /> : null
            ) : image ? (
              <Image source={{ uri: imageUrl(image) }} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} contentFit="cover" cachePolicy="memory-disk" recyclingKey={image} transition={150} />
            ) : (
              <Icon name={entry.kind === 'movie' ? 'movie-open-outline' : 'television-play'} size={imgH * 0.3} color={colors.muted} />
            )}
            <View style={{ position: 'absolute', top: k(7), left: k(7), flexDirection: 'row' }}>
              <Badge label={badge.label} tone={badge.tone} />
            </View>
            {done ? (
              <View style={{ position: 'absolute', top: k(6), right: k(6), backgroundColor: colors.videoScrim, borderRadius: radius.pill, padding: k(2) }}>
                <Icon name="check-circle" size={k(15)} color={colors.success} />
              </View>
            ) : null}
            {fraction > 0 ? (
              <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: k(4), backgroundColor: colors.videoScrim }}>
                <View style={{ width: `${Math.min(100, fraction * 100)}%`, height: '100%', backgroundColor: entry.kind === 'live' ? colors.live : colors.accent }} />
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} style={{ color: f || hovered ? colors.text : colors.textDim, fontSize: k(13), fontWeight: '700', marginTop: k(7), fontFamily: fonts.regular }}>
            {title}
          </Text>
          {line1 ? (
            <Text numberOfLines={1} style={{ color: colors.muted, fontSize: k(11.5), marginTop: k(1), fontFamily: fonts.regular }}>
              {line1}
            </Text>
          ) : null}
          {line2 ? (
            <Text numberOfLines={1} style={{ color: colors.muted, fontSize: k(11), marginTop: k(1), fontFamily: fonts.regular, fontVariant: ['tabular-nums'] }}>
              {line2}
            </Text>
          ) : null}
        </View>
      )}
    </Focusable>
  );
}

function EmptyHome({ tv, k, enabled }: { tv: boolean; k: (n: number) => number; enabled: boolean }) {
  const setScreen = useUI((st) => st.setScreen);
  const [btn, setBtn] = useState(0);
  const targets = [
    { label: 'Live TV', icon: 'television-classic', screen: 'guide' as const },
    { label: 'Movies', icon: 'movie-open-outline', screen: 'movies' as const },
    { label: 'Series', icon: 'television-play', screen: 'series' as const },
  ];
  useKeys(
    (e) => {
      if (e.key === 'left') return btn === 0 ? false : setBtn(btn - 1);
      if (e.key === 'right') return setBtn(Math.min(targets.length - 1, btn + 1));
      if (e.key === 'select') return setScreen(targets[btn].screen);
      return false;
    },
    enabled,
    Layer.screen
  );
  return (
    <View style={{ alignItems: 'center', paddingVertical: tv ? k(50) : 40, paddingHorizontal: 20 }}>
      <Icon name="history" size={k(40)} color={colors.muted} />
      <Text style={{ color: colors.text, fontSize: k(17), fontWeight: '800', marginTop: k(10), fontFamily: fonts.regular }}>Nothing watched yet</Text>
      <Text style={{ color: colors.textDim, fontSize: k(12.5), marginTop: k(4), textAlign: 'center', fontFamily: fonts.regular }}>
        Channels, movies and episodes you watch show up here, with where you left off.
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: k(10), marginTop: k(18) }}>
        {targets.map((t, i) => (
          <Button key={t.screen} label={t.label} icon={t.icon} primary={i === 0} focused={i === btn} onPress={() => setScreen(t.screen)} />
        ))}
      </View>
    </View>
  );
}
