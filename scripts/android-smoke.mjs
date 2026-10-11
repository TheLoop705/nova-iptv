import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadTestEnv } from './test-env.mjs';
import { startNativeMock } from './native-mock.mjs';
import { PNG } from 'pngjs';

loadTestEnv();
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
const adbPath = process.env.NOVA_TEST_ADB || (existsSync(join(sdk, 'platform-tools', 'adb.exe')) ? join(sdk, 'platform-tools', 'adb.exe') : 'adb');
const call = (args, timeout = 20000) => execFileSync(adbPath, args, { encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
const connected = call(['devices']).split(/\r?\n/).filter((line) => /\tdevice$/.test(line)).map((line) => line.split('\t')[0]);
if (process.argv.includes('--doctor')) {
  console.log(JSON.stringify({ sdk, adbAvailable: true, platforms: ['android-34', 'android-36'].filter((p) => existsSync(join(sdk, 'platforms', p))), emulatorInstalled: existsSync(join(sdk, 'emulator', 'emulator.exe')), devices: connected }, null, 2));
  process.exit(0);
}
const serial = process.env.NOVA_TEST_ANDROID_SERIAL || (connected.length === 1 ? connected[0] : undefined);
if (!serial || !connected.includes(serial)) throw new Error('Connect exactly one Android TV / Fire TV device, or set NOVA_TEST_ANDROID_SERIAL. Run npm run test:android:doctor for device status.');
const adb = (args, timeout) => call(['-s', serial, ...args], timeout);
const app = 'com.theloop705.nova';
const apk = process.env.NOVA_TEST_APK;
if (apk) {
  if (!existsSync(resolve(apk))) throw new Error('NOVA_TEST_APK does not exist.');
  adb(['install', '-r', resolve(apk)], 120000);
}
const installed = adb(['shell', 'pm', 'path', app]);
if (!installed.includes('package:')) throw new Error('Install the APK, or set NOVA_TEST_APK to install it without erasing saved data.');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (code) => adb(['shell', 'input', 'keyevent', String(code)]);
async function dump() {
  // A forced device PTY lets UIAutomator write straight to memory. Never leave
  // a credential-bearing UI hierarchy on shared device storage or in reports.
  return adb(['shell', '-tt', 'uiautomator', 'dump', '--compressed', '/dev/tty']);
}
function node(xml, id) {
  return (xml.match(/<node\b[^>]*>/g) || []).find((value) => value.includes('resource-id="' + id + '"') || value.includes('resource-id="' + app + ':id/' + id + '"'));
}
async function tapId(id, fraction = 0.5) {
  const xml = await dump();
  const element = node(xml, id);
  const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(element || '');
  if (!bounds) throw new Error('Expected visible control missing: ' + id);
  adb(['shell', 'input', 'tap', String(Math.round(Number(bounds[1]) + (Number(bounds[3]) - Number(bounds[1])) * fraction)), String(Math.round((Number(bounds[2]) + Number(bounds[4])) / 2))]);
  await pause(250);
}
const playbackMode = process.argv.includes('--playback');
async function position() {
  // Read only while paused. Android's accessibility dump waits for an idle UI;
  // the running clock can delay it until playback controls have disappeared.
  const value = node(await dump(), 'player-position');
  const text = /text="([^"]+)"/.exec(value || '')?.[1];
  if (!text || !/^\d+:\d{2}(?::\d{2})?$/.test(text)) throw new Error('Native playback position is not visible.');
  return text;
}
function frame() {
  return PNG.sync.read(execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], { windowsHide: true, timeout: 20000, maxBuffer: 20 * 1024 * 1024 }));
}
function changedCenterPixels(before, after) {
  if (before.width !== after.width || before.height !== after.height) throw new Error('Video display size changed during sampling.');
  let changed = 0;
  // Controls/time labels live around the edges. Compare only the center of the video.
  for (let y = Math.floor(before.height * 0.35); y < before.height * 0.6; y++) {
    for (let x = Math.floor(before.width * 0.3); x < before.width * 0.7; x++) {
      const offset = (y * before.width + x) * 4;
      const delta = Math.abs(before.data[offset] - after.data[offset]) + Math.abs(before.data[offset + 1] - after.data[offset + 1]) + Math.abs(before.data[offset + 2] - after.data[offset + 2]);
      if (delta > 30) changed++;
    }
  }
  return changed;
}
async function screen(name) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const xml = await dump();
    if (node(xml, 'screen-' + name)) return Date.now() - started;
    await pause(200);
  }
  throw new Error('Remote navigation did not reveal screen: ' + name);
}
let fixture;
let panel;
let playback;
try {
  adb(['shell', 'am', 'force-stop', app]);
  const launched = adb(['shell', 'am', 'start', '-W', '-n', app + '/.MainActivity']);
  if (/Error:|Error type/.test(launched)) throw new Error('Nova main activity could not start.');
  await pause(2500);
  const initial = await dump();
  if (process.argv.includes('--mock')) {
    // Setup is explicit because it adds a test playlist to the selected device.
    panel = await startNativeMock({ channels: 1000, movies: 25000, series: 10000, programmes: 144, xmlChunkDelayMs: 8, streamMode: playbackMode ? 'fixture' : 'unavailable' }, 8790);
    fixture = panel;
    adb(['reverse', 'tcp:8790', 'tcp:8790']);
    if (node(initial, 'onboarding-add')) await tapId('onboarding-add');
    else { await tapId('nav-settings'); await tapId('settings-add'); }
    await pause(500);
    // The pairing row precedes the editor tab row on Android TV.
    key(20); key(22);
    await pause(300);
    for (const [id, value] of [['name', 'Performance-test'], ['server', 'http://127.0.0.1:8790'], ['username', 'demo'], ['password', 'demo']]) {
      await tapId('field-' + id);
      // Values here are fixed, harmless fixture credentials; real secrets are never shell arguments.
      adb(['shell', 'input', 'text', value]);
      key(4);
    }
    await tapId('editor-save');
    await pause(1500);
  } else if (node(initial, 'onboarding-demo') && process.argv.includes('--demo')) {
    await tapId('onboarding-demo');
    await pause(1500);
  } else if (node(initial, 'onboarding-add')) {
    throw new Error('No playlist configured. Use --mock for a large local fixture, --demo for public demo, or add your provider on the TV before testing.');
  }
  adb(['shell', 'dumpsys', 'gfxinfo', app, 'reset']);
  const timings = [];
  for (const name of ['guide', 'settings', 'movies', 'series', 'search', 'home']) {
    await tapId('nav-' + name);
    timings.push({ screen: name, observedWithinMs: await screen(name) });
    if (name === 'settings' && panel) {
      const stats = await panel.stats();
      if (stats.requests['get_vod_streams:all'] || stats.requests['get_series:all']) throw new Error('Settings downloaded full catalogs to count them.');
    }
    // Exercise native key capture through the shared JS focus router.
    key(20); key(19); key(22); key(21);
  }
  if (panel) {
    await tapId('nav-search');
    await tapId('search-input');
    adb(['shell', 'input', 'text', 'Performance%sMovie%s025000']);
    const deadline = Date.now() + 60000;
    let found = false;
    while (Date.now() < deadline) {
      const xml = await dump();
      // One occurrence is the query field; another must be a rendered search result.
      if ((xml.match(/Performance Movie 025000/g) || []).length >= 2) { found = true; break; }
      await pause(250);
    }
    if (!found) throw new Error('Large native catalog search did not finish.');
    key(4);
    await tapId('nav-home');
    await screen('home');
    const stats = await panel.stats();
    if (stats.requests['get_vod_streams:all'] !== 1 || stats.requests['get_series:all'] !== 1) throw new Error('Native full-catalog downloads did not coalesce.');
  }
  if (playbackMode) {
    if (!panel) throw new Error('Use --mock --playback for the local native playback fixture.');
    await tapId('nav-movies'); await screen('movies');
    await tapId('vod-item-movies-v5001');
    await tapId('detail-play');
    await pause(2000);
    key(85); // Pause with the media key before waiting for accessibility idle.
    await pause(350);
    const initialPosition = await position();
    key(85);
    await pause(2000);
    key(85);
    await pause(350);
    const advancedPosition = await position();
    if (advancedPosition === initialPosition) throw new Error('Native MP4 playback position did not advance.');
    key(85);
    key(165); // Hide controls while sampling the actual video surface.
    await pause(700);
    const firstFrame = frame();
    await pause(1100);
    const secondFrame = frame();
    const changedPixels = changedCenterPixels(firstFrame, secondFrame);
    if (changedPixels < 100) throw new Error('Native MP4 produced no changing video pixels in the center of the screen.');
    key(85);
    await pause(350);
    const paused = await position();
    await pause(1000);
    if (await position() !== paused) throw new Error('Native paused playback position advanced.');
    await tapId('player-seekbar', 0.6);
    const sought = await position();
    if (sought === paused) throw new Error('Native seek did not change position.');
    key(85);
    await pause(1500);
    key(85);
    await pause(350);
    if (await position() === sought) throw new Error('Native playback did not resume.');
    await tapId('player-back');
    key(4); // Close the movie detail page.
    await tapId('nav-home'); await screen('home');
    playback = { mp4Advancing: true, paused: true, resumed: true, seek: true, changedCenterPixels: changedPixels, sampledVideoWidth: firstFrame.width, sampledVideoHeight: firstFrame.height };
  }
  // Test the D-pad rail path, not just touch: Home -> Live TV -> Settings.
  key(21); key(21);
  key(20); key(23);
  await screen('guide');
  key(21); key(21); key(21);
  for (let i = 0; i < 4; i++) key(20);
  key(23);
  await screen('settings');
  const stats = panel ? await panel.stats() : undefined;
  if (stats) {
    if (stats.requests.xmltv !== 1 || stats.completedXmltv !== 1 || stats.activeXmltv !== 0) {
      throw new Error('Native guide did not finish exactly once: ' + JSON.stringify({ requests: stats.requests.xmltv || 0, completed: stats.completedXmltv, active: stats.activeXmltv, cancelled: stats.cancelledXmltv }));
    }
  }
  const pid = adb(['shell', 'pidof', app]).trim();
  if (!pid) throw new Error('Nova exited during remote navigation.');
  const logs = adb(['logcat', '-d', '--pid=' + pid, 'ReactNativeJS:V', 'AndroidRuntime:E', '*:S']);
  if (/FATAL EXCEPTION|ANR in|Application Not Responding/.test(logs)) throw new Error('Native crash or ANR detected (raw logs withheld to protect provider data).');
  const frames = adb(['shell', 'dumpsys', 'gfxinfo', app]);
  const total = /Total frames rendered:\s*(\d+)/.exec(frames);
  const jank = /Janky frames:\s*(\d+)\s*\(([^)]+)\)/.exec(frames);
  const memory = adb(['shell', 'dumpsys', 'meminfo', app]);
  const pss = /TOTAL PSS:\s*(\d+)/.exec(memory);
  const samples = [];
  for (const match of logs.matchAll(/NOVA_PERF\s+(\{[^\n]+\})/g)) {
    try { samples.push(JSON.parse(match[1])); } catch { /* Ignore truncated log lines. */ }
  }
  const monitor = samples.at(-1) || null;
  if (monitor && monitor.eventLoopLagMs.p95 > 100) throw new Error('Native JS event-loop p95 exceeded the 100 ms budget.');
  if (monitor && monitor.eventLoopLagMs.max > 1000) throw new Error('Native JS event loop froze for over one second.');
  if (monitor?.keyToFrameMs.count && monitor.keyToFrameMs.p95 > 250) throw new Error('Native key-to-frame p95 exceeded the 250 ms budget.');
  const report = { ok: true, nativeRemote: true, screens: timings, monitor, playback, requests: stats?.requests, guideCompleted: stats?.completedXmltv, frames: total ? Number(total[1]) : null, jankyFrames: jank ? Number(jank[1]) : null, jankPercent: jank?.[2] || null, totalPssKb: pss ? Number(pss[1]) : null };
  mkdirSync(resolve('output/performance'), { recursive: true });
  writeFileSync(resolve('output/performance/android.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // Subprocess errors may include device output; never print raw logs/UI state.
  console.error(error instanceof Error && !('stdout' in error) ? error.message : 'Android command failed. Check the device, installed build and ADB connection.');
  process.exitCode = 1;
} finally {
  if (fixture) {
    adb(['reverse', '--remove', 'tcp:8790']);
    await fixture.close();
  }
}
