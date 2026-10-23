// Terra Cloud on Android: electron/cloud-sync.cjs, unchanged, inside the storage
// worker. This file does what electron/main.cjs does on desktop: it gives the
// sync engine the store, asks the page to pause the board around changes from
// the cloud (the "external transaction"), and forwards status and presence.
import { CloudSync } from '../../electron/cloud-sync.cjs';
import { terraCloud } from '../../electron/cloud-config.cjs';
import { terraCloud as server, version } from '../../package.json';

type Post = (message: Record<string, unknown>) => void;
type Queue = <T>(job: () => T | Promise<T>) => Promise<T>;

// What the page may ask of the sync engine (the desktop's canvas:cloud-* calls).
const methods = new Set([
  'status',
  'join',
  'enable',
  'identify',
  'rename',
  'setLibrary',
  'sharePeople',
  'invite',
  'setPersonRole',
  'removePerson',
  'setBoardAccess',
  'stopSharing',
  'removeFromCloud',
  'leave',
  'profile',
  'setAvatar',
  'setSong',
  'setPublishSong',
  'profileMedia',
  'joinBoard',
  'leaveBoard',
  'sendCursor',
  'pairingCode',
  'devices',
  'removeDevice',
  'syncNow',
  'sendEmailCode',
  'verifyEmailCode',
  'signInWithPassword',
  'signInWithProvider',
  'cancelSignIn',
  'signInMethods',
  'finishOAuth',
  'signOut',
  'deleteCloudData',
]);

export function startCloud({
  store,
  queue,
  post,
  root,
  wipe,
}: {
  store: any;
  queue: Queue;
  // Also how the page is asked to open a sign-in page (a Custom Tab): workers can't.
  post: Post;
  root: string;
  // Deletes the whole library on this phone (signing out); the page reloads after.
  wipe: () => Promise<void>;
}) {
  // Sync goes through the same queue as the page's commands, so the two never interleave.
  const call = (command: string, args?: unknown) => queue(() => store[command](args));

  // The page pauses the board (prepare), the job runs, the page reloads what changed (finish).
  let nextId = 0;
  const waiters = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  const askPage = (phase: 'prepare' | 'finish', detail: Record<string, unknown>) =>
    new Promise<void>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(Error('Board is busy. Retry when saving completes.'));
      }, 30000);
      waiters.set(id, {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      post({ type: 'external', id, phase, ...detail });
    });
  let tail: Promise<unknown> = Promise.resolve();
  const transaction = (job: () => Promise<any>) => {
    const run = async () => {
      let result: any;
      try {
        await askPage('prepare', { source: 'cloud' });
        result = await job();
        return result;
      } finally {
        await askPage('finish', {
          change: result?.boards?.length ? 'content' : result?.library ? 'library' : 'none',
          boards: result?.boards || [],
          source: 'cloud',
        });
      }
    };
    const next = tail.then(run, run);
    tail = next.catch(() => {});
    return next;
  };

  const config = terraCloud({ terraCloud: server });
  const cloud = new CloudSync({
    call,
    root,
    config,
    server: config && { name: config.name, kind: config.kind, locked: true, address: null },
    legacyServerUrl: config?.url,
    safeStorage: null,
    transaction,
    appVersion: version,
    redirectTo: 'terraboard://auth/callback',
    // supabase-js's own createClient (PKCE, the fs session file) works in the worker as it is.
    createSupabaseClient: undefined,
    // Google and Microsoft sign-in, in the system browser; it comes back through the
    // terraboard://auth/callback link (finishOAuth).
    openUrl: (url: string) => {
      if (new URL(url).protocol !== 'https:')
        throw Error('Only secure sign-in pages can be opened');
      post({ type: 'open-url', url });
    },
    onStatus: (status: unknown) => post({ type: 'cloud-status', status }),
    onPresence: (event: unknown) => post({ type: 'presence', event }),
  });

  // A phone joined with a pairing code knows its workspace but not the name the
  // computer gave it; without one, people on a shared board would see "Someone".
  async function learnName() {
    const local = await cloud.local();
    if (!local.identity || local.name || !cloud.client) return;
    const { data } = await cloud.client.rpc('my_profile', { p_workspace: local.workspace });
    const name = data?.[0]?.display_name;
    if (name) cloud.emit(await call('syncRename', { name }).then(() => cloud.local()));
  }

  const extra: Record<string, (...params: any[]) => unknown> = {
    status: () => cloud.status,
    // A claim that did not finish (offline after signing in) is retried by a fresh start.
    syncNow: () => (cloud.claimWaiting() ? cloud.start() : cloud.run()).then(() => cloud.status),
    signInMethods: () => cloud.loadMethods().then(() => cloud.status),
    async join(code: string, name?: string) {
      const status = await cloud.join(code, name);
      void learnName().catch(() => {});
      return status;
    },
    // Signing out of a phone signs out of the account (this phone leaves its device
    // list) and deletes its copy of the library: the next person to sign in must not see
    // it, and nothing local-only is left behind (the boards live in the cloud).
    async signOut() {
      const status = await cloud.signOut();
      cloud.stop();
      await wipe();
      return status;
    },
    // Deleting the account (Google Play requires it in the app) also clears the phone.
    async deleteCloudData() {
      const result = await cloud.deleteCloudData();
      cloud.stop();
      await wipe();
      return result;
    },
  };

  const ready = cloud
    .start()
    .then(() => learnName())
    .catch((e: any) => cloud.emit({ state: 'error', error: String(e?.message || e) }));

  return {
    // After a write that the cloud should hear about (main.cjs's syncedCommands).
    localChanged: () => cloud.localChanged(),
    pageReady(id: number, error?: string) {
      const waiter = waiters.get(id);
      if (!waiter) return;
      waiters.delete(id);
      if (error) waiter.reject(Error(error));
      else waiter.resolve();
    },
    async run(method: string, params: unknown[]) {
      if (!methods.has(method)) throw Error('Unknown cloud command');
      if (method !== 'status') await ready;
      const handler = extra[method] ?? (cloud as any)[method].bind(cloud);
      return handler(...params);
    },
  };
}
