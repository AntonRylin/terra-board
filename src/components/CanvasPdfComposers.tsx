import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  FilePlus2,
  FileText,
  GripVertical,
  LoaderCircle,
  Plus,
  Layers,
  LayoutList,
  ZoomIn,
  ZoomOut,
  Trash2,
} from 'lucide-react';
import type {
  Camera,
  CanvasObject,
  PdfComposer,
  PdfComposerPage,
  PdfComposerSource,
} from '../model';
import { localToWorld } from '../canvas/transform';
import {
  addPdfComposerColumn,
  movePdfComposerColumn,
  movePdfComposerPages,
  removePdfComposerPages,
  composerSlotCount,
} from '../canvas/pdf-composer';
import { ComposerPreviewPool } from '../canvas/pdf-composer-files';
import { renderPdfSheet } from '../canvas/pdf-render';
import ListEditOutline from './ListEditOutline';
import './canvas-pdf-composers.css';

interface Props {
  objects: CanvasObject[];
  camera: Camera;
  selectedIds: string[];
  editingId: string | null;
  interactive?: boolean;
  onEdit: (id: string | null) => void;
  onSelect: (id: string) => void;
  onUpdate: (object: CanvasObject) => void;
  onPointerDown: (event: PointerEvent) => void;
  onFiles: (id: string, files: File[]) => Promise<void>;
  onExport: (id: string, columnId: string) => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onError: (error: unknown) => void;
}

export function composerInsertionIndex(
  ids: string[],
  movingId: string,
  targetId: string | null,
  after: boolean,
): number {
  const target = targetId ? ids.indexOf(targetId) : -1;
  let index = target < 0 ? ids.length : target + (after ? 1 : 0);
  const original = ids.indexOf(movingId);
  if (original >= 0 && original < index) index--;
  return Math.max(0, index);
}

type LayoutItem = {
  id: string;
  kind: 'page' | 'column';
  columnId: string;
  node: HTMLElement;
  x: number;
  y: number;
  preview?: HTMLElement;
};

// Read layout coordinates, not animated/rotated screen bounds. The composer
// supplies the camera transform once, and drop hit testing keeps its own geometry.
function composerLayout(root: HTMLElement) {
  const items = new Map<string, LayoutItem>();
  for (const node of root.querySelectorAll<HTMLElement>(
    '.pdf-composer-column, .pdf-composer-page',
  )) {
    let x = node.offsetLeft,
      y = node.offsetTop;
    for (
      let parent = node.offsetParent as HTMLElement | null;
      parent && parent !== root;
      parent = parent.offsetParent as HTMLElement | null
    ) {
      x += parent.offsetLeft + parent.clientLeft;
      y += parent.offsetTop + parent.clientTop;
    }
    for (
      let parent = node.parentElement;
      parent && parent !== root;
      parent = parent.parentElement
    ) {
      x -= parent.scrollLeft || 0;
      y -= parent.scrollTop || 0;
    }
    const kind = node.dataset.pageId ? 'page' : 'column';
    const id = (node.dataset.pageId || node.dataset.columnId)!;
    items.set(`${kind}:${id}`, {
      id,
      kind,
      node,
      x,
      y,
      columnId: node.closest<HTMLElement>('.pdf-composer-column')!.dataset.columnId!,
    });
  }
  return items;
}

function pageMotionPreview(node: HTMLElement) {
  const clone = node.cloneNode(true) as HTMLElement;
  // Canvas pixels are not included by cloneNode. Preserve the existing preview
  // while React mounts this page under its new column.
  const originals = node.querySelectorAll('canvas');
  clone.querySelectorAll('canvas').forEach((canvas, index) => {
    const original = originals[index];
    if (!original) return;
    canvas.width = original.width;
    canvas.height = original.height;
    canvas.getContext('2d')?.drawImage(original, 0, 0);
  });
  clone.className = 'pdf-composer-motion-page';
  delete clone.dataset.pageId;
  delete clone.dataset.dragging;
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.tabIndex = -1;
  clone.inert = true;
  return clone;
}

export class ComposerLayoutMotion {
  private previous: Map<string, LayoutItem> | null = null;
  private root: HTMLElement | null = null;
  private running = new Set<{ animation: Animation; cleanup: () => void }>();

  finish() {
    for (const record of [...this.running]) {
      record.animation.cancel();
      record.cleanup();
    }
  }

