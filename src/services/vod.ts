import type { Episode, MovieInfo, PlayItem, SeriesInfo, SeriesItem, VodItem } from '../types';
import { useSettings, watchId } from '../store/settings';
import { getLibraryGeneration, useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { xtreamEpisodeUrl, xtreamMovieInfo, xtreamMovieUrl, xtreamSeriesInfo } from './xtream';
import { demoSeriesInfo } from './demo';
import { SharedRequestCache } from './requestCache';
import { throwIfAborted } from '../utils/cooperative';

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

const seriesInfoCache = new SharedRequestCache<SeriesInfo | null>();
const movieInfoCache = new SharedRequestCache<MovieInfo>();
let metadataScope = '';
let playingSeries: { series: SeriesItem; info: SeriesInfo } | undefined;
const episodeItemScopes = new WeakMap<object, string>();

/** Provider IDs repeat across playlists; cached metadata belongs to one library generation. */
function syncMetadataScope(): string {
  const scope = `${useLibrary.getState().playlistId ?? ''}:${getLibraryGeneration()}`;
  if (scope !== metadataScope) {
    metadataScope = scope;
    seriesInfoCache.clear();
    movieInfoCache.clear();
    playingSeries = undefined;
  }
  return scope;
}

async function requestMetadata<T>(generation: number, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancelIfChanged = () => { if (getLibraryGeneration() !== generation) controller.abort(); };
  const unsubscribe = useLibrary.subscribe(cancelIfChanged);
  try {
    cancelIfChanged();
    throwIfAborted(controller.signal);
    const result = await load(controller.signal);
    throwIfAborted(controller.signal);
    return result;
  } finally { unsubscribe(); }
}

/** The episode after `ep`: next in the season, else the first of the following season. */
export function nextEpisode(series: SeriesItem, ep: Episode): Episode | undefined {
  syncMetadataScope();
  const info = playingSeries?.series.id === series.id ? playingSeries.info : seriesInfoCache.get(String(series.seriesId));
  if (!info) return undefined;
  const seasons = info.seasons;
  const si = seasons.findIndex((s) => s.season === ep.season);
  if (si < 0) return undefined;
  const ei = seasons[si].episodes.findIndex((e) => e.id === ep.id);
  if (ei >= 0 && ei + 1 < seasons[si].episodes.length) return seasons[si].episodes[ei + 1];
  return seasons.slice(si + 1).find((s) => s.episodes.length)?.episodes[0];
}

function episodeItem(series: SeriesItem, ep: Episode) {
  const p = activePlaylist();
  const item = {
    kind: 'vod' as const,
    key: episodeKey(ep),
    title: series.name,
    subtitle: `S${ep.season} E${ep.episode} · ${ep.title}`,
    url: p?.type === 'xtream' ? xtreamEpisodeUrl(p, ep.id, ep.ext || 'mp4') : ep.url,
    poster: ep.image ?? series.poster,
    userAgent: p?.userAgent,
  };
  episodeItemScopes.set(item, syncMetadataScope());
  return item;
}

/** Resolve history against fresh metadata; removed entries start an available episode. */
function currentEpisode(info: SeriesInfo, saved: Episode): Episode | undefined {
  const season = info.seasons.find((s) => s.season === saved.season);
  let exact = season?.episodes.find((e) => e.id === saved.id);
  if (!exact) for (const s of info.seasons) {
    exact = s.episodes.find((e) => e.id === saved.id);
    if (exact) break;
  }
  return exact ?? season?.episodes.find((e) => e.episode === saved.episode)
    ?? season?.episodes[0] ?? info.seasons.find((s) => s.episodes.length)?.episodes[0];
}

function recordEpisode(series: SeriesItem, ep: Episode) {
  const pid = useLibrary.getState().playlistId;
  if (pid) useSettings.getState().pushHistory(pid, { kind: 'episode', id: watchId.series(series.id), series, episode: ep, at: Date.now() });
}

export function playEpisode(series: SeriesItem, ep: Episode, fromStart = false) {
  syncMetadataScope();
  const info = playingSeries?.series.id === series.id ? playingSeries.info : seriesInfoCache.get(String(series.seriesId));
  if (!info) return;
  const resolved = currentEpisode(info, ep);
  if (!resolved) return;
  playingSeries = { series, info };
  const progress = useSettings.getState().vodProgress[episodeKey(resolved)];
  const after = nextEpisode(series, resolved);
  recordEpisode(series, resolved);
  usePlayer.getState().playVod(
    { ...episodeItem(series, resolved), next: after ? episodeItem(series, after) : undefined },
    fromStart ? undefined : progress?.pos
  );
}

/** Play an "Up next" item, keeping the chain going to the episode after it. */
export function playNextItem(next: Omit<Extract<PlayItem, { kind: 'vod' }>, 'next'>) {
  const scope = syncMetadataScope();
  const producedScope = episodeItemScopes.get(next);
  if (producedScope && producedScope !== scope) return;
  const knownInfos: [string, SeriesInfo | null][] = playingSeries ? [[String(playingSeries.series.seriesId), playingSeries.info]] : [...seriesInfoCache.entries()];
  for (const [seriesId, info] of knownInfos) {
    if (!info) continue;
    for (const season of info.seasons) {
      const ep = season.episodes.find((e) => episodeKey(e) === next.key);
      if (!ep) continue;
      const known = useSettings.getState().history[useLibrary.getState().playlistId ?? '']?.find((h) => h.kind === 'episode' && h.series.seriesId === Number(seriesId));
      const series = playingSeries?.series.seriesId === Number(seriesId) ? playingSeries.series : known?.kind === 'episode' ? known.series : ({ id: String(seriesId), seriesId: Number(seriesId), name: next.title, poster: next.poster } as SeriesItem);
      const after = nextEpisode(series, ep);
      recordEpisode(series, ep);
      usePlayer.getState().playVod({ ...episodeItem(series, ep), next: after ? episodeItem(series, after) : undefined });
      return;
    }
  }
  // A cancelled/removed series has no current metadata to authorize autoplay.
}

/** Resume an episode from Home: loads the season list first so "Up next" keeps working. */
export async function resumeEpisode(series: SeriesItem, ep: Episode, fromStart = false) {
  const scope = syncMetadataScope();
  const info = await loadSeriesInfo(series).catch(() => null);
  if (syncMetadataScope() !== scope || !info) return;
  const resolved = currentEpisode(info, ep);
  if (resolved) playEpisode(series, resolved, fromStart);
}

/** Home: pick a series up where you left it — resume the episode, or start the next one once it's watched. */
export async function continueSeries(series: SeriesItem, ep: Episode) {
  const scope = syncMetadataScope();
  const info = await loadSeriesInfo(series).catch(() => null);
  if (syncMetadataScope() !== scope || !info) return;
  const resolved = currentEpisode(info, ep);
  if (!resolved) return;
  const pr = useSettings.getState().vodProgress[episodeKey(resolved)];
  const next = pr?.done && !(pr.pos > 0) ? nextEpisode(series, resolved) : undefined;
  playEpisode(series, next ?? resolved);
}

export async function loadMovieInfo(item: VodItem): Promise<MovieInfo | null> {
  syncMetadataScope();
  const p = activePlaylist();
  const generation = getLibraryGeneration();
  if (p?.type === 'xtream' && item.streamId) return movieInfoCache.load(String(item.streamId), () => requestMetadata(generation, (signal) => xtreamMovieInfo(p, item.streamId!, signal)));
  return null;
}

export async function loadSeriesInfo(item: SeriesItem): Promise<SeriesInfo | null> {
  syncMetadataScope();
  const p = activePlaylist();
  if (!p) return null;
  const generation = getLibraryGeneration();
  return seriesInfoCache.load(String(item.seriesId), async () => p.type === 'demo' ? demoSeriesInfo(item.seriesId) : p.type === 'xtream' ? requestMetadata(generation, (signal) => xtreamSeriesInfo(p, item.seriesId, signal)) : null);
}
