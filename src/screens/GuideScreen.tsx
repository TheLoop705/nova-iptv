import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, PanResponder, Pressable, ScrollView, Text, View, type ViewToken } from 'react-native';
import type { Channel, Program } from '../types';
import { colors, useLayout } from '../theme';
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
/** Window start for "now": keep at least ~10 minutes of the past visible, like TiviMate */
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

  const W = (tv ? 120 : 90) * 60000;
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
  const heroH = tv ? s(206) : 0;
  const headerH = tv ? s(26) : 30;
  const rowH = tv ? s(44) : 58;
  const chanW = tv ? s(196) : 60;
  const sidePad = tv ? s(10) : 0;
  const gridW = Math.max(120, boxW - chanW - sidePad * 2 - s(2));
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

  // Keep the group panel cursor on the active group
  useEffect(() => {
    setGroupIndex(Math.max(0, groups.findIndex((g) => g.id === group?.id)));
  }, [groups, group?.id]);

  const chooseGroup = useCallback(
    (id: string) => {
      setGroupId(id);
      if (pid) setLastGroup(pid, id);
      setZone('grid');
    },
    [pid, setLastGroup]
  );

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
          return chooseGroup(groups[groupIndex].id);
        case 'menu':
          return groupSheet(groups[groupIndex]);
        case 'right':
        case 'back':
          return setZone('channels');
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
              <Pressable
                key={g.id}
                focusable={false}
                onPress={() => chooseGroup(g.id)}
                style={{
                  paddingHorizontal: 14,
                  height: 32,
                  borderRadius: 16,
                  justifyContent: 'center',
                  backgroundColor: g.id === group?.id ? colors.focus : colors.surface2,
                }}
              >
                <Text style={{ color: g.id === group?.id ? colors.focusText : colors.text, fontWeight: '600', fontSize: 13 }}>{g.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </>
      )}

      {/* timeline header */}
      <View style={{ height: headerH, flexDirection: 'row', alignItems: 'center', paddingHorizontal: sidePad }}>
        <Pressable
          focusable={false}
          onPress={() => (tv ? setZone(zone === 'groups' ? 'channels' : 'groups') : undefined)}
          style={{ width: chanW + s(2), flexDirection: 'row', alignItems: 'center', paddingLeft: tv ? s(6) : 8 }}
        >
          {tv ? <Icon name="menu" size={s(13)} color={colors.textDim} style={{ marginRight: s(6) }} /> : null}
          <Text numberOfLines={1} style={{ color: colors.text, fontSize: tv ? s(11.5) : 12, fontWeight: '700', flex: 1 }}>
            {tv ? group?.name : formatDay(windowStart, now)}
          </Text>
        </Pressable>
        <View style={{ width: gridW, height: headerH, overflow: 'hidden' }}>
          {ticks.map((t) => (
            <View key={t} style={{ position: 'absolute', left: (t - windowStart) * px, top: 0, bottom: 0, justifyContent: 'center', paddingLeft: s(5), borderLeftWidth: 1, borderColor: colors.border }}>
              <Text style={{ color: colors.textDim, fontSize: tv ? s(10.5) : 11, fontWeight: '600' }}>
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
      <View style={{ flex: 1, paddingHorizontal: sidePad }} {...pan.panHandlers}>
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
            <Text style={{ color: colors.muted, fontSize: tv ? s(13) : 14 }}>No channels in this group</Text>
          </View>
        )}
        {nowX >= 0 && nowX <= gridW ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: sidePad + chanW + s(2) + nowX, top: -headerH, bottom: 0, width: 2, backgroundColor: colors.live, opacity: 0.9 }}>
            <View style={{ position: 'absolute', top: 0, left: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.live }} />
          </View>
        ) : null}
      </View>

      {epgStatus === 'loading' ? (
        <View pointerEvents="none" style={{ position: 'absolute', right: tv ? s(16) : 12, bottom: tv ? s(10) : 10, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface3, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={{ color: colors.textDim, fontSize: tv ? s(10.5) : 12, marginLeft: 8 }}>{epgMessage ?? 'Updating guide…'}</Text>
        </View>
      ) : null}

      {tv && zone === 'groups' ? (
        <GroupPanel
          groups={groups}
          index={groupIndex}
          activeId={group?.id}
          top={heroH}
          s={s}
          onPick={(id) => chooseGroup(id)}
          onClose={() => setZone('channels')}
        />
      ) : null}

      {digits ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: tv ? s(20) : 20, right: tv ? s(24) : 20, backgroundColor: colors.surface3, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10, borderWidth: 1, borderColor: colors.border }}>
          <Text style={{ color: colors.text, fontSize: tv ? s(28) : 28, fontWeight: '800', letterSpacing: 2 }}>{digits}</Text>
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
      style={{ height: tv ? s(20) : 24, minWidth: tv ? s(22) : 26, paddingHorizontal: label ? (tv ? s(8) : 10) : 0, borderRadius: 999, backgroundColor: colors.surface3, alignItems: 'center', justifyContent: 'center' }}
    >
      {icon ? <Icon name={icon} size={tv ? s(14) : 16} color={colors.text} /> : <Text style={{ color: colors.text, fontSize: tv ? s(10) : 12, fontWeight: '700' }}>{label}</Text>}
    </Pressable>
  );
}

