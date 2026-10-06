import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import { loadTestEnv, providerConfig, safeFailure } from './test-env.mjs';

loadTestEnv();
const config = providerConfig();
const apiUrl = (action) => {
  const url = new URL(config.server + '/player_api.php');
  url.search = new URLSearchParams({ username: config.username, password: config.password, ...(action ? { action } : {}) }).toString();
  return url;
};
const report = [];
async function check(label, url, validate, maxBytes = 64 * 1024 * 1024) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: controller.signal, headers: config.userAgent ? { 'user-agent': config.userAgent } : {} });
    if (!response.ok) throw new Error('HTTP failure');
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) { controller.abort(); throw new Error('Response exceeds test limit'); }
      if (validate) chunks.push(chunk);
    }
    const result = validate ? validate(Buffer.concat(chunks)) : {};
    report.push({ check: label, elapsedMs: Math.round(performance.now() - started), bytes, ...result });
  } catch {
    throw safeFailure(label);
  } finally { clearTimeout(deadline); controller.abort(); }
}
const list = (body, idField) => {
  const value = JSON.parse(body.toString());
  if (!Array.isArray(value) && (!value || typeof value !== 'object')) throw new Error('Invalid listing');
  const entries = Array.isArray(value) ? value : Object.values(value);
  // Xtream panels can send an error object with HTTP 200. A successful transfer
  // does not establish that the collection contains usable catalog records.
  for (const entry of entries) {
    const id = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry[idField] : undefined;
    if (!['string', 'number'].includes(typeof id) || !String(id).trim()) throw new Error('Invalid listing entry');
  }
  return { items: entries.length };
};
try {
  await check('Login', apiUrl(), (body) => {
    const value = JSON.parse(body.toString());
    if (String(value?.user_info?.auth) !== '1' || (value.user_info.status && value.user_info.status !== 'Active')) throw new Error('Inactive account');
    return { authenticated: true };
  });
  // Sequential requests avoid overwhelming panels with low connection limits.
  for (const [label, action, idField] of [
    ['Live categories', 'get_live_categories', 'category_id'], ['Live channels', 'get_live_streams', 'stream_id'],
    ['Movie categories', 'get_vod_categories', 'category_id'], ['Series categories', 'get_series_categories', 'category_id'],
    ['Movies', 'get_vod_streams', 'stream_id'], ['Series', 'get_series', 'series_id'],
  ]) await check(label, apiUrl(action), (body) => list(body, idField));
  const guide = config.epgUrl || config.server + '/xmltv.php?' + new URLSearchParams({ username: config.username, password: config.password });
  await check('Guide transfer', guide, (body) => {
    const xml = (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body, { maxOutputLength: config.maxGuideBytes }) : body).toString();
    if (!/<tv\b[^>]*>/i.test(xml) || !/<\/tv>\s*$/i.test(xml)) throw new Error('Invalid or truncated XMLTV');
    const programmes = (xml.match(/<programme\b/g) || []).length;
    if (!programmes) throw new Error('Guide has no programmes');
    return { programmes };
  }, config.maxGuideBytes);
  // Summary contains only counts, bytes and durations; URLs/credentials never enter artifacts.
  console.log(JSON.stringify({ ok: true, checks: report }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
