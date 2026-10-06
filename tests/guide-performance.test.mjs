import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { appModule } from './helpers/load-app-module.mjs';

globalThis.__guidePlatform = { OS: 'web' };
const saved = new Map();
const operations = [];
globalThis.__guideStorage = {
  async getItem(key) { return saved.has(key) ? JSON.parse(saved.get(key)) : null; },
  async setItem(key, value) {
    const text = JSON.stringify(value);
    operations.push({ key, bytes: text.length });
    saved.set(key, text);
  },
  async removeItem(key) { saved.delete(key); },
  async removeByPrefix(prefix) { for (const key of saved.keys()) if (key.startsWith(prefix)) saved.delete(key); },
};
globalThis.__guideSettings = { playlists: [], prefs: { epgRefreshHours: 12, epgPastDays: 1, epgFutureDays: 2 } };
const mocks = {
  'react-native': 'export const Platform = globalThis.__guidePlatform;',
  'expo/fetch': 'export const fetch = (...args) => globalThis.fetch(...args);',
  'src/services/storage': 'export const getItem = (...a) => globalThis.__guideStorage.getItem(...a); export const setItem = (...a) => globalThis.__guideStorage.setItem(...a); export const removeItem = (...a) => globalThis.__guideStorage.removeItem(...a); export const removeByPrefix = (...a) => globalThis.__guideStorage.removeByPrefix(...a);',
  'src/store/settings': 'export const useSettings = { getState: () => globalThis.__guideSettings }; export const favCatKey = (...a) => a.join(":");',
};
const { XmltvParser, parseXmltvTime } = await appModule('src/services/xmltv.ts', mocks);
const { buildEpgIndexAsync } = await appModule('src/services/epg.ts');
const { streamText, fetchText } = await appModule('src/services/http.ts');
const { readEpgCache, writeEpgCache, removeEpgCache } = await appModule('src/services/epgCache.ts');
const { readPlaylistCache, writePlaylistCache, removePlaylistCache } = await appModule('src/services/playlistCache.ts');
const { useLibrary, getLibraryGeneration } = await appModule('src/store/library.ts');
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });
test.afterEach(() => { useLibrary.getState().reset(); globalThis.__guidePlatform.OS = 'web'; saved.clear(); operations.length = 0; });

const xmlTime = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' Z';
const guide = (title = 'News', count = 1) => {
  const start = Date.now() - 30 * 60000;
  return '<tv><channel id="guide1"><display-name>Channel One</display-name></channel>' +
    Array.from({ length: count }, (_, i) => `<programme channel="guide1" start="${xmlTime(start + i * 3600000)}" stop="${xmlTime(start + (i + 1) * 3600000)}"><title>${title} ${i}</title></programme>`).join('') + '</tv>';
};
const filter = () => ({ ids: new Set(['guide1']), names: new Set(), from: 0, to: Infinity });
const response = (text) => new Response(new TextEncoder().encode(text));
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('XMLTV handles split tags, UTF-8 names, self-closing channels, filtering and overlap cleanup', async () => {
  const start = parseXmltvTime('20260924120000 +0200');
  assert.equal(start, Date.UTC(2026, 8, 24, 10));
  const xml = '<tv><channel id="unused"/><channel id="guide1"><display-name>Chännel One</display-name></channel>' +
    '<programme channel="unused" start="20260924120000 Z" stop="20260924123000 Z"><title>Ignored</title></programme>' +
    '<programme channel="guide1" start="20260924120000 Z" stop="20260924123000 Z"><title>A &amp; B</title></programme>' +
    '<programme channel="guide1" start="20260924120000 Z" stop="20260924123000 Z"><title>Duplicate</title></programme>' +
    '<programme channel="guide1" start="20260924121500 Z" stop="20260924124500 Z"><title><![CDATA[Later]]></title></programme></tv>';
  const parser = new XmltvParser(filter());
  for (let i = 0; i < xml.length; i += 7) parser.push(xml.slice(i, i + 7));
  const data = await parser.finishAsync();
  assert.equal(data.programs.unused, undefined);
  assert.equal(data.programs.guide1.length, 2);
  assert.equal(data.programs.guide1[0].title, 'A & B');
  assert.equal(data.programs.guide1[0].end, data.programs.guide1[1].start);
  const indexed = await buildEpgIndexAsync([{ id: 'c1', tvgId: 'GUIDE1@HD', name: 'One' }], data);
  assert.equal(indexed.c1, data.programs.guide1);
});

