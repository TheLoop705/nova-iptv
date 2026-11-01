import { useEffect } from 'react';
import { create } from 'zustand';
import type { MediaInfo, PlayItem } from '../types';
import { usePlayback } from './playback';
import { useSettings, type Prefs } from '../store/settings';
import { useUI } from '../store/ui';
import { getItem, removeItem, setItem } from '../services/storage';
import { languageName, parseSubtitles, parseTitle, trackMatchesLanguage, type Cue, type SubtitleQuery, type SubtitleResult } from '../services/subtitleCore';
import { canSearch, downloadSubtitle, effectiveKey, searchSubtitles, SubtitleApiError, type Credentials } from '../services/opensubtitles';

// Online subtitles (OpenSubtitles) for movies and episodes. Nova draws them itself
// (SubtitleOverlay), so they look and behave the same on ExoPlayer, VLC and the web player, and
// a downloaded file is kept per title: resuming a movie brings its subtitles back without using
// another download from the daily allowance.

type VodItem = Extract<PlayItem, { kind: 'vod' }>;

export interface ExternalSubtitle {
  fileId: number;
  lang: string;
  release: string;
  cues: Cue[];
}

interface SubtitleState {
  /** the VOD item these subtitles belong to */
  key: string | null;
  external: ExternalSubtitle | null;
  /** the downloaded subtitle is showing (any embedded track is then off) */
  on: boolean;
  /** seconds; positive shows the text later */
  delay: number;
  busy: 'search' | 'download' | null;
}

export const useSubtitles = create<SubtitleState>(() => ({ key: null, external: null, on: false, delay: 0, busy: null }));

export const DELAYS = [-5, -3, -2, -1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5, 2, 3, 5];
export const formatDelay = (d: number) => (d === 0 ? 'In sync' : `${d > 0 ? '+' : '−'}${Math.abs(d)} s`);

// ---- saved files ------------------------------------------------------------------------

interface Saved {
  fileId: number;
  lang: string;
  release: string;
  text: string;
  delay: number;
  on: boolean;
}

const INDEX = 'subs-index';
const MAX_SAVED = 30;
const storeKey = (key: string) => `subs:${key}`;

async function save(key: string, saved: Saved) {
  try {
    await setItem(storeKey(key), saved);
    const index = (await getItem<string[]>(INDEX)) ?? [];
    const next = [key, ...index.filter((k) => k !== key)];
    for (const old of next.slice(MAX_SAVED)) await removeItem(storeKey(old));
    await setItem(INDEX, next.slice(0, MAX_SAVED));
  } catch {
    // subtitles still show for this session
  }
}

let metaTimer: ReturnType<typeof setTimeout> | null = null;
/** Remember on/off and the timing for the saved file (debounced: the timing is stepped). */
function saveMeta() {
  const { key, external, on, delay } = useSubtitles.getState();
  if (!key || !external) return;
  if (metaTimer) clearTimeout(metaTimer);
  metaTimer = setTimeout(async () => {
    metaTimer = null;
    const saved = await getItem<Saved>(storeKey(key)).catch(() => null);
    if (saved && saved.fileId === external.fileId) await setItem(storeKey(key), { ...saved, on, delay }).catch(() => {});
  }, 800);
}

// ---- session ----------------------------------------------------------------------------

let generation = 0;
let controller: AbortController | null = null;
let restoring: Promise<void> = Promise.resolve();
let settled = -1;
let current: VodItem | null = null;

const credentials = (p: Prefs): Credentials => ({ apiKey: effectiveKey(p.osApiKey), username: p.osUsername, password: p.osPassword });

function startSession(item: PlayItem | null) {
  const vod = item?.kind === 'vod' ? item : null;
  const key = vod?.key ?? null;
  current = vod;
  if (key === useSubtitles.getState().key) return;
  generation++;
  controller?.abort();
  controller = key ? new AbortController() : null;
  useSubtitles.setState({ key, external: null, on: false, delay: 0, busy: null });
  if (key) restoring = restore(key, generation);
}

