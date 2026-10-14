import { useEffect, useLayoutEffect, useRef } from 'react';
import { Plus, MoreHorizontal, X, Folder as FolderIcon, Users } from 'lucide-react';
import type { Board, Folder, Library, SharingMark } from '../model';
import { Presence } from './Presence';
import { BoardGlyph } from './Icon';
import InlineName from './InlineName';
import LauncherTooltip from './LauncherTooltip';
import { useLauncherDock, type DockEdge } from './useLauncherDock';
import { useLauncherReorder } from './useLauncherReorder';
import { useLauncherAlignment } from './useLauncherAlignment';
import type { MenuPlacement } from './Dialogs';
export function ShareBadge({ mark }: { mark?: SharingMark }) {
  if (!mark) return null;
  return (
    <span
      className="share-badge"
      data-shared={mark.shared}
      title={mark.shared === 'owner' ? 'Shared by you' : `Shared by ${mark.owner || 'someone'}`}
    >
      <Users size={9} strokeWidth={2.5} />
    </span>
  );
}
export function AppIcon({ board, shared }: { board: Board; shared?: SharingMark }) {
  return (
    <span className={'app-icon ' + board.color + ' shape-' + (board.iconShape || 'rounded')}>
      <BoardGlyph
        name={board.icon}
        boardName={board.name}
        showInitial={board.showInitial !== false}
      />
      <ShareBadge mark={shared} />
    </span>
  );
}
interface Props {
  hidden: boolean;
  minimal: boolean;
  dockEdge: DockEdge;
  centered: boolean;
  onDock: (edge: DockEdge) => void;
  library: Library;
  active: string | null;
  opened: string | null;
  onOpen: (id: string) => void;
  onFolder: (id: string | null) => void;
  onCreate: (x: number, y: number) => void;
  onPanelMenu: (x: number, y: number, placement: MenuPlacement) => void;
  onBoardMenu: (b: Board, x: number, y: number) => void;
  onIconDrop: (b: Board, file: File) => void;
  onFolderMenu: (f: Folder, x: number, y: number) => void;
  onMove: (id: string, folderId: string | null, position?: number) => Promise<void>;
  onReorderFolder: (id: string, position: number) => Promise<void>;
  onNewBoard: (folderId: string) => void;
  onRenameBoard: (id: string, name: string) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  renameFolderRequest: { id: string; token: number } | null;
}
export default function Launcher(p: Props) {
  const rail = useRef<HTMLElement>(null),
    sheet = useRef<HTMLDivElement>(null);
  const dock = useLauncherDock(rail, p.dockEdge, p.onDock, () => p.onFolder(null));
  useLauncherAlignment(rail, p.centered, p.dockEdge);
  const horizontal = p.dockEdge === 'top' || p.dockEdge === 'bottom';
  const reorder = useLauncherReorder(p.library, async (change) => {
    if (change.kind === 'folder') await p.onReorderFolder(change.id, change.position!);
    else
      await p.onMove(
        change.id,
        change.folder || (change.group === 'root' ? null : change.group),
        change.folder ? undefined : change.position,
      );
  });
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
    let frame = 0;
    const followAlignment = () => {
      place();
      if (
        strip
          .getAnimations({ subtree: true })
          .some((a) => a.id === 'launcher-alignment' && a.playState === 'running')
      )
        frame = requestAnimationFrame(followAlignment);
    };
    frame = requestAnimationFrame(followAlignment);
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    observer.observe(strip);
    window.addEventListener('resize', place);
    strip.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', place);
      strip.removeEventListener('scroll', place, true);
    };
  }, [folder?.id, p.dockEdge, horizontal, p.centered, p.minimal]);
  // Boards and folders sort by pointer; HTML drops here are only image files.
  const dropIcon = (e: React.DragEvent, board: Board) => {
    e.currentTarget.classList.remove('drop-target');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    p.onIconDrop(board, file);
  };
  const iconDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    e.currentTarget.classList.add('drop-target');
  };
  const ignoreDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <>
      {!p.hidden && (
        <LauncherTooltip key={`${p.dockEdge}-${p.opened}-${p.active}`} edge={p.dockEdge} />
      )}
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
        data-minimal={p.minimal || undefined}
        style={dock.floating || undefined}
        aria-label="Boards and folders"
        aria-hidden={p.hidden || undefined}
        inert={p.hidden || undefined}
        title="Drag empty space to move this panel"
        {...dock.handlers}
        onContextMenu={(e) => {
          if (e.defaultPrevented) return;
          e.preventDefault();
          p.onPanelMenu(e.clientX, e.clientY, 'pointer');
        }}
      >
        <div
          className="launcher-scroll"
          data-reorder-group="root"
          onWheel={(e) => {
            if (horizontal && Math.abs(e.deltaY) > Math.abs(e.deltaX))
              e.currentTarget.scrollLeft += e.deltaY;
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={ignoreDrop}
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
                data-reorder-id={item.id}
                data-reorder-kind={kind}
                data-order={item.position}
                style={reorder.style(item.id)}
                className={
                  'launch-item ' +
                  (reorder.source === item.id ? 'reorder-source ' : '') +
                  (reorder.folder === item.id ? 'drop-target ' : '') +
                  (active ? 'active ' : '') +
                  (p.opened === item.id ? 'opened' : '')
                }
                title=""
                data-launcher-label={item.name}
                aria-label={(isFolder ? 'Open folder ' : 'Open board ') + item.name}
                aria-expanded={isFolder ? p.opened === item.id : undefined}
                aria-pressed={isFolder ? undefined : active}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                onPointerDown={(e) => reorder.start(e, item.id, kind)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!isFolder) iconDragOver(e);
                }}
                onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
                onDrop={(e) => {
                  if (!isFolder) dropIcon(e, b);
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
                    <ShareBadge mark={p.library.sharing?.folders[item.id]} />
                  </span>
                ) : (
                  <AppIcon board={b} shared={p.library.sharing?.boards[b.id]} />
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
              data-reorder-group={folder.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={ignoreDrop}
            >
              {boards
                .filter((b) => b.folderId === folder.id)
                .sort((a, b) => a.position - b.position)
                .map((b) => (
                  <div
                    key={b.id}
                    className={'folder-board' + (reorder.source === b.id ? ' reorder-source' : '')}
                    data-reorder-id={b.id}
                    data-reorder-kind="board"
                    data-order={b.position}
                    style={reorder.style(b.id)}
                    draggable={false}
                    onDragStart={(e) => e.preventDefault()}
                    onPointerDown={(e) => reorder.start(e, b.id, 'board')}
                    onDragOver={iconDragOver}
                    onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
                    onDrop={(e) => dropIcon(e, b)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      p.onBoardMenu(b, e.clientX, e.clientY);
                    }}
                  >
                    <button
                      className="folder-board-open"
                      data-launcher-label={b.name}
                      aria-label={'Open board ' + b.name}
                      onClick={() => p.onOpen(b.id)}
                    >
                      <AppIcon board={b} shared={p.library.sharing?.boards[b.id]} />
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
