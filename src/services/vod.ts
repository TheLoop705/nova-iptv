import type { Episode, MovieInfo, PlayItem, SeriesInfo, SeriesItem, VodItem } from '../types';
import { useSettings, watchId } from '../store/settings';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { useUI } from '../store/ui';
import { xtreamMovieInfo, xtreamMovieUrl, xtreamSeriesInfo } from './xtream';
import { demoSeriesInfo } from './demo';

const activePlaylist = () => {
  const pid = useLibrary.getState().playlistId;
  return useSettings.getState().playlists.find((p) => p.id === pid);
};

export const movieKey = (item: VodItem) => `${useLibrary.getState().playlistId}:movie:${item.id}`;
export const episodeKey = (ep: Episode) => `${useLibrary.getState().playlistId}:ep:${ep.id}`;

export function movieUrl(item: VodItem): string | null {
  if (item.url) return item.url;
  const p = activePlaylist();
  if (p?.type === 'xtream' && item.streamId) return xtreamMovieUrl(p, item.streamId, item.ext || 'mp4');
  return null;
}

export function playMovie(item: VodItem, fromStart = false) {
  const url = movieUrl(item);
  if (!url) return;
  const key = movieKey(item);
  const progress = useSettings.getState().vodProgress[key];
  const pid = useLibrary.getState().playlistId;
  if (pid) {
    useSettings.getState().pushRecentMovie(pid, item);
    useSettings.getState().pushHistory(pid, { kind: 'movie', id: watchId.movie(item.id), item, at: Date.now() });
  }
  usePlayer.getState().playVod(
    { kind: 'vod', key, title: item.name, subtitle: item.year, url, poster: item.poster, userAgent: activePlaylist()?.userAgent },
    fromStart ? undefined : progress?.pos
  );
}

const seriesInfoCache = new Map<number, SeriesInfo>();

/** The episode after `ep`: next in the season, else the first of the following season. */
export function nextEpisode(series: SeriesItem, ep: Episode): Episode | undefined {
  const info = seriesInfoCache.get(series.seriesId);
  if (!info) return undefined;
  const seasons = info.seasons;
  const si = seasons.findIndex((s) => s.season === ep.season);
  if (si < 0) return undefined;
  const ei = seasons[si].episodes.findIndex((e) => e.id === ep.id);
  if (ei >= 0 && ei + 1 < seasons[si].episodes.length) return seasons[si].episodes[ei + 1];
  return seasons.slice(si + 1).find((s) => s.episodes.length)?.episodes[0];
}

function episodeItem(series: SeriesItem, ep: Episode) {
  return {
    kind: 'vod' as const,
    key: episodeKey(ep),
    title: series.name,
    subtitle: `S${ep.season} E${ep.episode} · ${ep.title}`,
    url: ep.url,
    poster: ep.image ?? series.poster,
    userAgent: activePlaylist()?.userAgent,
  };
}

function recordEpisode(series: SeriesItem, ep: Episode) {
  const pid = useLibrary.getState().playlistId;
  if (pid) useSettings.getState().pushHistory(pid, { kind: 'episode', id: watchId.series(series.id), series, episode: ep, at: Date.now() });
}

export function playEpisode(series: SeriesItem, ep: Episode, fromStart = false) {
  const progress = useSettings.getState().vodProgress[episodeKey(ep)];
  const after = nextEpisode(series, ep);
  recordEpisode(series, ep);
  usePlayer.getState().playVod(
    { ...episodeItem(series, ep), next: after ? episodeItem(series, after) : undefined },
    fromStart ? undefined : progress?.pos
  );
}

/** Play an "Up next" item, keeping the chain going to the episode after it. */
export function playNextItem(next: Omit<Extract<PlayItem, { kind: 'vod' }>, 'next'>) {
  for (const [seriesId, info] of seriesInfoCache) {
    for (const season of info.seasons) {
      const ep = season.episodes.find((e) => episodeKey(e) === next.key);
      if (!ep) continue;
      const known = useSettings.getState().history[useLibrary.getState().playlistId ?? '']?.find((h) => h.kind === 'episode' && h.series.seriesId === seriesId);
      const series = known?.kind === 'episode' ? known.series : ({ id: String(seriesId), seriesId, name: next.title, poster: next.poster } as SeriesItem);
      const after = nextEpisode(series, ep);
      recordEpisode(series, ep);
      usePlayer.getState().playVod({ ...next, next: after ? episodeItem(series, after) : undefined });
      return;
    }
  }
  usePlayer.getState().playVod(next);
}

/** Resume an episode from Home: loads the season list first so "Up next" keeps working. */
export async function resumeEpisode(series: SeriesItem, ep: Episode, fromStart = false) {
  if (!seriesInfoCache.has(series.seriesId)) await loadSeriesInfo(series).catch(() => null);
  playEpisode(series, ep, fromStart);
}

