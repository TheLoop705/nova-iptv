import { createCheckpoint, throwIfAborted } from '../utils/cooperative';

// The native regex engine jumps between the few characters that matter instead of JS visiting every one.
// Shared by all parsers: never await between setting lastIndex and exec.
const STRUCTURAL = /["\[\]{},]/g;
const STRING_END = /["\\]/g;

/**
 * Read large Xtream array/object collections a record at a time. Keeping JSON.parse
 * bounded to one title avoids blocking the JS input thread with a whole catalog.
 */
export class CatalogJsonParser<T> {
  private buffer = '';
  private cursor = 0;
  private start = 0;
  private root?: '[' | '{';
  private closed = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private result: T[] = [];
  private records = 0;
  private afterComma = false;
  private sinceYield = 0;
  private checkpoint: () => Promise<void> | undefined;

  constructor(private normalize: (value: any) => T | undefined, signal?: AbortSignal) {
    this.checkpoint = createCheckpoint(signal);
  }

  async push(chunk: string): Promise<void> {
    this.buffer += chunk;
    const buffer = this.buffer;
    const length = buffer.length;
    let cursor = this.cursor;
    // Also what rejects an already-cancelled load before any work is done.
    const pause = this.checkpoint();
    if (pause) await pause;
    while (cursor < length) {
      if (this.closed) {
        if (!/\s/.test(buffer[cursor])) throw new Error('Unexpected data after catalog');
        cursor++;
        continue;
      }
      if (!this.root) {
        const c = buffer[cursor];
        if (/\s|\uFEFF/.test(c)) { cursor++; continue; }
        if (c !== '[' && c !== '{') throw new Error('Expected a catalog collection');
        this.root = c;
        this.start = ++cursor;
        continue;
      }
      if (this.inString) {
        // An escape can be split across chunks, so the escaped character is skipped on its own.
        if (this.escaped) { this.escaped = false; cursor++; continue; }
        STRING_END.lastIndex = cursor;
        const hit = STRING_END.exec(buffer);
        if (!hit) { cursor = length; break; }
        if (buffer.charCodeAt(hit.index) === 92) this.escaped = true;
        else this.inString = false;
        cursor = hit.index + 1;
        continue;
      }
      STRUCTURAL.lastIndex = cursor;
      const hit = STRUCTURAL.exec(buffer);
      if (!hit) { cursor = length; break; }
      cursor = hit.index;
      const code = buffer.charCodeAt(cursor);
      if (code === 34) this.inString = true;
      else if (code === 91 || code === 123) this.depth++;
      else if (code === 93 || code === 125) {
        if (this.depth > 0) this.depth--;
        else {
          if (code !== (this.root === '[' ? 93 : 125)) throw new Error('Invalid catalog collection');
          this.readValue(buffer.slice(this.start, cursor), true);
          this.closed = true;
          this.start = cursor + 1;
        }
      } else if (this.depth === 0) {
        this.readValue(buffer.slice(this.start, cursor));
        this.afterComma = true;
        this.start = cursor + 1;
        if ((++this.sinceYield & 15) === 0) {
          const pause = this.checkpoint();
          if (pause) await pause;
        }
      }
      cursor++;
    }
    this.cursor = cursor;
    // Retain only the current incomplete record, rather than the entire response.
    if (this.start) {
      this.buffer = buffer.slice(this.start);
      this.cursor -= this.start;
      this.start = 0;
    }
  }

  finish(): T[] {
    if (!this.closed || this.inString || this.depth) throw new Error('Incomplete catalog response');
    if (this.records && !this.result.length) throw new Error('Catalog response contained no valid entries');
    return this.result;
  }

  private readValue(text: string, final = false): void {
    if (!text.trim()) {
      if (!final || this.afterComma) throw new Error('Missing catalog entry');
      return;
    }
    this.records++;
    this.afterComma = false;
    const value = this.root === '[' ? JSON.parse(text) : Object.values(JSON.parse(`{${text}}`))[0];
    const item = this.normalize(value);
    if (item !== undefined) this.result.push(item);
  }
}

/** Group/count once outside render, yielding while large libraries are indexed. */
export async function groupCatalog<T extends { id: string; categoryId: string }>(items: T[], signal?: AbortSignal) {
  throwIfAborted(signal);
  const byCategory: Record<string, T[]> = Object.create(null);
  const ids = new Set<string>();
  const checkpoint = createCheckpoint(signal);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    (byCategory[item.categoryId] ??= []).push(item);
    ids.add(item.id);
    if ((i & 255) === 0) {
      const pause = checkpoint();
      if (pause) await pause;
    }
  }
  return { byCategory, count: ids.size };
}
