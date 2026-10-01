// Pixi's interpreter adapters keep shader setup compatible with a strict CSP (no eval).
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Sprite, Rectangle, Texture } from 'pixi.js';
import type { CanvasObject, Camera, Edit, Tool, ImageCrop } from '../model';
import { uid } from '../model';
import { SpatialIndex, screenToWorld, zoomAt, boundsOf, type Point, type Bounds } from './geometry';
import { History } from './history';
import { renderText, textRegion } from './text-rendering';
import { TextureCache } from './textures';
import { imageTiles } from './image-detail';
import { corners, resizeObject, type Corner } from './resize';
interface Callbacks {
  edit: (e: Edit) => void;
  camera: (c: Camera) => void;
  selection: (items: CanvasObject[]) => void;
  selectionView?: (bounds: Bounds | null, viewport: { width: number; height: number }) => void;
  activate: (o: CanvasObject) => void;
  create: (tool: Tool, p: Point) => void;
  context: (p: Point) => void;
  ready: () => void;
  error: (message: string) => void;
}
type Gesture = {
  mode: 'pan' | 'move' | 'resize' | 'box';
  start: Point;
  camera: Camera;
  original: CanvasObject[];
  world: Point;
  box?: Bounds;
  changed?: boolean;
  secondary?: boolean;
  toggle?: boolean;
  corner?: Corner;
  editOnClick?: string;
  dragged?: boolean;
};
export class Engine {
  app = new Application();
  camera: Camera;
  tool: Tool = 'select';
  objects = new Map<string, CanvasObject>();
  selection = new Set<string>();
  history = new History();
  private index = new SpatialIndex();
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
      .find(
        (o) =>
          o.type !== 'frame' ||
          p.x < o.x + 10 ||
          p.x > o.x + o.width - 10 ||
          p.y < o.y + 32 ||
          p.y > o.y + o.height - 10 ||
          this.views
            .get(o.id)
            ?.container.children.some(
              (label) =>
                label.label === 'board-text' &&
                p.x >= o.x + label.x &&
                p.x <= o.x + label.x + label.width &&
                p.y >= o.y + label.y &&
                p.y <= o.y + label.y + label.height,
            ),
      );
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
          mode: 'resize',
          corner: resize,
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
            hit.type !== 'image' &&
            this.selection.size === 1 &&
            this.selection.has(hit.id)
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
            original: this.selected.map((o) => ({ ...o })),
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
            original: this.selected.map((o) => ({ ...o })),
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
    } else if (g.changed && (g.mode === 'move' || g.mode === 'resize')) {
      const after = g.original.map((o) => this.objects.get(o.id)!);
      this.history.push({ upserts: after, deleted: [] }, { upserts: g.original, deleted: [] });
      this.callbacks.edit({ upserts: after, deleted: [] });
      this.callbacks.selection(this.selected);
    } else if (g.mode === 'move' || g.mode === 'resize') {
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
      const w = this.host.clientWidth,
        h = this.host.clientHeight,
        c = this.camera;
      if (
        image.x * c.zoom + c.x < 60 ||
        image.y * c.zoom + c.y < 60 ||
        (image.x + image.width) * c.zoom + c.x > w - 60 ||
        (image.y + image.height) * c.zoom + c.y > h - 100
      ) {
        const zoom = Math.max(
          0.01,
          Math.min(c.zoom, (w - 120) / image.width, (h - 160) / image.height),
        );
        this.camera = {
          zoom,
          x: w / 2 - (image.x + image.width / 2) * zoom,
          y: (h - 40) / 2 - (image.y + image.height / 2) * zoom,
        };
        this.callbacks.camera({ ...this.camera });
      }
    }
  }
  private resizeCorner(p: Point): Corner | undefined {
    if (this.selection.size !== 1 || this.editingId || this.cropPreview) return;
    const o = this.selected[0],
      c = this.camera;
    let nearest: Corner | undefined,
      distance = Infinity;
    for (const corner of corners) {
      const dx = Math.abs(p.x - (o.x + (corner.includes('e') ? o.width : 0)) * c.zoom - c.x);
      const dy = Math.abs(p.y - (o.y + (corner.includes('s') ? o.height : 0)) * c.zoom - c.y);
      if (dx < 10 && dy < 10 && dx * dx + dy * dy < distance) {
        nearest = corner;
        distance = dx * dx + dy * dy;
      }
    }
    return nearest;
  }
  private updateCursor(hoverCorner?: Corner) {
    const corner = this.gesture?.mode === 'resize' ? this.gesture.corner : hoverCorner;
    this.host.style.cursor =
      this.gesture?.mode === 'pan'
        ? 'grabbing'
        : this.space || this.tool === 'hand'
          ? 'grab'
          : corner && this.tool === 'select'
            ? corner === 'nw' || corner === 'se'
              ? 'nwse-resize'
              : 'nesw-resize'
            : this.tool === 'select'
              ? 'default'
              : 'crosshair';
  }
  private preview(o: CanvasObject) {
    this.objects.set(o.id, o);
    this.index.upsert(o);
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
    const tiles = new Map<string, ReturnType<typeof imageTiles>>();
    for (const o of [...visible].reverse()) {
      if (o.type !== 'image' || !o.assetId) continue;
      const fullWidth = o.width / (o.crop?.width || 1),
        fullHeight = o.height / (o.crop?.height || 1);
      let size = Math.max(fullWidth, fullHeight) * c.zoom * devicePixelRatio > 256 ? 1600 : 256;
      let cost = size * size * Math.min(fullWidth / fullHeight, fullHeight / fullWidth) * 4;
      if (bytes + cost > 100 * 1024 * 1024) {
        size = 256;
        cost = 256 * 256 * 4;
      }
      if (bytes + cost > 128 * 1024 * 1024) continue;
      const key = o.assetId + '/' + (size === 256 ? 'thumb' : 'preview');
      if (!wanted.has(key)) bytes += cost;
      wanted.add(key);
      variants.set(o.id, key);
    }
    // Reserve base images for the whole viewport before spending on close-up
    // detail. Give foreground tiles priority; details cannot starve base images.
    for (const o of [...visible].reverse()) {
      if (!variants.has(o.id)) continue;
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
    visible.forEach((o, i) => {
      const key = variants.get(o.id),
        texture = key ? this.textures.get(key) : null;
      const detailTiles = (tiles.get(o.id) || []).map((tile) => ({
        ...tile,
        texture: this.textures.get(tile.key),
      }));
      const detail = c.zoom > 0.16;
      const hasLabel =
        detail &&
        this.editingId !== o.id &&
        (o.type === 'image' ? !texture : o.type === 'video' || o.type === 'link' || !!o.text);
      const resolution = 2 ** Math.ceil(Math.log2(c.zoom * devicePixelRatio));
      const region = textRegion(o, c, w, h);
      const signature = JSON.stringify([
        o.width,
        o.height,
        o.text,
        o.color,
        o.fontSize,
        o.centerX,
        o.centerY,
        o.type,
        o.crop,
        key,
        !!texture,
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
        const container = this.makeView(o, texture, detail, resolution, region);
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
      view.container.position.set(o.x, o.y);
      this.world.setChildIndex(view.container, i);
    });
    this.drawSelection();
    const gap = 24 * c.zoom;
    this.host.style.backgroundSize = `${Math.max(8, gap)}px ${Math.max(8, gap)}px`;
    this.host.style.backgroundPosition = `${c.x}px ${c.y}px`;
    this.app.render();
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
  ) {
    const container = new Container(),
      g = new Graphics(),
      color = o.color || '#e8edf5';
    container.eventMode = 'none';
    if (o.type === 'image' && texture) {
      const sprite = this.imageSprite(texture, o.crop);
      sprite.width = o.width;
      sprite.height = o.height;
      container.addChild(sprite);
      return container;
    }
    if (o.type === 'ellipse')
      g.ellipse(o.width / 2, o.height / 2, o.width / 2, o.height / 2).fill(color);
    else if (o.type === 'frame')
      g.roundRect(0, 0, o.width, o.height, 8)
        .fill({ color, alpha: 0.35 })
        .stroke({ color: '#c9d0da', width: 1 });
    else if (o.type !== 'text') {
      if (o.type === 'note')
        g.roundRect(2, 3, o.width, o.height, 2).fill({ color: '#657180', alpha: 0.08 });
      g.roundRect(0, 0, o.width, o.height, o.type === 'note' ? 2 : 7).fill(
        o.type === 'image' || o.type === 'video'
          ? '#e8ecf2'
          : o.type === 'link'
            ? '#ffffff'
            : color,
      );
      if (o.type === 'link')
        g.roundRect(0, 0, o.width, o.height, 7).stroke({ color: '#dce2eb', width: 1 });
    }
    container.addChild(g);
    if (detail && this.editingId !== o.id) {
      let text = o.text || '';
      if (o.type === 'image') text = 'Image';
      if (o.type === 'video') text = o.text || 'Play video';
      if (o.type === 'link') text = o.text || o.url || 'Link';
      if (text) {
        const label = renderText(o, text, resolution, region);
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
    this.callbacks.selectionView?.(
      b
        ? {
            x: b.x * c.zoom + c.x,
            y: b.y * c.zoom + c.y,
            width: b.width * c.zoom,
            height: b.height * c.zoom,
          }
        : null,
      { width: this.host.clientWidth, height: this.host.clientHeight },
    );
    if (b && !this.cropPreview) {
      const x = b.x * c.zoom + c.x,
        y = b.y * c.zoom + c.y,
        w = b.width * c.zoom,
        h = b.height * c.zoom;
      g.rect(x - 2, y - 2, w + 4, h + 4).stroke({ color: '#4486d9', width: 1.5 });
      if (this.selection.size === 1)
        for (const corner of corners)
          g.rect(
            x + (corner.includes('e') ? w : 0) - 4,
            y + (corner.includes('s') ? h : 0) - 4,
            8,
            8,
          )
            .fill('#ffffff')
            .stroke({ color: '#4486d9', width: 1.5 });
    }
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
