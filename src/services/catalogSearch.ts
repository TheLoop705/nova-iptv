import type { Channel, SeriesItem, VodItem } from '../types';
import { compactTitle, matchScore, queryWords } from './searchMatch';
import { throwIfAborted, yieldToUI } from '../utils/cooperative';

export type SearchHit =
  | { kind: 'channel'; item: Channel }
  | { kind: 'movie'; item: VodItem }
  | { kind: 'series'; item: SeriesItem };

export interface SearchCatalog {
  channels: Channel[];
  movies: Record<string, VodItem[]>;
  series: Record<string, SeriesItem[]>;
}

// Weak keys release their normalized titles when a playlist/catalog is replaced.
const titles = new WeakMap<object, { name: string; compact: string }>();
function titleFor(item: { name: string }): string {
  const saved = titles.get(item);
  if (saved?.name === item.name) return saved.compact;
  const compact = compactTitle(item.name);
  titles.set(item, { name: item.name, compact });
  return compact;
}

const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

/** Search outside React render in short, cancellable slices, keeping only bounded result buckets. */
export async function searchCatalog(query: string, catalog: SearchCatalog, signal?: AbortSignal): Promise<SearchHit[]> {
  throwIfAborted(signal);
  const words = queryWords(query.trim());
  if (query.trim().length < 2 || !words.length) return [];
  // Always give the input/remote and React a turn before touching a large library.
  await yieldToUI(signal);
  let sliceStart = clock();
  let scanned = 0;
  const kinds: SearchHit['kind'][] = ['channel', 'movie', 'series'];
  const ranked: { hit: SearchHit; score: number; kind: number }[] = [];
  for (let kind = 0; kind < kinds.length; kind++) {
    const limit = kind === 0 ? 150 : 120;
    const buckets: SearchHit[][] = [[], [], [], []];
    const ids = new Set<string>();
    const unique = new Set<string>();
    const lists = kind === 0 ? [catalog.channels] : Object.values(kind === 1 ? catalog.movies : catalog.series);
    for (const list of lists) {
      for (const item of list) {
        // Check the clock in batches so the scheduler itself stays inexpensive.
        if ((++scanned & 63) === 0) {
          throwIfAborted(signal);
          if (clock() - sliceStart >= 4) {
            await yieldToUI(signal);
            sliceStart = clock();
          }
        }
        if (ids.has(item.id)) continue;
        ids.add(item.id);
        const title = titleFor(item);
        const score = matchScore(words, title);
        if (!score || buckets[score].length >= limit) continue;
        const dup = title + (kind === 0 ? '' : ':' + (('year' in item && item.year) || ''));
        if (unique.has(dup)) continue;
        unique.add(dup);
        buckets[score].push({ kind: kinds[kind], item } as SearchHit);
      }
    }
    let added = 0;
    for (let score = 3; score > 0 && added < limit; score--) {
      for (const hit of buckets[score]) {
        if (added++ >= limit) break;
        ranked.push({ hit, score, kind });
      }
    }
  }
  throwIfAborted(signal);
  ranked.sort((a, b) => b.score - a.score || a.kind - b.kind);
  return ranked.map((entry) => entry.hit);
}
