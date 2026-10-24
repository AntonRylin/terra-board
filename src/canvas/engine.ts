import { editTouchesLocked } from './object-lock';
import { linkedFrameScene, sceneObjects, type FrameBoards, type FrameScene } from './frame-links';
import { frameMediaKey, renderLinkedFrame } from './frame-link-rendering';
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
  arrowEnd,
  arrowHeldBy,
  copyArrowEnds,
  followArrow,
  keepArrowEnds,
  canConnect,
  connectionPoint,
  connectorDot,
  connectorSides,
  dropSide,
  hasAutoBends,
  routedPoints,
  sidePoint,
  type ConnectorSide,
} from './connectors';
import {
  clampHighlightSize,
  defaultHighlightStyle,
  highlightAlpha,
  highlightBounds,
  highlightFromPoints,
  highlightPoints,
  highlightSize,
  hitsHighlight,
  simplifyStroke,
  clampPenSize,
  defaultPenStyle,
  isPen,
  smoothStroke,
} from './highlight';
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
import {
  AlphaFilter,
  CanvasSource,
  Application,
  Container,
  Graphics,
  Sprite,
  Rectangle,
  Texture,
} from 'pixi.js';
import type { CanvasObject, Camera, Edit, Tool, ImageCrop, ImageAdded } from '../model';
import { uid } from '../model';
import { stampAdded } from './image-added.ts';
import { SpatialIndex, screenToWorld, zoomAt, boundsOf, type Point, type Bounds } from './geometry';
import { History } from './history';
import {
  stackingHierarchy,
  stackingOverlap,
  stackingSelection,
  bringToFrontEdit,
  copySelection,
} from './stacking';
import { renderText, renderLinkCaption, textRegion, textSpoilers } from './text-rendering';
import { hasRichText, shownMarks, shownText } from './rich-text';
import { dustLayer, hideDuration, revealDuration, updateDust } from './spoiler-dust';
import {
  canBeSpoiler,
  concealedBy,
  coverSpoiler,
  hidesContents,
  isSpoiler,
  spoilerContent,
  updateSpoilerCover,
  wholeObject,
} from './object-spoiler';
import { documentPreviewBox, renderDocumentCard } from './document-card';
import { renderBrowserCard, renderHtmlCard } from './html-card-rendering';
import { renderAlbumName } from './album-rendering';
import { isWebCard, snapshotKey } from './html-card';
import { listLayout } from './list-layout';
import { drawTable } from './table-drawing';
import { drawFilePlaceholder } from './file-link';
import { unionBounds } from './pins';
import {
  paginateLines,
  paperContentHeight,
  paperContentWidth,
  paperFontSize,
  paperLineHeight,
  paperMargin,
  paperPageHeight,
  paperPageTop,
  paperPages,
  paperScale,
  paperWidth,
} from './paper-layout';
import { drawRichText, layoutRichText, richTextHeight } from './rich-text-canvas';
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
import {
  hitsFrameLabel,
  visualBounds,
  pictureBounds,
  hasExternalLabel,
  arrowLabelObject,
  frameLabel,
} from './frame-label';
import { galleryEdit, selectionWithGalleryImages } from './gallery';
import {
  youtubeId,
  linkLayout,
  hitsLinkPlay,
  withLinkPreview,
  linkCornerRadius,
  hasLinkImage,
} from './link-preview';
import { activeCommand } from '../shortcuts/active.ts';
import type { CommandId } from '../shortcuts/commands';
import type { WheelMode, ZoomSpeed } from '../settings/preferences';

const zoomRates: Record<ZoomSpeed, number> = { slow: 0.0006, normal: 0.001, fast: 0.0017 };
// Board commands that must not act on a floating click-to-place preview.
const placementBlocked = new Set<CommandId>([
  'edit.undo',
  'edit.redo',
  'edit.selectAll',
  'edit.duplicate',
  'edit.group',
  'edit.ungroup',
  'edit.delete',
]);
export type InputPreferences = { wheel: WheelMode; zoomSpeed: ZoomSpeed; snapping: boolean };
interface Callbacks {
  lists?: (objects: CanvasObject[], camera: Camera) => void;
  tables?: (objects: CanvasObject[], camera: Camera) => void;
  files?: (objects: CanvasObject[], camera: Camera) => void;
  papers?: (objects: CanvasObject[], camera: Camera) => void;
  composers?: (objects: CanvasObject[], camera: Camera) => void;
  objectDrag?: (objects: CanvasObject[], point: Point | null) => void;
  objectDrop?: (objects: CanvasObject[], point: Point) => boolean;
  // The objects a move, resize or turn changes, on every frame; null when it ends.
  live?: (objects: CanvasObject[] | null) => void;
  tool?: (tool: Tool) => void;
  edit: (e: Edit) => void;
  camera: (c: Camera) => void;
  selection: (items: CanvasObject[]) => void;
  hover?: (imageId: string | null) => void;
  // The object under the pointer with the select tool, outside gestures, and
  // the pointer's board position.
  hoverObject?: (o: CanvasObject | null, point: Point | null) => void;
  // HTML embeds on screen, each frame, for running their pages under the board.
  embeds?: (objects: CanvasObject[], camera: Camera) => void;
  selectionView?: (bounds: Bounds | null, viewport: { width: number; height: number }) => void;
  rotation?: (value: { angle: number; x: number; y: number } | null) => void;
  activate: (o: CanvasObject, intent?: 'title') => void;
  // View mode: a tap on an object (embeds, links, pictures open), or on empty board.
  viewTap?: (o: CanvasObject | null) => void;
  create: (tool: Tool, p: Point) => void;
  context: (p: Point) => void;
  highlightSize?: (size: number) => void;
  penSize?: (size: number) => void;
  ready: () => void;
  error: (message: string) => void;
}
type Gesture = {
  mode:
    | 'pan'
    | 'move'
    | 'resize'
    | 'rotate'
    | 'box'
    | 'drawArrow'
    | 'arrowPoint'
    | 'drawHighlight'
    | 'highlightSize';
  highlightDraft?: CanvasObject;
  highlightPath?: Point[];
  highlightSize?: number;
  arrowDraft?: CanvasObject;
  arrowPointer?: Point;
  clickToPlace?: boolean;
  // An arrow dragged out of a selected object's side dot, and the object it will point at.
  connectFrom?: { id: string; side: ConnectorSide };
  connectTarget?: string;
  // A held arrow end being dragged ('from' or 'to'): it lets go, or holds what it lands on.
  connectEnd?: 'from' | 'to';
  // Arrows held by what this gesture moves, as they were before it.
  held?: Map<string, CanvasObject>;
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
  // Touch: a finger panning empty board clears the selection only if it was a tap.
  tapClears?: boolean;
  // Touch: a selection box begun by holding a finger still, and where it was held.
  holdAt?: Point;
  // View mode (and read-only boards): a press that pans, and on a tap opens what it hit.
  view?: boolean;
  viewTarget?: CanvasObject;
  // A locked object under the press: it lets the press through, and holding it for two
  // seconds selects it (to unlock it).
  lockedTarget?: CanvasObject;
};
const composerPreviewKey = (o: CanvasObject) =>
  `composer:${JSON.stringify(o.pdfComposer)}:${o.width}:${o.height}`;
