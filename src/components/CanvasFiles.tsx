// Folder frames and file tiles (type 'file'): folders on this computer shown
// live on the board, with the Windows actions done to them from here. The
// board stores only which folder to show and how; see src/canvas/file-link.ts.
import { TelegramCard } from './telegram/TelegramCard';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AppWindow,
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowUp,
  ArrowUpNarrowWide,
  Check,
  ClipboardPaste,
  Cloud,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  House,
  Image,
  LayoutGrid,
  Link2,
  List,
  Monitor,
  Music,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  Video,
} from 'lucide-react';
import type { Camera, CanvasObject } from '../model';
import { localToWorld, worldToLocal } from '../canvas/transform';
import {
  displayName,
  dropMode,
  fileIconSizes,
  fileLinkLabel,
  fileRootLabels,
  fileRoots,
  fileSorts,
  folderFooter,
  folderHeader,
  formatDate,
  formatSize,
  iconLayouts,
  iconTier,
  listRow,
  sortItems,
  typeLabel,
  type FileItem,
  type FileLink,
  type FileListing,
  type FileOp,
  type FileRoot,
  type FileSource,
  type FileSort,
} from '../canvas/file-link';
import { ContextMenu, type MenuItem } from './Dialogs';
import { DesktopsCard } from './CanvasDesktops';
import { AppFrame } from './CanvasApps';
import type { DesktopWindow } from '../canvas/file-link';
import { fileIcon, loadedIcon, useFileIcons } from './file-icons';
import { forwardWheel } from './forward-wheel';
import './canvas-files.css';

export interface FilesView {
  objects: CanvasObject[];
  camera: Camera;
}
export interface FileBoardItem {
  path: string;
  name: string;
  folder: boolean;
}
interface Shared {
  host: HTMLDivElement | null;
  overlay: () => HTMLDivElement | null;
  readOnly: boolean;
  select: (id: string) => void;
  forward: (event: PointerEvent) => void;
  update: (o: CanvasObject) => void;
  addToBoard: (items: FileBoardItem[], asIcons: boolean, from: CanvasObject) => void;
  onError: (message: string) => void;
}

const bridge = () => window.canvas?.files;
const sourceOf = (link: FileLink): FileSource =>
  link.root ? { root: link.root, path: link.path } : { path: link.path };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const windowsPaths = () =>
  window.canvas?.platform !== 'linux' && window.canvas?.platform !== 'darwin';
const samePath = (a: string, b: string) =>
  windowsPaths() ? a.toLowerCase() === b.toLowerCase() : a === b;
const baseName = (file: string) => file.split(/[\\/]/).filter(Boolean).pop() || file;
const driveOf = (file: string) =>
  /^[a-z]:/i.test(file)
    ? file.slice(0, 2).toLowerCase()
    : file.split(/[\\/]/).slice(0, 4).join('/').toLowerCase();
const rootIcons: Record<FileRoot, typeof Monitor> = {
  desktop: Monitor,
  downloads: Download,
  documents: FileText,
  pictures: Image,
  music: Music,
  videos: Video,
  home: House,
};
const sortLabels: Record<FileSort, string> = {
  name: 'Name',
  modified: 'Date',
  type: 'Type',
  size: 'Size',
};
const sizeLabels = { small: 'S', medium: 'M', large: 'L', huge: 'XL' } as const;

// Explorer keeps one undo history for every window; so do folder frames.
const undoStack: FileOp[][] = [];
const remember = (ops: FileOp[] | undefined) => {
  if (!ops?.length) return;
  undoStack.push(ops);
  if (undoStack.length > 50) undoStack.shift();
};
export const rememberFileOps = (ops: FileOp[] | undefined) => remember(ops);
let watchesReset = false;
// Items being dragged out of a frame right now, for drop labels.
let dragging: { paths: string[]; at: number } | null = null;
const currentDrag = () => (dragging && Date.now() - dragging.at < 120000 ? dragging : null);

function Glyph({ item, size }: { item?: FileItem; size: number }) {
  if (!item || item.folder)
    return (
      <svg className="cf-glyph" width={size} height={size} viewBox="0 0 48 48" aria-hidden>
        <path d="M4 10a3 3 0 0 1 3-3h11l4 5h19a3 3 0 0 1 3 3v3H4z" fill="#f2b636" />
        <rect x="4" y="15" width="40" height="26" rx="3" fill="#ffcb4c" />
      </svg>
    );
  return (
    <svg className="cf-glyph" width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <path d="M11 4h19l9 9v31H11z" fill="#fff" stroke="#9aa7b8" strokeWidth="1.5" />
      <path d="M30 4v9h9" fill="none" stroke="#9aa7b8" strokeWidth="1.5" />
    </svg>
  );
}

function ItemIcon({ item, size, tier }: { item: FileItem; size: number; tier: number }) {
  const url = fileIcon(item.path, item.modified, tier);
  return (
    <div className="cf-icon" style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" draggable={false} /> : <Glyph item={item} size={size * 0.9} />}
      {item.shortcut && (
        <span className="cf-link-badge" aria-hidden>
          <ArrowUp size={10} strokeWidth={3} />
        </span>
      )}
      {item.cloud && (
        <Cloud
          className="cf-cloud-badge"
          size={Math.max(10, size * 0.22)}
          aria-label="Online only"
        />
      )}
    </div>
  );
}

