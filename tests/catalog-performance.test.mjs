import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogJsonParser, groupCatalog } from '../src/services/catalog.ts';
import { parseM3U, parseM3UAsync } from '../src/services/m3u.ts';
import { SharedRequestCache } from '../src/services/requestCache.ts';

const normalize = (value) => value && typeof value === 'object' && value.id != null ? value : undefined;

test('streamed catalog preserves quotes, nested values and keyed provider responses across every boundary', async () => {
  const values = [{ id: '1', categoryId: 'a', name: 'Film \\"[] {}, 🎬', nested: { cast: ['a,b', '\\end'] } }, { id: '2', categoryId: 'b', name: 'Deux' }];
  for (const raw of [JSON.stringify(values), JSON.stringify({ 10: values[0], 20: values[1] })]) {
    for (const size of [1, 2, 7, 31, 1024]) {
      const parser = new CatalogJsonParser(normalize);
      for (let i = 0; i < raw.length; i += size) await parser.push(raw.slice(i, i + size));
      assert.deepEqual(parser.finish(), values);
    }
  }
});

test('malformed/truncated/error catalog responses cannot become successful empty catalogs', async () => {
  for (const raw of ['[{"id":"1"}', '[{"id":"1"},]', '[,{"id":"1"}]', '{"error":"denied"}', '[]extra', '<html>bad provider</html>']) {
    const parser = new CatalogJsonParser(normalize);
    await assert.rejects(async () => { await parser.push(raw); parser.finish(); });
  }
  for (const raw of ['[]', '{}', ' \uFEFF[ ]\n']) {
    const parser = new CatalogJsonParser(normalize);
    await parser.push(raw);
    assert.deepEqual(parser.finish(), []);
  }
});

test('large catalog parsing/grouping services input timers and counts IDs across categories once', async (t) => {
  const items = Array.from({ length: 100_000 }, (_, i) => ({ id: String(i % 90_000), categoryId: String(i % 100), name: `Movie ${i}`, plot: 'Large catalog regression fixture' }));
  const raw = JSON.stringify(items);
  const baselineStart = performance.now();
  const baselineIds = new Set(JSON.parse(raw).map((item) => item.id));
  const baselineMs = performance.now() - baselineStart;
  assert.equal(baselineIds.size, 90_000);
  const parser = new CatalogJsonParser(normalize);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const start = performance.now();
  try {
    await parser.push(raw);
    const data = await groupCatalog(parser.finish());
    assert.equal(data.count, 90_000);
    assert.equal(Object.keys(data.byCategory).length, 100);
    assert.ok(ticks > 1, `Input timer should run during a large catalog, got ${ticks} ticks`);
    t.diagnostic(`100,000 records (${(raw.length / 1048576).toFixed(1)} MB): whole-body JSON parsing/counting blocked for ${baselineMs.toFixed(0)} ms; streaming parse/group in ${(performance.now() - start).toFixed(0)} ms with ${ticks} input timer opportunities`);
  } finally { clearInterval(timer); }
});

test('catalog grouping handles arbitrary category names without prototype collisions', async () => {
  const result = await groupCatalog([{ id: 'a', categoryId: '__proto__' }, { id: 'a', categoryId: 'constructor' }]);
  assert.equal(result.count, 1);
  assert.equal(result.byCategory.__proto__[0].id, 'a');
  assert.equal(result.byCategory.constructor[0].id, 'a');
});

test('large M3U URL/import parsing yields and remains equivalent to synchronous parsing', async (t) => {
  const text = '#EXTM3U url-tvg="https://example.test/guide.xml" catchup="append" catchup-days="3"\n' +
    Array.from({ length: 50_000 }, (_, i) => `#EXTINF:-1 tvg-id="ch${i}" group-title="Group ${i % 50}" tvg-chno="${i % 10 === 0 ? i + 1 : ''}" tvg-logo="https://example.test/logo.png",Channel ${i}\nhttps://example.test/${i % 17 === 0 ? 'movie' : 'live'}/${i}.${i % 17 === 0 ? 'mp4' : 'ts'}\n`).join('');
  const expected = parseM3U(text);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const start = performance.now();
  let actual;
  try {
    actual = await parseM3UAsync(text);
    assert.ok(ticks > 1, `Input timer should run during a large M3U, got ${ticks} ticks`);
    t.diagnostic(`50,000 M3U entries parsed in ${(performance.now() - start).toFixed(0)} ms; ${ticks} input timer opportunities`);
  } finally { clearInterval(timer); }
  assert.deepEqual(actual, expected);
});

test('catalog and M3U background work stops when cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const parser = new CatalogJsonParser(normalize, controller.signal);
  await assert.rejects(parser.push('[{"id":"1"}]'), { name: 'AbortError' });
  await assert.rejects(groupCatalog([{ id: '1', categoryId: 'a' }], controller.signal), { name: 'AbortError' });
  await assert.rejects(groupCatalog([], controller.signal), { name: 'AbortError' });
  await assert.rejects(parseM3UAsync('#EXTM3U\n#EXTINF:-1,One\nhttps://example.test/live/1.ts', controller.signal), { name: 'AbortError' });
  await assert.rejects(parseM3UAsync('', controller.signal), { name: 'AbortError' });
});

test('detail requests coalesce, cache hits avoid downloads, and LRU memory is bounded', async () => {
  const cache = new SharedRequestCache(2);
  let resolve;
  let calls = 0;
  const fetch = () => { calls++; return new Promise((r) => { resolve = r; }); };
  const first = cache.load('provider-a:series:1', fetch);
  const second = cache.load('provider-a:series:1', fetch);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(first, second);
  resolve({ id: 'a' });
  await first;
  assert.deepEqual(await cache.load('provider-a:series:1', () => { throw Error('unnecessary request'); }), { id: 'a' });
  await cache.load('two', async () => ({ id: 'b' }));
  cache.get('provider-a:series:1');
  await cache.load('three', async () => ({ id: 'c' }));
  assert.equal(cache.get('two'), undefined);
  assert.equal([...cache.entries()].length, 2);
});

test('invalidated or failed detail requests cannot poison the new playlist cache', async () => {
  const cache = new SharedRequestCache();
  let finishOld;
  const old = cache.load('1', () => new Promise((resolve) => { finishOld = resolve; }));
  await Promise.resolve();
  cache.clear();
  await cache.load('1', async () => 'new provider');
  finishOld('old provider');
  await old;
  assert.equal(cache.get('1'), 'new provider');
  await assert.rejects(cache.load('failure', async () => { throw Error('network failed'); }));
  assert.equal(await cache.load('failure', async () => 'retried'), 'retried');
});
