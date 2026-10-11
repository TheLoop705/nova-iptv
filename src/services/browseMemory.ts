// Session-only UI state: never persist credentials, catalog entries or playback.
const positions = new Map<string, unknown>();
const LIMIT = 256;
const key = (playlistId: string | undefined, section: string) => JSON.stringify([playlistId ?? '', section]);

export function readBrowsePosition<T>(playlistId: string | undefined, section: string): T | undefined {
  const id = key(playlistId, section);
  const value = positions.get(id) as T | undefined;
  if (value !== undefined) { positions.delete(id); positions.set(id, value); }
  return value;
}

export function saveBrowsePosition<T>(playlistId: string | undefined, section: string, value: T): void {
  const id = key(playlistId, section);
  positions.delete(id);
  positions.set(id, value);
  if (positions.size > LIMIT) positions.delete(positions.keys().next().value!);
}

export function clearBrowsePositions(playlistId: string): void {
  for (const id of positions.keys()) if (JSON.parse(id)[0] === playlistId) positions.delete(id);
}
