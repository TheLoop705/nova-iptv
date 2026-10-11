import test from 'node:test';
import assert from 'node:assert/strict';
import { appModule } from './helpers/load-app-module.mjs';

process.env.EXPO_PUBLIC_PERF_MONITOR = '1';
const monitor = await appModule('src/services/performance.ts');

test('diagnostics retain bounded numeric samples and reset all counters', () => {
  for (let i = 0; i < 1000; i++) monitor.beginKeySample()();
  const snapshot = monitor.performanceSnapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.keyHandlerMs.count, 1000);
  assert.equal(snapshot.keyHandlerMs.samples, 512);
  assert.ok(snapshot.keyHandlerMs.max >= snapshot.keyHandlerMs.p95);
  assert.ok(!JSON.stringify(snapshot).includes('password'));
  monitor.resetPerformance();
  assert.equal(monitor.performanceSnapshot().keyHandlerMs.count, 0);
});

test('monitor stops cleanly and ignores background sampling', async () => {
  const stop = monitor.startPerformanceMonitor(() => false);
  await new Promise((resolve) => setTimeout(resolve, 75));
  stop();
  assert.equal(monitor.performanceSnapshot().eventLoopLagMs.count, 0);
});
