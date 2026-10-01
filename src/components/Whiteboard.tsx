import ArrowControls from './ArrowControls';
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  MousePointer2,
  MoveUpRight,
  Hand,
  Type,
  StickyNote,
  Square,
  Frame,
  Link2,
  ImagePlus,
  Minus,
  Plus,
  Maximize2,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  Group,
  Ungroup,
  MoreHorizontal,
  Download,
  Play,
  ExternalLink,
  Crop,
  AlignHorizontalJustifyCenter,
  AlignVerticalJustifyCenter,
} from 'lucide-react';
import type { Asset, CanvasObject, Document, Edit, Tool, ImageCrop as CropBounds } from '../model';
import { uid } from '../model';
import { clipboardObjects, pastedUrl } from '../canvas/content';
import {
  youtubeId,
  linkLayout,
  compactLinkHeight,
  normalizeLinkSize,
  setLinkCompact,
} from '../canvas/link-preview';
import { loadLinkPreview } from '../canvas/load-link-preview';
import { Engine } from '../canvas/engine';
import { textAppearance } from '../canvas/text-style';
import { textLayout, fitTextObject } from '../canvas/text-layout';
import { textPlacement } from '../canvas/text-alignment';
import { localToWorld } from '../canvas/transform';
import { SaveQueue, type SaveState } from '../canvas/save-queue';
import { importFiles, pickMedia, openLink, mediaUrl, download, invoke } from '../bridge';
import { ContextMenu, Modal, type MenuItem } from './Dialogs';
import ImageCrop from './ImageCrop';
import { cropImage, uncroppedImage, fullCrop } from '../canvas/crop';
import { selectionToolsPosition } from '../canvas/selection-tools';
import type { Bounds } from '../canvas/geometry';
export interface WhiteboardHandle {
  flush: () => Promise<void>;
  importMedia: () => void;
  fit: () => void;
}
interface Props {
  document: Document;
  onSave: (state: SaveState, message?: string) => void;
  onError: (message: string) => void;
}
const tools: { id: Tool; label: string; icon: typeof Type; key: string }[] = [
  { id: 'select', label: 'Select', icon: MousePointer2, key: 'V' },
  { id: 'hand', label: 'Pan', icon: Hand, key: 'H' },
  { id: 'text', label: 'Text', icon: Type, key: 'T' },
  { id: 'note', label: 'Note', icon: StickyNote, key: 'N' },
  { id: 'rect', label: 'Shape', icon: Square, key: 'R' },
  { id: 'arrow', label: 'Arrow', icon: MoveUpRight, key: 'A' },
  { id: 'frame', label: 'Frame', icon: Frame, key: 'F' },
  { id: 'link', label: 'Link', icon: Link2, key: 'L' },
];
const colors = ['#f8efd4', '#e4eee8', '#e4ecfa', '#efe5f1', '#f4e4e5', '#ffffff', '#000000'];
const Whiteboard = forwardRef<WhiteboardHandle, Props>(function Whiteboard(
  { document: doc, onSave, onError },
  ref,
) {
  const arrowDraft = useRef<{ flush: () => void }>(null);
  const host = useRef<HTMLDivElement>(null),
    engine = useRef<Engine | null>(null),
    queue = useRef<SaveQueue | null>(null),
    alive = useRef(true),
    editorRef = useRef<HTMLTextAreaElement>(null),
    editingSession = useRef<{ object: CanvasObject; draft: string } | null>(null),
    copy = useRef<CanvasObject[]>([]),
    imports = useRef(new Set<Promise<void>>());
  const cropSession = useRef<{ object: CanvasObject; crop: CropBounds } | null>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const angleRef = useRef<HTMLDivElement>(null);
  const toolsSize = useRef({ width: 0, height: 0 });
  const selectionView = useRef<{
    bounds: Bounds | null;
    viewport: { width: number; height: number };
  } | null>(null);
  const positionTools = () => {
    const el = toolsRef.current,
      view = selectionView.current;
    if (!el || !view?.bounds) return;
    const { left, top } = selectionToolsPosition(view.bounds, view.viewport, toolsSize.current);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
  };
  const [cropping, setCropping] = useState<{ object: CanvasObject; crop: CropBounds } | null>(null);
  const [player, setPlayer] = useState<{ id: string; videoId: string; muted: boolean } | null>(
    null,
  );
  const playerId = useRef<string | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const positionPlayer = () => {
    const el = playerRef.current,
      e = engine.current;
    if (!el || !e || !playerId.current) return;
    const o = e.objects.get(playerId.current);
    if (!o) {
      setPlayer(null);
      return;
    }
    const box = linkLayout(o.width, o.height);
    const origin = localToWorld(o, { x: box.x, y: box.y });
    el.style.left = `${origin.x * e.camera.zoom + e.camera.x}px`;
    el.style.top = `${origin.y * e.camera.zoom + e.camera.y}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.transform = `rotate(${o.rotation || 0}deg) scale(${e.camera.zoom})`;
  };
  useLayoutEffect(() => {
    playerId.current = player?.id || null;
    positionPlayer();
    if (!player?.muted) return;
    const timer = setTimeout(() => setPlayer(null), 16000);
    return () => clearTimeout(timer);
  }, [player]);
  const [ready, setReady] = useState(false),
    [tool, setTool] = useState<Tool>('select'),
    [selected, setSelected] = useState<CanvasObject[]>([]),
    [camera, setCamera] = useState(doc.camera),
    [editing, setEditing] = useState<CanvasObject | null>(null),
    [draft, setDraft] = useState(''),
    [video, setVideo] = useState<CanvasObject | null>(null),
    [linkPoint, setLinkPoint] = useState<{ x: number; y: number } | null>(null),
    [linkValue, setLinkValue] = useState(''),
    [menu, setMenu] = useState<{ x: number; y: number } | null>(null),
    [busy, setBusy] = useState(0),
    [count, setCount] = useState(doc.objects.length);
  const editingObject = useMemo(
    () => (editing ? fitTextObject(editing, draft) : null),
    [editing, draft],
  );
  const editingLayout = useMemo(
    () => (editingObject ? textLayout(editingObject, draft) : null),
    [editingObject, draft],
  );
  const editingAppearance = editingLayout?.appearance;
  const editingPlacement =
    editingObject && editingLayout
      ? textPlacement(
          editingObject,
          editingLayout.appearance,
          editingLayout.metrics.lines.length,
          editingLayout.editorContentHeight,
        )
      : null;
  const alignmentSelection = (editingObject ? [editingObject] : selected).filter(
    (o) => !['image', 'frame', 'link', 'arrow'].includes(o.type),
  );
  const editorOrigin =
    editingObject && editingPlacement
      ? localToWorld(editingObject, { x: editingPlacement.left, y: editingPlacement.top })
      : null;
  const setSelectionColor = (color: string, restoreFocus = true) => {
    const session = editingSession.current;
    if (session) {
      session.object = { ...session.object, color };
      setEditing(session.object);
      if (restoreFocus) editorRef.current?.focus();
    } else
      engine.current?.apply({
        upserts: engine.current.selected.map((o) => ({ ...o, color })),
        deleted: [],
      });
  };
  const toggleAlignment = (axis: 'centerX' | 'centerY') => {
    const session = editingSession.current;
    if (session) {
      session.object = { ...session.object, [axis]: !session.object[axis] };
      setEditing(session.object);
      editorRef.current?.focus();
    } else {
      const objects = engine.current?.selected.filter((o) => o.type !== 'image') || [];
      if (!objects.length) return;
      const enabled = !objects.every((o) => o[axis]);
      engine.current?.apply({
        upserts: objects.map((o) => ({ ...o, [axis]: enabled })),
        deleted: [],
      });
    }
  };
  const error = (e: unknown) => onError(e instanceof Error ? e.message : String(e));
  const selectTool = (value: Tool) => {
    setTool(value);
    engine.current?.setTool(value);
  };
  const startEdit = (o: CanvasObject) => {
    if (o.type === 'arrow') {
      (window.document.querySelector('[aria-label="Arrow label"]') as HTMLButtonElement)?.click();
      return;
    }
    if (editingSession.current?.object.id === o.id) {
      editorRef.current?.focus();
      return;
    }
    if (editingSession.current) finishEdit();
    engine.current?.setSelection([o.id]);
    const value = (o.type === 'image' ? o.imageTitle : o.text) || '';
    editingSession.current = { object: { ...o }, draft: value };
    engine.current?.setEditing(o.id);
    setEditing({ ...o });
    setDraft(value);
  };
  const openObject = (o: CanvasObject) => {
    if (o.type === 'video') setVideo(o);
    else if (o.type === 'link') {
      const id = youtubeId(o.url!);
      if (id) {
        if (o.linkCompact || o.height === compactLinkHeight)
          engine.current?.apply({
            upserts: [
              {
                ...setLinkCompact(o, false),
                height: o.linkPreviewHeight || ((o.width - 24) * 9) / 16 + 80,
              },
            ],
            deleted: [],
          });
        setPlayer({ id: o.id, videoId: id, muted: false });
      } else openLink(o.url!).catch(error);
    }
  };
  const activate = (o: CanvasObject) => {
    if (o.type === 'link' && o.linkCompact) openLink(o.url!).catch(error);
    else if (o.type === 'link') openObject(o);
    else if (o.type !== 'image' || o.imageTitle?.trim()) startEdit(o);
  };
  const previewRequests = useRef(new Map<string, Engine>());
  const refreshLink = (o: CanvasObject, e: Engine, autoplay = false) => {
    if (!window.canvas?.linkPreview || previewRequests.current.get(o.id) === e) return;
    previewRequests.current.set(o.id, e);
    e.setLinkLoading(o.id, true);
    void loadLinkPreview(
      o,
      (url) => window.canvas!.linkPreview(url),
      () => engine.current === e,
      (meta) => {
        e.hydrateLink(o.id, { ...meta, url: o.url! });
        const id = youtubeId(o.url!);
        if (
          autoplay &&
          id &&
          meta.assetId &&
          e.objects.has(o.id) &&
          !e.objects.get(o.id)?.linkCompact
        )
          setPlayer({ id: o.id, videoId: id, muted: true });
      },
    ).finally(() => {
      e.setLinkLoading(o.id, false);
      if (previewRequests.current.get(o.id) === e) previewRequests.current.delete(o.id);
    });
  };
  const enrichLink = (o: CanvasObject, e: Engine) => {
    refreshLink(o, e, true);
  };
  const startCrop = (o: CanvasObject) => {
    if (editingSession.current) finishEdit();
    const session = { object: { ...o }, crop: { ...(o.crop || fullCrop) } };
    cropSession.current = session;
    setCropping(session);
    setMenu(null);
    engine.current?.setSelection([o.id]);
    engine.current?.setCropPreview(uncroppedImage(o));
  };
  const finishCrop = (cancel = false) => {
    const session = cropSession.current;
    if (!session) return;
    cropSession.current = null;
    setCropping(null);
    engine.current?.setCropPreview(null);
    if (!cancel) {
      const next = cropImage(session.object, session.crop);
      if (JSON.stringify(next) !== JSON.stringify(session.object))
        engine.current?.apply({ upserts: [next], deleted: [] });
    }
    host.current?.focus();
  };
  const create = (t: Tool, p: { x: number; y: number }) => {
    const e = engine.current;
    if (!e) return;
    if (t === 'link') {
      setLinkValue('');
      setLinkPoint(p);
      selectTool('select');
      return;
    }
    const type = t === 'hand' || t === 'select' ? 'text' : t;
    const o: CanvasObject = {
      id: uid(),
      type,
      x: p.x,
      y: p.y,
      width: type === 'frame' ? 520 : type === 'text' ? 360 : 240,
      height: type === 'frame' ? 360 : type === 'text' ? 72 : 200,
      z: type === 'frame' ? -1 : e.topZ() + 1,
      text: type === 'frame' ? 'Untitled frame' : '',
      color: type === 'note' ? '#f8efd4' : type === 'text' ? '#29313b' : '#e4ecfa',
      fontSize: type === 'frame' ? 14 : type === 'note' ? 21 : 24,
    };
    e.apply({ upserts: [o], deleted: [] });
    e.setSelection([o.id]);
    selectTool('select');
    if (['text', 'note', 'frame'].includes(type)) startEdit(o);
  };
  const finishEdit = (cancel = false) => {
    const session = editingSession.current;
    if (!session) return;
    editingSession.current = null;
    const editing = session.object,
      draft = session.draft;
    engine.current?.setEditing(null);
    if (!cancel && engine.current) {
      if (editing.type === 'text') {
        if (!draft.trim()) engine.current.apply({ upserts: [], deleted: [editing.id] });
        else {
          const next = fitTextObject(editing, draft);
          if (JSON.stringify(next) !== JSON.stringify(engine.current.objects.get(editing.id)))
            engine.current.apply({ upserts: [next], deleted: [] });
        }
      } else if (editing.type === 'image') {
        const next = { ...editing, imageTitle: draft.trim() };
        if (JSON.stringify(next) !== JSON.stringify(engine.current.objects.get(editing.id)))
          engine.current.apply({ upserts: [next], deleted: [] });
      } else {
        const { padding, lineHeight } = textAppearance(editing);
        const height =
          editing.type === 'frame' || editing.type === 'note'
            ? editing.height
            : Math.max(
                editing.height,
                (editorRef.current?.scrollHeight || lineHeight * engine.current.camera.zoom) /
                  engine.current.camera.zoom +
                  padding * 2,
              );
        const next = { ...editing, text: draft, height };
        if (JSON.stringify(next) !== JSON.stringify(engine.current.objects.get(editing.id)))
          engine.current.apply({ upserts: [next], deleted: [] });
      }
    }
    if (cancel && editing.type === 'text' && !engine.current?.objects.get(editing.id)?.text?.trim())
      engine.current?.apply({ upserts: [], deleted: [editing.id] });
    setEditing(null);
    host.current?.focus();
  };
  useEffect(() => {
    alive.current = true;
    queue.current = new SaveQueue(doc.board.id, doc.revision, onSave, (args) =>
      invoke('patchBoard', { ...args }),
    );
    const fitted = doc.objects.map((o) =>
      o.type === 'text'
        ? fitTextObject(o)
        : o.type === 'link' && !o.assetId
          ? normalizeLinkSize(o)
          : o,
    );
    const resized = fitted.filter(
      (o, i) => o.width !== doc.objects[i].width || o.height !== doc.objects[i].height,
    );
    if (resized.length) queue.current.enqueue({ upserts: resized, deleted: [] });
    const e = new Engine(host.current!, fitted, doc.camera, {
      edit: (edit) => {
        queue.current!.enqueue(edit);
        setCount(e.objects.size);
      },
      camera: (c) => {
        setCamera(c);
        queue.current!.enqueue({ upserts: [], deleted: [] }, c);
      },
      selection: setSelected,
      tool: setTool,
      rotation: (value) => {
        const el = angleRef.current;
        if (!el) return;
        el.hidden = !value;
        if (value) {
          el.textContent = `${Math.round(value.angle * 10) / 10}°`;
          el.style.left = `${value.x + 14}px`;
          el.style.top = `${value.y - 12}px`;
        }
      },
      selectionView: (bounds, viewport) => {
        selectionView.current = { bounds, viewport };
        positionTools();
        positionPlayer();
      },
      activate,
      create,
      context: (p) => setMenu(p),
      ready: () => {
        setReady(true);
        window.canvas?.rendererReady();
      },
      error: onError,
    });
    engine.current = e;
    const recoverPreviews = () => {
      for (const o of e.all) if (o.type === 'link' && !o.assetId) refreshLink(o, e);
    };
    recoverPreviews();
    window.addEventListener('online', recoverPreviews);
    return () => {
      window.removeEventListener('online', recoverPreviews);
      alive.current = false;
      e.destroy();
      engine.current = null;
      queue.current?.flush().catch(error);
    };
  }, []);
  useLayoutEffect(() => {
    engine.current?.setEditingPreview(editingObject);
  }, [editingObject]);
  useLayoutEffect(() => {
    const el = toolsRef.current;
    if (!el) return;
    const measure = () => {
      toolsSize.current = { width: el.offsetWidth, height: el.offsetHeight };
      positionTools();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [selected, editing, cropping]);
  useEffect(() => {
    if (editing) {
      const editor = editorRef.current;
      editor?.focus();
      editor?.setSelectionRange(editor.value.length, editor.value.length);
    }
  }, [editing?.id]);
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!editing || !el || !editingAppearance) return;
    if (
      (editing.centerY || editing.type === 'frame' || editing.type === 'image') &&
      editingPlacement
    ) {
      const available =
        (editingObject || editing).height - editingPlacement.top - editingAppearance.padding;
      el.style.height = `${Math.max(1, Math.min(editingPlacement.height, available)) * camera.zoom}px`;
      return;
    }
    if (editing.type === 'note' || editing.type === 'text') {
      el.style.height = `${Math.max(1, (editingObject || editing).height - editingAppearance.padding * 2) * camera.zoom}px`;
      return;
    }
    el.style.height = '0px';
    el.style.height = `${Math.max(editingAppearance.lineHeight * camera.zoom, el.scrollHeight)}px`;
  }, [editing, editingObject, editingAppearance, draft, camera.zoom]);
  async function addAssets(assets: Asset[], point?: { x: number; y: number }) {
    const e = engine.current;
    if (!e || !alive.current) return;
    const p = point || e.center();
    const top = e.topZ();
    const objects = assets.map((a, i) => {
      const width = Math.min(a.width, 480),
        height = (width * a.height) / a.width;
      return {
        id: uid(),
        type: a.mime.startsWith('video/') ? 'video' : 'image',
        assetId: a.id,
        x: p.x + i * 36 - width / 2,
        y: p.y + i * 36 - height / 2,
        width,
        height,
        z: top + i + 1,
        text: a.name,
      } as CanvasObject;
    });
    e.apply({ upserts: objects, deleted: [] });
    e.setSelection(objects.map((o) => o.id));
  }
  async function performImport(load: () => Promise<Asset[]>, point?: { x: number; y: number }) {
    setBusy((n) => n + 1);
    const task = (async () => {
      try {
        await addAssets(await load(), point);
      } catch (e) {
        error(e);
      } finally {
        if (alive.current) setBusy((n) => n - 1);
      }
    })();
    imports.current.add(task);
    try {
      await task;
    } finally {
      imports.current.delete(task);
    }
  }
  async function importMedia() {
    await performImport(pickMedia);
  }
  useImperativeHandle(ref, () => ({
    flush: async () => {
      arrowDraft.current?.flush();
      engine.current?.stopCameraAnimation();
      if (editing) finishEdit();
      if (cropSession.current) finishCrop();
      await Promise.all([...imports.current]);
      await queue.current?.flush();
    },
    importMedia,
    fit: () => engine.current?.fit(),
  }));
  const pasteObjects = (objects: CanvasObject[]) => {
    const e = engine.current;
    if (!e || !objects.length) return;
    const groups = new Map<string, string>();
    const top = e.topZ();
    const copies = objects.map((o, i) => {
      if (o.groupId && !groups.has(o.groupId)) groups.set(o.groupId, uid());
      return {
        ...o,
        id: uid(),
        groupId: o.groupId ? groups.get(o.groupId) : undefined,
        x: o.x + 30,
        y: o.y + 30,
        z: top + i + 1,
      };
    });
    e.apply({ upserts: copies, deleted: [] });
    e.setSelection(copies.map((o) => o.id));
    for (const o of copies) if (o.type === 'link' && !o.assetId) refreshLink(o, e);
  };
  useEffect(() => {
    const typing = () =>
      !!editingSession.current ||
      !!(document.activeElement as HTMLElement)?.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role=dialog]',
      );
    const paste = async (event: ClipboardEvent) => {
      if (typing()) return;
      const e = engine.current;
      if (!e) return;
      const data = event.clipboardData;
      if (!data) return;
      event.preventDefault();
      const files = [...data.files];
      if (files.length) {
        await performImport(() => importFiles(files));
        return;
      }
      const json = data.getData('application/x-terra-board-objects');
      if (json) {
        try {
          pasteObjects(clipboardObjects(JSON.parse(json)));
        } catch {
          onError('The copied objects could not be pasted.');
        }
        return;
      }
      const text = data.getData('text/plain');
      if (!text) return;
      if (text.length > 100000) {
        onError('Paste up to 100,000 characters at once.');
        return;
      }
      const p = e.center(),
        url = pastedUrl(text);
      const o: CanvasObject = {
        id: uid(),
        type: url ? 'link' : 'text',
        x: p.x - (url ? 220 : 180),
        y: p.y - (url ? compactLinkHeight / 2 : 40),
        width: url ? 440 : 360,
        height: url
          ? compactLinkHeight
          : Math.min(1500, Math.max(80, text.split('\n').length * 30)),
        z: e.topZ() + 1,
        text: url ? new URL(url).hostname : text,
        color: url ? '#ffffff' : '#29313b',
        fontSize: 22,
        ...(url ? { url } : {}),
      };
      e.apply({ upserts: [fitTextObject(o)], deleted: [] });
      e.setSelection([o.id]);
      if (url) enrichLink(o, e);
    };
    const copyEvent = (event: ClipboardEvent) => {
      if (typing() || !engine.current?.selected.length) return;
      event.preventDefault();
      const objects = engine.current.selected;
      copy.current = objects;
      event.clipboardData?.setData('application/x-terra-board-objects', JSON.stringify(objects));
      event.clipboardData?.setData(
        'text/plain',
        objects.map((o) => o.text || o.url || o.type).join('\n'),
      );
    };
    const key = (event: KeyboardEvent) => {
      if (editingSession.current) return;
      if (typing()) return;
      const e = engine.current;
      if (!e) return;
      const mod = event.ctrlKey || event.metaKey;
      const k = event.key.toLowerCase();
      if (mod && k === 'z') {
        event.preventDefault();
        event.shiftKey ? e.redo() : e.undo();
      } else if (mod && k === 'y') {
        event.preventDefault();
        e.redo();
      } else if (mod && k === 'a') {
        event.preventDefault();
        e.setSelection(e.all.map((o) => o.id));
      } else if (mod && k === 'd') {
        event.preventDefault();
        e.duplicate();
      } else if (mod && k === 'g') {
        event.preventDefault();
        event.shiftKey ? e.ungroup() : e.group();
      } else if (mod && k === 's') {
        event.preventDefault();
        queue.current?.flush().catch(error);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        e.deleteSelected();
      } else if (event.key === 'Escape') {
        setMenu(null);
        e.setSelection([]);
        selectTool('select');
      } else if (!mod && !event.altKey) {
        const t = tools.find((t) => t.key.toLowerCase() === k);
        if (t) selectTool(t.id);
        if (k === '0') e.fit();
      }
    };
    window.addEventListener('paste', paste);
    window.addEventListener('copy', copyEvent);
    const cut = (event: ClipboardEvent) => {
      if (typing()) return;
      copyEvent(event);
      engine.current?.deleteSelected();
    };
    window.addEventListener('cut', cut);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('paste', paste);
      window.removeEventListener('copy', copyEvent);
      window.removeEventListener('cut', cut);
      window.removeEventListener('keydown', key);
    };
  }, []);
  async function drop(e: React.DragEvent) {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const r = host.current!.getBoundingClientRect(),
      point = engine.current!.screenPoint({ x: e.clientX - r.left, y: e.clientY - r.top });
    await performImport(() => importFiles(files), point);
  }
  async function exportView() {
    try {
      const canvas = await engine.current!.screenshot();
      if ('toBlob' in canvas)
        (canvas as HTMLCanvasElement).toBlob((b) => {
          if (b) download(b, 'Canvas view.png');
        });
    } catch (e) {
      error(e);
    }
  }
  const contextItems: (MenuItem | null)[] = [
    ...(selected.length === 1 && selected[0].type === 'link' && selected[0].assetId
      ? [
          {
            label: selected[0].linkCompact ? 'Show image preview' : 'Show compact card',
            icon: selected[0].linkCompact ? <ImagePlus /> : <Link2 />,
            action: () => {
              if (editingSession.current) finishEdit();
              const o = engine.current?.objects.get(selected[0].id);
              if (!o) return;
              if (player?.id === o.id) setPlayer(null);
              engine.current?.apply({ upserts: [setLinkCompact(o, !o.linkCompact)], deleted: [] });
            },
          },
          null,
        ]
      : []),
    ...(selected.length === 1 && selected[0].type === 'image'
      ? [
          {
            label: selected[0].imageTitle?.trim() ? 'Edit title' : 'Add title',
            icon: <Type />,
            action: () => startEdit(selected[0]),
          },
          { label: 'Crop image', icon: <Crop />, action: () => startCrop(selected[0]) },
          null,
        ]
      : []),
    {
      label: 'Undo',
      icon: <Undo2 />,
      action: () => engine.current?.undo(),
      disabled: !engine.current?.history.canUndo,
    },
    {
      label: 'Redo',
      icon: <Redo2 />,
      action: () => engine.current?.redo(),
      disabled: !engine.current?.history.canRedo,
    },
    null,
    {
      label: 'Duplicate',
      icon: <Copy />,
      action: () => engine.current?.duplicate(),
      disabled: !selected.length,
    },
    {
      label: selected.some((o) => o.groupId) ? 'Ungroup' : 'Group',
      icon: <Group />,
      action: () =>
        selected.some((o) => o.groupId) ? engine.current?.ungroup() : engine.current?.group(),
      disabled: selected.length < 2,
    },
    null,
    { label: 'Fit board', icon: <Maximize2 />, action: () => engine.current?.fit() },
    { label: 'Export visible area as PNG', icon: <Download />, action: exportView },
    null,
    {
      label: 'Delete selection',
      icon: <Trash2 />,
      action: () => engine.current?.deleteSelected(),
      danger: true,
      disabled: !selected.length,
    },
  ];
  return (
    <div className="whiteboard">
      <div
        ref={host}
        tabIndex={0}
        aria-label="Whiteboard"
        className={'canvas-surface tool-' + tool}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={drop}
      />
      {!ready && <div className="canvas-loading">Opening canvas…</div>}
      {ready && !count && (
        <div className="empty-canvas">
          <h1>Room for your next idea.</h1>
          <p>Paste an image, drop a file, or add a note.</p>
          <button className="button" onClick={importMedia}>
            <ImagePlus size={16} />
            Add images or video
          </button>
        </div>
      )}
      {busy > 0 && (
        <div className="import-status" role="status">
          Importing media…
        </div>
      )}
      {selected.length > 0 && !cropping && (
        <div
          ref={toolsRef}
          className="selection-tools"
          aria-label="Selection actions"
          onPointerDown={(event) => {
            if (editingSession.current && !(event.target instanceof HTMLInputElement))
              event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (!editingSession.current) return;
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              finishEdit(true);
            }
          }}
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget) &&
              event.relatedTarget !== editorRef.current
            )
              finishEdit();
          }}
        >
          {selected.length === 1 && selected[0].type === 'arrow' && (
            <ArrowControls
              key={selected[0].id}
              draftRef={arrowDraft}
              object={selected[0]}
              onChange={(patch, record = true) => {
                const e = engine.current,
                  o = e?.objects.get(selected[0].id);
                if (o) e?.apply({ upserts: [{ ...o, ...patch }], deleted: [] }, record);
              }}
              onCommitSlider={(field, before) => {
                const e = engine.current,
                  o = e?.objects.get(selected[0].id);
                if (!e || !o?.arrow) return;
                const current = field === 'thickness' ? o.arrow.thickness : o.fontSize || 18;
                if (current === before) return;
                e.history.push(
                  { upserts: [o], deleted: [] },
                  {
                    upserts: [
                      field === 'thickness'
                        ? { ...o, arrow: { ...o.arrow, thickness: before } }
                        : { ...o, fontSize: before },
                    ],
                    deleted: [],
                  },
                );
              }}
            />
          )}
          {selected.every(
            (o) => !['image', 'video', 'link', 'frame', 'arrow'].includes(o.type),
          ) && (
            <div className="color-options">
              {colors.map((color) => (
                <button
                  key={color}
                  style={{ background: color }}
                  aria-label={'Set color ' + color}
                  title={color === '#000000' ? 'Black' : color}
                  onClick={() => setSelectionColor(color)}
                />
              ))}
              <label className="custom-color" title="Custom color">
                <Plus size={12} aria-hidden="true" />
                <input
                  type="color"
                  aria-label="Custom color"
                  value={editingObject?.color || selected[0]?.color || '#29313b'}
                  onChange={(event) => setSelectionColor(event.target.value, false)}
                />
              </label>
            </div>
          )}
          {selected.length === 1 && ['video', 'link'].includes(selected[0].type) && (
            <button
              className="icon-button"
              aria-label={
                selected[0].type === 'video' || youtubeId(selected[0].url || '')
                  ? 'Play video'
                  : 'Open link'
              }
              onClick={() => openObject(selected[0])}
            >
              {selected[0].type === 'video' || youtubeId(selected[0].url || '') ? (
                <Play size={16} />
              ) : (
                <ExternalLink size={16} />
              )}
            </button>
          )}
          {selected.length === 1 &&
            selected[0].type === 'link' &&
            youtubeId(selected[0].url || '') && (
              <button
                className="icon-button"
                aria-label="Open on YouTube"
                onClick={() => openLink(selected[0].url!).catch(error)}
              >
                <ExternalLink size={16} />
              </button>
            )}
          {selected.length > 1 && (
            <button
              className="icon-button"
              aria-label={selected.some((o) => o.groupId) ? 'Ungroup selection' : 'Group selection'}
              onClick={() =>
                selected.some((o) => o.groupId)
                  ? engine.current?.ungroup()
                  : engine.current?.group()
              }
            >
              {selected.some((o) => o.groupId) ? <Ungroup size={17} /> : <Group size={17} />}
            </button>
          )}
          {alignmentSelection.length > 0 && (
            <>
              <button
                className="icon-button"
                aria-label="Center horizontally"
                title="Center horizontally"
                aria-pressed={
                  alignmentSelection.length > 0 && alignmentSelection.every((o) => o.centerX)
                }
                disabled={!alignmentSelection.length}
                onClick={() => toggleAlignment('centerX')}
              >
                <AlignHorizontalJustifyCenter size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="Center vertically"
                title="Center vertically"
                aria-pressed={
                  alignmentSelection.length > 0 && alignmentSelection.every((o) => o.centerY)
                }
                disabled={!alignmentSelection.length}
                onClick={() => toggleAlignment('centerY')}
              >
                <AlignVerticalJustifyCenter size={17} />
              </button>
            </>
          )}
          {selected.length === 1 && selected[0].type === 'image' && (
            <button
              className="icon-button"
              aria-label={selected[0].imageTitle?.trim() ? 'Edit title' : 'Add title'}
              title={selected[0].imageTitle?.trim() ? 'Edit title' : 'Add title'}
              onClick={() => startEdit(selected[0])}
            >
              <Type size={17} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Duplicate selection"
            onClick={() => {
              finishEdit();
              engine.current?.duplicate();
            }}
          >
            <Copy size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Delete selection"
            onClick={() => {
              finishEdit();
              engine.current?.deleteSelected();
            }}
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
      {editing && editingAppearance && (
        <textarea
          ref={editorRef}
          className={'text-editor ' + (editing.type === 'note' ? 'note-editor' : '')}
          aria-label={
            editing.type === 'image'
              ? 'Edit image title'
              : editing.type === 'frame'
                ? 'Edit frame name'
                : 'Edit canvas text'
          }
          placeholder={editing.type === 'image' ? 'Image title' : undefined}
          maxLength={100000}
          value={draft}
          onChange={(e) => {
            if (editingSession.current) editingSession.current.draft = e.target.value;
            setDraft(e.target.value);
          }}
          onBlur={(event) => {
            if (!toolsRef.current?.contains(event.relatedTarget)) finishEdit();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              finishEdit(true);
            } else if (
              (e.ctrlKey ||
                e.metaKey ||
                (['frame', 'image'].includes(editing.type) && !e.shiftKey)) &&
              e.key === 'Enter'
            ) {
              e.preventDefault();
              finishEdit();
            }
          }}
          style={{
            whiteSpace: editing.type === 'text' && !editing.textBox ? 'pre' : 'pre-wrap',
            overflowWrap: editing.type === 'text' && !editing.textBox ? 'normal' : 'break-word',
            left: (editorOrigin?.x ?? editing.x) * camera.zoom + camera.x,
            top: (editorOrigin?.y ?? editing.y) * camera.zoom + camera.y,
            transform: `rotate(${editing.rotation || 0}deg)`,
            transformOrigin: '0 0',
            textAlign:
              !['frame', 'image'].includes(editing.type) && editing.centerX ? 'center' : 'left',
            width: editingAppearance.wrapWidth * camera.zoom,
            fontSize: editingAppearance.fontSize * camera.zoom,
            lineHeight: `${editingAppearance.lineHeight * camera.zoom}px`,
            fontFamily: editingAppearance.fontFamily,
            color: editingAppearance.color,
          }}
        />
      )}
      <div ref={angleRef} className="rotation-angle" aria-label="Rotation angle" hidden />
      {cropping && (
        <ImageCrop
          image={uncroppedImage(cropping.object)}
          camera={camera}
          value={cropping.crop}
          onChange={(crop) => {
            const next = { object: cropping.object, crop };
            cropSession.current = next;
            setCropping(next);
          }}
          onApply={() => finishCrop()}
          onCancel={() => finishCrop(true)}
        />
      )}
      <div className="canvas-toolbar" aria-label="Canvas tools">
        {tools.map(({ id, label, icon: Icon, key }, i) => (
          <button
            key={id}
            className={'icon-button ' + (i === 2 ? 'tool-divider' : '')}
            aria-label={label}
            title={
              id === 'hand' ? 'Pan · Right-drag anywhere · H · Space + drag' : `${label} · ${key}`
            }
            aria-pressed={tool === id}
            onClick={() => selectTool(id)}
          >
            <Icon size={19} strokeWidth={1.7} />
          </button>
        ))}
        <span className="divider" />
        <button
          className="icon-button"
          aria-label="Add images or video"
          title="Add images or video"
          onClick={importMedia}
        >
          <ImagePlus size={19} />
        </button>
      </div>
      <div className="canvas-zoom">
        <button
          className="icon-button"
          aria-label="Zoom out"
          onClick={() => engine.current?.zoom(1 / 1.2)}
        >
          <Minus size={17} />
        </button>
        <button
          className="zoom-value"
          title="Fit board · 0"
          aria-label="Fit board"
          onClick={() => engine.current?.fit()}
        >
          {Math.round(camera.zoom * 100)}%
        </button>
        <button
          className="icon-button"
          aria-label="Zoom in"
          onClick={() => engine.current?.zoom(1.2)}
        >
          <Plus size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="Canvas options"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right, y: r.top });
          }}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>
      {menu && <ContextMenu {...menu} items={contextItems} onClose={() => setMenu(null)} />}
      {video && (
        <Modal title={video.text || 'Video'} onClose={() => setVideo(null)} wide>
          <video
            controls
            autoPlay
            src={mediaUrl(video.assetId!, 'original')}
            className="video-player"
          />
        </Modal>
      )}
      {player && (
        <div ref={playerRef} className="board-link-player">
          <iframe
            key={`${player.id}-${player.muted}`}
            title="YouTube video player"
            src={`https://www.youtube-nocookie.com/embed/${player.videoId}?autoplay=1&playsinline=1&rel=0${player.muted ? '&mute=1&end=8' : ''}`}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allowFullScreen
          />
          <div className="board-player-controls">
            {player.muted && (
              <button onClick={() => setPlayer({ ...player, muted: false })}>
                Play with sound
              </button>
            )}
            <button aria-label="Close video preview" onClick={() => setPlayer(null)}>
              ×
            </button>
          </div>
        </div>
      )}
      {linkPoint && (
        <Modal title="Add a link" onClose={() => setLinkPoint(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              try {
                const url = new URL(linkValue);
                if (!pastedUrl(linkValue))
                  throw Error('Use an http or https web address up to 8,192 characters');
                const engineNow = engine.current!;
                const o: CanvasObject = {
                  id: uid(),
                  type: 'link',
                  ...linkPoint,
                  width: 440,
                  height: compactLinkHeight,
                  z: engineNow.topZ() + 1,
                  url: url.href,
                  text: url.hostname,
                };
                engineNow.apply({ upserts: [o], deleted: [] });
                engineNow.setSelection([o.id]);
                enrichLink(o, engineNow);
                setLinkPoint(null);
              } catch (err) {
                error(err);
              }
            }}
          >
            <label>
              Web address
              <input
                autoFocus
                type="url"
                maxLength={8192}
                value={linkValue}
                onChange={(e) => setLinkValue(e.target.value)}
                placeholder="https://"
                required
              />
            </label>
            <div className="dialog-actions">
              <button className="button primary">Add link</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
});
export default Whiteboard;
