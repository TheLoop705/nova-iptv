// Subtitle text handling shared by every platform: SRT/WebVTT parsing, cue lookup, cleaning IPTV
// titles for an online search, and the OpenSubtitles query/result shapes. No React Native imports,
// so the tests run it directly under Node.

export interface Cue {
  /** seconds */
  start: number;
  end: number;
  text: string;
  /** the whole cue was wrapped in <i>…</i> (songs, off-screen voices) */
  italic?: boolean;
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function seconds(m: RegExpMatchArray): number {
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'", lrm: '', rlm: '' };

function cleanText(raw: string): string {
  return raw
    .replace(/\{\\[^}]*\}/g, '') // ASS override tags some SRTs carry: {\an8}
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (all, name: string) =>
      name.startsWith('#') ? String.fromCharCode(Number(name.slice(1))) : (ENTITIES[name.toLowerCase()] ?? all)
    )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Parses SRT or WebVTT (BOM, CRLF, comma or dot milliseconds, hour-less VTT times, cue settings). */
export function parseSubtitles(input: string): Cue[] {
  const src = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues: Cue[] = [];
  for (const block of src.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->');
    const a = from.match(TIME);
    const b = to?.match(TIME);
    if (!a || !b) continue;
    const raw = lines.slice(at + 1).join('\n').trim();
    const text = cleanText(raw);
    if (!text) continue;
    const start = seconds(a);
    const end = Math.max(start + 0.2, seconds(b));
    const cue: Cue = { start, end, text };
    if (/^<i>/i.test(raw) && /<\/i>$/i.test(raw)) cue.italic = true;
    cues.push(cue);
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Text of every cue showing at `t` seconds (overlapping cues stack), or '' between cues. */
export function cueTextAt(cues: Cue[], t: number): { text: string; italic: boolean } {
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const showing: Cue[] = [];
  // cues are sorted by start; a long cue that started earlier can still be on screen
  for (let i = last; i >= 0 && i > last - 8; i--) if (cues[i].end > t) showing.unshift(cues[i]);
  return { text: showing.map((c) => c.text).join('\n'), italic: showing.length > 0 && showing.every((c) => c.italic) };
}

// ---- titles ------------------------------------------------------------------------------

const PREFIX = /^\s*(?:\[[^\]]{1,14}\]|\|[^|]{1,14}\||(?:[A-Z]{2,3}|4K|UHD|FHD|NF|AMZ|D\+)(?:[ -](?:[A-Z]{2,3}|4K))?\s*(?:[-:|•]|\|)\s+)\s*/;
const TAG_WORDS = /\s+(?:4K|UHD|FHD|HD|SD|HDR10\+?|HDR|DV|1080p|720p|2160p|480p|HEVC|H\.?26[45]|x26[45]|MULTI(?:-?SUBS?)?|MULTISUB|VOSTFR|VOST|SUBS?|DUB(?:BED)?|REMUX|WEB-?DL|BluRay|ATMOS|DD5\.1|EXTENDED)\s*$/i;

/**
 * IPTV panels decorate names: "EN - The Matrix (1999) [4K]", "|NL| Dune 4K", "[MULTI] Up 2009".
 * Returns the bare title and the year, for an online subtitle search.
 */
export function parseTitle(name: string, knownYear?: string): { title: string; year?: string } {
  let s = name.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(PREFIX, '');
    if (next === s || !next) break;
    s = next;
  }
  let year: string | undefined;
  const paren = s.match(/[([]((?:19|20)\d{2})[)\]]/);
  if (paren && paren.index !== undefined && paren.index > 0) {
    year = paren[1];
    s = s.slice(0, paren.index);
  }
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/\s*[[(][^\])]*[\])]\s*$/, '').replace(TAG_WORDS, '').replace(/\s*[-|:•]\s*$/, '');
    if (next === s) break;
    s = next;
  }
  // a bare trailing year is only stripped when the panel told us the year: "Blade Runner 2049" stays
  if (!year && knownYear && /^(19|20)\d{2}$/.test(knownYear)) {
    const re = new RegExp(`\\s*[-–]?\\s*${knownYear}$`);
    if (re.test(s) && s.replace(re, '').trim()) s = s.replace(re, '');
  }
  const title = s.trim() || name.trim();
  const y = year ?? (knownYear && /^(19|20)\d{2}$/.test(knownYear) ? knownYear : undefined);
  return y ? { title, year: y } : { title };
}

// ---- languages ---------------------------------------------------------------------------

