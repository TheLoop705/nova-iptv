export function hashString(input: string): string {
  // FNV-1a 32-bit, base36 — stable ids for channels across refreshes
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const pad = (n: number) => (n < 10 ? '0' + n : String(n));

export function formatClock(ms: number, h24 = true): string {
  const d = new Date(ms);
  if (h24) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let h = d.getHours() % 12;
  if (h === 0) h = 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

export function formatRange(start: number, end: number, h24 = true) {
  return `${formatClock(start, h24)} – ${formatClock(end, h24)}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDay(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(d) - startOf(today)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function minutesLabel(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(hd|fhd|uhd|4k|sd|hevc|h265|backup)\b/g, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return (words[0][0] + words[1][0] + (words[2]?.[0] ?? '')).toUpperCase();
}

export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  });
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function b64decode(s: string): string {
  if (!s) return '';
  try {
    const bin = globalThis.atob ? globalThis.atob(s) : s;
    // atob yields a binary string; convert UTF-8 bytes
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Utf8Decoder().decode(bytes, false);
  } catch {
    return s;
  }
}

/** Streaming-safe UTF-8 decoder (Hermes may lack TextDecoder). */
export class Utf8Decoder {
  private native: TextDecoder | null;
  private carry: Uint8Array | null = null;

  constructor() {
    this.native = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  }

  decode(chunk: Uint8Array, stream = true): string {
    if (this.native) {
      try {
        return this.native.decode(chunk, { stream });
      } catch {
        this.native = null;
      }
    }
    let bytes = chunk;
    if (this.carry) {
      const merged = new Uint8Array(this.carry.length + chunk.length);
      merged.set(this.carry);
      merged.set(chunk, this.carry.length);
      bytes = merged;
      this.carry = null;
    }
    let end = bytes.length;
    if (stream) {
      // Don't split a multi-byte sequence across chunks
      let i = end - 1;
      let back = 0;
      while (i >= 0 && back < 4 && (bytes[i] & 0xc0) === 0x80) {
        i--;
        back++;
      }
      if (i >= 0) {
        const b = bytes[i];
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        if (need > back + 1) {
          this.carry = bytes.slice(i);
          end = i;
        }
      }
    }
    let out = '';
    const parts: string[] = [];
    let buf: number[] = [];
    for (let i = 0; i < end; ) {
      const b = bytes[i];
      let cp: number;
      if (b < 0x80) {
        cp = b;
        i += 1;
      } else if (b >= 0xf0) {
        cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        i += 4;
      } else if (b >= 0xe0) {
        cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
        i += 3;
      } else if (b >= 0xc0) {
        cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
        i += 2;
      } else {
        cp = 0xfffd;
        i += 1;
      }
      if (cp > 0xffff) {
        cp -= 0x10000;
        buf.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else buf.push(cp);
      if (buf.length > 8000) {
        parts.push(String.fromCharCode.apply(null, buf));
        buf = [];
      }
    }
    if (buf.length) parts.push(String.fromCharCode.apply(null, buf));
    out = parts.join('');
    return out;
  }
}
