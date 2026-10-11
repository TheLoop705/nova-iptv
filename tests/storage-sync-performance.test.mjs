import test from 'node:test';
import assert from 'node:assert/strict';
import { appModule } from './helpers/load-app-module.mjs';

const visibility = [];
globalThis.document = { visibilityState: 'visible', addEventListener(name, handler) { if (name === 'visibilitychange') visibility.push(handler); } };
const storage = await appModule('src/services/storage.web.ts', {
  'idb-keyval': 'export const createStore = () => ({}); export const get = async () => null; export const set = async () => {}; export const del = async () => {}; export const keys = async () => []; export const delMany = async () => {};',
});
const { applyOps } = await appModule('src/utils/docPatch.ts');
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; delete globalThis.document; });
const progress = () => Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => ['movie:' + i, { pos: 10, dur: 100, at: i }]));
const initial = () => ({ prefs: { userAgent: '', clock24: true }, favorites: { test: [] }, vodProgress: progress() });
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a batch of progress operations preserves the original nested document', () => {
  const before = { progress: { one: { pos: 1 }, two: { pos: 2 } }, prefs: { clock24: true } };
  const after = applyOps(before, [
    { path: ['progress', 'one'], value: { pos: 3 } },
    { path: ['progress', 'two'], delete: true },
    { path: ['progress', 'three'], value: { pos: 4 } },
  ]);
  assert.deepEqual(before.progress, { one: { pos: 1 }, two: { pos: 2 } });
  assert.deepEqual(after.progress, { one: { pos: 3 }, three: { pos: 4 } });
  assert.equal(after.prefs, before.prefs);
});

test('whole-field replacement between nested operations does not mutate the replacement value', () => {
  const replacement = { two: { pos: 2 } };
  const after = applyOps({ progress: { one: { pos: 1 } } }, [
    { path: ['progress', 'one'], value: { pos: 3 } },
    { path: ['progress'], value: replacement },
    { path: ['progress', 'three'], value: { pos: 4 } },
  ]);
  assert.deepEqual(replacement, { two: { pos: 2 } });
  assert.deepEqual(after.progress, { two: { pos: 2 }, three: { pos: 4 } });
});

test('an unsaved settings edit made during an asynchronous remote comparison survives the incoming merge', async () => {
  let server = initial();
  let current = structuredClone(server);
  let changed = false;
  globalThis.fetch = async (_url, opts) => {
    if (opts.method === 'PATCH') {
      server = applyOps(server, JSON.parse(opts.body).ops);
      server = { ...server, prefs: { ...server.prefs, userAgent: 'remote' } };
      // The diff of a large cloned progress library yields after the PATCH response.
      setTimeout(() => { current = { ...current, prefs: { ...current.prefs, userAgent: 'new-local' } }; changed = true; }, 0);
    }
    return new Response(JSON.stringify({ value: server }));
  };
  await storage.getItem('settings');
  const unsubscribe = storage.onRemoteChange('settings', (ops) => { current = applyOps(current, ops); }, () => current);
  try {
    current = { ...current, favorites: { test: ['one'] } };
    await storage.setItem('settings', current);
    assert.equal(changed, true, 'The comparison never reached its asynchronous yield');
    assert.equal(current.prefs.userAgent, 'new-local', 'Remote merge overwrote a newer unsaved edit');
  } finally { unsubscribe(); }
});

test('queued settings snapshots preserve remote fields that they did not change locally', async () => {
  let server = initial();
  let current = structuredClone(server);
  let patches = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.method === 'PATCH') {
      server = applyOps(server, JSON.parse(opts.body).ops);
      if (++patches === 1) server = { ...server, prefs: { ...server.prefs, userAgent: 'remote' } };
    }
    return new Response(JSON.stringify({ value: server }));
  };
  await storage.getItem('settings');
  const unsubscribe = storage.onRemoteChange('settings', (ops) => { current = applyOps(current, ops); }, () => current);
  try {
    current = { ...current, favorites: { test: ['one'] } };
    const first = storage.setItem('settings', current);
    current = { ...current, vodProgress: { ...current.vodProgress, 'movie:49999': { pos: 20, dur: 100, at: 49999 } } };
    const second = storage.setItem('settings', current);
    await Promise.all([first, second]);
    assert.equal(patches, 2);
    assert.equal(server.prefs.userAgent, 'remote', 'A queued raw snapshot reverted another device’s edit');
    assert.equal(current.prefs.userAgent, 'remote');
    assert.equal(server.vodProgress['movie:49999'].pos, 20);
  } finally { unsubscribe(); }
});

test('newer queued edits on the same field win over an earlier remote merge', async () => {
  let server = initial();
  let current = structuredClone(server);
  let patches = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.method === 'PATCH') {
      server = applyOps(server, JSON.parse(opts.body).ops);
      if (++patches === 1) server = { ...server, prefs: { ...server.prefs, userAgent: 'remote' } };
    }
    return new Response(JSON.stringify({ value: server }));
  };
  await storage.getItem('settings');
  const unsubscribe = storage.onRemoteChange('settings', (ops) => { current = applyOps(current, ops); }, () => current);
  try {
    current = { ...current, favorites: { test: ['one'] } };
    const first = storage.setItem('settings', current);
    current = { ...current, prefs: { ...current.prefs, userAgent: 'queued-local' } };
    const second = storage.setItem('settings', current);
    await Promise.all([first, second]);
    assert.equal(current.prefs.userAgent, 'queued-local');
    assert.equal(server.prefs.userAgent, 'queued-local');
  } finally { unsubscribe(); }
});

test('failed local intents are retried when the same document is flushed again', async () => {
  let server = { prefs: {}, favorites: { test: [] } };
  let calls = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.method === 'PATCH') {
      if (++calls === 1) return new Response('{}', { status: 503 });
      server = applyOps(server, JSON.parse(opts.body).ops);
    }
    return new Response(JSON.stringify({ value: server }));
  };
  await storage.getItem('settings');
  const document = { ...server, favorites: { test: ['retry'] } };
  await assert.rejects(storage.setItem('settings', document), /HTTP 503/);
  await storage.setItem('settings', document);
  assert.deepEqual(server.favorites.test, ['retry']);
});

test('visibility pulls preserve unsaved local edits and merge unrelated remote fields', async () => {
  let server = { prefs: { userAgent: '', clock24: true } };
  let current = structuredClone(server);
  globalThis.fetch = async () => new Response(JSON.stringify({ value: server }));
  await storage.getItem('settings');
  const unsubscribe = storage.onRemoteChange('settings', (ops) => { current = applyOps(current, ops); }, () => current);
  try {
    current = { prefs: { userAgent: 'unsaved', clock24: true } };
    server = { prefs: { userAgent: 'remote', clock24: false } };
    for (const callback of visibility) callback();
    for (let i = 0; i < 50 && current.prefs.clock24; i++) await pause();
    assert.equal(current.prefs.userAgent, 'unsaved');
    assert.equal(current.prefs.clock24, false);
  } finally { unsubscribe(); }
});
