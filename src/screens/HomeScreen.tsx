import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { colors, radius, useLayout } from '../theme';
import { useLibrary } from '../store/library';
import { useActivePlaylist, useSettings } from '../store/settings';
import { usePlayer } from '../store/player';
import { useUI, type MenuAnchor, type SheetOption } from '../store/ui';
import { openSearch } from '../store/actions';
import { Layer, useInputMode, useKeys } from '../input/keys';
import { continueSeries, episodeKey, movieKey, playMovie, playSeries, resumeEpisode } from '../services/vod';
import { formatDuration } from '../utils/format';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { NovaMark } from '../components/NovaMark';
import { LoadingScreen } from '../components/LoadingScreen';
import { useHomeRows, type HomeEntry, type HomeRow } from './home/rows';
import { Billboard, BillboardArt, FeaturedCard, useHero, type HeroAction } from './home/Billboard';
import { Rail, type RailMetrics } from './home/Rail';

type Zone = 'rows' | 'hero';

/**
 * Home, the start page, in the style of Netflix: movies and series only (live channels live in the guide).
 * TV and desktop: a billboard showing the focused title above rows of posters — Continue watching, My List,
 * then categories. Phones: a featured title card, then the same rows.
 */
export function HomeScreen() {
  const { s, mode, width, height } = useLayout();
  const tv = mode === 'tv';
  const { rows, catsKnown } = useHomeRows();
  const status = useLibrary((st) => st.status);
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
    const posterW = tv ? s(80) : 108;
    const artH = (posterW - (tv ? s(5) : 4)) * 1.5 + (tv ? s(5) : 4);
    // name + year under the poster
    const captionH = tv ? s(6 + 15 + 14) : 6 + 17 + 16;
    const titleH = k(tv ? 24 : 30);
    const padY = k(tv ? 8 : 6);
    return { tv, s, posterW, artH, gap: k(tv ? 12 : 10), padX: k(tv ? 28 : 16), padY, titleH, rowH: Math.round(titleH + padY * 2 + artH + captionH), viewW: box.w };
  }, [tv, s, box.w]);
  // TV: the billboard takes what's left once a row and a bit of the next are showing
  const heroH = Math.round(Math.max(s(200), Math.min(s(290), box.h - m.rowH * 1.3)));

  // ---- focus: a row (kept by key, so rows loading around it don't move it) and a card per row ----
  const [zone, setZone] = useState<Zone>('rows');
  const [focusKey, setFocusKey] = useState<string>();
  const [cols, setCols] = useState<Record<string, number>>({});
  const [heroBtn, setHeroBtn] = useState(0);
  const [hover, setHover] = useState<{ row: string; col: number } | null>(null);
  const lastRow = useRef(0);
  let rowIdx = focusKey ? rows.findIndex((r) => r.key === focusKey) : -1;
  if (rowIdx < 0) rowIdx = Math.max(0, Math.min(lastRow.current, rows.length - 1));
  lastRow.current = rowIdx;
  const row = rows[rowIdx] as HomeRow | undefined;
  const col = row ? Math.max(0, Math.min(cols[row.key] ?? 0, row.entries.length - 1)) : 0;
  const focused = row?.entries[col];

  // Desktop: the billboard follows the pointer until a key is pressed
  const hovered = hover ? rows.find((r) => r.key === hover.row)?.entries[hover.col] : undefined;

  // Phones: one featured title, from the first category (a different one each day)
  const featured = useMemo(() => {
    if (tv) return undefined;
    const pool = (rows.find((r) => r.categoryId && r.entries.length)?.entries ?? []).filter((e) => e.type !== 'more' && e.item.poster).slice(0, 10);
    if (pool.length) return pool[Math.floor(Date.now() / 86400000) % pool.length];
    return rows.find((r) => r.entries.length)?.entries.find((e) => e.type !== 'more');
  }, [rows, tv]);

  const shown = tv ? (hovered ?? focused) : featured;
  const hero = useHero(shown);

  // ---- actions ----
  const play = useCallback((e: HomeEntry) => {
    if (e.type === 'more') return useUI.getState().openCategory(e.kind, e.categoryId);
    if (e.type === 'movie') return playMovie(e.item);
    void (e.episode ? continueSeries(e.item, e.episode) : playSeries(e.item));
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
      const remove: SheetOption[] = e.historyId ? [{ label: 'Remove from Continue watching', icon: 'close-circle-outline', onSelect: () => st.removeHistory(pid, e.historyId!) }] : [];
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
            return openOptions(focused);
          case 'playpause':
            return focused ? play(focused) : undefined;
          case 'up':
            return;
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
          // back to the top first, then to the menu
          if (rowIdx === 0 && col === 0) return false;
          setCol(row, 0);
          return focusRow(0);
        default:
          return false;
      }
    },
    keysEnabled,
    Layer.screen
  );

  // ---- scrolling: the focused row sits right under the billboard ----
  const listRef = useRef<FlatList<HomeRow>>(null);
  const [headerH, setHeaderH] = useState(0);
  useEffect(() => {
    if (tv) listRef.current?.scrollToOffset({ offset: zone === 'hero' ? 0 : rowIdx * m.rowH, animated: true });
    else if (keysEnabled) listRef.current?.scrollToOffset({ offset: Math.max(0, headerH + rowIdx * m.rowH - 8), animated: true });
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
      setFocusKey(rk);
      setCol(r, c);
      setZone('rows');
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
    if (!catsKnown || status === 'loading' || status === 'idle') return <LoadingScreen message="Loading movies and series…" />;
    return <EmptyHome enabled={!menuFocused && !detailOpen && !sheetOpen && !editorOpen && !fullscreen} />;
  }

  const list = (
    <FlatList
      ref={listRef}
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={renderRow}
      extraData={renderRow}
      getItemLayout={(_d, i) => ({ length: m.rowH, offset: (tv ? 0 : headerH) + m.rowH * i, index: i })}
      initialNumToRender={tv ? 3 : 4}
      maxToRenderPerBatch={3}
      windowSize={5}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={
        tv ? undefined : (
          <View onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)} style={{ paddingBottom: 12 }}>
            <PhoneHeader />
            {hero ? <FeaturedCard hero={hero} actions={actions} /> : null}
          </View>
        )
      }
      // TV: room for the last row to come up under the billboard
      contentContainerStyle={{ paddingBottom: tv ? Math.max(0, box.h - heroH - m.rowH) : 24 }}
    />
  );

  return (
    <View style={{ flex: 1 }} onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {tv ? (
        <>
          <BillboardArt hero={hero} width={box.w} height={heroH + s(48)} />
          <Billboard hero={hero} actions={actions} focusedAction={zone === 'hero' ? heroBtn : -1} height={heroH} width={box.w} />
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
