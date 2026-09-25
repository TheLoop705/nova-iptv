import { createStore, del, get, set } from 'idb-keyval';

// IndexedDB storage on web: structured clone handles large playlists/EPG without JSON limits.
const store = typeof indexedDB !== 'undefined' ? createStore('nova-iptv', 'kv') : null;

export async function getItem<T>(key: string): Promise<T | null> {
  if (!store) return null;
  try {
    return ((await get(key, store)) as T) ?? null;
  } catch (e) {
    console.warn('storage.getItem failed', key, e);
    return null;
  }
}

export async function setItem(key: string, value: unknown): Promise<void> {
  if (!store) return;
  await set(key, value, store);
}

export async function removeItem(key: string): Promise<void> {
  if (!store) return;
  await del(key, store);
}
