import test from 'node:test';
import assert from 'node:assert/strict';
import { appModule } from './helpers/load-app-module.mjs';

let files = [];
const removed = new Set();
let deleteMs = 0;
class NativeFile {
  constructor(_directory, name) { this.name = name; }
  delete() {
    // Simulate synchronous native filesystem work, without creating or deleting
    // real application files. Input must run before the operation completes.
    const end = performance.now() + deleteMs;
    while (performance.now() < end) {}
    removed.add(this.name);
  }
}
globalThis.__nativeCacheFs = {
  File: NativeFile,
  Directory: class { exists = true; list() { return files; } },
  Paths: { document: 'isolated-documents' },
};
const { removeByPrefix } = await appModule('src/services/storage.ts', {
  'expo-file-system': 'export const { File, Directory, Paths } = globalThis.__nativeCacheFs;',
});
test.after(() => { delete globalThis.__nativeCacheFs; });
test.afterEach(() => { files = []; removed.clear(); deleteMs = 0; });

test('native category cache clearing preserves settings and other playlist caches', async () => {
  files = ['vod_playlist_a.json', 'vod_playlist_b.json', 'vod_other_a.json', 'settings.json']
    .map((name) => new NativeFile(null, name));
  // Non-file entries with a similar name must not be deleted recursively.
  let removedDirectory = false;
  files.push({ name: 'vod_playlist_directory', delete() { removedDirectory = true; } });
  await removeByPrefix('vod:playlist:');
  assert.deepEqual([...removed].sort(), ['vod_playlist_a.json', 'vod_playlist_b.json']);
  assert.equal(removedDirectory, false);
});

test('clearing hundreds of native cache pages lets input run before all files are removed', async (t) => {
  const pages = 400;
  files = Array.from({ length: pages }, (_, i) => new NativeFile(null, 'vod_playlist_' + i + '.json'));
  deleteMs = 0.5;
  const inputObservations = [];
  const timer = setInterval(() => inputObservations.push(removed.size), 1);
  const started = performance.now();
  try {
    await removeByPrefix('vod:playlist:');
    assert.equal(removed.size, pages);
    assert.ok(inputObservations.some((count) => count > 0 && count < pages), 'Native deletion blocked input until the entire cache was removed');
    t.diagnostic(JSON.stringify({ pages, elapsedMs: performance.now() - started, inputTurns: inputObservations.length }));
  } finally { clearInterval(timer); }
});
