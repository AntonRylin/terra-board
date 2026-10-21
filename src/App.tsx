import SettingsPage from './components/SettingsPage';
import type { SectionId } from './components/settings/settings-index';
import { UpdatePrompt } from './components/UpdatePrompt';
import { finishStartup } from './startup';
import { isCommand } from './shortcuts/active';
import { bindingsFor, commands, fixedShortcuts } from './shortcuts/commands';
import { formatBinding } from './shortcuts/keys';
import { getPreferences, subscribePreferences, usePreferences } from './settings/preferences';
import { useGlassAppearance } from './components/useGlassAppearance';
import { useAppearance } from './components/useAppearance';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Settings,
  Plus,
  FolderPlus,
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
  PanelLeftClose,
  AlertCircle,
  LoaderCircle,
  ImagePlus,
  Folder as FolderIcon,
  Radio,
  Users,
  KeyRound,
} from 'lucide-react';
import { LiveBadge, LiveRequests, LiveShareDialog, useLiveStatus } from './components/LiveShare';
import { JoinDialog, ShareDialog, useCloudStatus } from './components/ShareDialog';
import type { Board, Document, Folder, Library, BackgroundAppearance } from './model';
import BoardBackgroundSettings, { defaultBackgroundAppearance } from './components/BoardBackground';
import {
  chooseFiles,
  importFiles,
  desktop,
  exportPortable,
  importPortable,
  invoke,
} from './bridge';
import type { SaveState } from './canvas/save-queue';
import Launcher, { AppIcon } from './components/Launcher';
import LibrarySearch from './components/LibrarySearch';
import InlineName, { flushInlineNames } from './components/InlineName';
import Whiteboard, { type WhiteboardHandle } from './components/Whiteboard';
import BoardIconImage, { type BoardIconImageHandle } from './components/BoardIconImage';
import BoardEmojiPicker from './components/BoardEmojiPicker';
import { BoardGlyph } from './components/Icon';
import BoardSymbolPicker from './components/BoardSymbolPicker';
import { Presence } from './components/Presence';
import { ContextMenu, Modal, type MenuItem, type MenuPlacement } from './components/Dialogs';
import { readDockEdge } from './components/useLauncherDock';
import { useBoardHeaderSpace } from './components/useBoardHeaderSpace';
import { useFullscreenSpace } from './components/useFullscreenSpace';
type ModalState = {
  kind:
    | 'new-board'
    | 'new-folder'
    | 'rename-board'
    | 'rename-folder'
    | 'icon'
    | 'background'
    | 'move'
    | 'search'
    | 'trash'
    | 'help'
    | 'confirm-trash'
    | 'live'
    | 'share'
    | 'join'
    | 'settings';
  id?: string;
  shareKind?: 'folder' | 'board';
  folderId?: string | null;
  iconFile?: File;
  // Settings only: the section to open, and a server address from a link.
  section?: SectionId;
  address?: string;
};
export default function App() {
  const glass = useGlassAppearance();
  const appearance = useAppearance();
  const preferences = usePreferences();
  useEffect(() => {
    const send = () =>
      window.canvas?.setFullscreenKeys(bindingsFor('app.fullscreen', getPreferences().shortcuts));
    send();
    return subscribePreferences(send);
  }, []);
  const [aiBusy, setAiBusy] = useState<false | 'ai' | 'cloud' | 'guest'>(false);
  const liveStatus = useLiveStatus();
  const cloudStatus = useCloudStatus();
  // What is shared, and with whom, changes the board panel's badges and menus.
  const shareSignature = JSON.stringify([
    cloudStatus?.shared.map((s) => s.shareId),
    cloudStatus?.sharedWithMe.map((s) => [s.shareId, s.role, s.boards]),
  ]);
  useEffect(() => {
    if (cloudStatus) void refresh().catch(() => {});
  }, [shareSignature]);
  const [canvasReady, setCanvasReady] = useState(false);
  const activeDocument = useRef<Document | null>(null);
  const [dockEdge, setDockEdge] = useState(readDockEdge);
  const [searchTarget, setSearchTarget] = useState<{ boardId: string; objectId: string } | null>(
    null,
  );
  const [launcherCentered, setLauncherCentered] = useState(() => {
    try {
      return localStorage.getItem('terra-board.launcher-centered') === 'true';
    } catch {
      return false;
    }
  });
  const [launcherHidden, setLauncherHidden] = useState(() => {
    try {
      return localStorage.getItem('terra-board.launcher-hidden') === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('terra-board.launcher-hidden', String(launcherHidden));
    } catch {}
  }, [launcherHidden]);
  const [launcherMinimal, setLauncherMinimal] = useState(() => {
    try {
      return localStorage.getItem('terra-board.launcher-minimal') === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('terra-board.launcher-minimal', String(launcherMinimal));
    } catch {}
  }, [launcherMinimal]);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenButton = useFullscreenSpace(
    launcherMinimal && !launcherHidden && !fullscreen,
    launcherCentered,
    dockEdge,
  );
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
    [backgroundAppearance, setBackgroundAppearance] = useState<BackgroundAppearance>(
      defaultBackgroundAppearance,
    ),
    [destination, setDestination] = useState(''),
    [search, setSearch] = useState(''),
    [saveState, setSaveState] = useState<SaveState>('saved'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  activeDocument.current = doc;
  useEffect(() => {
    if (error || (!loading && (!doc || canvasReady))) finishStartup();
    if (!loading && !doc && !error) window.canvas?.rendererReady();
  }, [loading, doc, canvasReady, error]);
  const boardHeader = useBoardHeaderSpace(
    (dockEdge === 'top' || dockEdge === 'left') && launcherMinimal && !launcherHidden,
    launcherCentered,
    doc?.board.id,
  );
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
      const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      const exit = plain && event.key === 'Escape' && fullscreenNow.current;
      if (!exit && !isCommand(event, 'app.fullscreen')) return;
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
  const prepareSearch = useCallback(async () => {
    await flushInlineNames();
    await whiteboard.current?.flush();
  }, []);
  const openSearch = useCallback(() => {
    setMenu(null);
    void prepareSearch()
      .then(() => {
        setSearch('');
        setModal({ kind: 'search' });
      })
      .catch((error) => report(String(error)));
  }, [prepareSearch, report]);
  const openBoard = async (id: string, objectId?: string) => {
    const n = ++request.current;
    try {
      await flushInlineNames();
      await whiteboard.current?.flush();
      if (n !== request.current) return;
      const d = await invoke<Document>('loadBoard', { id });
      if (n !== request.current) return;
      setDoc(d);
      setSearchTarget(objectId ? { boardId: id, objectId } : null);
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
      const remembered = getPreferences().openLastBoard
        ? l.boards.find((b) => b.id === l.lastBoard && !b.trashed)
        : undefined;
      const first = remembered || l.boards.find((b) => !b.trashed);
      if (first) await openBoard(first.id);
      if (l.backupError)
        report('The automatic metadata snapshot could not be created: ' + l.backupError);
    }).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('.pdf-workspace, .image-viewer, .frame-usages')) return;
      if (aiBusy || modal?.kind === 'settings' || e.isComposing || e.repeat) return;
      if (isCommand(e, 'app.search')) {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
      } else if (isCommand(e, 'app.settings')) {
        e.preventDefault();
        e.stopPropagation();
        void flushInlineNames()
          .then(() => whiteboard.current?.flush())
          .then(() => ask({ kind: 'settings' }))
          .catch((error) => report(String(error)));
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [aiBusy, modal?.kind, openSearch]);
  useEffect(() => {
    // A terraboard://connect link opens Settings with the address filled in.
    // Nothing changes until the person checks the server and connects.
    return window.canvas?.cloud.onDeepLink((link) => {
      if (link.kind !== 'connect') return;
      void flushInlineNames()
        .then(() => whiteboard.current?.flush())
        .then(() => ask({ kind: 'settings', section: 'cloud', address: link.address }))
        .catch((error) => report(String(error)));
    });
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
      const root = window.document.getElementById('root');
      if (root) {
        delete root.dataset.mcpInert;
        root.inert = !!window.document.querySelector('.pdf-workspace, .image-viewer');
      }
      for (const event of events) window.removeEventListener(event, block, true);
      setAiBusy(false);
    };
    const cleanup = window.canvas?.onMcpSync(async (message) => {
      try {
        if (message.phase === 'prepare') {
          ++request.current;
          setAiBusy(
            message.source === 'cloud' || message.source === 'guest' ? message.source : 'ai',
          );
          const root = window.document.getElementById('root');
          if (root) {
            root.dataset.mcpInert = 'true';
            root.inert = true;
          }
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
                } else if (
                  message.change === 'content' &&
                  (message.idBoard === board.id || message.boards?.includes(board.id))
                ) {
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
  const centerLauncher = (centered: boolean) => {
    setLauncherCentered(centered);
    try {
      localStorage.setItem('terra-board.launcher-centered', String(centered));
    } catch {}
  };
  const launcherAlignmentItem: MenuItem = {
    label: launcherCentered ? 'Uncenter panel' : 'Center panel',
    icon: <AlignCenter />,
    action: () => centerLauncher(!launcherCentered),
  };
  const launcherModeItem: MenuItem = {
    label: launcherMinimal ? 'Full panel' : 'Minimal mode',
    icon: launcherMinimal ? <Maximize /> : <Minimize />,
    action: () => setLauncherMinimal((minimal) => !minimal),
  };
  const hideLauncherItem: MenuItem = {
    label: 'Hide panel',
    icon: <PanelLeftClose />,
    action: () =>
      void run(async () => {
        await flushInlineNames();
        setOpened(null);
        setLauncherHidden(true);
      }),
  };
  const toggleLauncher = () =>
    void run(async () => {
      await flushInlineNames();
      setOpened(null);
      setLauncherHidden((hidden) => !hidden);
    });
  const sharingOf = (b: Board) =>
    library.sharing?.boards[b.id] ||
    (b.folderId ? library.sharing?.folders[b.folderId] : undefined);
  const shareItem = (shareKind: 'folder' | 'board', id: string, received: boolean): MenuItem => ({
    label: received ? 'Shared with you…' : 'Invite over cloud…',
    icon: <Users />,
    action: () => ask({ kind: 'share', shareKind, id }),
  });
  const boardMenu = (b: Board, x: number, y: number) => {
    const mark = sharingOf(b);
    if (desktop && mark && mark.shared !== 'owner')
      return setMenu({
        x,
        y,
        items: [
          { label: 'Open', action: () => openBoard(b.id) },
          shareItem('board', b.id, true),
          null,
          { label: 'Export / share a copy…', icon: <Download />, action: () => exportBoard(b.id) },
          null,
          launcherAlignmentItem,
          launcherModeItem,
          hideLauncherItem,
        ],
      });
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
        {
          label: b.backgroundAssetId ? 'Change background image…' : 'Set background image…',
          icon: <ImagePlus />,
          action: () =>
            run(async () => {
              const [file] = await chooseFiles('.png,.jpg,.jpeg,.webp,.gif,.avif,.tif,.tiff');
              if (!file) return;
              const [asset] = await importFiles([file]);
              await change(b.id, { backgroundAssetId: asset.id });
              notify('Board background updated');
            }),
        },
        ...(b.backgroundAssetId
          ? [
              {
                label: 'Adjust background…',
                icon: <Palette />,
                action: () => {
                  setBackgroundAppearance(b.backgroundAppearance || defaultBackgroundAppearance);
                  ask({ kind: 'background', id: b.id });
                },
              },
              {
                label: 'Remove background image',
                icon: <Undo2 />,
                action: () =>
                  run(async () => {
                    await change(b.id, { backgroundAssetId: null });
                    notify('Board background removed');
                  }),
              },
            ]
          : []),
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
        ...(desktop ? [shareItem('board', b.id, false)] : []),
        ...(desktop
          ? [
              {
                label:
                  liveStatus.active && liveStatus.boardId === b.id
                    ? 'Sharing over Wi-Fi…'
                    : 'Share over Wi-Fi…',
                icon: <Radio />,
                action: () => ask({ kind: 'live', id: b.id }),
              },
            ]
          : []),
        null,
        launcherAlignmentItem,
        launcherModeItem,
        hideLauncherItem,
        null,
        {
          label: 'Move to Trash',
          icon: <Trash2 />,
          danger: true,
          action: () =>
            getPreferences().confirmTrash ? ask({ kind: 'confirm-trash', id: b.id }) : trash(b.id),
        },
      ],
    });
  };
  const folderMenu = (f: Folder, x: number, y: number) => {
    const mark = library.sharing?.folders[f.id];
    if (desktop && mark && mark.shared !== 'owner')
      return setMenu({
        x,
        y,
        items: [
          shareItem('folder', f.id, true),
          null,
          launcherAlignmentItem,
          launcherModeItem,
          hideLauncherItem,
        ],
      });
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
        ...(desktop ? [shareItem('folder', f.id, false)] : []),
        null,
        launcherAlignmentItem,
        launcherModeItem,
        hideLauncherItem,
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
  };
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
  const libraryMenu = (x: number, y: number, placement: MenuPlacement = 'below') =>
    setMenu({
      x,
      y,
      placement,
      items: [
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
        null,
        {
          label: 'Search',
          icon: <Search />,
          action: openSearch,
        },
        { label: 'Import board…', icon: <Upload />, action: importBoard },
        ...(desktop
          ? [
              {
                label: 'Join with a code…',
                icon: <KeyRound />,
                action: () => ask({ kind: 'join' }),
              },
            ]
          : []),
        null,
        { label: 'Trash', icon: <Trash2 />, action: () => ask({ kind: 'trash' }) },
        launcherAlignmentItem,
        launcherModeItem,
        hideLauncherItem,
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
      else if (modal.kind === 'background') await change(modal.id!, { backgroundAppearance });
      setModal(null);
    } catch (e) {
      report(String(e));
    } finally {
      setBusy(false);
    }
  }
  const modalTitle: Record<ModalState['kind'], string> = {
    'new-board': 'Name of the new board',
    'new-folder': 'New folder',
    'rename-board': 'Rename board',
    'rename-folder': 'Rename folder',
    icon: 'Board icon',
    background: 'Background image',
    move: 'Move board',
    search: 'Search',
    trash: 'Trash',
    help: 'Make yourself at home',
    'confirm-trash': 'Move to Trash?',
    live: 'Share over Wi-Fi',
    share: 'Invite over cloud',
    join: 'Join with a code',
    settings: 'Settings',
  };
  return (
    <>
      <div
        className="app-shell"
        data-dock={dockEdge}
        data-panel-hidden={launcherHidden || undefined}
        inert={modal?.kind === 'settings' ? true : undefined}
      >
        <Launcher
          hidden={launcherHidden}
          minimal={launcherMinimal}
          dockEdge={dockEdge}
          centered={launcherCentered}
          onDock={setDockEdge}
          library={library}
          active={doc?.board.id || null}
          opened={opened}
          onOpen={openBoard}
          onFolder={setOpened}
          onCreate={newMenu}
          onPanelMenu={libraryMenu}
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
          <header ref={boardHeader} className="board-header">
            {doc && (
              <>
                <div
                  className="board-identity"
                  role="button"
                  tabIndex={0}
                  aria-label={launcherHidden ? 'Show board panel' : 'Hide board panel'}
                  aria-expanded={!launcherHidden}
                  title={launcherHidden ? 'Show board panel' : 'Hide board panel'}
                  onClick={toggleLauncher}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleLauncher();
                    } else if (e.key === 'F2') {
                      e.preventDefault();
                      beginRename('board', doc.board.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    boardMenu(doc.board, e.clientX, e.clientY);
                  }}
                >
                  <AppIcon board={doc.board} />
                  <InlineName
                    key={doc.board.id}
                    className="board-title"
                    onActivate={toggleLauncher}
                    activationTitle={launcherHidden ? 'Show board panel' : 'Hide board panel'}
                    label="Board name"
                    value={doc.board.name}
                    editRequest={
                      renameRequest?.kind === 'board' && renameRequest.id === doc.board.id
                        ? renameRequest.token
                        : 0
                    }
                    onCommit={(name) => change(doc.board.id, { name })}
                  />
                </div>
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
              </>
            )}
            {!doc && launcherHidden && (
              <button
                className="board-identity"
                onClick={toggleLauncher}
                aria-label="Show board panel"
              >
                <FolderIcon size={34} strokeWidth={1.3} />
                <span className="board-title">Boards</span>
              </button>
            )}
          </header>
          {!fullscreen && (desktop || document.fullscreenEnabled) && (
            <button
              className="fullscreen-toggle"
              ref={fullscreenButton}
              aria-label="Full screen"
              onClick={() => void run(toggleFullscreen)}
            >
              <Maximize size={16} />
            </button>
          )}
          {doc ? (
            <Whiteboard
              theme={appearance.theme}
              key={doc.board.id}
              readOnly={sharingOf(doc.board)?.shared === 'view'}
              pinning
              ref={whiteboard}
              document={doc}
              backgroundPreview={
                modal?.kind === 'background' && modal.id === doc.board.id
                  ? backgroundAppearance
                  : undefined
              }
              onOpenFrame={(boardId, frameId) => {
                if (boardId === doc.board.id) setSearchTarget({ boardId, objectId: frameId });
                else void openBoard(boardId, frameId);
              }}
              searchTarget={searchTarget?.boardId === doc.board.id ? searchTarget : null}
              onError={report}
              onReady={() => setCanvasReady(true)}
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
        <LiveBadge
          status={liveStatus}
          onOpen={() => liveStatus.boardId && ask({ kind: 'live', id: liveStatus.boardId })}
        />
        <LiveRequests status={liveStatus} />
        <UpdatePrompt />
        {aiBusy && aiBusy !== 'guest' && (
          <div className="toast" role="status">
            <LoaderCircle size={15} />
            {aiBusy === 'cloud' ? 'Syncing changes…' : 'Syncing AI changes…'}
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
                'background',
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
                  {modal.kind === 'background' ? (
                    <BoardBackgroundSettings
                      assetId={library.boards.find((b) => b.id === modal.id)!.backgroundAssetId!}
                      value={backgroundAppearance}
                      onChange={setBackgroundAppearance}
                    />
                  ) : modal.kind === 'icon' ? (
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
                      {modal.kind !== 'new-board' && 'Name'}
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
              ) : modal.kind === 'share' ? (
                <ShareDialog
                  kind={modal.shareKind || 'board'}
                  id={modal.id!}
                  library={library}
                  status={cloudStatus}
                  onClose={() => setModal(null)}
                />
              ) : modal.kind === 'join' ? (
                <JoinDialog status={cloudStatus} onClose={() => setModal(null)} />
              ) : modal.kind === 'live' ? (
                <LiveShareDialog
                  boardId={modal.id!}
                  boardName={library.boards.find((b) => b.id === modal.id)?.name || 'this board'}
                  sharedName={library.boards.find((b) => b.id === liveStatus.boardId)?.name}
                  status={liveStatus}
                  onClose={() => setModal(null)}
                />
              ) : modal.kind === 'confirm-trash' ? (
                <>
                  <p className="quiet">
                    “{library.boards.find((b) => b.id === modal.id)?.name || 'This board'}” moves to
                    Trash. You can restore it from Trash at any time.
                  </p>
                  <div className="dialog-actions">
                    <button type="button" className="button" onClick={() => setModal(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => {
                        const id = modal.id!;
                        setModal(null);
                        trash(id);
                      }}
                    >
                      Move to Trash
                    </button>
                  </div>
                </>
              ) : modal.kind === 'search' ? (
                <LibrarySearch
                  library={library}
                  query={search}
                  onQuery={setSearch}
                  prepare={prepareSearch}
                  onOpen={(id, objectId) => {
                    setModal(null);
                    void openBoard(id, objectId);
                  }}
                  onRenameBoard={(id, name) => change(id, { name })}
                  onRenameFolder={renameFolder}
                />
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
                      ...commands.flatMap((c) => {
                        const keys = bindingsFor(c.id, preferences.shortcuts);
                        return keys.length
                          ? [[c.name, keys.map(formatBinding).join(' / ').replace(/\+/g, ' ')]]
                          : [];
                      }),
                      ...fixedShortcuts.map((f) => [f.name, f.keys]),
                      [
                        preferences.wheel === 'pan' ? 'Pan / zoom' : 'Zoom toward pointer',
                        preferences.wheel === 'pan' ? 'Mouse wheel / Ctrl + wheel' : 'Mouse wheel',
                      ],
                      ['Edit text', 'Double-click'],
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
          // A link opened while Settings is showing starts the page over on the server row.
          key={modal.address ?? ''}
          appearance={appearance}
          onClose={() => setModal(null)}
          transparency={glass.transparency}
          onTransparency={glass.setTransparency}
          panel={{
            hidden: launcherHidden,
            minimal: launcherMinimal,
            centered: launcherCentered,
            setHidden: setLauncherHidden,
            setMinimal: setLauncherMinimal,
            setCentered: centerLauncher,
          }}
          library={library}
          onManageShare={(shareKind, id) => ask({ kind: 'share', shareKind, id })}
          initialSection={modal.section}
          connectAddress={modal.address}
        />
      )}
    </>
  );
}
