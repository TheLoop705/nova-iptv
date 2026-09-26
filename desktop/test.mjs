import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron');
const directory = mkdtempSync(join(tmpdir(), 'nova-windows-smoke-'));
try {
  // Separate Electron launches prove both SQLite and IndexedDB survive a restart.
  for (const phase of ['write', 'read']) {
    const env = { ...process.env, NOVA_SMOKE_DIR: directory, NOVA_SMOKE_PHASE: phase };
    if (process.argv.includes('--packaged')) env.NOVA_SMOKE_PACKAGE = fileURLToPath(new URL('../release/windows/win-unpacked/resources/app.asar', import.meta.url));
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, [fileURLToPath(new URL('./smoke.mjs', import.meta.url))], {
      env, stdio: 'inherit', windowsHide: true, timeout: 60000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Windows smoke test (${phase}) failed: ${result.status}`);
  }
} finally {
  const parent = resolve(tmpdir());
  const target = resolve(directory);
  if (!target.startsWith(parent + '\\') && !target.startsWith(parent + '/')) throw new Error('Unexpected smoke-test directory');
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
