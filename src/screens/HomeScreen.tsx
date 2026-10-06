import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Platform, Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Image } from 'expo-image';
import { colors, radius, useLayout } from '../theme';
import { useLibrary } from '../store/library';
import { useActivePlaylist, useSettings } from '../store/settings';
import { usePlayer } from '../store/player';
import { useUI, type MenuAnchor, type SheetOption } from '../store/ui';
import { hasWatched, openSearch, removeFromHistory, type Watched } from '../store/actions';
import { Layer, useInputMode, useKeyMode, useKeys } from '../input/keys';
import { continueSeries, episodeKey, loadMovieInfo, movieKey, playMovie, resumeEpisode } from '../services/vod';
import { imageUrl } from '../services/http';
import { formatDuration } from '../utils/format';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { NovaMark } from '../components/NovaMark';
import { LoadingScreen } from '../components/LoadingScreen';
import { useHomeRows, type HomeEntry, type HomeFilter, type HomeRow } from './home/rows';
import { AmbientWash, Billboard, BillboardArt, FeaturedCard, FILTERS, TopBar, useHero, type HeroAction } from './home/Billboard';
import { Rail, type RailMetrics } from './home/Rail';

type Zone = 'tabs' | 'hero' | 'rows';

/** Titles the spotlight takes turns with, and how long each one stays */
const SPOTLIGHT_MAX = 6;
const SPOTLIGHT_MS = 9000;

/**
 * Home, the start page, in the style of the streaming apps: movies and series only (live channels live in
 * the guide). TV and desktop: a full-width billboard — first a spotlight taking turns with a few titles,
 * then, once the remote is in the rows, the focused title — above Continue watching, My List and the
 * categories. Phones: a featured title card over its own colours, then the same rows.
 */
