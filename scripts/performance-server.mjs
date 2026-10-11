import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMockPanel } from '../server/mock-xtream.mjs';

if (!existsSync(resolve('dist/index.html'))) throw new Error('Build the app first: npm run build:perf:web');
const directory = mkdtempSync(join(tmpdir(), 'nova-performance-'));
process.env.NOVA_DB = join(directory, 'test.db');
process.env.DIST = resolve('dist');
process.env.ALLOW_PRIVATE = '1';
process.env.BASIC_AUTH = '';
process.env.ALLOWED_HOSTS = '';
const { server } = await import('../server/index.mjs');
const appRequest = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (req.url === '/__test/shutdown' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    setTimeout(() => void stop().then(() => process.exit(0)), 25);
  } else appRequest(req, res);
});
const main = createMockPanel({ channels: 1000, movies: 25000, series: 10000, programmes: 144, apiDelayMs: 150, xmlChunkDelayMs: 8, streamMode: 'unavailable' }).server;
const empty = createMockPanel({ channels: 1000, movies: 25000, series: 10000, xmlMode: 'empty', streamMode: 'unavailable' }).server;
const fail = createMockPanel({ xmlMode: 'fail', streamMode: 'unavailable' }).server;
const playback = createMockPanel({ channels: 14, movies: 4, series: 1, programmes: 144, streamMode: 'fixture' }).server;
for (const [listener, port] of [[main, 8890], [empty, 8891], [fail, 8892], [playback, 8893], [server, 8878]]) {
  await new Promise((r, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', r); });
}
console.log('Isolated performance app on http://127.0.0.1:8878; deterministic panels on 8890–8893.');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const listener of [main, empty, fail, playback, server]) listener.closeAllConnections();
  await Promise.all([main, empty, fail, playback, server].map((listener) => new Promise((r) => listener.close(r))));
  const target = resolve(directory);
  const parent = resolve(tmpdir());
  if (!target.startsWith(parent + '\\') && !target.startsWith(parent + '/')) throw new Error('Unexpected temporary directory');
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop().then(() => process.exit(0)));
