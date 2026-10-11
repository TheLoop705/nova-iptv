import { getItem, removeItem, setItem } from './storage';
import { emptyEpg, type EpgData } from './xmltv';
import { createCheckpoint, throwIfAborted } from '../utils/cooperative';
import { Platform } from 'react-native';
import { withCacheLock } from '../utils/cacheQueue';

interface Manifest { version: 1; token: string; chunks: number; fetchedAt: number }
type Chunk = Pick<EpgData, 'programs' | 'names' | 'icons'>;
const keyFor = (playlistId: string) => 'epg-parts:' + playlistId;
const chunkKey = (key: string, manifest: Manifest, index: number) => `${key}:${manifest.token}:${index}`;
const emptyChunk = (): Chunk => ({ programs: Object.create(null), names: Object.create(null), icons: Object.create(null) });
const BATCH = 256;

/** Bound native JSON serialization, parsing and file writes to small cache pages. */
export function readEpgCache(playlistId: string, signal?: AbortSignal): Promise<EpgData | null> {
  return withCacheLock(keyFor(playlistId), () => read(playlistId, signal));
}
async function read(playlistId: string, signal?: AbortSignal): Promise<EpgData | null> {
  const key = keyFor(playlistId);
  const manifest = await getItem<Manifest>(key);
  throwIfAborted(signal);
  // Native legacy files can be tens of MB: parsing them would freeze the first
  // launch after an upgrade. Refresh once instead. Web uses structured clone.
  if (!manifest || manifest.version !== 1) return Platform.OS === 'web' ? getItem<EpgData>('epg:' + playlistId) : null;
  const data = emptyEpg();
  data.fetchedAt = manifest.fetchedAt;
  const checkpoint = createCheckpoint(signal);
  for (let i = 0; i < manifest.chunks; i++) {
    const page = await getItem<Chunk>(chunkKey(key, manifest, i));
    throwIfAborted(signal);
    if (!page) return null; // never expose an incomplete cache
    for (const id in page.programs) {
      const list = data.programs[id] ??= [];
      for (const program of page.programs[id]) list.push(program);
    }
    Object.assign(data.names, page.names);
    Object.assign(data.icons, page.icons);
    const pause = checkpoint();
    if (pause) await pause;
  }
  return data;
}

export function writeEpgCache(playlistId: string, data: EpgData, signal?: AbortSignal): Promise<void> {
  return withCacheLock(keyFor(playlistId), () => write(playlistId, data, signal));
}
async function write(playlistId: string, data: EpgData, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const key = keyFor(playlistId);
  const previous = await getItem<Manifest>(key);
  const manifest: Manifest = { version: 1, token: Date.now().toString(36) + Math.random().toString(36).slice(2, 9), chunks: 0, fetchedAt: data.fetchedAt };
  let page = emptyChunk();
  let size = 0;
  const checkpoint = createCheckpoint(signal);
  const flush = async () => {
    if (!size) return;
    throwIfAborted(signal);
    await setItem(chunkKey(key, manifest, manifest.chunks), page);
    manifest.chunks++;
    page = emptyChunk();
    size = 0;
    const pause = checkpoint();
    if (pause) await pause;
  };
  try {
    for (const id in data.programs) {
      const list = data.programs[id];
      for (let start = 0; start < list.length; ) {
        const count = Math.min(BATCH - size, list.length - start);
        page.programs[id] = list.slice(start, start + count);
        start += count;
        size += count;
        if (size === BATCH) await flush();
      }
    }
    for (const name in data.names) {
      page.names[name] = data.names[name];
      if (++size === BATCH) await flush();
    }
    for (const id in data.icons) {
      page.icons[id] = data.icons[id];
      if (++size === BATCH) await flush();
    }
    await flush();
    throwIfAborted(signal);
    // Publish only when every page is persisted; a failed refresh keeps the old cache.
    await setItem(key, manifest);
  } catch (error) {
    const cleanupCheckpoint = createCheckpoint();
    for (let i = 0; i < manifest.chunks; i++) {
      await removeItem(chunkKey(key, manifest, i));
      const pause = cleanupCheckpoint();
      if (pause) await pause;
    }
    throw error;
  }
  if (previous?.version === 1) {
    const cleanupCheckpoint = createCheckpoint();
    for (let i = 0; i < previous.chunks; i++) {
      await removeItem(chunkKey(key, previous, i));
      const pause = cleanupCheckpoint();
      if (pause) await pause;
    }
  }
  await removeItem('epg:' + playlistId);
}

export function removeEpgCache(playlistId: string): Promise<void> {
  return withCacheLock(keyFor(playlistId), () => remove(playlistId));
}
async function remove(playlistId: string): Promise<void> {
  const key = keyFor(playlistId);
  const manifest = await getItem<Manifest>(key);
  const checkpoint = createCheckpoint();
  if (manifest?.version === 1) {
    for (let i = 0; i < manifest.chunks; i++) {
      await removeItem(chunkKey(key, manifest, i));
      const pause = checkpoint();
      if (pause) await pause;
    }
  }
  await Promise.all([removeItem(key), removeItem('epg:' + playlistId)]);
}