async function restore(key: string, gen: number) {
  const saved = await getItem<Saved>(storeKey(key)).catch(() => null);
  if (gen !== generation || !saved?.text) return;
  const cues = parseSubtitles(saved.text);
  if (!cues.length) return;
  useSubtitles.setState({ external: { fileId: saved.fileId, lang: saved.lang, release: saved.release, cues }, on: saved.on !== false, delay: saved.delay || 0 });
}

/** First time the item plays: settle which subtitle shows. */
async function onFirstPlay(gen: number) {
  await restoring;
  if (gen !== generation || !current) return;
  const item = current;
  const pb = usePlayback.getState();
  const sub = useSubtitles.getState();
  if (sub.external) {
    // engines may switch on a default embedded track by themselves
    if (sub.on && pb.subtitleIndex >= 0) pb.cmd.setSubtitle(-1);
    return;
  }
  const prefs = useSettings.getState().prefs;
  if (!prefs.subtitleAuto) return;
  const lang = prefs.subtitleLanguage || 'en';
  const embedded = pb.subtitleTracks.findIndex((t) => trackMatchesLanguage(t.label, lang));
  if (embedded >= 0) {
    if (pb.subtitleIndex !== embedded) pb.cmd.setSubtitle(embedded);
    return;
  }
  if (!item.media || !canSearch(prefs.osApiKey)) return;
  try {
    const results = await searchSubtitles(queryFor(item.media, [lang]), credentials(prefs), controller?.signal);
    if (gen !== generation) return;
    const best = results.find((r) => r.language === lang && !r.machine) ?? results.find((r) => r.language === lang);
    if (best) await loadSubtitle(item, best, true);
  } catch {
    // automatic: stay quiet, the Subtitles menu shows errors
  }
}

/** Mounted once (VideoLayer): follows the playing item. */
export function useSubtitleSession(item: PlayItem | null) {
  useEffect(() => startSession(item), [item]);
  useEffect(
    () =>
      usePlayback.subscribe((st, prev) => {
        if (st.status === 'playing' && prev.status !== 'playing' && settled !== generation && current) {
          settled = generation;
          void onFirstPlay(generation);
        }
      }),
    []
  );
}

// ---- search & download ------------------------------------------------------------------

function queryFor(media: MediaInfo, languages: string[]): SubtitleQuery {
  const { title, year } = parseTitle(media.title, media.year);
  return { type: media.type, title, year, season: media.season, episode: media.episode, tmdbId: media.tmdbId, languages };
}

const describe = (r: SubtitleResult) =>
  [`${r.downloads.toLocaleString()} downloads`, r.hearingImpaired ? 'Hearing impaired' : '', r.machine ? 'Machine translated' : ''].filter(Boolean).join(' · ');

const errorText = (e: unknown) => (e instanceof SubtitleApiError ? e.message : "Couldn't reach OpenSubtitles");

function needKeySheet() {
  useUI.getState().openSheet({
    title: 'OpenSubtitles API key needed',
    subtitle: 'Create a free API key at opensubtitles.com (Profile → API consumers), then enter it in Settings → Subtitles.',
    options: [{ label: 'OK', icon: 'check', onSelect: () => {} }],
  });
}

