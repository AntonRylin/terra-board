// Signing in to a Terra Board server: email codes, Google and Microsoft, devices, the claim
// for computers set up anonymously by 0.1.28, and deleting cloud data.
//
// It uses no Node or Electron API, so the desktop app (electron/cloud-sync.cjs) and the
// Android app share it. Each passes its own Supabase client, created with
// auth.flowType = 'pkce', and a way to open a web page:
//
//   const auth = createCloudAuth({ client, openUrl: (url) => shell.openExternal(url) });
//   await auth.sendEmailCode('me@example.com');
//   await auth.verifyEmailCode('me@example.com', '123456');
//   await auth.signInWithProvider('google'); // resolves when finishOAuth() gets the callback
//   auth.finishOAuth('terraboard://auth/callback?code=…');
//
// Every error thrown here has a message meant for the person, never a raw server message.

const REDIRECT_URL = 'terraboard://auth/callback';
const PROVIDERS = { google: 'google', microsoft: 'azure' };
const OAUTH_TIMEOUT = 10 * 60 * 1000;
const MAX_LINK_LENGTH = 4096;

const NO_CONNECTION = 'Could not reach the server. Check your internet connection.';
const BAD_EMAIL = 'Enter a valid email address.';
const BAD_CODE = 'Enter the code from the email.';
const CODE_EXPIRED = 'This code is wrong or has expired. Send a new one.';
const TOO_MANY = 'Too many tries. Wait a minute, then try again.';
const NO_SIGNUPS = 'This server does not accept new accounts.';
const PROVIDER_OFF = 'This sign-in method is not available on this server.';
const BROWSER_FAILED = 'Signing in in the browser did not work. Try again.';
const CANCELLED = 'Signing in was cancelled.';
const TIMED_OUT = 'Signing in took too long. Try again.';
const NOT_SIGNED_IN = 'Sign in first.';
const SIGN_IN_FAILED = 'Could not sign in. Try again.';

class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const offline = (e) =>
  /fetch failed|network|Failed to fetch|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|AuthRetryableFetchError/i.test(
    `${e?.name || ''} ${e?.message || e || ''}`,
  );

// Turns a Supabase auth error into something a person can act on.
function friendly(error, fallback = SIGN_IN_FAILED) {
  if (!error) return new AuthError(fallback, 'unknown');
  if (error instanceof AuthError) return error;
  const code = String(error.code || error.error_code || '');
  const text = String(error.message || error);
  const status = Number(error.status || error.statusCode || 0);
  if (offline(error) || (status === 0 && /fetch/i.test(text)))
    return new AuthError(NO_CONNECTION, 'offline');
  if (status === 429 || /rate.?limit|too many|security purposes/i.test(code + ' ' + text))
    return new AuthError(TOO_MANY, 'rate_limited');
  if (/otp_expired|expired|invalid.*(otp|token)|token.*invalid/i.test(code + ' ' + text))
    return new AuthError(CODE_EXPIRED, 'code_expired');
  if (/signup.*disabled|signups not allowed|user_not_found/i.test(code + ' ' + text))
    return new AuthError(NO_SIGNUPS, 'signups_disabled');
  if (/email_address_invalid|invalid.*email|validation_failed/i.test(code + ' ' + text))
    return new AuthError(BAD_EMAIL, 'bad_email');
  if (/provider.*(not enabled|disabled)|unsupported provider/i.test(code + ' ' + text))
    return new AuthError(PROVIDER_OFF, 'provider_disabled');
  return new AuthError(fallback, code || 'unknown');
}

