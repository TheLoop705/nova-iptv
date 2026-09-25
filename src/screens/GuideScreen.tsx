import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, PanResponder, Pressable, ScrollView, Text, View, type ViewToken } from 'react-native';
import type { Channel, Program } from '../types';
import { colors, fonts, radius, useLayout } from '../theme';
import { Chip } from '../components/Chip';
import { useLibrary, useAllGroups, ALL } from '../store/library';
import { useSettings } from '../store/settings';
import { usePlayer } from '../store/player';
import { useUI } from '../store/ui';
import { Layer, useKeyMode, useKeys, type KeyEvt } from '../input/keys';
import { cellAt, nextProgram, programAt, type Cell } from '../services/epg';
import { canCatchup } from '../services/catchup';
import { formatClock, formatDay, formatRange } from '../utils/format';
import { useNow } from '../utils/hooks';
import { GuideRow, type RowMetrics } from './guide/GuideRow';
import { Hero, PreviewSlot } from './guide/Hero';
import { Icon } from '../components/Icon';
import { Focusable } from '../components/Focusable';

const HALF = 30 * 60000;
const DAY = 86400000;
const align = (t: number) => Math.floor(t / HALF) * HALF;
/** Window start for "now": keep at least ~10 minutes of the past visible */
const nowWindow = (t: number) => align(t - 10 * 60000);

type Zone = 'grid' | 'channels' | 'groups';

