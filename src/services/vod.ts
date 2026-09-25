import type { Episode, MovieInfo, SeriesInfo, SeriesItem, VodItem } from '../types';
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

export function playEpisode(series: SeriesItem, ep: Episode, fromStart = false) {
  const key = episodeKey(ep);
  const progress = useSettings.getState().vodProgress[key];
  usePlayer.getState().playVod(
    {
      kind: 'vod',
      key,
      title: series.name,
      subtitle: `S${ep.season} E${ep.episode} · ${ep.title}`,
      url: ep.url,
      poster: ep.image ?? series.poster,
      userAgent: activePlaylist()?.userAgent,
    },
    fromStart ? undefined : progress?.pos
  );
}

export async function loadMovieInfo(item: VodItem): Promise<MovieInfo | null> {
  const p = activePlaylist();
  if (p?.type === 'xtream' && item.streamId) return xtreamMovieInfo(p, item.streamId);
  return null;
}

export async function loadSeriesInfo(item: SeriesItem): Promise<SeriesInfo | null> {
  const p = activePlaylist();
  if (!p) return null;
  if (p.type === 'demo') return demoSeriesInfo(item.seriesId);
  if (p.type === 'xtream') return xtreamSeriesInfo(p, item.seriesId);
  return null;
}