function RenameField({
  item,
  hideExtensions,
  onDone,
}: {
  item: FileItem;
  hideExtensions: boolean;
  onDone: (name: string | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const shown = displayName(item, hideExtensions);
  const [value, setValue] = useState(shown);
  const done = useRef(false);
  useLayoutEffect(() => {
    const field = ref.current!;
    field.focus();
    // Like Explorer, the name is selected without its extension.
    const dot = item.folder || shown !== item.name ? -1 : shown.lastIndexOf('.');
    field.setSelectionRange(0, dot > 0 ? dot : shown.length);
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    if (name === null || name === shown) return onDone(null);
    // Hidden extensions (shortcuts, Windows' setting) stay on the file.
    const hidden = item.name.slice(shown.length);
    onDone(name + hidden);
  };
  return (
    <textarea
      ref={ref}
      className="cf-rename"
      value={value}
      rows={1}
      spellCheck={false}
      aria-label="New name"
      onChange={(event) => setValue(event.target.value.replace(/[\r\n]/g, ''))}
      onBlur={() => finish(value.trim() ? value.trim() : null)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(value.trim() ? value.trim() : null);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        }
      }}
    />
  );
}

type Menu = { x: number; y: number; items: (MenuItem | null)[]; header?: ReactNode };

function FolderCard({
  object: o,
  camera,
  active,
  shared,
  openMenu,
}: {
  object: CanvasObject;
  camera: Camera;
  active: boolean;
  shared: Shared;
  openMenu: (menu: Menu | null) => void;
}) {
  useFileIcons();
  const link = o.file!;
  const files = bridge();
  const { readOnly, select, forward, update, onError, addToBoard } = shared;
  const editable = !readOnly && !o.locked;
  const source = useMemo(() => sourceOf(link), [link.root, link.path]);
  const sourceKey = JSON.stringify(source);
  const [sub, setSub] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [scroll, setScroll] = useState(0);
  const [drop, setDrop] = useState<{ path: string | null; label: string } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  const [options, setOptions] = useState<{ x: number; y: number } | null>(null);
  const card = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const loadToken = useRef(0);
  const statusTimer = useRef(0);
  const typed = useRef({ text: '', at: 0 });
  const instance = useRef(Math.random().toString(36).slice(2));

  const flash = (text: string) => {
    window.clearTimeout(statusTimer.current);
    setStatus(text);
    statusTimer.current = window.setTimeout(() => setStatus(''), 4000);
  };
  useEffect(() => () => window.clearTimeout(statusTimer.current), []);

  // A different folder starts over at its top.
  useEffect(() => {
    setSub(null);
    setHistory([]);
    setSelection(new Set());
    setListing(null);
  }, [sourceKey]);

  const load = useCallback(async () => {
    if (!files) return;
    const token = ++loadToken.current;
    try {
      const next = await files.list({ source, sub: sub ?? undefined, hidden: !!link.hidden });
      if (token !== loadToken.current) return;
      if (next.state === 'missing' && sub) {
        // The folder open in the frame went away: back to the frame's own folder.
        flash(`“${baseName(sub)}” no longer exists`);
        setHistory([]);
        setSub(null);
        return;
      }
      setListing(next);
    } catch (error) {
      if (token !== loadToken.current) return;
      setListing({
        state: 'missing',
        dir: '',
        label: fileLinkLabel(link, o.text),
        message: message(error),
      });
    }
  }, [files, sourceKey, sub, link.hidden]);
  useEffect(() => {
    void load();
  }, [load]);

  // Live: reload when Windows reports a change; a missing folder is checked
  // again every few seconds.
  const dirs = listing?.state === 'folder' ? listing.dirs : [];
  const dirsKey = dirs.join('\n');
  const reloadTimer = useRef(0);
  useEffect(() => {
    if (!files || !dirs.length) return;
    const key = `${o.id}:${instance.current}`;
    void files.watch({ key, dirs }).catch(() => {});
    const off = files.onChange((dir) => {
      if (!dirs.some((d) => samePath(d, dir))) return;
      window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => void load(), 80);
    });
    return () => {
      off();
      window.clearTimeout(reloadTimer.current);
      void files.unwatch({ key }).catch(() => {});
    };
  }, [files, dirsKey, load]);
  useEffect(() => {
    if (!files || listing?.state !== 'missing') return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [files, listing?.state, load]);

  const items = useMemo(
    () => (listing?.state === 'folder' ? sortItems(listing.items, link.sort, link.descending) : []),
    [listing, link.sort, link.descending],
  );
  const byPath = useMemo(() => new Map(items.map((item) => [item.path, item])), [items]);
  // Selections keep only what still exists after a change.
  useEffect(() => {
    setSelection((current) => {
      const kept = [...current].filter((p) => byPath.has(p));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [byPath]);

  const hideExtensions = listing?.state === 'folder' ? listing.hideExtensions : true;
  const view = link.view || 'icons';
  const layout = iconLayouts[link.iconSize || 'medium'];
  const bodyWidth = Math.max(40, o.width - 2);
  const bodyHeight = Math.max(20, o.height - folderHeader - folderFooter);
  const columns = view === 'icons' ? Math.max(1, Math.floor((bodyWidth - 16) / layout.cell)) : 1;
  const rowHeight = view === 'icons' ? layout.row : listRow;
  const top = view === 'icons' ? 8 : listRow + 4;
  // Free placement: icons stay in the grid cell they were dropped in, like
  // the desktop's own. Cells are remembered on this computer only (names of
  // files never go into the board); items without one fill the first free cells.
  const free = view === 'icons' && link.arrange === 'free';
  const layoutKey =
    listing?.state === 'folder' ? `terra.folder-layout.${o.id}.${listing.dir.toLowerCase()}` : '';
  const [placed, setPlaced] = useState<Record<string, [number, number]>>({});
  useEffect(() => {
    try {
      setPlaced(layoutKey ? JSON.parse(localStorage.getItem(layoutKey) || '{}') : {});
    } catch {
      setPlaced({});
    }
  }, [layoutKey]);
  const savePlaced = (next: Record<string, [number, number]>) => {
    setPlaced(next);
    try {
      localStorage.setItem(layoutKey, JSON.stringify(next));
    } catch {}
  };
  const slots = useMemo(() => {
    if (!free) return null;
    const taken = new Set<string>(),
      result = new Map<string, [number, number]>();
    for (const item of items) {
      const cell = placed[item.name];
      if (!cell || taken.has(cell.join())) continue;
      taken.add(cell.join());
      result.set(item.path, cell);
    }
    let c = 0,
      r = 0;
    for (const item of items) {
      if (result.has(item.path)) continue;
      while (taken.has(`${c},${r}`)) if (++c >= columns) ((c = 0), r++);
      taken.add(`${c},${r}`);
      result.set(item.path, [c, r]);
    }
    return result;
  }, [free, items, placed, columns]);
  const rows = slots
    ? Math.max(0, ...[...slots.values()].map(([, r]) => r + 1))
    : Math.ceil(items.length / columns);
  const contentHeight = top + rows * rowHeight + 8;
  const firstRow = Math.max(0, Math.floor((scroll - top) / rowHeight) - 1);
  const lastRow = Math.min(rows - 1, Math.ceil((scroll + bodyHeight - top) / rowHeight) + 1);
  const dpr = window.devicePixelRatio || 1;
  const iconPixels = view === 'icons' ? layout.icon : 20;
  const tier = iconTier(iconPixels * camera.zoom * dpr);
  // Too small to read: a summary instead of hundreds of tiny icons.
  const tiny = iconPixels * camera.zoom < 5;
  const cellOf = (index: number) => {
    const slot = slots?.get(items[index]?.path);
    const row = slot ? slot[1] : Math.floor(index / columns),
      column = slot ? slot[0] : index % columns;
    return view === 'icons'
      ? {
          x: 8 + column * layout.cell,
          y: top + row * rowHeight,
          width: layout.cell,
          height: rowHeight,
        }
      : { x: 0, y: top + row * rowHeight, width: bodyWidth, height: rowHeight };
  };

  // Puts named items at a cell and the free cells after it (left to right,
  // then down), keeping everything else where it is.
  const placeAt = (names: string[], [c0, r0]: [number, number]) => {
    if (!names.length) return;
    const moving = new Set(names);
    const next: Record<string, [number, number]> = {};
    const taken = new Set<string>();
    for (const item of items) {
      if (moving.has(item.name)) continue;
      const cell = slots?.get(item.path) ?? placed[item.name];
      if (!cell) continue;
      next[item.name] = cell;
      taken.add(cell.join());
    }
    let c = c0,
      r = r0;
    for (const name of names) {
      while (taken.has(`${c},${r}`)) if (++c >= columns) ((c = 0), r++);
      next[name] = [c, r];
      taken.add(`${c},${r}`);
    }
    savePlaced(next);
  };
  const selectedItems = () => items.filter((item) => selection.has(item.path));
  const selectOnly = (paths: string[]) => {
    setSelection(new Set(paths));
    anchor.current = paths[paths.length - 1] ?? null;
  };
  const reveal = (path: string) => {
    const index = items.findIndex((item) => item.path === path);
    const element = body.current;
    if (index < 0 || !element) return;
    const cell = cellOf(index);
    if (cell.y < element.scrollTop) element.scrollTop = cell.y - 8;
    else if (cell.y + cell.height > element.scrollTop + element.clientHeight)
      element.scrollTop = cell.y + cell.height - element.clientHeight + 8;
  };

  const run = async (
    working: string,
    task: () => Promise<{ ops?: FileOp[]; errors: string[] } | void>,
    done?: (result: { ops?: FileOp[]; errors: string[] }) => string,
  ) => {
    window.clearTimeout(statusTimer.current);
    setStatus(working);
    try {
      const result = (await task()) || { errors: [] };
      remember(result.ops);
      if (result.errors.length)
        onError(
          result.errors.slice(0, 4).join('\n') +
            (result.errors.length > 4 ? `\nand ${result.errors.length - 4} more` : ''),
        );
      flash(done ? done(result) : '');
      return result;
    } catch (error) {
      setStatus('');
      onError(message(error));
    } finally {
      void load();
    }
  };
  const navigate = (dir: string) => {
    setHistory((h) => [...h, sub]);
    setSub(dir);
    selectOnly([]);
    setScroll(0);
    if (body.current) body.current.scrollTop = 0;
  };
  const goBack = () => {
    if (!history.length) return;
    const previous = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setSub(previous);
    selectOnly([]);
  };
  const goUp = () => {
    if (listing?.state !== 'folder' || !listing.parent) return;
    const parent = listing.parent;
    setHistory((h) => [...h, sub]);
    // The frame's own folder is shown as itself (with the shared Desktop).
    setSub(samePath(parent, listing.base) ? null : parent);
    selectOnly([]);
  };
  const open = (item: FileItem) => {
    if (item.folder) navigate(item.path);
    else void files?.open({ path: item.path }).catch((error) => onError(message(error)));
  };
  const openSelected = () => {
    const chosen = selectedItems();
    if (chosen.length === 1) open(chosen[0]);
    else for (const item of chosen.filter((i) => !i.folder).slice(0, 12)) open(item);
  };
  const trash = (chosen = selectedItems()) => {
    if (!files || !chosen.length) return;
    let done = 0;
    void run(
      'Moving to the Recycle Bin…',
      async () => {
        const result = await files.trash({ paths: chosen.map((i) => i.path) });
        done = result.done;
        return { errors: result.errors };
      },
      () => (done ? `${done === 1 ? '1 item' : `${done} items`} moved to the Recycle Bin` : ''),
    );
  };
  const copyItems = (cut: boolean, chosen = selectedItems()) => {
    if (!files || !chosen.length) return;
    void files
      .copy({ paths: chosen.map((i) => i.path), cut })
      .then(() =>
        flash(
          `${chosen.length === 1 ? '1 item' : `${chosen.length} items`} ${cut ? 'cut' : 'copied'}`,
        ),
      )
      .catch((error) => onError(message(error)));
  };
  const paste = (into?: string) => {
    if (!files || listing?.state !== 'folder') return;
    const target = into || listing.dir;
    void run('Pasting…', async () => {
      const clip = await files.readClipboard();
      if (!clip?.paths.length) return { errors: ['There are no copied files to paste.'] };
      const result = await files.transfer({
        paths: clip.paths,
        target,
        mode: clip.cut ? 'move' : 'copy',
      });
      if (clip.cut) await files.clearClipboard();
      return result;
    });
  };
  const newFolder = () => {
    if (!files || listing?.state !== 'folder') return;
    void run('Creating a folder…', async () => {
      const result = await files.newFolder({ dir: listing.dir });
      const created = result.ops[0]?.to;
      if (created) {
        await load();
        selectOnly([created]);
        setRenaming(created);
        requestAnimationFrame(() => reveal(created));
      }
      return result;
    });
  };
  const undo = () => {
    const ops = undoStack.pop();
    if (!files || !ops) {
      flash('Nothing to undo');
      return;
    }
    void run(
      'Undoing…',
      () => files.revert({ ops }).then((r) => ({ errors: r.errors })),
      () => 'Undone',
    );
  };
  const rename = (item: FileItem, name: string | null) => {
    setRenaming(null);
    card.current?.focus({ preventScroll: true });
    if (!files || name === null || name === item.name) return;
    void run('Renaming…', async () => {
      const result = await files.rename({ path: item.path, name });
      const to = result.ops[0]?.to;
      if (to) selectOnly([to]);
      return result;
    });
  };
  const setLink = (patch: Partial<FileLink>, text?: string) => {
    if (!editable) return;
    const next: FileLink = { ...link, ...patch };
    for (const key of Object.keys(patch) as (keyof FileLink)[])
      if (patch[key] === undefined) delete next[key];
    update({ ...o, file: next, ...(text !== undefined ? { text } : {}) });
  };
  const chooseRoot = (root: FileRoot) =>
    setLink({ root, path: '', kind: 'folder' }, fileRootLabels[root]);
  const chooseFolder = async () => {
    if (!files) return;
    try {
      const chosen = await files.choose({
        defaultPath: listing && listing.state !== 'missing' ? listing.dir : undefined,
      });
      if (!chosen) return;
      setLink(
        { root: chosen.source.root, path: chosen.source.path, kind: 'folder' },
        baseName(chosen.path),
      );
    } catch (error) {
      onError(message(error));
    }
  };

  // Board units inside the body, from a pointer on the screen.
  const bodyPoint = (clientX: number, clientY: number) => {
    const overlay = shared.overlay()?.getBoundingClientRect();
    if (!overlay) return { x: 0, y: 0 };
    const world = {
      x: (clientX - overlay.left - camera.x) / camera.zoom,
      y: (clientY - overlay.top - camera.y) / camera.zoom,
    };
    const local = worldToLocal(o, world);
    return { x: local.x - 1, y: local.y - folderHeader + (body.current?.scrollTop ?? 0) };
  };
  const itemsIn = (rect: { x0: number; y0: number; x1: number; y1: number }) => {
    const left = Math.min(rect.x0, rect.x1),
      right = Math.max(rect.x0, rect.x1),
      upper = Math.min(rect.y0, rect.y1),
      lower = Math.max(rect.y0, rect.y1);
    return items
      .filter((_, i) => {
        const c = cellOf(i);
        const x = view === 'icons' ? c.x + 6 : c.x,
          w = view === 'icons' ? c.width - 12 : Math.min(c.width, 360);
        return x < right && x + w > left && c.y < lower && c.y + c.height > upper;
      })
      .map((item) => item.path);
  };

  const pressItem = (event: PointerEvent, item: FileItem) => {
    if (event.button === 2) {
      if (!selection.has(item.path)) selectOnly([item.path]);
      return;
    }
    if (event.button !== 0) return;
    event.stopPropagation();
    card.current?.focus({ preventScroll: true });
    if (!active) select(o.id);
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selection);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      setSelection(next);
      anchor.current = item.path;
    } else if (event.shiftKey && anchor.current && byPath.has(anchor.current)) {
      const a = items.findIndex((i) => i.path === anchor.current),
        b = items.findIndex((i) => i.path === item.path);
      setSelection(new Set(items.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.path)));
    } else if (!selection.has(item.path)) selectOnly([item.path]);
    else if (selection.size === 1 && !renaming) {
      // A second click on the name of the selected item renames it, as in Explorer.
      const label = (event.target as HTMLElement).closest('.cf-label');
      if (label) {
        const started = Date.now();
        const up = () => {
          window.removeEventListener('pointerup', up);
          if (Date.now() - started < 400 && !currentDrag()) {
            window.setTimeout(() => {
              if (lastOpen.current < started) setRenaming(item.path);
            }, 450);
          }
        };
        window.addEventListener('pointerup', up);
      }
    }
  };
  const lastOpen = useRef(0);
  const pressBody = (event: PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-path],.cf-rename'))
      return;
    event.stopPropagation();
    card.current?.focus({ preventScroll: true });
    const element = body.current!;
    const start = bodyPoint(event.clientX, event.clientY);
    const additive = event.ctrlKey || event.metaKey;
    const before = additive ? new Set(selection) : new Set<string>();
    let moved = false;
    element.setPointerCapture(event.pointerId);
    const move = (e: globalThis.PointerEvent) => {
      const p = bodyPoint(e.clientX, e.clientY);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) * camera.zoom < 4) return;
      moved = true;
      const rect = { x0: start.x, y0: start.y, x1: p.x, y1: p.y };
      setMarquee(rect);
      const hit = itemsIn(rect);
      setSelection(new Set([...before, ...hit]));
      // Near the edges the list scrolls, so a selection can grow past them.
      const local = p.y - element.scrollTop;
      if (local < 12) element.scrollTop -= 12;
      else if (local > element.clientHeight - 12) element.scrollTop += 12;
    };
    const end = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', end);
      element.removeEventListener('pointercancel', end);
      setMarquee(null);
      if (!moved) {
        if (!additive) selectOnly([]);
        select(o.id);
      }
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
  };

  const dragStart = (event: DragEvent, item: FileItem) => {
    event.preventDefault();
    if (!files || renaming) return;
    const paths = selection.has(item.path)
      ? items.filter((i) => selection.has(i.path)).map((i) => i.path)
      : [item.path];
    if (!selection.has(item.path)) selectOnly([item.path]);
    dragging = { paths, at: Date.now() };
    files.drag(paths, loadedIcon(item.path, item.modified));
  };
  const dropTarget = (event: DragEvent) => {
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-path]');
    const item = element ? byPath.get(element.dataset.path!) : undefined;
    const drag = currentDrag();
    if (!item || drag?.paths.includes(item.path)) return null;
    return item.folder || item.app || item.shortcut ? item : null;
  };
  const dragOver = (event: DragEvent) => {
    if (!files || listing?.state !== 'folder' || !event.dataTransfer.types.includes('Files'))
      return;
    event.preventDefault();
    event.stopPropagation();
    const into = dropTarget(event);
    const mode = dropMode(event);
    const name = into ? displayName(into, hideExtensions) : listing.label;
    const drag = currentDrag();
    let label: string, effect: 'copy' | 'move' | 'link';
    if (into && !into.folder) {
      label = `Open with ${name}`;
      effect = 'copy';
    } else if (mode === 'link') {
      label = `Create shortcut in ${name}`;
      effect = 'link';
    } else if (mode === 'copy') {
      label = `Copy to ${name}`;
      effect = 'copy';
    } else if (
      mode === 'move' ||
      (drag && drag.paths.every((p) => driveOf(p) === driveOf(listing.dir)))
    ) {
      label = `Move to ${name}`;
      effect = 'move';
    } else {
      label = drag ? `Copy to ${name}` : `Add to ${name}`;
      effect = 'copy';
    }
    const allowed = event.dataTransfer.effectAllowed;
    event.dataTransfer.dropEffect =
      allowed === 'all' || allowed === 'uninitialized' || allowed.toLowerCase().includes(effect)
        ? effect
        : 'copy';
    setDrop((current) =>
      current?.path === (into?.path ?? null) && current.label === label
        ? current
        : { path: into?.path ?? null, label },
    );
  };
  const dragLeave = (event: DragEvent) => {
    if (!card.current?.contains(event.relatedTarget as Node | null)) setDrop(null);
  };
  const dropFiles = (event: DragEvent) => {
    if (!files || listing?.state !== 'folder' || !event.dataTransfer.types.includes('Files'))
      return;
    event.preventDefault();
    event.stopPropagation();
    setDrop(null);
    const into = dropTarget(event);
    const mode = dropMode(event);
    dragging = null;
    const paths = [...event.dataTransfer.files]
      .map((file) => window.canvas?.filePath(file) || '')
      .filter(Boolean);
    if (!paths.length) {
      onError('Only files and folders from this computer can be dropped here.');
      return;
    }
    // Free placement: items of this folder dropped on its own empty space move
    // to that cell; nothing happens on disk.
    const point = bodyPoint(event.clientX, event.clientY);
    const cell: [number, number] = [
      Math.max(0, Math.min(columns - 1, Math.floor((point.x - 8) / layout.cell))),
      Math.max(0, Math.floor((point.y - top) / rowHeight)),
    ];
    const here = paths.every((p) => byPath.has(p));
    if (free && !into && here) {
      placeAt(
        paths.map((p) => byPath.get(p)!.name),
        cell,
      );
      return;
    }
    if (into && !into.folder)
      void run(`Opening with ${displayName(into, hideExtensions)}…`, () =>
        files.openWith({ app: into.path, paths }),
      );
    else if (free && !into)
      // Items arriving from elsewhere land where they were dropped.
      void run(
        mode === 'link' ? 'Creating shortcuts…' : mode === 'copy' ? 'Copying…' : 'Moving…',
        async () => {
          const result = await files.transfer({ paths, target: listing.dir, mode });
          placeAt(
            result.ops.map((op) => op.to.split(/[\\/]/).pop()!),
            cell,
          );
          return result;
        },
      );
    else
      void run(
        mode === 'link' ? 'Creating shortcuts…' : mode === 'copy' ? 'Copying…' : 'Moving…',
        () => files.transfer({ paths, target: into?.path ?? listing.dir, mode }),
        (result) =>
          result.ops?.length
            ? `${result.ops.length === 1 ? '1 item' : `${result.ops.length} items`} ${
                {
                  move: 'moved',
                  copy: 'copied',
                  link: 'linked',
                  rename: 'renamed',
                  create: 'created',
                }[result.ops[0].op]
              }`
            : '',
      );
  };

  const keyDown = (event: KeyboardEvent) => {
    if (renaming || (event.target as HTMLElement).closest('input,textarea')) return;
    const mod = event.ctrlKey || event.metaKey;
    const chosen = selectedItems();
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const step = (delta: number) => {
      if (!items.length) return;
      const current = anchor.current ? items.findIndex((i) => i.path === anchor.current) : -1;
      const next = Math.max(0, Math.min(items.length - 1, current < 0 ? 0 : current + delta));
      selectOnly([items[next].path]);
      reveal(items[next].path);
    };
    if (listing?.state !== 'folder') return;
    if (event.key === 'Enter' && chosen.length) {
      handled();
      lastOpen.current = Date.now();
      openSelected();
    } else if (event.key === 'Delete' && chosen.length) {
      handled();
      trash(chosen);
    } else if (event.key === 'F2' && chosen.length === 1) {
      handled();
      setRenaming(chosen[0].path);
    } else if (event.key === 'F5') {
      handled();
      void load();
    } else if (mod && event.code === 'KeyA') {
      handled();
      setSelection(new Set(items.map((i) => i.path)));
    } else if (mod && (event.code === 'KeyC' || event.code === 'KeyX') && chosen.length) {
      handled();
      copyItems(event.code === 'KeyX', chosen);
    } else if (mod && event.code === 'KeyV') {
      handled();
      paste();
    } else if (mod && event.code === 'KeyZ' && !event.shiftKey) {
      handled();
      undo();
    } else if (mod && event.shiftKey && event.code === 'KeyN') {
      handled();
      newFolder();
    } else if (event.key === 'Backspace' || (event.altKey && event.key === 'ArrowLeft')) {
      handled();
      goBack();
    } else if (event.altKey && event.key === 'ArrowUp') {
      handled();
      goUp();
    } else if (event.key === 'Escape' && (chosen.length || drop)) {
      handled();
      selectOnly([]);
    } else if (!mod && !event.altKey && /^Arrow/.test(event.key)) {
      handled();
      const delta =
        event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowRight'
            ? 1
            : event.key === 'ArrowUp'
              ? -columns
              : columns;
      step(view === 'list' && /Left|Right/.test(event.key) ? 0 : delta);
    } else if (event.key === 'Home' || event.key === 'End') {
      handled();
      step(event.key === 'Home' ? -items.length : items.length);
    } else if (!mod && !event.altKey && event.key.length === 1 && event.key !== ' ') {
      // Typing jumps to the next item with that name, as in Explorer.
      handled();
      const now = Date.now();
      typed.current =
        now - typed.current.at > 700
          ? { text: event.key.toLowerCase(), at: now }
          : { text: typed.current.text + event.key.toLowerCase(), at: now };
      const text = typed.current.text;
      const start = anchor.current ? items.findIndex((i) => i.path === anchor.current) : -1;
      const ordered = [
        ...items.slice(start + (text.length > 1 ? 0 : 1)),
        ...items.slice(0, start + 1),
      ];
      const match = ordered.find((i) =>
        displayName(i, hideExtensions).toLowerCase().startsWith(text),
      );
      if (match) {
        selectOnly([match.path]);
        reveal(match.path);
      }
    }
  };

  const itemMenu = (item: FileItem): (MenuItem | null)[] => {
    const chosen = selection.has(item.path) ? selectedItems() : [item];
    const many = chosen.length > 1;
    const boardItems = chosen.map((i) => ({ path: i.path, name: i.name, folder: i.folder }));
    return [
      {
        label: item.folder ? 'Open' : many ? 'Open all' : 'Open',
        icon: <FolderOpen />,
        action: () => {
          lastOpen.current = Date.now();
          if (selection.has(item.path)) openSelected();
          else open(item);
        },
      },
      ...(item.folder
        ? [
            {
              label: 'Open in new frame',
              icon: <AppWindow />,
              disabled: readOnly,
              action: () => addToBoard(boardItems, false, o),
            },
          ]
        : [
            {
              label: many ? 'Add to board' : 'Add to board',
              icon: <Copy />,
              disabled: readOnly,
              action: () => addToBoard(boardItems, false, o),
            },
          ]),
      {
        label: many ? 'Add as icons on the board' : 'Add as icon on the board',
        icon: <Link2 />,
        disabled: readOnly,
        action: () => addToBoard(boardItems, true, o),
      },
      {
        label: 'Show in Explorer',
        icon: <ExternalLink />,
        action: () => void files?.reveal({ path: item.path }),
      },
      {
        label: many ? 'Copy paths' : 'Copy path',
        icon: <Copy />,
        action: () => void navigator.clipboard.writeText(chosen.map((i) => i.path).join('\r\n')),
      },
      null,
      { label: 'Cut', icon: <Scissors />, action: () => copyItems(true, chosen) },
      { label: 'Copy', icon: <Copy />, action: () => copyItems(false, chosen) },
      ...(item.folder
        ? [{ label: 'Paste into folder', icon: <ClipboardPaste />, action: () => paste(item.path) }]
        : []),
      null,
      { label: 'Rename', icon: <Pencil />, disabled: many, action: () => setRenaming(item.path) },
      { label: 'Delete', icon: <Trash2 />, danger: true, action: () => trash(chosen) },
    ];
  };
  const backgroundMenu = (): (MenuItem | null)[] => [
    { label: 'New folder', icon: <FolderPlus />, action: newFolder },
    { label: 'Paste', icon: <ClipboardPaste />, action: () => paste() },
    { label: 'Undo', icon: <ArrowLeft />, disabled: !undoStack.length, action: undo },
    null,
    { label: 'Refresh', icon: <RefreshCw />, action: () => void load() },
    {
      label: 'Show in Explorer',
      icon: <ExternalLink />,
      action: () =>
        listing && listing.state !== 'missing' && void files?.reveal({ path: listing.dir }),
    },
    {
      label: 'Folder and view…',
      icon: <Ellipsis />,
      disabled: !editable,
      action: () => openOptions(),
    },
  ];
  const contextMenu = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea')) return;
    event.preventDefault();
    event.stopPropagation();
    if (target.closest('.cf-header') || !files || listing?.state !== 'folder') {
      // The frame itself: the board's menu (delete, lock, arrange…).
      shared.host?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
      return;
    }
    if (!active) select(o.id);
    const element = target.closest<HTMLElement>('[data-path]');
    const item = element ? byPath.get(element.dataset.path!) : undefined;
    if (item && !selection.has(item.path)) selectOnly([item.path]);
    if (!item && selection.size) selectOnly([]);
    openMenu({
      x: event.clientX,
      y: event.clientY,
      items: item ? itemMenu(item) : backgroundMenu(),
    });
  };
  const optionsButton = useRef<HTMLButtonElement>(null);
  const openOptions = () => {
    const rect = optionsButton.current?.getBoundingClientRect();
    setOptions(rect ? { x: rect.right, y: rect.bottom + 6 } : { x: 200, y: 200 });
  };

  const origin = localToWorld(o, { x: 0, y: 0 });
  const RootIcon = link.root && !link.path ? rootIcons[link.root] : null;
  const title =
    listing && listing.state !== 'missing' ? listing.label : fileLinkLabel(link, o.text);
  const count =
    listing?.state === 'folder'
      ? `${listing.total === 1 ? '1 item' : `${listing.total} items`}${
          listing.total > items.length ? ` (first ${items.length} shown)` : ''
        }${selection.size ? ` · ${selection.size} selected` : ''}`
      : '';

  let content: ReactNode;
  if (!files)
    content = (
      <div className="cf-message">
        <Glyph size={44} />
        <p>Folders on a computer show in Terra Board for Windows and Linux.</p>
      </div>
    );
  else if (!listing) content = <div className="cf-message">Opening…</div>;
  else if (listing.state === 'missing')
    content = (
      <div className="cf-message">
        <FolderSearch size={36} strokeWidth={1.5} />
        <p>“{fileLinkLabel(link, o.text)}” isn’t on this computer.</p>
        {editable && (
          <button className="button" onClick={() => void chooseFolder()}>
            Choose folder…
          </button>
        )}
      </div>
    );
  else if (listing.state === 'file')
    content = (
      <div className="cf-message">
        <p>This is a file, not a folder.</p>
        <button
          className="button"
          onClick={() => void files.open({ path: listing.dir }).catch((e) => onError(message(e)))}
        >
          Open it
        </button>
      </div>
    );
  else if (tiny) content = <div className="cf-message cf-summary">{count}</div>;
  else if (!items.length)
    content = <div className="cf-message cf-empty">This folder is empty.</div>;
  else {
    const rendered: ReactNode[] = [];
    // Only the rows in view are drawn (in free placement, the items in them).
    const indexes: number[] = [];
    if (slots)
      items.forEach((item, i) => {
        const r = slots.get(item.path)![1];
        if (r >= firstRow && r <= lastRow) indexes.push(i);
      });
    else
      for (let i = firstRow * columns; i < Math.min(items.length, (lastRow + 1) * columns); i++)
        indexes.push(i);
    for (const index of indexes) {
      {
        const item = items[index];
        const cell = cellOf(index);
        const name = displayName(item, hideExtensions);
        const props = {
          key: item.path,
          'data-path': item.path,
          'data-selected': selection.has(item.path) || undefined,
          'data-drop': drop?.path === item.path || undefined,
          'data-hidden': item.hidden || undefined,
          'data-folder': item.folder,
          draggable: !renaming,
          title: `${item.name}\n${typeLabel(item)}${item.size !== null ? `\n${formatSize(item.size)}` : ''}\nModified ${formatDate(item.modified)}${item.cloud ? '\nOnline only' : ''}`,
          style: { left: cell.x, top: cell.y, width: cell.width, height: cell.height },
          onPointerDown: (event: PointerEvent) => pressItem(event, item),
          onDoubleClick: (event: React.MouseEvent) => {
            event.stopPropagation();
            lastOpen.current = Date.now();
            open(item);
          },
          onDragStart: (event: DragEvent) => dragStart(event, item),
        };
        const label =
          renaming === item.path ? (
            <RenameField
              item={item}
              hideExtensions={hideExtensions}
              onDone={(n) => rename(item, n)}
            />
          ) : (
            <span className="cf-label">{name}</span>
          );
        rendered.push(
          view === 'icons' ? (
            <div className="cf-item" {...props}>
              <ItemIcon item={item} size={layout.icon} tier={tier} />
              {label}
            </div>
          ) : (
            <div className="cf-row" {...props}>
              <span className="cf-name">
                <ItemIcon item={item} size={20} tier={tier} />
                {label}
              </span>
              <span>{formatDate(item.modified)}</span>
              <span>{typeLabel(item)}</span>
              <span className="cf-size">{formatSize(item.size)}</span>
            </div>
          ),
        );
      }
    }
    content = (
      <div className="cf-content" style={{ height: contentHeight }}>
        {view === 'list' && (
          <div className="cf-row cf-columns">
            {fileSorts.map((sort) => (
              <button
                key={sort}
                className={sort === 'size' ? 'cf-size' : sort === 'name' ? 'cf-name' : ''}
                disabled={!editable}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() =>
                  setLink(
                    link.sort === sort || (!link.sort && sort === 'name')
                      ? { descending: link.descending ? undefined : true }
                      : { sort: sort === 'name' ? undefined : sort, descending: undefined },
                  )
                }
              >
                {{ name: 'Name', modified: 'Date modified', type: 'Type', size: 'Size' }[sort]}
                {(link.sort || 'name') === sort &&
                  (link.descending ? (
                    <ArrowDownWideNarrow size={13} />
                  ) : (
                    <ArrowUpNarrowWide size={13} />
                  ))}
              </button>
            ))}
          </div>
        )}
        {rendered}
        {marquee && (
          <div
            className="cf-marquee"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        )}
      </div>
    );
  }

  return (
    <section
      ref={card}
      className="canvas-folder"
      data-file-id={o.id}
      data-dir={listing && listing.state === 'folder' ? listing.dir : undefined}
      data-selected={active || undefined}
      data-dropping={(drop && drop.path === null) || undefined}
      data-view={view}
      tabIndex={-1}
      aria-label={`Folder ${title}`}
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: o.width,
        height: o.height,
        transform: `scale(${camera.zoom}) rotate(${o.rotation || 0}deg)`,
      }}
      onKeyDown={keyDown}
      onContextMenu={contextMenu}
      onDragOver={dragOver}
      onDragEnter={dragOver}
      onDragLeave={dragLeave}
      onDrop={dropFiles}
    >
      <header
        className="cf-header"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          card.current?.focus({ preventScroll: true });
          forward(event);
        }}
      >
        <button
          className="cf-button"
          aria-label="Back"
          title="Back"
          disabled={!history.length}
          onClick={goBack}
        >
          <ArrowLeft size={17} />
        </button>
        <button
          className="cf-button"
          aria-label="Up"
          title="Up one folder"
          disabled={listing?.state !== 'folder' || !listing.parent}
          onClick={goUp}
        >
          <ArrowUp size={17} />
        </button>
        <span className="cf-title-icon">
          {RootIcon ? <RootIcon size={18} /> : <Glyph size={22} />}
        </span>
        <span
          className="cf-title"
          title={listing && listing.state !== 'missing' ? listing.dir : undefined}
        >
          {sub && listing?.state === 'folder' ? (
            <>
              <span className="cf-crumb">{fileLinkLabel(link, o.text)}</span>
              <span className="cf-crumb-sep">›</span>
              {title}
            </>
          ) : (
            title
          )}
        </span>
        {files && listing?.state === 'folder' && (
          <>
            <button
              className="cf-button"
              aria-label="New folder"
              title="New folder (Ctrl+Shift+N)"
              onClick={newFolder}
            >
              <FolderPlus size={17} />
            </button>
            <button
              className="cf-button"
              aria-label={view === 'icons' ? 'Show as list' : 'Show as icons'}
              title={view === 'icons' ? 'Show as list' : 'Show as icons'}
              disabled={!editable}
              onClick={() => setLink({ view: view === 'icons' ? 'list' : undefined })}
            >
              {view === 'icons' ? <List size={17} /> : <LayoutGrid size={17} />}
            </button>
          </>
        )}
        {files && (
          <button
            ref={optionsButton}
            className="cf-button"
            aria-label="Folder and view"
            title="Folder and view"
            disabled={!editable}
            onClick={openOptions}
          >
            <Ellipsis size={17} />
          </button>
        )}
      </header>
      <div
        ref={body}
        className="cf-body"
        style={{ height: bodyHeight }}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
        onPointerDown={pressBody}
      >
        {content}
      </div>
      <footer className="cf-footer">
        <span>{drop ? drop.label : count}</span>
        <span className="cf-status">{status}</span>
      </footer>
      {options &&
        createPortal(
          <FolderOptions
            at={options}
            link={link}
            onClose={() => setOptions(null)}
            setLink={setLink}
            chooseRoot={chooseRoot}
            chooseFolder={chooseFolder}
          />,
          document.body,
        )}
    </section>
  );
}

