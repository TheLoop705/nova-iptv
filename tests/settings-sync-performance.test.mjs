import test from 'node:test';
import assert from 'node:assert/strict';
import { appModule } from './helpers/load-app-module.mjs';

const { diffDoc, diffDocAsync, applyOps } = await appModule('src/utils/docPatch.ts');

test('cooperative settings changes preserve field operations, deletions and prototype guards', async () => {
  const before = { progress: { one: { pos: 10 }, two: { pos: 20 } }, favorites: ['a'], removed: 1 };
  const after = { progress: { one: { pos: 11 }, three: { pos: 30 } }, favorites: ['a'], added: false };
  const sync = diffDoc(before, after);
  assert.deepEqual(await diffDocAsync(before, after), sync);
  assert.deepEqual(applyOps(before, sync), after);
  assert.deepEqual(await diffDocAsync(before, structuredClone(before)), []);
  const unsafe = JSON.parse('{"__proto__":{"injected":true},"constructor":1}');
  assert.deepEqual(await diffDocAsync({}, unsafe), []);
});

test('large watch histories yield and send only the changed progress entry', async () => {
  const progress = Object.fromEntries(Array.from({ length: 50000 }, (_, i) => [`movie:${i}`, { pos: 10, dur: 100, at: i }]));
  const before = { vodProgress: progress };
  const after = structuredClone(before);
  after.vodProgress['movie:49999'].pos = 20;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const ops = await diffDocAsync(before, after);
    assert.deepEqual(ops, [{ path: ['vodProgress', 'movie:49999'], value: after.vodProgress['movie:49999'] }]);
    assert.ok(ticks > 0, 'Settings comparison did not yield to input');
  } finally {
    clearInterval(timer);
  }
});