export function GuideScreen() {
  const { s, mode, width: winW } = useLayout();
  const tv = mode === 'tv';
  const keyMode = useKeyMode();

  const pid = useLibrary((st) => st.playlistId);
  const byId = useLibrary((st) => st.byId);
  const epg = useLibrary((st) => st.epg);
  const epgStatus = useLibrary((st) => st.epgStatus);
  const epgMessage = useLibrary((st) => st.epgMessage);
  const groups = useAllGroups();
  const prefs = useSettings((st) => st.prefs);
  const favorites = useSettings((st) => (pid ? st.favorites[pid] : undefined));
  const lastGroup = useSettings((st) => (pid ? st.lastGroup[pid] : undefined));
  const setLastGroup = useSettings((st) => st.setLastGroup);
  const toggleFavorite = useSettings((st) => st.toggleFavorite);
  const toggleHiddenGroup = useSettings((st) => st.toggleHiddenGroup);
  const menuFocused = useUI((st) => st.menuFocused);
  const openSheet = useUI((st) => st.openSheet);
  const showToast = useUI((st) => st.showToast);
  const item = usePlayer((st) => st.item);
  const fullscreen = usePlayer((st) => st.fullscreen);
  const now = useNow(15000);

  const [groupId, setGroupId] = useState(lastGroup ?? ALL);
  const group = groups.find((g) => g.id === groupId) ?? groups.find((g) => g.id === ALL)!;
  const channels = useMemo(() => (group ? (group.channelIds.map((id) => byId[id]).filter(Boolean) as Channel[]) : []), [group, byId]);
  const favSet = useMemo(() => new Set(favorites ?? []), [favorites]);
  const playingId = item && item.kind !== 'vod' ? item.channelId : undefined;

  const W = 90 * 60000;
  const [windowStart, setWindowStart] = useState(() => nowWindow(Date.now()));
  const windowEnd = windowStart + W;
  const [zone, setZone] = useState<Zone>('grid');
  const [row, setRow] = useState(0);
  const [focusTime, setFocusTime] = useState(() => Date.now());
  const [groupIndex, setGroupIndex] = useState(0);
  const [digits, setDigits] = useState('');
  const digitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- metrics ----
  const [boxW, setBoxW] = useState(winW - (tv ? s(64) : 0));
  const heroH = tv ? s(118) : 0;
  const headerH = tv ? s(26) : 30;
  const rowH = tv ? s(52) : 62;
  // TV/desktop: categories and channels are always on screen, the grid takes what's left
  const catW = tv ? s(168) : 0;
  const catGap = tv ? s(8) : 0;
  const chanW = tv ? s(236) : 64;
  const sidePad = tv ? s(10) : 0;
  const gridW = Math.max(120, boxW - catW - catGap - chanW - sidePad * 2 - s(2));
  const m: RowMetrics = useMemo(() => ({ rowH, chanW, gridW, compact: !tv, s }), [rowH, chanW, gridW, tv, s]);
  const px = gridW / W;

  // ---- list scrolling ----
  const listRef = useRef<FlatList<Channel>>(null);
  const topRow = useRef(0);
  const listH = useRef(0);

  const ensureVisible = useCallback(
    (r: number, animated = true, center = false) => {
      const visible = Math.max(1, Math.floor(listH.current / rowH) || 6);
      let top = topRow.current;
      if (center) top = Math.max(0, r - Math.floor(visible / 2));
      else if (r < top + 1) top = Math.max(0, r - 1);
      else if (r > top + visible - 2) top = r - visible + 2;
      top = Math.max(0, Math.min(top, Math.max(0, channels.length - visible)));
      if (top !== topRow.current || center) {
        topRow.current = top;
        listRef.current?.scrollToOffset({ offset: top * rowH, animated });
      }
    },
    [rowH, channels.length]
  );

  // Focus the playing channel (or the top) when the group changes
  useEffect(() => {
    const idx = playingId ? channels.findIndex((c) => c.id === playingId) : -1;
    const r = Math.max(0, idx);
    setRow(r);
    setFocusTime(Date.now());
    setWindowStart(nowWindow(Date.now()));
    const t = setTimeout(() => ensureVisible(r, false, true), 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.id, channels.length > 0]);

  // Coming back from fullscreen: follow the channel that's playing now (zapping may have moved it)
  const wasFullscreen = useRef(fullscreen);
  useEffect(() => {
    if (wasFullscreen.current && !fullscreen && playingId) {
      const idx = channels.findIndex((c) => c.id === playingId);
      if (idx >= 0) {
        setZone('grid');
        setRow(idx);
        setFocusTime(Date.now());
        setWindowStart(nowWindow(Date.now()));
        setTimeout(() => ensureVisible(idx, false, true), 30);
      }
    }
    wasFullscreen.current = fullscreen;
  }, [fullscreen, playingId, channels, ensureVisible]);

  // Keep the category cursor on the active group (not while the remote is moving through them)
  useEffect(() => {
    if (zone !== 'groups') setGroupIndex(Math.max(0, groups.findIndex((g) => g.id === group?.id)));
  }, [groups, group?.id, zone]);

  const chooseGroup = useCallback(
    (id: string, next: Zone | null = 'grid') => {
      setGroupId(id);
      if (pid) setLastGroup(pid, id);
      if (next) setZone(next);
    },
    [pid, setLastGroup]
  );

  // Moving through categories switches the channel list right away; debounced so holding the key
  // doesn't rebuild the list for every group it passes.
  useEffect(() => {
    if (zone !== 'groups') return;
    const g = groups[groupIndex];
    if (!g || g.id === group?.id) return;
    const t = setTimeout(() => chooseGroup(g.id, null), 160);
    return () => clearTimeout(t);
  }, [zone, groupIndex, groups, group?.id, chooseGroup]);

  const enterChannels = () => {
    const g = groups[groupIndex];
    if (g && g.id !== group?.id) chooseGroup(g.id, 'channels');
    else setZone('channels');
  };

  // ---- actions ----
  const playChannel = usePlayer((st) => st.playChannel);
  const playCatchup = usePlayer((st) => st.playCatchup);

  const programSheet = useCallback(
    (ch: Channel, p: Program) => {
      const isFav = favSet.has(ch.id);
      openSheet({
        title: p.title || 'Programme',
        subtitle: `${ch.name} · ${formatDay(p.start, Date.now())} ${formatRange(p.start, p.end, prefs.clock24)}${p.desc ? '\n\n' + p.desc : ''}`,
        options: [
          ...(canCatchup(ch, p)
            ? [{ label: 'Watch from the start', detail: 'Catch-up', icon: 'history', onSelect: () => playCatchup(ch.id, p) }]
            : []),
          { label: 'Watch channel live', icon: 'play-circle-outline', onSelect: () => playChannel(ch.id, { groupId: group.id, fullscreen: true }) },
          {
            label: isFav ? 'Remove from favorites' : 'Add to favorites',
            icon: isFav ? 'star-off-outline' : 'star-outline',
            onSelect: () => pid && toggleFavorite(pid, ch.id),
          },
        ],
      });
    },
    [favSet, openSheet, prefs.clock24, playCatchup, playChannel, group?.id, pid, toggleFavorite]
  );

  const channelSheet = useCallback(
    (ch: Channel, focusedProgram?: Program) => {
      const isFav = favSet.has(ch.id);
      const cur = programAt(epg[ch.id], Date.now());
      const p = focusedProgram ?? cur;
      openSheet({
        title: `${ch.num}  ${ch.name}`,
        subtitle: ch.group,
        options: [
          { label: 'Watch', icon: 'play-circle-outline', onSelect: () => playChannel(ch.id, { groupId: group.id, fullscreen: true }) },
          {
            label: isFav ? 'Remove from favorites' : 'Add to favorites',
            icon: isFav ? 'star-off-outline' : 'star-outline',
            onSelect: () => {
              if (!pid) return;
              toggleFavorite(pid, ch.id);
              showToast(isFav ? 'Removed from favorites' : 'Added to favorites');
            },
          },
          ...(p ? [{ label: 'Programme info', detail: p.title, icon: 'information-outline', onSelect: () => programSheet(ch, p) }] : []),
          ...(p && canCatchup(ch, p)
            ? [{ label: 'Watch from the start', detail: p.title, icon: 'history', onSelect: () => playCatchup(ch.id, p) }]
            : []),
        ],
      });
    },
    [favSet, epg, openSheet, playChannel, group?.id, pid, toggleFavorite, showToast, programSheet, playCatchup]
  );

  const activate = useCallback(
    (idx: number, cell?: Cell) => {
      const ch = channels[idx];
      if (!ch) return;
      const t = Date.now();
      const p = cell?.program;
      if (p && p.end <= t) {
        if (canCatchup(ch, p, t)) playCatchup(ch.id, p);
        else programSheet(ch, p);
        return;
      }
      if (p && p.start > t) {
        programSheet(ch, p);
        return;
      }
      const pl = usePlayer.getState();
      if (pl.item?.kind === 'live' && pl.item.channelId === ch.id) {
        pl.setFullscreen(true);
        return;
      }
      playChannel(ch.id, { groupId: group.id, fullscreen: !prefs.previewInGuide });
    },
    [channels, playCatchup, programSheet, playChannel, group?.id, prefs.previewInGuide]
  );

  // ---- key navigation ----
  const moveRow = (delta: number, animated: boolean) => {
    if (!channels.length) return;
    const r = Math.max(0, Math.min(channels.length - 1, row + delta));
    setRow(r);
    ensureVisible(r, animated);
  };

  const moveHorizontal = (dir: 1 | -1) => {
    const ch = channels[row];
    if (!ch) return;
    const list = epg[ch.id];
    const t = Date.now();
    const cell = cellAt(list, focusTime);
    let target: Cell;
    if (dir > 0) {
      target = cellAt(list, cell.end);
      if (target.start > t + prefs.epgFutureDays * DAY) return;
    } else {
      target = cellAt(list, cell.start - 1);
      const inPast = cell.start <= t;
      const minT = ch.catchup ? t - Math.min(ch.catchup.days, prefs.epgPastDays) * DAY : Infinity;
      if (inPast && target.start < minT) {
        setZone('channels');
        return;
      }
    }
    // Only scroll the timeline when the target is fully out of view
    let ws = windowStart;
    if (target.end <= ws) ws = Math.max(align(target.start), align(target.end - HALF));
    else if (target.start >= ws + W - HALF) ws = align(target.start) - HALF;
    setWindowStart(ws);
    const live = target.start <= t && target.end > t;
    setFocusTime(live ? Math.max(t, ws) : Math.max(target.start, ws));
  };

  const resetToNow = () => {
    const t = Date.now();
    setWindowStart(nowWindow(t));
    setFocusTime(t);
  };

  const onDigit = (d: number) => {
    const next = (digits + d).slice(-4);
    setDigits(next);
    if (digitTimer.current) clearTimeout(digitTimer.current);
    digitTimer.current = setTimeout(() => {
      setDigits('');
      const n = Number(next);
      const idx = channels.findIndex((c) => c.num === n);
      if (idx >= 0) {
        setZone('grid');
        setRow(idx);
        resetToNow();
        ensureVisible(idx, false, true);
      } else {
        const ch = useLibrary.getState().channels.find((c) => c.num === n);
        if (ch) playChannel(ch.id, { groupId: ALL, fullscreen: true });
        else showToast(`No channel ${n}`);
      }
    }, 1300);
  };

  const onKey = (e: KeyEvt): boolean | void => {
    if (e.key === 'digit' && e.digit !== undefined) return onDigit(e.digit);
    if (zone === 'groups') {
      const n = groups.length;
      switch (e.key) {
        case 'up':
          return setGroupIndex((i) => Math.max(0, i - 1));
        case 'down':
          return setGroupIndex((i) => Math.min(n - 1, i + 1));
        case 'chup':
          return setGroupIndex((i) => Math.max(0, i - 8));
        case 'chdown':
          return setGroupIndex((i) => Math.min(n - 1, i + 8));
        case 'select':
          if (e.long) return groupSheet(groups[groupIndex]);
          return enterChannels();
        case 'menu':
          return groupSheet(groups[groupIndex]);
        case 'right':
          return enterChannels();
        case 'back':
          return false; // on to the menu
        case 'left':
          return false;
        default:
          return;
      }
    }
    const ch = channels[row];
    const visible = Math.max(1, Math.floor(listH.current / rowH));
    switch (e.key) {
      case 'up':
        return moveRow(-1, e.repeat === 0);
      case 'down':
        return moveRow(1, e.repeat === 0);
      case 'chup':
        return moveRow(-visible, true);
      case 'chdown':
        return moveRow(visible, true);
      case 'left':
        if (zone === 'channels') {
          if (!tv) return false;
          return setZone('groups');
        }
        return moveHorizontal(-1);
      case 'right':
        if (zone === 'channels') {
          setZone('grid');
          return resetToNow();
        }
        return moveHorizontal(1);
      case 'select': {
        if (!ch) return;
        const cell = zone === 'grid' ? cellAt(epg[ch.id], focusTime) : undefined;
        if (e.long) return channelSheet(ch, cell?.program);
        return activate(row, cell);
      }
      case 'menu':
        if (ch) channelSheet(ch, zone === 'grid' ? cellAt(epg[ch.id], focusTime).program : undefined);
        return;
      case 'back': {
        const t = Date.now();
        const cell = ch ? cellAt(epg[ch.id], focusTime) : undefined;
        const atNow = windowStart === nowWindow(t) && (!cell || (cell.start <= t && cell.end > t));
        if (zone === 'grid' && !atNow) return resetToNow();
        // TV: Back walks outward one column at a time — grid → channels → categories → menu
        if (tv && zone === 'grid') return setZone('channels');
        if (tv && zone === 'channels') return setZone('groups');
        return false;
      }
      default:
        return false;
    }
  };

  const groupSheet = (g: (typeof groups)[number]) => {
    if (!g || g.virtual || !pid) return;
    openSheet({
      title: g.name,
      subtitle: `${g.channelIds.length} channels`,
      options: [{ label: 'Hide this group', icon: 'eye-off-outline', onSelect: () => toggleHiddenGroup(pid, g.id) }],
    });
  };

  useKeys(onKey, !menuFocused && !fullscreen, Layer.screen);

  // ---- touch: horizontal drag scrubs the timeline ----
  const dragStart = useRef(0);
  const pxRef = useRef(px);
  pxRef.current = px;
  const wsRef = useRef(windowStart);
  wsRef.current = windowStart;
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
        onPanResponderGrant: () => {
          dragStart.current = wsRef.current;
        },
        onPanResponderMove: (_e, g) => {
          const ws = dragStart.current - g.dx / pxRef.current;
          setWindowStart(Math.round(ws / 60000) * 60000);
        },
        onPanResponderRelease: () => {
          setWindowStart((ws) => Math.round(ws / (5 * 60000)) * 5 * 60000);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    []
  );

  // ---- xtream: fetch per-channel guide for visible rows when there's no XMLTV ----
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const lib = useLibrary.getState();
    if (lib.epgStatus === 'loading') return;
    for (const v of viewableItems) {
      const ch = v.item as Channel;
      if (!lib.epg[ch.id]) lib.loadShortEpg(ch.id);
    }
  }).current;
  const viewConfig = useRef({ itemVisiblePercentThreshold: 20, minimumViewTime: 400 }).current;

  // ---- pointer handlers ----
  const onPressChannel = useCallback(
    (idx: number) => {
      setRow(idx);
      setZone('channels');
      activate(idx);
    },
    [activate]
  );
  const onLongPressChannel = useCallback(
    (idx: number) => {
      const ch = channels[idx];
      if (ch) channelSheet(ch);
    },
    [channels, channelSheet]
  );
  const focusRef = useRef({ row, focusTime, zone });
  focusRef.current = { row, focusTime, zone };
  const onPressCell = useCallback(
    (idx: number, cell: Cell) => {
      const t = Date.now();
      const f = focusRef.current;
      const same = f.zone === 'grid' && f.row === idx && cellAt(epg[channels[idx]?.id], f.focusTime).start === cell.start;
      setRow(idx);
      setZone('grid');
      setFocusTime(Math.max(cell.start, wsRef.current));
      const live = cell.start <= t && cell.end > t;
      if (live || same) activate(idx, cell);
      else if (!tv && cell.program) programSheet(channels[idx], cell.program);
    },
    [activate, epg, channels, tv, programSheet]
  );

  const renderItem = useCallback(
    ({ item: ch, index }: { item: Channel; index: number }) => (
      <GuideRow
        index={index}
        channel={ch}
        programs={epg[ch.id]}
        windowStart={windowStart}
        windowEnd={windowEnd}
        now={now}
        focusMode={index === row && zone !== 'groups' ? (zone === 'channels' ? 'channel' : 'cell') : 'none'}
        focusTime={index === row ? focusTime : 0}
        playing={ch.id === playingId}
        favorite={favSet.has(ch.id)}
        showNumber={prefs.showChannelNumbers}
        h24={prefs.clock24}
        m={m}
        onPressChannel={onPressChannel}
        onLongPressChannel={onLongPressChannel}
        onPressCell={onPressCell}
      />
    ),
    [epg, windowStart, windowEnd, now, row, zone, focusTime, playingId, favSet, prefs.showChannelNumbers, prefs.clock24, m, onPressChannel, onLongPressChannel, onPressCell]
  );

  // ---- hero content ----
  const heroChannel = channels[row];
  const heroList = heroChannel ? epg[heroChannel.id] : undefined;
  const heroProgram = heroChannel ? (zone === 'grid' ? cellAt(heroList, focusTime).program : programAt(heroList, now)) : undefined;
  const heroNext = heroProgram ? nextProgram(heroList, heroProgram.end - 1) : undefined;

  // ---- timeline ticks ----
  const ticks: number[] = [];
  for (let t = align(windowStart); t < windowEnd; t += HALF) if (t >= windowStart - 1) ticks.push(t);
  const nowX = (now - windowStart) * px;

  const previewActive = !!item && !fullscreen;
  const showCompactPreview = !tv && !!item && item.kind === 'live';

  return (
    <View style={{ flex: 1 }} onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
      {tv ? (
        <Hero
          channel={heroChannel}
          program={heroProgram}
          next={heroNext}
          now={now}
          h24={prefs.clock24}
          height={heroH}
          s={s}
          showPreview={prefs.previewInGuide}
          previewActive={previewActive}
        />
      ) : (
        <>
          {showCompactPreview ? (
            <View style={{ width: boxW, height: (boxW * 9) / 16 }}>
              <PreviewSlot width={boxW} height={(boxW * 9) / 16} active={previewActive} s={(n) => n} />
            </View>
          ) : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
            {groups.map((g) => (
              <Chip
                key={g.id}
                label={g.name}
                icon={g.id === 'fav' ? 'star' : undefined}
                selected={g.id === group?.id}
                onPress={() => chooseGroup(g.id)}
              />
            ))}
          </ScrollView>
        </>
      )}

      <View style={{ flex: 1, flexDirection: 'row', paddingHorizontal: sidePad }}>
      {tv ? (
        <CategoryColumn
          groups={groups}
          index={groupIndex}
          activeId={group?.id}
          focused={zone === 'groups'}
          width={catW}
          headerH={headerH}
          s={s}
          onPick={(id) => chooseGroup(id)}
          onLongPick={(g) => groupSheet(g)}
          style={{ marginRight: catGap }}
        />
      ) : null}
      <View style={{ flex: 1 }}>
      {/* timeline header */}
      <View style={{ height: headerH, flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: chanW + s(2), flexDirection: 'row', alignItems: 'center', paddingLeft: tv ? s(6) : 8 }}>
          <Text numberOfLines={1} style={{ color: colors.text, fontSize: tv ? s(12.5) : 13, fontWeight: '800', flexShrink: 1, fontFamily: fonts.regular }}>
            {tv ? group?.name : formatDay(windowStart, now)}
          </Text>
          {tv ? (
            <Text style={{ color: colors.muted, fontSize: s(11), fontWeight: '700', marginLeft: s(6), fontFamily: fonts.regular, fontVariant: ['tabular-nums'] }}>{channels.length}</Text>
          ) : null}
        </View>
        <View style={{ width: gridW, height: headerH, overflow: 'hidden' }}>
          {ticks.map((t) => (
            <View key={t} style={{ position: 'absolute', left: (t - windowStart) * px, top: 0, bottom: 0, justifyContent: 'center', paddingLeft: s(5), borderLeftWidth: 1, borderColor: colors.border }}>
              <Text style={{ color: colors.textDim, fontSize: tv ? s(11) : 12, fontWeight: '600', fontFamily: fonts.regular, fontVariant: ['tabular-nums'] }}>
                {formatClock(t, prefs.clock24)}
                {new Date(t).getHours() === 0 && new Date(t).getMinutes() === 0 ? `  ${formatDay(t, now)}` : ''}
              </Text>
            </View>
          ))}
          {!keyMode ? (
            <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: s(4), paddingRight: s(4), backgroundColor: colors.bg }}>
              <HeaderBtn icon="chevron-left" onPress={() => setWindowStart((w) => w - HALF)} s={s} tv={tv} />
              <HeaderBtn label="Now" onPress={resetToNow} s={s} tv={tv} />
              <HeaderBtn icon="chevron-right" onPress={() => setWindowStart((w) => w + HALF)} s={s} tv={tv} />
            </View>
          ) : null}
        </View>
      </View>

      {/* grid */}
      <View style={{ flex: 1 }} {...pan.panHandlers}>
        {channels.length ? (
          <FlatList
            ref={listRef}
            data={channels}
            keyExtractor={(c) => c.id}
            renderItem={renderItem}
            extraData={renderItem}
            getItemLayout={(_d, i) => ({ length: rowH, offset: rowH * i, index: i })}
            onLayout={(e) => (listH.current = e.nativeEvent.layout.height)}
            onScroll={(e) => (topRow.current = Math.round(e.nativeEvent.contentOffset.y / rowH))}
            scrollEventThrottle={32}
            initialNumToRender={14}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews={false}
            showsVerticalScrollIndicator={!tv}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={viewConfig}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="television-off" size={tv ? s(30) : 34} color={colors.muted} />
            <Text style={{ color: colors.textDim, fontSize: tv ? s(13) : 15, marginTop: 8 }}>No channels in this group</Text>
          </View>
        )}
        {nowX >= 0 && nowX <= gridW ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: chanW + s(2) + nowX, top: -headerH, bottom: 0, width: 2, backgroundColor: colors.live }}>
            <View style={{ position: 'absolute', top: 0, left: -4, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.live, borderWidth: 2, borderColor: colors.bg }} />
          </View>
        ) : null}
      </View>
      </View>
      </View>

      {epgStatus === 'loading' ? (
        <View pointerEvents="none" style={{ position: 'absolute', right: tv ? s(16) : 12, bottom: tv ? s(10) : 10, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface3, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.borderStrong }}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={{ color: colors.textDim, fontSize: tv ? s(11) : 12, marginLeft: 8 }}>{epgMessage ?? 'Updating guide…'}</Text>
        </View>
      ) : null}

      {digits ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: tv ? s(20) : 20, right: tv ? s(24) : 20, backgroundColor: colors.surface3, borderRadius: radius.lg, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: colors.borderStrong }}>
          <Text style={{ color: colors.text, fontSize: tv ? s(30) : 30, fontWeight: '800', letterSpacing: 2, fontVariant: ['tabular-nums'] }}>{digits}</Text>
        </View>
      ) : null}
    </View>
  );
}