function FolderOptions({
  at,
  link,
  onClose,
  setLink,
  chooseRoot,
  chooseFolder,
}: {
  at: { x: number; y: number };
  link: FileLink;
  onClose: () => void;
  setLink: (patch: Partial<FileLink>) => void;
  chooseRoot: (root: FileRoot) => void;
  chooseFolder: () => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.left =
      Math.max(8, Math.min(at.x - el.offsetWidth, innerWidth - el.offsetWidth - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(at.y, innerHeight - el.offsetHeight - 8)) + 'px';
    el.focus({ preventScroll: true });
  }, [at.x, at.y]);
  useEffect(() => {
    const down = (e: globalThis.PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  const view = link.view || 'icons',
    size = link.iconSize || 'medium',
    sort = link.sort || 'name';
  const chip = (on: boolean, label: ReactNode, action: () => void, key?: string, hint?: string) => (
    <button key={key} className="cf-chip" data-on={on || undefined} title={hint} onClick={action}>
      {label}
    </button>
  );
  return (
    <div
      ref={ref}
      className="cf-options context-menu"
      role="dialog"
      aria-label="Folder and view"
      tabIndex={-1}
    >
      <h3>Folder</h3>
      <div className="cf-chips">
        {fileRoots.map((root) => {
          const Icon = rootIcons[root];
          return chip(
            link.root === root && !link.path,
            <>
              <Icon size={14} /> {fileRootLabels[root]}
            </>,
            () => chooseRoot(root),
            root,
          );
        })}
        {chip(
          false,
          <>
            <FolderSearch size={14} /> Choose…
          </>,
          () => {
            onClose();
            void chooseFolder();
          },
        )}
      </div>
      <h3>View</h3>
      <div className="cf-chips">
        {chip(
          view === 'icons',
          <>
            <LayoutGrid size={14} /> Icons
          </>,
          () => setLink({ view: undefined }),
        )}
        {chip(
          view === 'list',
          <>
            <List size={14} /> List
          </>,
          () => setLink({ view: 'list' }),
        )}
        {view === 'icons' &&
          fileIconSizes.map((s) =>
            chip(
              size === s,
              sizeLabels[s],
              () => setLink({ iconSize: s === 'medium' ? undefined : s }),
              s,
              `${s[0].toUpperCase()}${s.slice(1)} icons`,
            ),
          )}
      </div>
      {view === 'icons' && (
        <>
          <h3>Arrange</h3>
          <div className="cf-chips">
            {chip(
              !link.arrange,
              'Sorted',
              () => setLink({ arrange: undefined }),
              'sorted',
              'Icons follow the sort order',
            )}
            {chip(
              link.arrange === 'free',
              'Free, like the desktop',
              () => setLink({ arrange: 'free' }),
              'free',
              'Drag icons to any spot; they stay there',
            )}
          </div>
        </>
      )}
      <h3>Sort by</h3>
      <div className="cf-chips">
        {fileSorts.map((s) =>
          chip(sort === s, sortLabels[s], () => setLink({ sort: s === 'name' ? undefined : s }), s),
        )}
        {chip(
          !!link.descending,
          link.descending ? <ArrowDownWideNarrow size={14} /> : <ArrowUpNarrowWide size={14} />,
          () => setLink({ descending: link.descending ? undefined : true }),
          'order',
          link.descending ? 'Descending' : 'Ascending',
        )}
      </div>
      <label className="cf-check">
        <input
          type="checkbox"
          checked={!!link.hidden}
          onChange={(event) => setLink({ hidden: event.target.checked ? true : undefined })}
        />
        Show hidden items
      </label>
    </div>
  );
}

// A file or app as a desktop icon on the board: double-click opens it, and
// files dropped on an app open with it.
function FileTile({
  object: o,
  camera,
  active,
  shared,
}: {
  object: CanvasObject;
  camera: Camera;
  active: boolean;
  shared: Shared;
}) {
  useFileIcons();
  const link = o.file!;
  const files = bridge();
  const { forward, onError } = shared;
  const sourceKey = JSON.stringify(sourceOf(link));
  const [listing, setListing] = useState<FileListing | null>(null);
  const [over, setOver] = useState(false);
  const load = useCallback(async () => {
    if (!files) return;
    try {
      setListing(await files.list({ source: sourceOf(link) }));
    } catch (error) {
      setListing({
        state: 'missing',
        dir: '',
        label: fileLinkLabel(link, o.text),
        message: message(error),
      });
    }
  }, [files, sourceKey]);
  useEffect(() => {
    void load();
  }, [load]);
  // The file's folder is watched, so a rename, change or deletion shows.
  const parent =
    listing && listing.state !== 'missing' && listing.dir
      ? listing.dir.replace(/[\\/][^\\/]*$/, '')
      : '';
  useEffect(() => {
    if (!files || !parent) return;
    const key = `tile:${o.id}`;
    void files.watch({ key, dirs: [parent] }).catch(() => {});
    const off = files.onChange((dir) => {
      if (samePath(dir, parent)) void load();
    });
    return () => {
      off();
      void files.unwatch({ key }).catch(() => {});
    };
  }, [files, parent, load]);
  useEffect(() => {
    if (!files || listing?.state !== 'missing') return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [files, listing?.state, load]);

  const item: FileItem | null =
    listing?.state === 'file'
      ? listing.item
      : listing?.state === 'folder'
        ? {
            name: baseName(listing.dir),
            path: listing.dir,
            folder: true,
            size: null,
            modified: 0,
            hidden: false,
          }
        : null;
  // A program keeps the name it was added with ("Google Chrome", not chrome.exe).
  const label =
    item && !(item.app && o.text)
      ? displayName(
          item,
          listing?.state === 'file' || listing?.state === 'folder' ? listing.hideExtensions : true,
        )
      : fileLinkLabel(link, o.text);
  const iconSize = Math.max(16, Math.min(o.width * 0.72, o.height - 34));
  const tier = iconTier(iconSize * camera.zoom * (window.devicePixelRatio || 1));
  const origin = localToWorld(o, { x: 0, y: 0 });
  const accepts = !!item && (item.folder || item.app || item.shortcut);
  return (
    <section
      className="canvas-file-tile"
      data-file-id={o.id}
      data-selected={active || undefined}
      data-missing={listing?.state === 'missing' || undefined}
      data-dropping={over || undefined}
      aria-label={label}
      title={
        item
          ? item.path
          : listing?.state === 'missing'
            ? `Not found on this computer: ${listing.label}`
            : undefined
      }
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: o.width,
        height: o.height,
        transform: `scale(${camera.zoom}) rotate(${o.rotation || 0}deg)`,
      }}
      onPointerDown={(event) => {
        if (event.button === 0) forward(event);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        openFileObject(o, onError);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        shared.select(o.id);
        shared.host?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
          }),
        );
      }}
      onDragOver={(event) => {
        if (!accepts || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (!accepts || !files || !item) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const paths = [...event.dataTransfer.files]
          .map((f) => window.canvas?.filePath(f) || '')
          .filter(Boolean);
        if (!paths.length) return;
        const task = item.folder
          ? files.transfer({ paths, target: item.path, mode: dropMode(event) })
          : files.openWith({ app: item.path, paths });
        void task
          .then((result) => {
            remember(result.ops);
            if (result.errors.length) onError(result.errors.join('\n'));
          })
          .catch((error) => onError(message(error)));
      }}
    >
      <div className="cf-tile-icon" style={{ width: iconSize, height: iconSize }}>
        {item ? (
          <ItemIcon item={item} size={iconSize} tier={tier} />
        ) : (
          <Glyph item={link.kind === 'file' ? ({} as FileItem) : undefined} size={iconSize} />
        )}
      </div>
      <span className="cf-tile-label">{label}</span>
    </section>
  );
}

