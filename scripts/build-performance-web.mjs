import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const result = spawnSync(process.execPath, [resolve('node_modules/expo/bin/cli'), 'export', '-p', 'web'], {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env, EXPO_PUBLIC_PERF_MONITOR: '1', EXPO_PUBLIC_PROXY_URL: '', EXPO_PUBLIC_DESKTOP: '0' },
});
process.exitCode = result.status ?? 1;
