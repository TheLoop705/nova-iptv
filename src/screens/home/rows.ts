import { useMemo } from 'react';
import type { Category, Episode, SeriesItem, VodItem } from '../../types';
import { useLibrary } from '../../store/library';
import { favCatKey, useSettings, type WatchEntry } from '../../store/settings';

export type VodKind = 'movies' | 'series';
/** Home's filter: everything, or movies or series only */
export type HomeFilter = 'all' | VodKind;

/** One card in a Home row. */
export type HomeEntry =
  | { type: 'movie'; key: string; item: VodItem; historyId?: string }
  | { type: 'series'; key: string; item: SeriesItem; episode?: Episode; historyId?: string }
  /** the "See all" card at the end of a long category row */
  | { type: 'more'; key: string; kind: VodKind; categoryId: string; title: string; total: number };

export interface HomeRow {
  key: string;
  title: string;
  /** "Movies" / "Series" after a category's name, when the playlist has both */
  kindLabel?: string;
  kind?: VodKind;
  categoryId?: string;
  /** Recently watched: OK plays straight away (resuming) instead of opening the details */
  resume?: boolean;
  /** landscape cards (Continue watching) instead of posters */
  wide?: boolean;
  entries: HomeEntry[];
  /** a category whose titles haven't arrived yet */
  loading: boolean;
}

/** Titles per category row; the rest are behind the row's "See all" card. */
export const ROW_MAX = 30;
/** Category rows on Home. Every other category is still in Movies / Series. */
const CATEGORY_ROWS = 40;
const RECENT_MAX = 30;

// Cards are cached per list so a row keeps its identity (and skips re-rendering) while other rows load
const entryCache = new WeakMap<object, HomeEntry[]>();

function categoryEntries(list: (VodItem | SeriesItem)[], kind: VodKind, cat: Category): HomeEntry[] {
  const hit = entryCache.get(list);
  if (hit) return hit;
  const out: HomeEntry[] = list
    .slice(0, ROW_MAX)
    .map((item) => (kind === 'movies' ? { type: 'movie', key: 'm' + item.id, item: item as VodItem } : { type: 'series', key: 's' + item.id, item: item as SeriesItem }));
  if (list.length > ROW_MAX) out.push({ type: 'more', key: `more:${kind}:${cat.id}`, kind, categoryId: cat.id, title: cat.name, total: list.length });
  entryCache.set(list, out);
  return out;
}

/**
 * Home's rows, Netflix style: Continue watching, My List, then categories — starred ones first, then the
 * ones you've been watching from, then movies and series alternating in the provider's order.
 * Live TV stays in the guide.
 */