const cleanEmail = (email) => {
  const text = typeof email === 'string' ? email.trim() : '';
  if (text.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
    throw new AuthError(BAD_EMAIL, 'bad_email');
  return text.toLowerCase();
};
const cleanCode = (code) => {
  const digits = String(code ?? '').replace(/\s/g, '');
  // Supabase sends 6 digits by default; projects can choose up to 10.
  if (!/^\d{6,10}$/.test(digits)) throw new AuthError(BAD_CODE, 'bad_code');
  return digits;
};

// The terraboard://auth/callback link the browser opens after Google or Microsoft.
// Returns { code } or { error }, or null for anything that isn't such a link.
function parseAuthCallback(url) {
  if (typeof url !== 'string' || url.length > MAX_LINK_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'terraboard:' || parsed.username || parsed.password || parsed.port)
    return null;
  if (parsed.hostname !== 'auth' || parsed.pathname !== '/callback') return null;
  // Supabase puts errors in the query or, for some, in the fragment.
  const params = new URLSearchParams(parsed.search);
  for (const [key, value] of new URLSearchParams(parsed.hash.replace(/^#/, '')))
    if (!params.has(key)) params.set(key, value);
  const codes = params.getAll('code');
  if (codes.length === 1 && /^[\w.~-]{6,512}$/.test(codes[0])) return { code: codes[0] };
  if (params.has('error') || params.has('error_code')) {
    const kind = String(params.get('error_code') || params.get('error') || '').slice(0, 80);
    return { error: kind || 'error' };
  }
  return null;
}

const userInfo = (session) => {
  const user = session?.user;
  if (!user) return { state: 'signedOut' };
  const meta = user.user_metadata || {};
  const anonymous = user.is_anonymous === true;
  return {
    state: anonymous ? 'anonymous' : 'signedIn',
    userId: user.id,
    email: anonymous ? null : user.email || null,
    // Pre-filled from Google or Microsoft; the person can change it in their profile.
    name: anonymous ? null : meta.full_name || meta.name || null,
    provider: anonymous ? null : user.app_metadata?.provider || 'email',
  };
};

const rpc = async (client, name, args, fallback) => {
  let result;
  try {
    result = await client.rpc(name, args);
  } catch (e) {
    throw offline(e) ? new AuthError(NO_CONNECTION, 'offline') : new AuthError(fallback);
  }
  if (result.error)
    throw offline(result.error)
      ? new AuthError(NO_CONNECTION, 'offline')
      : new AuthError(fallback, result.error.code || 'server');
  return result.data;
};

// onBeforeSignIn runs right before a sign-in replaces the client's session (the desktop app
// keeps a 0.1.28 anonymous session aside there, for the claim).
function createCloudAuth({
  client,
  openUrl,
  redirectTo = REDIRECT_URL,
  fetch = globalThis.fetch,
  onBeforeSignIn = async () => {},
}) {
  if (!client) throw new Error('createCloudAuth needs a Supabase client');
  // The sign-in waiting for its terraboard://auth/callback link.
  let pending = null;

  const settle = (outcome) => {
    const flow = pending;
    if (!flow) return;
    pending = null;
    clearTimeout(flow.timer);
    if (outcome instanceof Error) flow.reject(outcome);
    else flow.resolve(outcome);
  };

  const session = async () => {
    try {
      const { data } = await client.auth.getSession();
      return data.session || null;
    } catch {
      return null;
    }
  };

  const auth = {
    REDIRECT_URL: redirectTo,

    // Who is signed in: { state: 'signedOut' | 'anonymous' | 'signedIn', userId, email, name,
    // provider }. 'anonymous' is a computer set up by Terra Board 0.1.28.
    async account() {
      return userInfo(await session());
    },

    session,

    // The sign-in methods this server offers: { email, google, microsoft }. allowed is what
    // the server description (terra-board.json) enables; the server's own settings decide
    // the rest. If they can't be read, the description alone counts.
    async methods({ url, key, allowed = { email: true, google: true, microsoft: true } }) {
      const wanted = {
        email: !!allowed.email,
        google: !!allowed.google,
        microsoft: !!allowed.microsoft,
      };
      try {
        const response = await fetch(`${url}/auth/v1/settings`, {
          headers: { apikey: key },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return wanted;
        const settings = await response.json();
        const on = settings?.external || {};
        return {
          email: wanted.email && on.email !== false,
          google: wanted.google && on.google === true,
          microsoft: wanted.microsoft && on.azure === true,
        };
      } catch {
        return wanted;
      }
    },

    // Step 1 of the email sign-in: Supabase sends a code (the Magic Link email template
    // shows {{ .Token }}). New addresses get an account.
    async sendEmailCode(email) {
      const address = cleanEmail(email);
      let result;
      try {
        result = await client.auth.signInWithOtp({
          email: address,
          options: { shouldCreateUser: true },
        });
      } catch (e) {
        throw friendly(e);
      }
      if (result.error) throw friendly(result.error, 'Could not send the code. Try again.');
      return { email: address };
    },

    // Step 2: the code from the email signs in and replaces any session this client had.
    async verifyEmailCode(email, code) {
      const address = cleanEmail(email);
      const token = cleanCode(code);
      await onBeforeSignIn();
      let result;
      try {
        result = await client.auth.verifyOtp({ email: address, token, type: 'email' });
      } catch (e) {
        throw friendly(e);
      }
      if (result.error || !result.data?.session) throw friendly(result.error, CODE_EXPIRED);
      return userInfo(result.data.session);
    },

    // Google ('google') or Microsoft ('microsoft'): opens the provider's page in the system
    // browser and resolves once finishOAuth() receives the callback. A new call or cancel()
    // ends the previous one.
    async signInWithProvider(provider) {
      const name = PROVIDERS[provider];
      if (!name) throw new AuthError(PROVIDER_OFF, 'provider_disabled');
      settle(new AuthError(CANCELLED, 'cancelled'));
      let result;
      try {
        result = await client.auth.signInWithOAuth({
          provider: name,
          options: {
            redirectTo,
            skipBrowserRedirect: true,
            // Microsoft needs the email scope; Supabase only accepts accounts with an email.
            ...(name === 'azure' ? { scopes: 'email' } : {}),
            ...(name === 'google' ? { queryParams: { prompt: 'select_account' } } : {}),
          },
        });
      } catch (e) {
        throw friendly(e);
      }
      if (result.error || !result.data?.url) throw friendly(result.error, BROWSER_FAILED);
      const done = new Promise((resolve, reject) => {
        pending = {
          provider,
          resolve,
          reject,
          timer: setTimeout(() => settle(new AuthError(TIMED_OUT, 'timeout')), OAUTH_TIMEOUT),
        };
      });
      try {
        await openUrl(result.data.url);
      } catch {
        settle(new AuthError(BROWSER_FAILED, 'browser'));
      }
      return done;
    },

    // Is a browser sign-in waiting for its callback?
    waiting() {
      return pending ? pending.provider : null;
    },

    // Hands a terraboard://auth/callback link to the sign-in waiting for it. Returns false
    // when the link isn't one, or nothing is waiting (cancelled, or from an old attempt).
    async finishOAuth(url) {
      const link = parseAuthCallback(url);
      if (!link || !pending) return false;
      if (link.error) {
        settle(
          new AuthError(link.error === 'access_denied' ? CANCELLED : BROWSER_FAILED, link.error),
        );
        return true;
      }
      const flow = pending;
      let result;
      try {
        await onBeforeSignIn();
        result = await client.auth.exchangeCodeForSession(link.code);
      } catch (e) {
        if (pending === flow) settle(friendly(e, BROWSER_FAILED));
        return true;
      }
      // Cancelled while the code was being exchanged: the session stays, the caller decides.
      if (pending !== flow) return true;
      if (result.error || !result.data?.session) settle(friendly(result.error, BROWSER_FAILED));
      else settle(userInfo(result.data.session));
      return true;
    },

    cancel() {
      settle(new AuthError(CANCELLED, 'cancelled'));
    },

    // Signs out on this computer only (other computers stay signed in) and, when device is
    // given, removes it from the account's list.
    async signOut({ device } = {}) {
      auth.cancel();
      const current = userInfo(await session());
      if (device && current.state === 'signedIn')
        await client.rpc('revoke_device', { p_id: device }).catch(() => {});
      try {
        await client.auth.signOut({ scope: 'local' });
      } catch {}
    },

    // --- Devices -----------------------------------------------------------------------

    // Call after signing in and on every start. Returns { revoked: true } when this computer
    // was removed from the account; the app then signs out here and keeps its boards.
    async registerDevice({ id, name, version }) {
      return rpc(
        client,
        'register_device',
        { p_id: id, p_name: String(name || 'Computer').slice(0, 80), p_version: version || null },
        'Could not register this computer.',
      );
    },

    async devices(currentId) {
      let result;
      try {
        result = await client
          .from('devices')
          .select('id, name, app_version, last_seen')
          .is('revoked_at', null)
          .order('last_seen', { ascending: false });
      } catch (e) {
        throw friendly(e, 'Could not load your computers.');
      }
      if (result.error) throw friendly(result.error, 'Could not load your computers.');
      return result.data.map((d) => ({
        id: d.id,
        name: d.name,
        version: d.app_version || null,
        lastSeen: d.last_seen,
        current: d.id === currentId,
      }));
    },

    async removeDevice(id) {
      await rpc(client, 'revoke_device', { p_id: id }, 'Could not remove this computer.');
    },

    // --- The account's library ---------------------------------------------------------

    // The account's personal workspace, created on first use: { workspace, name, created }.
    async personalWorkspace(name) {
      const me = userInfo(await session());
      if (me.state !== 'signedIn') throw new AuthError(NOT_SIGNED_IN, 'signed_out');
      return rpc(
        client,
        'ensure_personal_workspace',
        { p_name: name || me.name || (me.email ? me.email.split('@')[0] : '') },
        'Could not set up your cloud library.',
      );
    },

    // --- Claiming a 0.1.28 computer ----------------------------------------------------

    // Before signing in on a computer with an anonymous session: the tokens to keep (the
    // desktop app stores them encrypted with its session) so the claim can run after the
    // sign-in replaced the session. null when there is nothing to claim.
    async anonymousTokens() {
      const current = await session();
      if (current?.user?.is_anonymous !== true) return null;
      return { access_token: current.access_token, refresh_token: current.refresh_token };
    },

    // After signing in: moves the anonymous computer's workspace onto the account.
    // makeClient() returns a throwaway client that keeps its session in memory only.
    // Returns the server's answer ({ result: 'moved' | 'joined' | 'combine' | 'none',
    // workspace, retire }) or { result: 'lost' } when the anonymous session no longer works.
    // tokens: the latest anonymous tokens, to keep if this fails for a reason worth retrying.
    async claim(tokens, makeClient) {
      const me = userInfo(await session());
      if (me.state !== 'signedIn') throw new AuthError(NOT_SIGNED_IN, 'signed_out');
      const anonymous = makeClient();
      let restored;
      try {
        restored = await anonymous.auth.setSession(tokens);
      } catch (e) {
        throw offline(e) ? new AuthError(NO_CONNECTION, 'offline') : friendly(e);
      }
      if (restored.error || !restored.data?.session) {
        if (offline(restored.error)) throw new AuthError(NO_CONNECTION, 'offline');
        return { result: 'lost' };
      }
      const fresh = restored.data.session;
      const keep = { access_token: fresh.access_token, refresh_token: fresh.refresh_token };
      try {
        const secret = await rpc(anonymous, 'begin_claim', {}, 'Could not move your cloud boards.');
        const outcome = await rpc(
          client,
          'finish_claim',
          { p_secret: secret },
          'Could not move your cloud boards.',
        );
        return outcome;
      } catch (e) {
        e.tokens = keep;
        throw e;
      } finally {
        anonymous.auth.stopAutoRefresh?.();
      }
    },

    // After a combine, once the library is uploaded to the account's workspace: removes the
    // old workspace's files, then the workspace (its shares move to the new one).
    async retireWorkspace(old, next) {
      await removeWorkspaceFiles(client, old);
      await rpc(
        client,
        'retire_workspace',
        { p_old: old, p_new: next },
        'Could not combine your cloud libraries.',
      );
    },

    // --- Deleting cloud data -----------------------------------------------------------

    // Right to erasure: the person's cloud library with its files, shares, devices and the
    // sign-in itself. Works for anonymous 0.1.28 computers too. Boards on the computer stay.
    // Returns { userDeleted } (false: data gone, sign-in removal left to an admin).
    async deleteCloudData() {
      if (userInfo(await session()).state === 'signedOut')
        throw new AuthError(NOT_SIGNED_IN, 'signed_out');
      const workspaces = await rpc(
        client,
        'my_deletable_workspaces',
        {},
        'Could not delete your cloud data.',
      );
      for (const workspace of workspaces || []) await removeWorkspaceFiles(client, workspace);
      const result = await rpc(
        client,
        'delete_my_cloud_data',
        {},
        'Could not delete your cloud data.',
      );
      try {
        await client.auth.signOut({ scope: 'local' });
      } catch {}
      return { userDeleted: result?.userDeleted !== false };
    },
  };
  return auth;
}

// Removes every file under <workspace>/ in the media and profile buckets, page by page.
async function removeWorkspaceFiles(client, workspace) {
  for (const bucket of ['assets', 'profiles']) {
    for (let round = 0; round < 10000; round++) {
      let listed;
      try {
        listed = await client.storage.from(bucket).list(workspace, { limit: 1000 });
      } catch (e) {
        throw offline(e) ? new AuthError(NO_CONNECTION, 'offline') : friendly(e);
      }
      if (listed.error) throw friendly(listed.error, 'Could not delete your files.');
      const names = (listed.data || [])
        .filter((f) => f.id !== null)
        .map((f) => `${workspace}/${f.name}`);
      if (!names.length) break;
      const removed = await client.storage.from(bucket).remove(names);
      if (removed.error) throw friendly(removed.error, 'Could not delete your files.');
      // Nothing removed means the server doesn't let this person: stop instead of looping.
      if (!removed.data?.length) throw new AuthError('Could not delete your files.', 'storage');
    }
  }
}

module.exports = {
  REDIRECT_URL,
  AuthError,
  createCloudAuth,
  parseAuthCallback,
  friendly,
  userInfo,
};
