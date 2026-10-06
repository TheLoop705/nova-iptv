import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
// Environment assignments in npm scripts are shell-specific; this also works on Windows.
const child = spawn(process.execPath, [resolve('node_modules/expo/bin/cli'), 'start', '--web'], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, EXPO_PUBLIC_PROXY_URL: 'http://localhost:8787' },
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
