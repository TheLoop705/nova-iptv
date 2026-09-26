// Generate a submission from the exact installer that will be published.
// Run after packaging; the GitHub release tag must match its Windows version.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { novaWindowsVersion: version } = JSON.parse(readFileSync(join(root, '.desktop/app/package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+\.[1-9]\d*$/.test(version ?? '')) throw new Error('WinGet manifests require a numbered release build');
const tag = `v${version}`;
const repository = 'https://github.com/TheLoop705/nova-iptv';
const id = 'TheLoop705.NovaIPTV';
const schema = '1.12.0';
const installer = 'Nova-windows-x64-Setup.exe';
const hash = createHash('sha256').update(readFileSync(join(root, 'release/windows', installer))).digest('hex').toUpperCase();
const directory = join(root, '.desktop/winget/manifests/t/TheLoop705/NovaIPTV', version);
mkdirSync(directory, { recursive: true });

function write(suffix, type, body) {
  writeFileSync(join(directory, `${id}${suffix}.yaml`),
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${schema}.schema.json\n\n` +
    `PackageIdentifier: ${id}\nPackageVersion: ${version}\n${body}\nManifestType: ${type}\nManifestVersion: ${schema}\n`);
}

write('', 'version', 'DefaultLocale: en-US');
write('.installer', 'installer', `InstallerType: nullsoft
Scope: user
MinimumOSVersion: 10.0.19041.0
InstallModes:
- interactive
- silent
InstallerSwitches:
  Silent: /S
  SilentWithProgress: /S
  Custom: /currentuser
  Upgrade: --updated
  InstallLocation: /D=<INSTALLPATH>
UpgradeBehavior: install
ProductCode: fe2e40c8-7caa-574f-a658-82593e3535bc
AppsAndFeaturesEntries:
- DisplayName: Nova ${version}
  Publisher: TheLoop705
Installers:
- Architecture: x64
  InstallerUrl: ${repository}/releases/download/${tag}/${installer}
  InstallerSha256: ${hash}`);
write('.locale.en-US', 'defaultLocale', `PackageLocale: en-US
Publisher: TheLoop705
PublisherUrl: https://github.com/TheLoop705
PublisherSupportUrl: ${repository}/issues
PrivacyUrl: ${repository}/blob/master/desktop/PRIVACY.md
PackageName: Nova
PackageUrl: ${repository}
License: MIT
LicenseUrl: ${repository}/blob/${tag}/LICENSE
Copyright: Copyright (c) 2026 TheLoop705
ShortDescription: IPTV player for M3U playlists and Xtream Codes providers.
Description: |-
  Nova is an IPTV player with a live TV guide, catch-up, movies and series,
  favorites, watch progress, and keyboard and mouse controls. Add an M3U
  playlist or your Xtream Codes provider. Nova does not supply TV channels
  or subscriptions; a built-in demo uses public test streams.
Moniker: nova-iptv
Tags:
- iptv
- m3u
- media-player
- streaming
- video
- xtream-codes
ReleaseNotesUrl: ${repository}/releases/tag/${tag}`);

writeFileSync(join(root, 'release/windows/SHA256SUMS-windows.txt'), `${hash.toLowerCase()}  ${installer}\n`);
console.log(`Prepared ${id} ${version} in ${directory}`);
