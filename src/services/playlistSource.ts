import type { Playlist } from '../types';

export type PlaylistSource = Omit<Playlist, 'name' | 'createdAt'>;

/** Store only fields that determine the downloaded data, never a display name. */
export function playlistSource(p: Playlist): PlaylistSource {
  const shared = { id: p.id, type: p.type, epgUrl: p.epgUrl, userAgent: p.userAgent };
  if (p.type === 'xtream') return { ...shared, server: p.server, username: p.username, password: p.password };
  if (p.type === 'm3u') return p.inline
    ? { ...shared, inline: true, sourceRevision: p.sourceRevision }
    : { ...shared, url: p.url };
  return shared;
}

/** Display names are editable without downloading the provider library again. */
export function samePlaylistSource(a: PlaylistSource, b: PlaylistSource): boolean {
  if (a.id !== b.id || a.type !== b.type || a.epgUrl !== b.epgUrl || a.userAgent !== b.userAgent) return false;
  if (a.type === 'xtream') return a.server === b.server && a.username === b.username && a.password === b.password;
  if (a.type === 'm3u') return !!a.inline === !!b.inline && (a.inline
    ? a.sourceRevision === b.sourceRevision
    : a.url === b.url);
  return true;
}

export type PlaylistLoadPlan =
  | { action: 'none' }
  | { action: 'reset'; stopPlayback: boolean }
  | { action: 'load'; force: boolean; stopPlayback: boolean };

/** null means first hydration; preserve an initial nova:// stream in that case. */
export function playlistLoadPlan(previous: Playlist | undefined | null, next: Playlist | undefined): PlaylistLoadPlan {
  if (previous && next && samePlaylistSource(previous, next)) return { action: 'none' };
  if (previous === undefined && next === undefined) return { action: 'none' };
  if (!next) return { action: 'reset', stopPlayback: previous !== null };
  return { action: 'load', force: previous?.id === next.id, stopPlayback: previous !== null };
}
