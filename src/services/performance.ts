/** Optional local diagnostics: fixed-size numeric samples, with no URLs, queries or credentials. */
const ENABLED = process.env.EXPO_PUBLIC_PERF_MONITOR === '1';
const SAMPLE_LIMIT = 512;
const samples = { eventLoopLagMs: [] as number[], keyToFrameMs: [] as number[], keyHandlerMs: [] as number[] };
const totals = { eventLoopLagMs: 0, keyToFrameMs: 0, keyHandlerMs: 0 };
const maxima = { eventLoopLagMs: 0, keyToFrameMs: 0, keyHandlerMs: 0 };
const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

function record(kind: keyof typeof samples, elapsed: number) {
  totals[kind]++;
  maxima[kind] = Math.max(maxima[kind], elapsed);
  const list = samples[kind];
  if (list.length === SAMPLE_LIMIT) list.shift();
  list.push(elapsed);
}

export function performanceSnapshot() {
  const summary = (kind: keyof typeof samples) => {
    const sorted = [...samples[kind]].sort((a, b) => a - b);
    return { count: totals[kind], max: maxima[kind], p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0, samples: sorted.length };
  };
  return { enabled: ENABLED, eventLoopLagMs: summary('eventLoopLagMs'), keyToFrameMs: summary('keyToFrameMs'), keyHandlerMs: summary('keyHandlerMs') };
}

export function resetPerformance() {
  for (const kind of Object.keys(samples) as (keyof typeof samples)[]) {
    samples[kind].length = 0;
    totals[kind] = 0;
    maxima[kind] = 0;
  }
}

/** Called around key routing only when diagnostic sampling is enabled. */
export function beginKeySample(): (() => void) | undefined {
  if (!ENABLED) return;
  const start = now();
  return () => {
    record('keyHandlerMs', now() - start);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => record('keyToFrameMs', now() - start));
  };
}

export function startPerformanceMonitor(
  isActive: () => boolean = () => true,
  logNative = false,
  subscribeToVisibility?: (changed: () => void) => () => void,
): () => void {
  if (!ENABLED) return () => {};
  let expected = now() + 50;
  const resetTimer = () => { expected = now() + 50; };
  const unsubscribe = subscribeToVisibility?.(resetTimer);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resetTimer);
  const timer = setInterval(() => {
    const current = now();
    if (isActive()) record('eventLoopLagMs', Math.max(0, current - expected));
    expected = current + 50;
  }, 50);
  const diagnostics = { snapshot: performanceSnapshot, reset: resetPerformance };
  const reporter = logNative ? setInterval(() => {
    if (isActive()) console.info('NOVA_PERF ' + JSON.stringify(performanceSnapshot()));
  }, 5000) : undefined;
  if (typeof window !== 'undefined') (window as any).__novaPerf = diagnostics;
  return () => {
    clearInterval(timer);
    unsubscribe?.();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resetTimer);
    if (reporter) clearInterval(reporter);
    if (typeof window !== 'undefined' && (window as any).__novaPerf === diagnostics) delete (window as any).__novaPerf;
  };
}
