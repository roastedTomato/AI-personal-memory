import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';

function authHarness() {
  const values = new Map();
  const calls = [];
  let now = 1000;
  let responder = async () => ({ ok: true, status: 200, json: async () => ({ AuthenticationResult: {
    AccessToken: 'synthetic-access', RefreshToken: 'synthetic-refresh', ExpiresIn: 60,
  } }) });
  const store = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device',
    async getItemAsync(key) { return values.get(key) ?? null; },
    async setItemAsync(key, value) { values.set(key, value); },
    async deleteItemAsync(key) { values.delete(key); },
  };
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(new URL('../api/auth.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, require: (name) => { assert.equal(name, 'expo-secure-store'); return store; },
    process: { env: { EXPO_PUBLIC_APP_ENV: 'cloud', EXPO_PUBLIC_COGNITO_REGION: 'ap-southeast-2', EXPO_PUBLIC_COGNITO_CLIENT_ID: 'synthetic-client' } },
    Date: { now: () => now }, AbortController, setTimeout, clearTimeout,
    fetch: async (...args) => { calls.push(args); return responder(...args); },
  });
  return { api: module.exports, values, calls, expire: () => { now += 120000; }, respond: (fn) => { responder = fn; } };
}

test('valid access token is reused across API and image calls without refreshing', async () => {
  const h = authHarness();
  h.api.setAccessTokenProvider(() => h.api.refreshAccessToken());
  await h.api.signIn('synthetic@example.invalid', 'synthetic-only');
  assert.equal((await h.api.authorizationHeaders()).Authorization, 'Bearer synthetic-access');
  assert.equal((await h.api.authorizationHeaders()).Authorization, 'Bearer synthetic-access');
  assert.equal(h.api.imageAuthorizationHeaders().Authorization, 'Bearer synthetic-access');
  assert.equal(h.calls.length, 1);
  assert.equal([...h.values.values()][0], 'synthetic-refresh');
});

test('concurrent expired-token requests share one refresh', async () => {
  const h = authHarness();
  await h.api.signIn('synthetic@example.invalid', 'synthetic-only');
  h.expire();
  await Promise.all([h.api.authorizationHeaders(), h.api.authorizationHeaders(), h.api.authorizationHeaders()]);
  assert.equal(h.calls.length, 2);
  assert.equal(JSON.parse(h.calls[1][1].body).AuthFlow, 'REFRESH_TOKEN_AUTH');
});

test('temporary refresh network failure preserves the secure refresh token', async () => {
  const h = authHarness();
  await h.api.signIn('synthetic@example.invalid', 'synthetic-only');
  h.expire();
  h.respond(async () => { throw new Error('synthetic offline'); });
  await assert.rejects(h.api.authorizationHeaders(), /synthetic offline/);
  assert.equal([...h.values.values()][0], 'synthetic-refresh');
});

test('rejected refresh clears the session instead of sending an expired bearer', async () => {
  const h = authHarness();
  await h.api.signIn('synthetic@example.invalid', 'synthetic-only');
  h.expire();
  h.respond(async () => ({ ok: false, status: 400, json: async () => ({ __type: 'NotAuthorizedException' }) }));
  await assert.rejects(h.api.authorizationHeaders(), /Sign in is required/);
  assert.equal(h.values.size, 0);
  assert.equal(h.api.imageAuthorizationHeaders().Authorization, undefined);
});

test('a refresh finishing after sign-out cannot restore the old session', async () => {
  const h = authHarness();
  await h.api.signIn('synthetic@example.invalid', 'synthetic-only');
  h.expire();
  let finish;
  h.respond(async (_url, options) => {
    if (options.headers['X-Amz-Target'].endsWith('.RevokeToken')) return { ok: true };
    return new Promise((resolve) => { finish = resolve; });
  });
  const refresh = h.api.refreshAccessToken();
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  assert.ok(finish);
  await h.api.signOut();
  finish({ ok: true, json: async () => ({ AuthenticationResult: { AccessToken: 'stale-token', ExpiresIn: 3600 } }) });
  assert.equal(await refresh, null);
  assert.equal(h.values.size, 0);
  assert.equal(h.api.imageAuthorizationHeaders().Authorization, undefined);
});
