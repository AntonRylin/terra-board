import SettingsPage from './components/SettingsPage';
import { useGlassAppearance } from './components/useGlassAppearance';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Settings,
  Plus,
  FolderPlus,
  MoreHorizontal,
  Maximize,
  Minimize,
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
  AlignCenter,
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
import BoardEmojiPicker from './components/BoardEmojiPicker';
import { BoardGlyph } from './components/Icon';
import BoardSymbolPicker from './components/BoardSymbolPicker';
import { Presence } from './components/Presence';
import { ContextMenu, Modal, type MenuItem, type MenuPlacement } from './components/Dialogs';
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
    | 'help'
    | 'settings';
  id?: string;
  folderId?: string | null;
  iconFile?: File;
};
export default function App() {
  const glass = useGlassAppearance();
  const [aiBusy, setAiBusy] = useState(false);
  const activeDocument = useRef<Document | null>(null);
  const [dockEdge, setDockEdge] = useState(readDockEdge);
  const [launcherCentered, setLauncherCentered] = useState(() => {
    try {
      return localStorage.getItem('terra-board.launcher-centered') === 'true';
    } catch {
      return false;
    }
  });
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenNow = useRef(false);
  const fullscreenEscapeHeld = useRef(false);
  const [library, setLibrary] = useState<Library>({ boards: [], folders: [], lastBoard: null }),
    [doc, setDoc] = useState<Document | null>(null),
    [opened, setOpened] = useState<string | null>(null),
    [menu, setMenu] = useState<{
      x: number;
      y: number;
      placement?: MenuPlacement;
      items: (MenuItem | null)[];
    } | null>(null),
    [modal, setModal] = useState<ModalState | null>(null),
    [name, setName] = useState(''),
    [glyph, setGlyph] = useState('lightbulb'),
    [color, setColor] = useState('blue'),
    [iconShape, setIconShape] = useState<'rounded' | 'circle'>('rounded'),
    [showInitial, setShowInitial] = useState(true),
    [destination, setDestination] = useState(''),
    [search, setSearch] = useState(''),
    [saveState, setSaveState] = useState<SaveState>('saved'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  activeDocument.current = doc;
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
  const toggleFullscreen = async () => {
    if (window.canvas) await window.canvas.toggleFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  };
  useEffect(() => {
    let active = true;
    const update = (value: boolean) => {
      if (!active) return;
      fullscreenNow.current = value;
      setFullscreen(value);
      setMenu(null);
    };
    if (window.canvas) {
      const unsubscribe = window.canvas.onFullscreenChange(update);
      window.canvas
        .fullscreenState()
        .then(update)
        .catch((e) => report(String(e)));
      return () => {
        active = false;
        unsubscribe();
      };
    }
    const changed = () => update(!!document.fullscreenElement);
    changed();
    document.addEventListener('fullscreenchange', changed);
    return () => {
      active = false;
      document.removeEventListener('fullscreenchange', changed);
    };
  }, [report]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && fullscreenEscapeHeld.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'F11' && !(event.key === 'Escape' && fullscreenNow.current)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') fullscreenEscapeHeld.current = true;
      if (!event.repeat) void toggleFullscreen().catch((e) => report(String(e)));
    };
    const release = (event: KeyboardEvent) => {
      if (event.key === 'Escape') fullscreenEscapeHeld.current = false;
    };
    const blur = () => {
      fullscreenEscapeHeld.current = false;
    };
    // Capture before editors/dialogs so exiting fullscreen preserves their drafts.
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', release, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', release, true);
      window.removeEventListener('blur', blur);
    };
  }, [report]);
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
    const block = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['keydown', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'paste', 'drop'];
    const unlock = () => {
      window.document.getElementById('root')?.removeAttribute('inert');
      for (const event of events) window.removeEventListener(event, block, true);
      setAiBusy(false);
    };
    const cleanup = window.canvas?.onMcpSync(async (message) => {
      try {
        if (message.phase === 'prepare') {
          ++request.current;
          setAiBusy(true);
          window.document.getElementById('root')?.setAttribute('inert', '');
          for (const event of events)
            window.addEventListener(event, block, { capture: true, passive: false });
          await flushInlineNames();
          await whiteboard.current?.prepareExternal();
        } else {
          try {
            if (message.change && message.change !== 'none') {
              const l = await refresh();
              const current = activeDocument.current;
              if (current) {
                const board = l.boards.find((b) => b.id === current.board.id && !b.trashed);
                if (!board) {
                  whiteboard.current?.finishExternal();
                  setDoc(null);
                } else if (message.change === 'content' && message.idBoard === board.id) {
                  const updated = await invoke<Document>('loadBoard', { id: board.id });
                  whiteboard.current?.finishExternal(updated);
                  setDoc({ ...updated, board });
                } else {
                  whiteboard.current?.finishExternal();
                  setDoc((d) => (d ? { ...d, board } : d));
                }
              }
            } else whiteboard.current?.finishExternal();
          } finally {
            unlock();
          }
        }
        window.canvas!.mcpReady(message.id);
      } catch (e) {
        whiteboard.current?.finishExternal();
        unlock();
        report(String(e));
        window.canvas!.mcpReady(message.id, String(e));
      }
    });
    window.canvas?.rendererReady();
    return () => {
      cleanup?.();
      unlock();
    };
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
  const launcherAlignmentItem: MenuItem = {
    label: launcherCentered ? 'Uncenter panel' : 'Center panel',
    icon: <AlignCenter />,
    action: () => {
      const centered = !launcherCentered;
      setLauncherCentered(centered);
      try {
        localStorage.setItem('terra-board.launcher-centered', String(centered));
      } catch {}
    },
  };
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
            setIconShape(b.iconShape || 'rounded');
            setShowInitial(b.showInitial !== false);
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
        launcherAlignmentItem,
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
        launcherAlignmentItem,
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
  const panelMenu = (x: number, y: number, placement: MenuPlacement) =>
    setMenu({
      x,
      y,
      placement,
      items: [
        launcherAlignmentItem,
        {
          label: 'New board',
          icon: <Plus />,
          action: () => ask({ kind: 'new-board', folderId: null }, 'Untitled'),
        },
        {
          label: 'New folder',
          icon: <FolderPlus />,
          action: () => ask({ kind: 'new-folder' }, 'Untitled folder'),
        },
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
        launcherAlignmentItem,
        ...(desktop || document.fullscreenEnabled
          ? [
              {
                label: fullscreen ? 'Exit full screen' : 'Full screen',
                icon: fullscreen ? <Minimize /> : <Maximize />,
                action: () => void run(toggleFullscreen),
              },
            ]
          : []),
        ...(desktop
          ? [{ label: 'Settings', icon: <Settings />, action: () => ask({ kind: 'settings' }) }]
          : []),
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
        await change(modal.id!, {
          icon: (await iconImage.current?.save()) || glyph,
          color,
          iconShape,
          showInitial,
        });
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
    settings: 'Settings',
  };
  return (
    <>
      <div
        className="app-shell"
        data-dock={dockEdge}
        inert={modal?.kind === 'settings' ? true : undefined}
      >
        <Launcher
          dockEdge={dockEdge}
          centered={launcherCentered}
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
          onPanelMenu={panelMenu}
          onBoardMenu={boardMenu}
          onIconDrop={(board, file) => {
            if (busy) return;
            setGlyph(board.icon);
            setColor(board.color);
            setIconShape(board.iconShape || 'rounded');
            setShowInitial(board.showInitial !== false);
            ask({ kind: 'icon', id: board.id, iconFile: file });
          }}
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
                <span
                  className={
                    'board-glyph shape-' +
                    (doc.board.iconShape || 'rounded') +
                    (doc.board.icon === 'none' ? ' app-icon ' + doc.board.color : '')
                  }
                >
                  <BoardGlyph
                    name={doc.board.icon}
                    size={34}
                    boardName={doc.board.name}
                    showInitial={doc.board.showInitial !== false}
                  />
                </span>
                <InlineName
                  key={doc.board.id}
                  className="board-title"
                  singleClick
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
        {aiBusy && (
          <div className="toast" role="status">
            <LoaderCircle size={15} />
            Syncing AI changes…
          </div>
        )}
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
        <Presence show={!!modal && modal.kind !== 'settings'}>
          {modal && modal.kind !== 'settings' && (
            <Modal
              title={modalTitle[modal.kind]}
              onClose={() => {
                if (!busy) setModal(null);
              }}
            >
              {[
                'new-board',
                'new-folder',
                'rename-board',
                'rename-folder',
                'icon',
                'move',
              ].includes(modal.kind) ? (
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
                      <BoardIconImage
                        ref={iconImage}
                        value={glyph}
                        color={color}
                        shape={iconShape}
                        boardName={library.boards.find((b) => b.id === modal.id)?.name || ''}
                        showInitial={showInitial}
                        onBusy={setBusy}
                        onClear={() => {
                          iconImage.current?.clear();
                          setGlyph('none');
                        }}
                        initialFile={modal.iconFile}
                      />
                      <div className="icon-shape-picker" role="group" aria-label="Icon shape">
                        {(['rounded', 'circle'] as const).map((shape) => (
                          <button
                            type="button"
                            key={shape}
                            aria-pressed={iconShape === shape}
                            onClick={() => setIconShape(shape)}
                          >
                            <span className={'shape-sample shape-' + shape} aria-hidden="true" />
                            {shape === 'circle' ? 'Circle' : 'Rounded square'}
                          </button>
                        ))}
                      </div>
                      <BoardSymbolPicker
                        value={glyph}
                        disabled={busy}
                        onSelect={(icon) => {
                          iconImage.current?.clear();
                          setGlyph(glyph === icon ? 'none' : icon);
                        }}
                      />
                      <BoardEmojiPicker
                        value={glyph}
                        disabled={busy}
                        onSelect={(icon) => {
                          iconImage.current?.clear();
                          setGlyph(glyph === icon ? 'none' : icon);
                        }}
                      />
                      <div className="tone-picker">
                        {['blue', 'green', 'purple', 'orange', 'rose', 'gray', 'yellow'].map(
                          (c) => (
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
                          ),
                        )}
                      </div>
                      <div className="initial-setting">
                        <span>Show first letter</span>
                        <button
                          type="button"
                          className="mcp-switch"
                          role="switch"
                          aria-label="Show first letter"
                          aria-checked={showInitial}
                          onClick={() => setShowInitial(!showInitial)}
                        >
                          <span />
                        </button>
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
                          <button
                            className="search-result-open"
                            aria-label={'Open board ' + b.name}
                          >
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
                      ['Toggle full screen', 'F11'],
                      ['Exit full screen', 'Esc'],
                      ['Pan around', 'Right-drag · Space + drag'],
                      ['Move without snapping', 'Alt + drag'],
                      ['Zoom toward pointer', 'Mouse wheel'],
                      ['Fit your board', '0'],
                      ['Draw an arrow', 'A + drag'],
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
                      ? 'Terra Board 0.1 · No account or connection needed.'
                      : 'Development preview · Uses a separate test library.'}
                  </p>
                </>
              )}
            </Modal>
          )}
        </Presence>
      </div>
      {modal?.kind === 'settings' && (
        <SettingsPage
          onClose={() => setModal(null)}
          transparency={glass.transparency}
          onTransparency={glass.setTransparency}
        />
      )}
    </>
  );
}
