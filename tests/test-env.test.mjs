import test from 'node:test';
import assert from 'node:assert/strict';
import { providerConfig, safeFailure } from '../scripts/test-env.mjs';

test('provider configuration rejects missing secrets and public/embedded credentials', () => {
  assert.throws(() => providerConfig({}), /NOVA_TEST/);
  assert.throws(() => providerConfig({ NOVA_TEST_SERVER: 'https://secret:pass@example.org', NOVA_TEST_USERNAME: 'user', NOVA_TEST_PASSWORD: 'pass' }), /embedded/);
  assert.throws(() => providerConfig({ NOVA_TEST_SERVER: 'file:///etc/passwd', NOVA_TEST_USERNAME: 'user', NOVA_TEST_PASSWORD: 'pass' }), /HTTP/);
  assert.throws(() => providerConfig({ NOVA_TEST_SERVER: 'private-password-is-not-a-url', NOVA_TEST_USERNAME: 'user', NOVA_TEST_PASSWORD: 'pass' }), (error) => !error.message.includes('private-password'));
});
test('provider configuration and safe failures apply bounded transfer/deadline budgets', () => {
  const env = { NOVA_TEST_SERVER: 'https://panel.example/', NOVA_TEST_USERNAME: 'private-user', NOVA_TEST_PASSWORD: 'private-pass' };
  assert.equal(providerConfig(env).server, 'https://panel.example');
  assert.equal(providerConfig(env).timeoutMs, 120000);
  assert.throws(() => providerConfig({ ...env, NOVA_TEST_TIMEOUT_MS: 'Infinity' }), /timeout/);
  assert.throws(() => providerConfig({ ...env, NOVA_TEST_MAX_GUIDE_MB: '1024' }), /Guide/);
  assert.doesNotMatch(safeFailure('Login').message, /private-user|private-pass|https:/);
});
