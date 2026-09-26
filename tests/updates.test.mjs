import test from 'node:test';
import assert from 'node:assert/strict';
import { apkUpdate, webUpdate, isNewer } from '../src/services/updateCore.ts';
import { focusScrollOffset } from '../src/utils/focusScroll.ts';

const asset = (name) => ({ name, size: 1234, browser_download_url: `https://github.com/TheLoop705/nova-iptv/releases/download/v1.7.0/${name}` });
const release = { tag_name: 'v1.7.0', assets: [asset('Nova-firetv.apk'), asset('Nova-universal.apk')] };

test('release versions compare numerically and reject malformed/prerelease versions', () => {
  assert.ok(isNewer('1.10.0', '1.9.9'));
  assert.ok(!isNewer('1.7.0', '1.7.0'));
  assert.ok(!isNewer('1.6.0', '1.7.0'));
  assert.ok(!isNewer('garbage', '1.6.0'));
  assert.ok(!isNewer('1.7.0-beta.1', '1.6.0'));
  assert.ok(isNewer('1.7.0.12', '1.7.0.9'));
  assert.ok(isNewer('1.7.0.1', '1.7.0'));
  assert.ok(isNewer('1.7.0', '1.6.0.99'));
  assert.ok(!isNewer('1.7.0', '1.7.0.1'));
  assert.ok(!isNewer('1.7.0.0', '1.7.0'));
});

test('older installed apps select the matching Fire TV or universal APK', () => {
  assert.match(apkUpdate(release, '1.6.0', 'Amazon').url, /Nova-firetv.apk$/);
  assert.match(apkUpdate(release, '1.6.0', 'Google').url, /Nova-universal.apk$/);
  assert.equal(apkUpdate(release, '1.7.0', 'Amazon'), null);
  assert.equal(apkUpdate({ ...release, tag_name: 'v1.7.0.12' }, '1.7.0.9', 'Amazon').version, '1.7.0.12');
});

test('incomplete releases and foreign URLs cannot be reported as current or installed', () => {
  assert.throws(() => apkUpdate({ ...release, assets: [asset('Nova-universal.apk')] }, '1.6.0', 'Amazon'), /not available/);
  assert.throws(() => apkUpdate({ ...release, assets: [{ ...asset('Nova-firetv.apk'), browser_download_url: 'https://example.com/Nova-firetv.apk' }] }, '1.6.0', 'Amazon'), /not available/);
  assert.throws(() => apkUpdate({ ...release, prerelease: true }, '1.6.0', 'Amazon'), /not ready/);
  assert.throws(() => apkUpdate({}, '1.6.0', 'Amazon'), /version/);
});

test('web detects a new deployment, stays current after reload, and never downgrades', () => {
  const oldBundle = '/_expo/static/js/web/index-old.js';
  const bundle = '/_expo/static/js/web/index-new.js';
  assert.equal(webUpdate({ version: '1.7.0', bundle }, '1.6.0', oldBundle).version, '1.7.0');
  assert.equal(webUpdate({ version: '1.7.0', bundle }, '1.7.0', oldBundle).build, bundle);
  assert.equal(webUpdate({ version: '1.7.0', bundle }, '1.7.0', bundle), null);
  assert.equal(webUpdate({ version: '1.6.0', bundle }, '1.7.0', oldBundle), null);
  assert.throws(() => webUpdate('<html>old server</html>', '1.7.0', bundle), /not published/);
});

test('playlist focus reveals lower controls, moves back up, and leaves visible fields still', () => {
  assert.equal(focusScrollOffset(0, 650, 50, 0, 540, 12), 172);
  assert.equal(focusScrollOffset(172, 478, 50, 0, 540, 12), 172);
  assert.equal(focusScrollOffset(172, -100, 50, 0, 540, 12), 60);
  assert.equal(focusScrollOffset(0, 0, 50, 0, 540, 12), 0);
  assert.equal(focusScrollOffset(100, 50, 600, 0, 300, 12), 138);
  assert.equal(focusScrollOffset(138, 12, 600, 0, 300, 12), 138);
});
