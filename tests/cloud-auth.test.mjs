import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCloudAuth, parseAuthCallback, REDIRECT_URL } = require('../electron/cloud-auth.cjs');

const user = (extra = {}) => ({
  id: 'u1',
  email: 'anton@example.com',
  is_anonymous: false,
  user_metadata: { full_name: 'Anton R' },
  app_metadata: { provider: 'google' },
  ...extra,
});
const sessionOf = (u) => ({ access_token: 'a', refresh_token: 'r', user: u });

// A Supabase client that records calls. Responses can be replaced per test.
function fakeClient(overrides = {}) {
  const calls = [];
  let current = overrides.session ?? null;
  const record =
    (name, answer) =>
    async (...args) => {
      calls.push([name, ...args]);
      return typeof answer === 'function' ? answer(...args) : answer;
    };
  const client = {
    calls,
    auth: {
      getSession: async () => ({ data: { session: current } }),
      signInWithOtp: record('signInWithOtp', overrides.signInWithOtp ?? { data: {}, error: null }),
      verifyOtp: record(
        'verifyOtp',
        overrides.verifyOtp ??
          (() => {
            current = sessionOf(user({ app_metadata: { provider: 'email' } }));
            return { data: { session: current }, error: null };
          }),
      ),
      signInWithPassword: record(
        'signInWithPassword',
        overrides.signInWithPassword ??
          (({ password }) => {
            if (password !== 'review-pass')
              return {
                data: {},
                error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
              };
            current = sessionOf(user({ app_metadata: { provider: 'email' } }));
            return { data: { session: current }, error: null };
          }),
      ),
      signInWithOAuth: record(
        'signInWithOAuth',
        overrides.signInWithOAuth ?? {
          data: { url: 'https://auth.example/authorize' },
          error: null,
        },
      ),
      exchangeCodeForSession: record(
        'exchangeCodeForSession',
        overrides.exchange ??
          (() => {
            current = sessionOf(user());
            return { data: { session: current }, error: null };
          }),
      ),
      signOut: record('signOut', () => {
        current = null;
        return { error: null };
      }),
      setSession: record('setSession', overrides.setSession ?? { data: {}, error: null }),
      stopAutoRefresh: () => {},
    },
    // Like supabase-js, rpc() returns a builder that can be awaited but has no .catch().
    rpc: (...args) => {
      const answer = record('rpc', overrides.rpc ?? { data: null, error: null })(...args);
      return { then: (resolve, reject) => answer.then(resolve, reject) };
    },
    storage: overrides.storage,
    from: overrides.from,
    setSession: (s) => (current = s),
  };
  return client;
}

test('email sign-in sends a code, then the code signs in', async () => {
  const client = fakeClient();
  const auth = createCloudAuth({ client, openUrl: () => {} });
  await assert.rejects(auth.sendEmailCode('not an email'), /valid email/);
  assert.deepEqual(await auth.sendEmailCode('  Anton@Example.com '), {
    email: 'anton@example.com',
  });
  assert.deepEqual(client.calls[0], [
    'signInWithOtp',
    { email: 'anton@example.com', options: { shouldCreateUser: true } },
  ]);
  await assert.rejects(auth.verifyEmailCode('anton@example.com', '12ab'), /code from the email/);
  const signedIn = await auth.verifyEmailCode('anton@example.com', '123 456');
  assert.equal(signedIn.state, 'signedIn');
  assert.equal(signedIn.provider, 'email');
  assert.deepEqual(client.calls[1], [
    'verifyOtp',
    { email: 'anton@example.com', token: '123456', type: 'email' },
  ]);
});

test('email sign-in errors tell the person what to do', async () => {
  const limited = createCloudAuth({
    client: fakeClient({
      signInWithOtp: { error: { status: 429, code: 'over_email_send_rate_limit', message: 'x' } },
    }),
  });
  await assert.rejects(limited.sendEmailCode('a@b.eu'), /Wait a minute/);
  const expired = createCloudAuth({
    client: fakeClient({
      verifyOtp: {
        data: {},
        error: { status: 403, code: 'otp_expired', message: 'Token has expired or is invalid' },
      },
    }),
  });
  await assert.rejects(expired.verifyEmailCode('a@b.eu', '123456'), /Send a new one/);
  const offline = createCloudAuth({
    client: fakeClient({
      signInWithOtp: () => {
        throw new TypeError('fetch failed');
      },
    }),
  });
  await assert.rejects(offline.sendEmailCode('a@b.eu'), /internet connection/);
});

