import test from 'node:test';
import assert from 'node:assert/strict';
import { appModule } from './helpers/load-app-module.mjs';

const { readBrowsePosition, saveBrowsePosition, clearBrowsePositions } = await appModule('src/services/browseMemory.ts');
test('browsing positions belong to a playlist and section and can be invalidated independently', () => {
  const movies = { selected: '10', itemId: 'v50', offset: 900 };
  saveBrowsePosition('a', 'movies', movies);
  saveBrowsePosition('a', 'series', { selected: '20' });
  saveBrowsePosition('b', 'movies', { selected: '11' });
  assert.deepEqual(readBrowsePosition('a', 'movies'), movies);
  assert.equal(readBrowsePosition('a', 'series').selected, '20');
  assert.equal(readBrowsePosition('b', 'movies').selected, '11');
  clearBrowsePositions('a');
  assert.equal(readBrowsePosition('a', 'movies'), undefined);
  assert.equal(readBrowsePosition('b', 'movies').selected, '11');
});
test('session memory is bounded and reading a position protects it from least-recently-used eviction', () => {
  for (let i = 0; i < 256; i++) saveBrowsePosition('bound', String(i), { offset: i });
  readBrowsePosition('bound', '0');
  saveBrowsePosition('bound', 'new', { offset: 257 });
  assert.deepEqual(readBrowsePosition('bound', '0'), { offset: 0 });
  assert.equal(readBrowsePosition('bound', '1'), undefined);
});
