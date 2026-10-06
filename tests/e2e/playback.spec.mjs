import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

async function report(testInfo, name, value) {
  const path = testInfo.outputPath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

async function seed(page) {
  const playlist = { id: 'playback', name: 'Local playback test', type: 'xtream', server: 'http://127.0.0.1:8893', username: 'demo', password: 'demo', createdAt: 1 };
  const document = { playlists: [playlist], activeId: playlist.id, prefs: {
    clock24: true, streamFormat: 'm3u8', userAgent: '', startWithLastChannel: false,
    epgRefreshHours: 12, epgPastDays: 2, epgFutureDays: 3, showChannelNumbers: true,
    previewInGuide: true, iosPlayer: 'auto', autoplayNext: false,
  } };
  await page.route('**/api/kv/settings', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ value: document }) }));
  await page.goto('/');
  await expect(page.getByTestId('screen-home')).toBeVisible({ timeout: 20000 });
}

async function decoded(page) {
  await expect(page.locator('video')).toHaveCount(1);
  await expect.poll(() => page.locator('video').evaluate((v) => ({
    ready: v.readyState >= 3, moving: !v.paused && v.currentTime > 0.5,
    decoded: v.getVideoPlaybackQuality().totalVideoFrames > 1,
  })), { timeout: 15000 }).toEqual({ ready: true, moving: true, decoded: true });
  return page.locator('video').evaluate((v) => ({
    duration: v.duration, position: v.currentTime, width: v.videoWidth, height: v.videoHeight,
    decodedFrames: v.getVideoPlaybackQuality().totalVideoFrames,
  }));
}

test('local MP4 movie and series decode, pause, seek, mute and leave the player', async ({ page }, testInfo) => {
  await seed(page);
  await page.getByTestId('nav-movies').click();
  await page.getByLabel('Tears of Steel', { exact: true }).click();
  await page.getByTestId('detail-play').click();
  const movie = await decoded(page);
  expect(movie.duration).toBeGreaterThan(39);
  expect(movie.duration).toBeLessThan(41);
  expect([movie.width, movie.height]).toEqual([160, 90]);

  // These are app commands routed through the same JS remote handler as a TV remote.
  await page.keyboard.press('k');
  await expect.poll(() => page.locator('video').evaluate((v) => v.paused)).toBe(true);
  const pausedAt = await page.locator('video').evaluate((v) => v.currentTime);
  await page.waitForTimeout(350);
  expect(await page.locator('video').evaluate((v) => v.currentTime)).toBeCloseTo(pausedAt, 1);
  await page.keyboard.press('l');
  await expect.poll(() => page.locator('video').evaluate((v) => v.currentTime)).toBeGreaterThan(pausedAt + 9);
  await page.keyboard.press('j');
  await expect.poll(() => page.locator('video').evaluate((v) => v.currentTime)).toBeLessThan(pausedAt + 1);
  const muted = await page.locator('video').evaluate((v) => v.muted);
  await page.keyboard.press('m');
  await expect.poll(() => page.locator('video').evaluate((v) => v.muted)).toBe(!muted);
  await page.keyboard.press('k');
  await expect.poll(() => page.locator('video').evaluate((v) => v.paused)).toBe(false);
  await expect(page.getByTestId('player-control-playpause')).toContainText('Pause');
  await page.keyboard.press('k');
  await expect.poll(() => page.locator('video').evaluate((v) => v.paused)).toBe(true);
  await expect(page.getByTestId('player-control-playpause')).toContainText('Play');
  await page.keyboard.press('Escape');
  await expect(page.locator('video')).toHaveCount(0);
  await page.keyboard.press('Escape'); // Return from the movie detail page.

  await page.getByTestId('nav-series').click();
  await page.getByLabel('Stream Lab', { exact: true }).click();
  await page.getByText('Pilot', { exact: true }).click();
  const series = await decoded(page);
  await page.keyboard.press('k');
  await page.getByTestId('player-back').click();
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByTestId('screen-series')).toBeVisible();
  await report(testInfo, 'decoded-playback.json', { movie, series });
});

test('local HLS live playback keeps the same decoded surface between guide preview and fullscreen', async ({ page }, testInfo) => {
  let manifestRequests = 0;
  page.on('request', (request) => {
    let url;
    try { const outer = new URL(request.url()); url = new URL(outer.searchParams.get('url') || request.url()); } catch { return; }
    if (url.pathname.endsWith('playback.m3u8') || /\/live\/.+\.m3u8$/.test(url.pathname)) manifestRequests++;
  });
  await seed(page);
  await page.getByTestId('nav-guide').click();
  await expect(page.getByTestId('screen-guide')).toBeVisible();
  await page.keyboard.press('Enter');
  const preview = await decoded(page);
  await expect(page.getByLabel('Open fullscreen', { exact: true })).toBeVisible();
  const startedRequests = manifestRequests;
  await page.locator('video').evaluate((v) => { window.__fixtureSurface = v; });
  await page.getByLabel('Open fullscreen', { exact: true }).click();
  await expect(page.getByTestId('player-back')).toBeVisible();
  expect(await page.locator('video').evaluate((v) => v === window.__fixtureSurface)).toBe(true);
  await page.waitForTimeout(700);
  await page.getByTestId('player-back').click();
  await expect(page.getByLabel('Open fullscreen', { exact: true })).toBeVisible();
  expect(await page.locator('video').evaluate((v) => v === window.__fixtureSurface)).toBe(true);
  const returned = await decoded(page);
  expect(returned.position).toBeGreaterThan(preview.position);
  expect(returned.decodedFrames).toBeGreaterThan(preview.decodedFrames);
  expect(manifestRequests, 'Moving the guide preview must not restart the HLS stream').toBe(startedRequests);
  await page.getByTestId('nav-settings').click();
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByTestId('screen-settings')).toBeVisible();
  await report(testInfo, 'decoded-live-playback.json', { preview, returned, manifestRequests });
});
