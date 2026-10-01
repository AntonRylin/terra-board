// Pixi's interpreter adapters keep shader setup compatible with a strict CSP (no eval).
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Text, Sprite, Rectangle } from 'pixi.js';
import type { CanvasObject, Camera, Edit, Tool } from '../model';
import { uid } from '../model';
import { SpatialIndex, screenToWorld, zoomAt, boundsOf, type Point, type Bounds } from './geometry';
import { History } from './history';
import { previewText } from './content';
import { TextureCache } from './textures';
interface Callbacks {
  edit: (e: Edit) => void;
  camera: (c: Camera) => void;
  selection: (items: CanvasObject[]) => void;
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
        resolution: Math.min(devicePixelRatio, 2),
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
          p.y > o.y + o.height - 10,
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
      const bounds = boundsOf(this.selected);
      const resize =
        bounds &&
        this.selection.size === 1 &&
        Math.abs(p.x - (bounds.x + bounds.width) * this.camera.zoom - this.camera.x) < 10 &&
        Math.abs(p.y - (bounds.y + bounds.height) * this.camera.zoom - this.camera.y) < 10;
      if (resize)
        this.gesture = {
          mode: 'resize',
          start: p,
          world: w,
          camera: { ...this.camera },
          original: this.selected.map((o) => ({ ...o })),
        };
      else {
        const hit = this.hit(w);
        if (hit) {
          const ids = this.members(hit);
          if (e.shiftKey) {
            const next = new Set(this.selection);
            for (const id of ids) next.has(id) ? next.delete(id) : next.add(id);
            this.setSelection([...next]);
          } else if (!this.selection.has(hit.id)) this.setSelection(ids);
          this.gesture = {
            mode: 'move',
            start: p,
            world: w,
            camera: { ...this.camera },
            original: this.selected.map((o) => ({ ...o })),
          };
        } else {
          if (!e.shiftKey) this.setSelection([]);
          this.gesture = {
            mode: 'box',
            start: p,
            world: w,
            camera: { ...this.camera },
            original: this.selected,
          };
        }
      }
    }
    this.host.setPointerCapture(e.pointerId);
  };
  private move = (e: PointerEvent) => {
    const g = this.gesture;
    if (!g) return;
    const p = this.point(e),
      dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    const moved = Math.abs(dx) + Math.abs(dy) > 2;
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
      let width = Math.max(20, o.width + dx / this.camera.zoom),
        height = Math.max(20, o.height + dy / this.camera.zoom);
      if (['image', 'video'].includes(o.type) && !e.shiftKey) height = (width * o.height) / o.width;
      this.preview({ ...o, width, height });
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
      this.setSelection([
        ...g.original.map((o) => o.id),
        ...this.index.search(g.box).flatMap((o) => this.members(o)),
      ]);
    } else if (g.changed && (g.mode === 'move' || g.mode === 'resize')) {
      const after = g.original.map((o) => this.objects.get(o.id)!);
      this.history.push({ upserts: after, deleted: [] }, { upserts: g.original, deleted: [] });
      this.callbacks.edit({ upserts: after, deleted: [] });
      this.callbacks.selection(this.selected);
    } else if (g.mode === 'move' || g.mode === 'resize') {
      for (const o of g.original) this.preview(o);
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
    if (e.ctrlKey || e.metaKey)
      this.camera = zoomAt(
        this.camera,
        this.point(e),
        this.camera.zoom * Math.exp(-e.deltaY * 0.004),
      );
    else this.camera = { ...this.camera, x: this.camera.x - e.deltaX, y: this.camera.y - e.deltaY };
    this.callbacks.camera({ ...this.camera });
    this.invalidate();
  };
  private keyDown = (e: KeyboardEvent) => {
    if (
      (e.target as HTMLElement)?.closest(
        'input,textarea,select,[contenteditable=true],[role=dialog]',
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
    if (e.target !== this.app.canvas) return;
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
  private updateCursor() {
    this.host.style.cursor =
      this.gesture?.mode === 'pan'
        ? 'grabbing'
        : this.space || this.tool === 'hand'
          ? 'grab'
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
    for (const o of visible) {
      if (o.type !== 'image' || !o.assetId) continue;
      let size = Math.max(o.width, o.height) * c.zoom > 350 ? 1600 : 256;
      let cost = size * size * Math.min(o.width / o.height, o.height / o.width) * 4;
      if (bytes + cost > 100 * 1024 * 1024) {
        size = 256;
        cost = 256 * 256 * 4;
      }
      if (bytes + cost > 128 * 1024 * 1024) continue;
      bytes += cost;
      const key = o.assetId + '/' + (size === 256 ? 'thumb' : 'preview');
      wanted.add(key);
      variants.set(o.id, key);
    }
    this.textures.begin(wanted);
    visible.forEach((o, i) => {
      const key = variants.get(o.id),
        texture = key ? this.textures.get(key) : null;
      const detail = c.zoom > 0.16;
      const signature = JSON.stringify([
        o.width,
        o.height,
        o.text,
        o.color,
        o.fontSize,
        o.type,
        key,
        !!texture,
        detail,
      ]);
      let view = this.views.get(o.id);
      if (!view || view.signature !== signature) {
        if (view) {
          this.world.removeChild(view.container);
          view.container.destroy({ children: true });
        }
        const container = this.makeView(o, texture, detail);
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
  private makeView(o: CanvasObject, texture: any, detail: boolean) {
    const container = new Container(),
      g = new Graphics(),
      color = o.color || '#e8edf5';
    container.eventMode = 'none';
    if (o.type === 'image' && texture) {
      const sprite = new Sprite(texture);
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
    if (detail) {
      let text = o.text || '';
      if (o.type === 'image') text = 'Image';
      if (o.type === 'video') text = '▶  Play video';
      if (o.type === 'link') text = o.text || o.url || 'Link';
      if (text) {
        const pad = o.type === 'text' ? 0 : o.type === 'frame' ? 14 : 22;
        const fontSize = o.fontSize || (o.type === 'note' ? 21 : o.type === 'frame' ? 14 : 18);
        text = previewText(text, o.width - pad * 2, o.height - pad * 2, fontSize);
        const label = new Text({
          text,
          style: {
            fontFamily:
              o.type === 'note' ? 'Segoe Print, Segoe UI, sans-serif' : 'Segoe UI, sans-serif',
            fontSize: o.fontSize || (o.type === 'note' ? 21 : o.type === 'frame' ? 14 : 18),
            fill: o.type === 'text' ? o.color || '#29313b' : '#434e5d',
            wordWrap: true,
            wordWrapWidth: Math.max(1, Math.min(2048, o.width - pad * 2)),
            breakWords: true,
            lineHeight: (o.fontSize || 21) * 1.45,
            fontWeight: '400',
          },
        });
        label.resolution = 1;
        label.position.set(pad, pad);
        const mask = new Graphics().rect(0, 0, o.width, o.height).fill('#ffffff');
        container.addChild(label, mask);
        label.mask = mask;
      }
    }
    return container;
  }
  private drawSelection() {
    const g = this.selectionLayer;
    g.clear();
    const c = this.camera,
      b = boundsOf(this.selected);
    if (b) {
      const x = b.x * c.zoom + c.x,
        y = b.y * c.zoom + c.y,
        w = b.width * c.zoom,
        h = b.height * c.zoom;
      g.rect(x - 2, y - 2, w + 4, h + 4).stroke({ color: '#4486d9', width: 1.5 });
      if (this.selection.size === 1)
        g.rect(x + w - 4, y + h - 4, 8, 8)
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