export interface ResumePoint {
  /** index into `SeriesInfo.seasons` */
  season: number;
  /** index into that season's episodes */
  index: number;
  episode: Episode;
  /** the episode before it was watched to the end: this one is up next */
  next: boolean;
}

/**
 * Where to pick a series up: the episode watched most recently, or the one after it once that's finished
 * (the last episode stays put). Reads each episode's watch progress, which outlives the 40-entry history,
 * plus the history entry for episodes stopped too early to have progress. Undefined if nothing was watched.
 */
export function seriesResumePoint(series: SeriesItem, info: SeriesInfo): ResumePoint | undefined {
  const pid = useLibrary.getState().playlistId;
  const { vodProgress, history } = useSettings.getState();
  const last = pid ? history[pid]?.find((h) => h.kind === 'episode' && h.series.id === series.id) : undefined;
  const lastId = last?.kind === 'episode' ? last.episode.id : undefined;
  const seasons = info.seasons;
  let si = -1;
  let ei = -1;
  let latest = 0;
  for (let s = 0; s < seasons.length; s++) {
    for (let e = 0; e < seasons[s].episodes.length; e++) {
      const ep = seasons[s].episodes[e];
      const at = Math.max(vodProgress[episodeKey(ep)]?.at ?? 0, ep.id === lastId ? last!.at : 0);
      if (at > latest) [latest, si, ei] = [at, s, e];
    }
  }
  if (si < 0) return undefined;
  const pr = vodProgress[episodeKey(seasons[si].episodes[ei])];
  if (pr?.done && !(pr.pos > 0)) {
    if (ei + 1 < seasons[si].episodes.length) return { season: si, index: ei + 1, episode: seasons[si].episodes[ei + 1], next: true };
    const later = seasons.findIndex((s, i) => i > si && s.episodes.length > 0);
    if (later >= 0) return { season: later, index: 0, episode: seasons[later].episodes[0], next: true };
  }
  return { season: si, index: ei, episode: seasons[si].episodes[ei], next: false };
}

/**
 * Carry a series on where you left it (see seriesResumePoint), or start the first episode. `ep` is the
 * episode Home's Recently watched remembers, used if the episode list can't be loaded.
 */
export async function continueSeries(series: SeriesItem, ep?: Episode) {
  let info = seriesInfoCache.get(series.seriesId) ?? null;
  if (!info) {
    useUI.getState().showToast('Loading episodes…');
    info = await loadSeriesInfo(series).catch(() => null);
  }
  const target = (info && seriesResumePoint(series, info)?.episode) ?? ep ?? info?.seasons.find((s) => s.episodes.length)?.episodes[0];
  if (target) playEpisode(series, target);
  else useUI.getState().setDetail({ kind: 'series', item: series });
}

/** Recently fetched movie details, so Home's billboard and the detail page don't ask twice. */
const movieInfoCache = new Map<string, Promise<MovieInfo | null>>();
const movieInfoDone = new Map<string, MovieInfo | null>();
const MOVIE_INFO_MAX = 300;
const movieInfoKey = (item: VodItem) => `${useLibrary.getState().playlistId}:${item.streamId}`;

export function loadMovieInfo(item: VodItem): Promise<MovieInfo | null> {
  const p = activePlaylist();
  if (p?.type !== 'xtream' || !item.streamId) return Promise.resolve(null);
  const key = movieInfoKey(item);
  const hit = movieInfoCache.get(key);
  if (hit) return hit;
  const req = xtreamMovieInfo(p, item.streamId);
  movieInfoCache.set(key, req);
  req.then(
    (info) => movieInfoDone.set(key, info),
    () => movieInfoCache.delete(key) // failures aren't remembered
  );
  if (movieInfoCache.size > MOVIE_INFO_MAX) {
    const oldest = movieInfoCache.keys().next().value!;
    movieInfoCache.delete(oldest);
    movieInfoDone.delete(oldest);
  }
  return req;
}

/** Movie details that have already arrived (undefined when not fetched yet), without a request. */
export function peekMovieInfo(item: VodItem): MovieInfo | null | undefined {
  return item.streamId ? movieInfoDone.get(movieInfoKey(item)) : null;
}

/** Watch-progress keys of every episode of a series (loads the episode list if it isn't known yet). */
export async function seriesProgressKeys(series: SeriesItem): Promise<string[]> {
  const info = seriesInfoCache.get(series.seriesId) ?? (await loadSeriesInfo(series).catch(() => null));
  return (info?.seasons ?? []).flatMap((s) => s.episodes.map(episodeKey));
}

export async function loadSeriesInfo(item: SeriesItem): Promise<SeriesInfo | null> {
  const p = activePlaylist();
  if (!p) return null;
  const info = p.type === 'demo' ? demoSeriesInfo(item.seriesId) : p.type === 'xtream' ? await xtreamSeriesInfo(p, item.seriesId) : null;
  if (info) seriesInfoCache.set(item.seriesId, info);
  return info;
}
