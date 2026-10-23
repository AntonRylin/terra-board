import type { Asset, Board, CanvasObject } from './model';
import type { RecognizedText } from './canvas/recognized-text';
import * as mobile from './mobile/platform';
export interface McpStatus {
  enabled: boolean;
  running: boolean;
  url: string;
  port: number;
  error: string | null;
  codexConfig: string;
  claudeConfig: string;
}
export type ShareRole = 'view' | 'edit';
export interface OwnShare {
  shareId: string;
  kind: 'folder' | 'board';
  targetId: string;
  people: number;
}
export interface ReceivedShare {
  shareId: string;
  workspace: string;
  owner: string;
  kind: 'folder' | 'board';
  targetId: string;
  role: ShareRole;
  boards: string[];
}
export interface CloudServer {
  name: string;
  kind: 'terra' | 'custom' | 'dev';
  locked: boolean;
  address: string | null;
}
export interface ServerPreview {
  name: string;
  host: string;
  billing: boolean;
}
export type ServerInput = { address: string } | { url: string; key: string };
export interface CloudStatus {
  configured: boolean;
  server: CloudServer | null;
  state: 'off' | 'syncing' | 'synced' | 'offline' | 'error';
  identity: boolean;
  library: boolean;
  name: string;
  pending: number;
  lastSync: number | null;
  error: string | null;
  workspace?: string | null;
  shared: OwnShare[];
  sharedWithMe: ReceivedShare[];
  profile?: CloudProfile;
  account: CloudAccount;
  /** The sign-in methods this server offers; null until known. */
  methods: SignInMethods | null;
  /** A browser sign-in waiting for its callback. */
  waiting: SignInProvider | null;
}
export type SignInProvider = 'google' | 'microsoft';
export interface SignInMethods {
  email: boolean;
  google: boolean;
  microsoft: boolean;
}
/** 'anonymous': a computer set up by Terra Board 0.1.28, before accounts. */
export interface CloudAccount {
  state: 'signedOut' | 'anonymous' | 'signedIn';
  userId?: string;
  email?: string | null;
  name?: string | null;
  provider?: string | null;
}
export interface CloudProfile {
  avatar: string | null;
  avatarVersion: number;
  song: string | null;
  songName: string;
  songVersion: number;
  publishSong: boolean;
}
export type ViewRect = { x: number; y: number; width: number; height: number };
export interface PresencePerson {
  key: string;
  person: string;
  name: string;
  avatar: number;
  song: number;
  songName?: string;
  device?: string;
  role: 'view' | 'edit';
  joined: number;
}
export type PresenceEvent =
  | {
      type: 'people';
      boardId: string;
      self: string;
      owner?: boolean;
      people: PresencePerson[];
    }
  | { type: 'cursor'; boardId: string; key: string; x: number; y: number; view: ViewRect };
export interface SharePerson {
  id: string;
  name: string;
  role: ShareRole;
}
export type LivePermission = 'view' | 'edit';
export interface LiveStatus {
  active: boolean;
  boardId?: string;
  permission?: LivePermission;
  ask?: boolean;
  port?: number;
  links?: { label: string; url: string }[];
  guests?: { id: string; name: string; permission: LivePermission; online: boolean }[];
  requests?: { id: string; name: string }[];
}
export interface CloudDevice {
  id: string;
  name: string;
  version: string | null;
  lastSeen: string;
  current: boolean;
}
export interface AppInfo {
  version: string;
  libraryPath: string;
  backupsPath: string;
  loginItemSupported: boolean;
  openAtLogin: boolean;
}
export interface UpdateStatus {
  /** This build can download and install updates itself (the installed copy). */
  supported: boolean;
  /** This build checks GitHub for a newer version, installed or not. */
  notify?: boolean;
  /** Checks on its own after launch and every few hours (Settings → About). */
  automatic?: boolean;
  /** 'available': a newer version exists that this build cannot install itself. */
  state: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
  version: string;
  /** Newer version published on GitHub, when there is one. */
  latest?: string;
  /** Release page of the newer version (the latest release until one is found). */
  page?: string;
  /** Installer of the newer version, for builds that cannot install it themselves. */
  download?: string;
  available?: string;
  percent?: number;
  checkedAt?: number;
  error?: string;
}
/** An optional part listed in Settings → Extensions (electron/extensions.cjs). */
// Import from Miro (electron/miro-import.cjs).
export interface MiroBoard {
  id: string;
  name: string;
  modifiedAt?: string;
  team?: string;
}
export interface MiroSkipped {
  drawings: number;
  arrows: number;
  images: number;
  other: number;
}
export type MiroResult =
  | { id: string; board: Board; objects: number; skipped: MiroSkipped; error?: undefined }
  | { id: string; error: string; board?: undefined };
