import type { Program } from '../types';
import { decodeEntities, normalizeName } from '../utils/format';

export interface EpgData {
  /** programmes keyed by XMLTV channel id, sorted by start */
  programs: Record<string, Program[]>;
  /** normalized display-name -> channel id, for playlists without tvg-id */
  names: Record<string, string>;
  /** XMLTV channel icons, used when the playlist has no logo */
  icons: Record<string, string>;
  fetchedAt: number;
}

export function emptyEpg(): EpgData {
  return { programs: {}, names: {}, icons: {}, fetchedAt: Date.now() };
}

/** "20260924120000 +0200" -> epoch ms */
export function parseXmltvTime(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}:?\d{2}|Z)?/.exec(s.trim());
  if (!m) return NaN;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const tz = m[7];
  if (!tz || tz === 'Z') return utc; // no offset: treat as UTC
  const sign = tz[0] === '-' ? -1 : 1;
  const digits = tz.replace(/[^\d]/g, '');
  const offset = (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2, 4), 10)) * 60000;
  return utc - sign * offset;
}

const attrRes = new Map<string, RegExp>();
const attr = (tag: string, name: string) => {
  let re = attrRes.get(name);
  if (!re) {
    re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrRes.set(name, re);
  }
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
};

const inner = (xml: string, tag: string) => {
  const open = xml.indexOf('<' + tag);
  if (open === -1) return undefined;
  const gt = xml.indexOf('>', open);
  if (gt === -1 || xml[gt - 1] === '/') return undefined;
  const close = xml.indexOf('</' + tag + '>', gt);
  if (close === -1) return undefined;
  let v = xml.slice(gt + 1, close);
  if (v.startsWith('<![CDATA[')) v = v.slice(9, v.endsWith(']]>') ? -3 : undefined);
  return decodeEntities(v.trim());
};

export interface XmltvFilter {
  /** lowercase tvg-ids present in the playlist */
  ids: Set<string>;
  /** normalized names present in the playlist */
  names: Set<string>;
  from: number;
  to: number;
}

/**
 * Incremental XMLTV parser: feed it text chunks as they stream in.
 * Keeps only programmes for channels in the playlist within [from, to] to bound memory.
 */
export class XmltvParser {
  private buf = '';
  private data = emptyEpg();
  private wanted = new Map<string, string | null>(); // xmltv id -> key to store under (null = skip)
  private displayNames = new Map<string, string[]>();
  count = 0;

  constructor(private filter: XmltvFilter) {}

  push(chunk: string) {
    this.buf += chunk;
    let consumed = 0;
    const b = this.buf;
    while (true) {
      const p = b.indexOf('<programme', consumed);
      const c = b.indexOf('<channel', consumed);
      let start: number;
      let isProg: boolean;
      if (p === -1 && c === -1) break;
      if (p !== -1 && (c === -1 || p < c)) {
        start = p;
        isProg = true;
      } else {
        start = c;
        isProg = false;
      }
      const closeTag = isProg ? '</programme>' : '</channel>';
      const end = b.indexOf(closeTag, start);
      if (end === -1) {
        // Self-closing <channel id="x"/> is valid too
        if (!isProg) {
          const gt = b.indexOf('>', start);
          if (gt !== -1 && b[gt - 1] === '/') {
            this.onChannel(b.slice(start, gt + 1));
            consumed = gt + 1;
            continue;
          }
        }
        consumed = start;
        break;
      }
      const el = b.slice(start, end + closeTag.length);
      if (isProg) this.onProgramme(el);
      else this.onChannel(el);
      consumed = end + closeTag.length;
    }
    // keep only the unconsumed tail (bounded; drop junk that can't be an element start)
    this.buf = consumed ? b.slice(consumed) : b;
    if (this.buf.length > 4_000_000 && this.buf.indexOf('<programme') === -1 && this.buf.indexOf('<channel') === -1) {
      this.buf = this.buf.slice(-2000);
    }
  }

  private onChannel(el: string) {
    const gt = el.indexOf('>');
    const id = attr(el.slice(0, gt + 1), 'id');
    if (!id) return;
    const names: string[] = [];
    const re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(el))) names.push(decodeEntities(m[1].trim()));
    this.displayNames.set(id, names);
    for (const n of names) {
      const k = normalizeName(n);
      if (k && !this.data.names[k]) this.data.names[k] = id;
    }
    const icon = /<icon[^>]*src="([^"]+)"/.exec(el);
    if (icon) this.data.icons[id] = icon[1];
  }

  private resolve(id: string): string | null {
    let key = this.wanted.get(id);
    if (key !== undefined) return key;
    key = null;
    if (this.filter.ids.has(id.toLowerCase())) key = id;
    else {
      const names = this.displayNames.get(id) ?? [id];
      if (names.some((n) => this.filter.names.has(normalizeName(n)))) key = id;
    }
    this.wanted.set(id, key);
    return key;
  }

  private onProgramme(el: string) {
    const gt = el.indexOf('>');
    const head = el.slice(0, gt + 1);
    const ch = attr(head, 'channel');
    if (!ch) return;
    const key = this.resolve(ch);
    if (!key) return;
    const start = parseXmltvTime(attr(head, 'start') ?? '');
    const end = parseXmltvTime(attr(head, 'stop') ?? '');
    if (!isFinite(start) || !isFinite(end) || end <= start) return;
    if (end < this.filter.from || start > this.filter.to) return;
    const body = el.slice(gt + 1);
    const title = inner(body, 'title') ?? '';
    let desc = inner(body, 'desc');
    if (desc && desc.length > 420) desc = desc.slice(0, 417) + '…';
    const category = inner(body, 'category');
    const list = (this.data.programs[key] ??= []);
    list.push({ start, end, title, desc: desc || undefined, category: category || undefined });
    this.count++;
  }

  finish(): EpgData {
    for (const k of Object.keys(this.data.programs)) {
      const list = this.data.programs[k];
      list.sort((a, b) => a.start - b.start);
      // drop overlaps/duplicates that some providers emit
      const out: Program[] = [];
      for (const p of list) {
        const last = out[out.length - 1];
        if (last && p.start < last.end) {
          if (p.start === last.start) continue;
          last.end = p.start;
        }
        out.push(p);
      }
      this.data.programs[k] = out;
    }
    this.data.fetchedAt = Date.now();
    this.buf = '';
    return this.data;
  }
}

/** Merge b into a (a wins on conflicting channel ids). */
export function mergeEpg(a: EpgData, b: EpgData): EpgData {
  const out: EpgData = {
    programs: { ...b.programs, ...a.programs },
    names: { ...b.names, ...a.names },
    icons: { ...b.icons, ...a.icons },
    fetchedAt: Math.max(a.fetchedAt, b.fetchedAt),
  };
  return out;
}
