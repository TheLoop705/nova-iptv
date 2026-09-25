import type { Catchup, Channel, VodItem } from '../types';
import { hashString } from '../utils/format';

export interface M3UResult {
  channels: Channel[];
  movies: VodItem[];
  epgUrls: string[];
  catchup?: Catchup;
}

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** Splits `#EXTINF:-1 key="v",Display name` into attrs + name, respecting commas inside quotes. */
function splitExtinf(line: string): { attrs: Record<string, string>; name: string } {
  let inQuote = false;
  let comma = -1;
  for (let i = 8; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) {
      comma = i;
      break;
    }
  }
  const head = comma === -1 ? line : line.slice(0, comma);
  const name = comma === -1 ? '' : line.slice(comma + 1).trim();
  return { attrs: parseAttrs(head), name };
}

const isVodUrl = (url: string) => /\/(movie|movies|vod)\//i.test(url) || /\.(mp4|mkv|avi|mov|m4v)(\?|$)/i.test(url);

export function parseM3U(text: string): M3UResult {
  const channels: Channel[] = [];
  const movies: VodItem[] = [];
  const epgUrls: string[] = [];
  const seen = new Map<string, number>();
  let headerCatchup: Catchup | undefined;

  let pending: { attrs: Record<string, string>; name: string } | null = null;
  let pendingGroup: string | undefined;
  let pendingUA: string | undefined;

  let pos = 0;
  const len = text.length;
  while (pos < len) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = len;
    let line = text.slice(pos, nl).trim();
    pos = nl + 1;
    if (!line) continue;
    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);

    if (line.startsWith('#EXTM3U')) {
      const a = parseAttrs(line);
      const tvg = a['url-tvg'] || a['x-tvg-url'] || a['tvg-url'];
      if (tvg) for (const u of tvg.split(',')) if (u.trim()) epgUrls.push(u.trim());
      if (a['catchup']) {
        headerCatchup = { type: a['catchup'], days: parseInt(a['catchup-days'] || '7', 10) || 7, source: a['catchup-source'] };
      }
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      pending = splitExtinf(line);
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      pendingGroup = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice(11);
      const m = /^http-user-agent=(.+)$/i.exec(opt);
      if (m) pendingUA = m[1].trim();
      continue;
    }
    if (line[0] === '#') continue;

    // URL line
    const url = line;
    const info = pending ?? { attrs: {}, name: url.split('/').pop() || 'Channel' };
    const a = info.attrs;
    const name = info.name || a['tvg-name'] || 'Channel';
    const group = a['group-title'] || pendingGroup || 'Uncategorized';
    const logo = a['tvg-logo'] || a['logo'] || undefined;
    pending = null;
    pendingGroup = undefined;
    const ua = pendingUA || a['user-agent'] || a['http-user-agent'];
    pendingUA = undefined;

    if (isVodUrl(url) && !/\/live\//i.test(url)) {
      const id = 'm' + hashString(name + '|' + url);
      movies.push({ id, name, poster: logo, categoryId: group, url });
      continue;
    }

    let baseId = hashString(`${name}|${a['tvg-id'] ?? ''}|${group}`);
    const dup = seen.get(baseId) ?? 0;
    seen.set(baseId, dup + 1);
    if (dup) baseId += '_' + dup;

    const catchupType = a['catchup'] || a['catchup-type'] || (a['timeshift'] || a['tvg-rec'] ? 'default' : undefined);
    let catchup: Catchup | undefined;
    if (catchupType || headerCatchup) {
      const days = parseInt(a['catchup-days'] || a['timeshift'] || a['tvg-rec'] || '', 10) || headerCatchup?.days || 0;
      if (days > 0) {
        catchup = {
          type: catchupType || headerCatchup!.type,
          days,
          source: a['catchup-source'] || headerCatchup?.source,
        };
      }
    }

    const chno = parseInt(a['tvg-chno'] || a['channel-number'] || '', 10);
    channels.push({
      id: baseId,
      num: Number.isFinite(chno) && chno > 0 ? chno : 0,
      name,
      logo,
      group,
      url,
      tvgId: a['tvg-id'] || undefined,
      tvgName: a['tvg-name'] || undefined,
      catchup,
      userAgent: ua,
    });
  }

  // Assign numbers: keep explicit tvg-chno, fill the rest sequentially
  let next = 1;
  const used = new Set(channels.filter((c) => c.num > 0).map((c) => c.num));
  for (const c of channels) {
    if (c.num > 0) continue;
    while (used.has(next)) next++;
    c.num = next++;
  }
  return { channels, movies, epgUrls, catchup: headerCatchup };
}