export function useHomeRows(filter: HomeFilter = 'all'): { rows: HomeRow[]; catsKnown: boolean } {
  const pid = useLibrary((st) => st.playlistId);
  const movieCats = useLibrary((st) => st.movieCats);
  const seriesCats = useLibrary((st) => st.seriesCats);
  const movies = useLibrary((st) => st.movies);
  const series = useLibrary((st) => st.series);
  const vodStatus = useLibrary((st) => st.vodStatus);
  const history = useSettings((st) => (pid ? st.history[pid] : undefined));
  const favs = useSettings((st) => (pid ? st.vodFavorites[pid] : undefined));
  const favMovieCats = useSettings((st) => (pid ? st.favCategories[favCatKey(pid, 'movies')] : undefined));
  const favSeriesCats = useSettings((st) => (pid ? st.favCategories[favCatKey(pid, 'series')] : undefined));

  const watched = useMemo(() => [...(history ?? [])].filter((h) => h.kind !== 'live').sort((a, b) => b.at - a.at), [history]);

  // Movies and TV shows you've watched, newest first (live channels stay in Live TV). OK resumes a movie, or
  // carries a show on from its episode (the next one once it's finished).
  const resume = useMemo(() => {
    const out: HomeEntry[] = [];
    for (const h of watched) {
      if (out.length >= RECENT_MAX) break;
      if (h.kind === 'movie') out.push({ type: 'movie', key: 'c:' + h.id, item: h.item, historyId: h.id });
      else if (h.kind === 'episode') out.push({ type: 'series', key: 'c:' + h.id, item: h.series, episode: h.episode, historyId: h.id });
    }
    return out;
  }, [watched]);

  const myList = useMemo(
    () =>
      (favs ?? []).map((f): HomeEntry =>
        f.kind === 'movie' ? { type: 'movie', key: 'l:m' + f.item.id, item: f.item } : { type: 'series', key: 'l:s' + f.item.id, item: f.item }
      ),
    [favs]
  );

  // Which categories get a row, in order. Waits for both lists, so rows don't reshuffle when the second arrives.
  const order = useMemo(() => {
    if (!movieCats || !seriesCats) return [];
    const mc = movieCats;
    const sc = seriesCats;
    const byKey = new Map<string, { kind: VodKind; cat: Category }>();
    for (const c of mc) byKey.set('m:' + c.id, { kind: 'movies', cat: c });
    for (const c of sc) byKey.set('s:' + c.id, { kind: 'series', cat: c });
    const out: { key: string; kind: VodKind; cat: Category }[] = [];
    const add = (key: string) => {
      const c = byKey.get(key);
      if (!c) return;
      byKey.delete(key);
      out.push({ key, ...c });
    };
    const favM = new Set(favMovieCats ?? []);
    const favS = new Set(favSeriesCats ?? []);
    mc.filter((c) => favM.has(c.id)).forEach((c) => add('m:' + c.id));
    sc.filter((c) => favS.has(c.id)).forEach((c) => add('s:' + c.id));
    for (const h of watched as WatchEntry[]) {
      if (h.kind === 'movie') add('m:' + h.item.categoryId);
      else if (h.kind === 'episode') add('s:' + h.series.categoryId);
    }
    for (let i = 0; i < Math.max(mc.length, sc.length); i++) {
      if (mc[i]) add('m:' + mc[i].id);
      if (sc[i]) add('s:' + sc[i].id);
    }
    return out;
  }, [movieCats, seriesCats, favMovieCats, favSeriesCats, watched]);

  const rows = useMemo(() => {
    const out: HomeRow[] = [];
    const want = (e: HomeEntry) => filter === 'all' || (filter === 'movies' ? e.type === 'movie' : e.type === 'series');
    const recent = filter === 'all' ? resume : resume.filter(want);
    const list = filter === 'all' ? myList : myList.filter(want);
    if (recent.length) out.push({ key: 'recent', title: 'Continue watching', resume: true, wide: true, entries: recent, loading: false });
    if (list.length) out.push({ key: 'mylist', title: 'My List', entries: list, loading: false });
    const both = filter === 'all' && !!movieCats?.length && !!seriesCats?.length;
    let count = 0;
    for (const { key, kind, cat } of order) {
      if (count >= CATEGORY_ROWS) break;
      if (filter !== 'all' && kind !== filter) continue;
      const titles = (kind === 'movies' ? movies[cat.id] : series[cat.id]) as (VodItem | SeriesItem)[] | undefined;
      // categories that turn out empty, or fail to load, drop out and the next one moves up
      if (titles ? !titles.length : vodStatus[key] === 'error') continue;
      count++;
      out.push({
        key,
        title: cat.name,
        kindLabel: both ? (kind === 'movies' ? 'Movies' : 'Series') : undefined,
        kind,
        categoryId: cat.id,
        entries: titles ? categoryEntries(titles, kind, cat) : [],
        loading: !titles,
      });
    }
    return out;
  }, [resume, myList, order, movies, series, vodStatus, movieCats, seriesCats, filter]);

  return { rows, catsKnown: movieCats !== null && seriesCats !== null };
}
