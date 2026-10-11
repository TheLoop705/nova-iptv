import test from 'node:test';
import assert from 'node:assert/strict';
import { appModule } from './helpers/load-app-module.mjs';

// Exercise Home's real row derivation without mounting a native renderer.
// Memoization is transparent here; the input/output and loading states matter.
globalThis.__homeLibrary = {};
globalThis.__homeSettings = { history: {}, vodFavorites: {}, favCategories: {} };
const { useHomeRows } = await appModule('src/screens/home/rows.ts', {
  react: 'export const useMemo = (compute) => compute();',
  'src/store/library': 'export const useLibrary = (select) => select(globalThis.__homeLibrary);',
  'src/store/settings': 'export const useSettings = (select) => select(globalThis.__homeSettings); export const favCatKey = (...args) => args.join(":");',
});
test.beforeEach(() => {
  globalThis.__homeLibrary = { playlistId: 'a', movieCats: null, seriesCats: null, movies: {}, series: {}, vodStatus: {} };
});

test('Home shows movie rows before series categories finish and retains row keys when they arrive', () => {
  const state = globalThis.__homeLibrary;
  state.movieCats = [{ id: '1', name: 'Movies' }];
  state.movies['1'] = [{ id: 'v1', categoryId: '1', name: 'Movie' }];
  let result = useHomeRows();
  assert.equal(result.catsKnown, false);
  assert.deepEqual(result.rows.map((row) => row.key), ['m:1']);
  assert.equal(result.rows[0].entries[0].item.id, 'v1');
  state.seriesCats = [{ id: '1', name: 'Series' }];
  result = useHomeRows();
  assert.equal(result.catsKnown, true);
  assert.deepEqual(result.rows.map((row) => row.key), ['m:1', 's:1']);
});

test('Home shows series first too, and a failed movie endpoint does not leave a perpetual loading screen', () => {
  const state = globalThis.__homeLibrary;
  state.seriesCats = [{ id: '1', name: 'Series' }];
  assert.deepEqual(useHomeRows().rows.map((row) => row.key), ['s:1']);
  assert.equal(useHomeRows('series').rows.length, 1);
  state.vodStatus.movieCats = 'error';
  assert.equal(useHomeRows().catsKnown, true);
  state.seriesCats = [];
  assert.equal(useHomeRows().catsKnown, true);
  assert.equal(useHomeRows().rows.length, 0);
});

test('Home keeps poster work bounded for large categories and exposes the rest through See all', () => {
  const state = globalThis.__homeLibrary;
  state.movieCats = [{ id: '1', name: 'Movies' }];
  state.movies['1'] = Array.from({ length: 25000 }, (_, i) => ({ id: 'v' + i, categoryId: '1', name: 'Movie ' + i }));
  const row = useHomeRows().rows[0];
  assert.equal(row.entries.length, 31);
  assert.equal(row.entries.at(-1).type, 'more');
  assert.equal(row.entries.at(-1).total, 25000);
});

test('failed Home categories remain visible for an explicit retry instead of disappearing', () => {
  const state = globalThis.__homeLibrary;
  state.movieCats = [{ id: '1', name: 'Movies' }];
  state.vodStatus['m:1'] = 'error';
  const row = useHomeRows().rows[0];
  assert.equal(row.key, 'm:1');
  assert.equal(row.error, true);
  assert.equal(row.loading, false);
});
