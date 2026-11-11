import { Directory, File, Paths } from 'expo-file-system';
import type { Doc, DocOp } from '../utils/docPatch';
import { createCheckpoint } from '../utils/cooperative';

// Native key/value storage backed by JSON files in the documents directory.
// Playlists and EPG data can be tens of MB, so AsyncStorage (6 MB cap on Android) is not an option.

const dir = new Directory(Paths.document, 'nova');

const fileName = (key: string) => key.replace(/[^a-zA-Z0-9_.-]/g, '_');

function fileFor(key: string) {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, fileName(key) + '.json');
}

// Small critical documents are written to a temp file and renamed, so a process kill mid-write
// cannot leave a truncated file (losing every playlist). Cache pages are just refetched.
const ATOMIC = new Set(['settings', 'device']);
const tmpFor = (key: string) => new File(dir, fileName(key) + '.json.tmp');

export async function getItem<T>(key: string): Promise<T | null> {
  try {
    const f = fileFor(key);
    if (f.exists) {
      try {
        return JSON.parse(await f.text()) as T;
      } catch (e) {
        if (!ATOMIC.has(key)) throw e;
        console.warn('storage.getItem: unreadable, trying temp copy', key, e);
      }
    }
    // The real file first, the temp copy second: a leftover temp may itself be an interrupted write,
    // while a missing real file with a complete temp is a kill between delete and rename.
    if (ATOMIC.has(key)) {
      const tmp = tmpFor(key);
      if (tmp.exists) return JSON.parse(await tmp.text()) as T;
    }
    return null;
  } catch (e) {
    console.warn('storage.getItem failed', key, e);
    return null;
  }
}

export async function setItem(key: string, value: unknown): Promise<void> {
  const f = fileFor(key);
  const text = JSON.stringify(value);
  if (ATOMIC.has(key)) {
    try {
      const tmp = tmpFor(key); // a new object each time: moveSync rewrites its uri
      if (!tmp.exists) tmp.create({ overwrite: true });
      tmp.write(text);
      tmp.moveSync(f, { overwrite: true });
      return;
    } catch (e) {
      // never stop saving settings over an unexpected filesystem error
      console.warn('storage.setItem: atomic write failed, writing directly', key, e);
    }
  }
  if (!f.exists) f.create({ overwrite: true });
  f.write(text);
}

export async function removeItem(key: string): Promise<void> {
  try {
    const f = fileFor(key);
    if (f.exists) f.delete();
  } catch {
    // already gone
  }
}

/** Removes every key that starts with `prefix` (a playlist's per-category caches). */
export async function removeByPrefix(prefix: string): Promise<void> {
  try {
    if (!dir.exists) return;
    const start = fileName(prefix);
    const checkpoint = createCheckpoint();
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name.startsWith(start)) entry.delete();
      const pause = checkpoint();
      if (pause) await pause;
    }
  } catch (e) {
    console.warn('storage.removeByPrefix failed', prefix, e);
  }
}

/** Web syncs settings between devices through the Nova server; native storage is per device. */
export function onRemoteChange(_key: string, _listener: (ops: DocOp[]) => void, _currentDoc?: () => Doc): () => void {
  return () => {};
}
