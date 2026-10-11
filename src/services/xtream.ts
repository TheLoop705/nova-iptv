import { Platform } from 'react-native';
import type {
  Category,
  Channel,
  Episode,
  MovieInfo,
  Playlist,
  Program,
  SeriesInfo,
  SeriesItem,
  VodItem,
} from '../types';
import { b64decode } from '../utils/format';
import { fetchJson, redact, streamText } from './http';
import { CatalogJsonParser } from './catalog';
import { createCheckpoint } from '../utils/cooperative';

export interface XtreamAccount {
  status?: string;
  expDate?: number;
  maxConnections?: number;
  activeConnections?: number;
  formats: string[];
  timezone?: string;
}

export function normalizeServer(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/(player_api\.php|get\.php|xmltv\.php).*$/i, '');
  s = s.replace(/\/c\/?$/i, '');
  return s.replace(/\/+$/, '');
}

function api(p: Playlist, action?: string, extra: Record<string, string | number> = {}) {
  const q = new URLSearchParams({ username: p.username ?? '', password: p.password ?? '' });
  if (action) q.set('action', action);
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return `${normalizeServer(p.server ?? '')}/player_api.php?${q.toString()}`;
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === 'object' ? (Object.values(v) as T[]) : []);
const rows = (v: unknown, key: string): any[] => arr<any>(v).filter((x) => x && typeof x === 'object' && x[key] != null);
/** An explicit provider refusal, as opposed to a transient network error. */
export class AuthError extends Error {}

export async function xtreamLogin(p: Playlist, signal?: AbortSignal): Promise<XtreamAccount> {
  const data = await fetchJson<any>(api(p), { ua: p.userAgent, timeoutMs: 20000, signal });
  const ui = data?.user_info;
  if (!ui || String(ui.auth) === '0') throw new AuthError('Login failed — check server, username and password.');
  if (ui.status && ui.status !== 'Active') throw new AuthError(`Account status: ${ui.status}`);
  return {
    status: ui.status,
    expDate: ui.exp_date ? Number(ui.exp_date) * 1000 : undefined,
    maxConnections: Number(ui.max_connections) || undefined,
    activeConnections: Number(ui.active_cons) || 0,
    formats: arr<string>(ui.allowed_output_formats),
    timezone: data?.server_info?.timezone,
  };
}

