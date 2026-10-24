// The renderer's `cloud` API on Android, the same shape as the desktop's
// window.canvas.cloud (preload.cjs). Every call goes to the sync engine in the
// storage worker (cloud-worker.ts).
import type { CloudBridge } from '../bridge';
import { call, onWorker } from './host.ts';

const run = <T = any>(method: string, ...params: unknown[]) => call<T>('cloud', { method, params });
const notOnPhone = () => Promise.reject(Error('Available in the desktop app.'));

export const cloud: CloudBridge = {
  status: () => run('status'),
  enable: (name) => run('enable', name),
  join: (code, name) => run('join', code, name),
  identify: (name) => run('identify', name),
  rename: (name) => run('rename', name),
  setLibrary: (on, name) => run('setLibrary', on, name),
  sharePeople: (kind, id) => run('sharePeople', kind, id),
  invite: (kind, id, role, name) => run('invite', kind, id, role, name),
  setPersonRole: (share, person, role) => run('setPersonRole', share, person, role),
  removePerson: (share, person) => run('removePerson', share, person),
  setBoardAccess: (boardId, person, role) => run('setBoardAccess', boardId, person, role),
  stopSharing: (share) => run('stopSharing', share),
  removeFromCloud: (boardId) => run('removeFromCloud', boardId),
  upload: (kind, id, name) => run('uploadToCloud', kind, id, name),
  leave: (share) => run('leave', share),
  profile: () => run('profile'),
  setAvatar: (asset) => run('setAvatar', asset),
  setSong: (asset, name) => run('setSong', asset, name),
  setPublishSong: (on) => run('setPublishSong', on),
  profileMedia: (person, avatar, song) => run('profileMedia', person, avatar, song),
  joinBoard: (boardId) => run('joinBoard', boardId),
  leaveBoard: () => run('leaveBoard'),
  sendCursor: (data) => void run('sendCursor', data).catch(() => {}),
  onPresence: (callback) => onWorker('presence', callback),
  // A phone stays in its workspace until it signs out (signOut below).
  disable: notOnPhone,
  devices: () => run('devices'),
  removeDevice: (id) => run('removeDevice', id),
  syncNow: () => run('syncNow'),
  sendCode: (email) => run('sendEmailCode', email),
  verifyCode: (email, code) => run('verifyEmailCode', email, code),
  signInWith: (provider) => run('signInWithProvider', provider),
  cancelSignIn: () => run('cancelSignIn'),
  signInMethods: () => run('signInMethods'),
  // Deletes the account and its cloud data, then this phone's library; the app reloads.
  deleteCloudData: () => run('deleteCloudData'),
  serverTest: notOnPhone,
  serverSet: notOnPhone,
  onDeepLink: () => () => {},
  onStatus: (callback) => onWorker('status', callback),
  // Signs out and deletes this phone's library; the app reloads.
  signOut: () => run('signOut'),
};

// For accounts with a password: the app-store review account (cloud-auth.cjs).
export const signInWithPassword = (email: string, password: string) =>
  run('signInWithPassword', email, password);

// The terraboard://auth/callback link back from Google or Microsoft.
export const finishOAuth = (url: string) => run<boolean>('finishOAuth', url);