test('Google opens the system browser and finishes with the callback link', async () => {
  const client = fakeClient();
  const opened = [];
  const auth = createCloudAuth({ client, openUrl: async (url) => opened.push(url) });
  const signingIn = auth.signInWithProvider('google');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(opened, ['https://auth.example/authorize']);
  assert.deepEqual(client.calls[0], [
    'signInWithOAuth',
    {
      provider: 'google',
      options: {
        redirectTo: REDIRECT_URL,
        skipBrowserRedirect: true,
        queryParams: { prompt: 'select_account' },
      },
    },
  ]);
  assert.equal(auth.waiting(), 'google');
  assert.equal(await auth.finishOAuth('terraboard://auth/callback?code=abcdef123456'), true);
  const signedIn = await signingIn;
  assert.equal(signedIn.email, 'anton@example.com');
  assert.equal(signedIn.name, 'Anton R');
  assert.deepEqual(client.calls.at(-1), ['exchangeCodeForSession', 'abcdef123456']);
  assert.equal(auth.waiting(), null);
});

test('Microsoft asks for the email scope', async () => {
  const client = fakeClient();
  const auth = createCloudAuth({ client, openUrl: () => {} });
  const signingIn = auth.signInWithProvider('microsoft');
  await new Promise((r) => setImmediate(r));
  assert.equal(client.calls[0][1].provider, 'azure');
  assert.equal(client.calls[0][1].options.scopes, 'email');
  auth.cancel();
  await assert.rejects(signingIn, /cancelled/);
});

test('a callback after Cancel is ignored', async () => {
  const client = fakeClient();
  const auth = createCloudAuth({ client, openUrl: () => {} });
  const signingIn = auth.signInWithProvider('google');
  await new Promise((r) => setImmediate(r));
  auth.cancel();
  await assert.rejects(signingIn, /cancelled/);
  assert.equal(await auth.finishOAuth('terraboard://auth/callback?code=abcdef123456'), false);
  assert.ok(!client.calls.some((c) => c[0] === 'exchangeCodeForSession'));
});

test('a refused Google sign-in comes back as an error link', async () => {
  const auth = createCloudAuth({ client: fakeClient(), openUrl: () => {} });
  const signingIn = auth.signInWithProvider('google');
  await new Promise((r) => setImmediate(r));
  await auth.finishOAuth('terraboard://auth/callback?error=access_denied&error_description=no');
  await assert.rejects(signingIn, /cancelled/);
  const failing = createCloudAuth({
    client: fakeClient({ exchange: { data: {}, error: { message: 'invalid flow state' } } }),
    openUrl: () => {},
  });
  const second = failing.signInWithProvider('google');
  await new Promise((r) => setImmediate(r));
  await failing.finishOAuth('terraboard://auth/callback?code=abcdef123456');
  await assert.rejects(second, /did not work/);
});

test('parseAuthCallback accepts only the callback link', () => {
  assert.deepEqual(parseAuthCallback('terraboard://auth/callback?code=abc-DEF_123.x'), {
    code: 'abc-DEF_123.x',
  });
  assert.deepEqual(parseAuthCallback('terraboard://auth/callback?error_code=bad_oauth_state'), {
    error: 'bad_oauth_state',
  });
  assert.equal(parseAuthCallback('https://auth/callback?code=abcdef'), null);
  assert.equal(parseAuthCallback('terraboard://auth/callback?code=<script>'), null);
  assert.equal(parseAuthCallback('terraboard://auth/callback?code=' + 'a'.repeat(5000)), null);
});

