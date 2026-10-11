import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const electron = createRequire(new URL('../desktop/package.json', import.meta.url))('electron');
const directory = mkdtempSync(join(tmpdir(), 'nova-windows-performance-'));
try {
  const env = { ...process.env, NOVA_PERF_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [join(root, 'desktop', 'performance.mjs')], {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows performance checks failed (${result.status})`);
} finally {
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + '\\') && !target.startsWith(resolve(tmpdir()) + '/')) throw new Error('Unexpected performance-test directory');
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