  capture(root: HTMLElement, next?: PdfComposer) {
    this.finish();
    this.root = root;
    this.previous = composerLayout(root);
    if (next) {
      const destinations = new Map(
        next.columns.flatMap((column) => column.pages.map((page) => [page.id, column.id])),
      );
      for (const item of this.previous.values())
        if (
          item.kind === 'page' &&
          destinations.has(item.id) &&
          destinations.get(item.id) !== item.columnId
        )
          item.preview = pageMotionPreview(item.node);
    }
  }

  private animate(node: HTMLElement, frames: Keyframe[], kind: string, done = () => {}) {
    if (!node.animate) {
      done();
      return;
    }
    node.dataset.layoutMotion = kind;
    this.root!.dataset.layoutAnimating = 'true';
    const animation = node.animate(frames, { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
    const record = {
      animation,
      cleanup: () => {
        if (!this.running.delete(record)) return;
        delete node.dataset.layoutMotion;
        done();
        if (!this.running.size && this.root) delete this.root.dataset.layoutAnimating;
      },
    };
    this.running.add(record);
    void animation.finished.then(record.cleanup, record.cleanup);
  }

  update(root: HTMLElement, reduced: boolean) {
    this.finish();
    this.root = root;
    const before = this.previous,
      after = composerLayout(root);
    this.previous = after;
    if (!before || reduced) return;
    const translate = (x: number, y: number) => `translate(${x}px, ${y}px)`;
    for (const [key, item] of after) {
      const old = before.get(key),
        column = after.get(`column:${item.columnId}`),
        oldColumn = before.get(`column:${item.columnId}`);
      if (!old) {
        // Pages inside a new column inherit its entrance instead of moving twice.
        if (item.kind === 'column' || oldColumn)
          this.animate(
            item.node,
            [
              { transform: 'translate(0px, 8px)', opacity: 0 },
              { transform: 'translate(0px, 0px)', opacity: 1 },
            ],
            item.kind,
          );
        continue;
      }
      let x = old.x - item.x,
        y = old.y - item.y;
      if (item.kind === 'page' && old.columnId !== item.columnId) {
        const preview = old.preview || pageMotionPreview(old.node);
        preview.dataset.motionPageId = item.id;
        Object.assign(preview.style, {
          left: `${item.x}px`,
          top: `${item.y}px`,
          width: `${item.node.offsetWidth}px`,
          height: `${item.node.offsetHeight}px`,
        });
        root.append(preview);
        item.node.dataset.motionHidden = 'true';
        this.animate(
          preview,
          [{ transform: translate(x, y) }, { transform: translate(0, 0) }],
          'page',
          () => {
            const transition = item.node.style.transition;
            item.node.style.transition = 'none';
            delete item.node.dataset.motionHidden;
            // Reveal the real page on the same frame that removes its flying copy.
            void item.node.offsetWidth;
            item.node.style.transition = transition;
            preview.remove();
          },
        );
      } else {
        if (item.kind === 'page' && column && oldColumn) {
          x -= oldColumn.x - column.x;
          y -= oldColumn.y - column.y;
        }
        if (Math.abs(x) > 0.1 || Math.abs(y) > 0.1)
          this.animate(
            item.node,
            [{ transform: translate(x, y) }, { transform: translate(0, 0) }],
            item.kind,
          );
      }
    }
  }
}

function PagePreview({
  source,
  page,
  pool,
  renderWidth,
}: {
  renderWidth: number;
  source: PdfComposerSource;
  page: PdfComposerPage;
  pool: ComposerPreviewPool;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false),
    [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '120px',
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) {
      host.current?.replaceChildren();
      return;
    }
    const abort = new AbortController(),
      canvas = document.createElement('canvas');
    setFailed(false);
    setLoading(true);
    void pool
      .acquire(source, abort.signal)
      .then(async (lease) => {
        try {
          await renderPdfSheet(lease.pdf, page, canvas, renderWidth, abort.signal, 4_000_000);
          if (!abort.signal.aborted) {
            const previous = host.current?.querySelector('canvas');
            host.current?.replaceChildren(canvas);
            if (previous) previous.width = previous.height = 1;
            setLoading(false);
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            setFailed(true);
            setLoading(false);
          }
        } finally {
          lease.release();
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      abort.abort();
      if (!canvas.isConnected) canvas.width = canvas.height = 1;
    };
  }, [visible, pool, source.assetId, source.kind, page.pageIndex, page.rotation, renderWidth]);
  return (
    <span
      className="pdf-composer-preview"
      data-failed={failed || undefined}
      data-loading={(visible && loading) || undefined}
      aria-busy={visible && loading}
    >
      <span ref={host} className="pdf-composer-paper" />
      {loading && <span className="pdf-composer-preview-loading" aria-hidden="true" />}
      {failed && (
        <span className="pdf-composer-preview-error" aria-label="Page preview unavailable">
          <FileText size={24} />
          <span>Preview unavailable</span>
        </span>
      )}
    </span>
  );
}

type DropTarget = {
  kind: 'page' | 'column' | 'new';
  columnId?: string;
  targetId?: string;
  after: boolean;
  index: number;
};
type Drag = {
  kind: 'page' | 'column';
  id: string;
  ids: string[];
  collapse: boolean;
  pointerId: number;
  capture: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  label: string;
  moved: boolean;
  target: DropTarget | null;
};

function ComposerCard({
  object,
  props,
  pool,
}: {
  object: CanvasObject;
  props: Props;
  pool: ComposerPreviewPool;
}) {
  const root = useRef<HTMLElement>(null),
    picker = useRef<HTMLInputElement>(null),
    ghost = useRef<HTMLDivElement>(null);
  const motion = useRef<ComposerLayoutMotion | null>(null);
  if (!motion.current) motion.current = new ComposerLayoutMotion();
  const latest = useRef(object);
  latest.current = object;
  const pendingFocus = useRef<{ kind: 'page' | 'column'; id: string } | null>(null);
  const drag = useRef<Drag | null>(null),
    alive = useRef(true),
    operation = useRef(false);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [droppingFiles, setDroppingFiles] = useState(false);
  const [dragging, setDragging] = useState<{
    kind: 'page' | 'column';
    id: string;
    label: string;
  } | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null),
    [selectedPages, setSelectedPages] = useState<string[]>([]);
  const anchor = useRef('');
  const composer = object.pdfComposer!;
  const pageZoom = composer.zoom ?? 1;
  // Quantized screen resolution avoids a new render on every camera animation frame.
  const renderWidth = Math.min(
    2048,
    Math.max(
      256,
      Math.ceil((150 * pageZoom * props.camera.zoom * (globalThis.devicePixelRatio || 1)) / 256) *
        256,
    ),
  );
  const selection = selectedPages.filter((id) =>
    composer.columns.some((column) => column.pages.some((page) => page.id === id)),
  );
  const sources = new Map(composer.sources.map((source) => [source.id, source]));
  const editing = !object.locked && props.editingId === object.id;
  const active = props.selectedIds.includes(object.id);
  const origin = localToWorld(object, { x: 0, y: 0 });
  const commit = (next: PdfComposer) => {
    const current = latest.current;
    if (current.locked) return;
    if (
      next === current.pdfComposer ||
      JSON.stringify(next) === JSON.stringify(current.pdfComposer)
    ) {
      pendingFocus.current = null;
      return;
    }
    if (root.current) motion.current!.capture(root.current, next);
    latest.current = { ...current, pdfComposer: next };
    props.onUpdate(latest.current);
  };
  const activate = () => {
    props.onSelect(object.id);
    if (!object.locked) props.onEdit(object.id);
  };
  const focusPage = (id: string) => {
    pendingFocus.current = { kind: 'page', id };
    if (!selectedPages.includes(id)) setSelectedPages([id]);
  };
  const focusPending = () => {
    const value = pendingFocus.current;
    if (!value) return;
    const selector =
      value.kind === 'page'
        ? `[data-page-id="${CSS.escape(value.id)}"]`
        : `[data-column-handle="${CSS.escape(value.id)}"]`;
    const node = root.current?.querySelector<HTMLElement>(selector);
    if (node) {
      node.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  };
  useLayoutEffect(focusPending, [object.pdfComposer, selectedPages]);
  useLayoutEffect(() => {
    if (root.current)
      motion.current!.update(
        root.current,
        !!drag.current || matchMedia('(prefers-reduced-motion: reduce)').matches,
      );
  }, [object.pdfComposer, object.width, object.height]);
  useEffect(() => {
    alive.current = true;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => {
      if (root.current) motion.current!.capture(root.current);
    };
    preference.addEventListener('change', changed);
    return () => {
      alive.current = false;
      drag.current = null;
      motion.current!.finish();
      preference.removeEventListener('change', changed);
    };
  }, []);
  useEffect(() => {
    if (!editing && drag.current) cancelDrag();
  }, [editing]);
  useEffect(() => {
    if (editing && active && !root.current?.contains(document.activeElement))
      root.current?.focus({ preventScroll: true });
  }, [editing, active, busy]);
  const run = async (label: string, action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    root.current?.focus({ preventScroll: true });
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (reason) {
      if (alive.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
        props.onError(reason);
      }
    } finally {
      operation.current = false;
      if (alive.current) setBusy('');
    }
  };
  const files = (input: File[]) => {
    if (!input.length || operation.current) return;
    activate();
    void run('files', () => props.onFiles(object.id, input));
  };
  const newColumn = () => {
    const next = addPdfComposerColumn(latest.current.pdfComposer!);
    pendingFocus.current = { kind: 'column', id: next.columns.at(-1)!.id };
    commit(next);
  };
  const beginDrag = (
    event: PointerEvent<HTMLElement>,
    kind: Drag['kind'],
    id: string,
    label: string,
  ) => {
    if (event.button !== 0 || operation.current) return;
    event.preventDefault();
    event.stopPropagation();
    activate();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    let ids = [id];
    if (kind === 'page') {
      const all = latest.current.pdfComposer!.columns.flatMap((column) =>
        column.pages.map((page) => page.id),
      );
      if (event.shiftKey && anchor.current && all.includes(anchor.current)) {
        const a = all.indexOf(anchor.current),
          b = all.indexOf(id);
        ids = all.slice(Math.min(a, b), Math.max(a, b) + 1);
      } else if (event.ctrlKey || event.metaKey) {
        ids = selectedPages.includes(id)
          ? selectedPages.filter((value) => value !== id)
          : [...selectedPages, id];
      } else ids = selectedPages.includes(id) ? selection : [id];
      setSelectedPages(ids);
      if (!event.shiftKey) anchor.current = id;
      if (!ids.includes(id)) return;
      if (ids.length > 1) label = `${ids.length} pages`;
    }
    drag.current = {
      kind,
      id,
      ids,
      collapse: kind === 'page' && !event.ctrlKey && !event.metaKey && !event.shiftKey,
      pointerId: event.pointerId,
      capture: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      label,
      moved: false,
      target: null,
    };
  };
  const cancelDrag = () => {
    const value = drag.current;
    drag.current = null;
    if (value?.capture.hasPointerCapture(value.pointerId))
      value.capture.releasePointerCapture(value.pointerId);
    setDragging(null);
    setTarget(null);
  };
  const locateTarget = (event: PointerEvent, value: Drag): DropTarget | null => {
    const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    if (hit?.closest('.canvas-pdf-composer') !== root.current) return null;
    const metadata = latest.current.pdfComposer!;
    if (
      value.kind === 'page' &&
      metadata.columns.length < 500 &&
      hit.closest('.pdf-composer-new-column')
    )
      return { kind: 'new', after: true, index: 0 };
    const node = hit.closest<HTMLElement>('.pdf-composer-column');
    const column = metadata.columns.find((item) => item.id === node?.dataset.columnId);
    if (!node || !column) return null;
    if (value.kind === 'column') {
      const rect = node.getBoundingClientRect(),
        after = event.clientX > rect.left + rect.width / 2;
      return {
        kind: 'column',
        columnId: column.id,
        targetId: column.id,
        after,
        index: composerInsertionIndex(
          metadata.columns.map((item) => item.id),
          value.id,
          column.id,
          after,
        ),
      };
    }
    const slot = hit.closest<HTMLElement>('[data-slot-row]');
    return {
      kind: 'page',
      columnId: column.id,
      targetId: slot?.dataset.pageId,
      after: false,
      index: slot ? Number(slot.dataset.slotRow) : composerSlotCount(column),
    };
  };
  const moveDrag = (event: PointerEvent) => {
    const value = drag.current;
    if (!value || value.pointerId !== event.pointerId) return;
    event.stopPropagation();
    value.x = event.clientX;
    value.y = event.clientY;
    if (!value.moved && Math.hypot(value.x - value.startX, value.y - value.startY) < 5) return;
    if (!value.moved) {
      value.moved = true;
      setDragging({ kind: value.kind, id: value.id, label: value.label });
    }
    if (ghost.current) {
      ghost.current.style.left = `${value.x + 14}px`;
      ghost.current.style.top = `${value.y + 14}px`;
    }
    const next = locateTarget(event, value);
    if (JSON.stringify(value.target) !== JSON.stringify(next)) {
      value.target = next;
      setTarget(next);
    }
    const hit = document.elementFromPoint(value.x, value.y) as HTMLElement | null;
    const list = hit?.closest<HTMLElement>('.pdf-composer-pages');
    if (list && root.current?.contains(list)) {
      const rect = list.getBoundingClientRect();
      if (value.y < rect.top + 28) list.scrollTop -= 16;
      if (value.y > rect.bottom - 28) list.scrollTop += 16;
    }
    const track = root.current?.querySelector<HTMLElement>('.pdf-composer-columns');
    if (track) {
      const rect = track.getBoundingClientRect();
      if (value.x < rect.left + 30) track.scrollLeft -= 16;
      if (value.x > rect.right - 30) track.scrollLeft += 16;
    }
  };
  const endDrag = (event: PointerEvent) => {
    const value = drag.current;
    if (!value || value.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const destination = value.target;
    cancelDrag();
    if (!value.moved) {
      if (value.collapse) setSelectedPages([value.id]);
      return;
    }
    if (!destination) return;
    let next = latest.current.pdfComposer!;
    if (destination.kind === 'column') {
      if (!next.columns.some((column) => column.id === value.id)) return;
      const index = composerInsertionIndex(
        next.columns.map((column) => column.id),
        value.id,
        destination.targetId || null,
        destination.after,
      );
      next = movePdfComposerColumn(next, value.id, index);
      pendingFocus.current = { kind: 'column', id: value.id };
    } else {
      let columnId = destination.columnId;
      if (!next.columns.some((column) => column.pages.some((page) => page.id === value.id))) return;
      if (destination.kind === 'new') {
        if (next.columns.length >= 500) return;
        next = addPdfComposerColumn(next);
        columnId = next.columns.at(-1)!.id;
      }
      const column = next.columns.find((column) => column.id === columnId);
      if (!column) return;
      next = movePdfComposerPages(next, value.ids, column.id, destination.index);
      focusPage(value.id);
    }
    commit(next);
  };
  return (
    <section
      ref={root}
      className="canvas-pdf-composer glass-surface"
      data-composer-id={object.id}
      data-selected={active}
      data-editing={editing}
      data-view={composer.view ?? 'stacked'}
      data-drag-files={droppingFiles || undefined}
      aria-busy={!!busy}
      aria-label={object.text || 'PDF composer'}
      tabIndex={-1}
      style={
        {
          '--page-width': `${162 * pageZoom}px`,
          '--page-height': `${234 * pageZoom}px`,
          '--page-overlap': `${(composer.view === 'full' ? -14 : 158) * pageZoom}px`,
          '--column-width': `${162 * pageZoom + 30}px`,
          left: origin.x * props.camera.zoom + props.camera.x,
          top: origin.y * props.camera.zoom + props.camera.y,
          width: object.width,
          height: object.height,
          transform: `scale(${props.camera.zoom}) rotate(${object.rotation || 0}deg)`,
        } as CSSProperties
      }
      onPointerDownCapture={(event) => {
        if (object.locked) {
          event.preventDefault();
          event.stopPropagation();
          props.onSelect(object.id);
          return;
        }
        if (!root.current) return;
        root.current
          .querySelector('.pdf-composer-content')
          ?.getAnimations()
          .forEach((animation) => animation.finish());
        motion.current!.capture(root.current);
      }}
      onKeyDownCapture={(event) => {
        if (object.locked && event.key !== 'Tab' && event.key !== 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (root.current) motion.current!.capture(root.current);
      }}
      onClickCapture={(event) => {
        if (object.locked) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onScrollCapture={() => {
        if (root.current) motion.current!.capture(root.current);
      }}
      onPointerDown={(event) => {
        if (event.button === 0) activate();
        if (
          event.button !== 0 ||
          !(event.target as HTMLElement).closest('button,input,.pdf-composer-pages')
        ) {
          props.onPointerDown(event);
          if (event.button === 0) root.current?.focus({ preventScroll: true });
        } else event.stopPropagation();
      }}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId === event.pointerId) cancelDrag();
      }}
      onDragStart={(event) => event.preventDefault()}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.stopPropagation();
          setDroppingFiles(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDroppingFiles(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDroppingFiles(false);
        if (object.locked) return;
        files([...event.dataTransfer.files]);
      }}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        const input = (event.target as HTMLElement).closest('input');
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelDrag();
          props.onEdit(null);
          (event.target as HTMLElement).blur();
          return;
        }
        if (input) return;
        const mod = event.ctrlKey || event.metaKey,
          key = event.key.toLowerCase();
        if (mod && ['z', 'y'].includes(key)) {
          event.preventDefault();
          event.shiftKey || key === 'y' ? props.onRedo() : props.onUndo();
          return;
        }
        if (!operation.current && ['Delete', 'Backspace'].includes(event.key) && selection.length) {
          event.preventDefault();
          commit(removePdfComposerPages(latest.current.pdfComposer!, selection));
          setSelectedPages([]);
          root.current?.focus({ preventScroll: true });
          return;
        }
        if (mod && key === 'a') {
          event.preventDefault();
          setSelectedPages(
            latest.current.pdfComposer!.columns.flatMap((column) =>
              column.pages.map((page) => page.id),
            ),
          );
          return;
        }
        if (
          ['Delete', 'Backspace'].includes(event.key) ||
          (mod && ['c', 'v', 'x', 'a', '+', '=', '-', '0', 's'].includes(key))
        ) {
          event.preventDefault();
          return;
        }
        if (operation.current || !event.altKey || !event.key.startsWith('Arrow')) return;
        event.preventDefault();
        const metadata = latest.current.pdfComposer!;
        const pageId = (event.target as HTMLElement).closest<HTMLElement>('[data-page-id]')?.dataset
          .pageId;
        const columnId = (event.target as HTMLElement).closest<HTMLElement>('[data-column-handle]')
          ?.dataset.columnHandle;
        if (pageId) {
          const ci = metadata.columns.findIndex((column) =>
            column.pages.some((page) => page.id === pageId),
          );
          if (ci < 0) return;
          const column = metadata.columns[ci],
            pi = column.pages.findIndex((page) => page.id === pageId);
          const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
          const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
          const destination = horizontal ? metadata.columns[ci + delta] : column;
          if (!destination) return;
          focusPage(pageId);
          commit(
            movePdfComposerPages(
              metadata,
              selection.includes(pageId) ? selection : [pageId],
              destination.id,
              horizontal
                ? (column.pages[pi].row ?? pi)
                : Math.max(0, (column.pages[pi].row ?? pi) + delta),
            ),
          );
        } else if (columnId && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          const ci = metadata.columns.findIndex((column) => column.id === columnId);
          pendingFocus.current = { kind: 'column', id: columnId };
          commit(
            movePdfComposerColumn(metadata, columnId, ci + (event.key === 'ArrowLeft' ? -1 : 1)),
          );
        }
      }}
    >
      {editing && <ListEditOutline width={object.width} height={object.height} />}
      <div className="pdf-composer-content">
        <header className="pdf-composer-header">
          <FileText size={17} />
          <span className="pdf-composer-title">{object.text || 'PDF composer'}</span>
          <button
            className="pdf-composer-action"
            aria-label={composer.view === 'full' ? 'Stack pages' : 'Show whole pages'}
            data-tooltip={composer.view === 'full' ? 'Stack pages' : 'Show whole pages'}
            disabled={!!busy}
            onClick={() =>
              commit({
                ...latest.current.pdfComposer!,
                view: composer.view === 'full' ? 'stacked' : 'full',
              })
            }
          >
            {composer.view === 'full' ? <Layers size={17} /> : <LayoutList size={17} />}
          </button>
          <button
            className="pdf-composer-action"
            aria-label="Zoom pages out"
            data-tooltip="Smaller pages"
            disabled={!!busy || pageZoom <= 0.75}
            onClick={() =>
              commit({ ...latest.current.pdfComposer!, zoom: Math.max(0.75, pageZoom - 0.25) })
            }
          >
            <ZoomOut size={17} />
          </button>
          <button
            className="pdf-composer-action"
            aria-label="Zoom pages in"
            data-tooltip="Larger pages"
            disabled={!!busy || pageZoom >= 3}
            onClick={() =>
              commit({ ...latest.current.pdfComposer!, zoom: Math.min(3, pageZoom + 0.25) })
            }
          >
            <ZoomIn size={17} />
          </button>
          {!!selection.length && (
            <button
              className="pdf-composer-action"
              aria-label="Remove selected pages"
              data-tooltip={`Remove ${selection.length} selected ${selection.length === 1 ? 'page' : 'pages'}`}
              disabled={!!busy}
              onClick={() => {
                commit(removePdfComposerPages(latest.current.pdfComposer!, selection));
                setSelectedPages([]);
              }}
            >
              <Trash2 size={16} />
            </button>
          )}
          <button
            className="pdf-composer-action"
            aria-label="Add documents or images"
            data-tooltip="Add documents or images"
            disabled={!!busy}
            onClick={() => picker.current?.click()}
          >
            {busy === 'files' ? (
              <LoaderCircle size={17} className="pdf-composer-spinner" />
            ) : (
              <FilePlus2 size={17} />
            )}
          </button>
          <button
            className="pdf-composer-action pdf-composer-new-column"
            aria-label="New PDF column"
            data-tooltip="New PDF column"
            data-drop-target={target?.kind === 'new' || undefined}
            disabled={!!busy || composer.columns.length >= 500}
            onClick={newColumn}
          >
            <Plus size={18} />
          </button>
        </header>
        {busy && (
          <div
            className="pdf-composer-progress"
            role="progressbar"
            aria-label={busy === 'files' ? 'Adding files' : 'Exporting PDF'}
          >
            <span />
          </div>
        )}
        <div className="pdf-composer-columns">
          {composer.columns.map((column, ci) => (
            <section
              className="pdf-composer-column"
              key={column.id}
              data-column-id={column.id}
              data-drop-target={target?.columnId === column.id || undefined}
              data-dragging={
                (dragging?.kind === 'column' && dragging.id === column.id) || undefined
              }
            >
              <header className="pdf-composer-column-header">
                <button
                  className="pdf-composer-column-handle"
                  data-column-handle={column.id}
                  aria-label={`Move file ${column.name}`}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                  disabled={!!busy}
                  onPointerDown={(event) => beginDrag(event, 'column', column.id, column.name)}
                >
                  <GripVertical size={15} />
                </button>
                <input
                  aria-label="PDF column name"
                  value={column.name}
                  maxLength={240}
                  disabled={!!busy}
                  onChange={(event) =>
                    commit({
                      ...latest.current.pdfComposer!,
                      columns: latest.current.pdfComposer!.columns.map((item) =>
                        item.id === column.id ? { ...item, name: event.target.value } : item,
                      ),
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                      root.current?.focus({ preventScroll: true });
                    }
                  }}
                />
                <button
                  className="pdf-composer-action pdf-composer-export"
                  aria-label={`Export ${column.name} as PDF`}
                  data-tooltip="Export PDF"
                  disabled={!!busy || !column.pages.length}
                  onClick={() => void run(column.id, () => props.onExport(object.id, column.id))}
                >
                  {busy === column.id ? (
                    <LoaderCircle size={15} className="pdf-composer-spinner" />
                  ) : (
                    <Download size={15} />
                  )}
                </button>
              </header>
              <div className="pdf-composer-column-meta">
                {column.pages.length} {column.pages.length === 1 ? 'page' : 'pages'}
              </div>
              <div className="pdf-composer-pages" data-column-id={column.id}>
                {Array.from({ length: composerSlotCount(column) }, (_, pi) => {
                  const page = column.pages.find((item, index) => (item.row ?? index) === pi);
                  if (!page)
                    return (
                      <button
                        key={`slot-${pi}`}
                        className="pdf-composer-slot"
                        data-slot-row={pi}
                        data-drop-target={
                          (target?.columnId === column.id && target.index === pi) || undefined
                        }
                        aria-label={`Empty slot ${pi + 1} of ${column.name}`}
                        onClick={() => setSelectedPages([])}
                      >
                        <span className="pdf-composer-page-number">{pi + 1}</span>
                      </button>
                    );
                  return (
                    <button
                      className="pdf-composer-page"
                      key={page.id}
                      data-page-id={page.id}
                      data-slot-row={pi}
                      data-source-id={page.sourceId}
                      data-page-index={page.pageIndex}
                      data-selected={selection.includes(page.id) || undefined}
                      aria-pressed={selection.includes(page.id)}
                      data-dragging={
                        (dragging?.kind === 'page' && selection.includes(page.id)) || undefined
                      }
                      data-drop-target={target?.targetId === page.id || undefined}
                      data-drop-after={(target?.targetId === page.id && target.after) || undefined}
                      aria-label={`Page ${pi + 1} of ${column.name}`}
                      aria-describedby={`${object.id}-pdf-keys`}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
                      disabled={!!busy}
                      onPointerDown={(event) =>
                        beginDrag(event, 'page', page.id, `Page ${pi + 1} · ${column.name}`)
                      }
                      onClick={(event) => {
                        if (event.detail === 0)
                          setSelectedPages(
                            event.ctrlKey || event.metaKey
                              ? [...new Set([...selection, page.id])]
                              : [page.id],
                          );
                      }}
                    >
                      <span className="pdf-composer-page-number">{pi + 1}</span>
                      {sources.get(page.sourceId) ? (
                        <PagePreview
                          source={sources.get(page.sourceId)!}
                          page={page}
                          pool={pool}
                          renderWidth={renderWidth}
                        />
                      ) : (
                        <FileText size={26} />
                      )}
                    </button>
                  );
                })}
                {!composerSlotCount(column) && (
                  <span className="pdf-composer-empty">
                    <Plus size={22} />
                    <span>Drop pages here</span>
                  </span>
                )}
              </div>
            </section>
          ))}
          {!composer.columns.length && <div className="pdf-composer-empty">Drop files here</div>}
        </div>
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        accept=".pdf,image/*,.tif,.tiff,.heic,.heif,.doc,.docx,.docm,.dotx,.txt,.text,.md,.markdown,.csv,.tsv,.log,.json,.xml,.html,.htm,.rtf,.odt,.xls,.xlsx,.xlsm,.xlsb,.ods,.ppt,.pptx,.odp"
        hidden
        aria-label="PDF composer files"
        onChange={(event) => {
          files([...(event.target.files || [])]);
          event.target.value = '';
        }}
      />
      <span className="pdf-composer-sr-only" id={`${object.id}-pdf-keys`}>
        Ctrl click selects multiple pages. Shift click selects a range. Delete removes selected
        pages and leaves empty slots. Alt Up or Down reorders selected pages. Alt Left or Right
        moves it between files. Use the file handle with Alt Left or Right to reorder files.
      </span>
      {error && (
        <div className="pdf-composer-status" role="alert">
          {error}
        </div>
      )}
      {dragging &&
        createPortal(
          <div
            ref={ghost}
            className="pdf-composer-drag-preview"
            style={{ left: (drag.current?.x || 0) + 14, top: (drag.current?.y || 0) + 14 }}
          >
            <FileText size={20} />
            <span>{dragging.label}</span>
          </div>,
          document.body,
        )}
    </section>
  );
}