export interface MiroProgress {
  board: string;
  phase: 'reading' | 'images' | 'saving';
  done?: number;
  total?: number;
  index: number;
  count: number;
}
export interface ExtensionStatus {
  id: string;
  name: string;
  description: string;
  version: string;
  state: 'available' | 'installing' | 'installed';
  /** Download size; approximate for LibreOffice. */
  downloadBytes: number;
  /** Space used on this PC, once installed. */
  installedBytes?: number;
  /** Installed, but this version of Terra Board has a newer one. */
  outdated?: boolean;
  progress?: { received: number; total: number; label?: string };
  /** Provided by Windows (a LibreOffice in Program Files): nothing to remove. */
  system?: boolean;
  /** Can't be installed on this system (Office files on Linux); says what to do instead. */
  unavailable?: string;
  error?: string;
  notice?: string;
}
interface DesktopBridge {
  assetDimensions(id: string): Promise<{ width: number; height: number }>;
  exportImage(args: {
    format: 'png' | 'jpg' | 'pdf';
    name: string;
    bytes: Uint8Array;
  }): Promise<{ id: string; name: string } | null>;
  downloadAsset(args: { id: string; name: string }): Promise<boolean>;
  printDocument(args: { html: string; name: string }): Promise<Asset>;
  convertOffice(args: { id: string; name: string }): Promise<Asset>;
  onOfficeProgress(callback: (message: string) => void): () => void;
  openExport(id: string, folder: boolean): Promise<void>;
  copyExport(id: string): Promise<void>;
  copyObjects(objects: CanvasObject[]): Promise<boolean>;
  copyText(text: string): Promise<void>;
  // The audio of a song link (YouTube and other sites), for an entrance song.
  songFromLink(url: string): Promise<{ bytes: Uint8Array; name: string }>;
  /** Windows (its OCR engine) and Linux with Tesseract installed; absent elsewhere. */
  recognizeAsset?(id: string): Promise<RecognizedText>;
  recognizeImage?(bytes: Uint8Array): Promise<RecognizedText>;
  /** The desktop's operating system, as Node's process.platform ('win32', 'linux'). */
  platform: string;
  cancelCopy(): void;
  clipboardObjects(): Promise<CanvasObject[] | null>;
  fullscreenState(): Promise<boolean>;
  toggleFullscreen(): Promise<void>;
  onFullscreenChange(callback: (fullscreen: boolean) => void): () => void;
  mcpStatus(): Promise<McpStatus>;
  mcpUpdate(patch: { enabled: boolean; port?: number }): Promise<McpStatus>;
  onMcpSync(
    callback: (message: {
      id: number;
      phase: 'prepare' | 'finish';
      change?: string;
      idBoard?: string;
      boards?: string[];
      source?: 'ai' | 'cloud' | 'guest';
    }) => void,
  ): () => void;
  mcpReady(id: number, error?: string): void;
  invoke(command: string, args?: unknown): Promise<any>;
  pickMedia(): Promise<Asset[]>;
  importAlbumFiles(args: { paths?: string[]; link: boolean }): Promise<Asset[]>;
  locateAsset(args: { id: string; name: string }): Promise<AssetLink | null>;
  filePath(file: File): string;
  importPortable(): Promise<Board | null>;
  miro: {
    status(): Promise<{ saved: boolean; canRemember: boolean }>;
    connect(token: string, remember: boolean): Promise<MiroBoard[]>;
    boards(): Promise<MiroBoard[]>;
    add(link: string): Promise<{ id: string; boards: MiroBoard[] }>;
    forget(): Promise<boolean>;
    import(ids: string[]): Promise<MiroResult[]>;
    onProgress(callback: (progress: MiroProgress) => void): () => void;
  };
  exportPortable(id: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  linkPreview(url: string): Promise<{
    text: string;
    linkDescription: string;
    assetId?: string;
    linkIconId?: string;
  } | null>;
  // An HTML embed's page, served from its own sandboxed origin.
  htmlPage(html: string): Promise<string>;
  // Captures an HTML embed at a CSS size; returns the picture's asset ID.
  htmlSnapshot(args: { html: string; width: number; height: number }): Promise<string>;
  // Captures a website offscreen, in the browser frames' session.
  browserSnapshot(args: { url: string; width: number; height: number }): Promise<string>;
  // Captures a running browser frame by its <webview>'s WebContents ID.
  browserCapture(id: number): Promise<string>;
  dataDirectory(): Promise<string>;
  appInfo(): Promise<AppInfo>;
  setOpenAtLogin(enabled: boolean): Promise<boolean>;
  openFolder(which: 'library' | 'backups'): Promise<void>;
  exportLibrary(): Promise<{ count: number; folder: string } | null>;
  licenses(): Promise<{ name: string; version: string; license: string }[]>;
  extensions: {
    list(): Promise<ExtensionStatus[]>;
    install(id: string): Promise<void>;
    cancel(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    onChange(callback: (list: ExtensionStatus[]) => void): () => void;
  };
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    setAutomatic(on: boolean): Promise<UpdateStatus>;
    install(): Promise<boolean>;
    onStatus(callback: (status: UpdateStatus) => void): () => void;
  };
  setFullscreenKeys(
    bindings: { code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }[],
  ): void;
  live: {
    status(): Promise<LiveStatus>;
    start(options: {
      boardId: string;
      permission: LivePermission;
      ask: boolean;
    }): Promise<LiveStatus>;
    stop(): Promise<LiveStatus>;
    configure(options: { permission?: LivePermission; ask?: boolean }): Promise<LiveStatus>;
    answer(id: string, allow: boolean, permission?: LivePermission): Promise<LiveStatus>;
    setGuestPermission(id: string, permission: LivePermission): Promise<LiveStatus>;
    removeGuest(id: string): Promise<LiveStatus>;
    onStatus(callback: (status: LiveStatus) => void): () => void;
  };
  cloud: {
    status(): Promise<CloudStatus>;
    enable(name?: string): Promise<CloudStatus>;
    join(code: string, name?: string): Promise<CloudStatus>;
    identify(name: string): Promise<CloudStatus>;
    rename(name: string): Promise<CloudStatus>;
    setLibrary(on: boolean, name?: string): Promise<CloudStatus>;
    sharePeople(
      kind: 'folder' | 'board',
      id: string,
    ): Promise<{ shareId: string | null; people: SharePerson[] }>;
    invite(kind: 'folder' | 'board', id: string, role: ShareRole, name?: string): Promise<string>;
    setPersonRole(share: string, person: string, role: ShareRole): Promise<void>;
    removePerson(share: string, person: string): Promise<void>;
    setBoardAccess(boardId: string, person: string, role: ShareRole | null): Promise<void>;
    stopSharing(share: string): Promise<void>;
    removeFromCloud(boardId: string): Promise<void>;
    leave(share: string): Promise<void>;
    profile(): Promise<CloudProfile>;
    setAvatar(asset: string | null): Promise<CloudProfile>;
    setSong(asset: string | null, name?: string): Promise<CloudProfile>;
    setPublishSong(on: boolean): Promise<CloudProfile>;
    profileMedia(
      person: string,
      avatar: number,
      song: number,
    ): Promise<{ avatar: string | null; song: string | null }>;
    joinBoard(boardId: string): Promise<{ active: boolean; shared?: boolean }>;
    leaveBoard(): Promise<void>;
    sendCursor(data: { x: number; y: number; view: ViewRect }): void;
    onPresence(callback: (event: PresenceEvent) => void): () => void;
    disable(): Promise<CloudStatus>;
    devices(): Promise<CloudDevice[]>;
    removeDevice(id: string): Promise<void>;
    syncNow(): Promise<CloudStatus>;
    sendCode(email: string): Promise<{ email: string }>;
    verifyCode(email: string, code: string): Promise<CloudStatus>;
    signInWith(provider: SignInProvider): Promise<CloudStatus>;
    cancelSignIn(): Promise<CloudStatus>;
    signOut(): Promise<CloudStatus>;
    /** Removes the cloud library, its files and shares, and the sign-in. */
    deleteCloudData(): Promise<{ userDeleted: boolean }>;
    signInMethods(): Promise<CloudStatus>;
    serverTest(input: ServerInput): Promise<ServerPreview>;
    serverSet(
      input: ServerInput | { terra: true },
      options?: { turnOffSync?: boolean },
    ): Promise<CloudStatus>;
    onDeepLink(callback: (link: { kind: 'connect'; address: string }) => void): () => void;
    onStatus(callback: (status: CloudStatus) => void): () => void;
  };
  onClose(callback: () => void): () => void;
  closeReady(): void;
  rendererReady(): void;
}
declare global {
  interface Window {
    canvas?: DesktopBridge;
  }
}
export const desktop = !!window.canvas;
// The Android app (Capacitor): storage runs in a worker, see docs/android.md.
export const android = mobile.isAndroid;
function base64(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
export async function invoke<T = any>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (window.canvas) return window.canvas.invoke(command, args);
  if (android) return mobile.call<T>(command, args);
  const input = { ...args };
  if (input.bytes) input.bytes = base64(new Uint8Array(input.bytes as ArrayBuffer));
  const response = await fetch('/__local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args: input }),
  });
  const data = await response.json();
  if (data.error) throw Error(data.error);
  return data.result;
}
export const mediaUrl = (id: string, variant = 'preview') =>
  desktop ? `canvas-media://asset/${id}/${variant}` : `/__local/asset/${id}/${variant}`;
