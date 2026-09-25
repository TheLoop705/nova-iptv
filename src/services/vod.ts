import type { Episode, MovieInfo, PlayItem, SeriesInfo, SeriesItem, VodItem } from '../types';
import { useSettings } from '../store/settings';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
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
  if (pid) useSettings.getState().pushRecentMovie(pid, item);
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

export function playEpisode(series: SeriesItem, ep: Episode, fromStart = false) {
  const progress = useSettings.getState().vodProgress[episodeKey(ep)];
  const after = nextEpisode(series, ep);
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
      const series = { seriesId, name: next.title, poster: next.poster } as SeriesItem;
      const after = nextEpisode(series, ep);
      usePlayer.getState().playVod({ ...next, next: after ? episodeItem(series, after) : undefined });
      return;
    }
  }
  usePlayer.getState().playVod(next);
}

export async function loadMovieInfo(item: VodItem): Promise<MovieInfo | null> {
  const p = activePlaylist();
  if (p?.type === 'xtream' && item.streamId) return xtreamMovieInfo(p, item.streamId);
  return null;
}

export async function loadSeriesInfo(item: SeriesItem): Promise<SeriesInfo | null> {
  const p = activePlaylist();
  if (!p) return null;
  const info = p.type === 'demo' ? demoSeriesInfo(item.seriesId) : p.type === 'xtream' ? await xtreamSeriesInfo(p, item.seriesId) : null;
  if (info) seriesInfoCache.set(item.seriesId, info);
  return info;
}
