// Keep Electron and its build tools in desktop/ so Android's npm ci stays small.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, '.desktop', 'app');
const config = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(config.expo.version)) throw new Error('Windows packaging expects the source version to be x.y.z');
const buildNumber = process.env.GITHUB_RUN_NUMBER ?? '0';
if (!/^\d+$/.test(buildNumber) || Number(buildNumber) > 65535 || (process.env.GITHUB_ACTIONS && Number(buildNumber) < 1)) {
  throw new Error('Windows build number must be between 0 and 65535 (positive in CI)');
}
const windowsVersion = `${config.expo.version}.${Number(buildNumber)}`;
if (windowsVersion.split('.').some(part => Number(part) > 65535)) throw new Error('Windows version components must fit in 16 bits');
mkdirSync(target, { recursive: true });
// Electron's package version must be SemVer. Windows file/installer versions use
// the fourth component so WinGet can distinguish every published CI release.
writeFileSync(join(root, '.desktop', 'windows-version.nsh'), `!undef VERSION\n!define VERSION "${windowsVersion}"\n`);

for (const file of ['desktop/main.mjs', 'desktop/runtime.mjs', 'server/index.mjs', 'assets/icon.png', 'LICENSE']) {
  mkdirSync(dirname(join(target, file)), { recursive: true });
  cpSync(join(root, file), join(target, file));
}
writeFileSync(join(target, 'package.json'), JSON.stringify({
  name: 'nova-iptv-desktop',
  productName: 'Nova',
  version: config.expo.version,
  novaWindowsVersion: windowsVersion,
  description: 'Nova IPTV player for Windows',
  author: 'TheLoop705',
  homepage: 'https://github.com/TheLoop705/nova-iptv',
  license: 'MIT',
  main: 'desktop/main.mjs',
  dependencies: {},
}, null, 2) + '\n');
console.log(`Windows release ${windowsVersion}`);

const result = spawnSync(process.execPath, [
  join(root, 'node_modules', 'expo', 'bin', 'cli'),
  'export', '--platform', 'web', '--output-dir', join(target, 'dist'), '--clear',
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, EXPO_PUBLIC_DESKTOP: '1', EXPO_PUBLIC_PROXY_URL: '', NODE_ENV: 'production' },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Ship the same typeface locally so the installed UI also renders fully offline.
const fontSource = join(root, 'desktop', 'node_modules', '@fontsource-variable', 'figtree');
const fonts = join(target, 'dist', 'fonts');
mkdirSync(join(fonts, 'files'), { recursive: true });
writeFileSync(join(fonts, 'figtree.css'), readFileSync(join(fontSource, 'index.css'), 'utf8').replaceAll("'Figtree Variable'", "'Figtree'"));
for (const name of ['figtree-latin-wght-normal.woff2', 'figtree-latin-ext-wght-normal.woff2']) cpSync(join(fontSource, 'files', name), join(fonts, 'files', name));
cpSync(join(fontSource, 'LICENSE'), join(fonts, 'OFL.txt'));

const manifest = spawnSync(process.execPath, [join(root, 'scripts', 'write-web-version.mjs'), join(target, 'dist')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (manifest.error) throw manifest.error;
if (manifest.status !== 0) process.exit(manifest.status ?? 1);