export async function assetDimensions(id: string) {
  if (window.canvas) return window.canvas.assetDimensions(id);
  const img = new Image();
  img.src = mediaUrl(id, 'export');
  await img.decode();
  return { width: img.naturalWidth, height: img.naturalHeight };
}
export async function importFiles(files: File[]) {
  const result: Asset[] = [];
  for (const file of files) {
    if (file.size > 256 * 1024 * 1024) throw Error(`${file.name} exceeds 256 MB`);
    result.push(
      await invoke<Asset>('importAsset', { bytes: await file.arrayBuffer(), name: file.name }),
    );
  }
  return result;
}
export function chooseFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files || [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}
export async function pickMedia() {
  return window.canvas ? window.canvas.pickMedia() : importFiles(await chooseFiles('', true));
}
// A linked album image: its original stays at `path` on this computer.
export interface AssetLink {
  id: string;
  path: string;
  state: 'ok' | 'missing' | 'changed';
}
// Images for an album, in order. Linking needs the desktop app and a file
// with a place on disk; anything else (the browser harness, an image dragged
// from a web page) is copied, and `copied` counts those that wanted a link.
export async function importAlbumFiles(
  files: File[] | null,
  link: boolean,
): Promise<{ assets: Asset[]; copied: number }> {
  if (window.canvas && !files)
    return { assets: await window.canvas.importAlbumFiles({ link }), copied: 0 };
  const assets: Asset[] = [];
  let copied = 0;
  for (const file of files || (await chooseFiles('image/*', true))) {
    const path = window.canvas?.filePath(file);
    if (path) assets.push(...(await window.canvas!.importAlbumFiles({ paths: [path], link })));
    else {
      if (link) copied++;
      assets.push(...(await importFiles([file])));
    }
  }
  return { assets, copied };
}
export const assetLinks = (ids: string[]) =>
  ids.length ? invoke<AssetLink[]>('assetLinks', { ids }) : Promise.resolve([]);