export async function xtreamLive(p: Playlist, signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<Channel[]> {
  let index = 0;
  const [cats, list] = await Promise.all([
    fetchJson<any[]>(api(p, 'get_live_categories'), { ua: p.userAgent, signal }),
    fetchCatalog<Channel>(api(p, 'get_live_streams'), p, (s) => {
    if (!s || typeof s !== 'object' || s.stream_id == null) return;
    const i = index++;
    const archive = Number(s.tv_archive) === 1;
    return {
      id: 'x' + s.stream_id,
      num: Number(s.num) || i + 1,
      name: String(s.name ?? '').trim() || `Channel ${s.stream_id}`,
      logo: s.stream_icon || undefined,
      group: String(s.category_id ?? ''),
      url: '',
      tvgId: s.epg_channel_id || undefined,
      streamId: Number(s.stream_id),
      catchup: archive ? { type: 'xc', days: Number(s.tv_archive_duration) || 3 } : undefined,
    };
    }, signal, onProgress),
  ]);
  const catName = new Map<string, string>();
  for (const c of rows(cats, 'category_id')) catName.set(String(c.category_id), String(c.category_name ?? ''));
  const checkpoint = createCheckpoint(signal);
  for (let i = 0; i < list.length; i++) {
    list[i].group = catName.get(list[i].group) || 'Uncategorized';
    if ((i & 255) === 0) {
      const pause = checkpoint();
      if (pause) await pause;
    }
  }
  // Keep provider order: by category order then channel number
  list.sort((a, b) => a.num - b.num);
  return list;
}

export async function xtreamVodCategories(p: Playlist, signal?: AbortSignal): Promise<Category[]> {
  const cats = await fetchJson<any[]>(api(p, 'get_vod_categories'), { ua: p.userAgent, signal });
  return rows(cats, 'category_id').map((c) => ({ id: String(c.category_id), name: String(c.category_name ?? '') }));
}

export async function xtreamSeriesCategories(p: Playlist, signal?: AbortSignal): Promise<Category[]> {
  const cats = await fetchJson<any[]>(api(p, 'get_series_categories'), { ua: p.userAgent, signal });
  return rows(cats, 'category_id').map((c) => ({ id: String(c.category_id), name: String(c.category_name ?? '') }));
}

async function fetchCatalog<T>(url: string, p: Playlist, normalize: (value: any) => T | undefined, signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<T[]> {
  const parser = new CatalogJsonParser(normalize, signal);
  try {
    await streamText(url, { ua: p.userAgent, timeoutMs: 120000, signal }, (chunk) => parser.push(chunk), onProgress);
    return parser.finish();
  } catch (error: any) {
    if (error instanceof SyntaxError) throw new Error(`Invalid catalog response from ${redact(url)}`);
    throw error;
  }
}

export async function xtreamMovies(p: Playlist, categoryId?: string, signal?: AbortSignal): Promise<VodItem[]> {
  const url = categoryId ? api(p, 'get_vod_streams', { category_id: categoryId }) : api(p, 'get_vod_streams');
  return fetchCatalog<VodItem>(url, p, (s) => s && typeof s === 'object' && s.stream_id != null ? ({
    id: 'v' + s.stream_id,
    name: String(s.name ?? ''),
    poster: s.stream_icon || undefined,
    categoryId: String(s.category_id ?? ''),
    streamId: Number(s.stream_id),
    ext: s.container_extension || 'mp4',
    rating: s.rating ? String(s.rating) : undefined,
    added: s.added ? Number(s.added) * 1000 : undefined,
  }) : undefined, signal);
}

export async function xtreamSeries(p: Playlist, categoryId?: string, signal?: AbortSignal): Promise<SeriesItem[]> {
  const url = categoryId ? api(p, 'get_series', { category_id: categoryId }) : api(p, 'get_series');
  return fetchCatalog<SeriesItem>(url, p, (s) => s && typeof s === 'object' && s.series_id != null ? ({
    id: 's' + s.series_id,
    seriesId: Number(s.series_id),
    name: String(s.name ?? ''),
    poster: s.cover || undefined,
    categoryId: String(s.category_id ?? ''),
    rating: s.rating ? String(s.rating) : undefined,
    year: s.releaseDate ? String(s.releaseDate).slice(0, 4) : s.year ? String(s.year) : undefined,
    plot: s.plot || undefined,
    genre: s.genre || undefined,
    backdrop: arr<string>(s.backdrop_path).find((b) => typeof b === 'string' && b) || undefined,
  }) : undefined, signal);
}

export async function xtreamSeriesInfo(p: Playlist, seriesId: number, signal?: AbortSignal): Promise<SeriesInfo> {
  const data = await fetchJson<any>(api(p, 'get_series_info', { series_id: seriesId }), { ua: p.userAgent, signal });
  const info = data?.info ?? {};
  const eps = data?.episodes ?? {};
  const seasonsMeta = new Map<number, string>();
  for (const s of arr<any>(data?.seasons)) seasonsMeta.set(Number(s.season_number), s.name);
  const seasons: SeriesInfo['seasons'] = [];
  const checkpoint = createCheckpoint(signal);
  for (const season of Object.keys(eps).map(Number).sort((a, b) => a - b)) {
    const episodes: Episode[] = [];
    for (const e of arr<any>(eps[String(season)])) {
      episodes.push({
          id: String(e.id),
          title: String(e.title ?? `Episode ${e.episode_num}`),
          season,
          episode: Number(e.episode_num) || 0,
          ext: e.container_extension || 'mp4',
          plot: e.info?.plot || undefined,
          duration: e.info?.duration || undefined,
          image: e.info?.movie_image || undefined,
          url: xtreamEpisodeUrl(p, String(e.id), e.container_extension || 'mp4'),
      });
      const pause = checkpoint();
      if (pause) await pause;
    }
    seasons.push({ season, name: seasonsMeta.get(season) || `Season ${season}`, episodes });
  }
  const backdrop = arr<string>(info.backdrop_path)[0];
  return {
    plot: info.plot,
    cast: info.cast,
    genre: info.genre,
    rating: info.rating ? String(info.rating) : undefined,
    backdrop,
    poster: info.cover,
    year: info.releaseDate ? String(info.releaseDate).slice(0, 4) : undefined,
    seasons,
  };
}

/** History may contain an old URL; credentials always come from the current playlist. */
export function xtreamEpisodeUrl(p: Playlist, episodeId: string, ext = 'mp4'): string {
  return `${normalizeServer(p.server!)}/series/${encodeURIComponent(p.username!)}/${encodeURIComponent(p.password!)}/${encodeURIComponent(episodeId)}.${ext}`;
}

export async function xtreamMovieInfo(p: Playlist, vodId: number, signal?: AbortSignal): Promise<MovieInfo> {
  const data = await fetchJson<any>(api(p, 'get_vod_info', { vod_id: vodId }), { ua: p.userAgent, signal });
  const info = data?.info ?? {};
  return {
    plot: info.plot || info.description,
    cast: info.cast || info.actors,
    director: info.director,
    genre: info.genre,
    rating: info.rating ? String(info.rating) : undefined,
    duration: info.duration,
    backdrop: arr<string>(info.backdrop_path)[0],
    poster: info.movie_image || info.cover_big,
    year: info.releasedate ? String(info.releasedate).slice(0, 4) : info.year,
  };
}

/** Lightweight per-channel guide, used when no XMLTV data is available. */
export async function xtreamShortEpg(p: Playlist, streamId: number, signal?: AbortSignal): Promise<Program[]> {
  const data = await fetchJson<any>(api(p, 'get_simple_data_table', { stream_id: streamId }), { ua: p.userAgent, signal });
  return arr<any>(data?.epg_listings)
    .map((e) => ({
      start: Number(e.start_timestamp) * 1000,
      end: Number(e.stop_timestamp) * 1000,
      title: b64decode(e.title),
      desc: b64decode(e.description)?.slice(0, 400) || undefined,
    }))
    .filter((e) => e.end > e.start)
    .sort((a, b) => a.start - b.start);
}

export function xtreamEpgUrl(p: Playlist) {
  const q = new URLSearchParams({ username: p.username ?? '', password: p.password ?? '' });
  return `${normalizeServer(p.server ?? '')}/xmltv.php?${q.toString()}`;
}

/** iOS AVPlayer can't play raw MPEG-TS, browsers play HLS via hls.js; Android's ExoPlayer handles both. */
export function preferredLiveExt(pref: 'auto' | 'ts' | 'm3u8', allowed: string[]): string {
  if (pref !== 'auto') return pref;
  const want = Platform.OS === 'android' ? 'ts' : 'm3u8';
  if (!allowed.length || allowed.includes(want)) return want;
  return allowed.includes('m3u8') ? 'm3u8' : allowed[0];
}

export function xtreamLiveUrl(p: Playlist, streamId: number, ext: string) {
  return `${normalizeServer(p.server!)}/live/${encodeURIComponent(p.username!)}/${encodeURIComponent(p.password!)}/${streamId}.${ext}`;
}

export function xtreamMovieUrl(p: Playlist, streamId: number, ext: string) {
  return `${normalizeServer(p.server!)}/movie/${encodeURIComponent(p.username!)}/${encodeURIComponent(p.password!)}/${streamId}.${ext}`;
}

function formatInZone(ms: number, timeZone?: string) {
  const pad = (n: number) => String(n).padStart(2, '0');
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(ms));
      const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
      const hour = get('hour') === '24' ? '00' : get('hour');
      return `${get('year')}-${get('month')}-${get('day')}:${hour}-${get('minute')}`;
    } catch {
      // fall through to local time
    }
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}:${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

export function xtreamCatchupUrl(p: Playlist, streamId: number, program: Program, timezone: string | undefined, ext: string) {
  const minutes = Math.ceil((program.end - program.start) / 60000);
  const start = formatInZone(program.start, timezone);
  return `${normalizeServer(p.server!)}/timeshift/${encodeURIComponent(p.username!)}/${encodeURIComponent(p.password!)}/${minutes}/${start}/${streamId}.${ext}`;
}
