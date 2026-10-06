import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createMockPanel, mockOptions } from '../server/mock-xtream.mjs';

async function fixture(t, options) {
  const panel = createMockPanel(options);
  await new Promise((r) => panel.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    panel.server.closeAllConnections();
    await new Promise((r) => panel.server.close(r));
  });
  return { ...panel, origin: 'http://127.0.0.1:' + panel.server.address().port };
}
test('stress fixture has bounded configurable large catalogs and exact category filtering', async (t) => {
  const { origin, stats } = await fixture(t, { channels: 3000, movies: 25000, series: 10000 });
  const api = (action, cat) => fetch(origin + '/player_api.php?' + new URLSearchParams({ username: 'demo', password: 'demo', action, ...(cat ? { category_id: cat } : {}) })).then((r) => r.json());
  assert.equal((await api('get_live_streams')).length, 3000);
  assert.equal((await api('get_vod_streams')).length, 25000);
  const movies = await api('get_vod_streams', '10');
  assert.equal(movies.length, 12500);
  assert.ok(movies.every((m) => m.category_id === '10'));
  assert.equal((await api('get_series', '21')).length, 5000);
  assert.equal(stats.requests['get_vod_streams:all'], 1);
  assert.equal(stats.requests['get_vod_streams:category'], 1);
  assert.equal(mockOptions({ MOCK_CHANNELS: '999999' }).channels, 20000);
});
test('fixture streams complete gzip XMLTV with repeatable programme counts', async (t) => {
  const { origin } = await fixture(t, { channels: 20, programmes: 24, clock: Date.UTC(2026, 9, 5), xmlChunkDelayMs: 1 });
  const response = await fetch(origin + '/xmltv.php?username=demo&password=demo');
  const xml = gunzipSync(Buffer.from(await response.arrayBuffer())).toString();
  assert.equal((xml.match(/<programme /g) || []).length, 480);
  assert.match(xml, /20261003000000/);
  assert.match(xml, /&amp;/);
  assert.ok(xml.endsWith('</tv>\n'));
  const stats = await (await fetch(origin + '/__test/stats')).json();
  assert.equal(stats.requests.xmltv, 1);
  assert.equal(stats.activeXmltv, 0);
  assert.equal(stats.completedXmltv, 1);
});
test('fixture supports empty, failing and indefinitely stalled guide bodies', async (t) => {
  for (const mode of ['empty', 'fail', 'stall']) {
    const { origin, stats } = await fixture(t, { xmlMode: mode });
    const controller = new AbortController();
    const response = await fetch(origin + '/xmltv.php?username=demo&password=demo', { signal: controller.signal });
    if (mode === 'fail') assert.equal(response.status, 503);
    else if (mode === 'empty') assert.equal((gunzipSync(Buffer.from(await response.arrayBuffer())).toString().match(/<programme /g) || []).length, 0);
    else {
      const body = response.text();
      controller.abort();
      await assert.rejects(body, /abort/i);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(stats.cancelledXmltv, 1);
      assert.equal(stats.activeXmltv, 0);
    }
  }
});
test('local playback fixture honors byte ranges and redirects live requests to local HLS', async (t) => {
  const { origin } = await fixture(t, { streamMode: 'fixture' });
  const data = readFileSync(new URL('./fixtures/playback.mp4', import.meta.url));
  const response = await fetch(origin + '/movie/demo/demo/5001.mp4', { headers: { range: 'bytes=0-15' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-15/' + data.length);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(0, 16));
  assert.equal((await fetch(origin + '/fixtures/playback.mp4', { headers: { range: 'bytes=' + data.length + '-' } })).status, 416);
  const manifest = await fetch(origin + '/live/demo/demo/1000.m3u8');
  assert.equal(manifest.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.match(await manifest.text(), /#EXTM3U/);
});
