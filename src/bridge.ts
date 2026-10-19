import type { Asset, Board, CanvasObject } from './model';
import type { RecognizedText } from './canvas/recognized-text';
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
export interface CloudStatus {
  configured: boolean;
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
  joined: string;
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
  recognizeAsset(id: string): Promise<RecognizedText>;
  recognizeImage(bytes: Uint8Array): Promise<RecognizedText>;
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
  importPortable(): Promise<Board | null>;
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
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
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
    pairingCode(): Promise<string>;
    devices(): Promise<CloudDevice[]>;
    removeDevice(id: string): Promise<void>;
    syncNow(): Promise<CloudStatus>;
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
export async function importPortable() {
  if (window.canvas) return window.canvas.importPortable();
  const [file] = await chooseFiles('.canvas');
  return file ? invoke<Board>('importBoard', { bytes: await file.arrayBuffer() }) : null;
}
export async function exportPortable(id: string) {
  if (window.canvas) return window.canvas.exportPortable(id);
  const data = await invoke<string>('exportBoard', { id });
  download(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]), 'Board.canvas');
  return true;
}
export function download(blob: Blob, name: string) {
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
  download(await response.blob(), name);
  return true;
}
export async function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) throw Error('Only web links can be opened');
  if (window.canvas) await window.canvas.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