test('XMLTV rejects oversized/truncated elements instead of retaining an unbounded buffer', () => {
  const parser = new XmltvParser(filter());
  assert.throws(() => parser.push('<programme ' + 'x'.repeat(1_048_576)), /oversized|incomplete/);
  const truncated = new XmltvParser(filter());
  truncated.push('<programme channel="guide1">');
  assert.throws(() => truncated.finish(), /ended/);
});

test('XMLTV treats prototype-like provider channel identifiers as ordinary guide IDs', () => {
  const ids = ['__proto__', 'constructor', 'toString'];
  const parser = new XmltvParser({ ...filter(), ids: new Set(ids.map((id) => id.toLowerCase())) });
  for (const id of ids) parser.push(`<channel id="${id}"/><programme channel="${id}" start="20260924120000 Z" stop="20260924123000 Z"><title>${id}</title></programme>`);
  const data = parser.finish();
  for (const id of ids) assert.equal(data.programs[id][0].title, id);
});

test('40k-programme guide stays linear and yields to input while a transport supplies one giant chunk', async (t) => {
  // This exact input took 29 seconds in the old paired indexOf parser on this PC.
  const xml = '<tv><channel id="guide1"/>' + '<programme channel="guide1" start="20260924120000 Z" stop="20260924123000 Z"><title>News</title></programme>'.repeat(40_000) + '</tv>';
  const parser = new XmltvParser(filter());
  const start = performance.now();
  parser.push(xml);
  parser.finish();
  const parseMs = performance.now() - start;
  assert.ok(parseMs < 3000, `40k guide parser exceeded 3s: ${parseMs.toFixed(1)}ms`);
  globalThis.fetch = async () => response(xml);
  let ticks = 0;
  let longestCallback = 0;
  let maxChars = 0;
  const interval = setInterval(() => ticks++, 1);
  const streamed = new XmltvParser(filter());
  try {
    await streamText('http://guide.test/xml', {}, (chunk) => {
      const begin = performance.now();
      maxChars = Math.max(maxChars, chunk.length);
      streamed.push(chunk);
      longestCallback = Math.max(longestCallback, performance.now() - begin);
    });
    streamed.finish();
  } finally { clearInterval(interval); }
  assert.ok(ticks > 0, 'background parsing never yielded to the input event loop');
  assert.ok(maxChars <= 16_384, 'parser callbacks were not bounded');
  assert.ok(longestCallback < 100, `one parse slice blocked ${longestCallback.toFixed(1)}ms`);
  t.diagnostic(JSON.stringify({ programs: 40_000, parseMs, longestCallbackMs: longestCallback, inputTicks: ticks }));
});

test('gzip headers split across reads and asynchronous callbacks preserve UTF-8 text in order', async () => {
  const text = 'Channel 👋 Chännel & Programme '.repeat(3000);
  const gz = gzipSync(text);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(gz.subarray(0, 1));
    for (let i = 1; i < gz.length; i += 13) controller.enqueue(gz.subarray(i, i + 13));
    controller.close();
  } }));
  let received = '';
  let active = false;
  await streamText('http://guide.test/xml.gz', {}, async (chunk) => {
    assert.equal(active, false, 'the next parser callback ran before the previous one finished');
    active = true;
    await Promise.resolve();
    received += chunk;
    active = false;
  });
  assert.equal(received, text);
});

test('playlist text loading forwards progress while preserving streamed UTF-8 decoding', async () => {
  const text = 'Chännel One 👋';
  const encoded = new TextEncoder().encode(text);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoded.subarray(0, 3));
    controller.enqueue(encoded.subarray(3));
    controller.close();
  } }));
  const progress = [];
  assert.equal(await fetchText('http://guide.test/playlist', { onProgress: (bytes) => progress.push(bytes) }), text);
  assert.deepEqual(progress, [3, encoded.length]);
});

test('truncated gzip is rejected', async () => {
  const gz = gzipSync('test '.repeat(100));
  globalThis.fetch = async () => new Response(gz.subarray(0, gz.length - 8));
  await assert.rejects(streamText('http://guide.test/broken.gz', {}, () => {}), /decompress|Incomplete/);
});