export default function CanvasPdfComposers(props: Props) {
  const overlay = useRef<HTMLDivElement>(null);
  const [pool] = useState(() => new ComposerPreviewPool());
  useEffect(
    () => () => {
      void pool.dispose();
    },
    [pool],
  );
  useEffect(() => {
    if (!props.editingId) return;
    const outside = (event: globalThis.PointerEvent) => {
      const hit = event.target as HTMLElement;
      if (hit.closest('.selection-tools')) return;
      if (hit.closest<HTMLElement>('.canvas-pdf-composer')?.dataset.composerId !== props.editingId)
        props.onEdit(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [props.editingId, props.onEdit]);
  useEffect(() => {
    const node = overlay.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      // The workspace is part of the board: wheel zoom stays anchored to the
      // pointer over pages and columns just as it does over the canvas itself.
      event.preventDefault();
      event.stopPropagation();
      node.parentElement?.querySelector('.canvas-surface > canvas')?.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
        }),
      );
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);
  return (
    <div
      ref={overlay}
      className="canvas-pdf-composers"
      data-interactive={props.interactive !== false}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        overlay.current?.parentElement?.querySelector('.canvas-surface')?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
          }),
        );
      }}
    >
      {props.objects
        .filter((object) => object.pdfComposer)
        .map((object) => (
          <ComposerCard key={object.id} object={object} props={props} pool={pool} />
        ))}
    </div>
  );
}
