import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { providerConfig, safeFailure } from '../../scripts/test-env.mjs';

const defaultPrefs = {
  clock24: true, streamFormat: 'auto', userAgent: '', startWithLastChannel: false,
  epgRefreshHours: 12, epgPastDays: 2, epgFutureDays: 3, showChannelNumbers: true,
  previewInGuide: false, iosPlayer: 'auto', autoplayNext: true,
};
async function seed(page, port = 8890, provider) {
  const playlist = { id: 'performance', name: 'Performance test', type: 'xtream', server: provider?.server || 'http://127.0.0.1:' + port, username: provider?.username || 'demo', password: provider?.password || 'demo', epgUrl: provider?.epgUrl, userAgent: provider?.userAgent, createdAt: Date.now() };
  const document = { playlists: [playlist], activeId: playlist.id, prefs: defaultPrefs };
  // Isolated in-memory settings. Real credentials never reach a persistent test DB or report.
  await page.route('**/api/kv/settings', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ value: document }) }));
  await page.goto('/');
  await expect(page.getByTestId('screen-home')).toBeVisible({ timeout: 20000 });
}
async function stats(page, port = 8890) {
  return page.request.get('http://127.0.0.1:' + port + '/__test/stats').then((r) => r.json());
}
const count = (snapshot, key) => snapshot.requests[key] || 0;
async function navigate(page, screen, compact = false) {
  const started = Date.now();
  await page.getByTestId((compact ? 'tab-' : 'nav-') + screen).click({ timeout: 2000 });
  await expect(page.getByTestId('screen-' + screen)).toBeVisible({ timeout: 2000 });
  expect(Date.now() - started, 'Visible screen change must stay interactive').toBeLessThan(2000);
}
async function instrument(page) {
  await page.evaluate(() => {
    window.__novaPerf?.reset();
    window.__performanceLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__performanceLongTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
}
async function report(page, testInfo) {
  const result = await page.evaluate(() => ({
    monitor: window.__novaPerf?.snapshot(),
    longTasks: { count: window.__performanceLongTasks?.length || 0, maxMs: Math.max(0, ...(window.__performanceLongTasks || [])) },
    domElements: document.querySelectorAll('*').length,
    navigationRounds: window.__navigationRounds || null,
    memory: performance.memory ? { usedJsHeapBytes: performance.memory.usedJSHeapSize, totalJsHeapBytes: performance.memory.totalJSHeapSize } : null,
  }));
  const path = testInfo.outputPath('sanitized-performance.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result, null, 2));
  await testInfo.attach('sanitized-performance.json', { path, contentType: 'application/json' });
  expect(result.monitor?.enabled, 'Build with npm run build:perf:web to enable numerical budgets').toBe(true);
  expect(result.monitor.eventLoopLagMs.count).toBeGreaterThan(5);
  expect(result.monitor.eventLoopLagMs.p95, '95% of JS event-loop samples must be under 100 ms late').toBeLessThan(100);
  expect(result.monitor.eventLoopLagMs.max, 'No one-second JS freeze').toBeLessThan(1000);
  expect(result.longTasks.maxMs, 'No one-second browser main-thread task').toBeLessThan(1000);
  if (result.monitor.keyToFrameMs.count) expect(result.monitor.keyToFrameMs.p95, 'Remote key to next frame').toBeLessThan(250);
  expect(result.domElements, 'Large libraries must remain virtualized').toBeLessThan(6000);
}

test('TV guide completes once while remote navigation and Settings stay available', async ({ page }, testInfo) => {
  const before = await stats(page);
  await seed(page);
  await instrument(page);
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await navigate(page, 'guide');
  await expect.poll(async () => (await stats(page)).activeXmltv).toBe(1);
  // Actual JS remote routing: walk out to the rail and choose Settings while gzip streams.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('screen-settings')).toBeVisible({ timeout: 2000 });
  const during = await stats(page);
  expect(during.activeXmltv).toBe(1);
  expect(count(during, 'get_vod_streams:all') - count(before, 'get_vod_streams:all')).toBe(0);
  expect(count(during, 'get_series:all') - count(before, 'get_series:all')).toBe(0);
  for (const screen of ['home', 'guide', 'settings', 'guide']) await navigate(page, screen);
  await expect.poll(async () => (await stats(page)).completedXmltv - before.completedXmltv, { timeout: 35000 }).toBe(1);
  await navigate(page, 'settings');
  await expect(page.getByTestId('settings-epg')).not.toContainText('Updating', { timeout: 20000 });
  const after = await stats(page);
  expect(count(after, 'xmltv') - count(before, 'xmltv')).toBe(1);
  await report(page, testInfo);
});

test('25k movies and 10k series stay virtualized; search/downloads are shared and counts cached', async ({ page }, testInfo) => {
  const before = await stats(page);
  await seed(page);
  await instrument(page);
  await navigate(page, 'settings');
  expect(count(await stats(page), 'get_vod_streams:all') - count(before, 'get_vod_streams:all')).toBe(0);
  await navigate(page, 'movies');
  await expect(page.getByLabel('Tears of Steel', { exact: true })).toBeVisible();
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp']) await page.keyboard.press(key);
  await page.getByLabel('Tears of Steel', { exact: true }).click();
  await expect(page.getByText('Tears of Steel — mock movie.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await navigate(page, 'series');
  await expect(page.getByLabel('Stream Lab', { exact: true })).toBeVisible();
  await page.getByLabel('Stream Lab', { exact: true }).click();
  await expect(page.getByText('Pilot', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await navigate(page, 'search');
  const input = page.getByTestId('search-input');
  await input.fill('Performance Movie 025000');
  await expect(page.getByText('Performance Movie 025000', { exact: true }).first()).toBeVisible({ timeout: 20000 });
  // Rapid edits cancel obsolete searches without launching repeated full-provider fetches.
  await input.fill('Performance Series');
  await input.fill('Performance Series 010000');
  await expect(page.getByText('Performance Series 010000', { exact: true }).first()).toBeVisible();
  await input.fill('');
  await page.keyboard.press('Escape');
  await navigate(page, 'settings');
  await expect(page.getByTestId('settings-lib-movies')).toContainText(/25[,.\s]?000 movies/);
  await expect(page.getByTestId('settings-lib-series')).toContainText(/10[,.\s]?000 series/);
  for (const screen of ['movies', 'series', 'search', 'settings']) await navigate(page, screen);
  const settled = await stats(page);
  const initialHeap = await page.evaluate(() => performance.memory?.usedJSHeapSize || null);
  let maximumDomElements = 0;
  for (let round = 0; round < 12; round++) {
    for (const screen of ['home', 'guide', 'settings', 'movies', 'series', 'search']) {
      await navigate(page, screen);
      maximumDomElements = Math.max(maximumDomElements, await page.evaluate(() => document.querySelectorAll('*').length));
    }
  }
  await page.evaluate((value) => { window.__navigationRounds = value; }, { rounds: 12, transitions: 72, maximumDomElements, initialHeapBytes: initialHeap });
  expect(maximumDomElements, 'Rendered list windows stay bounded across repeated navigation').toBeLessThan(6000);
  const after = await stats(page);
  expect(after.requests, 'Warm screen navigation must stop growing provider request counts').toEqual(settled.requests);
  expect(count(after, 'xmltv') - count(before, 'xmltv')).toBe(1);
  expect(count(after, 'get_vod_streams:all') - count(before, 'get_vod_streams:all')).toBe(1);
  expect(count(after, 'get_series:all') - count(before, 'get_series:all')).toBe(1);
  // Home's visible rails also load categories. This fixture has two of each;
  // revisiting screens must share each category rather than download it again.
  for (const action of ['get_vod_streams:category', 'get_series:category']) {
    const requests = count(after, action) - count(before, action);
    expect(requests).toBeGreaterThanOrEqual(1);
    expect(requests).toBeLessThanOrEqual(2);
  }
  await report(page, testInfo);
});

test('Settings Count action stays navigable while catalogs load and caches exact totals', async ({ page }) => {
  const before = await stats(page);
  await seed(page);
  await navigate(page, 'settings');
  expect(count(await stats(page), 'get_vod_streams:all') - count(before, 'get_vod_streams:all')).toBe(0);
  expect(count(await stats(page), 'get_series:all') - count(before, 'get_series:all')).toBe(0);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  await page.route('**/api/proxy?*', async (route) => {
    const target = new URL(new URL(route.request().url()).searchParams.get('url'));
    if (target.searchParams.get('action') !== 'get_vod_streams' || target.searchParams.has('category_id')) return route.continue();
    const response = await route.fetch();
    held = true;
    await gate;
    await route.fulfill({ response }).catch(() => {}); // The page can close on a failed assertion.
  });
  try {
    await page.getByTestId('settings-lib-count').click();
    await expect.poll(() => held, { timeout: 10000 }).toBe(true);
    await expect(page.getByTestId('settings-lib-count')).toContainText('Counting');
    // Leave and reopen Settings while a complete catalog response remains pending.
    await navigate(page, 'home');
    await navigate(page, 'settings');
    await expect(page.getByTestId('settings-lib-count')).toContainText('Counting');
    await page.getByTestId('settings-lib-count').click();
    expect(count(await stats(page), 'get_vod_streams:all') - count(before, 'get_vod_streams:all')).toBe(1);
    release();
    await expect(page.getByTestId('settings-lib-movies')).toContainText(/25[,.\s]?000 movies/, { timeout: 20000 });
    await expect(page.getByTestId('settings-lib-series')).toContainText(/10[,.\s]?000 series/, { timeout: 20000 });
    await expect(page.getByTestId('settings-lib-count')).toHaveCount(0);
    await navigate(page, 'home');
    await navigate(page, 'settings');
    await expect(page.getByTestId('settings-lib-movies')).toContainText(/25[,.\s]?000 movies/);
    await expect(page.getByTestId('settings-lib-series')).toContainText(/10[,.\s]?000 series/);
    const after = await stats(page);
    expect(count(after, 'get_vod_streams:all') - count(before, 'get_vod_streams:all')).toBe(1);
    expect(count(after, 'get_series:all') - count(before, 'get_series:all')).toBe(1);
  } finally { release(); }
});

test('empty XMLTV does not trigger a per-channel retry storm', async ({ page }, testInfo) => {
  const before = await stats(page, 8891);
  await seed(page, 8891);
  await instrument(page);
  await navigate(page, 'guide');
  await expect.poll(async () => (await stats(page, 8891)).completedXmltv - before.completedXmltv).toBe(1);
  await page.waitForTimeout(1500);
  const first = await stats(page, 8891);
  for (const screen of ['settings', 'guide', 'settings', 'guide']) await navigate(page, screen);
  await page.waitForTimeout(2000);
  const after = await stats(page, 8891);
  expect(count(after, 'xmltv') - count(before, 'xmltv')).toBe(1);
  expect(count(after, 'get_simple_data_table:all') - count(first, 'get_simple_data_table:all'), 'Negative fallback results must be cached').toBe(0);
  expect(count(after, 'get_simple_data_table:all') - count(before, 'get_simple_data_table:all')).toBeLessThan(30);
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown');
  await report(page, testInfo);
});

test('failed guide stops downloading and an explicit refresh is bounded', async ({ page }, testInfo) => {
  const before = await stats(page, 8892);
  await seed(page, 8892);
  await instrument(page);
  await navigate(page, 'guide');
  await expect.poll(async () => count(await stats(page, 8892), 'xmltv') - count(before, 'xmltv')).toBe(1);
  await navigate(page, 'settings');
  await expect(page.getByTestId('settings-epg')).not.toContainText('Updating');
  await page.getByTestId('settings-epg').click();
  await expect.poll(async () => count(await stats(page, 8892), 'xmltv') - count(before, 'xmltv')).toBe(2);
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('settings-epg')).not.toContainText('Updating');
  expect(count(await stats(page, 8892), 'xmltv') - count(before, 'xmltv')).toBe(2);
  await report(page, testInfo);
});

test('compact web layout remains interactive with the same large catalogs', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await instrument(page);
  for (const screen of ['guide', 'settings', 'movies', 'series', 'search', 'home']) await navigate(page, screen, true);
  await page.waitForTimeout(1500);
  await report(page, testInfo);
});

test('optional real provider: bounded loading, usable navigation and no repeated guide download', async ({ page }, testInfo) => {
  test.skip(process.env.NOVA_TEST_PROVIDER !== '1', 'Opt in after adding private .env credentials.');
  const provider = providerConfig();
  test.setTimeout(Math.min(360000, provider.timeoutMs * 2 + 30000));
  let guideRequests = 0;
  page.on('request', (request) => {
    let url;
    try {
      const outer = new URL(request.url());
      url = outer.searchParams.get('url') || request.url();
      if (provider.epgUrl ? url === provider.epgUrl : new URL(url).pathname.endsWith('/xmltv.php')) guideRequests++;
    } catch { /* Ignore non-provider resources. */ }
  });
  try {
    await seed(page, undefined, provider);
    await instrument(page);
    for (const screen of ['guide', 'settings', 'movies', 'series', 'guide']) await navigate(page, screen);
    await navigate(page, 'settings');
    await expect(page.getByTestId('settings-epg')).not.toContainText('Updating', { timeout: provider.timeoutMs + 10000 });
    await expect(page.getByTestId('settings-lib-live')).toContainText(/[1-9][\d,.]* channels? with TV guide/, { timeout: 10000 });
    expect(guideRequests).toBe(1);
    await report(page, testInfo);
  } catch {
    throw safeFailure('Real-provider UI check');
  } finally {
    // Prevent Playwright's failure DOM snapshot from retaining arbitrary provider guide tokens.
    await page.close();
  }
});
