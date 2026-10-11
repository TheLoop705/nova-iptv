/** Small LRU cache with shared pending requests and generation-safe invalidation. */
export class SharedRequestCache<T> {
  private values = new Map<string, T>();
  private pending = new Map<string, Promise<T>>();
  private generation = 0;

  constructor(private maxEntries = 24) {}

  get(key: string): T | undefined {
    if (!this.values.has(key)) return;
    const value = this.values.get(key)!;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  entries(): IterableIterator<[string, T]> { return this.values.entries(); }

  load(key: string, fetchValue: () => Promise<T>): Promise<T> {
    if (this.values.has(key)) return Promise.resolve(this.get(key)!);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const request = Promise.resolve().then(fetchValue).then((value) => {
      if (generation === this.generation) {
        this.values.set(key, value);
        while (this.values.size > this.maxEntries) this.values.delete(this.values.keys().next().value!);
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  clear(): void {
    this.generation++;
    this.values.clear();
    this.pending.clear();
  }
}
