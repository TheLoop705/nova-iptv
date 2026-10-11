import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Loads secrets in the Node harness only. Existing environment variables take precedence. */
export function loadTestEnv(path = resolve('.env')) {
  if (existsSync(path)) process.loadEnvFile(path);
  if (Object.keys(process.env).some((name) => /^EXPO_PUBLIC_.*(?:PASSWORD|USERNAME|CREDENTIAL|SECRET)/i.test(name))) {
    throw new Error('Provider secrets must use NOVA_TEST_* names, never EXPO_PUBLIC_* names.');
  }
}

export function providerConfig(env = process.env) {
  if (!env.NOVA_TEST_SERVER || !env.NOVA_TEST_USERNAME || !env.NOVA_TEST_PASSWORD) {
    throw new Error('Set NOVA_TEST_SERVER, NOVA_TEST_USERNAME and NOVA_TEST_PASSWORD in the ignored .env file.');
  }
  let server;
  try { server = new URL(env.NOVA_TEST_SERVER); }
  catch { throw new Error('NOVA_TEST_SERVER must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password) {
    throw new Error('NOVA_TEST_SERVER must be an HTTP(S) origin without embedded credentials.');
  }
  const timeoutMs = Number(env.NOVA_TEST_TIMEOUT_MS || 120000);
  const maxGuideBytes = Number(env.NOVA_TEST_MAX_GUIDE_MB || 128) * 1024 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('Test timeout must be 1000–600000 ms.');
  if (!Number.isFinite(maxGuideBytes) || maxGuideBytes <= 0 || maxGuideBytes > 512 * 1024 * 1024) throw new Error('Guide limit must be 1–512 MiB.');
  return {
    server: server.href.replace(/\/+$/, '').replace(/\/(?:player_api|get|xmltv)\.php.*$/, '').replace(/\/c\/?$/, ''),
    username: env.NOVA_TEST_USERNAME,
    password: env.NOVA_TEST_PASSWORD,
    epgUrl: env.NOVA_TEST_EPG_URL || undefined,
    userAgent: env.NOVA_TEST_USER_AGENT || undefined,
    timeoutMs,
    maxGuideBytes,
  };
}

/** Errors may contain URLs. Never print raw provider errors or request objects. */
export function safeFailure(label) {
  return new Error(`${label} failed. Check credentials, connectivity and the configured request deadline.`);
}
