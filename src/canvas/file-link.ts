// Board objects of type 'file': a live link to a folder or a file on this
// computer. A folder shows as a window-like frame listing what is in it; a file
// or app shows as a desktop icon. Boards keep only which item to show and how;
// what a folder holds is read live (electron/local-files.cjs) and never saved,
// exported or synced.
import type { Asset, CanvasObject } from '../model';

export const fileRoots = [
  'desktop',
  'downloads',
  'documents',
  'pictures',
  'music',
  'videos',
  'home',
] as const;
export type FileRoot = (typeof fileRoots)[number];
export const fileRootLabels: Record<FileRoot, string> = {
  desktop: 'Desktop',
  downloads: 'Downloads',
  documents: 'Documents',
  pictures: 'Pictures',
  music: 'Music',
  videos: 'Videos',
  home: 'Home',
};
export const fileViews = ['icons', 'list'] as const;
export const fileIconSizes = ['small', 'medium', 'large', 'huge'] as const;
export const fileSorts = ['name', 'modified', 'type', 'size'] as const;
export type FileView = (typeof fileViews)[number];
export type FileIconSize = (typeof fileIconSizes)[number];
export type FileSort = (typeof fileSorts)[number];

export interface FileLink {
  // A folder every computer has; `path` is then relative to it ('' for itself),
  // so the same board shows that folder on each of the person's computers.
  root?: FileRoot;
  // Otherwise the full path on the computer where it was added.
  path: string;
  // What it was when added; decides the placeholder where it can't be read.
  kind: 'folder' | 'file';
  view?: FileView;
  iconSize?: FileIconSize;
  sort?: FileSort;
  descending?: boolean;
  // Show hidden and system items.
  hidden?: boolean;
}