test('body deadline remains active after headers and cancels a stalled reader', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }));
  await assert.rejects(streamText('http://guide.test/xml?username=private&password=secret', { timeoutMs: 20 }, () => {}), (error) => {
    assert.match(error.message, /timed out/);
    assert.ok(!error.message.includes('private') && !error.message.includes('secret'));
    return true;
  });
  await pause();
  assert.equal(cancelled, true);
});

test('already-cancelled and in-flight requests abort without being labelled timeout', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })); };
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(streamText('http://guide.test/xml', { signal: preAborted.signal }, () => {}), { name: 'AbortError' });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = streamText('http://guide.test/xml', { signal: controller.signal }, () => {});
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('many tiny response chunks release each cancellation listener before the next read', async (t) => {
  const originalAdd = AbortSignal.prototype.addEventListener;
  const originalRemove = AbortSignal.prototype.removeEventListener;
  const active = new Set();
  let added = 0;
  let max = 0;
  AbortSignal.prototype.addEventListener = function (type, listener, options) {
    if (type === 'abort') { active.add(listener); added++; max = Math.max(max, active.size); }
    return originalAdd.call(this, type, listener, options);
  };
  AbortSignal.prototype.removeEventListener = function (type, listener, options) {
    if (type === 'abort') active.delete(listener);
    return originalRemove.call(this, type, listener, options);
  };
  const chunks = 10_000;
  let reads = 0;
  let released = false;
  globalThis.fetch = async () => ({ ok: true, body: { getReader: () => ({
    read: async () => reads++ < chunks ? { value: new Uint8Array([120]), done: false } : { done: true },
    releaseLock() { released = true; },
  }) } });
  let characters = 0;
  try {
    await streamText('http://guide.test/tiny-chunks', {}, (chunk) => { characters += chunk.length; });
    assert.equal(characters, chunks);
    assert.equal(active.size, 0, 'Transfer completion retained abort listeners');
    assert.equal(max, 1, 'Cancellation listeners accumulated across reads');
    assert.ok(added >= chunks, 'Every operation must release its own cancellation listener');
    assert.equal(released, true);
    t.diagnostic(JSON.stringify({ chunks, maxLiveAbortListeners: max, retainedAbortListeners: active.size }));
  } finally {
    AbortSignal.prototype.addEventListener = originalAdd;
    AbortSignal.prototype.removeEventListener = originalRemove;
  }
});

test('paged native EPG cache roundtrips, bounds serialization and removes superseded pages', async () => {
  const programs = Array.from({ length: 10_000 }, (_, i) => ({ start: i * 3600000, end: (i + 1) * 3600000, title: 'News', desc: 'x'.repeat(400) }));
  const data = { programs: { guide1: programs }, names: { one: 'guide1' }, icons: { guide1: 'http://guide.test/icon.png' }, fetchedAt: 123 };
  await writeEpgCache('test', data);
  assert.deepEqual(JSON.parse(JSON.stringify(await readEpgCache('test'))), data);
  assert.ok(Math.max(...operations.map((op) => op.bytes)) < 150_000, 'cache still serializes a whole large guide');
  const priorKeys = new Set(saved.keys());
  await writeEpgCache('test', { ...data, programs: { guide1: programs.slice(0, 10) } });
  for (const key of priorKeys) if (key !== 'epg-parts:test') assert.equal(saved.has(key), false);
  await removeEpgCache('test');
  assert.equal(saved.size, 0);
});

test('aborted cache writes leave the previous guide intact and remove partial pages', async () => {
  const old = { programs: { guide1: [{ start: 0, end: 1, title: 'Old' }] }, names: {}, icons: {}, fetchedAt: 1 };
  await writeEpgCache('test', old);
  const originalSet = globalThis.__guideStorage.setItem;
  const controller = new AbortController();
  globalThis.__guideStorage.setItem = async (key, value) => { await originalSet(key, value); if (key.includes(':0')) controller.abort(); };
  try {
    await assert.rejects(writeEpgCache('test', { ...old, programs: { guide1: Array.from({ length: 1000 }, () => old.programs.guide1[0]) } }, controller.signal), { name: 'AbortError' });
  } finally { globalThis.__guideStorage.setItem = originalSet; }
  assert.deepEqual(JSON.parse(JSON.stringify(await readEpgCache('test'))), old);
  assert.equal(saved.size, 2, 'cancelled write leaked partial pages');
});