export default function CanvasFiles({
  view,
  host,
  interactive,
  readOnly,
  selected,
  select,
  beginPointer,
  update,
  addToBoard,
  addApp,
  addText,
  openLink,
  telegramToWeb,
  onError,
}: {
  view: FilesView;
  host: HTMLDivElement | null;
  interactive: boolean;
  readOnly: boolean;
  selected: string[];
  select: (id: string) => void;
  beginPointer: (event: globalThis.PointerEvent) => void;
  update: (o: CanvasObject) => void;
  addToBoard: (items: FileBoardItem[], asIcons: boolean, from: CanvasObject) => void;
  addApp: (w: DesktopWindow, from: CanvasObject) => void;
  addText: (text: string, from: CanvasObject) => void;
  openLink: (url: string) => void;
  telegramToWeb: (o: CanvasObject) => void;
  onError: (message: string) => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  if (!watchesReset) {
    // Watches left by an earlier page load of this window; sent before any
    // frame asks for its own, so the app handles it first.
    watchesReset = true;
    void bridge()
      ?.reset()
      .catch(() => {});
  }
  const shared: Shared = {
    host,
    overlay: () => overlay.current,
    readOnly,
    select,
    forward: (event) => {
      event.preventDefault();
      beginPointer(event.nativeEvent);
    },
    update: (o) => {
      if (!readOnly && !o.locked) update(o);
    },
    addToBoard,
    onError,
  };
  return (
    <div
      ref={overlay}
      className="canvas-files"
      data-interactive={interactive}
      onWheel={(event) => forwardWheel(host, event.nativeEvent, { overlay: event.currentTarget })}
    >
      {view.objects.map((o) =>
        o.file?.kind === 'desktops' ? (
          <DesktopsCard
            key={o.id}
            object={o}
            camera={view.camera}
            active={selected.includes(o.id)}
            host={host}
            select={select}
            forward={shared.forward}
            onError={onError}
            openMenu={setMenu}
            addAppIcon={(exe, name) =>
              readOnly ? undefined : addToBoard([{ path: exe, name, folder: false }], true, o)
            }
            addAppFrame={(w) => (readOnly ? undefined : addApp(w, o))}
          />
        ) : o.file?.kind === 'telegram' ? (
          <TelegramCard
            key={o.id}
            object={o}
            camera={view.camera}
            active={selected.includes(o.id)}
            host={host}
            select={select}
            forward={shared.forward}
            actions={{
              onError,
              openMenu: setMenu,
              addFiles: (items) =>
                readOnly
                  ? undefined
                  : addToBoard(
                      items.map((item) => ({ ...item, folder: false })),
                      false,
                      o,
                    ),
              addText: (text) => (readOnly ? undefined : addText(text, o)),
              openLink,
              useWeb: readOnly ? undefined : () => telegramToWeb(o),
            }}
          />
        ) : o.file?.kind === 'app' ? (
          <AppFrame
            key={o.id}
            object={o}
            camera={view.camera}
            active={selected.includes(o.id)}
            host={host}
            select={select}
            forward={shared.forward}
            onError={onError}
          />
        ) : o.file?.kind === 'file' ? (
          <FileTile
            key={o.id}
            object={o}
            camera={view.camera}
            active={selected.includes(o.id)}
            shared={shared}
          />
        ) : (
          <FolderCard
            key={o.id}
            object={o}
            camera={view.camera}
            active={selected.includes(o.id)}
            shared={shared}
            openMenu={setMenu}
          />
        ),
      )}
      {menu &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={menu.items}
            header={menu.header}
            placement="pointer"
            onClose={() => setMenu(null)}
          />,
          document.body,
        )}
    </div>
  );
}

