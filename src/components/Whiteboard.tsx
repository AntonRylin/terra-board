import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  MousePointer2,
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
  Pencil,
  Play,
  ExternalLink,
} from 'lucide-react';
import type { Asset, CanvasObject, Document, Edit, Tool } from '../model';
import { uid } from '../model';
import { clipboardObjects, pastedUrl } from '../canvas/content';
import { Engine } from '../canvas/engine';
import { SaveQueue, type SaveState } from '../canvas/save-queue';
import { importFiles, pickMedia, openLink, mediaUrl, download, invoke } from '../bridge';
import { ContextMenu, Modal, type MenuItem } from './Dialogs';
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
  { id: 'frame', label: 'Frame', icon: Frame, key: 'F' },
  { id: 'link', label: 'Link', icon: Link2, key: 'L' },
];
const colors = ['#f8efd4', '#e4eee8', '#e4ecfa', '#efe5f1', '#f4e4e5', '#ffffff'];
const Whiteboard = forwardRef<WhiteboardHandle, Props>(function Whiteboard(
  { document: doc, onSave, onError },
  ref,
) {
  const host = useRef<HTMLDivElement>(null),
    engine = useRef<Engine | null>(null),
    queue = useRef<SaveQueue | null>(null),
    alive = useRef(true),
    editorRef = useRef<HTMLTextAreaElement>(null),
    copy = useRef<CanvasObject[]>([]),
    imports = useRef(new Set<Promise<void>>());
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
  const error = (e: unknown) => onError(e instanceof Error ? e.message : String(e));
  const selectTool = (value: Tool) => {
    setTool(value);
    engine.current?.setTool(value);
  };
  const startEdit = (o: CanvasObject) => {
    setEditing({ ...o });
    setDraft(o.text || '');
  };
  const activate = (o: CanvasObject) => {
    if (o.type === 'video') setVideo(o);
    else if (o.type === 'link') openLink(o.url!).catch(error);
    else if (['text', 'note', 'frame'].includes(o.type)) startEdit(o);
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
    if (!editing) return;
    if (!cancel && engine.current) {
      const height =
        editing.type === 'frame'
          ? editing.height
          : Math.max(
              editing.type === 'text' ? 40 : 120,
              (editorRef.current?.scrollHeight || editing.height * camera.zoom) / camera.zoom + 8,
            );
      engine.current.apply({ upserts: [{ ...editing, text: draft, height }], deleted: [] });
    }
    setEditing(null);
  };
  useEffect(() => {
    alive.current = true;
    queue.current = new SaveQueue(doc.board.id, doc.revision, onSave, (args) =>
      invoke('patchBoard', { ...args }),
    );
    const e = new Engine(host.current!, doc.objects, doc.camera, {
      edit: (edit) => {
        queue.current!.enqueue(edit);
        setCount(e.objects.size);
      },
      camera: (c) => {
        setCamera(c);
        queue.current!.enqueue({ upserts: [], deleted: [] }, c);
      },
      selection: setSelected,
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
    return () => {
      alive.current = false;
      e.destroy();
      engine.current = null;
      queue.current?.flush().catch(error);
    };
  }, []);
  useEffect(() => {
    if (editing) {
      editorRef.current?.focus();
      editorRef.current?.select();
    }
  }, [editing?.id]);
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
      if (editing) finishEdit();
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
  };
  useEffect(() => {
    const typing = () =>
      !!(document.activeElement as HTMLElement)?.closest(
        'input,textarea,select,[contenteditable=true],[role=dialog]',
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
      const json = data.getData('application/x-local-canvas-objects');
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
        x: p.x - 180,
        y: p.y - 40,
        width: 360,
        height: url ? 100 : Math.min(1500, Math.max(80, text.split('\n').length * 30)),
        z: e.topZ() + 1,
        text,
        color: url ? '#ffffff' : '#29313b',
        fontSize: 22,
        ...(url ? { url } : {}),
      };
      e.apply({ upserts: [o], deleted: [] });
      e.setSelection([o.id]);
    };
    const copyEvent = (event: ClipboardEvent) => {
      if (typing() || !engine.current?.selected.length) return;
      event.preventDefault();
      const objects = engine.current.selected;
      copy.current = objects;
      event.clipboardData?.setData('application/x-local-canvas-objects', JSON.stringify(objects));
      event.clipboardData?.setData(
        'text/plain',
        objects.map((o) => o.text || o.url || o.type).join('\n'),
      );
    };
    const key = (event: KeyboardEvent) => {
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
      {selected.length > 0 && !editing && (
        <div className="selection-tools" aria-label="Selection actions">
          {selected.every((o) => !['image', 'video', 'link'].includes(o.type)) && (
            <div className="color-options">
              {colors.map((color) => (
                <button
                  key={color}
                  style={{ background: color }}
                  aria-label={'Set color ' + color}
                  onClick={() =>
                    engine.current?.apply({
                      upserts: engine.current.selected.map((o) => ({ ...o, color })),
                      deleted: [],
                    })
                  }
                />
              ))}
            </div>
          )}
          {selected.length === 1 && ['text', 'note', 'frame'].includes(selected[0].type) && (
            <button
              className="icon-button"
              title="Edit text"
              aria-label="Edit text"
              onClick={() => startEdit(selected[0])}
            >
              <Pencil size={16} />
            </button>
          )}
          {selected.length === 1 && ['video', 'link'].includes(selected[0].type) && (
            <button
              className="icon-button"
              aria-label={selected[0].type === 'video' ? 'Play video' : 'Open link'}
              onClick={() => activate(selected[0])}
            >
              {selected[0].type === 'video' ? <Play size={16} /> : <ExternalLink size={16} />}
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
          <button
            className="icon-button"
            aria-label="Duplicate selection"
            onClick={() => engine.current?.duplicate()}
          >
            <Copy size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Delete selection"
            onClick={() => engine.current?.deleteSelected()}
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
      {editing && (
        <textarea
          ref={editorRef}
          className={'text-editor ' + (editing.type === 'note' ? 'note-editor' : '')}
          aria-label="Edit canvas text"
          maxLength={100000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finishEdit()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') finishEdit(true);
            else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') finishEdit();
          }}
          style={{
            left: editing.x * camera.zoom + camera.x,
            top: editing.y * camera.zoom + camera.y,
            width: editing.width * camera.zoom,
            height: editing.height * camera.zoom,
            fontSize: (editing.fontSize || 21) * camera.zoom,
            padding: (editing.type === 'text' ? 0 : 22) * camera.zoom,
            background: editing.type === 'note' ? editing.color : '#ffffff',
            color: editing.type === 'text' ? editing.color : '#434e5d',
          }}
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
                  width: 350,
                  height: 110,
                  z: engineNow.topZ() + 1,
                  url: url.href,
                  text: url.hostname,
                };
                engineNow.apply({ upserts: [o], deleted: [] });
                engineNow.setSelection([o.id]);
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
