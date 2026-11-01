import { Platform } from 'react-native';
import appJson from '../../app.json';
import { mapResults, searchPath, type SubtitleQuery, type SubtitleResult } from './subtitleCore';

// OpenSubtitles.com REST API (v1). Every request needs an API key: Settings → Subtitles, or one baked
// in at build time (EXPO_PUBLIC_OPENSUBTITLES_API_KEY). Without an account a key allows 5 downloads a
// day; signing in raises that to the account's allowance.
// Web can't send the custom headers cross-origin, so it goes through the Nova server's
// /api/opensubtitles route (server/index.mjs), which may also supply its own key.

const isWeb = Platform.OS === 'web';
const PROXY_BASE = (process.env.EXPO_PUBLIC_PROXY_URL ?? '').replace(/\/$/, '');
const BUILD_KEY = (process.env.EXPO_PUBLIC_OPENSUBTITLES_API_KEY ?? '').trim();
const DEFAULT_HOST = 'api.opensubtitles.com';
/** OpenSubtitles asks every app to identify itself as "Name vX.Y.Z". */
export const APP_UA = `Nova IPTV v${appJson.expo.version}`;

export const builtInKey = !!BUILD_KEY;

export interface Credentials {
  apiKey: string;
  username?: string;
  password?: string;
}

/** The key to use: the one from Settings, else the build's. */
export const effectiveKey = (settingsKey: string | undefined) => settingsKey?.trim() || BUILD_KEY;

/** Web can still work without a key in the app: the Nova server may add one. */
export const canSearch = (settingsKey: string | undefined) => isWeb || !!effectiveKey(settingsKey);

export class SubtitleApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

interface CallOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  key: string;
  token?: string;
  host?: string;
  signal?: AbortSignal;
}

function endpoint(path: string, host: string): string {
  return isWeb ? `${PROXY_BASE}/api/opensubtitles${path}` : `https://${host}/api/v1${path}`;
}

async function withTimeout<T>(signal: AbortSignal | undefined, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await run(controller.signal);
  } catch (e: any) {
    if (controller.signal.aborted && !signal?.aborted) throw new SubtitleApiError(0, 'OpenSubtitles did not answer in time');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function messageOf(data: any, status: number): string {
  const m = data?.message || (Array.isArray(data?.errors) ? data.errors.join(', ') : data?.errors) || data?.error;
  if (m) return String(m);
  if (status === 401 || status === 403) return 'OpenSubtitles rejected the API key or login';
  if (status === 429) return 'Too many requests to OpenSubtitles, try again in a moment';
  return `OpenSubtitles error ${status}`;
}

async function call<T>(path: string, o: CallOpts): Promise<T> {
  const host = o.host || DEFAULT_HOST;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.key) headers['Api-Key'] = o.key;
  // web: the Nova server may use Authorization for its own basic auth
  if (o.token) headers[isWeb ? 'X-OS-Token' : 'Authorization'] = isWeb ? o.token : `Bearer ${o.token}`;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (isWeb) {
    headers['X-OS-UA'] = APP_UA;
    if (host !== DEFAULT_HOST) headers['X-OS-Host'] = host;
  } else headers['User-Agent'] = APP_UA;
  return withTimeout(o.signal, 20_000, async (signal) => {
    let res: Response;
    try {
      res = await fetch(endpoint(path, host), {
        method: o.method ?? 'GET',
        headers,
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      throw new SubtitleApiError(0, "Couldn't reach OpenSubtitles");
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // HTML error pages from a CDN in front of the API
    }
    if (!res.ok) throw new SubtitleApiError(res.status, messageOf(data, res.status));
    return data as T;
  });
}

// ---- login --------------------------------------------------------------------------------

let session: { id: string; token: string; host: string; at: number } | null = null;
const SESSION_MS = 12 * 3600 * 1000;

/** Signs in once and reuses the token; anonymous (key only) when no account is set. */
async function auth(c: Credentials, signal?: AbortSignal, fresh = false): Promise<{ token?: string; host?: string }> {
  const user = c.username?.trim();
  if (!user || !c.password) return {};
  const id = `${user}\n${c.password}\n${c.apiKey}`;
  if (!fresh && session && session.id === id && Date.now() - session.at < SESSION_MS) return session;
  session = null;
  const data = await call<{ token?: string; base_url?: string }>('/login', { method: 'POST', body: { username: user, password: c.password }, key: c.apiKey, signal });
  if (!data?.token) throw new SubtitleApiError(401, 'OpenSubtitles login failed');
  const host = /^[a-z0-9.-]+\.opensubtitles\.com$/i.test(data.base_url ?? '') ? data.base_url! : DEFAULT_HOST;
  session = { id, token: data.token, host, at: Date.now() };
  return session;
}

/** Forget the cached login (credentials changed in Settings). */
export function resetSession() {
  session = null;
}

// ---- search / download --------------------------------------------------------------------

export async function searchSubtitles(q: SubtitleQuery, c: Credentials, signal?: AbortSignal): Promise<SubtitleResult[]> {
  const preferred = q.languages[0] ?? 'en';
  const first = mapResults(await call(searchPath(q), { key: c.apiKey, signal }), preferred);
  // a wrong or missing TMDB id on the panel: fall back to the title
  if (first.length || !q.tmdbId) return first;
  return mapResults(await call(searchPath(q, true), { key: c.apiKey, signal }), preferred);
}

export interface Downloaded {
  text: string;
  /** downloads left in the current 24 h window, when OpenSubtitles says */
  remaining?: number;
}

export async function downloadSubtitle(fileId: number, c: Credentials, signal?: AbortSignal): Promise<Downloaded> {
  let a: { token?: string; host?: string } = {};
  try {
    a = await auth(c, signal);
  } catch (e) {
    // a broken login shouldn't block the anonymous allowance
    if ((e as any)?.name === 'AbortError') throw e;
    a = {};
  }
  const request = (x: typeof a) =>
    call<{ link?: string; remaining?: number; message?: string }>('/download', { method: 'POST', body: { file_id: fileId }, key: c.apiKey, token: x.token, host: x.host, signal });
  let data;
  try {
    data = await request(a);
  } catch (e) {
    // the token expired early: sign in again once
    if (e instanceof SubtitleApiError && e.status === 401 && a.token) data = await request(await auth(c, signal, true));
    else throw e;
  }
  if (!data?.link) throw new SubtitleApiError(0, data?.message || 'OpenSubtitles returned no file');
  const text = await withTimeout(signal, 30_000, async (s) => {
    const url = isWeb ? `${PROXY_BASE}/api/opensubtitles/file?url=${encodeURIComponent(data.link!)}` : data.link!;
    const res = await fetch(url, { headers: isWeb ? { 'X-OS-UA': APP_UA } : { 'User-Agent': APP_UA }, signal: s });
    if (!res.ok) throw new SubtitleApiError(res.status, `Subtitle download failed (${res.status})`);
    return res.text();
  });
  return { text, remaining: typeof data.remaining === 'number' ? data.remaining : undefined };
}