export const boardSyncs = (id: string) => invoke<boolean>('boardSyncs', { id });
export type AssetInfo = Asset & { linkedPath?: string };
export const assetInfo = (id: string) => invoke<AssetInfo>('assetInfo', { id });
export interface BoardInfo {
  created: number | null;
  updated: number;
  objects: number;
  contentBytes: number;
  files: number;
  fileBytes: number;
  linkedFiles: number;
}
export const boardInfo = (id: string) => invoke<BoardInfo>('boardInfo', { id });
export async function importPortable() {
  if (window.canvas) return window.canvas.importPortable();
  const [file] = await chooseFiles('.canvas');
  return file ? invoke<Board>('importBoard', { bytes: await file.arrayBuffer() }) : null;
}
export async function exportPortable(id: string) {
  if (window.canvas) return window.canvas.exportPortable(id);
  if (android) {
    const bytes = await invoke<Uint8Array>('exportBoard', { id });
    const board = (await invoke<{ boards: { id: string; name: string }[] }>('library')).boards.find(
      (b) => b.id === id,
    );
    await mobile.saveFile(new Blob([bytes as BlobPart]), (board?.name || 'Board') + '.canvas');
    return true;
  }
  const data = await invoke<string>('exportBoard', { id });
  download(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]), 'Board.canvas');
  return true;
}
export function download(blob: Blob, name: string) {
  if (android) {
    void mobile.saveFile(blob, name).catch((e) => console.error(e));
    return;
  }
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function downloadAsset(id: string, name: string): Promise<boolean> {
  if (window.canvas) return window.canvas.downloadAsset({ id, name });
  const response = await fetch(mediaUrl(id, 'original'));
  if (!response.ok) throw Error('Could not download this file');
  if (android) await mobile.saveFile(await response.blob(), name);
  else download(await response.blob(), name);
  return true;
}
export async function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) throw Error('Only web links can be opened');
  if (window.canvas) await window.canvas.openExternal(url);
  else if (android) await mobile.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