test('native upgrades skip legacy giant JSON; web preserves the old cache', async () => {
  const legacy = { programs: {}, names: {}, icons: {}, fetchedAt: 1 };
  saved.set('epg:test', JSON.stringify(legacy));
  globalThis.__guidePlatform.OS = 'android';
  assert.equal(await readEpgCache('test'), null);
  globalThis.__guidePlatform.OS = 'web';
  assert.deepEqual(await readEpgCache('test'), legacy);
});

test('playlist cache pages roundtrip channel/movie collections and clean up on removal', async () => {
  const data = { channels: Array.from({ length: 3000 }, (_, i) => ({ id: 'c' + i, name: 'Channel ' + i, num: i, group: 'Live', url: 'http://stream.test/' + i })), movies: Array.from({ length: 2000 }, (_, i) => ({ id: 'm' + i, title: 'Movie', categoryId: '1' })), epgUrls: ['http://guide.test/xml'], account: undefined, fetchedAt: 123 };
  await writePlaylistCache('test', data);
  assert.deepEqual(await readPlaylistCache('test'), data);
  assert.ok(Math.max(...operations.map((op) => op.bytes)) < 30_000);
  await removePlaylistCache('test');
  assert.equal(saved.size, 0);
});

for (const [kind, write, remove, manifestKey, data] of [
  ['guide', writeEpgCache, removeEpgCache, 'epg-parts:test', { programs: { guide1: [{ start: 0, end: 1, title: 'Old source' }] }, names: {}, icons: {}, fetchedAt: 1 }],
  ['playlist', writePlaylistCache, removePlaylistCache, 'pl-parts:test', { channels: [{ id: 'old', name: 'Old source' }], movies: [], epgUrls: [], fetchedAt: 1 }],
]) test(`clearing a ${kind} cache waits for a cancelled manifest publication and removes all stale pages`, async () => {
  const originalSet = globalThis.__guideStorage.setItem;
  let release;
  let reached;
  const publication = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  const controller = new AbortController();
  globalThis.__guideStorage.setItem = async (key, value) => {
    if (key === manifestKey) { reached(); await publication; }
    await originalSet(key, value);
  };
  try {
    const writing = write('test', data, controller.signal);
    await started;
    controller.abort();
    let cleared = false;
    const clearing = remove('test').then(() => { cleared = true; });
    await pause();
    assert.equal(cleared, false, 'Clear raced ahead of an unfinished manifest write');
    release();
    await Promise.all([writing, clearing]);
    assert.equal(saved.size, 0, 'Cancelled source publication recreated a cleared cache');
  } finally {
    release();
    globalThis.__guideStorage.setItem = originalSet;
  }
});

test('native HTTP uses the Expo streaming transport and keeps its provider User-Agent', async () => {
  globalThis.__guidePlatform.OS = 'android';
  globalThis.__nativeGuideCalls = 0;
  const nativeHttp = await appModule('src/services/http.ts', {
    'expo/fetch': 'export const fetch = (...args) => { globalThis.__nativeGuideCalls++; return globalThis.fetch(...args); };',
  }, 'native');
  let options;
  globalThis.fetch = async (_url, requestOptions) => {
    options = requestOptions;
    return { ok: true, body: response('Native guide').body, arrayBuffer() { throw new Error('Native guide fell back to a whole-body buffer'); } };
  };
  let text = '';
  await nativeHttp.streamText('http://guide.test/native', { ua: 'Provider agent' }, (chunk) => { text += chunk; });
  assert.equal(text, 'Native guide');
  assert.equal(globalThis.__nativeGuideCalls, 1);
  assert.equal(options.headers['User-Agent'], 'Provider agent');
});

function seedLibrary(id = 'test') {
  const p = { id, name: id, type: 'xtream', server: 'http://guide.test', username: 'demo', password: 'demo', createdAt: 1 };
  const ch = { id: 'x1', num: 1, name: 'Channel One', group: 'Live', tvgId: 'guide1', streamId: 1, url: '' };
  globalThis.__guideSettings.playlists = [p];
  useLibrary.setState({ playlistId: id, status: 'ready', channels: [ch], byId: { x1: ch }, epgUrls: ['http://guide.test/xml'] });
  return p;
}