export class Engine {
  private frameBoardId = '';
  private frameBoards: FrameBoards = new Map();
  private composerPreviews = new Map<string, Texture | null>();
  private frameMediaVariants = new Map<string, string>();
  setFrameBoard(id: string, objects: CanvasObject[] | null, current = false) {
    if (current) this.frameBoardId = id;
    if (
      JSON.stringify(this.frameBoards.get(id)) === JSON.stringify(objects) &&
      this.frameBoards.has(id)
    )
      return;
    this.frameBoards.set(id, objects);
    this.invalidate();
  }
  private frameScene(o: CanvasObject) {
    this.frameBoards.set(this.frameBoardId, this.all);
    return linkedFrameScene(o, this.frameBoards);
  }
  private composerTexture(o: CanvasObject, wanted: Set<string>) {
    const key = composerPreviewKey(o);
    wanted.add(key);
    if (!this.composerPreviews.has(key)) {
      this.composerPreviews.set(key, null);
      void import('./pdf-composer-snapshot')
        .then(({ composerSnapshot }) => composerSnapshot(o, 1))
        .then((canvas) => {
          if (this.disposed || !this.composerPreviews.has(key)) return;
          this.composerPreviews.set(key, Texture.from(canvas));
          this.invalidate();
        })
        .catch(() => {});
    }
  }
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
  // A captured picture of a web card. It belongs to the page and size it was
  // captured from; a picture for an older version is dropped.
  hydrateSnapshot(id: string, key: string, assetId: string) {
    const object = this.objects.get(id);
    if (this.disposed || !object || !isWebCard(object) || snapshotKey(object) !== key) return;
    if (object.assetId === assetId && object.snapshotKey === key) return;
    const original = this.gesture?.original.find((o) => o.id === id);
    if (original) {
      // Keep the committed geometry on disk if the gesture is cancelled.
      this.preview({ ...object, assetId, snapshotKey: key });
      if (snapshotKey(original) === key)
        this.callbacks.edit({
          upserts: [{ ...original, assetId, snapshotKey: key }],
          deleted: [],
        });
      this.invalidate();
    } else this.apply({ upserts: [{ ...object, assetId, snapshotKey: key }], deleted: [] }, false);
  }
  app = new Application();
  camera: Camera;
  tool: Tool = 'select';
  highlightStyle = { ...defaultHighlightStyle };
  penStyle = { ...defaultPenStyle };
  // The pen and the highlighter draw the same kind of stroke with their own style.
  private get inkTool() {
    return this.tool === 'highlight' || this.tool === 'pen';
  }
  private get inkStyle() {
    return this.tool === 'pen' ? this.penStyle : this.highlightStyle;
  }
  private clampInk(size: number) {
    return this.tool === 'pen' ? clampPenSize(size) : clampHighlightSize(size);
  }
  private setInkSize(size: number) {
    if (this.tool === 'pen') {
      this.penStyle = { ...this.penStyle, size };
      this.callbacks.penSize?.(size);
    } else {
      this.highlightStyle = { ...this.highlightStyle, size };
      this.callbacks.highlightSize?.(size);
    }
  }
  private pointer: Point | null = null;
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
  private input: InputPreferences = { wheel: 'zoom', zoomSpeed: 'normal', snapping: true };
  private readOnly = false;
  private hoverConnector: ConnectorSide | null = null;
  private views = new Map<string, { container: Container; signature: string; sharpness: string }>();
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
  // Touch (docs/android.md): fingers on the board, a two-finger pinch, and the
  // long-press / double-tap timing. Mouse and pen never touch these.
  private touches = new Map<number, Point>();
  private pinch: { distance: number; mid: Point; camera: Camera } | null = null;
  private touchInput = false;
  private longPress = 0;
  private longPressOpened = 0;
  // The selection before the current finger came down; holding an object adds to it.
  private touchSelectionBefore: string[] = [];
  private lastTap: { at: number; point: Point } | null = null;
  // Finger gestures are on only in the Android app for now; desktop
  // touchscreens keep their mouse-like behaviour until tested there.
  private touchGestures = false;
  setTouchGestures(on: boolean) {
    this.touchGestures = on;
  }
  private isTouch(e: PointerEvent) {
    return this.touchGestures && e.pointerType === 'touch';
  }
  private cropPreview: CanvasObject | null = null;
  // Spoilers this viewer has revealed, by object and region start. Local only:
  // never saved, synced or exported.
  private spoilers = new Map<string, Map<number, { revealed: boolean; at: number }>>();
  private dustViews: { id: string; layer: Container }[] = [];
  // Spoiler frames on screen that still hide their contents, from the last draw.
  private coveringFrames: CanvasObject[] = [];
  private lastObjectReveal = -Infinity;
  private dustFrame = 0;
  private dustDrawn = 0;
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
    host.addEventListener('pointercancel', this.pointerCancel);
    host.addEventListener('pointerleave', this.leave);
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
  // The board area the window shows with a camera, in board units.
  visibleArea(camera: Camera = this.camera) {
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    if (!width || !height) return undefined;
    const p = screenToWorld({ x: 0, y: 0 }, camera);
    return { x: p.x, y: p.y, width: width / camera.zoom, height: height / camera.zoom };
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
  /** Selection as copied or duplicated: frames bring their contents along. */
  get copySelection() {
    return copySelection(this.all, this.clipboardSelection);
  }
  get selectionLocked() {
    const selected = this.selected;
    return (
      selected.some((o) => o.locked) ||
      (selected.some((o) => o.type === 'frame') &&
        stackingSelection(this.all, selected).some((o) => o.locked))
    );
  }
  setSelectionLocked(locked: boolean) {
    this.cancel();
    const upserts = stackingSelection(this.all, this.selected)
      .filter((o) => !!o.locked !== locked)
      .map((o) => ({ ...o, locked }));
    // Lock state is independent of undo: only the hold control can release it.
    for (const o of upserts) this.preview(o);
    if (upserts.length) this.callbacks.edit({ upserts, deleted: [] });
    this.callbacks.selection(this.selected);
    this.invalidate();
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
  // The album card under a board point that can take more images.
  albumAt(point: Point) {
    const o = this.hit(this.screenPoint(point));
    return o?.type === 'image' && o.album && !o.locked ? o.id : null;
  }
  galleryImageAt(point: Point) {
    const o = this.hit(this.screenPoint(point));
    return o?.type === 'image' && o.galleryId && !o.locked && !this.objects.get(o.galleryId)?.locked
      ? o.id
      : null;
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
  private hit(p: Point, ink = true) {
    return this.index
      .search({
        x: p.x - 8 / this.camera.zoom,
        y: p.y - 8 / this.camera.zoom,
        width: 16 / this.camera.zoom,
        height: 16 / this.camera.zoom,
      })
      .sort((a, b) => b.z - a.z)
      .find((o) => {
        if (this.coveringFrames.length && concealedBy(o, this.coveringFrames)) return false;
        const q = worldToLocal(o, p);
        if (o.type === 'highlight') return ink && hitsHighlight(o, q, 2 / this.camera.zoom);
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
        // A frame is grabbed by its edges; a finger needs them wider than a mouse does.
        const edge = this.touchInput ? Math.max(10, 20 / this.camera.zoom) : 10;
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
          !!o.frameLink ||
          q.x < edge ||
          q.x > o.width - edge ||
          q.y < Math.max(32, edge) ||
          q.y > o.height - edge ||
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
  // HTML embeds whose running page shows through the board in place of their
  // picture (the board draws a see-through hole and the border).
  private liveEmbeds = new Set<string>();
  setLiveEmbeds(ids: Iterable<string>) {
    const next = new Set(ids);
    if (next.size === this.liveEmbeds.size && [...next].every((id) => this.liveEmbeds.has(id)))
      return;
    this.liveEmbeds = next;
    this.invalidate();
  }
  /** A wheel turned over a running web page that the page did not scroll. */
  relayWheel(init: WheelEventInit) {
    this.app.canvas.dispatchEvent(
      new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true }),
    );
  }
  /**
   * A press on a running web page that the page did not take: the board
   * drags, pans, selects or opens its menu as it does over the canvas. Points
   * are client pixels of the board's window.
   */
  relayPointer(
    phase: 'start' | 'move' | 'end' | 'cancel',
    button: number,
    clientX: number,
    clientY: number,
    keys: Pick<PointerEventInit, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> = {},
  ) {
    const event = (type: string, buttons: number) =>
      new PointerEvent(type, {
        ...keys,
        clientX,
        clientY,
        button,
        buttons,
        pointerType: 'mouse',
        isPrimary: true,
        cancelable: true,
      });
    const mask = [1, 4, 2][button] ?? 0;
    if (phase === 'start') {
      if (!this.gesture) this.down(event('pointerdown', mask), true);
    } else if (!this.gesture) return;
    else if (phase === 'move') this.move(event('pointermove', mask));
    else if (phase === 'end') this.up(event('pointerup', 0));
    else this.cancel();
  }
  get canOpenQuickTools() {
    return !this.gesture && !this.editingId;
  }
  private beginArrow(w: Point, p: Point, selectDraft = true) {
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
    this.setSelection(selectDraft ? [draft.id] : []);
    this.gesture = {
      mode: 'drawArrow',
      start: p,
      world: w,
      camera: { ...this.camera },
      original: [],
      arrowDraft: draft,
      arrowPointer: p,
    };
  }
  private updateArrowPreview(shift: boolean, ctrl: boolean, alt = false) {
    const g = this.gesture;
    if (!g?.arrowPointer || (g.mode !== 'drawArrow' && g.mode !== 'arrowPoint')) return;
    const end = this.screenPoint(g.arrowPointer);
    const index = g.arrowIndex ?? 1;
    const anchor = g.mode === 'drawArrow' ? g.world : g.arrowPoints![index === 0 ? 1 : index - 1];
    if (ctrl) end.x = anchor.x;
    else if (shift) end.y = anchor.y;
    const find = (id: string) => this.objects.get(id),
      // An arc made to get around objects is redrawn as its end moves.
      autoBends = g.mode === 'arrowPoint' && !!g.connectEnd && hasAutoBends(g.original[0], find),
      facing = autoBends ? g.arrowPoints![index === 0 ? g.arrowPoints!.length - 1 : 0] : anchor;
    let target: CanvasObject | undefined;
    if (g.connectFrom || (g.connectEnd && !alt)) {
      // Over another object, the arrow lands on the side under the pointer.
      const pointer = this.screenPoint(g.arrowPointer);
      target = this.connectTargetAt(pointer, g);
      if (target)
        Object.assign(
          end,
          connectionPoint(
            target,
            dropSide(target, pointer, facing),
            pointer,
            48 / this.camera.zoom,
          ),
        );
    }
    g.connectTarget = target?.id;
    if (g.mode === 'drawArrow') {
      let draft = arrowFromPoints(g.arrowDraft!, [anchor, end]);
      const source = g.connectFrom && this.objects.get(g.connectFrom.id);
      // An arrow from a side dot holds that spot, and the object it lands on,
      // and bends around them when a straight line would cut through one.
      if (source) {
        const { from: _from, to: _to, ...style } = draft.arrow!;
        draft.arrow = {
          ...style,
          from: arrowEnd(source, anchor),
          ...(target ? { to: arrowEnd(target, end) } : {}),
        };
        draft = arrowFromPoints(draft, routedPoints(draft, anchor, end, find));
      }
      this.preview(draft);
    } else {
      let points = g.arrowPoints!.map((p) => ({ ...p }));
      points[index] = end;
      const before = g.original[0],
        original = arrowPoints(before).map((p) => localToWorld(before, p));
      let next = arrowFromPoints(before, points);
      if (g.connectEnd) {
        const { [g.connectEnd]: _end, ...style } = next.arrow!;
        next = {
          ...next,
          arrow: { ...style, ...(target ? { [g.connectEnd]: arrowEnd(target, end) } : {}) },
        };
        if (autoBends) {
          points = routedPoints(next, points[0], points[points.length - 1], find);
          next = arrowFromPoints(next, points);
        }
      }
      const was = before.arrow?.[g.connectEnd ?? 'from'],
        now = next.arrow?.[g.connectEnd ?? 'from'];
      g.changed =
        points.length !== original.length ||
        points.some((p, i) => Math.hypot(p.x - original[i].x, p.y - original[i].y) > 1e-8) ||
        was?.id !== now?.id;
      this.preview(next);
    }
    this.invalidate();
  }
  beginQuickArrow(anchor: Point, pointer: Point) {
    this.cancel();
    this.stopCameraAnimation();
    this.setTool('arrow');
    this.callbacks.tool?.('arrow');
    this.beginArrow(anchor, pointer, false);
    this.gesture!.clickToPlace = true;
    this.preview(arrowFromPoints(this.gesture!.arrowDraft!, [anchor, this.screenPoint(pointer)]));
    this.invalidate();
  }
  private connectorAt(p: Point): ConnectorSide | undefined {
    if (
      this.readOnly ||
      this.tool !== 'select' ||
      this.selection.size !== 1 ||
      this.selectionLocked ||
      this.editingId ||
      this.cropPreview
    )
      return;
    const o = this.selected[0];
    if (!canConnect(o)) return;
    const c = this.camera,
      top = hasExternalLabel(o) ? frameLabel(o, c.zoom).top : 0;
    return connectorSides.find((side) => {
      const q = connectorDot(o, side, c.zoom, top);
      return Math.hypot(p.x - q.x * c.zoom - c.x, p.y - q.y * c.zoom - c.y) < 10;
    });
  }
  /** The object an arrow end at world point `w` connects to: not frames, nor the source. */
  private connectTargetAt(w: Point, g: Gesture) {
    const pad = 4 / this.camera.zoom;
    return this.index
      .search({ x: w.x - pad, y: w.y - pad, width: pad * 2, height: pad * 2 })
      .filter((o) => {
        if (o.id === g.connectFrom?.id || o.id === g.arrowDraft?.id) return false;
        if (g.connectEnd) {
          const other = g.original[0]?.arrow?.[g.connectEnd === 'from' ? 'to' : 'from'];
          if (o.id === other?.id) return false;
        }
        if (!canConnect(o) || o.type === 'frame') return false;
        if (this.coveringFrames.length && concealedBy(o, this.coveringFrames)) return false;
        const q = worldToLocal(o, w);
        return q.x >= -pad && q.y >= -pad && q.x <= o.width + pad && q.y <= o.height + pad;
      })
      .sort((a, b) => b.z - a.z)[0];
  }
  private beginConnection(side: ConnectorSide, p: Point) {
    const o = this.selected[0];
    this.hoverConnector = null;
    this.beginArrow(sidePoint(o, side), p, false);
    const g = this.gesture!;
    g.connectFrom = { id: o.id, side };
    this.preview(arrowFromPoints(g.arrowDraft!, [g.world, this.screenPoint(p)]));
    this.invalidate();
  }
  private down = (e: PointerEvent, overlay = false) => {
    this.touchInput = this.isTouch(e);
    if (this.touchInput && (overlay || e.target === this.app.canvas)) {
      this.touches.set(e.pointerId, this.point(e));
      this.clearLongPress();
      if (this.touches.size === 1) this.touchSelectionBefore = [...this.selection];
      if (this.touches.size >= 2 || this.pinch) {
        e.preventDefault();
        if (!this.pinch) this.startPinch();
        this.capturePointer(e);
        return;
      }
    }
    if (this.gesture?.clickToPlace) {
      e.preventDefault();
      if (e.button === 0) {
        this.move(e);
        this.gesture.clickToPlace = false;
        this.up(e);
      } else if (e.button === 2) {
        this.secondaryContextHandled = true;
        this.cancel();
      }
      return;
    }
    if ((!overlay && e.target !== this.app.canvas) || e.button > 2 || this.gesture) return;
    e.preventDefault();
    this.stopCameraAnimation();
    this.host.focus();
    const p = this.point(e),
      w = this.screenPoint(p);
    this.secondaryContextHandled = e.button === 2;
    this.pointer = p;
    if (
      e.button === 0 &&
      !this.space &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      (this.tool === 'hand' ||
        (this.tool === 'select' && !this.resizeCorner(p) && !this.connectorAt(p)))
    ) {
      // Peeking at a spoiler neither selects nor drags.
      const spoiler = this.spoilerAt(w);
      if (spoiler) {
        this.toggleSpoiler(spoiler.id, spoiler.start);
        return;
      }
      // Nor does the second press of a double-click that revealed an object.
      if (performance.now() - this.lastObjectReveal < 400) return;
    }
    if ((this.viewOnly || this.readOnly) && e.button === 0 && !this.space) {
      this.gesture = {
        mode: 'pan',
        start: p,
        world: w,
        camera: { ...this.camera },
        original: [],
        view: true,
        viewTarget: this.hit(w),
      };
      this.updateCursor();
      this.capturePointer(e);
      return;
    }
    if (this.inkTool && e.button === 2 && !this.space && !this.hit(w)) {
      // Right-drag on empty canvas sizes the marker: left shrinks it, right grows it.
      this.gesture = {
        mode: 'highlightSize',
        start: p,
        world: w,
        camera: { ...this.camera },
        original: [],
        secondary: true,
        highlightSize: this.inkStyle.size,
      };
    } else if (this.space || this.tool === 'hand' || e.button === 1 || e.button === 2) {
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
      this.beginArrow(w, p);
    } else if (this.inkTool) {
      const style = this.inkStyle;
      const draft = highlightFromPoints(
        {
          id: uid(),
          type: 'highlight',
          x: w.x,
          y: w.y,
          width: 1,
          height: 1,
          z: this.topZ() + 1,
          color: style.color,
          highlight: {
            points: [],
            size: style.size / this.camera.zoom,
            ...(this.tool === 'pen' ? { pen: true } : {}),
          },
        },
        [w],
      );
      this.setSelection([]);
      this.preview(draft);
      this.gesture = {
        mode: 'drawHighlight',
        start: p,
        world: w,
        camera: { ...this.camera },
        original: [],
        highlightDraft: draft,
        highlightPath: [w],
      };
    } else if (this.tool !== 'select') {
      this.callbacks.create(this.tool, w);
      return;
    } else {
      const bounds = boundsOf(this.selected),
        additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const resize = !e.ctrlKey && !e.metaKey && this.resizeCorner(p);
      const arrowHandle = !e.metaKey && this.arrowHandle(p);
      const connector = !additive && e.button === 0 && this.connectorAt(p);
      if (connector) {
        this.beginConnection(connector, p);
        this.capturePointer(e);
        return;
      } else if (arrowHandle) {
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
          arrowPointer: p,
          // An end of an arrow that holds an object can move to another one.
          connectEnd:
            arrowHandle.insert || !(o.arrow?.from || o.arrow?.to)
              ? undefined
              : arrowHandle.index === 0
                ? 'from'
                : arrowHandle.index === points.length - 1
                  ? 'to'
                  : undefined,
        };
        if (e.shiftKey || e.ctrlKey) this.updateArrowPreview(e.shiftKey, e.ctrlKey, e.altKey);
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
        // A locked object lets presses through: it is not selected or dragged by a
        // click or a finger, only by holding it for two seconds (touchContext).
        const found = this.hit(w);
        const hit = found?.locked ? undefined : found;
        const lockedTarget = found?.locked ? found : undefined;
        if (hit) {
          const ids = this.members(hit);
          const editOnClick =
            !additive &&
            !hit.frameLink &&
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
          if (this.selectionLocked) return;
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
          !this.selectionLocked &&
          ((this.selection.size > 1 &&
            bounds &&
            w.x >= bounds.x &&
            w.x <= bounds.x + bounds.width &&
            w.y >= bounds.y &&
            w.y <= bounds.y + bounds.height) ||
            // A selected frame drags from its empty interior too.
            this.selection.has(this.frameAt(w)?.id ?? ''))
        ) {
          this.gesture = {
            mode: 'move',
            start: p,
            world: w,
            camera: { ...this.camera },
            original: this.moveObjects(),
          };
        } else if (this.touchInput) {
          // A finger on empty board pans; a tap there clears the selection (on release,
          // so panning keeps a selection built up by holding).
          this.gesture = {
            mode: 'pan',
            start: p,
            world: w,
            camera: { ...this.camera },
            original: [],
            tapClears: true,
            lockedTarget,
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
            lockedTarget,
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
    this.capturePointer(e);
    const lockedTarget = this.gesture?.lockedTarget;
    if (this.gesture && !this.inkTool && (this.touchInput || lockedTarget)) {
      const at = { x: e.clientX, y: e.clientY };
      this.longPress = window.setTimeout(() => this.touchContext(at), lockedTarget ? 2000 : 550);
    }
  };
  private clearLongPress() {
    if (!this.longPress) return;
    window.clearTimeout(this.longPress);
    this.longPress = 0;
  }
  // Long-press. With the Select tool it selects, as a phone's board should: held on
  // empty board it starts a selection box (drag it out; lifting without dragging opens
  // the board menu), held on an object it adds that object to the selection (or takes
  // it out again). Elsewhere: the context menu where a right-click would open it.
  private touchContext(at: { x: number; y: number }) {
    this.longPress = 0;
    if (this.pinch || (this.touchInput && this.touches.size !== 1)) return;
    if (this.viewOnly || this.readOnly) return;
    const g = this.gesture;
    // Held on a locked object for two seconds: it is selected, so it can be unlocked.
    if (g?.lockedTarget) {
      const locked = g.lockedTarget;
      globalThis.navigator?.vibrate?.(20);
      this.longPressOpened = performance.now();
      this.cancel();
      this.setSelection(this.members(locked));
      this.invalidate();
      return;
    }
    if (this.tool === 'select' && g && ((g.mode === 'pan' && g.tapClears) || g.mode === 'move')) {
      globalThis.navigator?.vibrate?.(20);
      this.longPressOpened = performance.now();
      if (g.mode === 'pan') {
        this.camera = { ...g.camera };
        this.gesture = {
          mode: 'box',
          start: g.start,
          world: g.world,
          camera: { ...g.camera },
          original: this.selected,
          holdAt: at,
        };
        this.invalidate();
        return;
      }
      const hit = this.hit(g.world);
      this.cancel();
      if (!hit) return;
      const ids = this.members(hit),
        before = this.touchSelectionBefore.filter((id) => this.objects.has(id)),
        next = new Set(before);
      const remove = ids.every((id) => next.has(id)) && before.length > ids.length;
      for (const id of ids) remove ? next.delete(id) : next.add(id);
      this.setSelection([...next]);
      this.invalidate();
      return;
    }
    this.cancel();
    this.longPressOpened = performance.now();
    this.openContext(new MouseEvent('contextmenu', { clientX: at.x, clientY: at.y }));
  }
  private startPinch() {
    this.clearLongPress();
    const g = this.gesture;
    // A pan hands its camera to the pinch; anything else the first finger
    // began (a stroke, a drag, a selection box) is undone.
    if (g?.mode === 'pan') {
      this.gesture = null;
      this.updateCursor();
    } else if (g) this.cancel();
    this.stopCameraAnimation();
    const [a, b] = [...this.touches.values()];
    this.pinch = {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      camera: { ...this.camera },
    };
  }
  private movePinch() {
    const pinch = this.pinch!;
    const [a, b] = [...this.touches.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ratio = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) / pinch.distance;
    const panned = {
      ...pinch.camera,
      x: pinch.camera.x + mid.x - pinch.mid.x,
      y: pinch.camera.y + mid.y - pinch.mid.y,
    };
    this.camera = zoomAt(panned, mid, pinch.camera.zoom * ratio);
    this.invalidate();
  }
  // Lifting a finger: a pinch ends once fewer than two remain; the last finger
  // does nothing until it lifts too. Returns whether the event is handled.
  private releaseTouch(e: PointerEvent) {
    if (!this.isTouch(e) || !this.touches.delete(e.pointerId)) return false;
    this.clearLongPress();
    if (!this.pinch) return false;
    if (this.touches.size < 2) {
      this.pinch = null;
      this.callbacks.camera({ ...this.camera });
    }
    return true;
  }
  private pointerCancel = (e: PointerEvent) => {
    if (this.releaseTouch(e)) return;
    this.cancel();
  };
  // Presses relayed from a web page have no live pointer to capture.
  private capturePointer(e: PointerEvent) {
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {}
  }
  private move = (e: PointerEvent) => {
    if (this.isTouch(e) && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.point(e));
      if (this.pinch) {
        if (this.touches.size >= 2) this.movePinch();
        return;
      }
      if (this.longPress && this.gesture) {
        const p = this.point(e);
        if (Math.hypot(p.x - this.gesture.start.x, p.y - this.gesture.start.y) > 8)
          this.clearLongPress();
      }
    } else if (!this.isTouch(e)) this.touchInput = false;
    const g = this.gesture;
    if (this.inkTool) {
      this.pointer = e.target === this.app.canvas || g ? this.point(e) : null;
      this.invalidate();
    }
    if (!g) {
      const hovered =
        this.tool === 'select' && !this.space && e.target === this.app.canvas
          ? this.hit(this.screenPoint(this.point(e)))
          : undefined;
      this.callbacks.hover?.(
        hovered?.type === 'image' && (hovered.galleryId || hovered.album) ? hovered.id : null,
      );
      // While the canvas lets the pointer through to a page under it, moves
      // the page has not taken yet reach the host; they are still on the board.
      // Moves addressed to a page's own frame (the browser sends some as the
      // pointer enters it) belong to the page, and say nothing about the board.
      const over =
        e.target === this.host && this.tool === 'select' && !this.space
          ? this.hit(this.screenPoint(this.point(e)))
          : hovered;
      if (e.target === this.app.canvas || e.target === this.host)
        this.callbacks.hoverObject?.(over || null, over ? this.screenPoint(this.point(e)) : null);
      this.updateCursor(
        e.target === this.app.canvas ? this.resizeCorner(this.point(e)) : undefined,
      );
      if (
        !this.space &&
        (this.tool === 'select' || this.tool === 'hand') &&
        e.target === this.app.canvas &&
        this.spoilerAt(this.screenPoint(this.point(e)))
      )
        this.host.style.cursor = 'pointer';
      if (
        !this.space &&
        this.tool === 'select' &&
        e.target === this.app.canvas &&
        this.arrowHandle(this.point(e))
      )
        this.host.style.cursor = 'move';
      const connector =
        (!this.space && e.target === this.app.canvas && this.connectorAt(this.point(e))) || null;
      if (connector) this.host.style.cursor = 'crosshair';
      if (connector !== this.hoverConnector) {
        this.hoverConnector = connector;
        this.invalidate();
      }
      return;
    }
    this.callbacks.hover?.(null);
    this.callbacks.hoverObject?.(null, null);
    const p = this.point(e),
      dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    if (this.longPress && Math.hypot(dx, dy) > 8) this.clearLongPress();
    const moved = Math.abs(dx) + Math.abs(dy) > 2;
    g.dragged ||= moved;
    g.changed = g.secondary ? g.changed || moved : moved;
    if (g.mode === 'highlightSize') {
      if (!g.changed) return;
      // The ring's edge follows the pointer: every pixel changes the radius by one.
      // The pen's sizes are small, so it grows more slowly.
      const size = this.clampInk(g.highlightSize! + dx * (this.tool === 'pen' ? 0.25 : 2));
      if (size !== this.inkStyle.size) this.setInkSize(size);
      this.invalidate();
    } else if (g.mode === 'drawHighlight') {
      const path = g.highlightPath!,
        w = this.screenPoint(p),
        last = path.at(-1)!;
      // Shift rules a straight line, the way one marks a line of text.
      if (e.shiftKey) path.splice(1, Infinity, w);
      else if (Math.hypot(w.x - last.x, w.y - last.y) * this.camera.zoom >= 1.5) path.push(w);
      this.preview(highlightFromPoints(g.highlightDraft!, path));
      this.invalidate();
    } else if (g.mode === 'drawArrow' || g.mode === 'arrowPoint') {
      g.arrowPointer = p;
      this.updateArrowPreview(e.shiftKey, e.ctrlKey, e.altKey);
      if (g.mode === 'arrowPoint') this.emitLive(g);
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
          e.altKey || !moved || !this.input.snapping,
        );
        delta = result.delta;
        g.snap.state = result.state;
        this.snapGuides = result.guides;
      }
      const moving = new Set(g.original.map((o) => o.id));
      for (const o of g.original)
        this.preview(
          keepArrowEnds({ ...o, x: o.x + delta.x, y: o.y + delta.y }, (id) => moving.has(id)),
        );
      this.followHeld(g);
      this.emitLive(g);
      this.callbacks.objectDrag?.(g.original, moved ? this.screenPoint(p) : null);
      this.invalidate();
    } else if (g.mode === 'rotate') {
      const o = g.original[0];
      this.preview({
        ...o,
        rotation: rotationFromDrag(o, g.world, this.screenPoint(p), e.shiftKey),
      });
      this.followHeld(g);
      this.emitLive(g);
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
          e.altKey || !moved || !this.input.snapping,
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
      this.followHeld(g);
      this.emitLive(g);
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
    try {
      this.finishGesture(e);
    } finally {
      if (!this.gesture) this.endLive();
    }
  };
  private finishGesture(e: PointerEvent) {
    if (this.releaseTouch(e)) return;
    this.clearLongPress();
    const g = this.gesture;
    if (!g || g.clickToPlace) return;
    if (this.isTouch(e) && !g.dragged && !g.holdAt && this.doubleTap(e)) {
      this.gesture = null;
      for (const o of g.original) this.preview(o);
      this.invalidate();
      return;
    }
    if ((g.mode === 'drawArrow' || g.mode === 'arrowPoint') && g.changed) {
      g.arrowPointer = this.point(e);
      this.updateArrowPreview(e.shiftKey, e.ctrlKey, e.altKey);
    }
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
      this.restoreHeld(g);
      this.callbacks.selection(this.selected);
      this.invalidate();
      return;
    }
    if (g.mode === 'highlightSize') {
      if (!g.changed) this.openContext(e);
    } else if (g.mode === 'drawHighlight') {
      // Handwriting keeps finer detail than a marker sweep.
      const tolerance = (isPen(g.highlightDraft!) ? 0.35 : 0.75) / this.camera.zoom;
      const o = highlightFromPoints(g.highlightDraft!, simplifyStroke(g.highlightPath!, tolerance));
      this.preview(o);
      this.history.push({ upserts: [o], deleted: [] }, { upserts: [], deleted: [o.id] });
      this.callbacks.edit({ upserts: [o], deleted: [] });
    } else if (
      g.mode === 'drawArrow' &&
      g.connectFrom &&
      !g.connectTarget &&
      Math.hypot(this.point(e).x - g.start.x, this.point(e).y - g.start.y) < 12
    ) {
      // A click (or a twitch) on a side dot creates nothing.
      this.objects.delete(g.arrowDraft!.id);
      this.index.remove(g.arrowDraft!.id);
      this.setSelection([g.connectFrom.id]);
    } else if (g.mode === 'drawArrow') {
      const o = this.objects.get(g.arrowDraft!.id)!;
      this.history.push({ upserts: [o], deleted: [] }, { upserts: [], deleted: [o.id] });
      this.callbacks.edit({ upserts: [o], deleted: [] });
      this.setSelection([o.id]);
      this.setTool('select');
      this.callbacks.tool?.('select');
    } else if (g.secondary && !g.changed) this.openContext(e);
    else if (g.mode === 'pan' && g.view) {
      this.callbacks.camera({ ...this.camera });
      if (!g.dragged) this.callbacks.viewTap?.(g.viewTarget ?? null);
    } else if (g.mode === 'pan') {
      this.callbacks.camera({ ...this.camera });
      // A tap inside a frame selects the frame, so a finger can then drag it; elsewhere a
      // tap clears the selection.
      if (g.tapClears && !g.dragged) {
        const frame = this.frameAt(g.world);
        this.setSelection(frame ? this.members(frame) : []);
      }
    } else if (g.holdAt && (!g.box || (g.box.width + g.box.height) * this.camera.zoom < 12)) {
      // Held on empty board and lifted without dragging: the board's menu, as before.
      this.longPressOpened = performance.now();
      this.openContext(new MouseEvent('contextmenu', { clientX: g.holdAt.x, clientY: g.holdAt.y }));
    } else if (g.mode === 'box' && g.box) {
      const next = new Set(g.original.map((o) => o.id));
      const hits = new Set(
        this.index
          .search(g.box)
          .filter((o) => {
            // Locked objects stay out of a selection box; holding one selects it.
            if (o.locked) return false;
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
      const held = [...(g.held?.values() ?? [])],
        after = g.original.map((o) => this.objects.get(o.id)!);
      if (g.original.some((o) => o.gallery || o.galleryId)) {
        for (const o of g.original) this.preview(o);
        this.restoreHeld(g);
        this.apply({ upserts: after, deleted: [] });
      } else {
        after.push(...held.map((o) => this.objects.get(o.id)!));
        this.history.push(
          { upserts: after, deleted: [] },
          { upserts: [...g.original, ...held], deleted: [] },
        );
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
      this.restoreHeld(g);
      if (g.editOnClick && !g.dragged) {
        const object = this.objects.get(g.editOnClick);
        if (object) this.callbacks.activate(object, object.type === 'image' ? 'title' : undefined);
      }
    }
    this.invalidate();
  }
  private cancel = () => {
    this.clearLongPress();
    this.callbacks.objectDrag?.([], null);
    this.endLive();
    const g = this.gesture;
    this.snapGuides = [];
    this.gesture = null;
    this.updateCursor();
    if (g) {
      if (g.mode === 'drawArrow') {
        this.objects.delete(g.arrowDraft!.id);
        this.index.remove(g.arrowDraft!.id);
        this.setSelection(g.connectFrom ? [g.connectFrom.id] : []);
      }
      if (g.mode === 'drawHighlight') {
        this.objects.delete(g.highlightDraft!.id);
        this.index.remove(g.highlightDraft!.id);
      }
      if (g.mode === 'highlightSize' && g.highlightSize !== this.inkStyle.size)
        this.setInkSize(g.highlightSize!);
      for (const o of g.original) this.preview(o);
      this.restoreHeld(g);
      if (g.mode === 'pan') this.camera = g.camera;
      if (g.clickToPlace) {
        this.setTool('select');
        this.callbacks.tool?.('select');
      }
      this.invalidate();
    }
  };
  private leave = () => {
    if (!this.pointer || this.gesture) return;
    this.pointer = null;
    this.invalidate();
  };
  private blur = () => {
    this.stopCameraAnimation();
    this.space = false;
    this.cancel();
  };
  setInputPreferences(input: InputPreferences) {
    this.input = { ...input };
  }
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
    if (this.gesture || !Number.isFinite(e.deltaY)) return;
    const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.host.clientHeight : 1;
    if (this.input.wheel === 'pan' && !e.ctrlKey && !e.metaKey) {
      // Pinch gestures arrive as Ctrl+wheel and keep zooming in pan mode.
      let dx = (Number.isFinite(e.deltaX) ? e.deltaX : 0) * units,
        dy = e.deltaY * units;
      if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
      if (!dx && !dy) return;
      this.stopCameraAnimation();
      this.camera = { ...this.camera, x: this.camera.x - dx, y: this.camera.y - dy };
      this.callbacks.camera({ ...this.camera });
      this.invalidate();
      return;
    }
    if (!e.deltaY) return;
    const delta = Math.max(-100, Math.min(100, e.deltaY * units));
    const point = this.point(e);
    const pending = this.wheelZoom;
    // Reversing the wheel discards remaining motion in the old direction.
    const base =
      pending && Math.sign(Math.log(pending.target / this.camera.zoom)) === -Math.sign(delta)
        ? pending.target
        : this.camera.zoom;
    const target = zoomAt(
      this.camera,
      point,
      base * Math.exp(-delta * zoomRates[this.input.zoomSpeed]),
    ).zoom;
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
    // View mode: the board takes no editing keys (selection, delete, tools, clipboard).
    if (this.viewOnly) return;
    if (this.gesture?.arrowPointer && ['Shift', 'Control', 'Alt'].includes(e.key)) {
      this.updateArrowPreview(e.shiftKey, e.ctrlKey, e.altKey);
      return;
    }
    if (e.key === 'Escape' && this.gesture) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancel();
      return;
    }
    if (this.gesture?.clickToPlace) {
      const command = activeCommand(e, 'board');
      const clipboard = (e.ctrlKey || e.metaKey) && !e.altKey && ['KeyC', 'KeyX'].includes(e.code);
      if (
        clipboard ||
        e.key === 'Delete' ||
        e.key === 'Backspace' ||
        (command && placementBlocked.has(command))
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // A floating preview is not yet a board object. Undo/Delete cancel it;
        // clipboard and selection commands must not publish or transform it.
        if (
          e.key === 'Delete' ||
          e.key === 'Backspace' ||
          command === 'edit.undo' ||
          command === 'edit.delete'
        )
          this.cancel();
        return;
      }
    }
    if (e.code === 'Space') {
      e.preventDefault();
      this.space = true;
      this.updateCursor();
    }
  };
  private keyUp = (e: KeyboardEvent) => {
    if (['Shift', 'Control', 'Alt'].includes(e.key))
      this.updateArrowPreview(e.shiftKey, e.ctrlKey, e.altKey);
    if (e.code === 'Space') {
      this.space = false;
      this.updateCursor();
    }
  };
  // Two taps close together act as a double-click. Chromium's own dblclick
  // from taps is ignored (doubleClick) so this runs once.
  private doubleTap(e: PointerEvent) {
    const point = this.point(e),
      now = performance.now(),
      last = this.lastTap;
    this.lastTap = { at: now, point };
    if (
      !last ||
      now - last.at > 350 ||
      Math.hypot(point.x - last.point.x, point.y - last.point.y) > 24
    )
      return false;
    this.lastTap = null;
    this.doubleClick(e, true);
    return true;
  }
  private doubleClick = (e: MouseEvent, tap = false) => {
    const source = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
      .sourceCapabilities;
    if (!tap && this.touchGestures && (source?.firesTouchEvents || this.touchInput)) return;
    if (this.editingId || this.readOnly || this.viewOnly) return;
    if (performance.now() - this.lastObjectReveal < 600) return;
    // Pointer capture on the surface retargets Chromium's subsequent click /
    // dblclick to that surface, even when both presses began on the canvas.
    if (!tap && e.target !== this.app.canvas && e.target !== this.host) return;
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
    // Ink lies over what it marks; a double click reaches the object underneath.
    const o = this.hit(world, false);
    if (o?.locked && !o.frameLink) return;
    if (o)
      this.callbacks.activate(
        o,
        o.type === 'image' && hitsFrameLabel(o, worldToLocal(o, world), this.camera.zoom)
          ? 'title'
          : undefined,
      );
    else {
      // A frame's empty interior is not a hit target, but a double click there
      // means the frame itself. Empty board does nothing; text comes from the tool.
      const frame = this.frameAt(world);
      if (frame) this.setSelection(this.members(frame));
    }
  };
  frameAt(p: Point) {
    return this.index
      .search({ x: p.x, y: p.y, width: 0, height: 0 })
      .filter((o) => {
        if (o.type !== 'frame') return false;
        if (this.coveringFrames.length && concealedBy(o, this.coveringFrames)) return false;
        const q = worldToLocal(o, p);
        return q.x >= 0 && q.y >= 0 && q.x <= o.width && q.y <= o.height;
      })
      .sort((a, b) => b.z - a.z)[0];
  }
  private context = (e: MouseEvent) => {
    if (e.target !== this.app.canvas && e.target !== this.host) return;
    e.preventDefault();
    // Touch opens its own menu on long-press (touchContext).
    if (this.touchInput || performance.now() - this.longPressOpened < 1000) return;
    // Windows emits contextmenu after release; other platforms emit it on press.
    // Right-button gestures own the menu decision until the next pointer press.
    if (this.gesture?.secondary || (e.button === 2 && this.secondaryContextHandled)) return;
    this.openContext(e);
  };
  private openContext(e: MouseEvent) {
    if (this.viewOnly) return;
    const p = this.point(e),
      o = this.hit(this.screenPoint(p));
    if (o && !this.selection.has(o.id)) this.setSelection(this.members(o));
    this.callbacks.context({ x: e.clientX, y: e.clientY });
  }
  // View mode: the board can be looked at, panned and zoomed, and its embeds, links and
  // pictures used, but nothing is selected, moved or edited.
  private viewOnly = false;
  get viewMode() {
    return this.viewOnly;
  }
  setViewMode(on: boolean) {
    if (this.viewOnly === on) return;
    this.viewOnly = on;
    this.cancel();
    this.setSelection([]);
    this.updateCursor();
    this.invalidate();
  }
  // Visitors without edit rights can only pan, zoom and look.
  setReadOnly(readOnly: boolean) {
    this.readOnly = readOnly;
    if (readOnly) {
      this.cancel();
      this.setSelection([]);
      this.setTool('hand');
    }
  }
  setTool(tool: Tool) {
    if (this.gesture?.clickToPlace) this.cancel();
    this.tool = this.readOnly ? 'hand' : tool;
    this.pointer = null;
    this.updateCursor();
    this.invalidate();
  }
  setHighlightStyle(style: { color: string; size: number }) {
    this.highlightStyle = { color: style.color, size: clampHighlightSize(style.size) };
    this.invalidate();
  }
  setPenStyle(style: { color: string; size: number }) {
    this.penStyle = { color: style.color, size: clampPenSize(style.size) };
    this.invalidate();
  }
  private spoilerAt(w: Point) {
    const hit = this.hit(w, false);
    const inside = (o: CanvasObject) => {
      const q = worldToLocal(o, w);
      return q.x >= 0 && q.y >= 0 && q.x <= o.width && q.y <= o.height;
    };
    // Hidden whole objects reveal on a click anywhere on their body; a
    // frame's title still selects it so it can be moved while hidden.
    if (
      hit &&
      hit.id !== this.editingId &&
      isSpoiler(hit) &&
      !this.spoilerRevealed(hit.id, wholeObject) &&
      inside(hit)
    )
      return { id: hit.id, start: wholeObject };
    const frame = this.coveringFrames
      .filter((f) => !this.spoilerRevealed(f.id, wholeObject) && inside(f))
      .sort((a, b) => b.z - a.z)[0];
    if (frame && (!hit || hit.z <= frame.z)) return { id: frame.id, start: wholeObject };
    if (!hit || hit.id === this.editingId || !hasRichText(hit)) return null;
    const q = worldToLocal(hit, w);
    const box = textSpoilers(hit, shownText(hit), this.camera.zoom).find(
      (b) => q.x >= b.x && q.x <= b.x + b.width && q.y >= b.y && q.y <= b.y + b.height,
    );
    return box ? { id: hit.id, start: box.start } : null;
  }
  private toggleSpoiler(id: string, start: number) {
    const regions = this.spoilers.get(id) || new Map();
    const current = regions.get(start);
    const now = performance.now();
    // The second press of a double-click (which edits) must not hide it again.
    if (current && now - current.at < 400) return;
    regions.set(start, { revealed: !current?.revealed, at: now });
    this.spoilers.set(id, regions);
    if (start === wholeObject) this.lastObjectReveal = now;
    this.invalidate();
  }
  /** Marks or unmarks the selected media, documents, links and frames as spoilers. */
  setSelectionSpoiler(on: boolean) {
    const now = performance.now();
    const upserts = this.selected
      .filter((o) => canBeSpoiler(o) && !o.locked && !!o.spoiler !== on)
      .map((o) => {
        const { spoiler: _spoiler, ...rest } = o;
        return on ? { ...rest, spoiler: true } : rest;
      });
    if (!upserts.length) return;
    // A new spoiler dusts over at once, even for the person who set it.
    for (const o of upserts)
      if (on)
        this.spoilers.set(
          o.id,
          new Map([
            ...(this.spoilers.get(o.id) || []),
            [wholeObject, { revealed: false, at: now }],
          ]),
        );
    this.apply({ upserts, deleted: [] });
    this.callbacks.selection(this.selected);
  }
  /** Covers the selected spoilers this viewer has revealed again. */
  hideSelectionSpoilers() {
    const now = performance.now();
    for (const o of this.selected)
      if (isSpoiler(o) && this.spoilerRevealed(o.id, wholeObject))
        this.spoilers.get(o.id)!.set(wholeObject, { revealed: false, at: now });
    this.callbacks.selection(this.selected);
    this.invalidate();
  }
  get selectionSpoilerRevealed() {
    return this.selected.some((o) => isSpoiler(o) && this.spoilerRevealed(o.id, wholeObject));
  }
  private spoilerRevealed(id: string, start: number) {
    return !!this.spoilers.get(id)?.get(start)?.revealed;
  }
  private spoilerVisibility(id: string, start: number, now: number) {
    const state = this.spoilers.get(id)?.get(start);
    if (!state) return { value: 1, moving: false };
    const elapsed = now - state.at;
    if (state.revealed) {
      const t = Math.min(1, elapsed / revealDuration);
      return { value: (1 - t) ** 2, moving: t < 1 };
    }
    const t = Math.min(1, elapsed / hideDuration);
    return { value: t, moving: t < 1 };
  }
  private animateDust(full: boolean) {
    const now = performance.now();
    const still = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let animating = false;
    for (const { id, layer } of this.dustViews)
      if (!layer.destroyed)
        animating =
          updateDust(
            layer,
            this.camera.zoom,
            now,
            (start) => this.spoilerVisibility(id, start, now),
            still,
          ) || animating;
    if (!full) this.app.render();
    this.dustDrawn = now;
    if (animating && !this.dustFrame && !this.disposed) {
      // About 40 frames a second is plenty for drifting dust. A full draw
      // updates it too, so a pending one takes over.
      const tick = () => {
        this.dustFrame = 0;
        if (this.frame || this.disposed) return;
        if (performance.now() - this.dustDrawn < 24) this.dustFrame = requestAnimationFrame(tick);
        else this.animateDust(false);
      };
      this.dustFrame = requestAnimationFrame(tick);
    }
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
    if (this.selectionLocked) return;
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
          ) < (this.touchInput ? 20 : 10)
        );
      });
  }
  private resizeCorner(p: Point): ResizeHandle | 'rotate' | undefined {
    if (this.selectionLocked) return;
    if (!this.selection.size || this.editingId || this.cropPreview) return;
    if (this.selection.size > 1) {
      const b = boundsOf(this.selected)!;
      return corners.find((corner) => {
        const x = (b.x + (corner.includes('e') ? b.width : 0)) * this.camera.zoom + this.camera.x;
        const y = (b.y + (corner.includes('s') ? b.height : 0)) * this.camera.zoom + this.camera.y;
        const r = this.touchInput ? 20 : 10;
        return Math.abs(p.x - x) < r && Math.abs(p.y - y) < r;
      });
    }
    const o = this.selected[0],
      c = this.camera;
    if (o.type === 'arrow' || o.type === 'highlight') return;
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
      const radius = (corner === 'rotate' ? 14 : 10) * (this.touchInput ? 2 : 1);
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
  private liveGesture = false;
  // What the current move, resize or turn has changed so far, for the other people on the board.
  private emitLive(g: Gesture) {
    if (!this.callbacks.live || !g.changed) return;
    const ids = [...g.original.map((o) => o.id), ...(g.held?.keys() ?? [])];
    const objects = ids.flatMap((id) => {
      const o = this.objects.get(id);
      return o ? [o] : [];
    });
    this.liveGesture = true;
    this.callbacks.live(objects);
  }
  private endLive() {
    if (!this.liveGesture) return;
    this.liveGesture = false;
    this.callbacks.live?.(null);
  }
  /** Shows objects where someone else has them mid-drag: no history, nothing saved. */
  previewRemote(objects: CanvasObject[]) {
    const own = new Set(this.gesture?.original.map((o) => o.id));
    let changed = false;
    for (const o of objects)
      if (this.objects.has(o.id) && !own.has(o.id)) {
        this.preview(o);
        changed = true;
      }
    if (changed) this.invalidate();
  }
  /** Whether the gesture in progress here moves, resizes or turns this object. */
  inGesture(id: string) {
    const g = this.gesture;
    return !!g && (g.original.some((o) => o.id === id) || !!g.held?.has(id));
  }
  private preview(o: CanvasObject) {
    o = this.withDocumentPreview(o);
    const meta = this.linkPreviews.get(o.id);
    if (o.type === 'link' && meta && meta.url === o.url) o = withLinkPreview(o, meta);
    this.objects.set(o.id, o);
    this.index.upsert(o);
  }
  /** Arrows held by what a gesture moves follow it on every frame. */
  private followHeld(g: Gesture) {
    if (!g.held) {
      const moving = new Set(g.original.map((o) => o.id));
      g.held = new Map();
      for (const o of this.objects.values())
        if (!moving.has(o.id) && arrowHeldBy(o, moving)) g.held.set(o.id, o);
    }
    for (const o of g.held.values()) this.preview(followArrow(o, (id) => this.objects.get(id)));
  }
  /** Puts arrows a gesture moved back where they were. */
  private restoreHeld(g: Gesture) {
    for (const o of g.held?.values() ?? []) this.preview(o);
  }
  /** The edit plus the arrows its objects hold, moved to follow them. */
  private withHeldArrows(edit: Edit): Edit {
    const changed = new Set(edit.upserts.filter((o) => o.type !== 'arrow').map((o) => o.id));
    if (!changed.size) return edit;
    const upserted = new Map(edit.upserts.map((o) => [o.id, o])),
      deleted = new Set(edit.deleted),
      followers: CanvasObject[] = [];
    for (const o of this.objects.values()) {
      if (upserted.has(o.id) || deleted.has(o.id) || !arrowHeldBy(o, changed) || o.locked) continue;
      const next = followArrow(o, (id) => upserted.get(id) ?? this.objects.get(id));
      if (next !== o) followers.push(next);
    }
    return followers.length ? { ...edit, upserts: [...edit.upserts, ...followers] } : edit;
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
    // This snapshot has already been validated and persisted externally.
    // Preserve its lock state instead of treating it as a local content edit.
    this.applyEdit(this.withHeldArrows(edit), true);
  }
  apply(edit: Edit, record = true) {
    if (this.readOnly || editTouchesLocked(this.objects, edit)) return;
    edit = {
      ...edit,
      upserts: edit.upserts.map((o) => {
        const current = this.objects.get(o.id);
        if (!current) return o;
        const { locked: _locked, ...content } = o;
        return current.locked === undefined ? content : { ...content, locked: current.locked };
      }),
    };
    if (record) edit = this.withHeldArrows(galleryEdit(this.objects, edit, visualBounds));
    if (editTouchesLocked(this.objects, edit)) return;
    if (!edit.upserts.length && !edit.deleted.length) return;
    this.applyEdit(edit, record);
  }
  private applyEdit(edit: Edit, record: boolean) {
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
    const edit = this.history.undo((edit) => !editTouchesLocked(this.objects, edit));
    if (edit) this.apply(edit, false);
  }
  redo() {
    const edit = this.history.redo((edit) => !editTouchesLocked(this.objects, edit));
    if (edit) this.apply(edit, false);
  }
  deleteSelected() {
    if (this.selection.size)
      this.apply({ upserts: [], deleted: this.clipboardSelection.map((o) => o.id) });
  }
  // What a new copy of an image records about being added (null: nothing);
  // unset keeps what the original had.
  imageAdded: (() => ImageAdded | null) | null = null;
  duplicate() {
    const ids = new Map<string, string>();
    const objects = this.copySelection;
    const objectIds = new Map<string, string>(objects.map((o) => [o.id, uid()]));
    const top = this.topZ();
    const copies = objects.map((o, i) => {
      if (o.groupId && !ids.has(o.groupId)) ids.set(o.groupId, uid());
      return copyArrowEnds(
        {
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
        },
        objectIds,
      );
    });
    if (copies.length) {
      this.apply({
        upserts: this.imageAdded ? stampAdded(copies, this.imageAdded()) : copies,
        deleted: [],
      });
      const chosen = new Set(this.selected.map((o) => objectIds.get(o.id)));
      this.setSelection(copies.filter((o) => !o.galleryId && chosen.has(o.id)).map((o) => o.id));
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
  // Move the view by screen pixels (keeping text being typed above the phone's keyboard).
  panBy(dx: number, dy: number) {
    this.stopCameraAnimation();
    this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy };
    this.callbacks.camera({ ...this.camera });
    this.invalidate();
  }
  // Show a world point at the centre of the view, at the given zoom.
  lookAt(center: Point, zoom: number) {
    this.stopCameraAnimation();
    const z = Math.min(8, Math.max(0.025, Number.isFinite(zoom) ? zoom : this.camera.zoom));
    this.camera = {
      x: this.host.clientWidth / 2 - center.x * z,
      y: this.host.clientHeight / 2 - center.y * z,
      zoom: z,
    };
    this.callbacks.camera({ ...this.camera });
    this.invalidate();
  }
  get viewSize() {
    return { width: this.host.clientWidth, height: this.host.clientHeight };
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
    const drawStarted = performance.now();
    let refined = 0,
      refinePending = false;
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
    // Spoiler frames contain whatever lies inside them, so those frames are
    // on screen whenever anything they hide is.
    const now = performance.now();
    const spoilerHidden = (o: CanvasObject) =>
      this.spoilerVisibility(o.id, wholeObject, now).value > 0.001;
    this.coveringFrames = visible.filter(
      (o) => isSpoiler(o) && hidesContents(o) && spoilerHidden(o),
    );
    const concealed = (o: CanvasObject) =>
      !!this.coveringFrames.length && !!concealedBy(o, this.coveringFrames);
    // A hidden PDF workspace is drawn here from a snapshot until revealed.
    const snapshotComposer = (o: CanvasObject) =>
      !!o.pdfComposer && isSpoiler(o) && spoilerHidden(o);
    this.callbacks.lists?.(
      visible.filter((o) => o.type === 'list' && !concealed(o)),
      c,
    );
    this.callbacks.tables?.(
      visible.filter((o) => o.type === 'table' && !concealed(o)),
      c,
    );
    this.callbacks.files?.(
      visible.filter((o) => o.type === 'file' && !concealed(o)),
      c,
    );
    this.callbacks.papers?.(
      visible.filter((o) => o.type === 'paper' && !concealed(o)),
      c,
    );
    this.callbacks.composers?.(
      visible.filter((o) => !!o.pdfComposer && !snapshotComposer(o) && !concealed(o)),
      c,
    );
    this.callbacks.embeds?.(
      visible.filter((o) => o.type === 'html' && !isSpoiler(o) && !concealed(o)),
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
      if (!['image', 'link', 'document', 'html', 'browser'].includes(o.type)) continue;
      // A running page shows in place of its picture, which need not load.
      if (o.type === 'html' && this.liveEmbeds.has(o.id) && !isSpoiler(o)) continue;
      const showImage =
        o.type === 'image' || o.type === 'document' || isWebCard(o) || hasLinkImage(o);
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
    const linkedScenes = new Map<string, FrameScene>();
    const composerKeys = new Set<string>();
    this.frameMediaVariants.clear();
    const requestLinkedMedia = (key: string) => {
      if (this.frameMediaVariants.has(key)) return;
      let actual = key;
      let cost = key.endsWith('/thumb') ? 256 * 256 * 4 : 1600 * 1600 * 4;
      if (!wanted.has(actual) && bytes + cost > 100 * 1024 * 1024) {
        actual = key.replace('/preview', '/thumb');
        cost = 256 * 256 * 4;
      }
      if (!wanted.has(actual)) {
        if (bytes + cost > 128 * 1024 * 1024) return;
        bytes += cost;
        wanted.add(actual);
      }
      this.frameMediaVariants.set(key, actual);
    };
    for (const o of visible)
      if (o.frameLink) {
        const scene = this.frameScene(o);
        linkedScenes.set(o.id, scene);
        for (const child of sceneObjects(scene)) {
          const key = frameMediaKey(child);
          if (key) requestLinkedMedia(key);
          if (child.linkIconId) requestLinkedMedia(`${child.linkIconId}/thumb`);
          if (child.pdfComposer) this.composerTexture(child, composerKeys);
        }
      } else if (snapshotComposer(o)) this.composerTexture(o, composerKeys);
    for (const [key, texture] of this.composerPreviews)
      if (!composerKeys.has(key)) {
        texture?.destroy(true);
        this.composerPreviews.delete(key);
      }
    this.textures.begin(wanted);
    const linkedTextureIds = [...wanted].map((key) => [key, this.textures.get(key)?.uid]);
    let animateLoading = false;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.dustViews = [];
    let spoilerMoving = false;
    visible.forEach((o, i) => {
      const key = variants.get(o.id),
        snapshot = snapshotComposer(o),
        texture = snapshot
          ? this.composerPreviews.get(composerPreviewKey(o)) || null
          : key
            ? this.textures.get(key)
            : null;
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
            : o.type === 'frame' ||
              o.type === 'video' ||
              o.type === 'link' ||
              o.type === 'browser' ||
              !!o.text));
      const resolution = 2 ** Math.ceil(Math.log2(c.zoom * devicePixelRatio));
      const region = textRegion(o, c, w, h, c.zoom);
      const signature = JSON.stringify([
        o.frameLink
          ? [
              linkedScenes.get(o.id),
              linkedTextureIds,
              [...this.composerPreviews].map(([k, t]) => [k, t?.uid]),
            ]
          : null,
        this.dark,
        !!o.gallery,
        o.width,
        o.height,
        o.text,
        o.imageTitle,
        o.album?.name,
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
        hasRichText(o)
          ? [
              shownMarks(o),
              [...(this.spoilers.get(o.id) || [])].filter(
                ([start, s]) => s.revealed && start !== wholeObject,
              ),
            ]
          : null,
        o.centerX,
        o.centerY,
        o.type,
        o.crop,
        o.arrow,
        o.highlight,
        isSpoiler(o),
        snapshot,
        // Tiny strokes skip the flattening pass; their overlaps are invisible.
        o.type === 'highlight' && highlightSize(o) * c.zoom >= 3,
        key,
        texture?.uid,
        iconKey,
        iconTexture?.uid,
        detail,
        this.editingId === o.id,
        detailTiles.map((tile) => [tile.key, tile.texture?.uid]),
        o.type === 'html' && this.liveEmbeds.has(o.id),
      ]);
      // Raster sharpness only: what changes when the camera moves over unchanged
      // content. These rebuilds are spread across frames within a small budget;
      // the previous bitmap stays on screen until its sharper replacement is ready.
      const sharpness = hasLabel
        ? [
            o.type === 'frame' ? c.zoom : '',
            resolution,
            region.x,
            region.y,
            region.width,
            region.height,
          ].join('|')
        : o.type === 'frame'
          ? String(c.zoom)
          : '';
      let view = this.views.get(o.id);
      let rebuild = !view || view.signature !== signature;
      if (!rebuild && view!.sharpness !== sharpness) {
        if (!refined || performance.now() - drawStarted < 4) {
          rebuild = true;
          refined++;
        } else refinePending = true;
      }
      if (rebuild || !view) {
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
          false,
          linkedScenes.get(o.id),
        );
        const content = spoilerContent(container);
        const loadedTiles = detailTiles.filter((tile) => tile.texture);
        if (texture && loadedTiles.length) {
          // Cut detailed regions out of the preview so transparent pixels are
          // composited once, including while only some detail tiles are loaded.
          const mask = new Graphics().rect(0, 0, o.width, o.height).fill('#ffffff');
          for (const tile of loadedTiles) mask.rect(tile.x, tile.y, tile.width, tile.height).cut();
          content.children[0].mask = mask;
          content.addChild(mask);
        }
        for (const tile of detailTiles)
          if (tile.texture) {
            const sprite = this.imageSprite(tile.texture, tile.frame);
            sprite.position.set(tile.x, tile.y);
            sprite.width = tile.width;
            sprite.height = tile.height;
            content.addChild(sprite);
          }
        view = { container, signature, sharpness };
        this.views.set(o.id, view);
        this.world.addChild(container);
      }
      view.container.pivot.set(o.width / 2, o.height / 2);
      view.container.position.set(o.x + o.width / 2, o.y + o.height / 2);
      view.container.rotation = ((o.rotation || 0) * Math.PI) / 180;
      if (isSpoiler(o)) {
        const state = this.spoilerVisibility(o.id, wholeObject, now);
        updateSpoilerCover(view.container, state.value);
        spoilerMoving ||= state.moving;
      }
      // Objects inside a hidden spoiler frame fade in as it reveals.
      const frame = this.coveringFrames.length ? concealedBy(o, this.coveringFrames) : undefined;
      const cover = frame ? this.spoilerVisibility(frame.id, wholeObject, now) : null;
      view.container.alpha = cover ? 1 - cover.value : 1;
      view.container.visible = !cover || cover.value < 0.999;
      spoilerMoving ||= !!cover?.moving;
      if (view.container.visible)
        for (const layer of [
          view.container,
          spoilerContent(view.container),
          view.container.getChildByLabel('spoiler-cover'),
        ]) {
          const dust = layer?.getChildByLabel('spoiler-dust');
          if (dust && !this.dustViews.some((d) => d.layer === dust))
            this.dustViews.push({ id: o.id, layer: dust });
        }
      const spinner = view.container.getChildByLabel('link-loading');
      if (spinner && loading && !reducedMotion) {
        spinner.rotation = performance.now() / 180;
        animateLoading = true;
      }
      if (this.world.children[i] !== view.container) this.world.setChildIndex(view.container, i);
    });
    this.drawSelection();
    const gap = 24 * c.zoom;
    this.host.style.backgroundSize = `${Math.max(8, gap)}px ${Math.max(8, gap)}px`;
    this.host.style.backgroundPosition = `${c.x}px ${c.y}px`;
    if (this.dustViews.length) this.animateDust(true);
    this.app.render();
    if (animateLoading || refinePending || spoilerMoving) this.invalidate();
    if (!this.rendered) {
      this.rendered = true;
      this.callbacks.ready();
    }
  }
  private makeView(...args: Parameters<Engine['makeObjectView']>): Container {
    const view = this.makeObjectView(...args);
    const [o, , , , , , , exporting] = args;
    if (!isSpoiler(o)) return view;
    coverSpoiler(view, o, this.dark && !exporting, hasExternalLabel(o), this.app.renderer);
    // Exports and linked previews keep the cover still; the board updates it every draw.
    updateSpoilerCover(view, this.spoilerRevealed(o.id, wholeObject) ? 0 : 1);
    return view;
  }
  private makeObjectView(
    o: CanvasObject,
    texture: any,
    detail: boolean,
    resolution: number,
    region: ReturnType<typeof textRegion>,
    loading = false,
    iconTexture: Texture | null = null,
    exporting = false,
    linkedScene?: FrameScene,
    linkedTextures?: Map<string, Texture>,
    staticPreview = false,
  ): Container {
    if (o.frameLink)
      return renderLinkedFrame(
        linkedScene || this.frameScene(o),
        resolution,
        this.dark && !exporting,
        (item, texture, icon) =>
          this.makeView(
            item,
            texture,
            true,
            Math.min(resolution, 8192 / Math.max(item.width, item.height)),
            { x: -100, y: -400, width: item.width + 200, height: item.height + 800 },
            false,
            icon,
            exporting,
            undefined,
            undefined,
            true,
          ),
        (key) =>
          linkedTextures
            ? linkedTextures.get(key) || null
            : key.startsWith('composer:')
              ? this.composerPreviews.get(key) || null
              : this.frameMediaVariants.has(key)
                ? this.textures.get(this.frameMediaVariants.get(key)!)
                : null,
      );
    const container = new Container(),
      g = new Graphics(),
      color = o.color || '#e8edf5';
    const dark = this.dark && !exporting;
    container.eventMode = 'none';
    if (o.pdfComposer) {
      if ((exporting || staticPreview || isSpoiler(o)) && texture) {
        const sprite = new Sprite(texture);
        sprite.width = o.width;
        sprite.height = o.height;
        container.addChild(sprite);
      }
      return container;
    }
    if (o.type === 'document') {
      container.addChild(renderDocumentCard(o, texture, resolution, region, dark));
      if ((exporting || staticPreview || this.editingId !== o.id) && o.documentTitle?.trim())
        this.addLabel(
          container,
          o,
          o.documentTitle,
          resolution,
          region,
          dark,
          exporting || staticPreview,
        );
      return container;
    }
    if (o.type === 'paper') {
      // Interactive pages are rendered in the DOM; exports draw the same sheets.
      if (!exporting && !staticPreview) return container;
      const scale = paperScale(o),
        pages = paperPages(o);
      const sheets = new Container();
      sheets.scale.set(scale);
      container.addChild(sheets);
      for (let index = 0; index < pages; index++)
        g.rect(0, paperPageTop(index), paperWidth, paperPageHeight)
          .fill('#ffffff')
          .stroke({ color: '#dfe3e8', width: 1 });
      sheets.addChild(g);
      const base = {
        size: paperFontSize,
        weight: 400,
        family: '"Segoe UI", sans-serif',
        lineHeight: paperLineHeight,
      };
      const measure = document.createElement('canvas').getContext('2d')!;
      const lines = layoutRichText(measure, o.text || '', o.textMarks, base, paperContentWidth);
      const pixels = Math.min(
        resolution * scale,
        8192 / paperContentWidth,
        8192 / paperContentHeight,
      );
      paginateLines(lines)
        .slice(0, pages)
        .forEach((page, index) => {
          if (!page.length) return;
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(paperContentWidth * pixels));
          canvas.height = Math.max(1, Math.ceil(paperContentHeight * pixels));
          const ctx = canvas.getContext('2d')!;
          ctx.scale(pixels, pixels);
          drawRichText(ctx, page, base, { x: 0, y: 0, color: '#1f2328', hidden: 'dust' });
          const texture = new Texture({
            source: new CanvasSource({ resource: canvas, resolution: pixels }),
          });
          const sprite = new Sprite(texture);
          sprite.position.set(paperMargin, paperPageTop(index) + paperMargin);
          sprite.once('destroyed', () => texture.destroy(true));
          sheets.addChild(sprite);
        });
      return container;
    }
    if (o.type === 'list') {
      // Interactive glass is rendered in the DOM; exports use the same card geometry.
      if (!exporting && !staticPreview) return container;
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
      // Returns the label's height; formatted runs render through one canvas sprite.
      const label = (
        value: string,
        marks: CanvasObject['textMarks'],
        x: number,
        y: number,
        size: number,
        checked = false,
        bold = false,
        strike = checked,
      ) => {
        const base = {
          size,
          weight: bold ? 700 : 400,
          family: '"Segoe UI", sans-serif',
          lineHeight: 24 / size,
        };
        const available = Math.max(1, o.width - x - (size === 16 ? 56 : 16));
        const lines = layoutRichText(measure, value, marks, base, available);
        const height = richTextHeight(lines);
        const canvas = document.createElement('canvas');
        const scale = Math.min(resolution, 8192 / available, 8192 / height);
        canvas.width = Math.max(1, Math.ceil(available * scale));
        canvas.height = Math.max(1, Math.ceil(height * scale));
        const ctx = canvas.getContext('2d')!;
        ctx.scale(scale, scale);
        drawRichText(ctx, lines, base, {
          x: 0,
          y: 0,
          color: checked ? '#87928e' : '#29313b',
          strikeAll: strike,
          hidden: 'dust',
        });
        const texture = new Texture({
          source: new CanvasSource({ resource: canvas, resolution: scale }),
        });
        const sprite = new Sprite(texture);
        sprite.position.set(x, y);
        sprite.once('destroyed', () => texture.destroy(true));
        card.addChild(sprite);
        return height;
      };
      const titleHeight = o.text
        ? label(o.text, o.textMarks, 51, 18, 15, false, o.bold, o.strikethrough)
        : 24;
      let y = 72 + titleHeight - 24;
      (o.items || []).forEach((item) => {
        g.circle(28, y, 10).stroke({ color: item.checked ? '#729385' : '#a0aebb', width: 1.4 });
        if (item.checked) {
          g.circle(28, y, 10).fill('#729385');
          g.moveTo(23, y)
            .lineTo(27, y + 4)
            .lineTo(33, y - 4)
            .stroke({ color: '#ffffff', width: 1.5 });
        }
        const height = label(item.text, item.marks, 51, y - 12, 16, item.checked);
        y += Math.max(44, height + 20);
      });
      return container;
    }
    if (o.type === 'file') {
      // Folder frames and file tiles are live HTML on screen. Elsewhere they are
      // a placeholder: what a folder holds never leaves this computer.
      if (!exporting && !staticPreview) return container;
      const canvas = drawFilePlaceholder(o, resolution, dark);
      const texture = new Texture({
        source: new CanvasSource({ resource: canvas, resolution: canvas.width / o.width }),
      });
      const sprite = new Sprite(texture);
      sprite.width = o.width;
      sprite.height = o.height;
      sprite.once('destroyed', () => texture.destroy(true));
      container.addChild(sprite);
      return container;
    }
    if (o.type === 'table') {
      // Interactive tables are HTML; exports and previews draw the same card.
      if (!exporting && !staticPreview) return container;
      const canvas = drawTable(o, resolution, dark);
      const texture = new Texture({
        source: new CanvasSource({ resource: canvas, resolution: canvas.width / o.width }),
      });
      const sprite = new Sprite(texture);
      sprite.width = o.width;
      sprite.height = o.height;
      sprite.once('destroyed', () => texture.destroy(true));
      container.addChild(sprite);
      return container;
    }
    if (o.type === 'highlight' && isPen(o)) {
      const points = highlightPoints(o),
        width = highlightSize(o),
        color = o.color || defaultPenStyle.color,
        // Dark ink turns light on the night board, as arrows and text do.
        ink = dark ? nightInk({ type: 'arrow', color }, color) : color;
      const path = smoothStroke(points);
      g.moveTo(path.start.x, path.start.y);
      for (const c of path.curves) g.quadraticCurveTo(c.control.x, c.control.y, c.to.x, c.to.y);
      g.stroke({ color: ink, width, cap: 'round', join: 'round' });
      if (points.every((p) => p.x === points[0].x && p.y === points[0].y))
        g.circle(points[0].x, points[0].y, width / 2).fill(ink);
      container.addChild(g);
      return container;
    }
    if (o.type === 'highlight') {
      const points = highlightPoints(o),
        width = highlightSize(o),
        ink = o.color || defaultHighlightStyle.color;
      g.moveTo(points[0].x, points[0].y);
      for (const p of points.slice(1)) g.lineTo(p.x, p.y);
      g.stroke({ color: ink, width, cap: 'round', join: 'round' });
      // A zero-length stroke has no outline to cap; a press still leaves a dot.
      if (points.every((p) => p.x === points[0].x && p.y === points[0].y))
        g.circle(points[0].x, points[0].y, width / 2).fill(ink);
      // Draw opaque, then fade the whole stroke once, so it never darkens where it crosses itself.
      if (exporting || width * this.camera.zoom >= 3)
        g.filters = [
          new AlphaFilter({
            alpha: highlightAlpha,
            antialias: 'inherit',
            resolution: 'inherit',
            padding: 2,
          }),
        ];
      else g.alpha = highlightAlpha;
      container.addChild(g);
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
    if (o.type === 'html') {
      container.addChild(
        renderHtmlCard(
          o,
          texture,
          dark,
          !exporting && !staticPreview && !isSpoiler(o) && this.liveEmbeds.has(o.id),
        ),
      );
      return container;
    }
    if (o.type === 'browser') {
      container.addChild(renderBrowserCard(o, texture, dark, resolution));
      return container;
    }
    if (o.type === 'image' && texture) {
      const sprite = this.imageSprite(texture, o.crop);
      sprite.width = o.width;
      sprite.height = o.height;
      container.addChild(sprite);
      if (o.album) container.addChild(renderAlbumName(o, resolution));
      else if ((exporting || this.editingId !== o.id) && o.imageTitle?.trim())
        this.addLabel(
          container,
          o,
          o.imageTitle,
          resolution,
          region,
          dark,
          exporting || staticPreview,
        );
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
    if (exporting || staticPreview || this.editingId !== o.id) {
      let text = o.text || '';
      if (o.type === 'frame') text = o.text || 'Untitled frame';
      if (o.type === 'image') text = o.imageTitle?.trim() ? o.imageTitle : 'Image';
      if (o.type === 'video') text = o.text || 'Play video';
      if (text)
        this.addLabel(
          container,
          o.type === 'image' && !o.imageTitle?.trim() ? { ...o, type: 'rect' } : o,
          text,
          resolution,
          region,
          dark,
          exporting || staticPreview,
          exporting ? undefined : this.camera?.zoom,
        );
    }
    return container;
  }
  // An object's text or name, with dust over the spoilers this viewer has not revealed.
  private addLabel(
    container: Container,
    o: CanvasObject,
    text: string,
    resolution: number,
    region: ReturnType<typeof textRegion>,
    dark: boolean,
    still: boolean,
    frameZoom?: number,
  ) {
    const label = renderText(o, text, resolution, region, dark, frameZoom, {
      exporting: still,
      revealed: (start) => this.spoilerRevealed(o.id, start),
    });
    if (label) container.addChild(label);
    if (!still && hasRichText(o)) {
      const boxes = textSpoilers(o, text, frameZoom);
      if (boxes.length) container.addChild(dustLayer(boxes, dark));
    }
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
    // View mode shows no selection: an embed in use is selected only to run its page.
    if (this.viewOnly) {
      this.callbacks.selectionView?.(null, {
        width: this.host.clientWidth,
        height: this.host.clientHeight,
      });
      return;
    }
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
    if (
      toolbarBounds &&
      this.selection.size === 1 &&
      this.selected[0].type !== 'arrow' &&
      this.selected[0].type !== 'highlight'
    ) {
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
      // Keep the toolbar clear of the rotation handle and the connector dots.
      const labelTop = hasExternalLabel(o) ? frameLabel(o, c.zoom).top : 0;
      const ys = [
        handle.y,
        ...(canConnect(o) ? connectorSides.map((s) => connectorDot(o, s, c.zoom, labelTop).y) : []),
      ].map((y) => y * c.zoom + c.y);
      const top = Math.min(toolbarBounds.y, ...ys.map((y) => y - 14));
      toolbarBounds = {
        ...toolbarBounds,
        y: top,
        height: Math.max(toolbarBounds.y + toolbarBounds.height, ...ys.map((y) => y + 14)) - top,
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
      if (this.selectionLocked) {
        g.rect(x, y, w, h).stroke({ color: '#8b98a9', width: 1.5 });
      } else if (this.selection.size === 1 && this.selected[0].type === 'arrow') {
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
      } else if (this.selection.size === 1 && this.selected[0].type === 'highlight') {
        const ink = highlightBounds(this.selected[0]);
        g.roundRect(
          ink.x * c.zoom + c.x,
          ink.y * c.zoom + c.y,
          ink.width * c.zoom,
          ink.height * c.zoom,
          Math.min(ink.width, ink.height, highlightSize(this.selected[0])) * 0.5 * c.zoom,
        ).stroke({ color: '#4486d9', width: 1.5 });
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
        } else if (
          o.type !== 'list' &&
          o.type !== 'paper' &&
          o.type !== 'table' &&
          o.type !== 'file'
        )
          g.poly(outline).stroke({ color: '#4486d9', width: 1.5 });
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
        if (!this.gesture && !this.editingId && !this.readOnly && canConnect(o)) {
          // Side dots: drag one out to draw an arrow from that side.
          const labelTop = hasExternalLabel(o) ? frameLabel(o, c.zoom).top : 0;
          for (const side of connectorSides) {
            const p = screen(worldToLocal(o, connectorDot(o, side, c.zoom, labelTop)));
            if (side === this.hoverConnector)
              g.circle(p.x, p.y, 7).fill('#4486d9').stroke({ color: '#ffffff', width: 2 });
            else g.circle(p.x, p.y, 4.5).fill('#ffffff').stroke({ color: '#4486d9', width: 1.5 });
          }
        }
      }
    }
    const connectTarget =
      this.gesture?.connectTarget && this.objects.get(this.gesture.connectTarget);
    if (connectTarget) {
      const outline = ['nw', 'ne', 'se', 'sw'].flatMap((h) => {
        const q = localToWorld(connectTarget, handlePoint(connectTarget, h as ResizeHandle));
        return [q.x * c.zoom + c.x, q.y * c.zoom + c.y];
      });
      g.poly(outline).stroke({ color: '#4486d9', width: 2 });
    }
    if (this.gesture?.mode !== 'rotate') this.callbacks.rotation?.(null);
    if (this.inkTool && this.pointer && !this.space && this.gesture?.mode !== 'pan') {
      // The ring is the marker's true footprint, pinned in place while it is resized.
      const style = this.inkStyle;
      const at = this.gesture?.mode === 'highlightSize' ? this.gesture.start : this.pointer,
        radius = Math.max(style.size / 2, this.tool === 'pen' ? 2 : 0);
      g.circle(at.x, at.y, radius)
        .fill({ color: style.color, alpha: this.gesture ? 0.25 : 0.12 })
        .stroke({ color: this.dark ? '#ffffff' : '#252d38', width: 1, alpha: 0.55 });
    }
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
    const getBounds = pictureBounds;
    const plan = exportPlan(
      this.all,
      [...this.selection],
      scope,
      this.camera,
      { width: this.host.clientWidth, height: this.host.clientHeight },
      getBounds,
    );
    // Exports show spoilers as this viewer sees them: hidden frames keep their contents out.
    const hiddenFrames = plan.objects.filter(
      (o) => isSpoiler(o) && hidesContents(o) && !this.spoilerRevealed(o.id, wholeObject),
    );
    if (hiddenFrames.length)
      plan.objects = plan.objects.filter((o) => !concealedBy(o, hiddenFrames));
    let sourceScale = 1;
    const images = plan.objects.flatMap((object) => {
      const id =
        object.type === 'document'
          ? object.documentPreviewId
          : object.type === 'image' ||
              isWebCard(object) ||
              (object.type === 'link' && hasLinkImage(object))
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
            if (o.type !== 'document' && !isWebCard(o)) throw error;
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
    await this.drawObjects(context, plan, assetUrl, getBounds, progress);
    progress(82, 'Encoding file…');
    return { canvas, limited: resolution.limited, pageSize };
  }
  // A picture of objects from any board, for a view pinned to the screen. It is
  // drawn like an export at the given pixel size, without a background.
  async pinPicture(
    objects: CanvasObject[],
    pixels: { width: number; height: number },
    assetUrl: (id: string, variant: string) => string,
  ) {
    await this.initialized;
    if (this.disposed || !this.ready) return null;
    const hidden = objects.filter(
      (o) => isSpoiler(o) && hidesContents(o) && !this.spoilerRevealed(o.id, wholeObject),
    );
    if (hidden.length) objects = objects.filter((o) => !concealedBy(o, hidden));
    if (!objects.length) return null;
    const bounds = unionBounds(objects.map(pictureBounds));
    const scale = Math.min(
      pixels.width / bounds.width,
      pixels.height / bounds.height,
      8192 / bounds.width,
      8192 / bounds.height,
    );
    const width = Math.max(1, Math.round(bounds.width * scale)),
      height = Math.max(1, Math.round(bounds.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    await this.drawObjects(
      canvas.getContext('2d')!,
      { objects, bounds, scale, width, height, quick: true },
      assetUrl,
      pictureBounds,
    );
    return canvas;
  }
  private async drawObjects(
    context: CanvasRenderingContext2D,
    plan: {
      objects: CanvasObject[];
      bounds: Bounds;
      scale: number;
      width: number;
      height: number;
      quick?: boolean;
    },
    assetUrl: (id: string, variant: string) => string,
    getBounds: (o: CanvasObject) => Bounds,
    progress?: (value: number, label: string) => void,
  ) {
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
        const needed = icon
          ? Math.max(256, 24 * plan.scale)
          : Math.min(
              8192,
              Math.max(o.width / (o.crop?.width || 1), o.height / (o.crop?.height || 1)) *
                plan.scale,
            );
        if (icon) await decode('thumb');
        else {
          try {
            // Pinned pictures make do with the 1600-pixel preview when it is enough.
            await decode(plan.quick && needed <= 1600 ? 'preview' : 'original');
          } catch {
            await decode('export');
          }
        }
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
      progress?.(
        5 + Math.round((75 * i) / Math.max(1, plan.objects.length)),
        `Rendering ${i + 1} of ${plan.objects.length} items…`,
      );
      // Yield to paint progress even when every item is a shape or text.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const linkedScene = o.frameLink ? this.frameScene(o) : undefined;
        const linkedTextures = new Map<string, Texture>();
        if (linkedScene)
          for (const child of sceneObjects(linkedScene)) {
            const key = frameMediaKey(child);
            if (key && !linkedTextures.has(key)) {
              const [id, variant] = key.split('/');
              try {
                linkedTextures.set(key, await load(id, variant === 'thumb'));
              } catch (error) {
                if (child.type !== 'document') throw error;
              }
            }
            if (child.linkIconId && !linkedTextures.has(`${child.linkIconId}/thumb`))
              linkedTextures.set(`${child.linkIconId}/thumb`, await load(child.linkIconId, true));
            if (child.pdfComposer) {
              const key = `composer:${JSON.stringify(child.pdfComposer)}:${child.width}:${child.height}`;
              if (!linkedTextures.has(key)) {
                const { composerSnapshot } = await import('./pdf-composer-snapshot');
                const canvas = await composerSnapshot(child, Math.min(2, plan.scale));
                const texture = Texture.from(canvas);
                linkedTextures.set(key, texture);
                textures.push(texture);
              }
            }
          }
        const imageId =
          o.type === 'document'
            ? o.documentPreviewId
            : o.type === 'image' || isWebCard(o) || (o.type === 'link' && hasLinkImage(o))
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
            // Document thumbnails and page pictures are derived; the card still exports.
            if (o.type !== 'document' && !isWebCard(o)) throw error;
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
          linkedScene,
          linkedTextures,
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
    this.clearLongPress();
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.dustFrame);
    this.observer.disconnect();
    window.removeEventListener(appearanceEvent, this.appearanceChanged);
    this.lighting.destroy();
    this.textures.destroy();
    for (const texture of this.composerPreviews.values()) texture?.destroy(true);
    this.composerPreviews.clear();
    this.host.removeEventListener('pointerdown', this.down);
    this.host.removeEventListener('pointermove', this.move);
    this.host.removeEventListener('pointerup', this.up);
    this.host.removeEventListener('pointercancel', this.cancel);
    this.host.removeEventListener('pointerleave', this.leave);
    this.host.removeEventListener('wheel', this.wheel);
    this.host.removeEventListener('dblclick', this.doubleClick);
    this.host.removeEventListener('contextmenu', this.context);
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.blur);
    if (this.ready) this.app.destroy(true, { children: true });
  }
}
