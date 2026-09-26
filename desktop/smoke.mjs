import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerDesktopScheme, startDesktop, isAppUrl } from './runtime.mjs';

const phase = process.env.NOVA_SMOKE_PHASE;
assert.ok(['write', 'read'].includes(phase));
assert.ok(process.env.NOVA_SMOKE_DIR);
app.setPath('userData', process.env.NOVA_SMOKE_DIR);
app.disableHardwareAcceleration();
registerDesktopScheme();
app.on('window-all-closed', () => {});
const rendererErrors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event) => {
    if (event.level === 'error') {
      rendererErrors.push(event.message);
      console.error('Renderer:', event.message);
    }
  });
});

let desktop;
let fixture;
let leakedAuthorization = false;
// Electron waits for its entry module to finish before emitting ready. Avoid a
// top-level await on app.whenReady(), which would deadlock startup.
void (async () => {
try {
  assert.equal(isAppUrl('nova://app/'), true);
  for (const url of ['https://app/', 'nova://evil/', 'nova://app.evil/', 'nova://user@app/', 'file:///etc/passwd']) assert.equal(isAppUrl(url), false);
  await app.whenReady();
  const packaged = process.env.NOVA_SMOKE_PACKAGE;
  const launch = packaged ? (await import(pathToFileURL(join(packaged, 'desktop', 'runtime.mjs')).href)).startDesktop : startDesktop;
  desktop = await launch({ show: false, dist: packaged ? join(packaged, 'dist') : undefined });
  assert.equal((await fetch(`${desktop.backendOrigin}/api/kv/settings`)).status, 401);

  fixture = createServer((req, res) => {
    leakedAuthorization ||= !!req.headers.authorization;
    if (req.url === '/playlist.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nclip.ts\n#EXT-X-ENDLIST');
    }
    res.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-3/8', 'content-length': '4', 'accept-ranges': 'bytes' });
    res.end(Buffer.from([0x47, 1, 2, 3]));
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;

  const result = await desktop.window.webContents.executeJavaScript(`(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const until = Date.now() + 15000;
    while ((!document.getElementById('root')?.textContent || !window.novaFlushSettings) && Date.now() < until) await new Promise(r => setTimeout(r, 50));
    check(document.getElementById('root')?.textContent.length > 20, 'App did not render');
    check(typeof window.novaFlushSettings === 'function', 'Desktop bundle/close hook missing');
    await document.fonts.ready;
    while (Date.now() < until && !['material-community', 'Figtree'].every(name => [...document.fonts].some(f => f.family === name && f.status === 'loaded'))) await new Promise(r => setTimeout(r, 50));
    check([...document.fonts].some(f => f.family === 'material-community' && f.status === 'loaded'), 'Icon font did not load');
    check([...document.fonts].some(f => f.family === 'Figtree' && f.status === 'loaded'), 'Bundled typeface did not load');
    check(typeof window.require === 'undefined' && !window.process?.versions?.node, 'Renderer has Node access');
    check((await (await fetch('/api/health')).json()).ok, 'Local service failed');
    const key = '/api/kv/m3u:windows-smoke';
    const playlist = '#EXTM3U\\n#EXTINF:-1,Test channel\\nhttps://example.com/test.m3u8';
    if (${JSON.stringify(phase)} === 'write') {
      check((await fetch(key, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(playlist) })).ok, 'SQLite write failed');
    }
    check((await (await fetch(key)).json()).value === playlist, 'SQLite data did not persist');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('nova-desktop-smoke', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('values');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (${JSON.stringify(phase)} === 'write') await new Promise((resolve, reject) => {
      const transaction = db.transaction('values', 'readwrite');
      transaction.objectStore('values').put('saved', 'restart');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    const saved = await new Promise((resolve, reject) => {
      const request = db.transaction('values').objectStore('values').get('restart');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    check(saved === 'saved', 'IndexedDB origin changed across launches');
    db.close();
    const fixtureOrigin = ${JSON.stringify(fixtureOrigin)};
    const manifest = await (await fetch('/api/proxy?url=' + encodeURIComponent(fixtureOrigin + '/playlist.m3u8'))).text();
    check(manifest.includes('/api/proxy?url=') && manifest.includes('clip.ts'), 'HLS URLs were not rewritten');
    const segment = await fetch('/api/proxy?url=' + encodeURIComponent(fixtureOrigin + '/clip.ts'), { headers: { range: 'bytes=0-3' } });
    check(segment.status === 206 && segment.headers.get('content-range') === 'bytes 0-3/8', 'Video range response was lost');
    check((await segment.arrayBuffer()).byteLength === 4, 'Video response was corrupted');
    const video = document.createElement('video');
    check(!!video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'), 'H.264/AAC playback unavailable');
    window.open('https://example.com/');
    return { title: document.title, rendered: true, sqlite: true, indexedDB: true, proxy: true, videoCodecs: true, fonts: true };
  })()`);
  assert.equal(leakedAuthorization, false);
  assert.deepEqual(rendererErrors, []);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  if (phase === 'write') {
    const output = fileURLToPath(new URL('../.desktop/', import.meta.url));
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'windows-smoke.png'), (await desktop.window.webContents.capturePage()).toPNG());
  }
  const closed = new Promise((resolve) => desktop.window.once('closed', resolve));
  desktop.window.close();
  await closed;
  console.log(`Windows smoke (${packaged ? 'packaged ' : ''}${phase}): ${JSON.stringify(result)}`);
  await desktop.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  app.exit(0);
} catch (error) {
  console.error(error);
  await desktop?.close();
  fixture?.closeAllConnections();
  fixture?.close();
  app.exit(1);
}
})();
