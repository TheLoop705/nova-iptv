import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPanel } from '../server/mock-xtream.mjs';
import {
  cueTextAt,
  languageForLocale,
  mapResults,
  parseSubtitles,
  parseTitle,
  searchPath,
  trackMatchesLanguage,
} from '../src/services/subtitleCore.ts';

test('parses SRT with BOM, CRLF, tags and italics', () => {
  const srt = '﻿1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Hello</i>\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,250\r\n{\\an8}Two &amp; <b>lines</b>\r\nhere\r\n\r\n';
  const cues = parseSubtitles(srt);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1.5, end: 3, text: 'Hello', italic: true });
  assert.equal(cues[1].text, 'Two & lines\nhere');
  assert.equal(cues[1].end, 6.25);
});

test('parses WebVTT with hour-less times, settings and notes', () => {
  const vtt = 'WEBVTT\n\nNOTE written by hand\n\n00:01.000 --> 00:02.500 align:start line:90%\nFirst\n\nintro\n01:00:00.000 --> 01:00:01.000\nAn hour in\n';
  const cues = parseSubtitles(vtt);
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[1, 2.5, 'First'], [3600, 3601, 'An hour in']]);
});

test('finds the cue on screen, including overlapping ones', () => {
  const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:10,000\nLong\n\n2\n00:00:02,000 --> 00:00:03,000\nShort\n\n3\n00:00:20,000 --> 00:00:21,000\nLater\n');
  assert.equal(cueTextAt(cues, 0.5).text, '');
  assert.equal(cueTextAt(cues, 2.5).text, 'Long\nShort');
  assert.equal(cueTextAt(cues, 5).text, 'Long');
  assert.equal(cueTextAt(cues, 15).text, '');
  assert.equal(cueTextAt(cues, 20.2).text, 'Later');
  assert.equal(cueTextAt([], 3).text, '');
});

test('cleans IPTV titles for searching', () => {
  assert.deepEqual(parseTitle('EN - The Matrix (1999) [4K]'), { title: 'The Matrix', year: '1999' });
  assert.deepEqual(parseTitle('|NL| Dune 4K', '2021'), { title: 'Dune', year: '2021' });
  assert.deepEqual(parseTitle('[MULTI] Up 2009', '2009'), { title: 'Up', year: '2009' });
  assert.deepEqual(parseTitle('Blade Runner 2049'), { title: 'Blade Runner 2049' });
  assert.deepEqual(parseTitle('Blade Runner 2049 (2017)'), { title: 'Blade Runner 2049', year: '2017' });
  assert.deepEqual(parseTitle('X-Men: Apocalypse'), { title: 'X-Men: Apocalypse' });
  assert.deepEqual(parseTitle('WALL-E'), { title: 'WALL-E' });
  assert.deepEqual(parseTitle('DE - Das Boot FHD MULTI'), { title: 'Das Boot' });
});

test('builds sorted lower-case OpenSubtitles queries', () => {
  assert.equal(
    searchPath({ type: 'movie', title: 'The Matrix', year: '1999', languages: ['en', 'de'] }),
    '/subtitles?languages=de%2Cen&query=the+matrix&type=movie&year=1999'
  );
  assert.equal(searchPath({ type: 'movie', title: 'Tears of Steel', tmdbId: '0133701', languages: ['en'] }), '/subtitles?languages=en&tmdb_id=133701&type=movie');
  assert.equal(searchPath({ type: 'movie', title: 'Tears of Steel', tmdbId: '133701', languages: ['en'] }, true), '/subtitles?languages=en&query=tears+of+steel&type=movie');
  assert.equal(
    searchPath({ type: 'episode', title: 'Stream Lab', season: 1, episode: 2, tmdbId: '1399', languages: [] }),
    '/subtitles?episode_number=2&parent_tmdb_id=1399&season_number=1&type=episode'
  );
});

test('ranks results: preferred language, human-made, most downloaded', () => {
  const row = (file_id, language, download_count, extra = {}) => ({ attributes: { language, release: `r${file_id}`, download_count, files: [{ file_id }], ...extra } });
  const out = mapResults({ data: [row(1, 'en', 900), row(2, 'de', 10), row(3, 'de', 50, { machine_translated: true }), row(4, 'de', 20, { hearing_impaired: true }), { attributes: { files: [] } }] }, 'de');
  assert.deepEqual(out.map((r) => r.fileId), [2, 4, 3, 1]);
  assert.equal(mapResults(null, 'en').length, 0);
});

test('maps device locales and embedded track labels to languages', () => {
  assert.equal(languageForLocale('de-DE'), 'de');
  assert.equal(languageForLocale('pt-BR'), 'pt-br');
  assert.equal(languageForLocale('zh-Hant-TW'), 'zh-tw');
  assert.equal(languageForLocale('nb-NO'), 'no');
  assert.equal(languageForLocale('xx'), 'en');
  assert.ok(trackMatchesLanguage('English', 'en'));
  assert.ok(trackMatchesLanguage('eng', 'en'));
  assert.ok(trackMatchesLanguage('Deutsch [SDH]', 'de'));
  assert.ok(trackMatchesLanguage('de-DE', 'de'));
  assert.ok(!trackMatchesLanguage('French', 'en'));
  assert.ok(!trackMatchesLanguage('Subtitle 1', 'de'));
});

test('the Nova server forwards only the OpenSubtitles API and its files', async (t) => {
  const panel = createMockPanel({ channels: 1, movies: 1, series: 1 });
  await new Promise((r) => panel.server.listen(0, '127.0.0.1', r));
  const upstream = `http://127.0.0.1:${panel.server.address().port}`;
  process.env.OPENSUBTITLES_API_URL = upstream;
  const { server } = await import('../server/index.mjs');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const nova = `http://127.0.0.1:${server.address().port}/api/opensubtitles`;
  t.after(async () => {
    for (const s of [server, panel.server]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });

  const noKey = await fetch(`${nova}/subtitles?languages=en&query=x&type=movie`);
  assert.equal(noKey.status, 401);

  const headers = { 'api-key': 'test-key', 'x-os-ua': 'Nova IPTV v1.7.0' };
  const search = await (await fetch(`${nova}/subtitles?languages=de&tmdb_id=133701&type=movie`, { headers })).json();
  assert.deepEqual(search.data.map((r) => r.attributes.language), ['de']);

  const preflight = await fetch(`${nova}/download`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /api-key/);

  const download = await (await fetch(`${nova}/download`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ file_id: 9002 }) })).json();
  assert.equal(download.remaining, 4);
  const file = await (await fetch(`${nova}/file?url=${encodeURIComponent(download.link)}`)).text();
  const cues = parseSubtitles(file);
  assert.equal(cues.length, 450);
  assert.equal(cues[0].text, 'Deutsche Zeile 1\nsecond line');

  assert.equal((await fetch(`${nova}/file?url=${encodeURIComponent('https://example.com/a.srt')}`)).status, 403);
  assert.equal((await fetch(`${nova}/infos/user`, { headers })).status, 404);
  assert.equal((await fetch(`${nova}/download`, { headers })).status, 404, 'GET on a POST endpoint');
});
