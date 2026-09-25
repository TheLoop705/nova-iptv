import { Platform } from 'react-native';
import { Inflate } from 'pako';
import { Utf8Decoder } from '../utils/format';

export const DEFAULT_UA = 'Nova/1.0 (Linux; Android 12) ExoPlayerLib/2.19.1';

const isWeb = Platform.OS === 'web';
const PROXY_BASE = (process.env.EXPO_PUBLIC_PROXY_URL ?? '').replace(/\/$/, '');

/**
 * Browsers can't talk to IPTV servers directly (no CORS headers, plain http, custom User-Agents),
 * so on web every request goes through the bundled proxy server. Native apps fetch directly.
 */
export function proxify(url: string, ua?: string): string {
  if (!isWeb || !/^https?:\/\//i.test(url)) return url;
  if (typeof location !== 'undefined' && url.startsWith(location.origin)) return url;
  let out = `${PROXY_BASE}/api/proxy?url=${encodeURIComponent(url)}`;
  if (ua) out += `&ua=${encodeURIComponent(ua)}`;
  return out;
}

/** Images: only proxy on web when the page is https and the image is plain http (mixed content). */
export function imageUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (!isWeb) return url;
  if (typeof location !== 'undefined' && location.protocol === 'https:' && url.startsWith('http:')) {
    return proxify(url);
  }
  return url;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

interface FetchOpts {
  ua?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request(url: string, opts: FetchOpts = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
  opts.signal?.addEventListener('abort', () => controller.abort());
  const headers: Record<string, string> = {};
  if (!isWeb) headers['User-Agent'] = opts.ua || DEFAULT_UA;
  try {
    const res = await fetch(proxify(url, opts.ua || DEFAULT_UA), { headers, signal: controller.signal });
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} for ${redact(url)}`);
    return res;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`Request timed out: ${redact(url)}`);
    if (e instanceof HttpError) throw e;
    throw new Error(`Network error for ${redact(url)}: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Hide credentials when surfacing URLs in errors. */
export function redact(url: string): string {
  return url.replace(/(password|username)=([^&]+)/gi, '$1=***').replace(/\/\/([^/:@]+):([^@/]+)@/, '//***@');
}

export async function fetchJson<T = any>(url: string, opts?: FetchOpts): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid response from ${redact(url)}`);
  }
}

export async function fetchText(url: string, opts?: FetchOpts): Promise<string> {
  const parts: string[] = [];
  await streamText(url, opts ?? {}, (t) => parts.push(t));
  return parts.join('');
}

/**
 * Streams a (possibly gzipped) text resource, calling onText with decoded chunks.
 * XMLTV guides are often 50-200 MB, so we never hold the raw bytes in memory at once.
 */
export async function streamText(
  url: string,
  opts: FetchOpts,
  onText: (chunk: string) => void,
  onProgress?: (bytes: number) => void
): Promise<void> {
  const res = await request(url, { timeoutMs: 180000, ...opts });
  const decoder = new Utf8Decoder();
  let inflater: Inflate | null = null;
  let sniffed = false;
  let bytes = 0;

  const handleBytes = (chunk: Uint8Array, last: boolean) => {
    if (!sniffed) {
      sniffed = true;
      if (chunk.length > 1 && chunk[0] === 0x1f && chunk[1] === 0x8b) {
        inflater = new Inflate();
        inflater.onData = (out: Uint8Array) => onText(decoder.decode(out, true));
      }
    }
    if (inflater) {
      inflater.push(chunk, last);
      if (inflater.err) throw new Error(`Failed to decompress ${redact(url)}: ${inflater.msg}`);
    } else {
      onText(decoder.decode(chunk, !last));
    }
  };

  const body: any = (res as any).body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        bytes += value.length;
        onProgress?.(bytes);
        handleBytes(value, false);
      }
    }
    if (!sniffed) return;
    handleBytes(new Uint8Array(0), true);
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buf.length);
    handleBytes(buf, true);
  }
}
