import { createStore, del, get, set } from 'idb-keyval';
import { diffDoc, type Doc, type DocOp } from '../utils/docPatch';

// Where web data lives:
// - `settings` (playlists, favourites, progress, preferences) and uploaded `m3u:` files: on the
//   Nova server in SQLite, so a refresh, cleared site data or another computer on the network all
//   see the same library. `settings` is saved as field-level ops (utils/docPatch), so two open
//   tabs or devices don't overwrite each other's changes.
// - everything else (channel/EPG caches, device-only state): this browser's IndexedDB. Structured
//   clone handles large playlists/EPG without JSON limits.
// Without the server API (a static host, an older server) everything stays in IndexedDB.

const idb = typeof indexedDB !== 'undefined' ? createStore('nova-iptv', 'kv') : null;
const API = `${(process.env.EXPO_PUBLIC_PROXY_URL ?? '').replace(/\/$/, '')}/api/kv/`;
const DOC_KEY = 'settings';
const onServer = (key: string) => key === DOC_KEY || key.startsWith('m3u:');

/** unknown until the first request */
let server: boolean | undefined;
/** the server's copy of the settings document as of the last sync */
let synced: Doc | null = null;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<(ops: DocOp[]) => void>();

async function idbGet<T>(key: string): Promise<T | null> {
  if (!idb) return null;
  try {
    return ((await get(key, idb)) as T) ?? null;
  } catch (e) {
    console.warn('storage.getItem failed', key, e);
    return null;
  }
}

async function call<T>(key: string, method: string, body?: unknown): Promise<T | null> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(API + encodeURIComponent(key), {
    method,
    cache: 'no-store',
    headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
    body: payload,
    // lets the save on page unload finish; browsers only allow it for small bodies
    keepalive: payload !== undefined && payload.length < 60000,
  });
  if (!res.ok) throw new Error(`Nova server: ${method} ${key} failed (HTTP ${res.status})`);
  // A static host answers with index.html here, which fails to parse
  const data = (await res.json()) as { value?: T | null; ok?: boolean };
  if (!data || typeof data !== 'object' || !('value' in data || data.ok)) throw new Error('Not a Nova server');
  return data.value ?? null;
}

/** Runs settings syncs one at a time so each diff is against the latest server copy. */
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

function emit(ops: DocOp[]) {
  if (ops.length) listeners.forEach((l) => l(ops));
}

/** Saves what changed since the last sync, then hands back what other devices changed meanwhile. */
function saveDoc(doc: Doc): Promise<void> {
  return enqueue(async () => {
    const ops = diffDoc(synced ?? {}, doc);
    if (!ops.length) return;
    const merged = (await call<Doc>(DOC_KEY, 'PATCH', { ops })) ?? {};
    synced = merged;
    emit(diffDoc(doc, merged));
  });
}

/** Picks up changes made on other devices while this tab was in the background. */
function pull() {
  if (server !== true || !synced) return;
  enqueue(async () => {
    const doc = (await call<Doc>(DOC_KEY, 'GET')) ?? {};
    const incoming = diffDoc(synced ?? {}, doc);
    synced = doc;
    emit(incoming);
  }).catch((e) => console.warn('Settings sync failed', e));
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && pull());
}

export async function getItem<T>(key: string): Promise<T | null> {
  if (onServer(key) && server !== false) {
    try {
      const stored = await call<T>(key, 'GET');
      server = true;
      if (key === DOC_KEY) synced = (stored as Doc | null) ?? {};
      if (stored !== null) return stored;
      // First load since the server took over: move what this browser saved before
      const mine = await idbGet<T>(key);
      if (mine !== null) {
        await setItem(key, mine)
          .then(() => idb && del(key, idb))
          .catch((e) => console.warn('Could not move saved data to the Nova server', key, e));
      }
      return mine;
    } catch (e) {
      if (server) {
        console.warn('storage.getItem failed', key, e);
        return null;
      }
      server = false;
      console.warn('Nova server storage unavailable, saving in this browser only', e);
    }
  }
  return idbGet<T>(key);
}

export async function setItem(key: string, value: unknown): Promise<void> {
  if (onServer(key) && server !== false) {
    if (key === DOC_KEY) return saveDoc(value as Doc);
    await call(key, 'PUT', value);
    return;
  }
  if (!idb) return;
  await set(key, value, idb);
}

export async function removeItem(key: string): Promise<void> {
  if (onServer(key) && server !== false) await call(key, 'DELETE').catch((e) => console.warn('storage.removeItem failed', key, e));
  // also clears a copy saved before the server took over
  if (idb) await del(key, idb);
}

/** Changes to `key` made in another tab or on another device, as ops to apply to local state. */
export function onRemoteChange(key: string, listener: (ops: DocOp[]) => void): () => void {
  if (key !== DOC_KEY) return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
