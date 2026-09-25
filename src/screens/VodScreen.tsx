import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, Text, View } from 'react-native';
import type { SeriesItem, VodItem } from '../types';
import { colors, fonts, radius, useLayout } from '../theme';
import { Chip } from '../components/Chip';
import { useLibrary } from '../store/library';
import { useSettings } from '../store/settings';
import { useUI } from '../store/ui';
import { useKeys, type KeyEvt } from '../input/keys';
import { Poster } from '../components/Logo';
import { Focusable } from '../components/Focusable';
import { Icon } from '../components/Icon';
import { movieKey } from '../services/vod';

type Item = VodItem | SeriesItem;
const RECENT = '__recent';
const FAVS = '__fav';

export function VodScreen({ kind }: { kind: 'movies' | 'series' }) {
  const { s, mode, width } = useLayout();
  const tv = mode === 'tv';
  const pid = useLibrary((st) => st.playlistId);
  const cats = useLibrary((st) => (kind === 'movies' ? st.movieCats : st.seriesCats));
  const byCat = useLibrary((st) => (kind === 'movies' ? st.movies : st.series)) as Record<string, Item[]>;
  const vodStatus = useLibrary((st) => st.vodStatus);
  const loadCats = useLibrary((st) => (kind === 'movies' ? st.loadMovieCats : st.loadSeriesCats));
  const loadItems = useLibrary((st) => (kind === 'movies' ? st.loadMovies : st.loadSeries));
  const favs = useSettings((st) => (pid ? st.vodFavorites[pid] : undefined));
  const recent = useSettings((st) => (pid ? st.recentMovies[pid] : undefined));
  const progress = useSettings((st) => st.vodProgress);
  const menuFocused = useUI((st) => st.menuFocused);
  const detail = useUI((st) => st.detail);
  const setDetail = useUI((st) => st.setDetail);

  useEffect(() => {
    void loadCats();
  }, [pid, loadCats]);

  const favItems = useMemo(() => (favs ?? []).filter((f) => (kind === 'movies' ? f.kind === 'movie' : f.kind === 'series')).map((f) => f.item), [favs, kind]);
  const allCats = useMemo(
    () => [
      ...(kind === 'movies' && recent?.length ? [{ id: RECENT, name: 'Recently watched' }] : []),
      ...(favItems.length ? [{ id: FAVS, name: 'Favorites' }] : []),
      ...(cats ?? []),
    ],
    [kind, recent?.length, favItems.length, cats]
  );

  const [catIndex, setCatIndex] = useState(0);
  const [selected, setSelected] = useState<string | undefined>();
  const [zone, setZone] = useState<'cats' | 'grid'>('cats');
  const [gi, setGi] = useState(0);

  // default category: first real one
  useEffect(() => {
    if (selected || !allCats.length) return;
    const first = allCats.findIndex((c) => c.id !== RECENT && c.id !== FAVS);
    const idx = first >= 0 ? first : 0;
    setCatIndex(idx);
    setSelected(allCats[idx].id);
  }, [allCats, selected]);

  // key browsing through categories selects them after a short pause
  useEffect(() => {
    if (!tv) return;
    const id = allCats[catIndex]?.id;
    if (!id || id === selected) return;
    const t = setTimeout(() => {
      setSelected(id);
      setGi(0);
    }, 350);
    return () => clearTimeout(t);
  }, [catIndex, allCats, selected, tv]);

  useEffect(() => {
    if (selected && selected !== RECENT && selected !== FAVS) void loadItems(selected);
  }, [selected, loadItems]);

  const items: Item[] = selected === RECENT ? (recent ?? []) : selected === FAVS ? favItems : selected ? (byCat[selected] ?? []) : [];
  const loading = !cats || (selected ? vodStatus[(kind === 'movies' ? 'm:' : 's:') + selected] === 'loading' : false);

  // grid metrics
  const [boxW, setBoxW] = useState(width);
  const catsW = tv ? s(200) : 0;
  const pad = tv ? s(18) : 14;
  const gap = tv ? s(14) : 10;
  const gridW = boxW - catsW - pad * 2;
  const cols = tv ? Math.max(3, Math.floor((gridW + gap) / (s(98) + gap))) : Math.max(3, Math.floor((gridW + gap) / (118 + gap)));
  const posterW = (gridW - gap * (cols - 1)) / cols;
  const rowH = posterW * 1.5 + (tv ? s(46) : 50);
  const rows = useMemo(() => {
    const out: Item[][] = [];
    for (let i = 0; i < items.length; i += cols) out.push(items.slice(i, i + cols));
    return out;
  }, [items, cols]);

  const gridRef = useRef<FlatList<Item[]>>(null);
  const catRef = useRef<FlatList>(null);
  const catH = tv ? s(34) : 0;

  useEffect(() => {
    if (tv) catRef.current?.scrollToOffset({ offset: Math.max(0, (catIndex - 4) * catH), animated: true });
  }, [catIndex, catH, tv]);
  useEffect(() => {
    const r = Math.floor(gi / cols);
    gridRef.current?.scrollToOffset({ offset: Math.max(0, r * rowH - (tv ? s(10) : 0)), animated: true });
  }, [gi, cols, rowH, tv, s]);

  const open = (it: Item) => setDetail(kind === 'movies' ? { kind: 'movie', item: it as VodItem } : { kind: 'series', item: it as SeriesItem });

  const onKey = (e: KeyEvt): boolean | void => {
    if (zone === 'cats') {
      switch (e.key) {
        case 'up':
          return setCatIndex((i) => Math.max(0, i - 1));
        case 'down':
          return setCatIndex((i) => Math.min(allCats.length - 1, i + 1));
        case 'right':
        case 'select':
          if (allCats[catIndex]?.id !== selected) {
            setSelected(allCats[catIndex]?.id);
            setGi(0);
          }
          if (items.length || e.key === 'select') setZone('grid');
          return;
        case 'left':
        case 'back':
          return false;
        default:
          return;
      }
    }
    const n = items.length;
    switch (e.key) {
      case 'left':
        if (gi % cols === 0) return setZone('cats');
        return setGi(gi - 1);
      case 'right':
        return setGi(Math.min(n - 1, gi + 1));
      case 'up':
        return setGi(gi - cols >= 0 ? gi - cols : gi);
      case 'down':
        return setGi(Math.min(n - 1, gi + cols < n ? gi + cols : gi));
      case 'chup':
        return setGi(Math.max(0, gi - cols * 3));
      case 'chdown':
        return setGi(Math.min(n - 1, gi + cols * 3));
      case 'select':
        if (items[gi]) open(items[gi]);
        return;
      case 'back':
        return setZone('cats');
      default:
        return;
    }
  };
  useKeys(onKey, !menuFocused && !detail);

  const title = kind === 'movies' ? 'Movies' : 'Series';

  return (
    <View style={{ flex: 1 }} onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: pad, paddingTop: tv ? s(16) : 14, paddingBottom: tv ? s(8) : 6 }}>
        <Text style={{ color: colors.text, fontSize: tv ? s(22) : 28, fontWeight: '800', letterSpacing: -0.3, fontFamily: fonts.regular }}>{title}</Text>
        <Text numberOfLines={1} style={{ color: colors.muted, fontSize: tv ? s(12) : 13, marginLeft: 10, flexShrink: 1 }}>
          {selected ? allCats.find((c) => c.id === selected)?.name : ''}
          {items.length ? `  ·  ${items.length}` : ''}
        </Text>
      </View>
      <View style={{ flex: 1, flexDirection: tv ? 'row' : 'column' }}>
        {tv ? (
          <FlatList
            ref={catRef}
            data={allCats}
            style={{ width: catsW, flexGrow: 0 }}
            contentContainerStyle={{ paddingLeft: s(10), paddingBottom: s(20) }}
            keyExtractor={(c) => c.id}
            getItemLayout={(_d, i) => ({ length: catH, offset: catH * i, index: i })}
            renderItem={({ item: c, index }) => (
              <Focusable
                focused={zone === 'cats' && index === catIndex}
                onPress={() => {
                  setCatIndex(index);
                  setSelected(c.id);
                  setGi(0);
                }}
                style={{ height: catH - s(2), borderRadius: s(radius.sm), paddingHorizontal: s(10), flexDirection: 'row', alignItems: 'center', backgroundColor: c.id === selected ? colors.accentSoft : 'transparent' }}
                focusStyle={{ backgroundColor: colors.focus }}
              >
                {({ focused }) => (
                  <>
                    {c.id === RECENT || c.id === FAVS ? (
                      <Icon name={c.id === RECENT ? 'history' : 'star'} size={s(13)} color={focused ? colors.focusText : c.id === RECENT ? colors.accent : colors.star} style={{ marginRight: s(7) }} />
                    ) : null}
                    <Text numberOfLines={1} style={{ flex: 1, color: focused ? colors.focusText : colors.text, fontSize: s(12.5), fontWeight: c.id === selected ? '700' : '500' }}>
                      {c.name}
                    </Text>
                  </>
                )}
              </Focusable>
            )}
          />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 10, gap: 8 }}>
            {allCats.map((c) => (
              <Chip
                key={c.id}
                label={c.name}
                icon={c.id === RECENT ? 'history' : c.id === FAVS ? 'star' : undefined}
                selected={c.id === selected}
                onPress={() => {
                  setSelected(c.id);
                  setGi(0);
                }}
              />
            ))}
          </ScrollView>
        )}

        <View style={{ flex: 1 }}>
          {loading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={colors.accent} size="large" />
            </View>
          ) : !items.length ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <Icon name={kind === 'movies' ? 'movie-open-off-outline' : 'television-off'} size={tv ? s(36) : 40} color={colors.muted} />
              <Text style={{ color: colors.textDim, fontSize: tv ? s(13) : 15, marginTop: 10, textAlign: 'center' }}>
                {cats && !cats.length && !allCats.length ? `This playlist has no ${kind}.` : 'Nothing here yet.'}
              </Text>
            </View>
          ) : (
            <FlatList
              ref={gridRef}
              data={rows}
              keyExtractor={(r, i) => (r[0]?.id ?? '') + i}
              contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: tv ? s(40) : 30, paddingTop: tv ? s(6) : 0 }}
              getItemLayout={(_d, i) => ({ length: rowH, offset: rowH * i, index: i })}
              initialNumToRender={4}
              windowSize={5}
              renderItem={({ item: r, index: ri }) => (
                <View style={{ flexDirection: 'row', height: rowH, gap }}>
                  {r.map((it, ci) => {
                    const idx = ri * cols + ci;
                    const prog = kind === 'movies' ? progress[movieKey(it as VodItem)] : undefined;
                    return (
                      <PosterCard
                        key={it.id}
                        item={it}
                        width={posterW}
                        focused={zone === 'grid' && gi === idx}
                        progress={prog ? prog.pos / prog.dur : 0}
                        tv={tv}
                        s={s}
                        onPress={() => {
                          setGi(idx);
                          setZone('grid');
                          open(it);
                        }}
                      />
                    );
                  })}
                </View>
              )}
            />
          )}
        </View>
      </View>
    </View>
  );
}

