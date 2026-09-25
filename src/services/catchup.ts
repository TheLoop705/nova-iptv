import type { Channel, Program } from '../types';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Builds an archive URL for M3U channels following the common Kodi/TiviMate catch-up conventions.
 * Supported: default, append, shift, flussonic(-hls/-ts), fs.
 */
export function m3uCatchupUrl(ch: Channel, p: Program, now = Date.now()): string | null {
  const c = ch.catchup;
  if (!c) return null;
  const start = Math.floor(p.start / 1000);
  const end = Math.floor(p.end / 1000);
  const duration = end - start;
  const fill = (tpl: string) => {
    const d = new Date(p.start);
    const e = new Date(p.end);
    return tpl
      .replace(/\{utc\}|\$\{start\}|\{start\}/g, String(start))
      .replace(/\{utcend\}|\$\{end\}|\{end\}/g, String(end))
      .replace(/\{lutc\}|\$\{now\}|\{now\}|\$\{timestamp\}|\{timestamp\}/g, String(Math.floor(now / 1000)))
      .replace(/\{duration\}|\$\{duration\}/g, String(duration))
      .replace(/\{duration:(\d+)\}/g, (_, div) => String(Math.floor(duration / Number(div))))
      .replace(/\{offset:(\d+)\}/g, (_, div) => String(Math.floor((now / 1000 - start) / Number(div))))
      .replace(/\{Y\}/g, String(d.getUTCFullYear()))
      .replace(/\{m\}/g, pad(d.getUTCMonth() + 1))
      .replace(/\{d\}/g, pad(d.getUTCDate()))
      .replace(/\{H\}/g, pad(d.getUTCHours()))
      .replace(/\{M\}/g, pad(d.getUTCMinutes()))
      .replace(/\{S\}/g, pad(d.getUTCSeconds()))
      .replace(/\{\(b\)yyyy\}/g, String(d.getUTCFullYear()))
      .replace(/\{\(e\)yyyy\}/g, String(e.getUTCFullYear()));
  };

  const type = c.type.toLowerCase();
  switch (type) {
    case 'append':
      return c.source ? ch.url + fill(c.source) : null;
    case 'shift':
    case 'timeshift':
      return `${ch.url}${ch.url.includes('?') ? '&' : '?'}utc=${start}&lutc=${Math.floor(now / 1000)}`;
    case 'flussonic':
    case 'flussonic-hls':
    case 'flussonic-ts':
    case 'fs': {
      const m = /^(https?:\/\/[^/]+)\/(.+)\/([^/]*)(\?.*)?$/.exec(ch.url);
      if (!m) return null;
      const [, host, streamPath, file, query = ''] = m;
      if (type === 'flussonic-ts' || file.endsWith('.ts') || file === 'mpegts') {
        return `${host}/${streamPath}/timeshift_abs-${start}.ts${query}`;
      }
      const base = file.replace(/\.m3u8$/, '') || 'index';
      return `${host}/${streamPath}/${base}-${start}-${duration}.m3u8${query}`;
    }
    case 'default':
    default:
      if (c.source) return /^https?:\/\//.test(c.source) ? fill(c.source) : ch.url + fill(c.source);
      return `${ch.url}${ch.url.includes('?') ? '&' : '?'}utc=${start}&lutc=${Math.floor(now / 1000)}`;
  }
}

export function canCatchup(ch: Channel | undefined, p: Program | undefined, now = Date.now()): boolean {
  if (!ch?.catchup || !p) return false;
  if (p.start >= now) return false;
  return now - p.start <= ch.catchup.days * 86400000;
}