function GroupPanel({
  groups,
  index,
  activeId,
  top,
  s,
  onPick,
  onClose,
}: {
  groups: ReturnType<typeof useAllGroups>;
  index: number;
  activeId?: string;
  top: number;
  s: (n: number) => number;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<FlatList>(null);
  const itemH = s(34);
  useEffect(() => {
    ref.current?.scrollToOffset({ offset: Math.max(0, (index - 3) * itemH), animated: true });
  }, [index, itemH]);
  return (
    <View style={{ position: 'absolute', left: 0, top, bottom: 0, width: s(270), backgroundColor: colors.bgElevated, borderRightWidth: 1, borderColor: colors.border, paddingTop: s(8) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: s(14), marginBottom: s(6) }}>
        <Text style={{ color: colors.muted, fontSize: s(10.5), fontWeight: '700', letterSpacing: 1, flex: 1 }}>GROUPS</Text>
        <Pressable focusable={false} onPress={onClose}>
          <Icon name="close" size={s(14)} color={colors.muted} />
        </Pressable>
      </View>
      <FlatList
        ref={ref}
        data={groups}
        keyExtractor={(g) => g.id}
        getItemLayout={(_d, i) => ({ length: itemH, offset: itemH * i, index: i })}
        renderItem={({ item: g, index: i }) => (
          <Focusable
            focused={i === index}
            alwaysShowFocus
            onPress={() => onPick(g.id)}
            style={{ height: itemH - s(2), marginHorizontal: s(8), borderRadius: s(6), flexDirection: 'row', alignItems: 'center', paddingHorizontal: s(10) }}
            focusStyle={{ backgroundColor: colors.focus }}
          >
            {({ focused }) => (
              <>
                <Icon
                  name={g.id === 'fav' ? 'star' : g.id === 'recent' ? 'history' : g.id === ALL ? 'view-list' : 'folder-outline'}
                  size={s(13)}
                  color={focused ? colors.focusText : g.id === activeId ? colors.accent : colors.muted}
                  style={{ marginRight: s(8) }}
                />
                <Text numberOfLines={1} style={{ flex: 1, color: focused ? colors.focusText : g.id === activeId ? colors.accent : colors.text, fontSize: s(12), fontWeight: '600' }}>
                  {g.name}
                </Text>
                <Text style={{ color: focused ? '#3A4252' : colors.muted, fontSize: s(10.5) }}>{g.channelIds.length}</Text>
              </>
            )}
          </Focusable>
        )}
      />
    </View>
  );
}
