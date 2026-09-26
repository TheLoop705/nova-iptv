import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { Channel } from '../types';
import { colors, fonts, radius, useLayout } from '../theme';
import { useLibrary, ALL } from '../store/library';
import { useActivePlaylist, useSettings, watchId, type VodProgress, type WatchEntry } from '../store/settings';
import { usePlayer } from '../store/player';
import { useUI, type MenuAnchor, type SheetOption } from '../store/ui';
import { openSearch } from '../store/actions';
import { Layer, useKeys } from '../input/keys';
import { programAt } from '../services/epg';
import { continueSeries, episodeKey, movieKey, playMovie, resumeEpisode } from '../services/vod';
import { imageUrl } from '../services/http';
import { formatClock, formatDay, formatDuration } from '../utils/format';
import { useNow } from '../utils/hooks';
import { Focusable } from '../components/Focusable';
import { Badge } from '../components/Badge';
import { Logo } from '../components/Logo';
import { Icon } from '../components/Icon';

const MAX_RECENT = 40;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Home, the app's start page. Split in two on TVs and desktops: everything watched recently on the
 * left (live channels, movies and episodes, newest first) and a big Search button on the right.
 */
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
  const progress = useSettings((st) => st.vodProgress);
  const clock24 = useSettings((st) => st.prefs.clock24);
  const playlist = useActivePlaylist();
  const menuFocused = useUI((st) => st.menuFocused);
  const detailOpen = useUI((st) => !!st.detail);
  const sheetOpen = useUI((st) => !!st.sheet);
  const fullscreen = usePlayer((st) => st.fullscreen && !!st.item);
  const now = useNow(30000);

  // Newest first. Channels and movies watched before the history existed have no time and follow at the end.
  const recent = useMemo(() => {
    const out: WatchEntry[] = [];
    const seen = new Set<string>();
    const add = (e: WatchEntry) => {
      if (seen.has(e.id) || out.length >= MAX_RECENT) return;
      if (e.kind === 'live' && !byId[e.channelId]) return;
      seen.add(e.id);
      out.push(e);
    };
    [...(history ?? [])].sort((a, b) => b.at - a.at).forEach(add);
    (recents ?? []).forEach((channelId) => add({ kind: 'live', id: watchId.live(channelId), channelId, at: 0 }));
    (recentMovies ?? []).forEach((item) => add({ kind: 'movie', id: watchId.movie(item.id), item, at: 0 }));
    return out;
  }, [history, recents, recentMovies, byId]);

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

  // ---- remote: the list on the left, the Search button on the right ----
  const [zone, setZone] = useState<'list' | 'search'>(recent.length ? 'list' : 'search');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<FlatList<WatchEntry>>(null);
  const rowH = tv ? s(76) : 84;

  useEffect(() => {
    if (!recent.length) setZone('search');
    else if (idx >= recent.length) setIdx(recent.length - 1);
  }, [recent.length, idx]);

  useEffect(() => {
    if (zone === 'list') listRef.current?.scrollToOffset({ offset: Math.max(0, (idx - 2) * rowH), animated: true });
  }, [idx, zone, rowH]);

  const keysEnabled = !menuFocused && !detailOpen && !sheetOpen && !fullscreen;
  useKeys(
    (e) => {
      if (zone === 'search') {
        if (e.key === 'select') return openSearch();
        if (e.key === 'left') return recent.length ? setZone('list') : false;
        return e.key === 'up' || e.key === 'down' || e.key === 'right' ? undefined : false;
      }
      const cur = recent[idx];
      switch (e.key) {
        case 'up':
          return setIdx((i) => Math.max(0, i - 1));
        case 'down':
          return setIdx((i) => Math.min(recent.length - 1, i + 1));
        case 'chup':
          return setIdx((i) => Math.max(0, i - 5));
        case 'chdown':
          return setIdx((i) => Math.min(recent.length - 1, i + 5));
        case 'right':
          return setZone('search');
        case 'left':
          return false; // on to the menu
        case 'select':
          if (!cur) return;
          return e.long ? openOptions(cur) : play(cur);
        case 'menu':
          return cur ? openOptions(cur) : undefined;
        default:
          return false;
      }
    },
    keysEnabled,
    Layer.screen
  );

  const hour = new Date(now).getHours();
  const greeting = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const header = (
    <View style={{ marginBottom: tv ? s(14) : 14 }}>
      <Text style={[type('display'), { color: colors.text }]}>{greeting}</Text>
      <Text style={[type('body'), { color: colors.textDim, marginTop: k(2) }]}>{playlist?.name}</Text>
    </View>
  );

  const renderRow = (e: WatchEntry, index: number) => (
    <WatchRow
      key={e.id}
      entry={e}
      channel={e.kind === 'live' ? byId[e.channelId] : undefined}
      epg={e.kind === 'live' ? epg[e.channelId] : undefined}
      progress={e.kind === 'movie' ? progress[movieKey(e.item)] : e.kind === 'episode' ? progress[episodeKey(e.episode)] : undefined}
      height={rowH}
      focused={zone === 'list' && index === idx}
      now={now}
      clock24={clock24}
      tv={tv}
      k={k}
      onPress={() => {
        setZone('list');
        setIdx(index);
        play(e);
      }}
      onMenu={(anchor) => openOptions(e, anchor)}
    />
  );

  // TV/desktop: its own scrolling list; phones: rows inside the page's scroll view
  const list = recent.length ? (
    tv ? (
      <FlatList
        ref={listRef}
        data={recent}
        keyExtractor={(e) => e.id}
        getItemLayout={(_d, i) => ({ length: rowH, offset: rowH * i, index: i })}
        contentContainerStyle={{ paddingBottom: s(24) }}
        showsVerticalScrollIndicator={false}
        renderItem={({ item: e, index }) => renderRow(e, index)}
      />
    ) : (
      <View>{recent.map(renderRow)}</View>
    )
  ) : (
    <View style={{ paddingVertical: tv ? s(30) : 24, alignItems: 'flex-start' }}>
      <Icon name="history" size={k(34)} color={colors.muted} />
      <Text style={{ color: colors.text, fontSize: k(16), fontWeight: '800', marginTop: k(10), fontFamily: fonts.regular }}>Nothing watched yet</Text>
      <Text style={{ color: colors.textDim, fontSize: k(12.5), marginTop: k(4), maxWidth: k(360), fontFamily: fonts.regular }}>
        Channels, movies and episodes you watch show up here, newest first, with where you left off.
      </Text>
    </View>
  );

  const search = <SearchButton focused={zone === 'search'} tv={tv} k={k} onPress={openSearch} />;

  if (!tv) {
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        {header}
        {search}
        <Text style={[type('heading'), { color: colors.text, marginTop: 22, marginBottom: 8 }]}>Recently watched</Text>
        {list}
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: 'row', paddingTop: s(24), paddingLeft: s(28), paddingRight: s(24) }}>
      <View style={{ flex: 1.15, paddingRight: s(24) }}>
        {header}
        <Text style={[type('heading'), { color: zone === 'list' ? colors.text : colors.textDim, marginBottom: s(8) }]}>Recently watched</Text>
        <View style={{ flex: 1 }}>{list}</View>
      </View>
      <View style={{ width: 1, backgroundColor: colors.border, marginBottom: s(24) }} />
      <View style={{ flex: 1, paddingLeft: s(24) }}>
        <Text style={[type('title'), { color: colors.text, alignSelf: 'flex-end', fontVariant: ['tabular-nums'] }]}>{formatClock(now, clock24)}</Text>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: s(40) }}>{search}</View>
      </View>
    </View>
  );
}

