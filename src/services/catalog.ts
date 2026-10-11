import { createCheckpoint, throwIfAborted } from '../utils/cooperative';

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
  private checkpoint: () => Promise<void> | undefined;

  constructor(private normalize: (value: any) => T | undefined, signal?: AbortSignal) {
    this.checkpoint = createCheckpoint(signal);
  }

  async push(chunk: string): Promise<void> {
    this.buffer += chunk;
    while (this.cursor < this.buffer.length) {
      if ((this.cursor & 2047) === 0) {
        const pause = this.checkpoint();
        if (pause) await pause;
      }
      const c = this.buffer[this.cursor];
      if (this.closed) {
        if (!/\s/.test(c)) throw new Error('Unexpected data after catalog');
        this.cursor++;
        continue;
      }
      if (!this.root) {
        if (/\s|\uFEFF/.test(c)) { this.cursor++; continue; }
        if (c !== '[' && c !== '{') throw new Error('Expected a catalog collection');
        this.root = c;
        this.start = ++this.cursor;
        continue;
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.inString = false;
      } else if (c === '"') this.inString = true;
      else if (c === '[' || c === '{') this.depth++;
      else if (c === ']' || c === '}') {
        if (this.depth > 0) this.depth--;
        else {
          if (c !== (this.root === '[' ? ']' : '}')) throw new Error('Invalid catalog collection');
          this.readValue(this.buffer.slice(this.start, this.cursor), true);
          this.closed = true;
          this.start = this.cursor + 1;
        }
      } else if (c === ',' && this.depth === 0) {
        this.readValue(this.buffer.slice(this.start, this.cursor));
        this.afterComma = true;
        this.start = this.cursor + 1;
      }
      this.cursor++;
    }
    // Retain only the current incomplete record, rather than the entire response.
    if (this.start) {
      this.buffer = this.buffer.slice(this.start);
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
