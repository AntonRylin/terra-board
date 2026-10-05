import {
  arrowFromPoints,
  arrowPoints,
  arrowPath,
  arrowHandles,
  hitsArrow,
  arrowLabelPoint,
} from './arrows';
import { drawArrow } from './arrow-rendering';
import {
  snapMove,
  snapResize,
  snapTargets,
  type SnapTargets,
  type SnapState,
  type SnapGuide,
} from './snapping';
// Pixi's interpreter adapters keep shader setup compatible with a strict CSP (no eval).
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Sprite, Rectangle, Texture, Text } from 'pixi.js';
import type { CanvasObject, Camera, Edit, Tool, ImageCrop } from '../model';
import { uid } from '../model';
import { SpatialIndex, screenToWorld, zoomAt, boundsOf, type Point, type Bounds } from './geometry';
import { History } from './history';
import {
  stackingHierarchy,
  stackingOverlap,
  stackingSelection,
  bringToFrontEdit,
} from './stacking';
import { renderText, renderLinkCaption, textRegion } from './text-rendering';
import { documentPreviewBox, renderDocumentCard } from './document-card';
import { listLayout, wrapListText } from './list-layout';
import { TextureCache } from './textures';
import { appearanceEvent, nightInk } from '../appearance';
import { NightLighting } from './night-lighting';
import { exportPlan, exportResolution, type ExportScope, type ExportQuality } from './export-plan';
import { imageTiles } from './image-detail';
import {
  corners,
  resizeSelection,
  resizeHandles,
  handlePoint,
  resizeObject,
  type Corner,
  type ResizeHandle,
} from './resize';
import {
  localToWorld,
  worldToLocal,
  rotationFromDrag,
  rotationHandlePoint,
  objectBounds,
} from './transform';
import { hitsFrameLabel, visualBounds, hasExternalLabel, arrowLabelObject } from './frame-label';
import { galleryEdit, selectionWithGalleryImages } from './gallery';
import {
  youtubeId,
  linkLayout,
  hitsLinkPlay,
  withLinkPreview,
  linkCornerRadius,
  hasLinkImage,
} from './link-preview';
interface Callbacks {
  lists?: (objects: CanvasObject[], camera: Camera) => void;
  composers?: (objects: CanvasObject[], camera: Camera) => void;
  objectDrag?: (objects: CanvasObject[], point: Point | null) => void;
  objectDrop?: (objects: CanvasObject[], point: Point) => boolean;
  tool?: (tool: Tool) => void;
  edit: (e: Edit) => void;
  camera: (c: Camera) => void;
  selection: (items: CanvasObject[]) => void;
  hover?: (imageId: string | null) => void;
  selectionView?: (bounds: Bounds | null, viewport: { width: number; height: number }) => void;
  rotation?: (value: { angle: number; x: number; y: number } | null) => void;
  activate: (o: CanvasObject, intent?: 'title') => void;
  create: (tool: Tool, p: Point) => void;
  context: (p: Point) => void;
  ready: () => void;
  error: (message: string) => void;
}
type Gesture = {
  mode: 'pan' | 'move' | 'resize' | 'rotate' | 'box' | 'drawArrow' | 'arrowPoint';
  arrowDraft?: CanvasObject;
  arrowIndex?: number;
  arrowPoints?: Point[];
  start: Point;
  camera: Camera;
  original: CanvasObject[];
  world: Point;
  box?: Bounds;
  scaleBounds?: Bounds;
  changed?: boolean;
  secondary?: boolean;
  toggle?: boolean;
  corner?: ResizeHandle;
  editOnClick?: string;
  dragged?: boolean;
  snap?: { bounds: Bounds; targets: SnapTargets; state: SnapState };
};
export class Engine {
  private documentPreviews = new Map<
    string,
    {
      assetId: string;
      metadata: Pick<CanvasObject, 'documentPreviewId' | 'documentExcerpt' | 'documentPageCount'>;
    }
  >();
  hydrateDocument(
    id: string,
    assetId: string,
    metadata: Pick<CanvasObject, 'documentPreviewId' | 'documentExcerpt' | 'documentPageCount'>,
  ): void {
    const object = this.objects.get(id);
    if (this.disposed || object?.type !== 'document' || object.assetId !== assetId) return;
    const previous = this.documentPreviews.get(id);
    this.documentPreviews.set(id, {
      assetId,
      metadata: {
        ...(previous?.assetId === assetId ? previous.metadata : {}),
        ...(metadata.documentPreviewId !== undefined
          ? { documentPreviewId: metadata.documentPreviewId }
          : {}),
        ...(metadata.documentExcerpt !== undefined
          ? { documentExcerpt: metadata.documentExcerpt }
          : {}),
        ...(metadata.documentPageCount !== undefined
          ? { documentPageCount: metadata.documentPageCount }
          : {}),
      },
    });
    if (this.editingPreview?.id === id)
      this.editingPreview = this.withDocumentPreview(this.editingPreview);
    const original = this.gesture?.original.find((o) => o.id === id);
    if (original) {
      // Preview work can complete during a transform. Persist its committed
      // geometry while merging the metadata into every subsequent live preview.
      this.preview(object);
      this.callbacks.edit({ upserts: [this.withDocumentPreview(original)], deleted: [] });
      this.callbacks.selection(this.selected);
      this.invalidate();
    } else this.apply({ upserts: [object], deleted: [] }, false);
  }
  private withDocumentPreview(o: CanvasObject): CanvasObject {
    const preview = this.documentPreviews.get(o.id);
    return o.type === 'document' && preview && preview.assetId === o.assetId
      ? { ...o, ...preview.metadata }
      : o;
  }
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
  // Index the largest possible title once; actual zoom bounds are checked at
  // rendering, marquee and pointer time without rebuilding the index on zoom.
  private index = new SpatialIndex((o) =>
    visualBounds(o, false, o.type === 'frame' ? 0.01 : undefined),
  );
  private world = new Container();
  private selectionLayer = new Graphics();
  private snapGuides: SnapGuide[] = [];
  private views = new Map<string, { container: Container; signature: string }>();
  private textures: TextureCache;
  private observer: ResizeObserver;
  private frame = 0;
  private wheelZoom: { target: number; point: Point; time: number } | null = null;
  private disposed = false;
  private ready = false;
  private rendered = false;
  private space = false;
  private gesture: Gesture | null = null;
  private secondaryContextHandled = false;
  private initialized: Promise<void>;
  private groupMembers = new Map<string, Set<string>>();
  private editingId: string | null = null;
  private dark = document.documentElement.dataset.theme === 'dark';
  private lighting: NightLighting;
  private appearanceChanged = () => {
    this.dark = document.documentElement.dataset.theme === 'dark';
    this.invalidate();
  };
  private editingPreview: CanvasObject | null = null;
  private cropPreview: CanvasObject | null = null;
  constructor(
    private host: HTMLDivElement,
    objects: CanvasObject[],
    camera: Camera,
    private callbacks: Callbacks,
  ) {
    this.camera = { ...camera };
    this.lighting = new NightLighting(host);
    window.addEventListener(appearanceEvent, this.appearanceChanged);
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
  get clipboardSelection() {
    return selectionWithGalleryImages(this.selected, this.objects.values());
  }
  get selectionOverlaps() {
    const selected = this.selected;
    if (!selected.length) return false;
    const hierarchy = stackingHierarchy(this.all);
    const ids = new Set(selected.map((o) => o.id));
    return selected.some((o) =>
      this.index
        .search(objectBounds(o))
        .some((other) => !ids.has(other.id) && stackingOverlap(o, other, hierarchy)),
    );
  }
  bringToFront() {
    const edit = bringToFrontEdit(this.all, this.clipboardSelection);
    if (edit.upserts.length) this.apply(edit);
  }
  galleryImageAt(point: Point) {
    const o = this.hit(this.screenPoint(point));
    return o?.type === 'image' && o.galleryId ? o.id : null;
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
      .search({
        x: p.x - 8 / this.camera.zoom,
        y: p.y - 8 / this.camera.zoom,
        width: 16 / this.camera.zoom,
        height: 16 / this.camera.zoom,
      })
      .sort((a, b) => b.z - a.z)
      .find((o) => {
        const q = worldToLocal(o, p);
        if (o.type === 'arrow') {
          const label = arrowLabelPoint(o),
            box = o.text ? arrowLabelObject(o) : null;
          return (
            hitsArrow(o, q, 8 / this.camera.zoom) ||
            (!!box &&
              Math.abs(q.x - label.x) < box.width / 2 + 5 &&
              Math.abs(q.y - label.y) < box.height / 2 + 2)
          );
        }
        if (hitsFrameLabel(o, q, this.camera.zoom)) return true;
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
          !!o.pdfComposer ||
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
  beginOverlayPointer(e: PointerEvent) {
    this.down(e, true);
  }
  private down = (e: PointerEvent, overlay = false) => {
    if ((!overlay && e.target !== this.app.canvas) || e.button > 2 || this.gesture) return;
    e.preventDefault();
    this.stopCameraAnimation();
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
    } else if (this.tool === 'arrow') {
      const draft = arrowFromPoints(
        {
          id: uid(),
          type: 'arrow',
          x: w.x,
          y: w.y,
          width: 1,
          height: 1,
          z: this.topZ() + 1,
          color: '#333333',
          fontSize: 18,
        },
        [w, { x: w.x + 160 / this.camera.zoom, y: w.y }],
      );
      this.preview(draft);
      this.setSelection([draft.id]);
      this.gesture = {
        mode: 'drawArrow',
        start: p,
        world: w,
        camera: { ...this.camera },
        original: [],
        arrowDraft: draft,
      };
    } else if (this.tool !== 'select') {
      this.callbacks.create(this.tool, w);
      return;
    } else {
      const bounds = boundsOf(this.selected),
        additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const resize = !e.ctrlKey && !e.metaKey && this.resizeCorner(p);
      const arrowHandle = !additive && this.arrowHandle(p);
      if (arrowHandle) {
        const o = this.selected[0],
          points = arrowPoints(o).map((q) => localToWorld(o, q));
        if (arrowHandle.insert) points.splice(arrowHandle.index, 0, localToWorld(o, arrowHandle));
        this.gesture = {
          mode: 'arrowPoint',
          start: p,
          world: w,
          camera: { ...this.camera },
          original: [{ ...o }],
          arrowIndex: arrowHandle.index,
          arrowPoints: points,
        };
      } else if (resize)
        this.gesture = {
          mode: resize === 'rotate' ? 'rotate' : 'resize',
          corner: resize === 'rotate' ? undefined : resize,
          start: p,
          world: w,
          camera: { ...this.camera },
          original:
            this.selection.size > 1 || this.selected[0]?.gallery
              ? this.moveObjects()
              : this.selected.map((o) => ({ ...o })),
          scaleBounds: this.selection.size > 1 ? bounds || undefined : undefined,
        };
      else {
        const hit = this.hit(w);
        if (hit) {
          const ids = this.members(hit);
          const editOnClick =
            !additive &&
            hit.type !== 'document' &&
            (hit.type !== 'image' || hitsFrameLabel(hit, worldToLocal(hit, w), this.camera.zoom)) &&
            ((!hit.groupId &&
              (hitsFrameLabel(hit, worldToLocal(hit, w), this.camera.zoom) ||
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
    if (this.gesture?.mode === 'move' || this.gesture?.mode === 'resize') {
      const original = this.gesture.original,
        moving = new Set(original.map((o) => o.id));
      const c = this.camera,
        margin = 100 / c.zoom;
      const nearby = this.index.search({
        x: -c.x / c.zoom - margin,
        y: -c.y / c.zoom - margin,
        width: this.host.clientWidth / c.zoom + margin * 2,
        height: this.host.clientHeight / c.zoom + margin * 2,
      });
      const bounds = boundsOf(original);
      if (bounds)
        this.gesture.snap = {
          bounds,
          state: {},
          targets: snapTargets(nearby.filter((o) => !moving.has(o.id)).map(objectBounds)),
        };
    }
    this.updateCursor();
    this.host.setPointerCapture(e.pointerId);
  };
  private move = (e: PointerEvent) => {
    const g = this.gesture;
    if (!g) {
      const hovered =
        this.tool === 'select' && !this.space && e.target === this.app.canvas
          ? this.hit(this.screenPoint(this.point(e)))
          : undefined;
      this.callbacks.hover?.(hovered?.type === 'image' && hovered.galleryId ? hovered.id : null);
      this.updateCursor(
        e.target === this.app.canvas ? this.resizeCorner(this.point(e)) : undefined,
      );
      if (
        !this.space &&
        this.tool === 'select' &&
        e.target === this.app.canvas &&
        this.arrowHandle(this.point(e))
      )
        this.host.style.cursor = 'move';
      return;
    }
    this.callbacks.hover?.(null);
    const p = this.point(e),
      dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    const moved = Math.abs(dx) + Math.abs(dy) > 2;
    g.dragged ||= moved;
    g.changed = g.secondary ? g.changed || moved : moved;
    if (g.mode === 'drawArrow') {
      this.preview(arrowFromPoints(g.arrowDraft!, [g.world, this.screenPoint(p)]));
      this.invalidate();
    } else if (g.mode === 'arrowPoint') {
      const points = g.arrowPoints!.map((q) => ({ ...q }));
      points[g.arrowIndex!] = this.screenPoint(p);
      this.preview(arrowFromPoints(g.original[0], points));
      this.invalidate();
    } else if (g.mode === 'pan') {
      if (g.secondary && !g.changed) return;
      this.camera = { ...g.camera, x: g.camera.x + dx, y: g.camera.y + dy };
      this.invalidate();
    } else if (g.mode === 'move') {
      let delta = { x: dx / this.camera.zoom, y: dy / this.camera.zoom };
      if (g.snap) {
        const result = snapMove(
          g.snap.bounds,
          delta,
          g.snap.targets,
          this.camera.zoom,
          g.snap.state,
          e.altKey || !moved,
        );
        delta = result.delta;
        g.snap.state = result.state;
        this.snapGuides = result.guides;
      }
      for (const o of g.original) this.preview({ ...o, x: o.x + delta.x, y: o.y + delta.y });
      this.callbacks.objectDrag?.(g.original, moved ? this.screenPoint(p) : null);
      this.invalidate();
    } else if (g.mode === 'rotate') {
      const o = g.original[0];
      this.preview({
        ...o,
        rotation: rotationFromDrag(o, g.world, this.screenPoint(p), e.shiftKey),
      });
      this.invalidate();
    } else if (g.mode === 'resize') {
      let delta = { x: dx / g.camera.zoom, y: dy / g.camera.zoom };
      if (g.snap) {
        const result = snapResize(
          delta,
          g.snap.targets,
          this.camera.zoom,
          (d) => {
            if (g.scaleBounds)
              return boundsOf(
                resizeSelection(g.original, g.scaleBounds, g.corner as Corner, d.x, d.y),
              )!;
            let resized: CanvasObject = resizeObject(
              g.original[0],
              g.corner!,
              d.x,
              d.y,
              e.shiftKey,
            );
            if (resized.gallery) {
              // Galleries reflow to their contents; align the actual final frame.
              const before = new Map(g.original.map((o) => [o.id, o]));
              resized =
                galleryEdit(before, { upserts: [resized], deleted: [] }, visualBounds).upserts.find(
                  (o) => o.id === resized.id,
                ) || resized;
            }
            return objectBounds(resized);
          },
          g.snap.state,
          e.altKey || !moved,
        );
        delta = result.delta;
        g.snap.state = result.state;
        this.snapGuides = result.guides;
      }
      if (g.scaleBounds) {
        for (const o of resizeSelection(
          g.original,
          g.scaleBounds,
          g.corner as Corner,
          delta.x,
          delta.y,
        ))
          this.preview(o);
      } else {
        const resized = resizeObject(g.original[0], g.corner!, delta.x, delta.y, e.shiftKey);
        if (resized.gallery) {
          const before = new Map(this.objects);
          for (const o of g.original) {
            before.set(o.id, o);
            this.preview(o);
          }
          for (const o of galleryEdit(before, { upserts: [resized], deleted: [] }, visualBounds)
            .upserts)
            this.preview(o);
        } else this.preview(resized);
      }
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
    this.snapGuides = [];
    this.gesture = null;
    this.updateCursor();
    this.callbacks.objectDrag?.([], null);
    if (
      g.mode === 'move' &&
      g.changed &&
      this.callbacks.objectDrop?.(g.original, this.screenPoint(this.point(e)))
    ) {
      for (const o of g.original) this.preview(o);
      this.callbacks.selection(this.selected);
      this.invalidate();
      return;
    }
    if (g.mode === 'drawArrow') {
      const o = this.objects.get(g.arrowDraft!.id)!;
      this.history.push({ upserts: [o], deleted: [] }, { upserts: [], deleted: [o.id] });
      this.callbacks.edit({ upserts: [o], deleted: [] });
      this.setSelection([o.id]);
      this.setTool('select');
      this.callbacks.tool?.('select');
    } else if (g.secondary && !g.changed) this.openContext(e);
    else if (g.mode === 'pan') this.callbacks.camera({ ...this.camera });
    else if (g.mode === 'box' && g.box) {
      const next = new Set(g.original.map((o) => o.id));
      const hits = new Set(
        this.index
          .search(g.box)
          .filter((o) => {
            const b = visualBounds(o, false, this.camera.zoom);
            return (
              b.x <= g.box!.x + g.box!.width &&
              b.x + b.width >= g.box!.x &&
              b.y <= g.box!.y + g.box!.height &&
              b.y + b.height >= g.box!.y
            );
          })
          .flatMap((o) => this.members(o)),
      );
      for (const id of hits) g.toggle && next.has(id) ? next.delete(id) : next.add(id);
      this.setSelection([...next]);
    } else if (
      g.changed &&
      (g.mode === 'move' || g.mode === 'resize' || g.mode === 'rotate' || g.mode === 'arrowPoint')
    ) {
      const after = g.original.map((o) => this.objects.get(o.id)!);
      if (g.original.some((o) => o.gallery || o.galleryId)) {
        for (const o of g.original) this.preview(o);
        this.apply({ upserts: after, deleted: [] });
      } else {
        this.history.push({ upserts: after, deleted: [] }, { upserts: g.original, deleted: [] });
        this.callbacks.edit({ upserts: after, deleted: [] });
        this.callbacks.selection(this.selected);
      }
    } else if (
      g.mode === 'move' ||
      g.mode === 'resize' ||
      g.mode === 'rotate' ||
      g.mode === 'arrowPoint'
    ) {
      for (const o of g.original) this.preview(o);
      if (g.editOnClick && !g.dragged) {
        const object = this.objects.get(g.editOnClick);
        if (object) this.callbacks.activate(object, object.type === 'image' ? 'title' : undefined);
      }
    }
    this.invalidate();
  };
  private cancel = () => {
    this.callbacks.objectDrag?.([], null);
    const g = this.gesture;
    this.snapGuides = [];
    this.gesture = null;
    this.updateCursor();
    if (g) {
      if (g.mode === 'drawArrow') {
        this.objects.delete(g.arrowDraft!.id);
        this.index.remove(g.arrowDraft!.id);
        this.setSelection([]);
      }
      for (const o of g.original) this.preview(o);
      if (g.mode === 'pan') this.camera = g.camera;
      this.invalidate();
    }
  };
  private blur = () => {
    this.stopCameraAnimation();
    this.space = false;
    this.cancel();
  };
  // Freeze at the visible camera before a gesture, explicit camera action or save flush.
  stopCameraAnimation() {
    this.wheelZoom = null;
  }
  private advanceWheelZoom(time: number) {
    const animation = this.wheelZoom;
    if (!animation) return;
    const dt = Math.max(0, Math.min(64, time - animation.time));
    animation.time = time;
    const distance = Math.log(animation.target / this.camera.zoom);
    const next = this.camera.zoom * Math.exp(distance * (1 - Math.exp(-dt / 55)));
    const done = Math.abs(Math.log(animation.target / next)) < 0.0001;
    this.camera = zoomAt(this.camera, animation.point, done ? animation.target : next);
    if (done) this.wheelZoom = null;
    this.callbacks.camera({ ...this.camera });
  }
  private wheel = (e: WheelEvent) => {
    if (e.target !== this.app.canvas) return;
    e.preventDefault();
    if (this.gesture || !Number.isFinite(e.deltaY) || !e.deltaY) return;
    const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.host.clientHeight : 1;
    const delta = Math.max(-100, Math.min(100, e.deltaY * units));
    const point = this.point(e);
    const pending = this.wheelZoom;
    // Reversing the wheel discards remaining motion in the old direction.
    const base =
      pending && Math.sign(Math.log(pending.target / this.camera.zoom)) === -Math.sign(delta)
        ? pending.target
        : this.camera.zoom;
    const target = zoomAt(this.camera, point, base * Math.exp(-delta * 0.001)).zoom;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.stopCameraAnimation();
      this.camera = zoomAt(this.camera, point, target);
      this.callbacks.camera({ ...this.camera });
    } else {
      this.wheelZoom = { target, point, time: pending?.time ?? performance.now() };
    }
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
    const handle = this.arrowHandle(this.point(e));
    if (
      handle &&
      !handle.insert &&
      handle.index > 0 &&
      handle.index < arrowPoints(this.selected[0]).length - 1
    ) {
      const o = this.selected[0],
        points = arrowPoints(o).map((p) => localToWorld(o, p));
      points.splice(handle.index, 1);
      this.apply({ upserts: [arrowFromPoints(o, points)], deleted: [] });
      return;
    }
    const world = this.screenPoint(this.point(e));
    const o = this.hit(world);
    if (o)
      this.callbacks.activate(
        o,
        o.type === 'image' && hitsFrameLabel(o, worldToLocal(o, world), this.camera.zoom)
          ? 'title'
          : undefined,
      );
    else this.callbacks.create('text', world);
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
    this.stopCameraAnimation();
    this.editingId = id;
    if (!id) this.editingPreview = null;
    this.invalidate();
  }
  setEditingPreview(object: CanvasObject | null) {
    this.editingPreview = object ? this.withDocumentPreview(object) : null;
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
  private arrowHandle(p: Point) {
    if (this.selection.size !== 1 || this.selected[0].type !== 'arrow') return;
    const o = this.selected[0];
    return arrowHandles(o)
      .sort((a, b) => Number(a.insert) - Number(b.insert))
      .find((h) => {
        const q = localToWorld(o, h);
        return (
          Math.hypot(
            p.x - q.x * this.camera.zoom - this.camera.x,
            p.y - q.y * this.camera.zoom - this.camera.y,
          ) < 10
        );
      });
  }
  private resizeCorner(p: Point): ResizeHandle | 'rotate' | undefined {
    if (!this.selection.size || this.editingId || this.cropPreview) return;
    if (this.selection.size > 1) {
      const b = boundsOf(this.selected)!;
      return corners.find((corner) => {
        const x = (b.x + (corner.includes('e') ? b.width : 0)) * this.camera.zoom + this.camera.x;
        const y = (b.y + (corner.includes('s') ? b.height : 0)) * this.camera.zoom + this.camera.y;
        return Math.abs(p.x - x) < 10 && Math.abs(p.y - y) < 10;
      });
    }
    const o = this.selected[0],
      c = this.camera;
    if (o.type === 'arrow') return;
    let nearest: ResizeHandle | 'rotate' | undefined,
      distance = Infinity;
    for (const corner of [...resizeHandles, 'rotate'] as const) {
      if (o.gallery && corner === 'rotate') continue;
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
      (this.selection.size === 1 && selectedId ? this.objects.get(selectedId)?.rotation || 0 : 0) +
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
    o = this.withDocumentPreview(o);
    const meta = this.linkPreviews.get(o.id);
    if (o.type === 'link' && meta && meta.url === o.url) o = withLinkPreview(o, meta);
    this.objects.set(o.id, o);
    this.index.upsert(o);
  }
  private moveObjects(): CanvasObject[] {
    // Capture membership before the drag, so crossing other objects cannot
    // collect them mid-gesture. Geometry also releases items moved out of a frame.
    return stackingSelection(this.all, this.selected).map((o) => ({ ...o }));
  }
  prepareExternalEdit() {
    this.stopCameraAnimation();
    this.cancel();
  }
  get hasActiveGesture() {
    return this.gesture !== null;
  }
  acceptExternalEdit(edit: Edit) {
    for (const id of [...edit.upserts.map((o) => o.id), ...edit.deleted]) {
      this.linkPreviews.delete(id);
      this.documentPreviews.delete(id);
    }
    this.apply(edit);
  }
  apply(edit: Edit, record = true) {
    if (record) edit = galleryEdit(this.objects, edit, visualBounds);
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
    if (this.selection.size)
      this.apply({ upserts: [], deleted: this.clipboardSelection.map((o) => o.id) });
  }
  duplicate() {
    const ids = new Map<string, string>();
    const objects = this.clipboardSelection;
    const objectIds = new Map(objects.map((o) => [o.id, uid()]));
    const top = this.topZ();
    const copies = objects.map((o, i) => {
      if (o.groupId && !ids.has(o.groupId)) ids.set(o.groupId, uid());
      return {
        ...o,
        id: objectIds.get(o.id)!,
        x: o.x + 28,
        y: o.y + 28,
        z: top + i + 1,
        groupId: o.groupId ? ids.get(o.groupId) : undefined,
        galleryId: o.galleryId ? objectIds.get(o.galleryId) : undefined,
        galleryIndex: o.galleryId && objectIds.has(o.galleryId) ? o.galleryIndex : undefined,
        galleryRow: o.galleryId && objectIds.has(o.galleryId) ? o.galleryRow : undefined,
        galleryColumn: o.galleryId && objectIds.has(o.galleryId) ? o.galleryColumn : undefined,
      };
    });
    if (copies.length) {
      this.apply({ upserts: copies, deleted: [] });
      this.setSelection(copies.filter((o) => !o.galleryId).map((o) => o.id));
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
    this.stopCameraAnimation();
    this.camera = zoomAt(
      this.camera,
      { x: this.host.clientWidth / 2, y: this.host.clientHeight / 2 },
      this.camera.zoom * factor,
    );
    this.callbacks.camera({ ...this.camera });
    this.invalidate();
  }
  focusObject(id: string) {
    const object = this.objects.get(id);
    if (!object) return false;
    this.setTool('select');
    this.callbacks.tool?.('select');
    this.setSelection([id]);
    this.fit([object]);
    return true;
  }
  fit(objects = this.all) {
    this.stopCameraAnimation();
    const b = boundsOf(objects);
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
    this.frame = requestAnimationFrame((time) => {
      this.frame = 0;
      this.advanceWheelZoom(time);
      if (this.ready) this.draw();
      if (this.wheelZoom) this.invalidate();
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
      .filter((o) => {
        const b = visualBounds(o, false, c.zoom);
        return (
          (b.x + b.width) * c.zoom + c.x >= -50 &&
          b.x * c.zoom + c.x <= w + 50 &&
          (b.y + b.height) * c.zoom + c.y >= -50 &&
          b.y * c.zoom + c.y <= h + 50
        );
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
    this.callbacks.lists?.(
      visible.filter((o) => o.type === 'list'),
      c,
    );
    this.callbacks.composers?.(
      visible.filter((o) => !!o.pdfComposer),
      c,
    );
    const lightMargin = 600;
    const lightingObjects =
      this.dark && document.documentElement.dataset.nightGlow === 'true'
        ? this.index.search({
            x: (-c.x - lightMargin) / c.zoom,
            y: (-c.y - lightMargin) / c.zoom,
            width: (w + lightMargin * 2) / c.zoom,
            height: (h + lightMargin * 2) / c.zoom,
          })
        : [];
    this.lighting.draw(
      lightingObjects,
      c,
      w,
      h,
      this.dark && document.documentElement.dataset.nightGlow === 'true',
    );
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
      if (!['image', 'link', 'document'].includes(o.type)) continue;
      const showImage = o.type === 'image' || o.type === 'document' || hasLinkImage(o);
      const mediaId =
        o.type === 'document' ? o.documentPreviewId : showImage ? o.assetId : o.linkIconId;
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
      // Text scales with zoom; only decorative controls use the detail cutoff.
      const hasLabel =
        o.type === 'document' ||
        (this.editingId !== o.id &&
          (o.type === 'image'
            ? !!o.imageTitle?.trim() || !texture
            : o.type === 'frame' || o.type === 'video' || o.type === 'link' || !!o.text));
      const resolution = 2 ** Math.ceil(Math.log2(c.zoom * devicePixelRatio));
      const region = textRegion(o, c, w, h, c.zoom);
      const signature = JSON.stringify([
        this.dark,
        !!o.gallery,
        o.width,
        o.height,
        o.text,
        o.imageTitle,
        o.documentTitle,
        o.documentMime,
        o.documentBytes,
        o.documentPreviewId,
        o.documentExcerpt,
        o.documentPageCount,
        o.url,
        o.linkDescription,
        o.linkCompact,
        loading,
        o.color,
        o.fontSize,
        o.textBox,
        o.bold,
        o.strikethrough,
        o.centerX,
        o.centerY,
        o.type,
        o.type === 'frame' ? c.zoom : null,
        o.crop,
        o.arrow,
        key,
        texture?.uid,
        iconKey,
        iconTexture?.uid,
        detail,
        hasLabel ? resolution : 0,
        hasLabel ? region : null,
        this.editingId === o.id,
        detailTiles.map((tile) => [tile.key, tile.texture?.uid]),
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
    exporting = false,
  ) {
    const container = new Container(),
      g = new Graphics(),
      color = o.color || '#e8edf5';
    const dark = this.dark && !exporting;
    container.eventMode = 'none';
    if (o.pdfComposer) {
      if (exporting && texture) {
        const sprite = new Sprite(texture);
        sprite.width = o.width;
        sprite.height = o.height;
        container.addChild(sprite);
      }
      return container;
    }
    if (o.type === 'document') {
      container.addChild(renderDocumentCard(o, texture, resolution, region, dark));
      if ((exporting || this.editingId !== o.id) && o.documentTitle?.trim()) {
        const label = renderText(o, o.documentTitle, resolution, region, dark);
        if (label) container.addChild(label);
      }
      return container;
    }
    if (o.type === 'list') {
      // Interactive glass is rendered in the DOM; exports use the same card geometry.
      if (!exporting) return container;
      const layout = listLayout(o);
      const card = new Container();
      card.scale.set(layout.scale);
      container.addChild(card);
      o = { ...o, width: layout.width, height: layout.height };
      resolution *= layout.scale;
      g.roundRect(0, 0, o.width, o.height, 20)
        .fill('#f4f7fa')
        .stroke({ color: '#d7e0e7', width: 1 });
      card.addChild(g);
      const measure = document.createElement('canvas').getContext('2d')!;
      const label = (
        value: string,
        x: number,
        y: number,
        size: number,
        checked = false,
        bold = false,
        strike = checked,
      ) => {
        measure.font = `${bold ? 'bold' : 'normal'} ${size}px "Segoe UI", sans-serif`;
        const available = Math.max(1, o.width - x - (size === 16 ? 56 : 16));
        const lines = wrapListText(value, available, (text) => measure.measureText(text).width);
        lines.forEach((line, index) => {
          const text = new Text({
            text: line,
            resolution,
            style: {
              fontFamily: 'Segoe UI',
              fontSize: size,
              fontWeight: bold ? 'bold' : 'normal',
              fill: checked ? '#87928e' : '#29313b',
            },
          });
          const lineY = y + index * 24;
          text.position.set(x, lineY);
          card.addChild(text);
          if (strike)
            g.moveTo(x, lineY + 10)
              .lineTo(Math.min(o.width - 22, x + text.width), lineY + 10)
              .stroke({ color: '#87928e', width: 1 });
        });
        return lines.length;
      };
      const titleLines = o.text ? label(o.text, 51, 20, 15, false, o.bold, o.strikethrough) : 1;
      let y = 72 + (titleLines - 1) * 24;
      (o.items || []).forEach((item) => {
        g.circle(28, y, 10).stroke({ color: item.checked ? '#729385' : '#a0aebb', width: 1.4 });
        if (item.checked) {
          g.circle(28, y, 10).fill('#729385');
          g.moveTo(23, y)
            .lineTo(27, y + 4)
            .lineTo(33, y - 4)
            .stroke({ color: '#ffffff', width: 1.5 });
        }
        const lines = label(item.text, 51, y - 10, 16, item.checked);
        y += Math.max(44, lines * 24 + 20);
      });
      return container;
    }
    if (o.type === 'arrow') {
      drawArrow(g, dark ? { ...o, color: nightInk(o, o.color || '#66758a') } : o);
      container.addChild(g);
      if (o.text) {
        const p = arrowLabelPoint(o),
          labelObject = arrowLabelObject(o);
        const label = renderText(
          labelObject,
          o.text,
          resolution,
          {
            x: 0,
            y: 0,
            width: labelObject.width,
            height: labelObject.height,
          },
          dark,
        );
        if (label) {
          label.x += p.x - labelObject.width / 2;
          label.y += p.y - labelObject.height / 2;
          container.addChild(label);
        }
      }
      return container;
    }
    if (o.type === 'link') {
      const compact = !hasLinkImage(o);
      const iconY = compact && o.linkDescription ? 36 : o.height / 2;
      const box = linkLayout(o.width, o.height);
      g.roundRect(0, 0, o.width, o.height, linkCornerRadius)
        .fill(dark ? '#1c2632' : '#ffffff')
        .stroke({ color: dark ? '#3a485b' : '#dce2eb', width: 1 });
      if (!compact)
        g.roundRect(box.x, box.y, box.width, box.height, 8).fill(dark ? '#151d27' : '#eef1f5');
      if (compact) {
        g.roundRect(o.width - 48, iconY - 18, 36, 36, 11).fill(dark ? '#2c394b' : '#f0f3f7');
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
          .stroke({ color: dark ? '#a7b9ce' : '#536172', width: 1.6 });
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
      {
        const label = renderLinkCaption(o, resolution, region, loading, dark);
        if (label) container.addChild(label);
      }
      return container;
    }
    if (o.type === 'image' && texture) {
      const sprite = this.imageSprite(texture, o.crop);
      sprite.width = o.width;
      sprite.height = o.height;
      container.addChild(sprite);
      if ((exporting || this.editingId !== o.id) && o.imageTitle?.trim()) {
        const label = renderText(o, o.imageTitle, resolution, region, dark);
        if (label) container.addChild(label);
      }
      return container;
    }
    if (dark && ['note', 'rect', 'ellipse', 'frame'].includes(o.type)) {
      if (o.type === 'ellipse') g.ellipse(o.width / 2, o.height / 2, o.width / 2, o.height / 2);
      else g.roundRect(0, 0, o.width, o.height, o.type === 'note' ? 4 : 8);
      g.fill({
        color: o.type === 'frame' ? '#202b38' : color,
        alpha: o.type === 'frame' ? 0.5 : 0.13,
      }).stroke({ color: o.type === 'frame' ? '#6b8098' : color, alpha: 0.28, width: 1 });
      if (o.type !== 'ellipse')
        g.moveTo(5, 0.5)
          .lineTo(o.width - 5, 0.5)
          .stroke({ color: '#ffffff', alpha: 0.22, width: 0.8 });
    } else if (o.type === 'ellipse')
      g.ellipse(o.width / 2, o.height / 2, o.width / 2, o.height / 2).fill(color);
    else if (o.type === 'frame')
      o.gallery
        ? g
            .roundRect(0, 0, o.width, o.height, 8)
            .fill({ color: '#ffffff', alpha: 0.48 })
            .stroke({ color: '#dce3eb', width: 1 })
        : g.rect(0, 0, o.width, o.height).fill('#ffffff').stroke({ color: '#dce1e7', width: 1 });
    else if (o.type !== 'text') {
      if (o.type === 'note') {
        // Paper stays almost flat. Most of the depth comes from a diffuse
        // shadow below it, rather than a bowed silhouette or pointed corners.
        const size = Math.min(o.width, o.height);
        const curl = size * 0.002;
        for (let layer = 24; layer >= 1; layer--) {
          const t = layer / 24;
          const spread = size * 0.055 * t;
          g.roundRect(
            -spread,
            size * 0.022 - spread * 0.7,
            o.width + spread * 2,
            o.height + spread * 1.4,
            Math.min(spread + size * 0.006, o.width / 4, o.height / 4),
          ).fill({ color: '#454332', alpha: 0.01 * (1 - t) ** 1.3 });
        }
        g.moveTo(0, 0)
          .lineTo(o.width, 0)
          .lineTo(o.width, o.height - curl * 0.4)
          .quadraticCurveTo(o.width * 0.5, o.height + curl * 0.2, 0, o.height - curl * 0.4)
          .closePath()
          .fill(color);
        const edge = Math.min(0.5, o.width / 100, o.height / 100);
        g.moveTo(0, 0).lineTo(o.width, 0).stroke({ color: '#ffffff', alpha: 0.4, width: edge });
        // A faint sheen near the attached edge gives the flat fill paper depth.
        for (let band = 0; band < 8; band++) {
          g.rect(
            edge,
            edge + band * o.height * 0.01,
            Math.max(0, o.width - edge * 2),
            o.height * 0.01,
          ).fill({ color: '#ffffff', alpha: 0.035 * (1 - band / 8) });
        }
      } else
        g.roundRect(0, 0, o.width, o.height, 7).fill(
          o.type === 'image' || o.type === 'video' ? (dark ? '#253143' : '#e8ecf2') : color,
        );
    }
    container.addChild(g);
    if (exporting || this.editingId !== o.id) {
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
          dark,
          exporting ? undefined : this.camera?.zoom,
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
    // Screen-space dashes keep guides fine and readable at every canvas zoom.
    for (const guide of this.snapGuides) {
      const vertical = guide.axis === 'x',
        c = this.camera;
      const at = guide.at * c.zoom + (vertical ? c.x : c.y);
      const from = Math.max(0, guide.from * c.zoom + (vertical ? c.y : c.x) - 12);
      const to = Math.min(
        vertical ? this.host.clientHeight : this.host.clientWidth,
        guide.to * c.zoom + (vertical ? c.y : c.x) + 12,
      );
      for (let p = from; p < to; p += 8) {
        const end = Math.min(p + 4, to);
        if (vertical) g.moveTo(at, p).lineTo(at, end);
        else g.moveTo(p, at).lineTo(end, at);
      }
    }
    if (this.snapGuides.length) g.stroke({ color: '#568cff', width: 1, alpha: 0.9 });
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
    if (toolbarBounds && this.selection.size === 1 && this.selected[0].type !== 'arrow') {
      const o = this.editingPreview || this.selected[0];
      if (
        hasExternalLabel(o) ||
        ((o.type === 'image' || o.type === 'document') && this.editingId === o.id)
      ) {
        const visual = visualBounds(o, this.editingId === o.id, c.zoom);
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
      if (this.selection.size === 1 && this.selected[0].type === 'arrow') {
        const o = this.selected[0];
        const path = arrowPath(o).map((p) => localToWorld(o, p));
        for (let i = 0; i < path.length; i++) {
          const p = path[i];
          if (i) g.lineTo(p.x * c.zoom + c.x, p.y * c.zoom + c.y);
          else g.moveTo(p.x * c.zoom + c.x, p.y * c.zoom + c.y);
        }
        g.stroke({ color: '#4486d9', width: 1 });
        for (const h of arrowHandles(o)) {
          const p = localToWorld(o, h);
          g.circle(p.x * c.zoom + c.x, p.y * c.zoom + c.y, h.insert ? 4 : 5)
            .fill(h.insert ? '#4486d9' : '#ffffff')
            .stroke({ color: h.insert ? '#ffffff' : '#4486d9', width: 1.5 });
        }
      } else if (this.selection.size !== 1) {
        g.rect(x, y, w, h).stroke({ color: '#4486d9', width: 1.5 });
        for (const corner of corners) {
          const hx = x + (corner.includes('e') ? w : 0),
            hy = y + (corner.includes('s') ? h : 0);
          g.rect(hx - 4, hy - 4, 8, 8)
            .fill('#ffffff')
            .stroke({ color: '#4486d9', width: 1.5 });
        }
      } else {
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
        } else if (o.type !== 'list') g.poly(outline).stroke({ color: '#4486d9', width: 1.5 });
        for (const handle of resizeHandles) {
          const p = screen(handlePoint(o, handle));
          if (o.type === 'link') g.circle(p.x, p.y, 3.5);
          else g.rect(p.x - 4, p.y - 4, 8, 8);
          g.fill('#ffffff').stroke({ color: '#4486d9', width: 1.5 });
        }
        if (!o.gallery) {
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
    }
    if (this.gesture?.mode !== 'rotate') this.callbacks.rotation?.(null);
    if (this.gesture?.box) {
      const b = this.gesture.box;
      g.rect(b.x * c.zoom + c.x, b.y * c.zoom + c.y, b.width * c.zoom, b.height * c.zoom)
        .fill({ color: '#4486d9', alpha: 0.08 })
        .stroke({ color: '#4486d9', width: 1 });
    }
  }
  async exportCanvas(
    scope: ExportScope,
    progress: (value: number, label: string) => void,
    assetUrl: (id: string, variant: string) => string,
    quality: ExportQuality,
    dimensions: (id: string) => Promise<{ width: number; height: number }>,
  ) {
    await this.initialized;
    if (this.disposed || !this.ready) throw Error('The canvas is not ready to export.');
    const getBounds = (o: CanvasObject) => {
      const b = visualBounds(o);
      const pad = o.type === 'note' ? Math.min(o.width, o.height) * 0.08 : 2;
      return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
    };
    const plan = exportPlan(
      this.all,
      [...this.selection],
      scope,
      this.camera,
      { width: this.host.clientWidth, height: this.host.clientHeight },
      getBounds,
    );
    let sourceScale = 1;
    const images = plan.objects.flatMap((object) => {
      const id =
        object.type === 'document'
          ? object.documentPreviewId
          : object.type === 'image' || (object.type === 'link' && hasLinkImage(object))
            ? object.assetId
            : undefined;
      return id ? [{ object, id }] : [];
    });
    if (quality === 'full') {
      const sizes = new Map<string, { width: number; height: number }>();
      for (let i = 0; i < images.length; i++) {
        const { object: o, id } = images[i];
        progress(Math.round((4 * i) / images.length), `Reading original image sizes…`);
        if (!sizes.has(id)) {
          try {
            sizes.set(id, await dimensions(id));
          } catch (error) {
            if (o.type !== 'document') throw error;
            // A derived document thumbnail is optional. Its file card still
            // exports when the thumbnail is missing or cannot be decoded.
            continue;
          }
        }
        const size = sizes.get(id)!;
        const box =
          o.type === 'document'
            ? documentPreviewBox(o)
            : o.type === 'link'
              ? linkLayout(o.width, o.height)
              : o;
        sourceScale = Math.max(
          sourceScale,
          (size.width * (o.crop?.width || 1)) / box.width,
          (size.height * (o.crop?.height || 1)) / box.height,
        );
      }
      // Text/shape-only exports have no source pixel density: render at least 4K.
      if (!images.length)
        sourceScale = Math.max(2, 4096 / Math.max(plan.bounds.width, plan.bounds.height));
    }
    // Resolution changes pixel density, not the PDF's physical page dimensions.
    const pageSize = { width: plan.width * 0.75, height: plan.height * 0.75 };
    const resolution = exportResolution(plan.bounds, quality, sourceScale);
    Object.assign(plan, resolution);
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fbfcfd';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const camera = {
      x: -plan.bounds.x * plan.scale,
      y: -plan.bounds.y * plan.scale,
      zoom: plan.scale,
    };
    // Draw one object at a time so original images and GPU textures are released
    // as we go; exports do not disturb the on-screen camera, selection or cache.
    for (let i = 0; i < plan.objects.length; i++) {
      const o = plan.objects[i];
      const textures: Texture[] = [];
      const bitmaps: ImageBitmap[] = [];
      let composerCanvas: HTMLCanvasElement | undefined;
      let container: Container | undefined;
      const load = async (id: string, icon = false) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const decode = async (variant: string) => {
          img.src = assetUrl(id, variant);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              img.decode(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  img.src = '';
                  reject(Error('Image loading timed out.'));
                }, 20000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        if (icon) await decode('thumb');
        else {
          try {
            await decode('original');
          } catch {
            await decode('export');
          }
        }
        const needed = icon
          ? Math.max(256, 24 * plan.scale)
          : Math.min(
              8192,
              Math.max(o.width / (o.crop?.width || 1), o.height / (o.crop?.height || 1)) *
                plan.scale,
            );
        const scale = Math.min(1, needed / Math.max(img.naturalWidth, img.naturalHeight));
        const bitmap = await createImageBitmap(img, {
          resizeWidth: Math.max(1, Math.ceil(img.naturalWidth * scale)),
          resizeHeight: Math.max(1, Math.ceil(img.naturalHeight * scale)),
          resizeQuality: 'high',
        });
        bitmaps.push(bitmap);
        const texture = Texture.from(bitmap);
        textures.push(texture);
        return texture;
      };
      progress(
        5 + Math.round((75 * i) / Math.max(1, plan.objects.length)),
        `Rendering ${i + 1} of ${plan.objects.length} items…`,
      );
      // Yield to paint progress even when every item is a shape or text.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const imageId =
          o.type === 'document'
            ? o.documentPreviewId
            : o.type === 'image' || (o.type === 'link' && hasLinkImage(o))
              ? o.assetId
              : o.type === 'link'
                ? o.linkIconId
                : undefined;
        let texture: Texture | null = null;
        if (o.pdfComposer) {
          const { composerSnapshot } = await import('./pdf-composer-snapshot');
          composerCanvas = await composerSnapshot(o, plan.scale);
          texture = Texture.from(composerCanvas);
          textures.push(texture);
        }
        if (imageId) {
          try {
            texture = await load(imageId, o.type === 'link' && !hasLinkImage(o));
          } catch (error) {
            if (o.type !== 'document') throw error;
          }
        }
        const icon =
          o.type === 'link' && hasLinkImage(o) && o.linkIconId
            ? await load(o.linkIconId, true)
            : null;
        if (this.disposed) throw Error('The canvas closed before export finished.');
        container = new Container();
        const view = this.makeView(
          o,
          texture,
          true,
          plan.scale,
          textRegion(o, camera, plan.width, plan.height),
          false,
          icon,
          true,
        );
        view.pivot.set(o.width / 2, o.height / 2);
        view.position.set(o.x + o.width / 2, o.y + o.height / 2);
        view.rotation = ((o.rotation || 0) * Math.PI) / 180;
        // Pixi extraction replaces the root transform. Keep the export camera
        // on a child so the requested pixel frame uses that transform.
        const scene = new Container();
        scene.addChild(view);
        scene.scale.set(plan.scale);
        scene.position.set(camera.x, camera.y);
        container.addChild(scene);
        const b = getBounds(o);
        const left = Math.max(0, Math.floor(b.x * plan.scale + camera.x));
        const top = Math.max(0, Math.floor(b.y * plan.scale + camera.y));
        const right = Math.min(plan.width, Math.ceil((b.x + b.width) * plan.scale + camera.x));
        const bottom = Math.min(plan.height, Math.ceil((b.y + b.height) * plan.scale + camera.y));
        if (right > left && bottom > top) {
          const part = this.app.renderer.extract.canvas({
            target: container,
            frame: new Rectangle(left, top, right - left, bottom - top),
            resolution: 1,
            clearColor: [0, 0, 0, 0],
          });
          context.drawImage(part as HTMLCanvasElement, left, top);
          part.width = part.height = 1;
        }
      } finally {
        container?.destroy({ children: true });
        for (const texture of textures) texture.destroy(true);
        if (composerCanvas) composerCanvas.width = composerCanvas.height = 1;
        for (const bitmap of bitmaps) bitmap.close();
      }
    }
    progress(82, 'Encoding file…');
    return { canvas, limited: resolution.limited, pageSize };
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
    this.stopCameraAnimation();
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    window.removeEventListener(appearanceEvent, this.appearanceChanged);
    this.lighting.destroy();
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
