const fs = require('node:fs');
const os = require('node:os');

// The device's approximate town from its public address, for the devices list. GeoJS is
// free and needs no key; it only sees the device's own address, once per app start.
async function lookUpLocation() {
  const response = await fetch('https://get.geojs.io/v1/ip/geo.json', {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) return null;
  const geo = await response.json();
  const parts = [geo.city, geo.city ? null : geo.region, geo.country]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(', ').slice(0, 120) : null;
}
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { referencedAssets } = require('./store-sync.cjs');
const { createCloudAuth, userInfo } = require('./cloud-auth.cjs');

// Where a 0.1.28 computer's anonymous session waits for the claim after signing in.
const ANONYMOUS_KEY = 'terra-cloud-anonymous';
const SIGNED_OUT = { state: 'signedOut' };
// After a change here, how long sync waits before uploading it; after another computer
// says it uploaded, how long before downloading. Edits on an open board also travel live
// (sendEdit), so these only decide how soon the change is stored everywhere.
const PUSH_DELAY = 400;
const PULL_DELAY = 50;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iconAssetId = (icon) =>
  typeof icon === 'string' && icon.startsWith('asset-') ? icon.slice(6) : null;
// Node says "fetch failed"; Chromium (the Android app's storage worker) "Failed to fetch".
const offline = (e) =>
  /fetch failed|failed to fetch|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(
    String(e?.message || e),
  );
const fail = (error, fallback) => {
  if (!error) return;
  throw Error(error.message || fallback);
};
const audioTypes = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};
const audioType = (name) =>
  audioTypes[path.extname(String(name || '')).toLowerCase()] || 'audio/mpeg';
const audioExtension = (type) =>
  Object.entries(audioTypes).find(([, t]) => t === type)?.[0] || '.mp3';