const PosterCard = React.memo(function PosterCard({
  item,
  width,
  focused,
  progress,
  tv,
  s,
  onPress,
}: {
  item: Item;
  width: number;
  focused: boolean;
  progress: number;
  tv: boolean;
  s: (n: number) => number;
  onPress: () => void;
}) {
  const year = 'year' in item ? item.year : undefined;
  return (
    <Focusable
      focused={focused}
      onPress={onPress}
      accessibilityLabel={item.name}
      style={{ width, borderRadius: radius.md, padding: 0 }}
      hoverStyle={{ transform: [{ scale: 1.03 }] }}
      focusStyle={{ transform: [{ scale: 1.07 }] }}
    >
      {({ focused: f, hovered }) => (
        <View>
          <View style={{ borderRadius: tv ? s(radius.md) : radius.md, borderWidth: tv ? s(2.5) : 2, borderColor: f ? colors.focus : hovered ? colors.borderStrong : 'transparent', overflow: 'hidden' }}>
            <Poster uri={item.poster} name={item.name} width={width - (tv ? s(5) : 4)} />
            {item.rating && Number(item.rating) > 0 ? (
              <View style={{ position: 'absolute', top: 6, right: 6, backgroundColor: colors.videoScrim, borderRadius: radius.xs, paddingHorizontal: 5, paddingVertical: 1, flexDirection: 'row', alignItems: 'center' }}>
                <Icon name="star" size={tv ? s(10) : 11} color={colors.star} />
                <Text style={{ color: colors.onVideo, fontSize: tv ? s(10.5) : 11, fontWeight: '700', marginLeft: 2, fontVariant: ['tabular-nums'] }}>{Number(item.rating).toFixed(1)}</Text>
              </View>
            ) : null}
            {progress > 0 ? (
              <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: tv ? s(3) : 4, backgroundColor: colors.videoScrim }}>
                <View style={{ width: `${Math.min(100, progress * 100)}%`, height: '100%', backgroundColor: colors.accent }} />
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} style={{ color: f || hovered ? colors.text : colors.textDim, fontSize: tv ? s(11.5) : 13, fontWeight: f ? '700' : '600', marginTop: tv ? s(6) : 6 }}>
            {item.name}
          </Text>
          {year ? <Text style={{ color: colors.muted, fontSize: tv ? s(11) : 12 }}>{year}</Text> : null}
        </View>
      )}
    </Focusable>
  );
});
