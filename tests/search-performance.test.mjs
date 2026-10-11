import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { appModule } from './helpers/load-app-module.mjs';

const { searchCatalog } = await appModule('src/services/catalogSearch.ts');
const empty = { channels: [], movies: {}, series: {} };
const movie = (id, name) => ({ id, name, categoryId: '1' });

test('search ranks late exact matches and bounds results across an entire category', async () => {
  const items = Array.from({ length: 1000 }, (_, i) => movie(String(i), `Target Film ${i}`));
  items.push(movie('exact', 'Target Film'));
  const hits = await searchCatalog('target film', { ...empty, movies: { '1': items } });
  assert.equal(hits.length, 120);
  assert.equal(hits[0].item.id, 'exact');
});

test('movies and series with the same provider id both appear, and category copies are deduplicated', async () => {
  const item = movie('42', 'Channel 4');
  const catalog = {
    ...empty,
    movies: { '1': [item, movie('43', 'Channel 4')], '2': [item] },
    series: { '1': [{ ...item, seriesId: 42 }] },
  };
  const hits = await searchCatalog('channel four', catalog);
  assert.deepEqual(hits.map((hit) => hit.kind), ['movie', 'series']);
});

test('large no-match searches yield to input and can be cancelled before publication', async () => {
  const items = Array.from({ length: 100000 }, (_, i) => movie(String(i), `International Movie ${i} UHD Full HD`));
  let ticks = 0;
  let last = performance.now();
  let maximumGap = 0;
  const heartbeat = setInterval(() => {
    const current = performance.now();
    maximumGap = Math.max(maximumGap, current - last);
    last = current;
    ticks++;
  }, 1);
  try {
    const start = performance.now();
    const hits = await searchCatalog('missing title', { ...empty, movies: { '1': items } });
    assert.deepEqual(hits, []);
    assert.ok(ticks >= 5, `Input only got ${ticks} turns while scanning 100,000 titles`);
    // A generous portable budget; browser/device tests enforce their own latency budgets.
    assert.ok(maximumGap < 250, `Search blocked the event loop for ${maximumGap.toFixed(1)} ms`);
    console.log(JSON.stringify({ workload: 'search 100000 titles', totalMs: performance.now() - start, maximumHeartbeatGapMs: maximumGap, inputTurns: ticks }));
    const controller = new AbortController();
    const pending = searchCatalog('international', { ...empty, movies: { '1': items } }, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    clearInterval(heartbeat);
  }
});

test('already aborted searches do no work and changed titles invalidate normalized cache entries', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchCatalog('film', empty, controller.signal), { name: 'AbortError' });
  const item = movie('1', 'Old Film');
  const catalog = { ...empty, movies: { '1': [item] } };
  assert.equal((await searchCatalog('old film', catalog)).length, 1);
  item.name = 'New Film';
  assert.equal((await searchCatalog('old film', catalog)).length, 0);
  assert.equal((await searchCatalog('new film', catalog)).length, 1);
});
