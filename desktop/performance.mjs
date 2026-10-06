import { app } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMockPanel } from '../server/mock-xtream.mjs';
import { registerDesktopScheme, startDesktop } from './runtime.mjs';

assert.ok(process.env.NOVA_PERF_DIR, 'Launch this through npm run test:perf:windows');
app.setPath('userData', process.env.NOVA_PERF_DIR);
app.disableHardwareAcceleration();
registerDesktopScheme();
app.on('window-all-closed', () => {});
let desktop;
let panel;
const errors = [];

void (async () => {
  try {
    panel = createMockPanel({ channels: 1000, movies: 25000, series: 10000, programmes: 48, xmlChunkDelayMs: 2, streamMode: 'fixture' });
    await new Promise((resolve) => panel.server.listen(0, '127.0.0.1', resolve));
    await app.whenReady();
    desktop = await startDesktop({ show: false });
    desktop.window.webContents.setBackgroundThrottling(false);
    // Windows suppresses animation frames for hidden windows even with timer
    // throttling disabled. Render the fixture without taking keyboard focus.
    desktop.window.showInactive();
    desktop.window.webContents.setAudioMuted(true);
    desktop.window.webContents.debugger.attach('1.3');
    desktop.window.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message);
    });
    const evaluate = (source) => desktop.window.webContents.executeJavaScript(source);
    const until = async (source, label, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(source)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out: ${label}`);
    };
    const screen = (name) => `!!document.querySelector('[data-testid="screen-${name}"]')`;
    const click = (name) => evaluate(`document.querySelector('[data-testid="nav-${name}"]').click()`);
    const key = async (keyCode) => {
      // Exercise the same capture-phase key path as the user's keyboard.
      const keys = { Down: ['ArrowDown', 40], Escape: ['Escape', 27], Return: ['Enter', 13], Pause: ['k', 75], Forward: ['l', 76] };
      const [key, windowsVirtualKeyCode] = keys[keyCode];
      await desktop.window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode });
      await desktop.window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode });
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    await until('!!window.novaFlushSettings', 'desktop hydration');
    const settings = {
      playlists: [{ id: 'windows-performance', name: 'Performance Fixture', type: 'xtream', server: `http://127.0.0.1:${panel.server.address().port}`, username: 'demo', password: 'demo', createdAt: 1 }],
      prefs: { startWithLastChannel: false, previewInGuide: false, streamFormat: 'm3u8' },
    };
    await evaluate(`fetch('/api/kv/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(settings)}) }).then(response => { if (!response.ok) throw new Error('Fixture seed failed'); })`);
    desktop.window.webContents.reload();
    await until(screen('home'), 'library startup');
    await until("!!document.querySelector('[data-testid=\"nav-settings\"]')", 'navigation');
    await evaluate(`window.__windowsPerf = { gaps: [], last: performance.now() }; window.__windowsPerf.timer = setInterval(() => { const t = performance.now(); window.__windowsPerf.gaps.push(Math.max(0, t - window.__windowsPerf.last - 50)); window.__windowsPerf.last = t; }, 50); window.__novaPerf?.reset()`);

    await click('guide');
    await until(screen('guide'), 'guide navigation');
    await until("document.querySelector('[data-testid=\"screen-guide\"]')?.textContent.includes('BBC One HD')", 'live channel list');
    await key('Down');
    for (let i = 0; i < 4; i++) {
      await key('Escape');
      if (await evaluate("document.querySelector('[data-testid=\"nav-settings\"]')?.textContent.includes('Settings')")) break;
    }
    for (let i = 0; i < 4; i++) await key('Down');
    await key('Return');
    await until(screen('settings'), 'settings while guide downloads', 3000);
    assert.equal(panel.stats.requests['get_vod_streams:all'] ?? 0, 0, 'Settings fetched the full movie catalog');
    assert.equal(panel.stats.requests['get_series:all'] ?? 0, 0, 'Settings fetched the full series catalog');
    await click('movies');
    await until("document.querySelector('[data-testid=\"screen-movies\"]')?.textContent.includes('Tears of Steel')", 'movie category');
    await click('series');
    await until("document.querySelector('[data-testid=\"screen-series\"]')?.textContent.includes('Stream Lab')", 'series category');
    await click('search');
    await until('!!document.querySelector("input")', 'search input');
    await evaluate(`(() => { const input = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Performance Movie 025000'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until("document.querySelector('[data-testid=\"screen-search\"]')?.textContent.includes('Performance Movie 025000')", 'full-library search', 45000);
    await click('home');
    await until(screen('home'), 'return home', 3000);
    await until('window.__windowsPerf.gaps.length >= 60', 'responsiveness samples');
    const metrics = await evaluate(`(() => { clearInterval(window.__windowsPerf.timer); const gaps = window.__windowsPerf.gaps.sort((a,b) => a-b); return { heartbeatMaxMs: Math.max(...gaps), heartbeatP95Ms: gaps[Math.ceil(gaps.length * .95)-1], samples: gaps.length, monitor: window.__novaPerf?.snapshot() ?? null }; })()`);
    assert.ok(metrics.heartbeatMaxMs < 1000, `Windows blocked for ${metrics.heartbeatMaxMs} ms`);
    assert.ok(metrics.heartbeatP95Ms < 150, `Windows p95 lag ${metrics.heartbeatP95Ms} ms`);
    assert.ok(metrics.monitor?.keyToFrameMs?.count > 0, 'Missing rendered key samples');
    assert.ok(metrics.monitor.keyToFrameMs.p95 < 250, `Windows key-to-frame p95 ${metrics.monitor.keyToFrameMs.p95} ms`);

    const decoded = async (label) => {
      await until(`(() => { const v = document.querySelector('video'); return v && v.readyState >= 3 && !v.paused && v.currentTime > .5 && v.getVideoPlaybackQuality().totalVideoFrames > 1; })()`, label, 15000);
      return evaluate(`(() => { const v = document.querySelector('video'); return { duration: v.duration, position: v.currentTime, width: v.videoWidth, height: v.videoHeight, decodedFrames: v.getVideoPlaybackQuality().totalVideoFrames }; })()`);
    };
    await click('movies');
    await until("!!document.querySelector('[aria-label=\"Tears of Steel\"]')", 'movie poster');
    await evaluate("document.querySelector('[aria-label=\"Tears of Steel\"]').click()");
    await until("!!document.querySelector('[data-testid=\"detail-play\"]')", 'movie play action');
    await evaluate("document.querySelector('[data-testid=\"detail-play\"]').click()");
    const movie = await decoded('MP4 decoded playback');
    assert.equal(movie.width, 160);
    assert.ok(movie.duration > 39 && movie.duration < 41, 'Unexpected fixture duration');
    await key('Pause');
    await until("document.querySelector('video')?.paused", 'movie paused');
    const pausedAt = await evaluate("document.querySelector('video').currentTime");
    await key('Forward');
    await until(`document.querySelector('video')?.currentTime > ${pausedAt + 9}`, 'movie seek');
    await key('Pause');
    await until("document.querySelector('video') && !document.querySelector('video').paused", 'movie resumed');
    await until("document.querySelector('[data-testid=\"player-control-playpause\"]')?.textContent.includes('Pause')", 'rendered resume state');
    await key('Escape'); // First Back hides the playing controls.
    await key('Escape');
    await until("!document.querySelector('video')", 'movie stopped');
    await key('Escape');
    await click('guide');
    await until(screen('guide'), 'guide for playback');
    await key('Return');
    const live = await decoded('HLS decoded playback');
    await key('Escape'); // First Back hides the playing controls.
    await key('Escape');
    await until("!document.querySelector('video')", 'live stopped');
    assert.equal(panel.stats.requests.xmltv, 1, 'Guide download restarted while changing screens');
    assert.deepEqual(errors, [], 'Renderer errors');
    const report = { platform: 'Windows Electron', fixture: { channels: 1000, movies: 25000, series: 10000 }, metrics, playback: { movie, live, controls: ['pause', 'seek', 'resume', 'stop'] }, requests: panel.stats.requests, passed: true };
    const reportUrl = new URL('../output/performance/windows.json', import.meta.url);
    mkdirSync(fileURLToPath(new URL('./', reportUrl)), { recursive: true });
    writeFileSync(reportUrl, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    await desktop.close();
    panel.server.closeAllConnections();
    await new Promise((resolve) => panel.server.close(resolve));
    app.exit(0);
  } catch (error) {
    console.error(error);
    await desktop?.close();
    panel?.server.closeAllConnections();
    panel?.server.close();
    app.exit(1);
  }
})();
