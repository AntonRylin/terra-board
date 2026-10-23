// Android home screen (docs/android.md): every board and folder in one list, as
// phones and tablets expect, in place of the desktop's board panel. Boards open
// full screen; the back button beside the board name returns here.
import { useEffect, useState, type MouseEvent } from 'react';
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  KeyRound,
  MoreVertical,
  Plus,
  Search,
  Settings,
  SquarePlus,
} from 'lucide-react';
import type { Board, Folder, Library, SharingMark } from '../model';
import { AppIcon } from './Launcher';
import './mobile-home.css';

const OPEN_FOLDERS = 'terra-board.home-open-folders';

function readOpen(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_FOLDERS) || '[]');
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function edited(time: number, now = Date.now()) {
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return 'Edited just now';
  if (minutes < 60) return `Edited ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Edited ${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Edited yesterday';
  if (days < 7) return `Edited ${days} days ago`;
  return (
    'Edited ' + new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  );
}

function shareLine(mark?: SharingMark) {
  if (!mark) return '';
  return mark.shared === 'owner' ? 'Shared by you' : `Shared by ${mark.owner || 'someone'}`;
}

interface Props {
  library: Library;
  // A folder just created or asked for: shown open.
  opened: string | null;
  onOpen: (id: string) => void;
  onBoardMenu: (b: Board, x: number, y: number) => void;
  onFolderMenu: (f: Folder, x: number, y: number) => void;
  onNewBoard: (folderId: string | null) => void;
  onNewFolder: () => void;
  onJoin: () => void;
  onSearch: () => void;
  onSettings: () => void;
}

export default function MobileHome(p: Props) {
  const [open, setOpen] = useState(readOpen);
  const [sheet, setSheet] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (p.opened && !open.includes(p.opened)) setOpen((o) => [...o, p.opened!]);
  }, [p.opened]);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_FOLDERS, JSON.stringify(open));
    } catch {}
  }, [open]);
  // The system back button closes the sheet first (src/mobile/index.ts sends Escape).
  useEffect(() => {
    if (!sheet) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setSheet(false);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [sheet]);

  const boards = p.library.boards.filter((b) => !b.trashed);
  const sharing = p.library.sharing;
  const markOf = (b: Board) =>
    sharing?.boards[b.id] || (b.folderId ? sharing?.folders[b.folderId] : undefined);
  const items = [
    ...boards.filter((b) => !b.folderId).map((b) => ({ kind: 'board' as const, item: b })),
    ...p.library.folders.map((f) => ({ kind: 'folder' as const, item: f })),
  ].sort((a, b) => a.item.position - b.item.position);
  // Recent boards only help once the list is longer than a screen's glance.
  const recent =
    boards.length > 4 ? [...boards].sort((a, b) => b.updated - a.updated).slice(0, 3) : [];
  const menuAt = (e: MouseEvent, show: (x: number, y: number) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    show(
      e.type === 'contextmenu' ? e.clientX : r.right,
      e.type === 'contextmenu' ? e.clientY : r.bottom,
    );
  };

  const boardRow = (b: Board, nested = false) => {
    const mark = markOf(b);
    return (
      <div
        key={b.id}
        className={'home-row' + (nested ? ' nested' : '')}
        role="button"
        tabIndex={0}
        data-item={b.id}
        onClick={() => p.onOpen(b.id)}
        onKeyDown={(e) => e.key === 'Enter' && p.onOpen(b.id)}
        onContextMenu={(e) => menuAt(e, (x, y) => p.onBoardMenu(b, x, y))}
      >
        <AppIcon board={b} shared={mark} />
        <span className="home-text">
          <span className="home-name">{b.name}</span>
          <span className="home-meta">
            {[shareLine(mark), edited(b.updated, now)].filter(Boolean).join(' · ')}
          </span>
        </span>
        <button
          type="button"
          className="home-more"
          aria-label={'More for ' + b.name}
          onClick={(e) => menuAt(e, (x, y) => p.onBoardMenu(b, x, y))}
        >
          <MoreVertical size={20} />
        </button>
      </div>
    );
  };

  const folderRow = (f: Folder) => {
    const inside = boards
      .filter((b) => b.folderId === f.id)
      .sort((a, b) => a.position - b.position);
    const expanded = open.includes(f.id);
    const mark = sharing?.folders[f.id];
    const toggle = () =>
      setOpen((o) => (o.includes(f.id) ? o.filter((id) => id !== f.id) : [...o, f.id]));
    return (
      <div key={f.id} className="home-folder" data-open={expanded || undefined}>
        <div
          className="home-row"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          data-item={f.id}
          onClick={toggle}
          onKeyDown={(e) => e.key === 'Enter' && toggle()}
          onContextMenu={(e) => menuAt(e, (x, y) => p.onFolderMenu(f, x, y))}
        >
          <span className="app-icon gray home-folder-icon">
            <FolderIcon size={19} strokeWidth={1.6} />
          </span>
          <span className="home-text">
            <span className="home-name">
              {f.name}
              <ChevronRight className="home-chevron" size={17} aria-hidden="true" />
            </span>
            <span className="home-meta">
              {[shareLine(mark), inside.length === 1 ? '1 board' : `${inside.length} boards`]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <button
            type="button"
            className="home-more"
            aria-label={'More for ' + f.name}
            onClick={(e) => menuAt(e, (x, y) => p.onFolderMenu(f, x, y))}
          >
            <MoreVertical size={20} />
          </button>
        </div>
        {expanded && (
          <div className="home-folder-boards">
            {inside.map((b) => boardRow(b, true))}
            <button
              type="button"
              className="home-row nested home-add"
              onClick={() => p.onNewBoard(f.id)}
            >
              <span className="home-add-icon">
                <Plus size={18} />
              </span>
              <span className="home-name">New board in {f.name}</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  const choose = (action: () => void) => {
    setSheet(false);
    action();
  };

  return (
    <main className="mobile-home">
      <header className="home-header">
        <h1>Your boards</h1>
        <button type="button" className="home-icon-button" aria-label="Search" onClick={p.onSearch}>
          <Search size={21} />
        </button>
        <button
          type="button"
          className="home-icon-button"
          aria-label="Settings"
          onClick={p.onSettings}
        >
          <Settings size={21} />
        </button>
      </header>
      <div className="home-list">
        {recent.length > 0 && (
          <section aria-label="Recent">
            <h2>Recent</h2>
            {recent.map((b) => boardRow(b))}
          </section>
        )}
        <section aria-label="All boards">
          {recent.length > 0 && <h2>All</h2>}
          {items.map((entry) =>
            entry.kind === 'board' ? boardRow(entry.item) : folderRow(entry.item),
          )}
          {!items.length && <p className="home-empty">No boards yet. Tap New to start one.</p>}
        </section>
      </div>
      <button type="button" className="home-new" onClick={() => setSheet(true)}>
        <Plus size={20} />
        New
      </button>
      {sheet && (
        <div className="home-sheet-backdrop" onClick={() => setSheet(false)}>
          <div
            className="home-sheet"
            role="dialog"
            aria-label="New"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="home-sheet-handle" aria-hidden="true" />
            <button type="button" onClick={() => choose(() => p.onNewBoard(null))}>
              <span className="home-add-icon">
                <SquarePlus size={20} />
              </span>
              New board
            </button>
            <button type="button" onClick={() => choose(p.onNewFolder)}>
              <span className="home-add-icon">
                <FolderPlus size={20} />
              </span>
              New folder
            </button>
            <button type="button" onClick={() => choose(p.onJoin)}>
              <span className="home-add-icon">
                <KeyRound size={20} />
              </span>
              <span className="home-text">
                <span className="home-name">Join with a code</span>
                <span className="home-meta">Open a board someone shared with you</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
