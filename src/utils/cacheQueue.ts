const operations = new Map<string, Promise<unknown>>();

/** Keep a paged cache reader, writer and clear operation consistent per playlist. */
export function withCacheLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = operations.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(work);
  operations.set(key, result);
  void result.finally(() => { if (operations.get(key) === result) operations.delete(key); }).catch(() => {});
  return result;
}