/** OpenSubtitles language codes (ISO 639-1, plus its pt-PT/pt-BR and zh-CN/zh-TW variants). */
export const SUBTITLE_LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'ar', name: 'Arabic' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'zh-cn', name: 'Chinese (simplified)' },
  { code: 'zh-tw', name: 'Chinese (traditional)' },
  { code: 'hr', name: 'Croatian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'et', name: 'Estonian' },
  { code: 'fa', name: 'Persian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'ms', name: 'Malay' },
  { code: 'no', name: 'Norwegian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt-pt', name: 'Portuguese' },
  { code: 'pt-br', name: 'Portuguese (Brazil)' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'vi', name: 'Vietnamese' },
];

export const languageName = (code: string) => SUBTITLE_LANGUAGES.find((l) => l.code === code.toLowerCase())?.name ?? code.toUpperCase();

/** The subtitle language for a device locale such as "de-DE", "pt-BR" or "zh-Hant-TW". */
export function languageForLocale(locale: string | undefined): string {
  const l = (locale ?? '').toLowerCase().replace('_', '-');
  if (l.startsWith('pt')) return l.includes('br') ? 'pt-br' : 'pt-pt';
  if (l.startsWith('zh')) return /tw|hk|hant/.test(l) ? 'zh-tw' : 'zh-cn';
  if (l.startsWith('nb') || l.startsWith('nn')) return 'no';
  const base = l.split('-')[0];
  return SUBTITLE_LANGUAGES.some((x) => x.code === base) ? base : 'en';
}

/** Does an embedded track's label ("English", "eng", "en-US", "Deutsch [SDH]") match `code`? */
export function trackMatchesLanguage(label: string, code: string): boolean {
  const l = label.toLowerCase();
  const base = code.split('-')[0];
  const name = languageName(code).toLowerCase().split(' ')[0];
  const ISO3: Record<string, string[]> = {
    en: ['eng'], de: ['ger', 'deu', 'deutsch'], fr: ['fre', 'fra', 'français', 'francais'], es: ['spa', 'español', 'espanol'],
    it: ['ita', 'italiano'], nl: ['dut', 'nld', 'nederlands'], pt: ['por', 'português', 'portugues'], ru: ['rus'], pl: ['pol', 'polski'],
    tr: ['tur', 'türkçe'], ar: ['ara'], sv: ['swe', 'svenska'], da: ['dan', 'dansk'], no: ['nor', 'nob', 'norsk'], fi: ['fin', 'suomi'],
    cs: ['cze', 'ces'], el: ['gre', 'ell'], he: ['heb'], hu: ['hun', 'magyar'], ro: ['rum', 'ron'], ja: ['jpn'], ko: ['kor'], zh: ['chi', 'zho'],
  };
  const words = l.split(/[^a-zà-ÿ]+/).filter(Boolean);
  return words.includes(base) || l.startsWith(base + '-') || l.includes(name) || (ISO3[base] ?? []).some((w) => words.includes(w));
}

// ---- OpenSubtitles -----------------------------------------------------------------------

export interface SubtitleQuery {
  type: 'movie' | 'episode';
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  /** TMDB id of the movie, or of the show for an episode */
  tmdbId?: string;
  languages: string[];
}

/**
 * Query string for GET /subtitles. OpenSubtitles answers unsorted or upper-case parameters with a
 * redirect, so keys are sorted and values lower-cased. With a TMDB id the search is exact; without
 * one it searches by title (and year for movies).
 */
export function searchPath(q: SubtitleQuery, byTitle = false): string {
  const p: Record<string, string> = {};
  // no languages: every language
  if (q.languages.length) p.languages = [...new Set(q.languages.map((l) => l.toLowerCase()))].sort().join(',');
  const tmdb = !byTitle && q.tmdbId && /^\d+$/.test(q.tmdbId) ? String(Number(q.tmdbId)) : undefined;
  if (q.type === 'movie') {
    p.type = 'movie';
    if (tmdb) p.tmdb_id = tmdb;
    else {
      p.query = q.title.toLowerCase();
      if (q.year) p.year = q.year;
    }
  } else {
    p.type = 'episode';
    if (tmdb) p.parent_tmdb_id = tmdb;
    else p.query = q.title.toLowerCase();
    if (q.season !== undefined) p.season_number = String(q.season);
    if (q.episode !== undefined) p.episode_number = String(q.episode);
  }
  const qs = Object.keys(p)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(p[k]).replace(/%20/g, '+')}`)
    .join('&');
  return `/subtitles?${qs}`;
}

export interface SubtitleResult {
  fileId: number;
  language: string;
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  /** machine or AI translated */
  machine: boolean;
  fps?: number;
}

/** Flattens a /subtitles response; best first: preferred language, human-made, most downloaded. */
export function mapResults(data: unknown, preferred: string): SubtitleResult[] {
  const rows = (data as { data?: unknown[] })?.data;
  if (!Array.isArray(rows)) return [];
  const out: SubtitleResult[] = [];
  for (const row of rows) {
    const a = (row as { attributes?: Record<string, any> })?.attributes;
    const file = Array.isArray(a?.files) ? a!.files[0] : undefined;
    if (!a || !file?.file_id) continue;
    out.push({
      fileId: Number(file.file_id),
      language: String(a.language ?? '').toLowerCase(),
      release: String(a.release || file.file_name || a.feature_details?.title || 'Subtitle').trim(),
      downloads: Number(a.download_count) || 0,
      hearingImpaired: !!a.hearing_impaired,
      machine: !!(a.machine_translated || a.ai_translated),
      fps: Number(a.fps) || undefined,
    });
  }
  const pref = preferred.toLowerCase();
  const rank = (r: SubtitleResult) => (r.language === pref ? 0 : 1) * 4 + (r.machine ? 2 : 0) + (r.hearingImpaired ? 1 : 0);
  return out.sort((x, y) => rank(x) - rank(y) || y.downloads - x.downloads);
}