/** "12 min ago", "Today 17:01", "Yesterday 21:30"; nothing for entries from before the history existed. */
function watchedAgo(at: number, now: number, clock24: boolean): string | undefined {
  if (!at) return undefined;
  const min = Math.floor((now - at) / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  return `${formatDay(at, now)} ${formatClock(at, clock24)}`;
}

function SearchButton({ focused, tv, k, onPress }: { focused: boolean; tv: boolean; k: (n: number) => number; onPress: () => void }) {
  const hint = Platform.OS === 'web' ? `or press ${isMac ? '⌘K' : 'Ctrl K'}` : Platform.isTV ? 'Hold ☰ Menu to search by voice' : undefined;
  if (!tv) {
    return (
      <Focusable
        focused={focused}
        onPress={onPress}
        accessibilityLabel="Search"
        style={{ flexDirection: 'row', alignItems: 'center', height: 56, borderRadius: radius.pill, paddingHorizontal: 20, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border }}
      >
        <Icon name="magnify" size={24} color={colors.accent} />
        <Text style={{ color: colors.textDim, fontSize: 16, marginLeft: 12, fontFamily: fonts.regular }}>Search channels, movies and series</Text>
      </Focusable>
    );
  }
  return (
    <Focusable
      focused={focused}
      alwaysShowFocus={false}
      onPress={onPress}
      accessibilityLabel="Search"
      style={{ alignItems: 'center', justifyContent: 'center', width: k(260), paddingVertical: k(30), borderRadius: k(radius.xl), backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}
      hoverStyle={{ backgroundColor: colors.surface2, borderColor: colors.borderStrong }}
      focusStyle={{ backgroundColor: colors.focus, borderColor: colors.focus, transform: [{ scale: 1.04 }] }}
    >
      {({ focused: f }) => (
        <>
          <View style={{ width: k(84), height: k(84), borderRadius: k(42), alignItems: 'center', justifyContent: 'center', backgroundColor: f ? colors.focusText : colors.accentFill }}>
            <Icon name="magnify" size={k(44)} color={f ? colors.focus : colors.onAccent} />
          </View>
          <Text style={{ color: f ? colors.focusText : colors.text, fontSize: k(22), fontWeight: '800', marginTop: k(14), fontFamily: fonts.regular }}>Search</Text>
          <Text style={{ color: f ? colors.focusDim : colors.textDim, fontSize: k(12.5), marginTop: k(4), textAlign: 'center', fontFamily: fonts.regular }}>Channels, movies and series</Text>
          {hint ? <Text style={{ color: f ? colors.focusDim : colors.muted, fontSize: k(11), marginTop: k(10), fontFamily: fonts.regular }}>{hint}</Text> : null}
        </>
      )}
    </Focusable>
  );
}

function WatchRow({
  entry,
  channel,
  epg,
  progress,
  height,
  focused,
  now,
  clock24,
  tv,
  k,
  onPress,
  onMenu,
}: {
  entry: WatchEntry;
  channel?: Channel;
  epg?: ReturnType<typeof useLibrary.getState>['epg'][string];
  progress?: VodProgress;
  height: number;
  focused: boolean;
  now: number;
  clock24: boolean;
  tv: boolean;
  k: (n: number) => number;
  onPress: () => void;
  onMenu: (anchor?: MenuAnchor) => void;
}) {
  const thumbH = height - k(12);
  const thumbW = Math.round((thumbH * 16) / 9);
  let image: string | undefined;
  let badge: { label: string; tone: 'live' | 'catchup' | 'neutral' };
  let title: string;
  let line1: string | undefined;
  let fraction = 0;
  let done = false;

  if (entry.kind === 'live') {
    const p = programAt(epg, now);
    badge = { label: 'LIVE', tone: 'live' };
    title = channel ? channel.name : 'Channel';
    line1 = p ? `${p.title} · ${formatClock(p.start, clock24)} – ${formatClock(p.end, clock24)}` : channel ? `Channel ${channel.num}` : undefined;
    fraction = p ? (now - p.start) / (p.end - p.start) : 0;
  } else {
    const resume = progress && progress.pos > 0 && progress.dur > 0;
    done = !!progress?.done && !resume;
    fraction = resume ? progress!.pos / progress!.dur : 0;
    const left = resume ? `${Math.max(1, Math.round((progress!.dur - progress!.pos) / 60))} min left` : done ? 'Watched' : undefined;
    if (entry.kind === 'movie') {
      image = entry.item.poster;
      badge = { label: 'MOVIE', tone: 'neutral' };
      title = entry.item.name;
      line1 = [left, entry.item.year].filter(Boolean).join(' · ') || undefined;
    } else {
      image = entry.episode.image || entry.series.poster;
      badge = { label: 'SERIES', tone: 'catchup' };
      title = entry.series.name;
      line1 = [`S${entry.episode.season} E${entry.episode.episode} · ${entry.episode.title}`, left].filter(Boolean).join(' · ');
    }
  }
  const when = watchedAgo(entry.at, now, clock24);

  return (
    <Focusable
      focused={focused}
      onPress={onPress}
      onLongPress={() => onMenu()}
      onContextMenu={onMenu}
      accessibilityLabel={title}
      style={{ height: height - k(6), marginBottom: k(6), borderRadius: k(radius.md), flexDirection: 'row', alignItems: 'center', paddingHorizontal: k(6), backgroundColor: colors.surface }}
      focusStyle={{ backgroundColor: colors.focus, transform: [{ scale: 1.02 }] }}
    >
      {({ focused: f }) => (
        <>
          <View style={{ width: thumbW, height: thumbH, borderRadius: k(radius.sm), backgroundColor: colors.surface2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
            {entry.kind === 'live' ? (
              channel ? <Logo uri={channel.logo} name={channel.name} size={thumbH * 0.42} rounded={k(5)} /> : null
            ) : image ? (
              <Image source={{ uri: imageUrl(image) }} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} contentFit="cover" cachePolicy="memory-disk" recyclingKey={image} transition={150} />
            ) : (
              <Icon name={entry.kind === 'movie' ? 'movie-open-outline' : 'television-play'} size={thumbH * 0.4} color={colors.muted} />
            )}
            {done ? (
              <View style={{ position: 'absolute', top: k(4), right: k(4), backgroundColor: colors.videoScrim, borderRadius: radius.pill, padding: k(1.5) }}>
                <Icon name="check-circle" size={k(13)} color={colors.success} />
              </View>
            ) : null}
            {fraction > 0 ? (
              <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: k(3.5), backgroundColor: colors.videoScrim }}>
                <View style={{ width: `${Math.min(100, fraction * 100)}%`, height: '100%', backgroundColor: entry.kind === 'live' ? colors.live : colors.accent }} />
              </View>
            ) : null}
          </View>
          <View style={{ flex: 1, marginLeft: k(12), marginRight: k(8) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Badge label={badge.label} tone={badge.tone} />
              <Text numberOfLines={1} style={{ flex: 1, color: f ? colors.focusText : colors.text, fontSize: k(14), fontWeight: '700', fontFamily: fonts.regular }}>
                {title}
              </Text>
            </View>
            {line1 ? (
              <Text numberOfLines={1} style={{ color: f ? colors.focusDim : colors.textDim, fontSize: k(12), marginTop: k(4), fontFamily: fonts.regular }}>
                {line1}
              </Text>
            ) : null}
          </View>
          {when ? (
            <Text numberOfLines={1} style={{ color: f ? colors.focusDim : colors.muted, fontSize: k(11), marginRight: k(6), fontVariant: ['tabular-nums'], fontFamily: fonts.regular }}>
              {when}
            </Text>
          ) : null}
        </>
      )}
    </Focusable>
  );
}
