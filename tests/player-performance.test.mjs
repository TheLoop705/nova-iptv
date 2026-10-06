import test from 'node:test';
import assert from 'node:assert/strict';
import { appModule } from './helpers/load-app-module.mjs';

const { createSourceLoader } = await appModule('src/player/sourceLoad.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('a late native asset cannot play after a stream change', async () => {
  const first = deferred();
  const played = [];
  const loader = createSourceLoader((source) => source === 'first' ? first.promise : Promise.resolve());
  const old = loader.load('first', () => played.push('first'), () => assert.fail('stale error'));
  await Promise.resolve();
  await loader.load('second', () => played.push('second'), () => assert.fail('current error'));
  first.resolve();
  await old;
  assert.deepEqual(played, ['second']);
});

test('unmount and superseded errors do not update playback', async () => {
  const asset = deferred();
  const loader = createSourceLoader(() => asset.promise);
  const old = loader.load('first', () => assert.fail('stale play'), () => assert.fail('stale error'));
  await Promise.resolve();
  loader.cancel();
  asset.reject(new Error('native load failed'));
  await old;
});

test('only the latest queued native source loads and synchronous failures are handled', async () => {
  const calls = [];
  const loader = createSourceLoader((source) => {
    calls.push(source);
    throw new Error('released native player');
  });
  let failures = 0;
  const old = loader.load('first', () => assert.fail('play'), () => assert.fail('stale error'));
  const current = loader.load('second', () => assert.fail('play'), () => failures++);
  await Promise.all([old, current]);
  assert.deepEqual(calls, ['second']);
  assert.equal(failures, 1);
});
