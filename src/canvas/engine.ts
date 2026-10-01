// Pixi's interpreter adapters keep shader setup compatible with a strict CSP (no eval).
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Sprite, Rectangle, Texture } from 'pixi.js';
import type { CanvasObject, Camera, Edit, Tool, ImageCrop } from '../model';
import { uid } from '../model';
import { SpatialIndex, screenToWorld, zoomAt, boundsOf, type Point, type Bounds } from './geometry';
import { History } from './history';
import { renderText, renderLinkCaption, textRegion } from './text-rendering';
import { TextureCache } from './textures';
import { imageTiles } from './image-detail';
import { resizeHandles, handlePoint, resizeObject, type ResizeHandle } from './resize';
import { localToWorld, worldToLocal, rotationFromDrag, rotationHandlePoint } from './transform';
import { hitsFrameLabel, visualBounds, hasExternalLabel } from './frame-label';
import {
  youtubeId,
  linkLayout,
  hitsLinkPlay,
  withLinkPreview,
  linkCornerRadius,
  hasLinkImage,
} from './link-preview';
interface Callbacks {
  edit: (e: Edit) => void;
  camera: (c: Camera) => void;
  selection: (items: CanvasObject[]) => void;
  selectionView?: (bounds: Bounds | null, viewport: { width: number; height: number }) => void;
  rotation?: (value: { angle: number; x: number; y: number } | null) => void;
  activate: (o: CanvasObject) => void;
  create: (tool: Tool, p: Point) => void;
  context: (p: Point) => void;
  ready: () => void;
  error: (message: string) => void;
}
type Gesture = {
  mode: 'pan' | 'move' | 'resize' | 'rotate' | 'box';
  start: Point;
  camera: Camera;
  original: CanvasObject[];
  world: Point;
  box?: Bounds;
  changed?: boolean;
  secondary?: boolean;
  toggle?: boolean;
  corner?: ResizeHandle;
  editOnClick?: string;
  dragged?: boolean;
};
export class Engine {
  private loadingLinks = new Set<string>();
  setLinkLoading(id: string, loading: boolean) {
    if (loading) this.loadingLinks.add(id);
    else this.loadingLinks.delete(id);
    this.host.setAttribute('aria-busy', String(this.loadingLinks.size > 0));
    this.invalidate();
  }
  private linkPreviews = new Map<
    string,
    { url: string; text: string; linkDescription: string; assetId?: string; linkIconId?: string }
  >();
  hydrateLink(
    id: string,
    preview: {
      url: string;
      text: string;
      linkDescription: string;
      assetId?: string;
      linkIconId?: string;
    },
  ) {
    this.linkPreviews.set(id, preview);
    const object = this.objects.get(id);
    if (object?.type !== 'link' || object.url !== preview.url) return;
    const original = this.gesture?.original.find((o) => o.id === id);
    if (original) {
      // Metadata may arrive during a drag. Save the committed geometry, so
      // cancelling the gesture cannot leave a temporary position on disk.
      this.preview(object);
      this.callbacks.edit({ upserts: [withLinkPreview(original, preview)], deleted: [] });
      this.invalidate();
    } else this.apply({ upserts: [object], deleted: [] }, false);
  }
  app = new Application();
  camera: Camera;
  tool: Tool = 'select';
  objects = new Map<string, CanvasObject>();
  selection = new Set<string>();
  history = new History();
  private index = new SpatialIndex(visualBounds);
  private world = new Container();
  private selectionLayer = new Graphics();
  private views = new Map<string, { container: Container; signature: string }>();
  private textures: TextureCache;
  private observer: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private ready = false;
  private rendered = false;
  private space = false;
  private gesture: Gesture | null = null;
  private secondaryContextHandled = false;
  private initialized: Promise<void>;
  private groupMembers = new Map<string, Set<string>>();
  private editingId: string | null = null;
  private editingPreview: CanvasObject | null = null;
  private cropPreview: CanvasObject | null = null;
  constructor(
    private host: HTMLDivElement,
    objects: CanvasObject[],
    camera: Camera,
    private callbacks: Callbacks,
  ) {
    this.camera = { ...camera };
    for (const o of objects) this.objects.set(o.id, o);
    this.index.reset(objects);
    this.rebuildGroups();
    this.textures = new TextureCache(() => this.invalidate());
    this.initialized = this.app
      .init({
        resizeTo: host,
        backgroundAlpha: 0,
        antialias: true,
        resolution: devicePixelRatio,
        autoDensity: true,
        autoStart: false,
        preference: 'webgl',
      })
      .then(() => {
        if (this.disposed) {
          this.app.destroy(true, { children: true });
          return;
        }
        this.ready = true;
        host.prepend(this.app.canvas);
        this.app.stage.addChild(this.world, this.selectionLayer);
        this.app.canvas.setAttribute('aria-label', 'Infinite whiteboard');
        this.app.canvas.setAttribute('role', 'img');
        this.invalidate();
      })
      .catch((e) => callbacks.error('The graphics canvas could not start: ' + String(e)));
    this.observer = new ResizeObserver(() => this.invalidate());
    this.observer.observe(host);
    host.addEventListener('pointerdown', this.down);
    host.addEventListener('pointermove', this.move);
    host.addEventListener('pointerup', this.up);
    host.addEventListener('pointercancel', this.cancel);
    host.addEventListener('wheel', this.wheel, { passive: false });
    host.addEventListener('dblclick', this.doubleClick);
    host.addEventListener('contextmenu', this.context);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.blur);
  }
  private point = (e: MouseEvent | PointerEvent | WheelEvent) => {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  screenPoint(p: Point) {
    return screenToWorld(p, this.camera);
  }
  center() {
    return this.screenPoint({ x: this.host.clientWidth / 2, y: this.host.clientHeight / 2 });
  }
  get selected() {
    return [...this.selection].map((id) => this.objects.get(id)).filter(Boolean) as CanvasObject[];
  }
  get all() {
    return [...this.objects.values()];
  }
  private rebuildGroups() {
    this.groupMembers.clear();
    for (const o of this.objects.values())
      if (o.groupId) {
        if (!this.groupMembers.has(o.groupId)) this.groupMembers.set(o.groupId, new Set());
        this.groupMembers.get(o.groupId)!.add(o.id);
      }
  }
  setSelection(ids: string[]) {
    this.selection = new Set(ids.filter((id) => this.objects.has(id)));
    this.callbacks.selection(this.selected);
    this.invalidate();
  }
  private members(o: CanvasObject) {
    return o.groupId ? [...(this.groupMembers.get(o.groupId) || [o.id])] : [o.id];
  }
  private hit(p: Point) {
    return this.index
      .search({ x: p.x, y: p.y, width: 0, height: 0 })
      .sort((a, b) => b.z - a.z)
      .find((o) => {
        const q = worldToLocal(o, p);
        if (hitsFrameLabel(o, q)) return true;
        if (q.x < 0 || q.y < 0 || q.x > o.width || q.y > o.height) return false;
        if (
          o.type === 'ellipse' &&
          ((q.x - o.width / 2) / (o.width / 2)) ** 2 +
            ((q.y - o.height / 2) / (o.height / 2)) ** 2 >
            1
        )
          return false;
        return (
          o.type !== 'frame' ||
          q.x < 10 ||
          q.x > o.width - 10 ||
          q.y < 32 ||
          q.y > o.height - 10 ||
          this.views
            .get(o.id)
            ?.container.children.some(
              (label) =>
                label.label === 'board-text' &&
                q.x >= label.x &&
                q.x <= label.x + label.width &&
                q.y >= label.y &&
                q.y <= label.y + label.height,
            )
        );
      });
  }
  private down = (e: PointerEvent) => {
    if (e.target !== this.app.canvas || e.button > 2 || this.gesture) return;
    e.preventDefault();
    this.host.focus();
    const p = this.point(e),
      w = this.screenPoint(p);
    this.secondaryContextHandled = e.button === 2;
    if (this.space || this.tool === 'hand' || e.button === 1 || e.button === 2) {
      this.gesture = {
        mode: 'pan',
        start: p,
        world: w,
        camera: { ...this.camera },
        original: [],
        secondary: e.button === 2,
      };
      this.updateCursor();
    } else if (this.tool !== 'select') {
      this.callbacks.create(this.tool, w);
      return;
    } else {
      const bounds = boundsOf(this.selected),
        additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const resize = !e.ctrlKey && !e.metaKey && this.resizeCorner(p);
      if (resize)
        this.gesture = {
          mode: resize === 'rotate' ? 'rotate' : 'resize',
          corner: resize === 'rotate' ? undefined : resize,
          start: p,
          world: w,
          camera: { ...this.camera },
          original: this.selected.map((o) => ({ ...o })),
        };
      else {
        const hit = this.hit(w);
        if (hit) {
          const ids = this.members(hit);
          const editOnClick =
            !additive &&
            (hit.type !== 'image' || hitsFrameLabel(hit, worldToLocal(hit, w))) &&
            ((!hit.groupId &&
              (hitsFrameLabel(hit, worldToLocal(hit, w)) ||
                hitsLinkPlay(hit, worldToLocal(hit, w)))) ||
              (this.selection.size === 1 && this.selection.has(hit.id)))
              ? hit.id
              : undefined;
          if (additive) {
            const next = new Set(this.selection);
            const remove = ids.every((id) => next.has(id));
            for (const id of ids) remove ? next.delete(id) : next.add(id);
            this.setSelection([...next]);
            if (remove) return;
          } else if (!this.selection.has(hit.id)) this.setSelection(ids);
          this.gesture = {
            mode: 'move',
            editOnClick,
            start: p,
            world: w,
            camera: { ...this.camera },
            original: this.moveObjects(),
          };
        } else if (
          !additive &&
          this.selection.size > 1 &&
          bounds &&
          w.x >= bounds.x &&
          w.x <= bounds.x + bounds.width &&
          w.y >= bounds.y &&
          w.y <= bounds.y + bounds.height
        ) {
          this.gesture = {
            mode: 'move',
            start: p,
            world: w,
            camera: { ...this.camera },
            original: this.moveObjects(),
          };
        } else {
          if (!additive) this.setSelection([]);
          this.gesture = {
            mode: 'box',
            start: p,
            world: w,
            camera: { ...this.camera },
            original: this.selected,
            toggle: e.ctrlKey || e.metaKey,
          };
        }
      }
    }
    this.updateCursor();
    this.host.setPointerCapture(e.pointerId);
  };
  private move = (e: PointerEvent) => {
    const g = this.gesture;
    if (!g) {
      this.updateCursor(
        e.target === this.app.canvas ? this.resizeCorner(this.point(e)) : undefined,
      );
      return;
    }
    const p = this.point(e),
      dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    const moved = Math.abs(dx) + Math.abs(dy) > 2;
    g.dragged ||= moved;
    g.changed = g.secondary ? g.changed || moved : moved;
    if (g.mode === 'pan') {
      if (g.secondary && !g.changed) return;
      this.camera = { ...g.camera, x: g.camera.x + dx, y: g.camera.y + dy };
      this.invalidate();
    } else if (g.mode === 'move') {
      for (const o of g.original)
        this.preview({ ...o, x: o.x + dx / this.camera.zoom, y: o.y + dy / this.camera.zoom });
      this.invalidate();
    } else if (g.mode === 'rotate') {
      const o = g.original[0];
      this.preview({
        ...o,
        rotation: rotationFromDrag(o, g.world, this.screenPoint(p), e.shiftKey),
      });
      this.invalidate();
    } else if (g.mode === 'resize') {
      const o = g.original[0];
      this.preview(resizeObject(o, g.corner!, dx / g.camera.zoom, dy / g.camera.zoom, e.shiftKey));
      this.invalidate();
    } else {
      const w = this.screenPoint(p);
      g.box = {
        x: Math.min(g.world.x, w.x),
        y: Math.min(g.world.y, w.y),
        width: Math.abs(w.x - g.world.x),
        height: Math.abs(w.y - g.world.y),
      };
      this.invalidate();
    }
  };
  private up = (e: PointerEvent) => {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.updateCursor();
    if (g.secondary && !g.changed) this.openContext(e);
    else if (g.mode === 'pan') this.callbacks.camera({ ...this.camera });
    else if (g.mode === 'box' && g.box) {
      const next = new Set(g.original.map((o) => o.id));
      const hits = new Set(this.index.search(g.box).flatMap((o) => this.members(o)));
      for (const id of hits) g.toggle && next.has(id) ? next.delete(id) : next.add(id);
      this.setSelection([...next]);
    } else if (g.changed && (g.mode === 'move' || g.mode === 'resize' || g.mode === 'rotate')) {
      const after = g.original.map((o) => this.objects.get(o.id)!);
      this.history.push({ upserts: after, deleted: [] }, { upserts: g.original, deleted: [] });
      this.callbacks.edit({ upserts: after, deleted: [] });
      this.callbacks.selection(this.selected);
    } else if (g.mode === 'move' || g.mode === 'resize' || g.mode === 'rotate') {
      for (const o of g.original) this.preview(o);
      if (g.editOnClick && !g.dragged) {
        const object = this.objects.get(g.editOnClick);
        if (object) this.callbacks.activate(object);
      }
    }
    this.invalidate();
  };
  private cancel = () => {
    const g = this.gesture;
    this.gesture = null;
    this.updateCursor();
    if (g) {
      for (const o of g.original) this.preview(o);
      if (g.mode === 'pan') this.camera = g.camera;
      this.invalidate();
    }
  };
  private blur = () => {
    this.space = false;
    this.cancel();
  };
  private wheel = (e: WheelEvent) => {
    if (e.target !== this.app.canvas) return;
    e.preventDefault();
    this.camera = zoomAt(
      this.camera,
      this.point(e),
      this.camera.zoom * Math.exp(-e.deltaY * 0.004),
    );
    this.callbacks.camera({ ...this.camera });
    this.invalidate();
  };
  private keyDown = (e: KeyboardEvent) => {
    if (
      (e.target as HTMLElement)?.closest?.(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role=dialog]',
      )
    )
      return;
    if (e.key === 'Escape' && this.gesture) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancel();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      this.space = true;
      this.updateCursor();
    }
  };
  private keyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      this.space = false;
      this.updateCursor();
    }
  };
  private doubleClick = (e: MouseEvent) => {
    if (this.editingId) return;
    // Pointer capture on the surface retargets Chromium's subsequent click /
    // dblclick to that surface, even when both presses began on the canvas.
    if (e.target !== this.app.canvas && e.target !== this.host) return;
    const o = this.hit(this.screenPoint(this.point(e)));
    if (o) this.callbacks.activate(o);
    else this.callbacks.create('text', this.screenPoint(this.point(e)));
  };
  private context = (e: MouseEvent) => {
    if (e.target !== this.app.canvas && e.target !== this.host) return;
    e.preventDefault();
    // Windows emits contextmenu after release; other platforms emit it on press.
    // Right-button gestures own the menu decision until the next pointer press.
    if (this.gesture?.secondary || (e.button === 2 && this.secondaryContextHandled)) return;
    this.openContext(e);
  };
  private openContext(e: MouseEvent) {
    const p = this.point(e),
      o = this.hit(this.screenPoint(p));
    if (o && !this.selection.has(o.id)) this.setSelection(this.members(o));
    this.callbacks.context({ x: e.clientX, y: e.clientY });
  }
  setTool(tool: Tool) {
    this.tool = tool;
    this.updateCursor();
  }
  setEditing(id: string | null) {
    this.editingId = id;
    if (!id) this.editingPreview = null;
    this.invalidate();
  }
  setEditingPreview(object: CanvasObject | null) {
    this.editingPreview = object;
    this.invalidate();
  }
  setCropPreview(image: CanvasObject | null) {
    this.cropPreview = image;
    this.setEditing(image?.id || null);
    if (image) {
      const b = boundsOf([image])!;
      const w = this.host.clientWidth,
        h = this.host.clientHeight,
        c = this.camera;
      if (
        b.x * c.zoom + c.x < 60 ||
        b.y * c.zoom + c.y < 60 ||
        (b.x + b.width) * c.zoom + c.x > w - 60 ||
        (b.y + b.height) * c.zoom + c.y > h - 100
      ) {
        const zoom = Math.max(0.01, Math.min(c.zoom, (w - 120) / b.width, (h - 160) / b.height));
        this.camera = {
          zoom,
          x: w / 2 - (image.x + image.width / 2) * zoom,
          y: (h - 40) / 2 - (image.y + image.height / 2) * zoom,
        };
        this.callbacks.camera({ ...this.camera });
      }
    }
  }
  private resizeCorner(p: Point): ResizeHandle | 'rotate' | undefined {
    if (this.selection.size !== 1 || this.editingId || this.cropPreview) return;
    const o = this.selected[0],
      c = this.camera;
    let nearest: ResizeHandle | 'rotate' | undefined,
      distance = Infinity;
    for (const corner of [...resizeHandles, 'rotate'] as const) {
      const q = localToWorld(
        o,
        corner === 'rotate' ? rotationHandlePoint(o, c.zoom) : handlePoint(o, corner),
      );
      const dx = Math.abs(p.x - q.x * c.zoom - c.x);
      const dy = Math.abs(p.y - q.y * c.zoom - c.y);
      const radius = corner === 'rotate' ? 14 : 10;
      if (dx < radius && dy < radius && dx * dx + dy * dy < distance) {
        nearest = corner;
        distance = dx * dx + dy * dy;
      }
    }
    return nearest;
  }
  private updateCursor(hoverCorner?: ResizeHandle | 'rotate') {
    const corner =
      this.gesture?.mode === 'rotate'
        ? 'rotate'
        : this.gesture?.mode === 'resize'
          ? this.gesture.corner
          : hoverCorner;
    const selectedId = this.selection.values().next().value;
    const angle =
      (selectedId ? this.objects.get(selectedId)?.rotation || 0 : 0) +
      (corner === 'n' || corner === 's'
        ? 90
        : corner === 'e' || corner === 'w'
          ? 0
          : corner === 'nw' || corner === 'se'
            ? 45
            : 135);
    this.host.style.cursor =
      this.gesture?.mode === 'pan'
        ? 'grabbing'
        : this.space || this.tool === 'hand'
          ? 'grab'
          : corner && this.tool === 'select'
            ? corner === 'rotate'
              ? this.gesture
                ? 'grabbing'
                : 'grab'
              : ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(angle / 45) % 4]
            : this.tool === 'select'
              ? 'default'
              : 'crosshair';
  }
  private preview(o: CanvasObject) {
    const meta = this.linkPreviews.get(o.id);
    if (o.type === 'link' && meta && meta.url === o.url) o = withLinkPreview(o, meta);
    this.objects.set(o.id, o);
    this.index.upsert(o);
  }
  private moveObjects(): CanvasObject[] {
    // Capture membership before the drag, so crossing other objects cannot
    // collect them mid-gesture. Geometry also releases items moved out of a frame.
    const moving = new Map(this.selected.map((o) => [o.id, o]));
    for (const frame of this.selected.filter((o) => o.type === 'frame')) {
      for (const o of this.index.search(boundsOf([frame])!)) {
        if (moving.has(o.id)) continue;
        const inside = [
          { x: 0, y: 0 },
          { x: o.width, y: 0 },
          { x: o.width, y: o.height },
          { x: 0, y: o.height },
        ].every((corner) => {
          const p = worldToLocal(frame, localToWorld(o, corner));
          const epsilon = 1e-7;
          return (
            p.x >= -epsilon &&
            p.y >= -epsilon &&
            p.x <= frame.width + epsilon &&
            p.y <= frame.height + epsilon
          );
        });
        if (inside) moving.set(o.id, o);
      }
    }
    return [...moving.values()].map((o) => ({ ...o }));
  }
  apply(edit: Edit, record = true) {
    const inverse: Edit = { upserts: [], deleted: [] };
    for (const o of edit.upserts) {
      const before = this.objects.get(o.id);
      if (before) inverse.upserts.push(before);
      else inverse.deleted.push(o.id);
      this.preview(o);
    }
    for (const id of edit.deleted) {
      const before = this.objects.get(id);
      if (before) inverse.upserts.push(before);
      this.objects.delete(id);
      this.index.remove(id);
      this.selection.delete(id);
    }
    this.rebuildGroups();
    edit = { ...edit, upserts: edit.upserts.map((o) => this.objects.get(o.id)!) };
    if (record) this.history.push(edit, inverse);
    this.callbacks.edit(edit);
    this.callbacks.selection(this.selected);
    this.invalidate();
  }
  undo() {
    const edit = this.history.undo();
    if (edit) this.apply(edit, false);
  }
  redo() {
    const edit = this.history.redo();
    if (edit) this.apply(edit, false);
  }
  deleteSelected() {
    if (this.selection.size) this.apply({ upserts: [], deleted: [...this.selection] });
  }
  duplicate() {
    const ids = new Map<string, string>();
    const top = this.topZ();
    const copies = this.selected.map((o, i) => {
      if (o.groupId && !ids.has(o.groupId)) ids.set(o.groupId, uid());
      return {
        ...o,
        id: uid(),
        x: o.x + 28,
        y: o.y + 28,
        z: top + i + 1,
        groupId: o.groupId ? ids.get(o.groupId) : undefined,
      };
    });
    if (copies.length) {
      this.apply({ upserts: copies, deleted: [] });
      this.setSelection(copies.map((o) => o.id));
    }
  }
  group() {
    if (this.selection.size < 2) return;
    const id = uid();
    this.apply({ upserts: this.selected.map((o) => ({ ...o, groupId: id })), deleted: [] });
  }
  ungroup() {
    this.apply({ upserts: this.selected.map((o) => ({ ...o, groupId: undefined })), deleted: [] });
  }
  topZ() {
    let z = 0;
    for (const o of this.objects.values()) z = Math.max(z, o.z);
    return z;
  }
  zoom(factor: number) {
    this.camera = zoomAt(
      this.camera,
      { x: this.host.clientWidth / 2, y: this.host.clientHeight / 2 },
      this.camera.zoom * factor,
    );
    this.callbacks.camera({ ...this.camera });
    this.invalidate();
  }
  fit() {
    const b = boundsOf(this.all);
    if (!b) {
      this.camera = { x: 0, y: 0, zoom: 1 };
    } else {
      const zoom = Math.min(
        1.5,
        Math.max(
          0.025,
          Math.min(
            (this.host.clientWidth - 140) / b.width,
            (this.host.clientHeight - 150) / b.height,
          ),
        ),
      );
      this.camera = {
        x: (this.host.clientWidth - b.width * zoom) / 2 - b.x * zoom,
        y: (this.host.clientHeight - b.height * zoom) / 2 - b.y * zoom,
        zoom,
      };
    }
    this.callbacks.camera({ ...this.camera });
    this.invalidate();
  }
  invalidate() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.ready) this.draw();
    });
  }
  private draw() {
    const c = this.camera,
      w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    if (this.app.renderer.resolution !== devicePixelRatio)
      this.app.renderer.resolution = devicePixelRatio;
    if (
      this.app.renderer.width / this.app.renderer.resolution !== w ||
      this.app.renderer.height / this.app.renderer.resolution !== h
    )
      this.app.resize();
    this.world.position.set(c.x, c.y);
    this.world.scale.set(c.zoom);
    const visible = this.index
      .search({
        x: (-c.x - 50) / c.zoom,
        y: (-c.y - 50) / c.zoom,
        width: (w + 100) / c.zoom,
        height: (h + 100) / c.zoom,
      })
      .sort((a, b) => a.z - b.z);
    if (this.editingPreview) {
      const index = visible.findIndex((o) => o.id === this.editingPreview!.id);
      if (index !== -1) visible[index] = this.editingPreview;
    }
    if (this.cropPreview) {
      const index = visible.findIndex((o) => o.id === this.cropPreview!.id);
      if (index !== -1) visible.splice(index, 1);
      visible.push(this.cropPreview);
    }
    const visibleIds = new Set(visible.map((o) => o.id));
    for (const [id, v] of this.views)
      if (!visibleIds.has(id)) {
        this.world.removeChild(v.container);
        v.container.destroy({ children: true });
        this.views.delete(id);
      }
    const wanted = new Set<string>();
    let bytes = 0;
    const variants = new Map<string, string>();
    const icons = new Map<string, string>();
    const tiles = new Map<string, ReturnType<typeof imageTiles>>();
    for (const o of [...visible].reverse()) {
      if (!['image', 'link'].includes(o.type)) continue;
      const showImage = o.type === 'image' || hasLinkImage(o);
      const mediaId = showImage ? o.assetId : o.linkIconId;
      if (!mediaId) continue;
      const fullWidth = o.width / (o.crop?.width || 1),
        fullHeight = o.height / (o.crop?.height || 1);
      let size =
        showImage && Math.max(fullWidth, fullHeight) * c.zoom * devicePixelRatio > 256 ? 1600 : 256;
      let cost = size * size * Math.min(fullWidth / fullHeight, fullHeight / fullWidth) * 4;
      if (bytes + cost > 100 * 1024 * 1024) {
        size = 256;
        cost = 256 * 256 * 4;
      }
      if (bytes + cost > 128 * 1024 * 1024) continue;
      const key = mediaId + '/' + (size === 256 || !showImage ? 'thumb' : 'preview');
      if (!wanted.has(key)) bytes += cost;
      wanted.add(key);
      variants.set(o.id, key);
      if (o.type === 'link' && showImage && o.linkIconId) {
        const iconKey = o.linkIconId + '/thumb';
        if (wanted.has(iconKey) || bytes + 256 * 256 * 4 <= 128 * 1024 * 1024) {
          if (!wanted.has(iconKey)) bytes += 256 * 256 * 4;
          wanted.add(iconKey);
          icons.set(o.id, iconKey);
        }
      }
    }
    // Reserve base images for the whole viewport before spending on close-up
    // detail. Give foreground tiles priority; details cannot starve base images.
    for (const o of [...visible].reverse()) {
      if (o.type !== 'image' || !variants.has(o.id)) continue;
      const detailTiles = imageTiles(o, c, w, h, devicePixelRatio).filter((tile) => {
        if (wanted.has(tile.key)) return true;
        if (bytes + 512 * 512 * 4 > 128 * 1024 * 1024) return false;
        bytes += 512 * 512 * 4;
        wanted.add(tile.key);
        return true;
      });
      tiles.set(o.id, detailTiles);
    }
    this.textures.begin(wanted);
    let animateLoading = false;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    visible.forEach((o, i) => {
      const key = variants.get(o.id),
        texture = key ? this.textures.get(key) : null;
      const iconKey = icons.get(o.id),
        iconTexture = iconKey ? this.textures.get(iconKey) : null;
      const detailTiles = (tiles.get(o.id) || []).map((tile) => ({
        ...tile,
        texture: this.textures.get(tile.key),
      }));
      const detail = c.zoom > 0.16;
      const loading =
        o.type === 'link' &&
        (this.loadingLinks.has(o.id) || (!!key && !texture && !this.textures.failed(key)));
      const hasLabel =
        detail &&
        this.editingId !== o.id &&
        (o.type === 'image'
          ? !!o.imageTitle?.trim() || !texture
          : o.type === 'frame' || o.type === 'video' || o.type === 'link' || !!o.text);
      const resolution = 2 ** Math.ceil(Math.log2(c.zoom * devicePixelRatio));
      const region = textRegion(o, c, w, h);
      const signature = JSON.stringify([
        o.width,
        o.height,
        o.text,
        o.imageTitle,
        o.url,
        o.linkDescription,
        o.linkCompact,
        loading,
        o.color,
        o.fontSize,
        o.textBox,
        o.centerX,
        o.centerY,
        o.type,
        o.crop,
        key,
        !!texture,
        iconKey,
        !!iconTexture,
        detail,
        hasLabel ? resolution : 0,
        hasLabel ? region : null,
        this.editingId === o.id,
        detailTiles.map((tile) => [tile.key, !!tile.texture]),
      ]);
      let view = this.views.get(o.id);
      if (!view || view.signature !== signature) {
        if (view) {
          this.world.removeChild(view.container);
          view.container.destroy({ children: true });
        }
        const container = this.makeView(
          o,
          texture,
          detail,
          resolution,
          region,
          loading,
          iconTexture,
        );
        const loadedTiles = detailTiles.filter((tile) => tile.texture);
        if (texture && loadedTiles.length) {
          // Cut detailed regions out of the preview so transparent pixels are
          // composited once, including while only some detail tiles are loaded.
          const mask = new Graphics().rect(0, 0, o.width, o.height).fill('#ffffff');
          for (const tile of loadedTiles) mask.rect(tile.x, tile.y, tile.width, tile.height).cut();
          container.children[0].mask = mask;
          container.addChild(mask);
        }
        for (const tile of detailTiles)
          if (tile.texture) {
            const sprite = this.imageSprite(tile.texture, tile.frame);
            sprite.position.set(tile.x, tile.y);
            sprite.width = tile.width;
            sprite.height = tile.height;
            container.addChild(sprite);
          }
        view = { container, signature };
        this.views.set(o.id, view);
        this.world.addChild(container);
      }
      view.container.pivot.set(o.width / 2, o.height / 2);
      view.container.position.set(o.x + o.width / 2, o.y + o.height / 2);
      view.container.rotation = ((o.rotation || 0) * Math.PI) / 180;
      const spinner = view.container.getChildByLabel('link-loading');
      if (spinner && loading && !reducedMotion) {
        spinner.rotation = performance.now() / 180;
        animateLoading = true;
      }
      this.world.setChildIndex(view.container, i);
    });
    this.drawSelection();
    const gap = 24 * c.zoom;
    this.host.style.backgroundSize = `${Math.max(8, gap)}px ${Math.max(8, gap)}px`;
    this.host.style.backgroundPosition = `${c.x}px ${c.y}px`;
    this.app.render();
    if (animateLoading) this.invalidate();
    if (!this.rendered) {
      this.rendered = true;
      this.callbacks.ready();
    }
  }
  private makeView(
    o: CanvasObject,
    texture: any,
    detail: boolean,
    resolution: number,
    region: ReturnType<typeof textRegion>,
    loading = false,
    iconTexture: Texture | null = null,
  ) {
    const container = new Container(),
      g = new Graphics(),
      color = o.color || '#e8edf5';
    container.eventMode = 'none';
    if (o.type === 'link') {
      const compact = !hasLinkImage(o);
      const iconY = compact && o.linkDescription ? 36 : o.height / 2;
      const box = linkLayout(o.width, o.height);
      g.roundRect(0, 0, o.width, o.height, linkCornerRadius)
        .fill('#ffffff')
        .stroke({ color: '#dce2eb', width: 1 });
      if (!compact) g.roundRect(box.x, box.y, box.width, box.height, 8).fill('#eef1f5');
      if (compact) {
        g.roundRect(o.width - 48, iconY - 18, 36, 36, 11).fill('#f0f3f7');
        const x = o.width - 37,
          y = iconY;
        g.moveTo(x + 9, y - 7)
          .lineTo(x + 15, y - 7)
          .lineTo(x + 15, y - 1)
          .moveTo(x + 15, y - 7)
          .lineTo(x + 6, y + 2)
          .moveTo(x + 3, y - 5)
          .lineTo(x, y - 5)
          .lineTo(x, y + 7)
          .lineTo(x + 12, y + 7)
          .lineTo(x + 12, y + 4)
          .stroke({ color: '#536172', width: 1.6 });
        if (!loading && !texture)
          g.circle(29, iconY, 10)
            .stroke({ color: '#8290a3', width: 1.5 })
            .moveTo(19, iconY)
            .lineTo(39, iconY)
            .stroke({ color: '#8290a3', width: 1.5 });
      }
      container.addChild(g);
      if (texture) {
        const sprite = this.imageSprite(texture);
        // Preserve the thumbnail's aspect ratio, with a quiet letterbox when needed.
        const scale = compact
          ? Math.min(24 / texture.width, 24 / texture.height)
          : Math.min(box.width / texture.width, box.height / texture.height);
        sprite.width = texture.width * scale;
        sprite.height = texture.height * scale;
        sprite.position.set(
          compact ? 29 - sprite.width / 2 : box.x + (box.width - sprite.width) / 2,
          compact ? iconY - sprite.height / 2 : box.y + (box.height - sprite.height) / 2,
        );
        container.addChild(sprite);
      }
      if (!compact && iconTexture && detail) {
        const icon = this.imageSprite(iconTexture);
        const size = Math.min(24 / iconTexture.width, 24 / iconTexture.height);
        icon.width = iconTexture.width * size;
        icon.height = iconTexture.height * size;
        icon.position.set(26 - icon.width / 2, box.y + box.height + 28 - icon.height / 2);
        container.addChild(icon);
      }
      if (!compact && !loading && youtubeId(o.url || '')) {
        const cx = o.width / 2,
          cy = box.y + box.height / 2,
          size = Math.min(56, box.width / 5, box.height / 2);
        const play = new Graphics()
          .roundRect(cx - size * 0.7, cy - size / 2, size * 1.4, size, size / 4)
          .fill('#ff0033');
        play
          .poly([
            cx - size * 0.15,
            cy - size * 0.23,
            cx + size * 0.27,
            cy,
            cx - size * 0.15,
            cy + size * 0.23,
          ])
          .fill('#ffffff');
        container.addChild(play);
      }
      if (loading && detail) {
        const spinner = new Graphics();
        spinner.label = 'link-loading';
        spinner.position.set(compact ? 29 : o.width / 2, compact ? iconY : box.y + box.height / 2);
        spinner.circle(0, 0, 10).stroke({ color: '#d5dde8', width: 2.5 });
        spinner.arc(0, 0, 10, -Math.PI / 2, Math.PI / 2).stroke({ color: '#6695e5', width: 2.5 });
        container.addChild(spinner);
      }
      if (detail) {
        const label = renderLinkCaption(o, resolution, region, loading);
        if (label) container.addChild(label);
      }
      return container;
    }
    if (o.type === 'image' && texture) {
      const sprite = this.imageSprite(texture, o.crop);
      sprite.width = o.width;
      sprite.height = o.height;
      container.addChild(sprite);
      if (detail && this.editingId !== o.id && o.imageTitle?.trim()) {
        const label = renderText(o, o.imageTitle, resolution, region);
        if (label) container.addChild(label);
      }
      return container;
    }
    if (o.type === 'ellipse')
      g.ellipse(o.width / 2, o.height / 2, o.width / 2, o.height / 2).fill(color);
    else if (o.type === 'frame')
      g.rect(0, 0, o.width, o.height).fill('#ffffff').stroke({ color: '#dce1e7', width: 1 });
    else if (o.type !== 'text') {
      if (o.type === 'note')
        g.roundRect(2, 3, o.width, o.height, 2).fill({ color: '#657180', alpha: 0.08 });
      g.roundRect(0, 0, o.width, o.height, o.type === 'note' ? 2 : 7).fill(
        o.type === 'image' || o.type === 'video' ? '#e8ecf2' : color,
      );
    }
    container.addChild(g);
    if (detail && this.editingId !== o.id) {
      let text = o.text || '';
      if (o.type === 'frame') text = o.text || 'Untitled frame';
      if (o.type === 'image') text = o.imageTitle?.trim() ? o.imageTitle : 'Image';
      if (o.type === 'video') text = o.text || 'Play video';
      if (text) {
        const label = renderText(
          o.type === 'image' && !o.imageTitle?.trim() ? { ...o, type: 'rect' } : o,
          text,
          resolution,
          region,
        );
        if (label) container.addChild(label);
      }
    }
    return container;
  }
  private imageSprite(source: Texture, crop?: ImageCrop) {
    if (!crop || (crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1))
      return new Sprite(source);
    const texture = new Texture({
      source: source.source,
      frame: new Rectangle(
        source.frame.x + crop.x * source.frame.width,
        source.frame.y + crop.y * source.frame.height,
        crop.width * source.frame.width,
        crop.height * source.frame.height,
      ),
    });
    const sprite = new Sprite(texture);
    // This is just a view into a shared cached texture; keep its source alive.
    sprite.once('destroyed', () => texture.destroy(false));
    return sprite;
  }
  private drawSelection() {
    const g = this.selectionLayer;
    g.clear();
    const c = this.camera,
      b = boundsOf(this.editingPreview ? [this.editingPreview] : this.selected);
    let toolbarBounds = b
      ? {
          x: b.x * c.zoom + c.x,
          y: b.y * c.zoom + c.y,
          width: b.width * c.zoom,
          height: b.height * c.zoom,
        }
      : null;
    if (toolbarBounds && this.selection.size === 1) {
      const o = this.editingPreview || this.selected[0];
      if (hasExternalLabel(o) || (o.type === 'image' && this.editingId === o.id)) {
        const visual = visualBounds(o, this.editingId === o.id);
        toolbarBounds = {
          x: visual.x * c.zoom + c.x,
          y: visual.y * c.zoom + c.y,
          width: visual.width * c.zoom,
          height: visual.height * c.zoom,
        };
      }
      const handle = localToWorld(o, rotationHandlePoint(o, c.zoom));
      const hy = handle.y * c.zoom + c.y;
      const top = Math.min(toolbarBounds.y, hy - 14);
      toolbarBounds = {
        ...toolbarBounds,
        y: top,
        height: Math.max(toolbarBounds.y + toolbarBounds.height, hy + 14) - top,
      };
    }
    this.callbacks.selectionView?.(toolbarBounds, {
      width: this.host.clientWidth,
      height: this.host.clientHeight,
    });
    if (b && !this.cropPreview) {
      const x = b.x * c.zoom + c.x,
        y = b.y * c.zoom + c.y,
        w = b.width * c.zoom,
        h = b.height * c.zoom;
      if (this.selection.size !== 1)
        g.rect(x - 2, y - 2, w + 4, h + 4).stroke({ color: '#4486d9', width: 1.5 });
      else {
        const o = this.editingPreview || this.selected[0];
        const screen = (p: Point) => {
          const q = localToWorld(o, p);
          return { x: q.x * c.zoom + c.x, y: q.y * c.zoom + c.y };
        };
        const outline = ['nw', 'ne', 'se', 'sw'].flatMap((h) => {
          const p = screen(handlePoint(o, h as ResizeHandle));
          return [p.x, p.y];
        });
        if (o.type === 'link') {
          const origin = screen({ x: 0, y: 0 });
          const angle = ((o.rotation || 0) * Math.PI) / 180;
          const cos = Math.cos(angle),
            sin = Math.sin(angle);
          g.save()
            .setTransform(cos, sin, -sin, cos, origin.x, origin.y)
            .roundRect(0, 0, o.width * c.zoom, o.height * c.zoom, linkCornerRadius * c.zoom)
            .stroke({ color: '#4486d9', width: 1.5 })
            .restore();
        } else g.poly(outline).stroke({ color: '#4486d9', width: 1.5 });
        for (const handle of resizeHandles) {
          const p = screen(handlePoint(o, handle));
          if (o.type === 'link') g.circle(p.x, p.y, 3.5);
          else g.rect(p.x - 4, p.y - 4, 8, 8);
          g.fill('#ffffff').stroke({ color: '#4486d9', width: 1.5 });
        }
        const rotation = screen(rotationHandlePoint(o, c.zoom));
        // A compact curved arrow outside the lower-left corner, in screen pixels.
        g.moveTo(rotation.x + 9, rotation.y)
          .arc(rotation.x, rotation.y, 9, 0, Math.PI / 2, true)
          .stroke({ color: '#252d38', width: 1.6 });
        g.poly([
          rotation.x + 4,
          rotation.y + 9,
          rotation.x - 2,
          rotation.y + 5,
          rotation.x - 2,
          rotation.y + 13,
        ]).fill('#252d38');
        this.callbacks.rotation?.(
          this.gesture?.mode === 'rotate'
            ? { angle: o.rotation || 0, x: rotation.x, y: rotation.y }
            : null,
        );
      }
    }
    if (this.gesture?.mode !== 'rotate') this.callbacks.rotation?.(null);
    if (this.gesture?.box) {
      const b = this.gesture.box;
      g.rect(b.x * c.zoom + c.x, b.y * c.zoom + c.y, b.width * c.zoom, b.height * c.zoom)
        .fill({ color: '#4486d9', alpha: 0.08 })
        .stroke({ color: '#4486d9', width: 1 });
    }
  }
  async screenshot() {
    await this.initialized;
    this.selectionLayer.visible = false;
    try {
      return this.app.renderer.extract.canvas({
        target: this.app.stage,
        frame: new Rectangle(0, 0, this.host.clientWidth, this.host.clientHeight),
        resolution: 1,
        clearColor: '#fbfcfd',
      });
    } finally {
      this.selectionLayer.visible = true;
      this.invalidate();
    }
  }
  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.textures.destroy();
    this.host.removeEventListener('pointerdown', this.down);
    this.host.removeEventListener('pointermove', this.move);
    this.host.removeEventListener('pointerup', this.up);
    this.host.removeEventListener('pointercancel', this.cancel);
    this.host.removeEventListener('wheel', this.wheel);
    this.host.removeEventListener('dblclick', this.doubleClick);
    this.host.removeEventListener('contextmenu', this.context);
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.blur);
    if (this.ready) this.app.destroy(true, { children: true });
  }
}
