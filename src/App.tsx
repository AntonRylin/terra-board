import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Palette,
  Copy,
  FolderInput,
  Download,
  Upload,
  Trash2,
  Undo2,
  Search,
  Keyboard,
  FolderOpen,
  Check,
  AlertCircle,
  LoaderCircle,
  ImagePlus,
  Folder as FolderIcon,
} from 'lucide-react';
import type { Board, Document, Folder, Library } from './model';
import { desktop, exportPortable, importPortable, invoke } from './bridge';
import type { SaveState } from './canvas/save-queue';
import Launcher, { AppIcon } from './components/Launcher';
import InlineName, { flushInlineNames } from './components/InlineName';
import Whiteboard, { type WhiteboardHandle } from './components/Whiteboard';
import BoardIconImage, { type BoardIconImageHandle } from './components/BoardIconImage';
import { BoardGlyph, iconNames } from './components/Icon';
import { Presence } from './components/Presence';
import { ContextMenu, Modal, type MenuItem } from './components/Dialogs';
import { readDockEdge } from './components/useLauncherDock';
type ModalState = {
  kind:
    | 'new-board'
    | 'new-folder'
    | 'rename-board'
    | 'rename-folder'
    | 'icon'
    | 'move'
    | 'search'
    | 'trash'
    | 'help';
  id?: string;
  folderId?: string | null;
};
export default function App() {
  const [dockEdge, setDockEdge] = useState(readDockEdge);
  const [library, setLibrary] = useState<Library>({ boards: [], folders: [], lastBoard: null }),
    [doc, setDoc] = useState<Document | null>(null),
    [opened, setOpened] = useState<string | null>(null),
    [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | null)[] } | null>(null),
    [modal, setModal] = useState<ModalState | null>(null),
    [name, setName] = useState(''),
    [glyph, setGlyph] = useState('lightbulb'),
    [color, setColor] = useState('blue'),
    [destination, setDestination] = useState(''),
    [search, setSearch] = useState(''),
    [saveState, setSaveState] = useState<SaveState>('saved'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [renameRequest, setRenameRequest] = useState<{
    kind: 'board' | 'folder';
    id: string;
    token: number;
  } | null>(null);
  const iconImage = useRef<BoardIconImageHandle>(null);
  const whiteboard = useRef<WhiteboardHandle>(null),
    request = useRef(0),
    noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const report = useCallback((message: string) => {
    setError(message.replace(/^Error: /, ''));
  }, []);
  const notify = (message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 3000);
  };
  const refresh = async () => {
    const l = await invoke<Library>('library');
    setLibrary(l);
    return l;
  };
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      report(e instanceof Error ? e.message : String(e));
    }
  };
  const openBoard = async (id: string) => {
    const n = ++request.current;
    try {
      await flushInlineNames();
      await whiteboard.current?.flush();
      if (n !== request.current) return;
      const d = await invoke<Document>('loadBoard', { id });
      if (n !== request.current) return;
      setDoc(d);
      setOpened(null);
      setSaveState('saved');
      await invoke('setLastBoard', { id });
    } catch (e) {
      report(String(e));
    }
  };
  useEffect(() => {
    run(async () => {
      const l = await refresh();
      const first =
        l.boards.find((b) => b.id === l.lastBoard && !b.trashed) ||
        l.boards.find((b) => !b.trashed);
      if (first) await openBoard(first.id);
      if (l.backupError)
        report('The automatic metadata snapshot could not be created: ' + l.backupError);
    }).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch('');
        setModal({ kind: 'search' });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    const cleanup = window.canvas?.onClose(async () => {
      try {
        await flushInlineNames();
        await whiteboard.current?.flush();
        window.canvas!.closeReady();
      } catch (e) {
        report('The window stayed open because changes could not be saved. ' + String(e));
      }
    });
    return cleanup;
  }, []);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!desktop && saveState !== 'saved') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [saveState]);
  const ask = (state: ModalState, initial = '') => {
    setName(initial);
    setModal(state);
    setMenu(null);
  };
  const change = async (id: string, patch: Record<string, unknown>) => {
    await invoke('updateBoard', { id, patch });
    const l = await refresh();
    setDoc((d) => (d?.board.id === id ? { ...d, board: l.boards.find((b) => b.id === id)! } : d));
  };
  const renameFolder = async (id: string, name: string) => {
    await invoke('updateFolder', { id, patch: { name } });
    await refresh();
  };
  const beginRename = (kind: 'board' | 'folder', id: string) => {
    setMenu(null);
    if (kind === 'folder') {
      setOpened(id);
      setRenameRequest({ kind, id, token: performance.now() });
    } else
      run(async () => {
        if (doc?.board.id !== id) await openBoard(id);
        setRenameRequest({ kind, id, token: performance.now() });
      });
  };
  const exportBoard = (id: string) =>
    run(async () => {
      await whiteboard.current?.flush();
      if (await exportPortable(id)) notify('Board and media exported');
    });
  const duplicate = (id: string) =>
    run(async () => {
      await whiteboard.current?.flush();
      const b = await invoke<Board>('duplicateBoard', { id });
      await refresh();
      await openBoard(b.id);
      notify('Board duplicated');
    });
  const trash = (id: string) =>
    run(async () => {
      await whiteboard.current?.flush();
      await change(id, { trashed: true });
      if (doc?.board.id === id) {
        const l = await refresh(),
          next = l.boards.find((b) => !b.trashed);
        if (next) await openBoard(next.id);
        else setDoc(null);
      }
      notify('Moved to Trash');
    });
  const importBoard = () =>
    run(async () => {
      await whiteboard.current?.flush();
      setBusy(true);
      try {
        const b = await importPortable();
        if (b) {
          await refresh();
          await openBoard(b.id);
          notify('Board imported');
        }
      } finally {
        setBusy(false);
      }
    });
  const boardMenu = (b: Board, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: 'Open', action: () => openBoard(b.id) },
        null,
        {
          label: 'Rename',
          icon: <Pencil />,
          action: () => beginRename('board', b.id),
        },
        {
          label: 'Change icon',
          icon: <Palette />,
          action: () => {
            setGlyph(b.icon);
            setColor(b.color);
            ask({ kind: 'icon', id: b.id });
          },
        },
        { label: 'Duplicate', icon: <Copy />, action: () => duplicate(b.id) },
        {
          label: 'Move to…',
          icon: <FolderInput />,
          action: () => {
            setDestination(b.folderId || '');
            ask({ kind: 'move', id: b.id });
          },
        },
        null,
        { label: 'Export / share a copy…', icon: <Download />, action: () => exportBoard(b.id) },
        null,
        { label: 'Move to Trash', icon: <Trash2 />, danger: true, action: () => trash(b.id) },
      ],
    });
  const folderMenu = (f: Folder, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        {
          label: 'Rename folder',
          icon: <Pencil />,
          action: () => beginRename('folder', f.id),
        },
        {
          label: 'New board',
          icon: <Plus />,
          action: () => ask({ kind: 'new-board', folderId: f.id }, 'Untitled'),
        },
        null,
        {
          label: 'Ungroup folder',
          icon: <FolderOpen />,
          action: () =>
            run(async () => {
              await invoke('removeFolder', { id: f.id });
              setOpened(null);
              await refresh();
              notify('Boards moved to the icon strip');
            }),
        },
      ],
    });
  const newMenu = (x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        {
          label: 'New board',
          icon: <Plus />,
          action: () => ask({ kind: 'new-board', folderId: opened }, 'Untitled'),
        },
        {
          label: 'New folder',
          icon: <FolderPlus />,
          action: () => ask({ kind: 'new-folder' }, 'Untitled folder'),
        },
        null,
        { label: 'Import board…', icon: <Upload />, action: importBoard },
      ],
    });
  const libraryMenu = (x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        {
          label: 'Search boards',
          icon: <Search />,
          action: () => {
            setSearch('');
            ask({ kind: 'search' });
          },
        },
        { label: 'Import board…', icon: <Upload />, action: importBoard },
        null,
        { label: 'Trash', icon: <Trash2 />, action: () => ask({ kind: 'trash' }) },
        { label: 'Keyboard shortcuts', icon: <Keyboard />, action: () => ask({ kind: 'help' }) },
      ],
    });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!modal || busy) return;
    setBusy(true);
    try {
      if (modal.kind === 'new-board') {
        await whiteboard.current?.flush();
        const b = await invoke<Board>('createBoard', { name, folderId: modal.folderId || null });
        await refresh();
        await openBoard(b.id);
      } else if (modal.kind === 'new-folder') {
        const f = await invoke<Folder>('createFolder', { name });
        await refresh();
        setOpened(f.id);
      } else if (modal.kind === 'rename-board') await change(modal.id!, { name });
      else if (modal.kind === 'rename-folder') {
        await invoke('updateFolder', { id: modal.id, patch: { name } });
        await refresh();
      } else if (modal.kind === 'icon')
        await change(modal.id!, { icon: (await iconImage.current?.save()) || glyph, color });
      else if (modal.kind === 'move') await change(modal.id!, { folderId: destination || null });
      setModal(null);
    } catch (e) {
      report(String(e));
    } finally {
      setBusy(false);
    }
  }
  const modalTitle: Record<ModalState['kind'], string> = {
    'new-board': 'New board',
    'new-folder': 'New folder',
    'rename-board': 'Rename board',
    'rename-folder': 'Rename folder',
    icon: 'Board icon',
    move: 'Move board',
    search: 'Search boards',
    trash: 'Trash',
    help: 'Make yourself at home',
  };
  return (
    <div className="app-shell" data-dock={dockEdge}>
      <Launcher
        dockEdge={dockEdge}
        onDock={setDockEdge}
        library={library}
        active={doc?.board.id || null}
        opened={opened}
        onOpen={openBoard}
        onFolder={setOpened}
        onCreate={newMenu}
        onSearch={() => {
          setSearch('');
          ask({ kind: 'search' });
        }}
        onOptions={libraryMenu}
        onBoardMenu={boardMenu}
        onFolderMenu={folderMenu}
        onRenameBoard={(id, name) => change(id, { name })}
        onRenameFolder={renameFolder}
        renameFolderRequest={renameRequest?.kind === 'folder' ? renameRequest : null}
        onMove={(id, folderId, position) =>
          run(async () => {
            await change(id, { folderId, ...(position === undefined ? {} : { position }) });
          })
        }
        onReorderFolder={(id, position) =>
          run(async () => {
            await invoke('updateFolder', { id, patch: { position } });
            await refresh();
          })
        }
        onNewBoard={(folderId) => ask({ kind: 'new-board', folderId }, 'Untitled')}
      />
      <main className="workspace">
        <header className="board-header">
          {doc && (
            <>
              <span className="board-glyph">
                <BoardGlyph name={doc.board.icon} size={17} />
              </span>
              <InlineName
                key={doc.board.id}
                className="board-title"
                label="Board name"
                value={doc.board.name}
                editRequest={
                  renameRequest?.kind === 'board' && renameRequest.id === doc.board.id
                    ? renameRequest.token
                    : 0
                }
                onCommit={(name) => change(doc.board.id, { name })}
              />
              <button
                className={'save-indicator ' + saveState}
                title={
                  saveState === 'saved'
                    ? 'All changes saved on this computer'
                    : saveState === 'error'
                      ? 'Save failed. Click to retry.'
                      : 'Saving changes…'
                }
                aria-label={
                  saveState === 'error'
                    ? 'Retry saving'
                    : saveState === 'saved'
                      ? 'Saved locally'
                      : 'Saving changes'
                }
                onClick={() =>
                  run(async () => {
                    await whiteboard.current?.flush();
                    if (saveState === 'error') setError('');
                  })
                }
              >
                {saveState === 'saved' ? (
                  <Check size={14} />
                ) : saveState === 'error' ? (
                  <AlertCircle size={15} />
                ) : (
                  <LoaderCircle size={14} />
                )}
              </button>
              <button
                className="icon-button board-options"
                aria-label="Board options"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  boardMenu(doc.board, r.right, r.bottom + 5);
                }}
              >
                <MoreHorizontal size={20} />
              </button>
            </>
          )}
        </header>
        {doc ? (
          <Whiteboard
            key={doc.board.id}
            ref={whiteboard}
            document={doc}
            onError={report}
            onSave={(state, message) => {
              setSaveState(state);
              if (message) report(message);
            }}
          />
        ) : (
          <div className="welcome-empty">
            <span className="welcome-symbol">
              <FolderIcon size={30} strokeWidth={1.3} />
            </span>
            <h1>{loading ? 'Opening your workspace…' : 'A place for your ideas.'}</h1>
            {!loading && (
              <>
                <p>Your boards and media stay on this computer.</p>
                <button
                  className="button primary"
                  onClick={() => ask({ kind: 'new-board' }, 'Ideas')}
                >
                  <Plus size={17} />
                  Create a board
                </button>
              </>
            )}
          </div>
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      <Presence show={!!modal}>
        {modal && (
          <Modal
            title={modalTitle[modal.kind]}
            onClose={() => {
              if (!busy) setModal(null);
            }}
          >
            {['new-board', 'new-folder', 'rename-board', 'rename-folder', 'icon', 'move'].includes(
              modal.kind,
            ) ? (
              <form
                onSubmit={submit}
                onDragOver={(e) => {
                  if (modal.kind === 'icon') {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }
                }}
                onDrop={(e) => {
                  if (modal.kind === 'icon') {
                    e.preventDefault();
                    e.stopPropagation();
                    void iconImage.current?.importFile(e.dataTransfer.files[0]);
                  }
                }}
              >
                {modal.kind === 'icon' ? (
                  <>
                    <BoardIconImage ref={iconImage} value={glyph} color={color} onBusy={setBusy} />
                    <div className="icon-picker">
                      {iconNames.map((icon) => (
                        <button
                          type="button"
                          className="icon-button"
                          key={icon}
                          aria-label={icon}
                          aria-pressed={glyph === icon}
                          disabled={busy}
                          onClick={() => {
                            iconImage.current?.clear();
                            setGlyph(icon);
                          }}
                        >
                          <BoardGlyph name={icon} />
                        </button>
                      ))}
                    </div>
                    <div className="tone-picker">
                      {['blue', 'green', 'purple', 'orange', 'rose', 'gray'].map((c) => (
                        <button
                          type="button"
                          key={c}
                          className={'app-icon ' + c}
                          aria-label={c}
                          aria-pressed={color === c}
                          onClick={() => setColor(c)}
                        >
                          {c === color && <Check size={16} />}
                        </button>
                      ))}
                    </div>
                  </>
                ) : modal.kind === 'move' ? (
                  <label>
                    Destination
                    <select
                      aria-label="Destination"
                      value={destination}
                      onChange={(e) => setDestination(e.target.value)}
                    >
                      <option value="">Icon strip</option>
                      {library.folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    Name
                    <input
                      aria-label="Name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={10000}
                      required
                      autoFocus
                      onFocus={(e) => e.target.select()}
                    />
                  </label>
                )}
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => setModal(null)}
                  >
                    Cancel
                  </button>
                  <button className="button primary" disabled={busy}>
                    {busy
                      ? 'Saving…'
                      : modal.kind.startsWith('new')
                        ? 'Create'
                        : modal.kind === 'move'
                          ? 'Move'
                          : 'Save'}
                  </button>
                </div>
              </form>
            ) : modal.kind === 'search' ? (
              <>
                <div className="search-input">
                  <Search size={18} />
                  <input
                    aria-label="Search boards"
                    placeholder="Find a board…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="search-results">
                  {library.boards
                    .filter(
                      (b) => !b.trashed && b.name.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((b) => (
                      <div
                        key={b.id}
                        className="search-result"
                        data-item={b.id}
                        onClick={() => {
                          setModal(null);
                          openBoard(b.id);
                        }}
                      >
                        <button className="search-result-open" aria-label={'Open board ' + b.name}>
                          <AppIcon board={b} />
                        </button>
                        <span>
                          <InlineName
                            value={b.name}
                            label={'Board name in search: ' + b.name}
                            onCommit={(name) => change(b.id, { name })}
                          />
                          <small>
                            {b.folderId && library.folders.find((f) => f.id === b.folderId) ? (
                              <InlineName
                                value={library.folders.find((f) => f.id === b.folderId)!.name}
                                label="Folder name in search"
                                onCommit={(name) => renameFolder(b.folderId!, name)}
                              />
                            ) : (
                              'Icon strip'
                            )}
                          </small>
                        </span>
                      </div>
                    ))}
                </div>
              </>
            ) : modal.kind === 'trash' ? (
              <div className="trash-list">
                {library.boards.filter((b) => b.trashed).length ? (
                  library.boards
                    .filter((b) => b.trashed)
                    .map((b) => (
                      <div key={b.id} data-item={b.id}>
                        <AppIcon board={b} />
                        <InlineName
                          value={b.name}
                          label={'Board name in Trash: ' + b.name}
                          onCommit={(name) => change(b.id, { name })}
                        />
                        <button
                          className="button"
                          onClick={() =>
                            run(async () => {
                              await invoke('restoreBoard', { id: b.id });
                              await refresh();
                              notify('Board restored');
                            })
                          }
                        >
                          <Undo2 size={15} />
                          Restore
                        </button>
                      </div>
                    ))
                ) : (
                  <p className="quiet">
                    Nothing in Trash. Deleted boards stay here until you restore them.
                  </p>
                )}
              </div>
            ) : (
              <>
                <p className="quiet">A private space, saved automatically on this computer.</p>
                <dl className="shortcuts">
                  {[
                    ['Paste images, text or links', 'Ctrl V'],
                    ['Select everything', 'Ctrl A'],
                    ['Duplicate selection', 'Ctrl D'],
                    ['Undo / redo', 'Ctrl Z / Ctrl Shift Z'],
                    ['Group / ungroup', 'Ctrl G / Ctrl Shift G'],
                    ['Search your boards', 'Ctrl K'],
                    ['Pan around', 'Right-drag · Space + drag'],
                    ['Zoom toward pointer', 'Mouse wheel'],
                    ['Fit your board', '0'],
                    ['Edit text', 'Double-click'],
                    ['Finish text editing', 'Ctrl Enter'],
                  ].map(([a, b]) => (
                    <div key={a}>
                      <dt>{a}</dt>
                      <dd>
                        <kbd>{b}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="quiet small">
                  {desktop
                    ? 'Local Canvas 0.1 · No account or connection needed.'
                    : 'Development preview · Uses a separate test library.'}
                </p>
              </>
            )}
          </Modal>
        )}
      </Presence>
    </div>
  );
}
