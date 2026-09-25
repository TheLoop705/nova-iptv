import type { Channel, Program } from '../types';
import { normalizeName } from '../utils/format';
import type { EpgData } from './xmltv';

export function buildEpgIndex(channels: Channel[], epg: EpgData): Record<string, Program[]> {
  const out: Record<string, Program[]> = {};
  // cache case-insensitive lookups once instead of per channel
  const lowerKeys = new Map<string, string>();
  for (const k in epg.programs) lowerKeys.set(k.toLowerCase(), k);
  for (const ch of channels) {
    let key: string | undefined;
    if (ch.tvgId) {
      key = epg.programs[ch.tvgId] ? ch.tvgId : lowerKeys.get(ch.tvgId.toLowerCase());
      // iptv-org style "channel.de@HD" feeds share the base channel's guide
      if (!key && ch.tvgId.includes('@')) key = lowerKeys.get(ch.tvgId.split('@')[0].toLowerCase());
    }
    if (!key) {
      for (const n of [ch.tvgName, ch.name]) {
        if (!n) continue;
        const id = epg.names[normalizeName(n)];
        if (id && epg.programs[id]) {
          key = id;
          break;
        }
      }
    }
    if (key) out[ch.id] = epg.programs[key];
  }
  return out;
}

/** Index of the last programme starting at or before t (binary search). */
export function indexAt(list: Program[] | undefined, t: number): number {
  if (!list || !list.length) return -1;
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function programAt(list: Program[] | undefined, t: number): Program | undefined {
  const i = indexAt(list, t);
  if (i < 0 || !list) return undefined;
  const p = list[i];
  return p.end > t ? p : undefined;
}

export function nextProgram(list: Program[] | undefined, t: number): Program | undefined {
  if (!list) return undefined;
  const i = indexAt(list, t);
  const n = list[i + 1];
  return n && n.start >= t ? n : list[0]?.start > t ? list[0] : undefined;
}

export interface Cell {
  start: number;
  end: number;
  program?: Program;
}

/**
 * Cells covering [from, to): real programmes plus "no information" filler blocks,
 * so every point in time on a row is focusable. Cells keep their true bounds (they may
 * start before `from`); the renderer clips them to the visible window.
 */
export function cellsInRange(list: Program[] | undefined, from: number, to: number, fillerMs = 60 * 60000): Cell[] {
  const cells: Cell[] = [];
  let t = from;
  for (let guard = 0; t < to && guard < 400; guard++) {
    const c = cellAt(list, t, fillerMs);
    cells.push(c);
    t = Math.max(c.end, t + 60000);
  }
  return cells;
}

/** The cell containing time t on a row (programme or filler). */
export function cellAt(list: Program[] | undefined, t: number, fillerMs = 60 * 60000): Cell {
  const p = programAt(list, t);
  if (p) return { start: p.start, end: p.end, program: p };
  // gap: bounded by neighbouring programmes and the filler grid
  const i = indexAt(list, t);
  const prevEnd = i >= 0 && list ? list[i].end : -Infinity;
  const nextStart = list && list[i + 1] ? list[i + 1].start : Infinity;
  const blockStart = Math.floor(t / fillerMs) * fillerMs;
  const start = Math.max(prevEnd, blockStart);
  const end = Math.min(nextStart, blockStart + fillerMs);
  return { start, end };
}