test('concurrent guide refreshes share one download, then a fresh cache prevents reopening downloads', async () => {
  seedLibrary();
  let calls = 0;
  globalThis.fetch = async () => { calls++; await pause(5); return response(guide()); };
  const first = useLibrary.getState().refreshEpg(true);
  const second = useLibrary.getState().refreshEpg(true);
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(useLibrary.getState().epgStatus, 'ready');
  assert.equal(useLibrary.getState().epg.x1.length, 1);
  await useLibrary.getState().refreshEpg();
  assert.equal(calls, 1);
  assert.equal(useLibrary.getState().epgMessage, undefined);
});

test('a valid guide with no matching programmes is cached so ordinary refreshes do not retry forever', async () => {
  seedLibrary();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response('<tv/>'); };
  await useLibrary.getState().refreshEpg(true);
  assert.equal(useLibrary.getState().epgStatus, 'error');
  await useLibrary.getState().refreshEpg();
  assert.equal(useLibrary.getState().epgStatus, 'ready');
  assert.equal(calls, 1);
});

test('switch/reset cancels guide work and blocks stale completion, including returning to the same playlist', async () => {
  seedLibrary();
  let networkSignal;
  let resolveFetch;
  globalThis.fetch = (_url, options) => { networkSignal = options.signal; return new Promise((resolve) => { resolveFetch = resolve; }); };
  const generation = getLibraryGeneration();
  const pending = useLibrary.getState().refreshEpg(true);
  await pause();
  useLibrary.getState().reset();
  assert.ok(getLibraryGeneration() > generation);
  assert.equal(networkSignal.aborted, true);
  seedLibrary();
  resolveFetch(response(guide('Stale')));
  await pending;
  assert.deepEqual(useLibrary.getState().epg, {});
  assert.equal(useLibrary.getState().epgStatus, 'idle');
});

test('short guide requests cannot overwrite another playlist or a completed full-guide row', async () => {
  seedLibrary();
  let resolveFetch;
  globalThis.fetch = async () => new Promise((resolve) => { resolveFetch = resolve; });
  const pending = useLibrary.getState().loadShortEpg('x1');
  await pause();
  useLibrary.getState().reset();
  seedLibrary('other');
  resolveFetch(response(JSON.stringify({ epg_listings: [{ start_timestamp: 1, stop_timestamp: 2, title: 'U3RhbGU=' }] })));
  await pending;
  assert.deepEqual(useLibrary.getState().epg, {});
  const current = useLibrary.getState().loadShortEpg('x1');
  await pause();
  const fullGuide = [{ start: 1000, end: 2000, title: 'Full guide won' }];
  useLibrary.setState({ epg: { x1: fullGuide } });
  resolveFetch(response(JSON.stringify({ epg_listings: [{ start_timestamp: 1, stop_timestamp: 2, title: 'U2hvcnQ=' }] })));
  await current;
  assert.equal(useLibrary.getState().epg.x1, fullGuide);
});

test('explicit guide refresh retries completed negative short guides once and preserves an active request', async () => {
  seedLibrary();
  let shortCalls = 0;
  let finishShort;
  globalThis.fetch = async (url) => {
    if (!url.includes('get_simple_data_table')) return response('<tv/>');
    shortCalls++;
    if (shortCalls === 1) return new Promise((resolve) => { finishShort = resolve; });
    return response(JSON.stringify({ epg_listings: [{ start_timestamp: 1, stop_timestamp: 2, title: 'UmV0cnkgd29u' }] }));
  };
  const active = useLibrary.getState().loadShortEpg('x1');
  await pause();
  await useLibrary.getState().refreshEpg(true);
  await useLibrary.getState().loadShortEpg('x1');
  assert.equal(shortCalls, 1, 'Explicit refresh duplicated a running channel request');
  finishShort(response(JSON.stringify({ epg_listings: [] })));
  await active;
  await useLibrary.getState().loadShortEpg('x1');
  assert.equal(shortCalls, 1, 'Ordinary navigation retried a negative result');
  await useLibrary.getState().refreshEpg(true);
  await useLibrary.getState().loadShortEpg('x1');
  assert.equal(shortCalls, 2, 'Explicit refresh failed to retry a completed negative result');
  assert.equal(useLibrary.getState().epg.x1[0].title, 'Retry won');
  await useLibrary.getState().loadShortEpg('x1');
  assert.equal(shortCalls, 2, 'The retried row did not stay cached');
});