export function HomeScreen() {
  const { s, mode, width, height } = useLayout();
  const tv = mode === 'tv';
  const [filter, setFilter] = useState<HomeFilter>('all');
  const { rows, catsKnown } = useHomeRows(tv ? filter : 'all');
  const showFilter = useLibrary((st) => !!st.movieCats?.length && !!st.seriesCats?.length);
  const catalogStatus = useLibrary((st) => st.catalogStatus);
  const pid = useLibrary((st) => st.playlistId);
  const favs = useSettings((st) => (pid ? st.vodFavorites[pid] : undefined));
  const history = useSettings((st) => (pid ? st.history[pid] : undefined));
  const menuFocused = useUI((st) => st.menuFocused);
  const detailOpen = useUI((st) => !!st.detail);
  const sheetOpen = useUI((st) => !!st.sheet);
  const editorOpen = useUI((st) => !!st.editor);
  const fullscreen = usePlayer((st) => st.fullscreen && !!st.item);

  // ---- metrics ----
  const [box, setBox] = useState({ w: width - (tv ? s(64) : 0), h: height });
  const m: RailMetrics = useMemo(() => {
    const k = tv ? s : (n: number) => n;
    const posterW = tv ? s(84) : 112;
    const artH = (posterW - (tv ? s(5) : 4)) * 1.5 + (tv ? s(5) : 4);
    const gap = k(tv ? 12 : 10);
    const wideW = posterW * 2 + gap;
    const wideH = Math.round((wideW * 9) / 16);
    const titleH = k(tv ? 26 : 30);
    const padY = k(tv ? 9 : 8);
    const row = (h: number) => Math.round(titleH + padY * 2 + h);
    return { tv, s, posterW, artH, wideW, wideH, gap, padX: k(tv ? 28 : 16), padY, titleH, rowH: row(artH), wideRowH: row(wideH), viewW: box.w };
  }, [tv, s, box.w]);
  const rowHeight = useCallback((r: HomeRow) => (r.wide ? m.wideRowH : m.rowH), [m]);

  // ---- focus: the spotlight, or a row (kept by key, so rows loading around it don't move it) and a card per row ----
  const [zone, setZone] = useState<Zone>(tv ? 'hero' : 'rows');
  const [focusKey, setFocusKey] = useState<string>();
  const [cols, setCols] = useState<Record<string, number>>({});
  const [heroBtn, setHeroBtn] = useState(0);
  const [tab, setTab] = useState(0);
  const [hover, setHover] = useState<{ row: string; col: number } | null>(null);
  const lastRow = useRef(0);
  let rowIdx = focusKey ? rows.findIndex((r) => r.key === focusKey) : -1;
  if (rowIdx < 0) rowIdx = Math.max(0, Math.min(lastRow.current, rows.length - 1));
  lastRow.current = rowIdx;
  const row = rows[rowIdx] as HomeRow | undefined;
  const col = row ? Math.max(0, Math.min(cols[row.key] ?? 0, row.entries.length - 1)) : 0;
  const focused = row?.entries[col];

  // Desktop: the billboard follows the pointer until a key is pressed
  const keyMode = useKeyMode();
  // the rows have been scrolled down (by a mouse; the remote moves `zone` instead)
  const [scrolled, setScrolled] = useState(false);
  // TV and desktop: the spotlight is showing — at the top of Home, before the remote goes into the rows
  const atTop = tv && (keyMode ? zone !== 'rows' : !scrolled);
  const hovered = hover ? rows.find((r) => r.key === hover.row)?.entries[hover.col] : undefined;

  // Phones: one featured title, from the first category (a different one each day)
  const featured = useMemo(() => {
    if (tv) return undefined;
    const pool = (rows.find((r) => r.categoryId && r.entries.length)?.entries ?? []).filter((e) => e.type !== 'more' && e.item.poster).slice(0, 10);
    if (pool.length) return pool[Math.floor(Date.now() / 86400000) % pool.length];
    return rows.find((r) => r.entries.length)?.entries.find((e) => e.type !== 'more');
  }, [rows, tv]);

  // TV and desktop: a few titles from the first categories take turns in the spotlight
  const spotlight = useMemo(() => {
    if (!tv) return [];
    const cats = rows.filter((r) => r.categoryId).slice(0, 4);
    const out: Extract<HomeEntry, { type: 'movie' | 'series' }>[] = [];
    for (let i = 0; i < 3; i++)
      for (const r of cats) {
        const e = r.entries.filter((x) => x.type !== 'more' && x.item.poster)[i];
        if (e && e.type !== 'more' && out.length < SPOTLIGHT_MAX && !out.some((o) => o.item.id === e.item.id)) out.push(e);
      }
    return out;
  }, [rows, tv]);
  const [slide, setSlide] = useState(() => Math.floor(Date.now() / 86400000));
  const spot = spotlight.length ? spotlight[slide % spotlight.length] : undefined;

  const shown = tv ? (hovered ?? (atTop || !keyMode ? (spot ?? focused) : focused)) : featured;
  const hero = useHero(shown);

  // ---- actions ----
  const play = useCallback((e: HomeEntry) => {
    if (e.type === 'more') return useUI.getState().openCategory(e.kind, e.categoryId);
    if (e.type === 'movie') return playMovie(e.item);
    void continueSeries(e.item, e.episode);
  }, []);

  const open = useCallback(
    (r: HomeRow, e: HomeEntry) => {
      if (e.type === 'more') return useUI.getState().openCategory(e.kind, e.categoryId);
      if (r.resume) return play(e);
      useUI.getState().setDetail(e.type === 'movie' ? { kind: 'movie', item: e.item } : { kind: 'series', item: e.item });
    },
    [play]
  );

  const toggleList = useCallback(
    (e: Extract<HomeEntry, { type: 'movie' | 'series' }>) => {
      if (!pid) return;
      useSettings.getState().toggleVodFavorite(pid, e.type === 'movie' ? { kind: 'movie', item: e.item } : { kind: 'series', item: e.item });
    },
    [pid]
  );

  const openOptions = useCallback(
    (e: HomeEntry | undefined, anchor?: MenuAnchor) => {
      if (!e || e.type === 'more' || !pid) return;
      const ui = useUI.getState();
      const st = useSettings.getState();
      const inList = (st.vodFavorites[pid] ?? []).some((f) => f.item.id === e.item.id);
      const list: SheetOption = { label: inList ? 'Remove from My List' : 'Add to My List', icon: inList ? 'playlist-remove' : 'playlist-plus', onSelect: () => toggleList(e) };
      const watched: Watched = e.type === 'movie' ? { kind: 'movie', item: e.item } : { kind: 'series', item: e.item };
      const remove: SheetOption[] = e.historyId || hasWatched(watched) ? [{ label: 'Remove from history', icon: 'delete-clock-outline', onSelect: () => void removeFromHistory(watched) }] : [];
      if (e.type === 'movie') {
        const key = movieKey(e.item);
        const pr = st.vodProgress[key];
        const resume = pr && pr.pos > 0;
        return ui.openSheet({
          anchor,
          title: e.item.name,
          subtitle: e.item.year,
          options: [
            { label: resume ? `Resume ${formatDuration(pr.pos)}` : 'Play', icon: 'play', onSelect: () => playMovie(e.item) },
            ...(resume ? [{ label: 'Play from the beginning', icon: 'restart', onSelect: () => playMovie(e.item, true) }] : []),
            { label: 'Movie details', icon: 'information-outline', onSelect: () => ui.setDetail({ kind: 'movie', item: e.item }) },
            list,
            pr?.done
              ? { label: 'Mark as unwatched', icon: 'check-circle-outline', onSelect: () => st.setWatched(key, false) }
              : { label: 'Mark as watched', icon: 'check-circle', onSelect: () => st.setWatched(key, true) },
            ...remove,
          ],
        });
      }
      const ep = e.episode;
      const pr = ep ? st.vodProgress[episodeKey(ep)] : undefined;
      const resume = pr && pr.pos > 0;
      return ui.openSheet({
        anchor,
        title: e.item.name,
        subtitle: ep ? `S${ep.season} E${ep.episode} · ${ep.title}` : e.item.year,
        options: [
          { label: resume ? `Resume ${formatDuration(pr.pos)}` : pr?.done ? 'Play next episode' : 'Play', icon: 'play', onSelect: () => play(e) },
          ...(ep ? [{ label: `Play S${ep.season} E${ep.episode} from the beginning`, icon: 'restart', onSelect: () => void resumeEpisode(e.item, ep, true) }] : []),
          { label: 'Episodes', icon: 'format-list-bulleted', onSelect: () => ui.setDetail({ kind: 'series', item: e.item }) },
          list,
          ...remove,
        ],
      });
    },
    [pid, play, toggleList]
  );

  // Billboard buttons for the title it shows
  const shownKey = shown?.type === 'movie' ? movieKey(shown.item) : shown?.type === 'series' && shown.episode ? episodeKey(shown.episode) : undefined;
  const shownProgress = useSettings((st) => (shownKey ? st.vodProgress[shownKey] : undefined));
  const actions: HeroAction[] = useMemo(() => {
    const e = shown;
    if (!e) return [];
    if (e.type === 'more') return [{ id: 'all', label: 'See all', icon: 'view-grid-outline', primary: true, run: () => play(e) }];
    const inList = (favs ?? []).some((f) => f.item.id === e.item.id);
    const started = e.type === 'movie' ? !!shownProgress && shownProgress.pos > 0 : !!e.episode || !!history?.some((h) => h.kind === 'episode' && h.series.id === e.item.id);
    const out: HeroAction[] = [
      { id: 'play', label: e.type === 'movie' ? (started ? 'Resume' : 'Play') : started ? 'Continue' : 'Play', icon: 'play', primary: true, run: () => play(e) },
      {
        id: 'info',
        label: e.type === 'movie' ? 'More info' : 'Episodes',
        icon: e.type === 'movie' ? 'information-outline' : 'format-list-bulleted',
        run: () => useUI.getState().setDetail(e.type === 'movie' ? { kind: 'movie', item: e.item } : { kind: 'series', item: e.item }),
      },
      { id: 'list', label: 'My List', icon: inList ? 'check' : 'plus', run: () => toggleList(e) },
    ];
    // phones put Play in the middle, like the Netflix app
    return tv ? out : [out[2], out[0], { ...out[1], label: e.type === 'movie' ? 'Info' : 'Episodes' }];
  }, [shown, favs, history, shownProgress, play, toggleList, tv]);

  // ---- filter: All / Movies / Series ----
  const applyFilter = (f: HomeFilter) => {
    if (f === filter) return;
    setFilter(f);
    setFocusKey(undefined);
    setCols({});
    setHover(null);
    lastRow.current = 0;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  };

  // ---- remote ----
  const focusRow = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (r) setFocusKey(r.key);
  };
  const setCol = (r: HomeRow, c: number) => setCols((p) => ({ ...p, [r.key]: Math.max(0, Math.min(r.entries.length - 1, c)) }));

  const keysEnabled = !menuFocused && !detailOpen && !sheetOpen && !editorOpen && !fullscreen && rows.length > 0;
  useKeys(
    (e) => {
      if (hover) setHover(null);
      if (zone === 'tabs') {
        switch (e.key) {
          case 'left':
            return tab > 0 ? setTab(tab - 1) : false;
          case 'right':
            return setTab(Math.min(FILTERS.length - 1, tab + 1));
          case 'select':
            return applyFilter(FILTERS[tab].id);
          case 'down':
          case 'back':
            return setZone('hero');
          case 'up':
            return;
          default:
            return false;
        }
      }
      if (zone === 'hero') {
        switch (e.key) {
          case 'left':
            return heroBtn > 0 ? setHeroBtn(heroBtn - 1) : false;
          case 'right':
            return setHeroBtn(Math.min(actions.length - 1, heroBtn + 1));
          case 'down':
            return setZone('rows');
          case 'select':
            return actions[heroBtn]?.run();
          case 'menu':
            return openOptions(shown);
          case 'playpause':
            return shown ? play(shown) : undefined;
          case 'chup':
            return setSlide((i) => i - 1 + spotlight.length);
          case 'chdown':
            return setSlide((i) => i + 1);
          case 'up':
            if (!showFilter) return;
            setTab(FILTERS.findIndex((f) => f.id === filter));
            return setZone('tabs');
          default:
            return false;
        }
      }
      if (!row) return false;
      switch (e.key) {
        case 'up':
          if (rowIdx > 0) return focusRow(rowIdx - 1);
          if (!tv) return;
          setHeroBtn(0);
          return setZone('hero');
        case 'down':
          return focusRow(rowIdx + 1);
        case 'left':
          return col > 0 ? setCol(row, col - 1) : false; // on to the menu
        case 'right':
          return setCol(row, col + 1);
        case 'chup':
          return focusRow(rowIdx - 3);
        case 'chdown':
          return focusRow(rowIdx + 3);
        case 'select':
          if (!focused) return;
          return e.long ? openOptions(focused) : open(row, focused);
        case 'menu':
          return openOptions(focused);
        case 'playpause':
          return focused ? play(focused) : undefined;
        case 'back':
          // back to the top first (TV: the spotlight), then to the menu
          if (!tv && rowIdx === 0 && col === 0) return false;
          setCol(row, 0);
          focusRow(0);
          if (!tv) return;
          setHeroBtn(0);
          return setZone('hero');
        default:
          return false;
      }
    },
    keysEnabled,
    Layer.screen
  );

  // ---- the spotlight: the next title every few seconds while it's on screen and no card is pointed at ----
  const spotlightOn = atTop && !hover && keysEnabled && spotlight.length > 1;
  useEffect(() => {
    if (!spotlightOn) return;
    const t = setTimeout(() => setSlide((i) => i + 1), SPOTLIGHT_MS);
    return () => clearTimeout(t);
  }, [spotlightOn, slide, heroBtn]);
  // the next title's details and artwork, so it arrives complete
  useEffect(() => {
    if (!spotlightOn) return;
    const next = spotlight[(slide + 1) % spotlight.length];
    const prefetch = (uri?: string) => {
      const url = uri && imageUrl(uri);
      if (url) Image.prefetch(url).catch(() => {});
    };
    if (next.type === 'series') prefetch(next.item.backdrop);
    else
      loadMovieInfo(next.item).then(
        (info) => prefetch(info?.backdrop),
        () => {}
      );
  }, [spotlightOn, slide, spotlight]);

  // ---- rows: where each one starts ----
  const offsets = useMemo(() => {
    const out = [0];
    for (const r of rows) out.push(out[out.length - 1] + rowHeight(r));
    return out;
  }, [rows, rowHeight]);

  // ---- the billboard: tall for the spotlight, shorter once in the rows; it always stays on screen ----
  const compactH = Math.round(Math.max(s(200), Math.min(s(300), box.h - m.rowH * 1.25)));
  // under the spotlight, the first row shows whole and the next one peeks out
  const firstRow = rows[0] ? rowHeight(rows[0]) : m.rowH;
  const expandedH = Math.round(Math.max(compactH, Math.min(box.h * 0.64, box.h - firstRow - m.titleH - m.padY - m.artH * 0.3)));
  const expanded = atTop;
  const heroH = expanded ? expandedH : compactH;
  const heroAnim = useRef(new Animated.Value(heroH)).current;
  const sized = useRef(false);
  useEffect(() => {
    // the first size is set, not animated
    if (!sized.current) {
      heroAnim.setValue(heroH);
      sized.current = rows.length > 0;
      return;
    }
    Animated.timing(heroAnim, { toValue: heroH, duration: 320, useNativeDriver: false }).start();
  }, [heroH, heroAnim, rows.length]);
  const artH = useMemo(() => Animated.add(heroAnim, s(56)), [heroAnim, s]);

  // ---- scrolling: the focused row sits right under the billboard ----
  const listRef = useRef<FlatList<HomeRow>>(null);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    setScrolled((was) => (was ? y > 0 : y > 12));
  }, []);
  // Web: the mouse wheel scrolls the rows wherever the pointer is, the billboard included
  const rootRef = useRef<View>(null);
  const ready = rows.length > 0;
  useEffect(() => {
    if (Platform.OS !== 'web' || !tv || !ready) return;
    const root = rootRef.current as unknown as HTMLElement | null;
    if (!root?.addEventListener) return;
    const onWheel = (e: WheelEvent) => {
      const list = (listRef.current as unknown as { getScrollableNode?: () => HTMLElement } | null)?.getScrollableNode?.();
      if (!list || list.contains(e.target as Node) || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      list.scrollTop += e.deltaY;
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [tv, ready]);
  const [headerH, setHeaderH] = useState(0);
  useEffect(() => {
    if (tv) listRef.current?.scrollToOffset({ offset: zone === 'rows' ? (offsets[rowIdx] ?? 0) : 0, animated: true });
    else if (keysEnabled) listRef.current?.scrollToOffset({ offset: Math.max(0, headerH + (offsets[rowIdx] ?? 0) - 8), animated: true });
    // only when the remote moves, not when the pointer scrolls the list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIdx, zone, m.rowH, tv]);

  // ---- pointer ----
  const handlers = useRef({ press: (_r: string, _c: number) => {}, menu: (_r: string, _c: number, _a?: MenuAnchor) => {} });
  handlers.current = {
    press: (rk, c) => {
      const r = rows.find((x) => x.key === rk);
      const e = r?.entries[c];
      if (!r || !e) return;
      // the zone stays, so the billboard doesn't resize under the pointer
      setFocusKey(rk);
      setCol(r, c);
      open(r, e);
    },
    menu: (rk, c, anchor) => openOptions(rows.find((x) => x.key === rk)?.entries[c], anchor),
  };
  const onPress = useCallback((rk: string, c: number) => handlers.current.press(rk, c), []);
  const onMenu = useCallback((rk: string, c: number, a?: MenuAnchor) => handlers.current.menu(rk, c, a), []);
  const onHover = useCallback((rk: string, c: number) => {
    // rows sliding under a resting pointer while the remote/keyboard drives shouldn't take the billboard
    if (useInputMode.getState().mode !== 'pointer') return;
    setHover((h) => (h?.row === rk && h.col === c ? h : { row: rk, col: c }));
  }, []);

  const renderRow = useCallback(
    ({ item: r, index }: { item: HomeRow; index: number }) => (
      <Rail
        rowKey={r.key}
        title={r.title}
        kindLabel={r.kindLabel}
        kind={r.kind}
        categoryId={r.categoryId}
        entries={r.entries}
        loading={r.loading}
        wide={r.wide}
        focusCol={zone === 'rows' && index === rowIdx ? col : -1}
        active={zone === 'rows' && index === rowIdx}
        m={m}
        onPress={onPress}
        onMenu={onMenu}
        onHover={tv ? onHover : undefined}
      />
    ),
    [zone, rowIdx, col, m, tv, onPress, onMenu, onHover]
  );

  // ---- states before there's anything to show ----
  if (!rows.length) {
    if (!catsKnown || catalogStatus === 'loading' || catalogStatus === 'idle') return <LoadingScreen message="Loading movies and series…" />;
    return <EmptyHome enabled={!menuFocused && !detailOpen && !sheetOpen && !editorOpen && !fullscreen} />;
  }

  const list = (
    <FlatList
      ref={listRef}
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={renderRow}
      extraData={renderRow}
      getItemLayout={(d, i) => ({ length: d?.[i] ? rowHeight(d[i]) : m.rowH, offset: (tv ? 0 : headerH) + (offsets[i] ?? 0), index: i })}
      initialNumToRender={tv ? 3 : 4}
      maxToRenderPerBatch={3}
      windowSize={5}
      showsVerticalScrollIndicator={false}
      onScroll={tv ? onScroll : undefined}
      scrollEventThrottle={64}
      ListHeaderComponent={
        tv ? undefined : (
          <View onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)} style={{ paddingBottom: 12 }}>
            <AmbientWash uri={hero?.poster} height={headerH + 60} />
            <PhoneHeader />
            {hero ? <FeaturedCard hero={hero} actions={actions} /> : null}
          </View>
        )
      }
      // TV: room for the last row to come up under the billboard
      contentContainerStyle={{ paddingBottom: tv ? Math.max(0, box.h - compactH - (rows.length ? rowHeight(rows[rows.length - 1]) : 0)) : 24 }}
    />
  );

  return (
    <View ref={rootRef} style={{ flex: 1 }} onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {tv ? (
        <>
          <BillboardArt hero={hero} width={box.w} height={artH} heroH={heroH} />
          <Billboard
            hero={hero}
            actions={actions}
            focusedAction={zone === 'hero' ? heroBtn : -1}
            height={heroAnim}
            width={box.w}
            expanded={expanded}
            slides={atTop && !hover && spotlight.length > 1 ? { count: spotlight.length, index: slide % spotlight.length, onSelect: setSlide } : undefined}
          />
          {expanded ? <TopBar filter={filter} focusedTab={zone === 'tabs' ? tab : -1} showFilter={showFilter} onSelect={applyFilter} /> : null}
        </>
      ) : null}
      {list}
    </View>
  );
}

/** Phones: the Nova mark, the playlist, and search. */
function PhoneHeader() {
  const { type } = useLayout();
  const playlist = useActivePlaylist();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
      <NovaMark size={30} />
      <Text numberOfLines={1} style={[type('heading'), { color: colors.text, marginLeft: 10, flex: 1 }]}>
        {playlist?.name ?? 'Nova'}
      </Text>
      <Pressable
        focusable={false}
        onPress={openSearch}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Search"
        style={({ pressed }) => ({ width: 44, height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? colors.surface3 : colors.surface2 })}
      >
        <Icon name="magnify" size={24} color={colors.text} />
      </Pressable>
    </View>
  );
}

/** A playlist without movies or series (live channels only). */
function EmptyHome({ enabled }: { enabled: boolean }) {
  const { k, type } = useLayout();
  const setScreen = useUI((st) => st.setScreen);
  useKeys(
    (e) => {
      if (e.key === 'select') return setScreen('guide');
      if (e.key === 'up' || e.key === 'down' || e.key === 'right') return;
      return false;
    },
    enabled,
    Layer.screen
  );
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Icon name="movie-open-off-outline" size={k(40)} color={colors.muted} />
      <Text style={[type('heading'), { color: colors.text, marginTop: k(12), textAlign: 'center' }]}>No movies or series here yet</Text>
      <Text style={[type('body'), { color: colors.textDim, marginTop: k(6), textAlign: 'center', maxWidth: k(460) }]}>
        This playlist only has live channels. When your provider adds movies or series, they show up here.
      </Text>
      <View style={{ marginTop: k(20) }}>
        <Button label="Open Live TV" icon="television-classic" primary focused onPress={() => setScreen('guide')} />
      </View>
    </View>
  );
}
