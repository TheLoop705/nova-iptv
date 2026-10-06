import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { Inflate } from 'pako';
import { Utf8Decoder } from '../utils/format';
import { createCheckpoint, throwIfAborted } from '../utils/cooperative';

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

export interface FetchOpts {
  ua?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** bytes received so far (big playlists and channel lists: shown on the loading screen) */
  onProgress?: (bytes: number) => void;
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
  await streamText(url, { timeoutMs: 45_000, ...opts }, (t) => { parts.push(t); }, opts?.onProgress);
  return parts.join('');
}

/**
 * Streams a (possibly gzipped) text resource, calling onText with decoded chunks.
 * XMLTV guides are often 50-200 MB, so we never hold the raw bytes in memory at once.
 */
export async function streamText(
  url: string,
  opts: FetchOpts,
  onText: (chunk: string) => void | Promise<void>,
  onProgress?: (bytes: number) => void
): Promise<void> {
  throwIfAborted(opts.signal);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? 180000);
  const cancel = () => controller.abort();
  opts.signal?.addEventListener('abort', cancel, { once: true });
  const signal = controller.signal;
  const checkpoint = createCheckpoint(signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  const decoder = new Utf8Decoder();
  let inflater: Inflate | null = null;
  let prefix: Uint8Array = new Uint8Array(0);
  let sniffed = false;
  let bytes = 0;
  let inflated: Uint8Array[] = [];

  const emit = async (text: string) => {
    // Providers, native transports and gzip may each deliver a complete large
    // body in one chunk. Keep every parser invocation small on all platforms.
    for (let i = 0; i < text.length; i += 16_384) {
      throwIfAborted(signal);
      await onText(text.slice(i, i + 16_384));
      const pause = checkpoint();
      if (pause) await pause;
    }
  };

  const handleBytes = async (input: Uint8Array, last = false) => {
    let chunk = input;
    if (!sniffed) {
      if (prefix.length) {
        chunk = new Uint8Array(prefix.length + input.length);
        chunk.set(prefix);
        chunk.set(input, prefix.length);
      }
      // A gzip signature can be split between network reads.
      if (chunk.length < 2 && !last) {
        prefix = chunk;
        return;
      }
      prefix = new Uint8Array(0);
      sniffed = true;
      if (chunk[0] === 0x1f && chunk[1] === 0x8b) {
        inflater = new Inflate({ chunkSize: 16_384 });
        inflater.onData = (out: Uint8Array) => inflated.push(out);
      }
    }
    const step = inflater ? 1_024 : 16_384;
    for (let offset = 0; offset < chunk.length; offset += step) {
      throwIfAborted(signal);
      const part = chunk.subarray(offset, Math.min(chunk.length, offset + step));
      if (inflater) {
        inflater.push(part, false);
        if (inflater.err) throw new Error(`Failed to decompress ${redact(url)}: ${inflater.msg}`);
        const pending = inflated;
        inflated = [];
        for (const out of pending) await emit(decoder.decode(out, true));
      } else await emit(decoder.decode(part, true));
      const pause = checkpoint();
      if (pause) await pause;
    }
    if (last) {
      if (inflater) {
        inflater.push(new Uint8Array(0), true);
        if (inflater.err || !inflater.ended) throw new Error(`Failed to decompress ${redact(url)}: ${inflater.msg || 'Incomplete gzip stream'}`);
        for (const out of inflated) await emit(decoder.decode(out, true));
        inflated = [];
      }
      await emit(decoder.decode(new Uint8Array(0), false));
    }
  };

  // Older transports may not reject a pending read on abort. Use a listener
  // scoped to each operation; racing every read against one pending Promise
  // retains all its reaction closures for the entire large-guide transfer.
  const waitFor = <T,>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      const error = new Error('Operation cancelled');
      error.name = 'AbortError';
      reject(error);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    // Observe the operation even if it was already aborted, so a late native
    // rejection cannot become an unhandled rejection after cancellation.
    operation.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    if (signal.aborted) onAbort();
  });
  try {
    const headers: Record<string, string> = {};
    if (!isWeb) headers['User-Agent'] = opts.ua || DEFAULT_UA;
    // React Native's global fetch buffers the body; Expo exposes a true stream.
    const transport = isWeb ? globalThis.fetch : expoFetch;
    const res = await waitFor(transport(proxify(url, opts.ua || DEFAULT_UA), { headers, signal }));
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} for ${redact(url)}`);
    const body = res.body;
    if (body && typeof body.getReader === 'function') {
      reader = body.getReader();
      while (true) {
        const { done, value } = await waitFor(reader.read());
        if (done) break;
        if (value?.length) {
          bytes += value.length;
          onProgress?.(bytes);
          await handleBytes(value);
        }
      }
    } else {
      const buf = new Uint8Array(await waitFor(res.arrayBuffer()));
      bytes = buf.length;
      onProgress?.(bytes);
      await handleBytes(buf);
    }
    await handleBytes(new Uint8Array(0), true);
    throwIfAborted(signal);
    complete = true;
  } catch (e: any) {
    if (timedOut) throw new Error(`Request timed out: ${redact(url)}`);
    if (opts.signal?.aborted || e?.name === 'AbortError') {
      const error = new Error('Operation cancelled');
      error.name = 'AbortError';
      throw error;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', cancel);
    if (!complete) {
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
    try { reader?.releaseLock(); } catch { /* a cancelled pending read owns the lock until it settles */ }
  }
}