const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// Session tokens are stored next to the library, encrypted when the OS allows it.
function sessionStorage(file, safeStorage) {
  const read = () => {
    try {
      const raw = fs.readFileSync(file);
      const text =
        safeStorage?.isEncryptionAvailable() && raw[0] !== 0x7b
          ? safeStorage.decryptString(raw)
          : raw.toString('utf8');
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
  const write = (data) => {
    const text = JSON.stringify(data);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      safeStorage?.isEncryptionAvailable() ? safeStorage.encryptString(text) : text,
    );
  };
  return {
    getItem: (key) => read()[key] ?? null,
    setItem: (key, value) => write({ ...read(), [key]: value }),
    removeItem: (key) => {
      const data = read();
      delete data[key];
      write(data);
    },
  };
}

// Cloud sync for one library. A person signs in to an account, which has one
// personal workspace; it holds their whole library when library sync is on, and
// otherwise only what they share. Folders and boards other people share are
// pulled from those people's workspaces with view or edit rights. Computers set up
// by 0.1.28 are anonymous users instead; they keep syncing until they sign in,
// and then the claim moves their workspace onto the account (cloud-auth.cjs).
class CloudSync {
  // legacyServerUrl: the server a session saved without a marker (by 0.1.28 and earlier) is for.
  // openUrl opens a web page in the system browser (Google and Microsoft sign-in).
  constructor({
    call,
    root,
    config,
    server,
    legacyServerUrl,
    safeStorage,
    transaction,
    onStatus,
    onPresence,
    openUrl,
    appVersion,
    redirectTo,
    createSupabaseClient,
    locate,
  }) {
    this.call = call;
    this.root = root;
    this.safeStorage = safeStorage;
    this.config = config;
    this.transaction = transaction;
    this.onStatus = onStatus;
    this.onPresence = onPresence;
    this.openUrl = openUrl || (async () => {});
    // The Android app passes its own redirect and client factory; the desktop uses the defaults.
    this.redirectTo = redirectTo;
    this.createSupabaseClient = createSupabaseClient || createClient;
    this.appVersion = appVersion || null;
    // The town shown next to this device in Settings → Account: locate() → "Vienna, Austria".
    this.locate = locate || null;
    this.place = null;
    this.deviceError = null;
    this.knownDevice = null;
    this.media = new Map();
    this.board = null;
    this.status = {
      configured: !!config,
      server: server || null,
      state: 'off',
      identity: false,
      library: false,
      name: '',
      pending: 0,
      lastSync: null,
      error: null,
      shared: [],
      sharedWithMe: [],
      account: SIGNED_OUT,
      methods: null,
      waiting: null,
    };
    this.timer = null;
    this.poll = null;
    this.running = null;
    this.again = false;
    this.channels = new Map();
    this.roles = { boards: {}, folders: {} };
    this.foreign = [];
    this.client = null;
    this.dropSessionForOtherServer(legacyServerUrl);
    this.makeClient(config);
  }

  // A session saved for another server must never reach this one: a new client refreshes its
  // session straight away. The marker keeps naming the old server, so start() still turns
  // sync off and says why.
  dropSessionForOtherServer(legacyServerUrl) {
    const session = path.join(this.root, 'settings', 'cloud-session');
    if (!fs.existsSync(session)) return;
    const recorded = this.recordedServer();
    const owner = recorded ?? legacyServerUrl ?? null;
    if (!owner || owner === this.config?.url) return;
    fs.rmSync(session, { force: true });
    if (!recorded) {
      try {
        fs.writeFileSync(this.sessionServerFile(), owner);
      } catch {}
    }
  }

  // The client for one server. The person's session lives next to the library
  // and belongs to that server only. No config means no client (local use only).
  makeClient(config) {
    this.config = config || null;
    this.vault = sessionStorage(
      path.join(this.root, 'settings', 'cloud-session'),
      this.safeStorage,
    );
    this.client = config
      ? this.createSupabaseClient(config.url, config.key, {
          auth: {
            storage: this.vault,
            storageKey: 'terra-cloud',
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            // Google and Microsoft sign in through the system browser; PKCE keeps the code
            // useless to any other program that receives the terraboard:// link.
            flowType: 'pkce',
          },
        })
      : null;
    this.auth = this.client
      ? createCloudAuth({
          client: this.client,
          openUrl: (url) => this.openUrl(url),
          ...(this.redirectTo ? { redirectTo: this.redirectTo } : {}),
          onBeforeSignIn: () => this.keepAnonymousSession(),
        })
      : null;
    // The session can end on its own (this computer removed from the account, a refresh
    // that fails); the account shown follows it. No awaiting Supabase inside this callback.
    const client = this.client;
    client?.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' || this.client !== client) return;
      this.emit({ account: userInfo(session) });
    });
  }

  // A client that keeps its session in memory only, for the claim.
  tempClient() {
    const memory = new Map();
    return this.createSupabaseClient(this.config.url, this.config.key, {
      auth: {
        storage: {
          getItem: (k) => memory.get(k) ?? null,
          setItem: (k, v) => memory.set(k, v),
          removeItem: (k) => memory.delete(k),
        },
        storageKey: 'terra-claim',
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }

  // This installation's id, made once and kept with the library's settings.
  get deviceId() {
    this.knownDevice ??= this.loadDeviceId();
    return this.knownDevice;
  }

  set deviceId(id) {
    this.knownDevice = id;
  }

  // The id belongs to this computer: a library copied or restored onto another computer
  // gets a new one there, or both would skip each other's changes.
  loadDeviceId() {
    const file = path.join(this.root, 'settings', 'device.json');
    const host = os.hostname();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (uuid.test(saved.id) && saved.host === host) return saved.id;
    } catch {}
    const id = randomUUID();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ id, host }));
    } catch {}
    return id;
  }

  // Points the engine at another server. Only while sync is off, so nothing is
  // waiting to be sent. The old server's session is dropped; boards in this
  // library stay as they are, and copies of other people's boards were already
  // removed when sync was turned off.
  async reconfigure(config, server) {
    if ((await this.local()).identity) throw Error('Turn off sync before changing servers.');
    this.stop();
    await this.idle();
    await this.presenceQueue;
    this.client?.auth.stopAutoRefresh();
    this.forgetSession();
    this.workspace = null;
    this.userId = null;
    this.makeClient(config);
    return this.emit({ configured: !!config, server: server || null, state: 'off', error: null });
  }

  // The saved session belongs to one server; this file records which, so a different server
  // at the next start (a new managed file, a changed setting) is noticed.
  sessionServerFile() {
    return path.join(this.root, 'settings', 'cloud-session-server');
  }

  recordedServer() {
    try {
      return fs.readFileSync(this.sessionServerFile(), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  recordSessionServer() {
    if (!this.config) return;
    try {
      fs.mkdirSync(path.dirname(this.sessionServerFile()), { recursive: true });
      fs.writeFileSync(this.sessionServerFile(), this.config.url);
    } catch {}
  }

  forgetSession() {
    fs.rmSync(path.join(this.root, 'settings', 'cloud-session'), { force: true });
    fs.rmSync(this.sessionServerFile(), { force: true });
  }

  emit(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
    return this.status;
  }

  async local() {
    const l = await this.call('syncStatus');
    return {
      identity: l.identity,
      library: l.library,
      name: l.name,
      pending: l.pending,
      workspace: l.workspace,
      rejoin: !!l.rejoin,
    };
  }

  async start() {
    if (!this.client && !this.recordedServer()) return this.status;
    const local = await this.local();
    const recorded = this.recordedServer();
    if (local.identity && recorded && recorded !== this.config?.url) {
      // Another server than the one this sync was set up with: nothing to say to either.
      this.stop();
      await this.turnOffLocally();
      this.forgetSession();
      // A fresh client, so no old session stays in memory either.
      this.client?.auth.stopAutoRefresh();
      this.makeClient(this.config);
      return this.emit({
        state: 'off',
        identity: false,
        library: false,
        pending: 0,
        lastSync: null,
        shared: [],
        sharedWithMe: [],
        error: 'The server for this computer changed, so sync was turned off.',
      });
    }
    const account = await this.checkAccount();
    if (!local.identity) return this.emit({ state: 'off', ...local, shared: [], sharedWithMe: [] });
    if (!recorded) this.recordSessionServer();
    this.workspace = local.workspace;
    this.emit({ state: 'syncing', ...local });
    if (account.state === 'signedOut') {
      // Signed out, the server can no longer say what is still shared here: copies of
      // other people's boards go, as when sync is turned off.
      await this.transaction(async () => {
        const dropped = await this.call('syncDropForeign');
        return { library: dropped.changed, boards: [] };
      });
      return this.emit({ state: 'error', error: 'Signed out. Sign in to sync again.' });
    }
    if (account.state === 'signedIn' && this.claimWaiting()) {
      try {
        await this.runClaim();
      } catch (e) {
        return this.emit({
          state: 'error',
          error: `Signed in, but your cloud boards were not moved to your account yet. ${e.message}`,
        });
      }
      // The claim may have moved this library to another workspace.
      this.workspace = (await this.local()).workspace;
    }
    this.userId = account.userId;
    this.listen(this.workspace);
    void this.rejoin().catch(() => {});
    void this.loadProfile().catch(() => {});
    // Files synced boards use but this library lacks are fetched again (retryFetches).
    await this.call('syncScanMissing').catch(() => {});
    clearInterval(this.poll);
    this.poll = setInterval(() => this.schedule(0), 30000);
    this.schedule(0);
    return this.status;
  }

  // --- Account ---------------------------------------------------------------

  // Who is signed in, the sign-in methods this server offers, and this computer's place on
  // the account. Returns the account (see cloud-auth userInfo).
  async checkAccount() {
    if (!this.auth) return this.emit({ account: SIGNED_OUT }).account;
    const account = await this.auth.account();
    this.emit({ account, waiting: this.auth.waiting() });
    if (!this.status.methods) void this.loadMethods().catch(() => {});
    if (account.state !== 'signedIn') return account;
    this.userId = account.userId;
    let revoked = false;
    try {
      revoked = (await this.registerHere())?.revoked;
    } catch {
      // Offline or an older server: asked again on the next start (and by devices()).
    }
    if (!revoked) return account;
    await this.signOut();
    this.emit({ error: 'This computer was removed from your account. Sign in to sync again.' });
    return SIGNED_OUT;
  }

  async loadMethods() {
    if (!this.auth || !this.config) return this.emit({ methods: null });
    const config = this.config;
    const methods = await this.auth.methods({
      url: config.url,
      key: config.key,
      allowed: config.signIn,
    });
    if (this.config === config) this.emit({ methods });
    return methods;
  }

  async requireSignedOut() {
    this.requireClient();
    if ((await this.auth.account()).state === 'signedIn') throw Error('You are already signed in.');
  }

  async sendEmailCode(email) {
    await this.requireSignedOut();
    return this.auth.sendEmailCode(email);
  }

  async verifyEmailCode(email, code) {
    await this.requireSignedOut();
    try {
      await this.auth.verifyEmailCode(email, code);
    } catch (e) {
      await this.resumeAfterFailedSignIn();
      throw e;
    }
    return this.afterSignIn();
  }

  // For accounts with a password (the app-store review account; cloud-auth.cjs).
  async signInWithPassword(email, password) {
    await this.requireSignedOut();
    try {
      await this.auth.signInWithPassword(email, password);
    } catch (e) {
      await this.resumeAfterFailedSignIn();
      throw e;
    }
    return this.afterSignIn();
  }

  // Google or Microsoft in the system browser; finishes when the terraboard://auth/callback
  // link arrives (finishOAuth), or fails on cancelSignIn().
  async signInWithProvider(provider) {
    await this.requireSignedOut();
    this.emit({ waiting: provider });
    try {
      await this.auth.signInWithProvider(provider);
    } catch (e) {
      this.emit({ waiting: null });
      await this.resumeAfterFailedSignIn();
      throw e;
    }
    this.emit({ waiting: null });
    return this.afterSignIn();
  }

  finishOAuth(url) {
    return this.auth ? this.auth.finishOAuth(url) : Promise.resolve(false);
  }

  cancelSignIn() {
    this.auth?.cancel();
    return this.emit({ waiting: null });
  }

  // Right before a sign-in replaces an anonymous 0.1.28 session: keep that session for the
  // claim, and pause sync so nothing is sent as the account before the claim is done.
  async keepAnonymousSession() {
    const tokens = await this.auth.anonymousTokens();
    if (!tokens || !(await this.local()).identity) return;
    this.vault.setItem(ANONYMOUS_KEY, JSON.stringify(tokens));
    this.stop();
    await this.idle();
  }

  // The sign-in failed: an anonymous computer keeps syncing as before.
  async resumeAfterFailedSignIn() {
    if ((await this.auth.account()).state === 'anonymous' && (await this.local()).identity)
      await this.start().catch(() => {});
  }

  async afterSignIn() {
    this.recordSessionServer();
    this.emit({ error: null });
    return this.start();
  }

  // --- The claim (0.1.28 computers) ---------------------------------------------

  retireFile() {
    return path.join(this.root, 'settings', 'cloud-retire.json');
  }

  readRetire() {
    try {
      const pending = JSON.parse(fs.readFileSync(this.retireFile(), 'utf8'));
      return uuid.test(pending.old) && uuid.test(pending.next) ? pending : null;
    } catch {
      return null;
    }
  }

  claimWaiting() {
    return !!this.vault?.getItem(ANONYMOUS_KEY) || !!this.readRetire();
  }

  // One at a time: a second claim would replace the first one's secret.
  runClaim() {
    this.claiming ??= this.claimOnce().finally(() => {
      this.claiming = null;
    });
    return this.claiming;
  }

  async claimOnce() {
    const raw = this.vault.getItem(ANONYMOUS_KEY);
    if (raw) {
      const local = await this.local();
      let outcome = null;
      if (local.identity) {
        try {
          outcome = await this.auth.claim(
            JSON.parse(raw),
            () => this.tempClient(),
            local.workspace,
          );
        } catch (e) {
          if (e.tokens) this.vault.setItem(ANONYMOUS_KEY, JSON.stringify(e.tokens));
          throw e;
        }
      }
      this.vault.removeItem(ANONYMOUS_KEY);
      if (outcome) await this.adoptClaim(outcome, local);
    }
    await this.retireWhenUploaded();
  }

  // The library stays on its workspace when the claim kept it; otherwise it moves to the
  // account's personal workspace and uploads there.
  async adoptClaim(outcome, local) {
    if (['moved', 'joined'].includes(outcome.result) && outcome.workspace === local.workspace)
      return;
    const target =
      outcome.result === 'combine' || (outcome.result === 'joined' && outcome.workspace)
        ? outcome.workspace
        : (await this.auth.personalWorkspace(local.name)).workspace;
    await this.moveLibrary(target, local);
    if (outcome.result === 'combine' && outcome.retire) {
      fs.mkdirSync(path.dirname(this.retireFile()), { recursive: true });
      fs.writeFileSync(this.retireFile(), JSON.stringify({ old: outcome.retire, next: target }));
    }
  }

  // Points this library at another of the person's workspaces and queues what belongs
  // there: everything when the whole library syncs, otherwise what this person shares.
  async moveLibrary(workspace, local) {
    const lib = await this.call('library');
    const owned = [
      ...Object.entries(lib.sharing?.folders || {}).map(([id, m]) => ['folder', id, m]),
      ...Object.entries(lib.sharing?.boards || {}).map(([id, m]) => ['board', id, m]),
    ]
      .filter(([, , mark]) => mark.shared === 'owner')
      .map(([kind, targetId]) => ({ kind, targetId, shareId: 'moved' }));
    await this.transaction(async () => {
      if (local.library) await this.call('syncEnable', { workspace });
      else {
        await this.call('syncIdentity', { workspace });
        await this.call('syncOwned', { shares: owned, upload: true });
      }
      return { library: true, boards: [] };
    });
    this.workspace = workspace;
  }

  // After a combine: once this computer's library is in the account's workspace, the old
  // workspace goes, and its shares move over.
  async retireWhenUploaded() {
    const pending = this.readRetire();
    if (!pending) return;
    const local = await this.local();
    if (local.workspace !== pending.next) {
      fs.rmSync(this.retireFile(), { force: true });
      return;
    }
    // Not before this library has been pulled and everything it adds is uploaded.
    if (local.rejoin || local.pending > 0) return;
    try {
      await this.auth.retireWorkspace(pending.old, pending.next);
    } catch (e) {
      // Offline: next round. Refused: nothing will change that, so stop trying.
      if (e.code === 'offline') throw e;
    }
    fs.rmSync(this.retireFile(), { force: true });
  }

  // --- Library identity --------------------------------------------------------

  // A cloud identity for this library: the account's personal workspace. Needed to sync,
  // share or accept a share. The name is what people it shares with see.
  async identify(name) {
    this.requireClient();
    const local = await this.local();
    const wanted = typeof name === 'string' ? name.trim().slice(0, 60) : '';
    if (local.identity) {
      if (wanted && wanted !== local.name) await this.rename(wanted);
      return this.status;
    }
    if ((await this.auth.account()).state !== 'signedIn')
      throw Error('Sign in first, in Settings → Account.');
    const space = await this.auth.personalWorkspace(wanted || local.name);
    // Another computer of this account chose the name already; a new one only fills a gap.
    let shown = space.name || '';
    if (!shown && wanted) {
      const named = await this.client.rpc('set_display_name', {
        p_workspace: space.workspace,
        p_name: wanted,
      });
      fail(named.error, 'Could not save your name');
      shown = wanted;
    }
    await this.call('syncIdentity', { workspace: space.workspace, name: shown });
    return this.start();
  }

  async rename(name) {
    this.requireWorkspace();
    const { error } = await this.client.rpc('set_display_name', {
      p_workspace: this.workspace,
      p_name: name,
    });
    fail(error, 'Could not save your name');
    await this.call('syncRename', { name });
    return this.emit(await this.local());
  }

  // Sync the whole library, or only what is shared.
  async setLibrary(on, name) {
    if (on) await this.identify(name || this.status.name);
    else this.requireWorkspace();
    await this.call('syncLibrary', { on: !!on });
    this.emit(await this.local());
    this.schedule(0);
    return this.status;
  }

  async enable(name) {
    return this.setLibrary(true, name || this.status.name);
  }

  // An invite to someone's share. Pairing codes from 0.1.28 are gone: another computer
  // signs in to the same account instead.
  async join(code, name) {
    this.requireClient();
    if (typeof code !== 'string' || code.length > 40) throw Error('Enter the code you were given');
    const clean = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (clean.startsWith('S')) {
      await this.requireAccount('Sign in to open boards people share with you.');
      await this.identify(name || this.status.name);
      const { error } = await this.client.rpc('redeem_share_invite', {
        p_code: clean,
        p_workspace: this.workspace,
      });
      fail(error, 'This code is wrong or has expired');
      await this.run();
      return this.status;
    }
    throw Error('To add a computer, sign in on it with the same account.');
  }

  // The part of turning sync off that only touches this computer.
  async turnOffLocally() {
    await this.transaction(async () => {
      await this.call('syncDisable');
      return { library: true, boards: [] };
    });
    this.workspace = null;
  }

  // Turns sync off on this computer. Signed in to an account, the person stays signed in and
  // their other computers keep syncing; a 0.1.28 computer also leaves its workspace.
  async disable() {
    this.stop();
    await this.idle();
    fs.rmSync(this.retireFile(), { force: true });
    if ((await this.auth?.account())?.state === 'signedIn') {
      await this.turnOffLocally();
      return this.emit({
        state: 'off',
        identity: false,
        library: false,
        pending: 0,
        error: null,
        lastSync: null,
        shared: [],
        sharedWithMe: [],
      });
    }
    if (this.client && this.workspace && this.userId) {
      try {
        await this.client.rpc('remove_member', {
          p_workspace: this.workspace,
          p_user: this.userId,
        });
        await this.client.auth.signOut();
      } catch {}
    }
    await this.turnOffLocally();
    // The session goes too, even when signing out failed or was skipped.
    this.client?.auth.stopAutoRefresh();
    this.forgetSession();
    this.makeClient(this.config);
    this.workspace = null;
    return this.emit({
      state: 'off',
      identity: false,
      library: false,
      pending: 0,
      error: null,
      lastSync: null,
      shared: [],
      sharedWithMe: [],
      account: SIGNED_OUT,
    });
  }

  // Signs out on this computer: sync stops, copies of other people's boards go, this
  // computer leaves the account's list. The person's own boards stay here.
  async signOut() {
    if ((await this.auth?.account())?.state !== 'signedIn') return this.disable();
    this.stop();
    await this.idle();
    fs.rmSync(this.retireFile(), { force: true });
    await this.turnOffLocally();
    await this.auth.signOut({ device: this.deviceId });
    return this.forgetAccount();
  }

  // After signing out or deleting the account: a fresh client with no session.
  forgetAccount() {
    this.client?.auth.stopAutoRefresh();
    this.forgetSession();
    this.makeClient(this.config);
    this.workspace = null;
    this.userId = null;
    return this.emit({
      state: 'off',
      identity: false,
      library: false,
      pending: 0,
      error: null,
      lastSync: null,
      shared: [],
      sharedWithMe: [],
      account: SIGNED_OUT,
      waiting: null,
    });
  }

  // Deletes this person's cloud library, its files and shares, and their sign-in.
  // Boards on this computer stay. Returns { userDeleted }.
  async deleteCloudData() {
    this.requireClient();
    this.stop();
    await this.idle();
    let result;
    try {
      result = await this.auth.deleteCloudData();
    } catch (e) {
      void this.start().catch(() => {});
      throw e;
    }
    fs.rmSync(this.retireFile(), { force: true });
    await this.turnOffLocally();
    this.forgetAccount();
    return result;
  }

  // Adds or refreshes this device on the account. A failure is kept for the devices list.
  async registerHere() {
    if (this.locate && !this.place)
      this.place = await Promise.resolve()
        .then(() => this.locate())
        .catch(() => null);
    try {
      const result = await this.auth.registerDevice({
        id: this.deviceId,
        name: os.hostname(),
        version: this.appVersion,
        platform: os.platform(),
        location: this.place,
      });
      this.deviceError = null;
      return result;
    } catch (e) {
      this.deviceError = String(e?.message || e);
      throw e;
    }
  }

  // The devices signed in to this account, this one first. If this device is missing (its
  // registration failed at start), it is registered again; if that fails too, it is listed
  // anyway with the reason.
  async devices() {
    this.requireClient();
    if ((await this.auth.account()).state !== 'signedIn') return [];
    let list = await this.auth.devices(this.deviceId);
    if (!list.some((d) => d.current)) {
      try {
        if ((await this.registerHere())?.revoked) {
          await this.signOut();
          this.emit({ error: 'This device was removed from your account. Sign in to sync again.' });
          return [];
        }
        list = await this.auth.devices(this.deviceId);
      } catch {}
    }
    const here = list.find((d) => d.current) || {
      id: this.deviceId,
      name: os.hostname(),
      version: this.appVersion,
      platform: os.platform(),
      lastSeen: new Date().toISOString(),
      ip: null,
      location: this.place,
      firstSeen: null,
      signedInAt: null,
      current: true,
      problem: this.deviceError || 'Not on your account yet.',
    };
    return [here, ...list.filter((d) => !d.current)];
  }

  async removeDevice(id) {
    this.requireClient();
    if (id === this.deviceId) return this.signOut();
    await this.auth.removeDevice(id);
  }

  // --- Profile -------------------------------------------------------------

  async profile() {
    return this.call('syncProfile');
  }

  // Bring this computer's copy of the picture and song in line with the server,
  // for example after changing them on another computer.
  async loadProfile() {
    const { data, error } = await this.client.rpc('my_profile', { p_workspace: this.workspace });
    if (error || !data?.length) return;
    const remote = data[0];
    const local = await this.profile();
    const patch = {};
    if (Number(remote.avatar_version) !== local.avatarVersion) {
      patch.avatarVersion = Number(remote.avatar_version);
      patch.avatar = remote.avatar_version
        ? await this.fetchMedia(this.workspace, 'avatar', remote.avatar_version)
        : null;
    }
    if (Number(remote.song_version) !== local.songVersion) {
      patch.songVersion = Number(remote.song_version);
      patch.song = remote.song_version
        ? await this.fetchMedia(this.workspace, 'song', remote.song_version)
        : null;
    }
    if (Object.keys(patch).length) await this.call('syncSetProfile', patch);
    this.emit({ profile: await this.profile() });
  }

  async uploadMedia(kind, assetId) {
    const asset = await this.call('asset', { id: assetId, variant: 'original' });
    const { error } = await this.client.storage
      .from('profiles')
      .upload(`${this.workspace}/${kind}`, fs.readFileSync(asset.file), {
        contentType: kind === 'song' ? audioType(asset.name) : asset.mime,
        upsert: true,
      });
    fail(error, 'Could not upload your ' + (kind === 'song' ? 'song' : 'picture'));
  }

  async setAvatar(assetId) {
    this.requireWorkspace();
    const version = assetId ? Date.now() : 0;
    if (assetId) await this.uploadMedia('avatar', assetId);
    else await this.client.storage.from('profiles').remove([`${this.workspace}/avatar`]);
    const { error } = await this.client.rpc('set_profile_media', {
      p_workspace: this.workspace,
      p_avatar: version,
      p_song: null,
    });
    fail(error, 'Could not save your picture');
    await this.call('syncSetProfile', { avatar: assetId, avatarVersion: version });
    return this.announce();
  }

  async setSong(assetId, name) {
    this.requireWorkspace();
    const version = assetId ? Date.now() : 0;
    if (assetId) {
      const asset = await this.call('asset', { id: assetId, variant: 'original' });
      if (asset.bytes > 10 * 1024 * 1024) throw Error('Choose a song up to 10 MB.');
      await this.uploadMedia('song', assetId);
    } else await this.client.storage.from('profiles').remove([`${this.workspace}/song`]);
    const { error } = await this.client.rpc('set_profile_media', {
      p_workspace: this.workspace,
      p_avatar: null,
      p_song: version,
    });
    fail(error, 'Could not save your song');
    await this.call('syncSetProfile', {
      song: assetId,
      songName: assetId ? name : null,
      songVersion: version,
    });
    return this.announce();
  }

  async setPublishSong(on) {
    await this.call('syncSetProfile', { publishSong: !!on });
    return this.announce();
  }

  async announce() {
    const profile = await this.profile();
    this.emit({ profile });
    if (this.board?.channel) await this.board.channel.track(await this.presenceInfo());
    return profile;
  }

  // Someone's picture or song as a local asset, downloaded once per version.
  async fetchMedia(person, kind, version) {
    const key = `${person}/${kind}/${version}`;
    if (this.media.has(key)) return this.media.get(key);
    const job = (async () => {
      const { data, error } = await this.client.storage
        .from('profiles')
        .download(`${person}/${kind}`);
      if (error) return null;
      const bytes = new Uint8Array(await data.arrayBuffer());
      const name =
        kind === 'avatar' ? 'Profile picture.png' : 'Entrance song' + audioExtension(data.type);
      const asset = await this.call('importAsset', { bytes, name });
      return asset.id;
    })();
    this.media.set(key, job);
    const id = await job;
    if (!id) this.media.delete(key);
    return id;
  }

  async profileMedia(person, avatarVersion, songVersion) {
    if (!this.client || typeof person !== 'string') return { avatar: null, song: null };
    const [avatar, song] = await Promise.all([
      avatarVersion ? this.fetchMedia(person, 'avatar', avatarVersion) : null,
      songVersion ? this.fetchMedia(person, 'song', songVersion) : null,
    ]);
    return { avatar, song };
  }

  // --- Presence on a board ---------------------------------------------------

  async presenceInfo() {
    const profile = await this.profile();
    return {
      person: this.workspace,
      name: this.status.name || 'Someone',
      avatar: profile.avatarVersion,
      song: profile.publishSong ? profile.songVersion : 0,
      songName: profile.publishSong && profile.songVersion ? profile.songName : '',
      device: os.hostname(),
      role: this.board?.role || 'edit',
      joined: this.board?.joined || Date.now(),
    };
  }

  // Announce this person on a cloud board so others see them, their cursor and view.
  // Joins and leaves run one at a time: Realtime keeps one channel per topic, so
  // overlapping ones would share a channel and nobody would be announced.
  joinBoard(boardId) {
    this.wantedBoard = typeof boardId === 'string' ? boardId : null;
    return this.presence(() => this.enterBoard(this.wantedBoard));
  }

  leaveBoard() {
    this.wantedBoard = null;
    return this.presence(() => this.exitBoard());
  }

  // The board asked for before sync was ready, now that it is.
  rejoin() {
    return this.wantedBoard ? this.joinBoard(this.wantedBoard) : Promise.resolve();
  }

  presence(job) {
    const next = (this.presenceQueue || Promise.resolve()).then(job);
    this.presenceQueue = next.catch(() => {});
    return next;
  }

  async enterBoard(boardId) {
    if (!this.client || !this.workspace || !this.userId || !boardId) {
      await this.exitBoard();
      return { active: false };
    }
    const lib = await this.call('library');
    const board = lib.boards.find((b) => b.id === boardId);
    const mark =
      lib.sharing?.boards[boardId] || (board?.folderId && lib.sharing?.folders[board.folderId]);
    if (!board || !(this.status.library || mark)) {
      await this.exitBoard();
      return { active: false };
    }
    const role = mark && mark.shared !== 'owner' ? mark.shared : 'edit';
    const owner = !mark || mark.shared === 'owner';
    const current = this.board;
    // Shared with other people, not only synced between this person's computers.
    const shared = !!mark;
    if (current?.boardId === boardId) {
      // Same board: only the announcement changes, for example a new role.
      if (current.role === role && current.owner === owner) return { active: true, shared };
      // The server judges who may send edits when the channel is joined: join it again.
      if (current.role !== role) {
        await this.leaveEdits(current);
        if (this.board === current) current.edits = this.joinEdits(boardId, current);
      }
      current.role = role;
      current.owner = owner;
      current.folderId = board.folderId || null;
      if (current.subscribed) await current.channel.track(await this.presenceInfo());
      return { active: true, shared };
    }
    await this.exitBoard();
    await this.authRealtime();
    const channel = this.client.channel('board:' + boardId, {
      config: { private: true, presence: { key: this.deviceId }, broadcast: { self: false } },
    });
    const next = {
      boardId,
      folderId: board.folderId || null,
      channel,
      role,
      owner,
      joined: Date.now(),
      subscribed: false,
    };
    this.board = next;
    const people = () =>
      Object.entries(channel.presenceState()).map(([key, metas]) => ({ key, ...metas[0] }));
    channel
      .on('presence', { event: 'sync' }, () =>
        this.onPresence?.({
          type: 'people',
          boardId,
          self: this.deviceId,
          owner: next.owner,
          people: people(),
        }),
      )
      .on('broadcast', { event: 'cursor' }, ({ payload }) =>
        this.onPresence?.({ type: 'cursor', boardId, ...payload }),
      )
      .subscribe(async (state) => {
        if (state !== 'SUBSCRIBED' || this.board !== next) return;
        next.subscribed = true;
        await channel.track(await this.presenceInfo());
      });
    next.edits = this.joinEdits(boardId, next);
    return { active: true, shared };
  }

  // Edits on the open board go straight to the people on it over 'edits:<board id>'; sync
  // stores them a moment later. Everyone who can see the board hears them, and only people
  // who may change it can send (migration 20261024150000). A server without that migration
  // refuses the channel, and edits then arrive through sync alone.
  joinEdits(boardId, board) {
    const channel = this.client.channel('edits:' + boardId, {
      config: { private: true, broadcast: { self: false } },
    });
    const edits = { channel, subscribed: false };
    channel
      .on('broadcast', { event: 'edit' }, ({ payload }) => this.receiveEdit(boardId, payload))
      .subscribe((state, error) => {
        if (board.edits !== edits) return;
        edits.subscribed = state === 'SUBSCRIBED';
        // Refused, not a dropped connection (which rejoins by itself): stop asking.
        if (
          state === 'CHANNEL_ERROR' &&
          /unauthori[sz]ed|permission|denied|not allowed/i.test(String(error?.message || ''))
        ) {
          board.edits = null;
          void Promise.resolve(this.client.removeChannel(channel)).catch(() => {});
        }
      });
    return edits;
  }

  // Finishes once the channel is gone: Realtime keeps one channel per topic, so joining the
  // same board again before that would get the one being removed.
  async leaveEdits(board) {
    const edits = board?.edits;
    if (!edits) return;
    board.edits = null;
    try {
      await this.client.removeChannel(edits.channel);
    } catch {}
  }

  // { boardId, kind: 'edit', upserts, deleted } after an edit here, or { boardId, kind:
  // 'moving', objects, done } while a drag is under way. Like cursors, only sent while
  // someone else is on the board.
  sendEdit(data) {
    const current = this.board;
    const edits = current?.edits;
    if (!edits?.subscribed || current.role !== 'edit' || !current.subscribed) return;
    if (!data || typeof data !== 'object' || data.boardId !== current.boardId) return;
    const others = Object.keys(current.channel.presenceState()).some((k) => k !== this.deviceId);
    if (!others) return;
    const payload =
      data.kind === 'moving'
        ? {
            key: this.deviceId,
            kind: 'moving',
            objects: Array.isArray(data.objects) ? data.objects : [],
            done: !!data.done,
          }
        : {
            key: this.deviceId,
            kind: 'edit',
            upserts: Array.isArray(data.upserts) ? data.upserts : [],
            deleted: Array.isArray(data.deleted) ? data.deleted : [],
          };
    // Realtime refuses large messages; sync brings those edits.
    if (JSON.stringify(payload).length > 200000) return;
    void edits.channel.send({ type: 'broadcast', event: 'edit', payload });
  }

  // An edit from someone on the open board: checked like synced objects, then shown.
  // One at a time, in the order they came; a drag frame that a newer one from the same
  // person overtook while waiting is skipped.
  receiveEdit(boardId, payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.key !== 'string') return;
    const moving = payload.kind === 'moving';
    if (!moving && payload.kind !== 'edit') return;
    const objects = moving ? payload.objects : payload.upserts;
    const deleted = moving ? [] : payload.deleted;
    if (!Array.isArray(objects) || !Array.isArray(deleted)) return;
    const key = payload.key;
    this.liveFrames ??= new Map();
    const frame = moving && !payload.done ? (this.liveFrames.get(key) || 0) + 1 : 0;
    if (frame) this.liveFrames.set(key, frame);
    const job = async () => {
      if (frame && this.liveFrames.get(key) !== frame) return;
      const checked =
        objects.length || deleted.length
          ? await this.call('syncLiveObjects', { objects, deleted })
          : { objects: [], deleted: [] };
      if (this.board?.boardId !== boardId) return;
      this.onPresence?.(
        moving
          ? { type: 'moving', boardId, key, objects: checked.objects, done: !!payload.done }
          : { type: 'edit', boardId, key, upserts: checked.objects, deleted: checked.deleted },
      );
    };
    this.liveQueue = (this.liveQueue || Promise.resolve()).then(job).catch(() => {});
  }

  async exitBoard() {
    const current = this.board;
    this.board = null;
    if (!current) return;
    await this.leaveEdits(current);
    try {
      await current.channel.untrack();
    } catch {}
    try {
      await this.client.removeChannel(current.channel);
    } catch {}
    this.onPresence?.({
      type: 'people',
      boardId: current.boardId,
      self: this.deviceId,
      people: [],
    });
  }

  sendCursor(data) {
    const current = this.board;
    if (!current?.subscribed || !data || typeof data !== 'object') return;
    // Realtime bills every message: send only when someone else can see it.
    const others = Object.keys(current.channel.presenceState()).some((k) => k !== this.deviceId);
    if (!others) return;
    void current.channel.send({
      type: 'broadcast',
      event: 'cursor',
      payload: { key: this.deviceId, x: data.x, y: data.y, view: data.view },
    });
  }

  // --- Sharing ---------------------------------------------------------------

  shareFor(kind, targetId) {
    return this.status.shared.find((s) => s.kind === kind && s.targetId === targetId) || null;
  }

  async sharePeople(kind, targetId) {
    const share = this.workspace && this.shareFor(kind, targetId);
    if (!share) return { shareId: null, people: [] };
    const { data, error } = await this.client.rpc('share_people', { p_share: share.shareId });
    fail(error, 'Could not load who has access');
    return {
      shareId: share.shareId,
      people: data.map((p) => ({ id: p.workspace_id, name: p.name, role: p.role })),
    };
  }

  // Share a folder or board (if not yet) and create a one-time invite code.
  // Sharing and joining need an account (migration 20261024130000 enforces it too).
  async requireAccount(message) {
    this.requireClient();
    if ((await this.auth.account()).state !== 'signedIn') throw Error(message);
  }

  // A share for a folder or board, new or the one it has. Run inside exclusive(): no sync
  // round may read a share list from before this share exists. Content that only this
  // computer has is queued for upload (syncOwned).
  async createShareLocked(kind, targetId) {
    const known = this.shareFor(kind, targetId);
    if (known) return known;
    const { data, error } = await this.client.rpc('create_share', {
      p_workspace: this.workspace,
      p_kind: kind,
      p_target: targetId,
    });
    fail(error, 'Could not put this in the cloud');
    const created = { shareId: data, kind, targetId, people: 0 };
    this.emit({ shared: [...this.status.shared.filter((s) => s.shareId !== data), created] });
    await this.syncOwnedShares();
    return created;
  }

  syncOwnedShares() {
    return this.call('syncOwned', {
      upload: true,
      shares: this.status.shared.map((s) => ({
        kind: s.kind,
        targetId: s.targetId,
        shareId: s.shareId,
      })),
    });
  }

  // Upload to cloud: the board or folder syncs to this account's devices, and only this
  // account can open it until people are invited. On the server it is a share with nobody
  // in it yet, so it syncs like any other share.
  async uploadToCloud(kind, targetId, name) {
    if (!['folder', 'board'].includes(kind)) throw Error('Choose a folder or a board');
    await this.requireAccount('Sign in to upload boards to the cloud.');
    await this.identify(name || this.status.name);
    if (!this.shareFor(kind, targetId))
      await this.exclusive(() => this.createShareLocked(kind, targetId));
    await this.run();
    return this.status;
  }

  async invite(kind, targetId, role, name) {
    if (!['folder', 'board'].includes(kind)) throw Error('Choose a folder or a board');
    await this.requireAccount('Sign in to share boards.');
    await this.identify(name || this.status.name);
    let share = this.shareFor(kind, targetId);
    if (!share) {
      share = await this.exclusive(() => this.createShareLocked(kind, targetId));
      // Upload the shared content before the invite is used.
      await this.run();
    }
    const { data, error } = await this.client.rpc('create_share_invite', {
      p_share: share.shareId,
      p_role: role === 'edit' ? 'edit' : 'view',
    });
    fail(error, 'Could not create an invite');
    return data;
  }

  async setPersonRole(shareId, person, role) {
    const { error } = await this.client.rpc('set_share_role', {
      p_share: shareId,
      p_member: person,
      p_role: role === 'edit' ? 'edit' : 'view',
    });
    fail(error, 'Could not change access');
    this.ping(this.workspace);
  }

  // The shares that give people access to a board: its own and its folder's.
  sharesCovering(board) {
    return this.status.shared.filter(
      (s) =>
        (s.kind === 'board' && s.targetId === board.id) ||
        (s.kind === 'folder' && board.folderId && s.targetId === board.folderId),
    );
  }

  // Change what one person may do on a board, or (role null) take it away,
  // through every share of this person that covers it.
  async setBoardAccess(boardId, person, role) {
    this.requireWorkspace();
    const lib = await this.call('library');
    const board = lib.boards.find((b) => b.id === boardId);
    if (!board) throw Error('This board is gone.');
    let found = false;
    for (const share of this.sharesCovering(board)) {
      const { people } = await this.sharePeople(share.kind, share.targetId);
      if (!people.some((p) => p.id === person)) continue;
      found = true;
      if (role) await this.setPersonRole(share.shareId, person, role);
      else await this.removePerson(share.shareId, person);
    }
    if (!found) throw Error('This person does not get access through your shares.');
  }

  async removePerson(shareId, person) {
    const { error } = await this.client.rpc('remove_share_member', {
      p_share: shareId,
      p_member: person,
    });
    fail(error, 'Could not remove access');
    this.ping(this.workspace);
    await this.run();
  }

  // Everyone loses access and unused invite codes stop working. The board or folder stays
  // in the cloud: the share is replaced by a new one with nobody in it.
  async stopSharing(shareId) {
    const share = this.status.shared.find((s) => s.shareId === shareId);
    await this.exclusive(async () => {
      const { error } = await this.client.rpc('delete_share', { p_share: shareId });
      fail(error, 'Could not stop sharing');
      this.emit({ shared: this.status.shared.filter((s) => s.shareId !== shareId) });
      if (share) await this.createShareLocked(share.kind, share.targetId);
      else await this.syncOwnedShares();
    });
    this.ping(this.workspace);
    await this.run();
  }

  // Take a board out of the cloud: its share ends, its content is wiped from the
  // server, and this computer keeps the board without syncing it any more.
  async removeFromCloud(boardId) {
    this.requireWorkspace();
    await this.exclusive(async () => {
      const lib = await this.call('library');
      const board = lib.boards.find((b) => b.id === boardId);
      if (!board) throw Error('This board is gone.');
      const mark =
        lib.sharing?.boards[boardId] || (board.folderId && lib.sharing?.folders[board.folderId]);
      if (mark && mark.shared !== 'owner')
        throw Error('Only the person who shared this board can remove it from the cloud.');
      const objects = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await this.client
          .from('entities')
          .select('id')
          .eq('workspace_id', this.workspace)
          .eq('kind', 'object')
          .eq('board_id', boardId)
          .eq('deleted', false)
          .order('id')
          .range(from, from + 999);
        fail(error, 'Could not reach the cloud copy');
        objects.push(...data.map((r) => r.id));
        if (data.length < 1000) break;
      }
      const share = this.shareFor('board', boardId);
      if (share) {
        const { error } = await this.client.rpc('delete_share', { p_share: share.shareId });
        fail(error, 'Could not stop sharing');
      }
      // The marker goes first, so this person's other computers keep their copy
      // instead of applying the deletions that follow.
      const push = async (rows) => {
        const { error } = await this.client.rpc('push_entities', {
          p_workspace: this.workspace,
          p_rows: rows,
          p_device: this.deviceId,
        });
        fail(error, 'Could not remove the board from the cloud');
      };
      await push([{ kind: 'board', board_id: '', id: boardId, data: { removed: true } }]);
      for (const part of chunks(objects, 400))
        await push(part.map((id) => ({ kind: 'object', board_id: boardId, id, deleted: true })));
      await this.transaction(() => this.call('syncKeepLocal', { boardId }));
      const shared = this.status.shared.filter((s) => s !== share);
      this.emit({ shared });
      await this.call('syncOwned', {
        shares: shared.map((s) => ({ kind: s.kind, targetId: s.targetId, shareId: s.shareId })),
      });
    });
    this.ping(this.workspace);
    await this.run();
  }

  // Leave something another person shared; its copies disappear here.
  async leave(shareId) {
    this.requireWorkspace();
    const { error } = await this.client.rpc('remove_share_member', {
      p_share: shareId,
      p_member: this.workspace,
    });
    fail(error, 'Could not leave');
    await this.run();
  }

  requireClient() {
    if (!this.client) throw Error('Cloud sync is not set up in this build.');
  }
  requireWorkspace() {
    this.requireClient();
    if (!this.workspace) throw Error('Turn on sync first.');
  }

  stop() {
    void this.presence(() => this.exitBoard());
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.timer = this.poll = null;
    for (const channel of this.channels.values()) this.client?.removeChannel(channel);
    this.channels.clear();
  }

  // Waits for a sync round in progress to finish. stop() cleared the timers, so no round
  // starts by itself; a timer the finished round set for its next one is cleared here.
  async idle() {
    while (this.running) await this.running.catch(() => {});
    clearTimeout(this.timer);
    this.timer = null;
  }

  // People who change a workspace ping its channel; listeners pull straight away.
  listen(workspace) {
    if (this.channels.has(workspace)) return;
    const channel = this.client
      .channel('terra:' + workspace, { config: { private: true } })
      .on('broadcast', { event: 'pushed' }, () => this.schedule(PULL_DELAY));
    this.channels.set(workspace, channel);
    void this.authRealtime().then(() => {
      if (this.channels.get(workspace) === channel) channel.subscribe();
    });
  }

  // Board and workspace channels are private: the server lets someone join only
  // while they belong to the workspace or a share, judged by the token sent on join.
  async authRealtime() {
    try {
      await this.client.realtime.setAuth();
    } catch {}
  }

  ping(workspace) {
    void this.channels.get(workspace)?.send({ type: 'broadcast', event: 'pushed', payload: {} });
  }

  // The board saves 350 ms after the last change; this short wait gathers what follows.
  localChanged() {
    if (this.workspace) this.schedule(PUSH_DELAY);
  }

  schedule(delay) {
    if (!this.workspace) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  // Run a job while no sync round is in progress; rounds asked for meanwhile follow it.
  async exclusive(job) {
    while (this.running) await this.running.catch(() => {});
    let release;
    this.running = new Promise((resolve) => (release = resolve));
    try {
      return await job();
    } finally {
      this.running = null;
      release();
      if (this.again) {
        this.again = false;
        this.schedule(0);
      }
    }
  }

  async run() {
    if (!this.workspace) return this.status;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          // What this person may still see comes first: copies whose access ended are
          // dropped with their unsent edits, which the server would refuse and so
          // stop every round from reaching this step.
          await this.reconcile();
          if ((await this.call('syncStatus')).rejoin) {
            await this.pull(this.workspace);
            await this.call('syncRejoined');
          }
          const pushed = await this.push();
          // The others pull while this computer does.
          for (const ws of pushed) this.ping(ws);
          await this.pull(this.workspace);
          for (const ws of this.foreign) await this.pull(ws);
        } while (this.again && this.workspace);
        await this.retryFetches();
        await this.retireWhenUploaded().catch(() => {});
        // Access to the open board may have changed: a new role, or none at all.
        void this.rejoin().catch(() => {});
        this.emit({ state: 'synced', ...(await this.local()), lastSync: Date.now(), error: null });
      } catch (e) {
        const local = await this.local().catch(() => ({}));
        this.emit({
          state: offline(e) ? 'offline' : 'error',
          ...local,
          error: offline(e) ? null : String(e.message || e),
        });
        this.schedule(offline(e) ? 15000 : 60000);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async push() {
    const pushed = new Set();
    for (;;) {
      const batch = await this.call('syncTake', { limit: 200 });
      if (!batch.entries.length && !batch.dropped.length) return pushed;
      this.emit({ state: 'syncing', pending: Math.max(this.status.pending, batch.entries.length) });
      for (const a of batch.assets) await this.upload(a);
      const byWorkspace = new Map();
      const add = (workspace, row) => {
        if (!byWorkspace.has(workspace)) byWorkspace.set(workspace, []);
        byWorkspace.get(workspace).push(row);
      };
      for (const a of batch.assets)
        add(a.workspace, {
          kind: 'asset',
          board_id: '',
          id: a.id,
          data: { name: a.name, mime: a.mime, width: a.width, height: a.height, bytes: a.bytes },
          deleted: false,
        });
      for (const { workspace, queued, ...e } of batch.entries) add(workspace, e);
      for (const [workspace, rows] of byWorkspace) {
        for (const part of chunks(rows, 400)) {
          const { error } = await this.client.rpc('push_entities', {
            p_workspace: workspace,
            p_rows: part,
            p_device: this.deviceId,
          });
          fail(error, 'Could not upload changes');
        }
        pushed.add(workspace);
      }
      const local = await this.call('syncAck', {
        entries: batch.entries,
        dropped: batch.dropped,
        assets: batch.assets.map((a) => ({ workspace: a.workspace, id: a.id })),
      });
      this.emit({ pending: local.pending });
    }
  }

  async upload(asset) {
    const bytes = fs.readFileSync(asset.file);
    const { error } = await this.client.storage
      .from('assets')
      .upload(`${asset.workspace}/${asset.id}`, bytes, {
        contentType: asset.mime || 'application/octet-stream',
        upsert: false,
      });
    // Content-addressed: an existing file is already the same bytes.
    if (error && !/exists|duplicate|409/i.test(`${error.message} ${error.statusCode}`))
      fail(error, 'Could not upload a file');
  }

  // Learn what this person shares and what others share with them, then
  // download boards that just became visible and drop ones that did not stay.
  async reconcile() {
    const [mine, withMe] = await Promise.all([
      this.client.rpc('my_shares', { p_workspace: this.workspace }),
      this.client.rpc('shared_with_me'),
    ]);
    fail(mine.error, 'Could not load your shares');
    fail(withMe.error, 'Could not load what is shared with you');
    const shared = mine.data.map((s) => ({
      shareId: s.share_id,
      kind: s.kind,
      targetId: s.target_id,
      people: s.people,
    }));
    await this.call('syncOwned', {
      shares: shared.map((s) => ({ kind: s.kind, targetId: s.targetId, shareId: s.shareId })),
    });
    const sharedWithMe = withMe.data.map((s) => ({
      shareId: s.share_id,
      workspace: s.workspace_id,
      owner: s.owner_name,
      kind: s.kind,
      targetId: s.target_id,
      role: s.role,
      boards: s.boards || [],
    }));
    this.emit({ shared, sharedWithMe });
    this.foreign = [...new Set(sharedWithMe.map((s) => s.workspace))];
    for (const ws of this.foreign) this.listen(ws);
    for (const [ws, channel] of this.channels)
      if (ws !== this.workspace && !this.foreign.includes(ws)) {
        this.channels.delete(ws);
        void this.client.removeChannel(channel);
      }
    const result = await this.call('syncReconcile', {
      shares: sharedWithMe.map((s) => ({
        workspace: s.workspace,
        kind: s.kind,
        targetId: s.targetId,
        role: s.role,
        boards: s.boards,
        owner: s.owner,
      })),
    });
    this.roles = result.roles;
    // The panel loses removed copies now, even if a download below fails.
    if (result.changed) await this.transaction(async () => ({ library: true, boards: [] }));
    for (const group of result.missing) await this.download(group);
  }

  // Everything of the given boards and folders, regardless of the cursor.
  async download({ workspace, boards, folders }) {
    const rows = [];
    const select = () =>
      this.client
        .from('entities')
        .select('kind, board_id, id, data, deleted, seq, updated_by')
        .eq('workspace_id', workspace)
        .eq('deleted', false);
    for (const part of chunks(folders, 100)) {
      const { data, error } = await select().eq('kind', 'folder').in('id', part);
      fail(error, 'Could not download shared folders');
      rows.push(...data);
    }
    for (const part of chunks(boards, 100)) {
      const { data, error } = await select().eq('kind', 'board').in('id', part);
      fail(error, 'Could not download shared boards');
      rows.push(...data);
      for (let from = 0; ; from += 1000) {
        const objects = await select()
          .eq('kind', 'object')
          .in('board_id', part)
          .order('seq')
          .range(from, from + 999);
        fail(objects.error, 'Could not download shared boards');
        rows.push(...objects.data);
        if (objects.data.length < 1000) break;
      }
    }
    if (!rows.length) return;
    await this.fetchAssets(rows, workspace);
    await this.transaction(() =>
      this.call('syncApply', { workspace, rows, cursor: null, roles: this.roles }),
    );
  }

  async pull(workspace) {
    for (;;) {
      const cursor = await this.call('syncCursor', { workspace });
      const { data: rows, error } = await this.client
        .from('entities')
        .select('kind, board_id, id, data, deleted, seq, updated_by, updated_device')
        .eq('workspace_id', workspace)
        .gt('seq', cursor)
        .order('seq')
        .limit(500);
      fail(error, 'Could not download changes');
      if (!rows.length) return;
      const next = rows.at(-1).seq;
      // This computer's own pushes come back too; only changes from elsewhere matter. All
      // computers of an account are one user, so pushes name their device; rows from
      // 0.1.28 computers name only the user.
      const own = (r) =>
        r.updated_by === this.userId && (!r.updated_device || r.updated_device === this.deviceId);
      const remote = rows.filter((r) => !own(r));
      // Rows this computer pushed itself still tell a rejoining library what the server has.
      const seen = rows.filter(own).map((r) => ({ kind: r.kind, board_id: r.board_id, id: r.id }));
      await this.fetchAssets(remote, workspace);
      const content = remote.filter((r) => r.kind !== 'asset');
      const args = { workspace, rows: content, cursor: next, roles: this.roles, seen };
      if (content.length) await this.transaction(() => this.call('syncApply', args));
      else await this.call('syncApply', { ...args, rows: [] });
    }
  }

  // Downloads the files these rows use that this library lacks. A file the server refuses
  // or that cannot be read is remembered and tried again later (retryFetches); the board
  // still opens. Losing the connection stops the round, so the whole pull is retried.
  async fetchAssets(rows, workspace) {
    const needed = new Map(); // file → boards that show it
    for (const r of rows)
      if (!r.deleted)
        for (const id of r.kind === 'asset'
          ? [r.id]
          : referencedAssets(r.kind, r.data, iconAssetId)) {
          if (!needed.has(id)) needed.set(id, new Set());
          const board = r.kind === 'object' ? r.board_id : r.kind === 'board' ? r.id : '';
          if (board) needed.get(id).add(board);
        }
    if (!needed.size) return;
    const missing = await this.call('syncMissingAssets', { ids: [...needed.keys()] });
    if (!missing.length) return;
    const names = new Map(
      rows.filter((r) => r.kind === 'asset').map((r) => [r.id, r.data?.name || 'file']),
    );
    const failed = await this.downloadAssets(workspace, missing, names);
    if (failed.length)
      await this.call('syncFetchFailed', {
        workspace,
        items: failed.flatMap((id) => {
          const boards = [...needed.get(id)];
          return boards.length ? boards.map((boardId) => ({ id, boardId })) : [{ id }];
        }),
      });
  }

  // Downloads and imports files of one workspace; returns the IDs that failed.
  // names: what is known of their file names (the rest are looked up).
  async downloadAssets(workspace, ids, names = new Map(), done = () => {}) {
    const unknown = ids.filter((id) => !names.has(id));
    for (const part of chunks(unknown, 100)) {
      const { data, error } = await this.client
        .from('entities')
        .select('id, data')
        .eq('workspace_id', workspace)
        .eq('kind', 'asset')
        .in('id', part);
      fail(error, 'Could not look up files');
      for (const a of data) names.set(a.id, a.data?.name || 'file');
    }
    const failed = [];
    for (const id of ids) {
      try {
        const { data, error } = await this.client.storage
          .from('assets')
          .download(`${workspace}/${id}`);
        if (error) throw error;
        const bytes = new Uint8Array(await data.arrayBuffer());
        await this.call('syncImportAsset', { bytes, name: names.get(id) || 'file', workspace });
        done(id);
      } catch (e) {
        if (offline(e)) throw e;
        failed.push(id);
      }
    }
    return failed;
  }

  // Files that failed to download before, when their pause is over. Boards that show the
  // ones that arrive are reloaded, so their pictures appear.
  async retryFetches() {
    const due = await this.call('syncFetchDue', { limit: 50 });
    if (!due.length) return;
    const byWorkspace = new Map();
    for (const f of due) {
      if (!byWorkspace.has(f.workspace)) byWorkspace.set(f.workspace, []);
      byWorkspace.get(f.workspace).push(f);
    }
    const arrived = [];
    try {
      for (const [workspace, items] of byWorkspace) {
        const ids = [...new Set(items.map((f) => f.id))];
        const failed = await this.downloadAssets(workspace, ids, new Map(), (id) =>
          arrived.push(id),
        );
        if (failed.length)
          await this.call('syncFetchFailed', {
            workspace,
            items: items.filter((f) => failed.includes(f.id)),
          });
      }
    } finally {
      if (arrived.length) {
        const boards = await this.call('syncFetchDone', { ids: arrived });
        if (boards.length) await this.transaction(async () => ({ library: false, boards }));
      }
    }
  }
}

module.exports = { CloudSync, lookUpLocation };
