const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const metadata = JSON.parse(readFileSync(join(__dirname, '../.desktop/app/package.json'), 'utf8'));
const version = metadata.novaWindowsVersion;
if (!/^\d+\.\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Run prepare:app before packaging Windows');

module.exports = {
  appId: 'com.theloop705.nova',
  productName: 'Nova',
  buildVersion: version,
  buildNumber: version.split('.').at(-1),
  directories: { app: '../.desktop/app', output: '../release/windows' },
  asar: true,
  beforeBuild: './before-build.cjs',
  files: ['desktop/*.mjs', 'server/index.mjs', 'dist/**/*', 'assets/icon.png', 'package.json', 'LICENSE', '!node_modules/**/*'],
  win: {
    icon: '../assets/icon.png',
    executableName: 'Nova',
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    // Preserve the ID generated for the first Windows release so upgrades find it.
    guid: 'fe2e40c8-7caa-574f-a658-82593e3535bc',
    include: '../.desktop/windows-version.nsh',
    uninstallDisplayName: `Nova ${version}`,
    artifactName: 'Nova-windows-x64-Setup.exe',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: 'Nova',
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  },
  publish: null,
};
