import test from 'node:test';
import assert from 'node:assert/strict';
import { playlistLoadPlan, samePlaylistSource } from '../src/services/playlistSource.ts';

const provider = { id: 'a', name: 'Provider', type: 'xtream', server: 'https://example.test', username: 'user', password: 'pass', createdAt: 1 };

test('renaming a playlist avoids loading its catalog or stopping playback', () => {
  const renamed = { ...provider, name: 'Living room', createdAt: 2 };
  assert.equal(samePlaylistSource(provider, renamed), true);
  assert.deepEqual(playlistLoadPlan(provider, renamed), { action: 'none' });
});

test('each same-ID provider source change forces one refresh and stops old playback', () => {
  for (const change of [
    { server: 'https://second.test' }, { username: 'second' }, { password: 'new' },
    { epgUrl: 'https://example.test/guide.xml' }, { userAgent: 'custom' },
    { type: 'm3u', url: 'https://example.test/channels.m3u' },
  ]) {
    const updated = { ...provider, ...change };
    assert.equal(samePlaylistSource(provider, updated), false);
    assert.deepEqual(playlistLoadPlan(provider, updated), { action: 'load', force: true, stopPlayback: true });
    assert.deepEqual(playlistLoadPlan(updated, updated), { action: 'none' });
  }
});

test('replacing an imported file under its original ID and name invalidates its source', () => {
  const imported = { id: 'file', name: 'Channels', type: 'm3u', inline: true, sourceRevision: 'first', createdAt: 1 };
  assert.deepEqual(playlistLoadPlan(imported, { ...imported, sourceRevision: 'second' }), { action: 'load', force: true, stopPlayback: true });
  assert.equal(samePlaylistSource(imported, { ...imported, name: 'Renamed' }), true);
  // Existing imports without a revision remain valid until their file is replaced.
  assert.deepEqual(playlistLoadPlan({ ...imported, sourceRevision: undefined }, imported), { action: 'load', force: true, stopPlayback: true });
});

test('URL changes and file-to-URL changes invalidate an M3U source', () => {
  const linked = { id: 'm3u', name: 'Channels', type: 'm3u', url: 'https://first.test/list.m3u', createdAt: 1 };
  assert.equal(samePlaylistSource(linked, { ...linked, url: 'https://second.test/list.m3u' }), false);
  assert.equal(samePlaylistSource(linked, { ...linked, inline: true }), false);
  assert.equal(samePlaylistSource(linked, { ...linked, username: 'unused', sourceRevision: 'unused' }), true);
});

test('switches/removal stop playback, while first hydration preserves a deep-linked stream', () => {
  assert.deepEqual(playlistLoadPlan(null, provider), { action: 'load', force: false, stopPlayback: false });
  assert.deepEqual(playlistLoadPlan(null, undefined), { action: 'reset', stopPlayback: false });
  assert.deepEqual(playlistLoadPlan(provider, { ...provider, id: 'b' }), { action: 'load', force: false, stopPlayback: true });
  assert.deepEqual(playlistLoadPlan(provider, undefined), { action: 'reset', stopPlayback: true });
  assert.deepEqual(playlistLoadPlan(undefined, provider), { action: 'load', force: false, stopPlayback: true });
});