test('methods follow both the server description and the server settings', async () => {
  const auth = createCloudAuth({
    client: fakeClient(),
    fetch: async (url, options) => {
      assert.equal(url, 'https://x.supabase.co/auth/v1/settings');
      assert.equal(options.headers.apikey, 'key');
      return Response.json({ external: { email: true, google: true, azure: false } });
    },
  });
  assert.deepEqual(
    await auth.methods({
      url: 'https://x.supabase.co',
      key: 'key',
      allowed: { email: true, google: true, microsoft: true },
    }),
    { email: true, google: true, microsoft: false },
  );
  const down = createCloudAuth({
    client: fakeClient(),
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.deepEqual(
    await down.methods({ url: 'u', key: 'k', allowed: { email: true, google: false } }),
    { email: true, google: false, microsoft: false },
  );
});

test('signing out stays on this computer and removes it from the account', async () => {
  const client = fakeClient({ session: sessionOf(user()) });
  const auth = createCloudAuth({ client, openUrl: () => {} });
  await auth.signOut({ device: 'd1' });
  assert.deepEqual(client.calls, [
    ['rpc', 'revoke_device', { p_id: 'd1' }],
    ['signOut', { scope: 'local' }],
  ]);
});

test('the claim restores the anonymous session aside and finishes as the account', async () => {
  const client = fakeClient({
    session: sessionOf(user()),
    rpc: { data: { result: 'moved', workspace: 'w1' }, error: null },
  });
  const anonymous = fakeClient({
    setSession: { data: { session: sessionOf(user({ is_anonymous: true })) }, error: null },
    rpc: { data: 'secret', error: null },
  });
  const auth = createCloudAuth({ client, openUrl: () => {} });
  const outcome = await auth.claim(
    { access_token: 'a0', refresh_token: 'r0' },
    () => anonymous,
    'w0',
  );
  assert.deepEqual(outcome, { result: 'moved', workspace: 'w1' });
  assert.deepEqual(anonymous.calls, [
    ['setSession', { access_token: 'a0', refresh_token: 'r0' }],
    ['rpc', 'begin_claim', { p_workspace: 'w0' }],
  ]);
  assert.deepEqual(client.calls, [['rpc', 'finish_claim', { p_secret: 'secret' }]]);

  const gone = fakeClient({
    setSession: { data: {}, error: { message: 'Invalid Refresh Token: Not Found', status: 400 } },
  });
  assert.deepEqual(await auth.claim({ access_token: 'a', refresh_token: 'r' }, () => gone), {
    result: 'lost',
  });
});

test('deleting cloud data removes files page by page, then the data', async () => {
  const files = { assets: ['f1', 'f2', 'f3'], profiles: ['avatar'] };
  const removed = [];
  const storage = {
    from: (bucket) => ({
      list: async (prefix, { limit }) => {
        assert.equal(prefix, 'w1');
        return { data: files[bucket].slice(0, 2).map((name) => ({ id: name, name })), error: null };
      },
      remove: async (paths) => {
        removed.push(...paths);
        files[bucket] = files[bucket].filter((n) => !paths.includes(`w1/${n}`));
        return { data: paths.map((name) => ({ name })), error: null };
      },
    }),
  };
  const client = fakeClient({
    session: sessionOf(user()),
    storage,
    rpc: (name) =>
      name === 'my_deletable_workspaces'
        ? { data: ['w1'], error: null }
        : { data: { userDeleted: true }, error: null },
  });
  const auth = createCloudAuth({ client, openUrl: () => {} });
  assert.deepEqual(await auth.deleteCloudData(), { userDeleted: true });
  assert.deepEqual(removed, ['w1/f1', 'w1/f2', 'w1/f3', 'w1/avatar']);
  assert.deepEqual(
    client.calls.map((c) => c[1]),
    ['my_deletable_workspaces', 'delete_my_cloud_data', { scope: 'local' }],
  );

  // A server that lists files but removes none must not loop forever.
  const stuck = fakeClient({
    session: sessionOf(user()),
    storage: {
      from: () => ({
        list: async () => ({ data: [{ id: 'x', name: 'x' }], error: null }),
        remove: async () => ({ data: [], error: null }),
      }),
    },
    rpc: { data: ['w1'], error: null },
  });
  await assert.rejects(createCloudAuth({ client: stuck }).deleteCloudData(), /delete your files/);
  assert.ok(!stuck.calls.some((c) => c[1] === 'delete_my_cloud_data'));
});

test('Cancel during the code exchange does not leave a half sign-in', async () => {
  let finishExchange;
  const client = fakeClient({
    exchange: () =>
      new Promise((resolve) => {
        finishExchange = () => resolve({ data: { session: sessionOf(user()) }, error: null });
      }),
  });
  const auth = createCloudAuth({ client, openUrl: () => {} });
  const signingIn = auth.signInWithProvider('google');
  await new Promise((r) => setImmediate(r));
  const finishing = auth.finishOAuth('terraboard://auth/callback?code=abcdef123456');
  await new Promise((r) => setImmediate(r));
  auth.cancel();
  finishExchange();
  await finishing;
  assert.equal((await signingIn).state, 'signedIn', 'the sign-in finished despite Cancel');
});

test('combining checks with the server before removing any file', async () => {
  const removed = [];
  const client = fakeClient({
    session: sessionOf(user()),
    storage: {
      from: () => ({
        list: async () => ({ data: [{ id: 'f', name: 'f' }], error: null }),
        remove: async (paths) => {
          removed.push(...paths);
          return { data: paths, error: null };
        },
      }),
    },
    rpc: (name) =>
      name === 'check_retire'
        ? { data: null, error: { message: 'You cannot combine these libraries', code: '42501' } }
        : { data: null, error: null },
  });
  await assert.rejects(createCloudAuth({ client }).retireWorkspace('old', 'new'), /combine/);
  assert.deepEqual(removed, []);
});

test('a password signs in accounts that have one (the store review account)', async () => {
  const client = fakeClient();
  const auth = createCloudAuth({ client, openUrl: async () => {} });
  await assert.rejects(auth.signInWithPassword('anton@example.com', 'nope'), {
    message: 'Wrong email or password.',
  });
  await assert.rejects(auth.signInWithPassword('not an email', 'x'), {
    message: 'Enter a valid email address.',
  });
  const account = await auth.signInWithPassword(' Anton@Example.com ', 'review-pass');
  assert.equal(account.state, 'signedIn');
  assert.deepEqual(client.calls.at(-1), [
    'signInWithPassword',
    { email: 'anton@example.com', password: 'review-pass' },
  ]);
});