// The board's own double-click and the tile's may both report one double-click.
const lastOpened = new Map<string, number>();
/** Opens a file tile's file or app with Windows (a folder in Explorer). */
export function openFileObject(o: CanvasObject, onError: (message: string) => void) {
  const files = bridge();
  if (!files || !o.file) return;
  const now = Date.now();
  if (now - (lastOpened.get(o.id) || 0) < 700) return;
  lastOpened.set(o.id, now);
  void files
    .list({ source: sourceOf(o.file) })
    .then((listing) => {
      if (listing.state === 'missing') throw Error(`“${listing.label}” isn’t on this computer.`);
      return files.open({ path: listing.dir });
    })
    .catch((error) => onError(message(error)));
}

/** A folder frame's folder opened in Explorer, or a tile's file shown in its folder. */
export function showFileObject(o: CanvasObject, onError: (message: string) => void) {
  const files = bridge();
  if (!files || !o.file) return;
  void files
    .list({ source: sourceOf(o.file) })
    .then((listing) => {
      if (listing.state === 'missing') throw Error(`“${listing.label}” isn’t on this computer.`);
      return listing.state === 'folder'
        ? files.open({ path: listing.dir })
        : files.reveal({ path: listing.dir });
    })
    .catch((error) => onError(message(error)));
}

/** The folder frame under a screen point, for board pictures dropped into it. */
export function folderDropAt(clientX: number, clientY: number): { id: string; dir: string } | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const frame = (element as HTMLElement).closest<HTMLElement>('.canvas-folder');
    if (!frame?.dataset.dir || !frame.dataset.fileId) continue;
    const item = (element as HTMLElement).closest<HTMLElement>('[data-path]');
    const folder = item && item.dataset.folder === 'true' ? item.dataset.path! : null;
    return { id: frame.dataset.fileId, dir: folder || frame.dataset.dir };
  }
  return null;
}
/** Marks the folder frame a board drag would drop into. */
export function markFolderDrop(id: string | null) {
  for (const element of document.querySelectorAll<HTMLElement>('.canvas-folder[data-board-drop]'))
    if (element.dataset.fileId !== id) delete element.dataset.boardDrop;
  if (id) {
    const element = document.querySelector<HTMLElement>(
      `.canvas-folder[data-file-id="${CSS.escape(id)}"]`,
    );
    if (element) element.dataset.boardDrop = 'true';
  }
}