// Keep equal to fileLinkValue in electron/store.cjs (a test compares them).
export function fileLinkValue(input: unknown): FileLink {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid file link');
  const { root, path, kind, view, iconSize, sort, descending, hidden } = value;
  if (root !== undefined && !(fileRoots as readonly unknown[]).includes(root))
    throw Error('Invalid file link folder');
  if (typeof path !== 'string' || path.length > 4096 || /[\x00-\x1f]/.test(path))
    throw Error('Invalid file link path');
  if (root !== undefined) {
    if (/^([a-z]:|[\\/])/i.test(path) || path.split(/[\\/]+/).some((p) => p === '..' || p === '.'))
      throw Error('Invalid file link path');
  } else if (!/^([a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/i.test(path))
    throw Error('Invalid file link path');
  if (kind !== 'folder' && kind !== 'file') throw Error('Invalid file link kind');
  const pick = <T extends string>(v: unknown, options: readonly T[]) =>
    options.includes(v as T) ? (v as T) : undefined;
  const result: FileLink = { path, kind };
  if (root !== undefined) result.root = root as FileRoot;
  const v = pick(view, fileViews),
    size = pick(iconSize, fileIconSizes),
    order = pick(sort, fileSorts);
  if (v) result.view = v;
  if (size) result.iconSize = size;
  if (order) result.sort = order;
  if (descending === true) result.descending = true;
  if (hidden === true) result.hidden = true;
  return result;
}

// One entry of a folder as electron/local-files.cjs lists it.
export interface FileItem {
  name: string;
  path: string;
  folder: boolean;
  size: number | null;
  modified: number;
  hidden: boolean;
  // Kept online only (OneDrive and other cloud folders).
  cloud?: boolean;
  shortcut?: boolean;
  app?: boolean;
  // From the Desktop every user of this computer shares.
  shared?: boolean;
}
export type FileListing =
  | {
      state: 'folder';
      dir: string;
      // The frame's own folder, where Up stops showing a parent.
      base: string;
      dirs: string[];
      label: string;
      parent: string | null;
      items: FileItem[];
      total: number;
      hiddenCount: number;
      hideExtensions: boolean;
    }
  | { state: 'file'; dir: string; label: string; item: FileItem; hideExtensions: boolean }
  | { state: 'missing'; dir: string; label: string; message: string };
export type FileOp = {
  op: 'move' | 'copy' | 'link' | 'rename' | 'create';
  from?: string;
  to: string;
};
export interface FileResult {
  ops: FileOp[];
  errors: string[];
}
export interface FileSource {
  root?: FileRoot;
  path: string;
}
export interface DroppedPath {
  path: string;
  name: string;
  kind: 'folder' | 'shortcut' | 'app' | 'file';
  source: FileSource;
}
export interface FilesBridge {
  list(args: { source: FileSource; sub?: string; hidden?: boolean }): Promise<FileListing>;
  icons(requests: { path: string; size: number; modified: number }[]): Promise<(string | null)[]>;
  transfer(args: {
    paths: string[];
    target: string;
    mode: 'auto' | 'copy' | 'move' | 'link';
  }): Promise<FileResult>;
  rename(args: { path: string; name: string }): Promise<FileResult>;
  newFolder(args: { dir: string }): Promise<FileResult>;
  trash(args: { paths: string[] }): Promise<{ done: number; errors: string[] }>;
  revert(args: { ops: FileOp[] }): Promise<{ errors: string[] }>;
  saveAssets(args: { target: string; items: { id: string; name?: string }[] }): Promise<FileResult>;
  classify(args: { paths: string[] }): Promise<DroppedPath[]>;
  import(args: { paths: string[] }): Promise<{ assets: Asset[]; errors: string[] }>;
  open(args: { path: string }): Promise<void>;
  openWith(args: { app: string; paths: string[] }): Promise<FileResult>;
  reveal(args: { path: string }): Promise<void>;
  copy(args: { paths: string[]; cut: boolean }): Promise<void>;
  readClipboard(): Promise<{ paths: string[]; cut: boolean } | null>;
  clearClipboard(): Promise<void>;
  choose(args: { defaultPath?: string }): Promise<{ path: string; source: FileSource } | null>;
  source(args: { path: string }): Promise<FileSource>;
  watch(args: { key: string; dirs: string[] }): Promise<void>;
  unwatch(args: { key: string }): Promise<void>;
  reset(): Promise<void>;
  drag(paths: string[], icon?: string): void;
  onChange(callback: (dir: string) => void): () => void;
}

// Layout at scale 1, in board units: icon, cell width and cell height.
export const iconLayouts: Record<FileIconSize, { icon: number; cell: number; row: number }> = {
  small: { icon: 32, cell: 84, row: 78 },
  medium: { icon: 56, cell: 104, row: 106 },
  large: { icon: 96, cell: 140, row: 150 },
  huge: { icon: 160, cell: 200, row: 216 },
};
export const listRow = 30;
export const folderHeader = 48;
export const folderFooter = 26;
export const folderSize = { width: 760, height: 500 };
export const fileTileSize = { width: 112, height: 132 };
export const folderMinimum = { width: 240, height: 160 };

export const isFileObject = (o: CanvasObject) => o.type === 'file' && !!o.file;
export const isFolderObject = (o: CanvasObject) => o.type === 'file' && o.file?.kind === 'folder';

export function fileLinkLabel(link: FileLink, fallback?: string) {
  if (fallback) return fallback;
  const parts = link.path.split(/[\\/]+/).filter(Boolean);
  if (link.root && !parts.length) return fileRootLabels[link.root];
  return parts[parts.length - 1] || link.path;
}

// What a list shows as the name: shortcuts never show .lnk/.url, other
// extensions follow the Windows "File name extensions" setting.
export function displayName(item: FileItem, hideExtensions: boolean) {
  if (item.folder) return item.name;
  const dot = item.name.lastIndexOf('.');
  if (dot <= 0) return item.name;
  const ext = item.name.slice(dot).toLowerCase();
  if (item.shortcut && ext !== '.desktop') return item.name.slice(0, dot);
  return hideExtensions ? item.name.slice(0, dot) : item.name;
}
export function extensionOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
export function typeLabel(item: FileItem) {
  if (item.folder) return 'File folder';
  if (item.shortcut) return 'Shortcut';
  if (item.app) return 'Application';
  const ext = extensionOf(item.name);
  return ext ? ext.toUpperCase() + ' File' : 'File';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// Folders first, then by the chosen order; names break ties, as in Explorer.
export function sortItems(items: FileItem[], sort: FileSort = 'name', descending = false) {
  const direction = descending ? -1 : 1;
  return [...items].sort((a, b) => {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    let order = 0;
    if (sort === 'modified') order = a.modified - b.modified;
    else if (sort === 'size') order = (a.size ?? 0) - (b.size ?? 0);
    else if (sort === 'type') order = collator.compare(typeLabel(a), typeLabel(b));
    return (order || collator.compare(a.name, b.name)) * direction;
  });
}

export function formatSize(bytes: number | null) {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const formatDate = (ms: number) => dateFormat.format(new Date(ms));

// The icon size to ask Windows for: what the icon covers on screen, rounded up.
export function iconTier(screenPixels: number) {
  return screenPixels <= 32 ? 32 : screenPixels <= 64 ? 64 : screenPixels <= 128 ? 128 : 256;
}

// What to do with items dropped on a folder: Windows' keys (Ctrl copies,
// Shift moves, Alt makes shortcuts); otherwise move on the same drive and
// copy across drives.
export function dropMode(event: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  if (event.altKey) return 'link' as const;
  if (event.ctrlKey && !event.shiftKey) return 'copy' as const;
  if (event.shiftKey && !event.ctrlKey) return 'move' as const;
  if (event.ctrlKey && event.shiftKey) return 'link' as const;
  return 'auto' as const;
}

// Exports, linked frames and pins draw a placeholder: the name and a folder
// or file picture, never what the folder holds.
export function drawFilePlaceholder(o: CanvasObject, resolution: number, dark: boolean) {
  const scale = Math.max(0.05, Math.min(resolution, 4096 / Math.max(o.width, o.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(o.width * scale));
  canvas.height = Math.max(1, Math.round(o.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  const folder = o.file?.kind !== 'file';
  const ink = dark ? '#e6ebf2' : '#29313b';
  const name = o.file ? fileLinkLabel(o.file, o.text) : o.text || 'Folder';
  if (folder) {
    ctx.fillStyle = dark ? '#1f2630' : '#ffffff';
    ctx.strokeStyle = dark ? '#3a4656' : '#d9e0ea';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, o.width - 1, o.height - 1, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = `600 16px 'Segoe UI', sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 52, folderHeader / 2, Math.max(10, o.width - 70));
    drawFolderGlyph(ctx, 16, folderHeader / 2 - 11, 26);
    const size = Math.min(o.width, o.height - folderHeader) * 0.32;
    if (size > 24)
      drawFolderGlyph(
        ctx,
        (o.width - size) / 2,
        folderHeader + (o.height - folderHeader - size) / 2,
        size,
        0.35,
      );
  } else {
    const size = Math.min(o.width * 0.6, o.height - 40);
    drawFileGlyph(ctx, (o.width - size) / 2, 8, size);
    ctx.fillStyle = ink;
    ctx.font = `13px 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(name, o.width / 2, size + 16, o.width - 8);
  }
  return canvas;
}
function drawFolderGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  alpha = 1,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#f2b636';
  ctx.beginPath();
  ctx.roundRect(x, y + size * 0.12, size * 0.45, size * 0.2, size * 0.05);
  ctx.fill();
  ctx.fillStyle = '#ffcb4c';
  ctx.beginPath();
  ctx.roundRect(x, y + size * 0.22, size, size * 0.68, size * 0.08);
  ctx.fill();
  ctx.restore();
}
function drawFileGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const w = size * 0.74;
  x += (size - w) / 2;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#9aa7b8';
  ctx.lineWidth = Math.max(1, size / 48);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w * 0.7, y);
  ctx.lineTo(x + w, y + w * 0.3);
  ctx.lineTo(x + w, y + size);
  ctx.lineTo(x, y + size);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
