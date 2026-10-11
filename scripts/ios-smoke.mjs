import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, cpSync, createWriteStream, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMockPanel } from '../server/mock-xtream.mjs';

if (process.platform !== 'darwin') {
  console.error('Run this harness on the connected Mac in an isolated checkout: node scripts/ios-smoke.mjs');
  process.exit(1);
}
const root = resolve('.');
const output = resolve('output/performance');
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'nova-ios-performance-'));
const env = { ...process.env, PATH: '/opt/homebrew/bin:' + process.env.PATH, EXPO_PUBLIC_PERF_MONITOR: '1' };
const call = (file, args, timeout = 120000) => execFileSync(file, args, { encoding: 'utf8', env, timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function run(label, command, args, logName, timeout = 1200000) {
  const log = createWriteStream(join(output, logName));
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const status = await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); }).finally(() => { clearTimeout(timer); log.end(); });
  if (status !== 0) throw new Error(label + ' failed. Inspect output/performance/' + logName + '.');
}
let simulator;
let panel;
try {
  const runtimes = JSON.parse(call('xcrun', ['simctl', 'list', 'runtimes', '--json'])).runtimes;
  const runtime = process.env.NOVA_TEST_IOS_RUNTIME || runtimes.findLast((value) => value.isAvailable && value.name.startsWith('iOS'))?.identifier;
  if (!runtime) throw new Error('No available iOS simulator runtime.');
  const type = process.env.NOVA_TEST_IOS_DEVICE_TYPE || 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
  simulator = call('xcrun', ['simctl', 'create', 'Nova Performance ' + Date.now(), type, runtime]);
  call('xcrun', ['simctl', 'boot', simulator]);
  await run('Simulator boot', 'xcrun', ['simctl', 'bootstatus', simulator, '-b'], 'ios-boot.log', 180000);
  let application = process.env.NOVA_TEST_IOS_APP;
  if (!application) {
    if (!existsSync(join(root, 'ios', 'Nova.xcworkspace'))) throw new Error('Generate/install the iOS project first, or set NOVA_TEST_IOS_APP to a Release simulator .app.');
    await run('iOS Release build', 'xcodebuild', [
      '-workspace', join(root, 'ios', 'Nova.xcworkspace'), '-scheme', 'Nova', '-configuration', 'Release',
      '-sdk', 'iphonesimulator', '-destination', 'platform=iOS Simulator,id=' + simulator,
      '-derivedDataPath', join(output, 'ios-derived-data'), 'CODE_SIGNING_ALLOWED=NO',
    ], 'ios-build.log');
    application = join(output, 'ios-derived-data', 'Build', 'Products', 'Release-iphonesimulator', 'Nova.app');
  }
  call('xcrun', ['simctl', 'install', simulator, resolve(application)]);
  const container = call('xcrun', ['simctl', 'get_app_container', simulator, 'com.theloop705.nova', 'data']);
  // Simulator is newly created by this runner; no existing device or user library is changed.
  if (!container.includes(simulator)) throw new Error('Unexpected simulator app container.');
  const settingsDirectory = join(container, 'Documents', 'nova');
  mkdirSync(settingsDirectory, { recursive: true });
  panel = createMockPanel({ channels: 1000, movies: 25000, series: 10000, programmes: 144, xmlChunkDelayMs: 8, streamMode: 'fixture' });
  await new Promise((r, reject) => { panel.server.once('error', reject); panel.server.listen(0, '127.0.0.1', r); });
  const settings = {
    playlists: [{ id: 'ios-performance', name: 'Performance Fixture', type: 'xtream', server: 'http://127.0.0.1:' + panel.server.address().port, username: 'demo', password: 'demo', createdAt: 1 }],
    activeId: 'ios-performance',
    prefs: { previewInGuide: false, startWithLastChannel: false, iosPlayer: 'native', epgRefreshHours: 12, epgPastDays: 2, epgFutureDays: 3 },
  };
  writeFileSync(join(settingsDirectory, 'settings.json'), JSON.stringify(settings));
  writeFileSync(join(settingsDirectory, 'device.json'), JSON.stringify({ activeId: settings.activeId }));
  const uiProject = join(directory, 'UI');
  cpSync(join(root, 'tests', 'ios'), uiProject, { recursive: true });
  writeFileSync(join(uiProject, 'fixture.json'), JSON.stringify({ url: settings.playlists[0].server }));
  call('xcodegen', ['generate', '--spec', join(uiProject, 'project.yml'), '--project', uiProject]);
  const resultBundle = join(output, 'ios-' + Date.now() + '.xcresult');
  await run('iOS UI/MP4 smoke', 'xcodebuild', [
    'test', '-project', join(uiProject, 'NovaPerformanceUI.xcodeproj'), '-scheme', 'NovaPerformanceUI',
    '-destination', 'platform=iOS Simulator,id=' + simulator, '-derivedDataPath', join(directory, 'UITestBuild'),
    '-resultBundlePath', resultBundle, 'CODE_SIGNING_ALLOWED=NO',
  ], 'ios-ui.log', 600000);
  let systemLogs = '';
  // Some simulator versions do not expose Release JS console logs. UI,
  // request-count and decoding assertions remain mandatory; unavailable
  // optional diagnostics are reported as null rather than hiding those results.
  try { systemLogs = call('xcrun', ['simctl', 'spawn', simulator, 'log', 'show', '--style', 'compact', '--last', '5m', '--predicate', 'process == "Nova"'], 30000); }
  catch { /* Native timing diagnostics unavailable on this simulator. */ }
  const samples = [];
  for (const match of systemLogs.matchAll(/NOVA_PERF\s+(\{[^\n]+\})/g)) {
    try { samples.push(JSON.parse(match[1])); } catch { /* Ignore truncated log lines. */ }
  }
  const monitor = samples.at(-1) || null;
  if (monitor && monitor.eventLoopLagMs.p95 > 100) throw new Error('iOS event-loop p95 exceeded 100 ms.');
  if (monitor && monitor.eventLoopLagMs.max > 1000) throw new Error('iOS event loop froze for over one second.');
  if (panel.stats.requests.xmltv !== 1 || panel.stats.completedXmltv !== 1 || panel.stats.activeXmltv !== 0) throw new Error('iOS guide did not complete exactly once.');
  const testLog = readFileSync(join(output, 'ios-ui.log'), 'utf8');
  const navigation = [...testLog.matchAll(/NOVA_IOS_NAVIGATION\s+(\w+)\s+(\d+)/g)].map((match) => ({ screen: match[1], observedWithinMs: Number(match[2]) }));
  const changedPixels = Number(/NOVA_IOS_DECODED_CHANGED_PIXELS\s+(\d+)/.exec(testLog)?.[1] || 0);
  if (changedPixels <= 100) throw new Error('iOS did not report changing decoded video pixels.');
  const report = { ok: true, platform: 'iOS Release simulator', mockOnly: true, uiTests: 2, mp4ProgressPauseResumeSeek: true, changedCenterPixels: changedPixels, navigation, guideRequests: panel.stats.requests.xmltv || 0, requests: panel.stats.requests, monitor, resultBundle };
  writeFileSync(join(output, 'ios.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error && !('stdout' in error) ? error.message : 'iOS command failed. Check Xcode, simulator runtime and the generated project.');
  process.exitCode = 1;
} finally {
  if (panel) { panel.server.closeAllConnections(); await new Promise((r) => panel.server.close(r)); }
  if (simulator && process.env.NOVA_TEST_KEEP_IOS_SIM !== '1') {
    try { call('xcrun', ['simctl', 'shutdown', simulator]); } catch { /* Already shut down. */ }
    try { call('xcrun', ['simctl', 'delete', simulator]); } catch { /* Keep logs even if simulator cleanup fails. */ }
  }
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + '/')) throw new Error('Unexpected iOS test directory.');
  rmSync(target, { recursive: true, force: true });
}