function HeaderBtn({ icon, label, onPress, s, tv }: { icon?: string; label?: string; onPress: () => void; s: (n: number) => number; tv: boolean }) {
  return (
    <Pressable
      focusable={false}
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label ?? (icon === 'chevron-left' ? 'Earlier' : 'Later')}
      style={({ pressed }) => ({ height: tv ? s(20) : 26, minWidth: tv ? s(22) : 28, paddingHorizontal: label ? (tv ? s(8) : 10) : 0, borderRadius: radius.pill, backgroundColor: pressed ? colors.borderStrong : colors.surface3, alignItems: 'center', justifyContent: 'center' })}
    >
      {icon ? <Icon name={icon} size={tv ? s(14) : 16} color={colors.text} /> : <Text style={{ color: colors.text, fontSize: tv ? s(10) : 12, fontWeight: '700' }}>{label}</Text>}
    </Pressable>
  );
}

/** Always-visible category list on the left of the TV guide. */
function CategoryColumn({
  groups,
  index,
  activeId,
  focused,
  width,
  headerH,
  s,
  onPick,
  onLongPick,
  style,
}: {
  groups: ReturnType<typeof useAllGroups>;
  /** remote cursor; tracks the active group when the column isn't focused */
  index: number;
  activeId?: string;
  focused: boolean;
  width: number;
  headerH: number;
  s: (n: number) => number;
  onPick: (id: string) => void;
  onLongPick: (g: ReturnType<typeof useAllGroups>[number]) => void;
  style?: object;
}) {
  const ref = useRef<FlatList>(null);
  const listH = useRef(0);
  const itemH = s(34);
  useEffect(() => {
    const visible = Math.max(1, Math.floor(listH.current / itemH) || 8);
    ref.current?.scrollToOffset({ offset: Math.max(0, (index - Math.floor(visible / 2) + 1) * itemH), animated: true });
  }, [index, itemH]);

  return (
    <View style={[{ width }, style]}>
      <View style={{ height: headerH, justifyContent: 'center', paddingLeft: s(10) }}>
        <Text style={{ color: focused ? colors.text : colors.muted, fontSize: s(11), fontWeight: '800', letterSpacing: 1.1, fontFamily: fonts.regular }}>CATEGORIES</Text>
      </View>
      <View style={{ flex: 1, backgroundColor: colors.bgElevated, borderRadius: s(radius.md), borderWidth: 1, borderColor: focused ? colors.borderStrong : colors.border, overflow: 'hidden' }}>
        <FlatList
          ref={ref}
          data={groups}
          keyExtractor={(g) => g.id}
          onLayout={(e) => (listH.current = e.nativeEvent.layout.height)}
          getItemLayout={(_d, i) => ({ length: itemH, offset: itemH * i, index: i })}
          contentContainerStyle={{ paddingVertical: s(4) }}
          showsVerticalScrollIndicator={false}
          renderItem={({ item: g, index: i }) => {
            const active = g.id === activeId;
            return (
              <Focusable
                focused={focused && i === index}
                onPress={() => onPick(g.id)}
                onLongPress={() => onLongPick(g)}
                style={{ height: itemH - s(2), marginHorizontal: s(4), marginVertical: s(1), borderRadius: s(radius.sm), flexDirection: 'row', alignItems: 'center', paddingHorizontal: s(9), backgroundColor: active ? colors.accentSoft : 'transparent' }}
                focusStyle={{ backgroundColor: colors.focus }}
              >
                {({ focused: f }) => (
                  <>
                    {active && !f ? <View style={{ position: 'absolute', left: 0, top: s(8), bottom: s(8), width: s(3), borderRadius: 2, backgroundColor: colors.accent }} /> : null}
                    <Icon
                      name={g.id === 'fav' ? 'star' : g.id === 'recent' ? 'history' : g.id === ALL ? 'view-list' : 'folder-outline'}
                      size={s(13)}
                      color={f ? colors.focusText : g.id === 'fav' ? colors.star : active ? colors.accent : colors.muted}
                      style={{ marginRight: s(8) }}
                    />
                    <Text numberOfLines={1} style={{ flex: 1, color: f ? colors.focusText : active ? colors.text : colors.textDim, fontSize: s(12.5), fontWeight: active || f ? '700' : '600', fontFamily: fonts.regular }}>
                      {g.name}
                    </Text>
                    <Text style={{ color: f ? colors.focusDim : colors.muted, fontSize: s(11), marginLeft: s(6), fontFamily: fonts.regular, fontVariant: ['tabular-nums'] }}>{g.channelIds.length}</Text>
                  </>
                )}
              </Focusable>
            );
          }}
        />
      </View>
    </View>
  );
}
