import { Platform } from 'react-native';
import type { Channel, VodItem } from '../types';
import type { XtreamAccount } from './xtream';
import { getItem, removeItem, setItem } from './storage';
import { createCheckpoint, throwIfAborted } from '../utils/cooperative';
import { withCacheLock } from '../utils/cacheQueue';
import { samePlaylistSource, type PlaylistSource } from './playlistSource';

export interface PlaylistCache {
  channels: Channel[];
  movies: VodItem[];
  epgUrls: string[];
  account?: XtreamAccount;
  fetchedAt: number;
  /** Compared before publishing a cache after an edit on another device. */
  source?: PlaylistSource;
}
interface Manifest extends Omit<PlaylistCache, 'channels' | 'movies'> {
  version: 1;
  token: string;
  channelPages: number;
  moviePages: number;
}
const keyFor = (id: string) => 'pl-parts:' + id;
const pageKey = (key: string, manifest: Manifest, kind: 'channels' | 'movies', page: number) => `${key}:${manifest.token}:${kind}:${page}`;
const BATCH = 128;

export function readPlaylistCache(id: string, signal?: AbortSignal, source?: PlaylistSource): Promise<PlaylistCache | null> {
  return withCacheLock(keyFor(id), () => read(id, signal, source));
}
async function read(id: string, signal?: AbortSignal, source?: PlaylistSource): Promise<PlaylistCache | null> {
  const key = keyFor(id);
  const manifest = await getItem<Manifest>(key);
  throwIfAborted(signal);
  if (!manifest || manifest.version !== 1) return Platform.OS === 'web' ? getItem<PlaylistCache>('pl:' + id) : null;
  const result: PlaylistCache = { channels: [], movies: [], epgUrls: manifest.epgUrls, account: manifest.account, fetchedAt: manifest.fetchedAt,
    ...(manifest.source ? { source: manifest.source } : {}) };
  // A mismatched source needs only the manifest so the caller can invalidate it.
  if (source && (!manifest.source || !samePlaylistSource(manifest.source, source))) return result;
  const checkpoint = createCheckpoint(signal);
  for (const kind of ['channels', 'movies'] as const) {
    const pages = kind === 'channels' ? manifest.channelPages : manifest.moviePages;
    for (let i = 0; i < pages; i++) {
      const page = await getItem<(Channel | VodItem)[]>(pageKey(key, manifest, kind, i));
      throwIfAborted(signal);
      if (!page) return null;
      (result[kind] as (Channel | VodItem)[]).push(...page);
      const pause = checkpoint();
      if (pause) await pause;
    }
  }
  return result;
}

export function writePlaylistCache(id: string, data: PlaylistCache, signal?: AbortSignal): Promise<void> {
  return withCacheLock(keyFor(id), () => write(id, data, signal));
}
async function write(id: string, data: PlaylistCache, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const key = keyFor(id);
  const previous = await getItem<Manifest>(key);
  const manifest: Manifest = {
    version: 1, token: Date.now().toString(36) + Math.random().toString(36).slice(2, 9),
    channelPages: 0, moviePages: 0, epgUrls: data.epgUrls, account: data.account, fetchedAt: data.fetchedAt, source: data.source,
  };
  const checkpoint = createCheckpoint(signal);
  try {
    for (const kind of ['channels', 'movies'] as const) {
      for (let start = 0; start < data[kind].length; start += BATCH) {
        throwIfAborted(signal);
        const counter = kind === 'channels' ? 'channelPages' : 'moviePages';
        await setItem(pageKey(key, manifest, kind, manifest[counter]), data[kind].slice(start, start + BATCH));
        manifest[counter]++;
        const pause = checkpoint();
        if (pause) await pause;
      }
    }
    throwIfAborted(signal);
    await setItem(key, manifest);
  } catch (error) {
    await removePages(key, manifest);
    throw error;
  }
  if (previous?.version === 1) await removePages(key, previous);
  await removeItem('pl:' + id);
}

async function removePages(key: string, manifest: Manifest): Promise<void> {
  const checkpoint = createCheckpoint();
  for (const kind of ['channels', 'movies'] as const) {
    const pages = kind === 'channels' ? manifest.channelPages : manifest.moviePages;
    for (let i = 0; i < pages; i++) {
      await removeItem(pageKey(key, manifest, kind, i));
      const pause = checkpoint();
      if (pause) await pause;
    }
  }
}

export function removePlaylistCache(id: string): Promise<void> {
  return withCacheLock(keyFor(id), () => remove(id));
}
async function remove(id: string): Promise<void> {
  const key = keyFor(id);
  const manifest = await getItem<Manifest>(key);
  if (manifest?.version === 1) await removePages(key, manifest);
  await Promise.all([removeItem(key), removeItem('pl:' + id)]);
}
