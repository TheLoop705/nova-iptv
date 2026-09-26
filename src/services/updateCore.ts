export interface Update {
  version: string;
  notes: string;
  url: string;
  size: number;
  build?: string;
}

export type UpdateStatus = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error';
export interface UpdaterState {
  status: UpdateStatus;
  update?: Update;
  progress: number;
  error?: string;
  checkedAt?: number;
  check: () => Promise<Update | null>;
  install: () => Promise<void>;
}

export const REPO = 'TheLoop705/nova-iptv';
// CI appends its run number; older manually published builds have three components.
export const validVersion = (version: string) => /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version);

export function isNewer(candidate: string, current: string): boolean {
  if (!validVersion(candidate) || !validVersion(current)) return false;
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function apkUpdate(release: any, current: string, manufacturer: string): Update | null {
  const version = String(release?.tag_name ?? '').replace(/^v/i, '');
  if (!validVersion(version) || !validVersion(current)) throw new Error('Could not read the release version');
  if (release?.draft || release?.prerelease) throw new Error('The latest release is not ready');
  if (!isNewer(version, current)) return null;
  const name = /amazon/i.test(manufacturer) ? 'Nova-firetv.apk' : 'Nova-universal.apk';
  const asset = Array.isArray(release.assets) ? release.assets.find((a: any) => a?.name === name) : undefined;
  // Do not substitute a different architecture or call an incomplete release "up to date".
  const prefix = `https://github.com/${REPO}/releases/download/`;
  const url = String(asset?.browser_download_url ?? '');
  if (!asset || !url.startsWith(prefix) || !url.endsWith(`/${name}`) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error('The download for this device is not available yet. Try again later.');
  }
  return { version, notes: String(release.body ?? ''), url, size: asset.size };
}

export function webUpdate(manifest: any, current: string, currentBundle: string): Update | null {
  if (!validVersion(manifest?.version ?? '') || typeof manifest?.bundle !== 'string' || !/^\/_expo\/static\/js\/web\/[^/]+\.js$/.test(manifest.bundle)) {
    throw new Error('This server has not published web update information yet');
  }
  if (!isNewer(manifest.version, current) && !(manifest.version === current && currentBundle && manifest.bundle !== currentBundle)) return null;
  return { version: manifest.version, build: manifest.bundle, notes: '', url: '', size: 0 };
}
