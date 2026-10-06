import test from 'node:test';
import assert from 'node:assert/strict';
import { startNativeMock } from '../scripts/native-mock.mjs';
import { gunzipSync } from 'node:zlib';

test('native fixture guide keeps downloading while synchronous device polling blocks the driver', async () => {
  const panel = await startNativeMock({ channels: 50, programmes: 12, xmlChunkDelayMs: 4 });
  try {
    const response = await fetch(`http://127.0.0.1:${panel.port}/xmltv.php?username=demo&password=demo`);
    assert.equal(response.status, 200);
    // Model the real ADB UI dump's synchronous wait. The fixture provider must
    // finish on its own event loop instead of depending on this driver's timers.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    const stats = await panel.stats();
    assert.equal(stats.completedXmltv, 1);
    assert.equal(stats.activeXmltv, 0);
    assert.equal(stats.requests.xmltv, 1);
    const bytes = Buffer.from(await response.arrayBuffer());
    const xml = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
    assert.ok(xml.trimEnd().endsWith('</tv>'));
  } finally { await panel.close(); }
});