/** Search OpenSubtitles for the playing movie/episode and offer the results in a sheet. */
export async function searchOnline(item: VodItem, allLanguages = false) {
  const prefs = useSettings.getState().prefs;
  const ui = useUI.getState();
  if (!item.media) return ui.showToast('Nothing to search for');
  if (!canSearch(prefs.osApiKey)) return needKeySheet();
  if (useSubtitles.getState().busy) return;
  const gen = generation;
  const lang = prefs.subtitleLanguage || 'en';
  const languages = allLanguages ? [] : lang === 'en' ? ['en'] : [lang, 'en'];
  useSubtitles.setState({ busy: 'search' });
  ui.showToast('Searching OpenSubtitles…');
  try {
    const q = queryFor(item.media, languages);
    const results = await searchSubtitles(q, credentials(prefs), controller?.signal);
    if (gen !== generation) return;
    const name = q.type === 'episode' && q.season !== undefined && q.episode !== undefined ? `${q.title} S${q.season} E${q.episode}` : q.year ? `${q.title} (${q.year})` : q.title;
    if (!results.length && allLanguages) return ui.showToast(`No subtitles found for ${name}`);
    const picked = useSubtitles.getState().external?.fileId;
    ui.openSheet({
      title: 'Online subtitles',
      subtitle: results.length ? `${name} · from OpenSubtitles` : `Nothing in ${languages.map(languageName).join(' or ')} for ${name}.`,
      options: [
        ...results.slice(0, 40).map((r) => ({
          label: `${languageName(r.language)} · ${r.release}`,
          detail: describe(r),
          selected: r.fileId === picked,
          onSelect: () => void loadSubtitle(item, r),
        })),
        ...(allLanguages ? [] : [{ label: 'All languages…', icon: 'translate', onSelect: () => void searchOnline(item, true) }]),
      ],
    });
  } catch (e: any) {
    if (e?.name !== 'AbortError' && gen === generation) ui.showToast(errorText(e));
  } finally {
    if (gen === generation) useSubtitles.setState({ busy: null });
  }
}

export async function loadSubtitle(item: VodItem, r: SubtitleResult, quiet = false): Promise<boolean> {
  const prefs = useSettings.getState().prefs;
  const ui = useUI.getState();
  const gen = generation;
  useSubtitles.setState({ busy: 'download' });
  if (!quiet) ui.showToast('Downloading subtitles…');
  try {
    const { text, remaining } = await downloadSubtitle(r.fileId, credentials(prefs), controller?.signal);
    if (gen !== generation) return false;
    const cues = parseSubtitles(text);
    if (!cues.length) {
      if (!quiet) ui.showToast("That subtitle file couldn't be read, try another");
      return false;
    }
    useSubtitles.setState({ external: { fileId: r.fileId, lang: r.language, release: r.release, cues }, on: true, delay: 0 });
    const pb = usePlayback.getState();
    if (pb.subtitleIndex >= 0) pb.cmd.setSubtitle(-1);
    void save(item.key, { fileId: r.fileId, lang: r.language, release: r.release, text, delay: 0, on: true });
    const left = remaining !== undefined && remaining <= 10 ? ` · ${remaining} download${remaining === 1 ? '' : 's'} left today` : '';
    ui.showToast(`Subtitles: ${languageName(r.language)}${left}`);
    return true;
  } catch (e: any) {
    if (e?.name !== 'AbortError' && gen === generation && !quiet) ui.showToast(errorText(e));
    return false;
  } finally {
    if (gen === generation) useSubtitles.setState({ busy: null });
  }
}

// ---- switching --------------------------------------------------------------------------

/** Show the downloaded subtitle (turning any embedded track off), or hide it. */
export function setExternalOn(on: boolean) {
  if (!useSubtitles.getState().external) return;
  useSubtitles.setState({ on });
  const pb = usePlayback.getState();
  if (on && pb.subtitleIndex >= 0) pb.cmd.setSubtitle(-1);
  saveMeta();
}

/** Pick an embedded track (-1 = off); the downloaded one goes off with it. */
export function selectEmbedded(index: number) {
  if (useSubtitles.getState().on) {
    useSubtitles.setState({ on: false });
    saveMeta();
  }
  usePlayback.getState().cmd.setSubtitle(index);
}

export function setDelay(delay: number) {
  useSubtitles.setState({ delay });
  saveMeta();
}

export function externalLabel(sub: ExternalSubtitle) {
  return `${languageName(sub.lang)} · downloaded`;
}
