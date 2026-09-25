import { Directory, File, Paths } from 'expo-file-system';
import type { DocOp } from '../utils/docPatch';

// Native key/value storage backed by JSON files in the documents directory.
// Playlists and EPG data can be tens of MB, so AsyncStorage (6 MB cap on Android) is not an option.

const dir = new Directory(Paths.document, 'nova');

function fileFor(key: string) {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, key.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');
}

export async function getItem<T>(key: string): Promise<T | null> {
  try {
    const f = fileFor(key);
    if (!f.exists) return null;
    const text = await f.text();
    return JSON.parse(text) as T;
  } catch (e) {
    console.warn('storage.getItem failed', key, e);
    return null;
  }
}

export async function setItem(key: string, value: unknown): Promise<void> {
  const f = fileFor(key);
  if (!f.exists) f.create({ overwrite: true });
  f.write(JSON.stringify(value));
}

export async function removeItem(key: string): Promise<void> {
  try {
    const f = fileFor(key);
    if (f.exists) f.delete();
  } catch {
    // already gone
  }
}

/** Web syncs settings between devices through the Nova server; native storage is per device. */
export function onRemoteChange(_key: string, _listener: (ops: DocOp[]) => void): () => void {
  return () => {};
}
