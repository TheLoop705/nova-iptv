/** Let input handlers and React commits run between batches of background work. */
export function yieldToUI(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => throwIfAborted(signal));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Operation cancelled');
  error.name = 'AbortError';
  throw error;
}

/** Call at bounded intervals in a loop; await only when the time budget expires. */
export function createCheckpoint(signal?: AbortSignal, budgetMs = 8): () => Promise<void> | undefined {
  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  let deadline = now() + budgetMs;
  return () => {
    throwIfAborted(signal);
    if (now() < deadline) return;
    return yieldToUI(signal).then(() => { deadline = now() + budgetMs; });
  };
}
