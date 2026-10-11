import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMockPanel } from '../server/mock-xtream.mjs';

async function runProvider(origin) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/provider-smoke.mjs', import.meta.url))], {
    windowsHide: true,
    env: { ...process.env, NOVA_TEST_SERVER: origin, NOVA_TEST_USERNAME: 'demo', NOVA_TEST_PASSWORD: 'demo', NOVA_TEST_EPG_URL: '', NOVA_TEST_USER_AGENT: '', NOVA_TEST_TIMEOUT_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const exitCode = await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); });
  return { exitCode, stdout, stderr };
}
test('private-provider CLI checks real HTTP and gzip without leaking login values', async (t) => {
  const { server } = createMockPanel({ channels: 20, movies: 100, series: 50, programmes: 24 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const result = await runProvider(origin);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 8);
  assert.equal(report.checks.find((c) => c.check === 'Movies').items, 100);
  assert.equal(report.checks.find((c) => c.check === 'Guide transfer').programmes, 480);
  assert.doesNotMatch(result.stdout + result.stderr, /username|password|demo|127\.0\.0\.1/);
});
test('private-provider CLI fails safely when headers arrive but the guide body stalls', async (t) => {
  const { server } = createMockPanel({ xmlMode: 'stall' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const started = Date.now();
  const result = await runProvider('http://127.0.0.1:' + server.address().port);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Guide transfer failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /demo|127\.0\.0\.1|password=/);
  assert.ok(Date.now() - started < 5000, 'Provider body deadline must include reading after headers');
});

test('private-provider CLI rejects HTTP-200 provider error catalogs without printing their contents', async (t) => {
  const { server } = createMockPanel({ channels: 1, movies: 1, series: 1, programmes: 1 });
  const handler = server.listeners('request')[0];
  server.removeListener('request', handler);
  server.on('request', (request, response) => {
    if (new URL(request.url, 'http://fixture.test').searchParams.get('action') === 'get_vod_streams') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unauthorized private-user private-password https://private.example/token=secret' }));
    } else handler(request, response);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const result = await runProvider('http://127.0.0.1:' + server.address().port);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Movies failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /Unauthorized|private-|https:|token=|demo|127\.0\.0\.1/);
});

test('private-provider CLI accepts keyed catalog records and valid empty collections', async (t) => {
  const { server } = createMockPanel({ channels: 1, movies: 1, series: 1, programmes: 1 });
  const handler = server.listeners('request')[0];
  server.removeListener('request', handler);
  server.on('request', (request, response) => {
    const action = new URL(request.url, 'http://fixture.test').searchParams.get('action');
    if (action === 'get_vod_streams' || action === 'get_series') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(action === 'get_series' ? {} : { first: { stream_id: 1, name: 'Valid movie' } }));
    } else handler(request, response);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const result = await runProvider('http://127.0.0.1:' + server.address().port);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find((c) => c.check === 'Movies').items, 1);
  assert.equal(report.checks.find((c) => c.check === 'Series').items, 0);
});
