import { useEffect, useLayoutEffect, useRef } from 'react';
import { Search, Plus, MoreHorizontal, X, Folder as FolderIcon } from 'lucide-react';
import type { Board, Folder, Library } from '../model';
import { Presence } from './Presence';
import { BoardGlyph } from './Icon';
import InlineName from './InlineName';
import { useLauncherDock, type DockEdge } from './useLauncherDock';
export function AppIcon({ board }: { board: Board }) {
  return (
    <span className={'app-icon ' + board.color + ' shape-' + (board.iconShape || 'rounded')}>
      <BoardGlyph name={board.icon} />
    </span>
  );
}
interface Props {
  dockEdge: DockEdge;
  onDock: (edge: DockEdge) => void;
  library: Library;
  active: string | null;
  opened: string | null;
  onOpen: (id: string) => void;
  onFolder: (id: string | null) => void;
  onCreate: (x: number, y: number) => void;
  onSearch: () => void;
  onOptions: (x: number, y: number) => void;
  onBoardMenu: (b: Board, x: number, y: number) => void;
  onIconDrop: (b: Board, file: File) => void;
  onFolderMenu: (f: Folder, x: number, y: number) => void;
  onMove: (id: string, folderId: string | null, position?: number) => void;
  onReorderFolder: (id: string, position: number) => void;
  onNewBoard: (folderId: string) => void;
  onRenameBoard: (id: string, name: string) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  renameFolderRequest: { id: string; token: number } | null;
}
export default function Launcher(p: Props) {
  const rail = useRef<HTMLElement>(null),
    sheet = useRef<HTMLDivElement>(null);
  const dock = useLauncherDock(rail, p.dockEdge, p.onDock, () => p.onFolder(null));
  const horizontal = p.dockEdge === 'top' || p.dockEdge === 'bottom';
  const boards = p.library.boards.filter((b) => !b.trashed);
  const items = [
    ...boards.filter((b) => !b.folderId).map((b) => ({ kind: 'board', item: b })),
    ...p.library.folders.map((f) => ({ kind: 'folder', item: f })),
  ].sort((a, b) => a.item.position - b.item.position);
  const folder = p.library.folders.find((f) => f.id === p.opened);
  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      if (
        !rail.current?.contains(e.target as Node) &&
        !sheet.current?.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest('.context-menu,.modal-backdrop')
      )
        p.onFolder(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onFolder(null);
    };
    if (folder) {
      window.addEventListener('pointerdown', dismiss);
      window.addEventListener('keydown', key);
    }
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', key);
    };
  }, [folder?.id]);
  useLayoutEffect(() => {
    if (!folder || !sheet.current || !rail.current) return;
    const panel = sheet.current,
      strip = rail.current;
    const place = () => {
      const anchor = strip.querySelector(`[data-item="${folder.id}"]`)?.getBoundingClientRect();
      if (!anchor) return;
      const r = strip.getBoundingClientRect();
      const width = panel.offsetWidth,
        height = panel.offsetHeight;
      let x = horizontal
        ? anchor.left - 12
        : p.dockEdge === 'right'
          ? r.left - width - 12
          : r.right + 12;
      let y = horizontal
        ? p.dockEdge === 'top'
          ? r.bottom + 12
          : r.top - height - 12
        : anchor.top - 5;
      panel.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener('resize', place);
    strip.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      strip.removeEventListener('scroll', place, true);
    };
  }, [folder?.id, p.dockEdge, horizontal]);
  const drag = (e: React.DragEvent, id: string, kind = 'board') => {
    e.dataTransfer.setData('application/x-local-canvas', JSON.stringify({ id, kind }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropIcon = (e: React.DragEvent, board: Board) => {
    const file = e.dataTransfer.files[0];
    if (!file) return false;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('drop-target');
    p.onIconDrop(board, file);
    return true;
  };
  const iconDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    e.currentTarget.classList.add('drop-target');
  };
  const drop = (
    e: React.DragEvent,
    fid: string | null,
    target?: { kind: string; position: number },
  ) => {
    e.preventDefault();
    e.currentTarget.classList.remove('drop-target');
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/x-local-canvas'));
      if (data.kind === 'board')
        p.onMove(data.id, fid, target?.kind === 'board' ? target.position - 0.5 : undefined);
      else if (data.kind === 'folder' && target) p.onReorderFolder(data.id, target.position - 0.5);
    } catch {}
  };
  return (
    <>
      {dock.target && <div className="dock-preview" data-edge={dock.target} aria-hidden="true" />}
      {dock.floating && (
        <div className="dock-hint" role="status">
          {dock.target ? `Release to dock ${dock.target}` : 'Drag to an edge to dock'}
          <span>Esc to cancel</span>
        </div>
      )}
      <aside
        ref={rail}
        className={'launcher' + (dock.floating ? ' is-dragging' : '')}
        style={dock.floating || undefined}
        aria-label="Boards and folders"
        title="Drag empty space to move this panel"
        {...dock.handlers}
      >
        <div className="launcher-top">
          <button
            className="icon-button"
            aria-label="Search boards"
            title="Search boards · Ctrl+K"
            onClick={p.onSearch}
          >
            <Search size={19} />
          </button>
        </div>
        <div
          className="launcher-scroll"
          onWheel={(e) => {
            if (horizontal && Math.abs(e.deltaY) > Math.abs(e.deltaX))
              e.currentTarget.scrollLeft += e.deltaY;
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            if (e.target === e.currentTarget) drop(e, null);
          }}
        >
          {items.map(({ kind, item }) => {
            const isFolder = kind === 'folder',
              b = item as Board,
              active = isFolder
                ? boards.some((b) => b.folderId === item.id && b.id === p.active)
                : p.active === item.id;
            const children = isFolder ? boards.filter((b) => b.folderId === item.id) : [];
            return (
              <button
                key={item.id}
                data-item={item.id}
                className={
                  'launch-item ' +
                  (active ? 'active ' : '') +
                  (p.opened === item.id ? 'opened' : '')
                }
                title={item.name}
                aria-label={(isFolder ? 'Open folder ' : 'Open board ') + item.name}
                aria-expanded={isFolder ? p.opened === item.id : undefined}
                aria-pressed={isFolder ? undefined : active}
                draggable
                onDragStart={(e) => drag(e, item.id, kind)}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.add('drop-target');
                  if (!isFolder) iconDragOver(e);
                }}
                onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
                onDrop={(e) => {
                  if (!isFolder && dropIcon(e, b)) return;
                  drop(e, isFolder ? item.id : null, { kind, position: item.position });
                }}
                onClick={() =>
                  isFolder ? p.onFolder(p.opened === item.id ? null : item.id) : p.onOpen(item.id)
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  isFolder
                    ? p.onFolderMenu(item as Folder, e.clientX, e.clientY)
                    : p.onBoardMenu(b, e.clientX, e.clientY);
                }}
                onKeyDown={(e) => {
                  const next = horizontal ? 'ArrowRight' : 'ArrowDown';
                  const previous = horizontal ? 'ArrowLeft' : 'ArrowUp';
                  if (e.key === next || e.key === previous) {
                    e.preventDefault();
                    const buttons = [
                        ...rail.current!.querySelectorAll<HTMLButtonElement>('[data-item]'),
                      ],
                      i = buttons.indexOf(e.currentTarget);
                    buttons[i + (e.key === next ? 1 : -1)]?.focus();
                  }
                }}
              >
                {isFolder ? (
                  <span className="app-icon folder-mosaic">
                    {children.length ? (
                      children
                        .slice(0, 9)
                        .map((b) => <span key={b.id} className={'mini ' + b.color} />)
                    ) : (
                      <FolderIcon size={18} />
                    )}
                  </span>
                ) : (
                  <AppIcon board={b} />
                )}
              </button>
            );
          })}
          <div className="launcher-create">
            <button
              className="icon-button create-button"
              aria-label="Create"
              title="Create board or folder"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                p.onCreate(
                  p.dockEdge === 'right' ? r.left - 232 : r.right + 12,
                  p.dockEdge === 'top' ? r.bottom + 12 : r.top,
                );
              }}
            >
              <Plus size={20} />
            </button>
          </div>
        </div>
        <div className="launcher-footer">
          <button
            className="icon-button"
            aria-label="Library options"
            title="Library options"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              p.onOptions(
                p.dockEdge === 'right' ? r.left - 232 : r.right + 12,
                p.dockEdge === 'top' ? r.bottom + 12 : r.top,
              );
            }}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
      </aside>
      <Presence show={!!folder}>
        {folder && (
          <div
            ref={sheet}
            className="folder-sheet"
            role="dialog"
            aria-label={folder.name + ' folder'}
          >
            <header>
              <h2>
                <InlineName
                  key={folder.id}
                  value={folder.name}
                  label="Folder name"
                  editRequest={
                    p.renameFolderRequest?.id === folder.id ? p.renameFolderRequest.token : 0
                  }
                  onCommit={(name) => p.onRenameFolder(folder.id, name)}
                />
              </h2>
              <button
                className="icon-button"
                aria-label="Folder options"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  p.onFolderMenu(folder, r.left, r.bottom + 6);
                }}
              >
                <MoreHorizontal size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="Close folder"
                onClick={() => p.onFolder(null)}
              >
                <X size={17} />
              </button>
            </header>
            <div
              className="folder-grid"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => drop(e, folder.id)}
            >
              {boards
                .filter((b) => b.folderId === folder.id)
                .sort((a, b) => a.position - b.position)
                .map((b) => (
                  <div
                    key={b.id}
                    className="folder-board"
                    title={b.name}
                    draggable
                    onDragStart={(e) => drag(e, b.id)}
                    onDragOver={iconDragOver}
                    onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
                    onDrop={(e) => {
                      dropIcon(e, b);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      p.onBoardMenu(b, e.clientX, e.clientY);
                    }}
                  >
                    <button
                      className="folder-board-open"
                      aria-label={'Open board ' + b.name}
                      onClick={() => p.onOpen(b.id)}
                    >
                      <AppIcon board={b} />
                    </button>
                    <InlineName
                      value={b.name}
                      label={'Board name in folder: ' + b.name}
                      onCommit={(name) => p.onRenameBoard(b.id, name)}
                    />
                  </div>
                ))}
            </div>
            {!boards.some((b) => b.folderId === folder.id) && (
              <p className="quiet empty-folder">Add your first board.</p>
            )}
            <button
              className="icon-button folder-add"
              aria-label="New board in folder"
              onClick={() => p.onNewBoard(folder.id)}
            >
              <Plus size={20} />
            </button>
          </div>
        )}
      </Presence>
    </>
  );
}
