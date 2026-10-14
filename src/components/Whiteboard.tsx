import ArrowControls from './ArrowControls';
import CanvasLists, { listHeight, type ListView } from './CanvasLists';
import CanvasPdfComposers from './CanvasPdfComposers';
import PdfExportDialog from './PdfExportDialog';
import type { PdfComposer } from '../model';
import { createPdfComposer, appendPdfComposer } from '../canvas/pdf-composer';
import { prepareComposerSources, exportComposerColumn } from '../canvas/pdf-composer-files';
import { isPdfComposerInput, pdfComposerTargetAt } from '../canvas/pdf-drop';
import { convertibleFile, needsOfficeConversion } from '../canvas/pdf-conversion-formats';
import { convertComposerInputs } from '../canvas/document-convert';
import ListEditOutline from './ListEditOutline';
import CanvasToolbar from './CanvasToolbar';
import RadialMenu from './RadialMenu';
import CollabLayer from './CollabLayer';
import { activeCommand, isCommand, useShortcutLabels } from '../shortcuts/active';
import type { CommandId } from '../shortcuts/commands';
import { getPreferences, subscribePreferences } from '../settings/preferences';
import { BackgroundImage } from './BoardBackground';
import type { BackgroundAppearance } from '../model';
import SelectionToolbar from './SelectionToolbar';
import FrameUsages from './FrameUsages';
import { frameReference, type FrameReference } from '../canvas/frame-usages';
import ObjectLockButton from './ObjectLockButton';
import type { ToolbarId } from './toolbar-layout';
import {
  highlightColors,
  highlightSizeRange,
  readHighlightStyle,
  defaultHighlightStyle,
} from '../canvas/highlight';
import { useZoomControlSpace } from './useZoomControlSpace';
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
  Bold,
  Strikethrough,
  MousePointer2,
  MoveUpRight,
  Highlighter,
  Hand,
  Type,
  StickyNote,
  Square,
  Frame,
  Link2,
  ImagePlus,
  FileText,
  ListTodo,
  Images,
  ArrowRight,
  ArrowDown,
  Minus,
  Plus,
  Maximize2,
  Pencil,
  Files,
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
  Eraser,
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
import {
  defaultGallery,
  galleryMembers,
  selectionWithGalleryImages,
  insertGalleryImages,
  type GalleryTarget,
} from '../canvas/gallery';
import { textAppearance } from '../canvas/text-style';
import { textLayout, fitTextObject, fitTextToView } from '../canvas/text-layout';
import { textPlacement } from '../canvas/text-alignment';
import { localToWorld, objectBounds, containsObject } from '../canvas/transform';
import { SaveQueue, CameraSaveQueue, type SaveState } from '../canvas/save-queue';
import {
  importFiles,
  pickMedia,
  openLink,
  mediaUrl,
  assetDimensions,
  download,
  invoke,
} from '../bridge';
import { ContextMenu, Modal, type MenuItem } from './Dialogs';
import ImageCrop from './ImageCrop';
import DocumentReader, { type DocumentReaderHandle } from './DocumentReader';
import PdfWorkspace, { type PdfWorkspaceHandle } from './PdfWorkspace';
import ImageViewer from './ImageViewer';
import { documentKind, withDocumentTitle } from '../canvas/document-files';
import { prepareDocumentPreview, type DocumentPreview } from '../canvas/document-preview';
import { downloadAsset } from '../bridge';
import { cropImage, uncroppedImage, fullCrop } from '../canvas/crop';
import { selectionToolsPosition } from '../canvas/selection-tools';
import { boundsOf, type Bounds } from '../canvas/geometry';
import { encodeExport, type ExportFormat } from '../canvas/export-format';
import type { ExportScope, ExportQuality } from '../canvas/export-plan';
import ExportControls, { type ExportProgress, type ExportResult } from './ExportControls';
import { nightInk, type ResolvedTheme } from '../appearance';
export interface WhiteboardHandle {
  prepareExternal: () => Promise<void>;
  finishExternal: (doc?: Document) => void;
  flush: () => Promise<void>;
  importMedia: () => void;
  fit: () => void;
}
interface Props {
  backgroundPreview?: BackgroundAppearance;
  onOpenFrame: (boardId: string, frameId: string) => void;
  onReady: () => void;
  searchTarget: { objectId: string } | null;
  theme: ResolvedTheme;
  document: Document;
  onSave: (state: SaveState, message?: string) => void;
  onError: (message: string) => void;
  // Live-sharing visitors without edit rights.
  readOnly?: boolean;
}
const tools: { id: Tool & ToolbarId; label: string; icon: typeof Type; command: CommandId }[] = [
  { id: 'select', label: 'Select', icon: MousePointer2, command: 'tool.select' },
  { id: 'hand', label: 'Pan', icon: Hand, command: 'tool.hand' },
  { id: 'text', label: 'Text', icon: Type, command: 'tool.text' },
  { id: 'note', label: 'Note', icon: StickyNote, command: 'tool.note' },
  { id: 'rect', label: 'Shape', icon: Square, command: 'tool.rect' },
  { id: 'arrow', label: 'Arrow', icon: MoveUpRight, command: 'tool.arrow' },
  { id: 'highlight', label: 'Highlighter', icon: Highlighter, command: 'tool.highlight' },
  { id: 'frame', label: 'Frame', icon: Frame, command: 'tool.frame' },
  { id: 'link', label: 'Link', icon: Link2, command: 'tool.link' },
];
const colors = ['#f8efd4', '#e4eee8', '#e4ecfa', '#efe5f1', '#f4e4e5', '#ffffff', '#000000'];
const Whiteboard = forwardRef<WhiteboardHandle, Props>(function Whiteboard(
  {
    document: doc,
    onSave,
    onError,
    onReady,
    theme,
    searchTarget,
    onOpenFrame,
    backgroundPreview,
    readOnly = false,
  },
  ref,
) {
  const external = useRef(false);
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    readOnlyRef.current = readOnly;
    engine.current?.setReadOnly(readOnly);
  }, [readOnly]);
  const shortcutLabel = useShortcutLabels();
  const [usageTarget, setUsageTarget] = useState<{
    source: FrameReference;
    name: string;
  } | null>(null);
  const refreshLinkedBoards = useRef<() => Promise<void>>(async () => {});
  const [frameClipboard, setFrameClipboard] = useState<CanvasObject | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('terra-board.frame-link') || 'null');
      return value ? clipboardObjects([value])[0] : null;
    } catch {
      return null;
    }
  });
  const openOriginalFrame = async (o: CanvasObject) => {
    if (!o.frameLink) return;
    const { boardId, frameId } = o.frameLink;
    const source =
      boardId === doc.board.id
        ? engine.current?.all
        : (await invoke<Document>('loadBoard', { id: boardId })).objects;
    if (!source?.some((item) => item.id === frameId && item.type === 'frame'))
      throw Error('The original frame is unavailable. Restore it to reconnect this link.');
    onOpenFrame(boardId, frameId);
  };
  const copyFrameLink = async (o: CanvasObject) => {
    finishEdit();
    await queue.current?.flush();
    const original = engine.current?.objects.get(o.id) || o;
    const link: CanvasObject = {
      id: uid(),
      type: 'frame',
      x: original.x,
      y: original.y,
      width: original.width,
      height: original.height,
      z: 0,
      text: original.text,
      frameLink: original.frameLink || { boardId: doc.board.id, frameId: original.id },
    };
    localStorage.setItem('terra-board.frame-link', JSON.stringify(link));
    setFrameClipboard(link);
    if (window.canvas) await copyDesktop([link]);
  };
  const pasteFrameLink = () => {
    const e = engine.current;
    if (!e || !frameClipboard) return;
    const surface = host.current!.getBoundingClientRect();
    const p = menu
      ? e.screenPoint({ x: menu.x - surface.left, y: menu.y - surface.top })
      : e.center();
    const o = {
      ...frameClipboard,
      id: uid(),
      x: p.x - frameClipboard.width / 2,
      y: p.y - frameClipboard.height / 2,
      z: e.topZ() + 1,
    };
    e.apply({ upserts: [o], deleted: [] });
    e.setSelection([o.id]);
  };
  const lastTextSize = useRef<number | null>(null);
  if (lastTextSize.current === null) {
    let saved = 0;
    try {
      saved = Number(localStorage.getItem('terra-board.text-size'));
    } catch {}
    lastTextSize.current = Number.isFinite(saved) && saved >= 8 && saved <= 300 ? saved : 24;
  }
  const rememberTextSize = (o: CanvasObject) => {
    if (o.type !== 'text') return;
    const size = textAppearance(o).fontSize;
    if (size === lastTextSize.current) return;
    lastTextSize.current = size;
    try {
      localStorage.setItem('terra-board.text-size', String(size));
    } catch {}
  };
  const [highlightStyle, setHighlightStyle] = useState(() => {
    try {
      return readHighlightStyle(
        JSON.parse(localStorage.getItem('terra-board.highlighter') || 'null'),
      );
    } catch {
      return { ...defaultHighlightStyle };
    }
  });
  const highlightStyleRef = useRef(highlightStyle);
  highlightStyleRef.current = highlightStyle;
  useEffect(() => {
    engine.current?.setHighlightStyle(highlightStyle);
    try {
      localStorage.setItem('terra-board.highlighter', JSON.stringify(highlightStyle));
    } catch {}
  }, [highlightStyle]);
  const backgroundJob = useRef<Promise<void> | null>(null);
  const [removingBackground, setRemovingBackground] = useState(false);
  const exportTask = useRef<Promise<void> | null>(null);
  const [exportScope, setExportScope] = useState<ExportScope | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  useEffect(
    () => () => {
      if (exportResult?.url) URL.revokeObjectURL(exportResult.url);
    },
    [exportResult],
  );
  const syncingExternal = useRef(false);
  const arrowDraft = useRef<{ flush: () => void }>(null);
  const host = useRef<HTMLDivElement>(null),
    engine = useRef<Engine | null>(null),
    queue = useRef<SaveQueue | null>(null),
    cameraQueue = useRef<CameraSaveQueue | null>(null),
    alive = useRef(true),
    editorRef = useRef<HTMLTextAreaElement>(null),
    editingSession = useRef<{ object: CanvasObject; draft: string } | null>(null),
    clipboardTask = useRef<Promise<boolean> | null>(null),
    imports = useRef(new Set<Promise<void>>());
  const cropSession = useRef<{ object: CanvasObject; crop: CropBounds } | null>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const zoomControls = useZoomControlSpace();
  const galleryHintRef = useRef<HTMLDivElement>(null);
  const galleryTargetsRef = useRef<HTMLDivElement>(null);
  const galleryTarget = useRef<GalleryTarget | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pastePoint = () => {
    const e = engine.current,
      rect = host.current?.getBoundingClientRect(),
      p = pointer.current;
    if (!e) return undefined;
    if (!rect || !p || p.x < rect.left || p.y < rect.top || p.x > rect.right || p.y > rect.bottom)
      return e.center();
    return e.screenPoint({ x: p.x - rect.left, y: p.y - rect.top });
  };
  // The board area in view, clear of the floating header and toolbar and of the board panel.
  const visibleBoardArea = (e: Engine) => {
    const surface = host.current!.getBoundingClientRect(),
      panel = window.document.querySelector('.launcher')?.getBoundingClientRect();
    const inset = { left: 32, top: 84, right: 32, bottom: 124 };
    if (panel?.width && panel.height) {
      const upright = panel.height > panel.width;
      const near = upright
        ? panel.left + panel.right < surface.left + surface.right
        : panel.top + panel.bottom < surface.top + surface.bottom;
      const cover = upright
        ? near
          ? panel.right - surface.left
          : surface.right - panel.left
        : near
          ? panel.bottom - surface.top
          : surface.bottom - panel.top;
      inset[upright ? (near ? 'left' : 'right') : near ? 'top' : 'bottom'] += Math.max(0, cover);
    }
    const from = e.screenPoint({ x: inset.left, y: inset.top }),
      to = e.screenPoint({ x: surface.width - inset.right, y: surface.height - inset.bottom });
    return {
      ...from,
      width: Math.max(160 / e.camera.zoom, to.x - from.x),
      height: Math.max(80 / e.camera.zoom, to.y - from.y),
    };
  };
  const pasteTarget = () => {
    // Only an explicit insertion target captures a paste; selection alone does not.
    const target = galleryTarget.current;
    if (target) return { ...target };
    const e = engine.current,
      point = pastePoint(),
      gallery = e?.selected.length === 1 ? e.selected[0] : undefined;
    // The empty gallery's "Paste images here" area is its first insertion target.
    if (
      gallery?.gallery &&
      !gallery.locked &&
      point &&
      !galleryMembers(gallery.id, e!.all).length &&
      point.x >= gallery.x &&
      point.x <= gallery.x + gallery.width &&
      point.y >= gallery.y &&
      point.y <= gallery.y + gallery.height
    )
      return { galleryId: gallery.id };
    return null;
  };
  const hoveredImage = useRef<string | null>(null);
  const [hoverImageId, setHoverImageId] = useState<string | null>(null);
  const hoverImage = (id: string | null) => {
    if (id === hoveredImage.current) return;
    hoveredImage.current = id;
    setHoverImageId(id);
    galleryTarget.current = null;
  };
  const positionGalleryTargets = () => {
    const e = engine.current,
      overlay = galleryTargetsRef.current;
    const image = e && hoveredImage.current && e.objects.get(hoveredImage.current);
    if (!e || !overlay || !image) return;
    const b = objectBounds(image),
      c = e.camera;
    overlay.style.left = `${b.x * c.zoom + c.x}px`;
    overlay.style.top = `${b.y * c.zoom + c.y}px`;
    overlay.style.width = `${b.width * c.zoom}px`;
    overlay.style.height = `${b.height * c.zoom}px`;
  };
  useLayoutEffect(positionGalleryTargets, [hoverImageId]);
  const angleRef = useRef<HTMLDivElement>(null);
  const toolsSize = useRef({ width: 0, height: 0 });
  const selectionView = useRef<{
    bounds: Bounds | null;
    viewport: { width: number; height: number };
  } | null>(null);
  const positionTools = () => {
    positionGalleryTargets();
    const hint = galleryHintRef.current,
      e = engine.current,
      gallery = e?.selected[0];
    if (hint && e && gallery?.gallery) {
      hint.style.left = `${gallery.x * e.camera.zoom + e.camera.x}px`;
      hint.style.top = `${gallery.y * e.camera.zoom + e.camera.y}px`;
      hint.style.width = `${gallery.width * e.camera.zoom}px`;
      hint.style.height = `${gallery.height * e.camera.zoom}px`;
    }
    const el = toolsRef.current,
      view = selectionView.current;
    if (!el || !view?.bounds) return;
    const { left, top } = selectionToolsPosition(view.bounds, view.viewport, toolsSize.current);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
  };
  const measureTools = () => {
    const el = toolsRef.current;
    if (!el) return;
    toolsSize.current = { width: el.offsetWidth, height: el.offsetHeight };
    positionTools();
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
    [copying, setCopying] = useState(false),
    [count, setCount] = useState(doc.objects.length);
  const activeGallery = selected.length === 1 && selected[0].gallery ? selected[0] : null;
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [listView, setListView] = useState<ListView>({ objects: [], camera: doc.camera });
  const [composerView, setComposerView] = useState<ListView>({ objects: [], camera: doc.camera });
  const [editingComposerId, setEditingComposerId] = useState<string | null>(null);
  const [pdfDropTarget, setPdfDropTarget] = useState<CanvasObject | null>(null);
  const [officeProgress, setOfficeProgress] = useState('');
  const [composerProgress, setComposerProgress] = useState('');
  const [pdfExport, setPdfExport] = useState<{
    composer: PdfComposer;
    columnId: string;
    name: string;
  } | null>(null);
  useEffect(() => window.canvas?.onOfficeProgress(setOfficeProgress), []);
  const composerViewKey = useRef('');
  const composerTail = useRef<Promise<void>>(Promise.resolve());
  const [readingDocument, setReadingDocument] = useState<CanvasObject | null>(null);
  const [documentSession, setDocumentSession] = useState(0);
  const readingDocumentId = useRef<string | null>(null);
  const readingDocumentSession = useRef(0);
  const savingDocumentId = useRef<string | null>(null);
  const documentReader = useRef<DocumentReaderHandle>(null);
  const pdfReader = useRef<PdfWorkspaceHandle>(null);
  const pdfSession = useRef(0);
  const [pdfWorkspace, setPdfWorkspace] = useState<{
    objects: CanvasObject[];
    mode: 'preview' | 'edit';
    session: number;
  } | null>(null);
  const [previewingImage, setPreviewingImage] = useState<CanvasObject | null>(null);
  const documentRequests = useRef(new Map<string, string>());
  const documentAbort = useRef(new AbortController());
  const deferredDocumentPreviews = useRef(
    new Map<string, { assetId: string; metadata: DocumentPreview }>(),
  );
  const documentViewKey = useRef('');
  const closeDocument = (session = readingDocumentSession.current) => {
    if (session !== readingDocumentSession.current) return;
    readingDocumentSession.current++;
    readingDocumentId.current = null;
    setReadingDocument(null);
    host.current?.focus();
  };
  const syncDocumentView = () => {
    const id = readingDocumentId.current,
      current = id && engine.current?.objects.get(id);
    // Keep the saving reader mounted and disabled until persistence completes.
    // Replacing its asset key earlier would expose a fresh, editable reader.
    if (id && savingDocumentId.current === id) return;
    if (!current) {
      if (id) closeDocument();
      return;
    }
    const key = JSON.stringify(current);
    if (key !== documentViewKey.current) {
      documentViewKey.current = key;
      setReadingDocument({ ...current });
    }
  };
  const refreshDocument = (o: CanvasObject, e: Engine) => {
    if (external.current || o.type !== 'document' || !o.assetId) return;
    const kind = documentKind(o.text || '', o.documentMime);
    if (
      kind === 'file' ||
      (kind === 'pdf' ? !!o.documentPreviewId : o.documentExcerpt !== undefined)
    )
      return;
    if (documentRequests.current.get(o.id) === o.assetId) return;
    documentRequests.current.set(o.id, o.assetId);
    void prepareDocumentPreview(o, documentAbort.current.signal)
      .then((metadata) => {
        if (!alive.current || engine.current !== e) return;
        if (external.current)
          deferredDocumentPreviews.current.set(o.id, { assetId: o.assetId!, metadata });
        else e.hydrateDocument(o.id, o.assetId!, metadata);
      })
      .catch(() => {
        /* Keep the attachment; the reader explains unsupported previews. */
      });
  };
  const openDocument = async (o: CanvasObject) => {
    if (readingDocumentId.current === o.id) return;
    await documentReader.current?.flush();
    if (editingSession.current) finishEdit();
    const current = engine.current?.objects.get(o.id);
    if (!current) return;
    engine.current?.setSelection([o.id]);
    setDocumentSession(++readingDocumentSession.current);
    readingDocumentId.current = o.id;
    documentViewKey.current = JSON.stringify(current);
    setReadingDocument({ ...current });
  };
  const saveDocument = async (o: CanvasObject, bytes: Uint8Array<ArrayBuffer>, excerpt: string) => {
    const e = engine.current;
    if (!e || !alive.current) throw Error('This board is no longer open.');
    if (e.objects.get(o.id)?.locked) throw Error('Unlock this document before editing it.');
    const asset = await invoke<Asset>('importAsset', { name: o.text || 'Document.txt', bytes });
    const current = e.objects.get(o.id);
    if (!alive.current || engine.current !== e || !current || current.assetId !== o.assetId)
      throw Error('This document changed while it was being edited. Reopen it before saving.');
    savingDocumentId.current = o.id;
    try {
      e.apply({
        upserts: [
          {
            ...current,
            assetId: asset.id,
            documentBytes: asset.bytes,
            documentExcerpt: excerpt,
            documentPreviewId: undefined,
            documentPageCount: undefined,
          },
        ],
        deleted: [],
      });
      await queue.current?.flush();
    } finally {
      savingDocumentId.current = null;
      syncDocumentView();
    }
  };
  const downloadDocument = async (o: CanvasObject) => {
    if (editingSession.current) finishEdit();
    if (readingDocumentId.current === o.id) await documentReader.current?.flush();
    const current = engine.current?.objects.get(o.id);
    if (current?.assetId) await downloadAsset(current.assetId, current.text || 'Document');
  };
  const openPdfWorkspace = async (objects: CanvasObject[], mode: 'preview' | 'edit') => {
    if (mode === 'edit' && objects.some((o) => engine.current?.objects.get(o.id)?.locked)) return;
    await documentReader.current?.flush();
    if (!alive.current || !engine.current) return;
    if (editingSession.current) finishEdit();
    const current = objects
      .map((o) => engine.current!.objects.get(o.id))
      .filter((o): o is CanvasObject => !!o);
    if (!current.length) return;
    closeDocument();
    engine.current.setSelection(current.map((o) => o.id));
    setPdfWorkspace({
      objects: current.map((o) => ({ ...o })),
      mode,
      session: ++pdfSession.current,
    });
  };
  const openImageViewer = async (o: CanvasObject) => {
    await documentReader.current?.flush();
    if (!alive.current || !engine.current) return;
    if (editingSession.current) finishEdit();
    const current = engine.current.objects.get(o.id);
    if (!current?.assetId || current.type !== 'image') return;
    closeDocument();
    engine.current.setSelection([current.id]);
    setPreviewingImage({ ...current });
  };
  const savePdfCopy = async (
    source: CanvasObject,
    bytes: Uint8Array<ArrayBuffer>,
    name: string,
    id: string,
    pageCount: number,
  ) => {
    const e = engine.current;
    if (!e || !alive.current) throw Error('This board is no longer open.');
    const asset = await invoke<Asset>('importAsset', { name, bytes });
    if (!alive.current || engine.current !== e) throw Error('This board is no longer open.');
    const anchor = e.objects.get(source.id) || source;
    const existing = e.objects.get(id);
    const copy: CanvasObject = {
      id,
      type: 'document',
      text: name,
      assetId: asset.id,
      x: anchor.x + anchor.width + 32,
      y: anchor.y,
      width: source.type === 'document' ? anchor.width : 320,
      height: source.type === 'document' ? anchor.height : 400,
      z: e.topZ() + 1,
      documentTitle:
        anchor.documentTitle || anchor.imageTitle
          ? `${anchor.documentTitle || anchor.imageTitle} — edited`
          : undefined,
      ...existing,
      documentMime: 'application/pdf',
      documentBytes: asset.bytes,
      documentPreviewId: undefined,
      documentExcerpt: undefined,
      documentPageCount: pageCount,
    };
    // A failed persistence retry reuses the same copy, rather than adding another attachment.
    if (!existing || existing.assetId !== asset.id)
      e.apply({ upserts: [{ ...copy, assetId: asset.id }], deleted: [] });
    await queue.current?.flush();
    refreshDocument(e.objects.get(id) || copy, e);
  };
  const listViewKey = useRef('');
  const createList = (point?: { x: number; y: number }) => {
    finishEdit();
    const e = engine.current;
    if (!e) return;
    const p = e.center();
    const o: CanvasObject = {
      id: uid(),
      type: 'list',
      text: 'Title',
      items: [
        { id: uid(), text: 'Item 1', checked: false },
        { id: uid(), text: 'Item 2', checked: false },
      ],
      x: point?.x ?? p.x - 160,
      y: point?.y ?? p.y - listHeight(2) / 2,
      width: 320,
      height: listHeight(2),
      z: e.topZ() + 1,
    };
    e.apply({ upserts: [o], deleted: [] });
    e.setSelection([o.id]);
    selectTool('select');
  };
  const canExportFromSelectionBar =
    selected.some((object) => object.type === 'frame') ||
    selected.filter((object) => object.type === 'image').length > 1;
  const exportSelectionButton = (
    <button
      key="export"
      className="icon-button"
      aria-label="Export selected"
      title="Export selected"
      disabled={!!exportProgress}
      onClick={() => setExportScope('selection')}
    >
      <Download size={16} />
    </button>
  );
  const bringToFrontButton = engine.current?.selectionOverlaps ? (
    <button
      key="front"
      className="icon-button"
      aria-label="Bring to front"
      onClick={() => {
        finishEdit();
        engine.current?.bringToFront();
        host.current?.focus();
      }}
    >
      <svg
        width={19}
        height={19}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 7H2v14h10v-2" />
        <path d="M7 2h7l3 3v11H7Z M14 2v3h3" />
        <path d="M15 21h2a4 4 0 0 0 4-4v-6m-2.5 2.5L21 11l2.5 2.5" />
      </svg>
    </button>
  ) : null;
  const selectedGalleryTarget = (): GalleryTarget | null => {
    if (galleryTarget.current) return { ...galleryTarget.current };
    const objects = engine.current?.selected;
    return objects?.length === 1 && objects[0].gallery && !objects[0].locked
      ? { galleryId: objects[0].id }
      : null;
  };
  const createGallery = (point?: { x: number; y: number }) => {
    finishEdit();
    const e = engine.current;
    if (!e) return;
    const p = e.center();
    const o: CanvasObject = {
      id: uid(),
      type: 'frame',
      text: 'Gallery',
      fontSize: 14,
      color: '#66758a',
      x: point?.x ?? p.x - 216,
      y: point?.y ?? p.y - 90,
      width: 432,
      height: 180,
      z: e.topZ() + 1,
      gallery: { ...defaultGallery },
    };
    e.apply({ upserts: [o], deleted: [] });
    e.setSelection([o.id]);
    selectTool('select');
    host.current?.focus();
  };
  const editingObject = useMemo(
    () => (editing ? fitTextObject(editing, draft) : null),
    [editing, draft],
  );
  const editingLayout = useMemo(
    () => (editingObject ? textLayout(editingObject, draft, camera.zoom) : null),
    [editingObject, draft, camera.zoom],
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
  const canFormat = (o: CanvasObject) =>
    (!o.frameLink &&
      !o.pdfComposer &&
      ['text', 'note', 'rect', 'ellipse', 'frame', 'arrow', 'list'].includes(o.type)) ||
    (o.type === 'image' && (!!o.imageTitle || editingSession.current?.object.id === o.id)) ||
    (o.type === 'document' && (!!o.documentTitle || editingSession.current?.object.id === o.id));
  const formattingSelection = (editingObject ? [editingObject] : selected).filter(canFormat);
  const toggleFormatting = (field: 'bold' | 'strikethrough') => {
    const session = editingSession.current;
    if (session) {
      session.object = { ...session.object, [field]: !session.object[field] };
      setEditing(session.object);
      editorRef.current?.focus();
    } else {
      const objects = engine.current?.selected.filter(canFormat) || [];
      if (!objects.length) return;
      const enabled = !objects.every((o) => o[field]);
      engine.current?.apply({
        upserts: objects.map((o) => fitTextObject({ ...o, [field]: enabled })),
        deleted: [],
      });
    }
  };
  const alignmentSelection = (editingObject ? [editingObject] : selected).filter(
    (o) => !['image', 'document', 'frame', 'link', 'arrow', 'highlight', 'list'].includes(o.type),
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
    engine.current?.setTool(value);
    setTool(value);
  };
  const startEdit = (o: CanvasObject) => {
    if (o.frameLink) return;
    if (engine.current?.objects.get(o.id)?.locked || o.type === 'highlight') return;
    if (o.type === 'list') {
      (
        window.document.querySelector(
          `[data-list-id="${o.id}"] textarea:not([readonly])`,
        ) as HTMLTextAreaElement | null
      )?.focus();
      return;
    }
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
    const value =
      (o.type === 'image' ? o.imageTitle : o.type === 'document' ? o.documentTitle : o.text) || '';
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
  const activate = (o: CanvasObject, intent?: 'title') => {
    if (o.frameLink) {
      void openOriginalFrame(o).catch(error);
      return;
    }
    if (engine.current?.objects.get(o.id)?.locked) return;
    if (intent === 'title') startEdit(o);
    else if (o.pdfComposer) setEditingComposerId(o.id);
    else if (o.type === 'document') void openDocument(o).catch(error);
    else if (o.type === 'image') void openImageViewer(o).catch(error);
    else if (o.type === 'list') setEditingListId(o.id);
    else if (o.type === 'link' && o.linkCompact) openLink(o.url!).catch(error);
    else if (o.type === 'link') openObject(o);
    else startEdit(o);
  };
  const previewRequests = useRef(new Map<string, Engine>());
  const refreshLink = (o: CanvasObject, e: Engine, autoplay = false) => {
    if (!window.canvas?.linkPreview || previewRequests.current.get(o.id) === e) return;
    previewRequests.current.set(o.id, e);
    e.setLinkLoading(o.id, true);
    void loadLinkPreview(
      o,
      (url) => window.canvas!.linkPreview(url),
      () => engine.current === e && !external.current,
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
    if (engine.current?.objects.get(o.id)?.locked) return;
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
      fontSize:
        type === 'frame' ? 14 : type === 'note' ? 21 : type === 'text' ? lastTextSize.current! : 24,
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
      } else if (editing.type === 'image' || editing.type === 'document') {
        const current = engine.current.objects.get(editing.id);
        const next =
          editing.type === 'document' && current
            ? withDocumentTitle(current, editing, draft)
            : { ...editing, imageTitle: draft.trim() };
        if (current && JSON.stringify(next) !== JSON.stringify(current))
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
    documentAbort.current = new AbortController();
    queue.current = new SaveQueue(doc.board.id, doc.revision, onSave, (args) =>
      invoke('patchBoard', { ...args }),
    );
    cameraQueue.current = new CameraSaveQueue(
      doc.camera,
      (camera) => invoke('saveCamera', { id: doc.board.id, camera }),
      error,
    );
    const fitted = doc.objects.map((o) =>
      o.locked
        ? o
        : o.type === 'text'
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
      composers: (objects, camera) => {
        const key = objects.length ? JSON.stringify([objects, camera]) : '';
        if (key !== composerViewKey.current) {
          composerViewKey.current = key;
          setComposerView({ objects, camera: { ...camera } });
        }
      },
      objectDrag: (objects, point) => {
        const target =
          point && objects.length && objects.every(isPdfComposerInput)
            ? pdfComposerTargetAt(e.all, point, new Set(objects.map((o) => o.id)))
            : null;
        setPdfDropTarget((previous) => (previous?.id === target?.id ? previous : target));
      },
      objectDrop: (objects, point) => {
        if (external.current || !objects.length || !objects.every(isPdfComposerInput)) return false;
        const target = pdfComposerTargetAt(e.all, point, new Set(objects.map((o) => o.id)));
        if (!target) return false;
        void addToComposer(target.id, () => Promise.resolve(objects)).catch(error);
        return true;
      },
      lists: (objects, camera) => {
        const key = objects.length ? JSON.stringify([objects, camera]) : '';
        if (key !== listViewKey.current) {
          listViewKey.current = key;
          setListView({ objects, camera: { ...camera } });
        }
      },
      edit: (edit) => {
        if (!syncingExternal.current) queue.current!.enqueue(edit);
        setCount(e.objects.size);
        syncDocumentView();
        void refreshLinkedBoards.current();
      },
      camera: (c) => {
        setCamera(c);
        cameraQueue.current!.enqueue(c);
      },
      selection: (objects) => {
        if (objects.length === 1) rememberTextSize(objects[0]);
        setSelected(objects);
        const id = readingDocumentId.current,
          session = readingDocumentSession.current;
        if (id && !objects.some((o) => o.id === id)) {
          void documentReader.current
            ?.flush()
            .then(() => {
              if (readingDocumentId.current === id) closeDocument(session);
            })
            .catch(error);
        }
      },
      hover: hoverImage,
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
        syncDocumentView();
        for (const o of e.all) {
          if (o.type !== 'document') continue;
          const b = objectBounds(o),
            c = e.camera;
          if (
            (b.x + b.width) * c.zoom + c.x >= 0 &&
            b.x * c.zoom + c.x <= viewport.width &&
            (b.y + b.height) * c.zoom + c.y >= 0 &&
            b.y * c.zoom + c.y <= viewport.height
          )
            refreshDocument(o, e);
        }
      },
      activate,
      create,
      context: (p) => setMenu(p),
      highlightSize: (size) => setHighlightStyle((style) => ({ ...style, size })),
      ready: () => {
        setReady(true);
        onReady();
        window.canvas?.rendererReady();
      },
      error: onError,
    });
    engine.current = e;
    const applyInput = () => {
      const { wheel, zoomSpeed, snapping } = getPreferences();
      e.setInputPreferences({ wheel, zoomSpeed, snapping });
    };
    applyInput();
    e.setReadOnly(readOnlyRef.current);
    const stopInput = subscribePreferences(applyInput);
    e.setFrameBoard(doc.board.id, fitted, true);
    let frameRefresh: Promise<void> | null = null;
    let framesDisposed = false;
    const refreshFrames = (): Promise<void> => {
      if (frameRefresh) return frameRefresh;
      frameRefresh = (async () => {
        const boards = new Map<string, CanvasObject[] | null>([[doc.board.id, e.all]]);
        const visited = new Set<string>();
        const scan = async (objects: CanvasObject[], depth = 0) => {
          if (depth >= 12 || framesDisposed) return;
          for (const object of objects)
            if (object.frameLink) {
              const { boardId, frameId } = object.frameLink;
              const key = `${boardId}/${frameId}`;
              if (visited.has(key) || visited.size >= 256) continue;
              visited.add(key);
              if (!boards.has(boardId)) {
                try {
                  const source = await invoke<Document>('loadBoard', { id: boardId });
                  boards.set(boardId, source.board.trashed ? null : source.objects);
                } catch {
                  boards.set(boardId, null);
                }
                if (framesDisposed) return;
                e.setFrameBoard(boardId, boards.get(boardId)!);
              }
              const all = boards.get(boardId);
              const source = all?.find(
                (o) => o.id === frameId && o.type === 'frame' && !o.frameLink,
              );
              if (source)
                await scan(
                  all!.filter((o) => o.id !== source.id && containsObject(source, o)),
                  depth + 1,
                );
            }
        };
        await scan(e.all);
      })().finally(() => {
        frameRefresh = null;
      });
      return frameRefresh;
    };
    refreshLinkedBoards.current = refreshFrames;
    void refreshFrames();
    const frameTimer = window.setInterval(() => {
      void refreshFrames();
    }, 1500);
    e.setHighlightStyle(highlightStyleRef.current);
    const recoverPreviews = () => {
      for (const o of e.all) if (o.type === 'link' && !o.assetId) refreshLink(o, e);
    };
    recoverPreviews();
    window.addEventListener('online', recoverPreviews);
    return () => {
      framesDisposed = true;
      window.clearInterval(frameTimer);
      refreshLinkedBoards.current = async () => {};
      window.removeEventListener('online', recoverPreviews);
      alive.current = false;
      stopInput();
      documentAbort.current.abort();
      e.destroy();
      engine.current = null;
      queue.current?.flush().catch(error);
      cameraQueue.current?.flush().catch(error);
    };
  }, []);
  useLayoutEffect(() => {
    engine.current?.setEditingPreview(editingObject);
  }, [editingObject]);
  useEffect(() => {
    if (!ready || !searchTarget) return;
    if (!engine.current?.focusObject(searchTarget.objectId))
      onError('This item is no longer on the board.');
  }, [ready, searchTarget]);
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
    if (editing.type === 'text' && !editing.textBox && editingPlacement) {
      // The selection hugs the ink; the native textarea still needs its full
      // line boxes so accents, descenders and the caret remain visible.
      el.style.height = `${editingPlacement.height * camera.zoom}px`;
      return;
    }
    if (
      (editing.centerY || ['frame', 'image', 'document'].includes(editing.type)) &&
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
  async function addAssets(
    assets: Asset[],
    point?: { x: number; y: number },
    target?: GalleryTarget | null,
  ) {
    const e = engine.current;
    if (!e || !alive.current) return;
    const p = point || e.center();
    const top = e.topZ();
    const objects = assets.map((a, i) => {
      const isDocument = !a.mime.startsWith('image/') && !a.mime.startsWith('video/');
      const width = isDocument ? 320 : Math.min(a.width, 480),
        height = isDocument ? 400 : (width * a.height) / a.width;
      return {
        id: uid(),
        type: isDocument ? 'document' : a.mime.startsWith('video/') ? 'video' : 'image',
        assetId: a.id,
        x: p.x + i * 36 - width / 2,
        y: p.y + i * 36 - height / 2,
        width,
        height,
        z: top + i + 1,
        text: a.name,
        ...(isDocument ? { documentMime: a.mime, documentBytes: a.bytes } : {}),
      } as CanvasObject;
    });
    const edit = insertGalleryImages(e.objects, objects, target);
    e.apply(edit);
    const gallery =
      target && edit.upserts.some((o) => o.galleryId === target.galleryId)
        ? target.galleryId
        : null;
    e.setSelection(gallery ? [gallery] : objects.map((o) => o.id));
    for (const o of objects) refreshDocument(o, e);
  }
  async function performImport(
    load: () => Promise<Asset[]>,
    point?: { x: number; y: number },
    target: GalleryTarget | null = selectedGalleryTarget(),
  ) {
    setBusy((n) => n + 1);
    const task = (async () => {
      try {
        await addAssets(await load(), point, target);
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
  function composerTask(action: (e: Engine, signal: AbortSignal) => Promise<void>) {
    const e = engine.current,
      signal = documentAbort.current.signal;
    if (!e || external.current)
      return Promise.reject(Error('The board is busy. Please try again.'));
    setBusy((n) => n + 1);
    const task = composerTail.current
      .then(async () => {
        signal.throwIfAborted();
        if (!alive.current || engine.current !== e) throw Error('This board is no longer open.');
        await action(e, signal);
      })
      .finally(() => {
        if (alive.current) {
          setBusy((n) => n - 1);
          setComposerProgress('');
        }
      });
    composerTail.current = task.catch(() => {});
    return task;
  }
  function addToComposer(targetId: string | null, load: () => Promise<CanvasObject[]>) {
    return composerTask(async (e, signal) => {
      setComposerProgress('Preparing PDF workspace…');
      await documentReader.current?.flush();
      if (editingSession.current) finishEdit();
      const incoming = await load();
      signal.throwIfAborted();
      if (!incoming.length || !incoming.every(isPdfComposerInput))
        throw Error('Drop convertible documents or images into this workspace.');
      const target = targetId ? e.objects.get(targetId) : undefined;
      if (targetId && !target) throw Error('The PDF workspace was removed.');
      const existing = target?.pdfComposer;
      const sources: CanvasObject[] = existing
        ? existing.sources.map((source) => ({
            id: source.id,
            assetId: source.assetId,
            type: source.kind === 'pdf' ? 'document' : 'image',
            text: source.name,
            documentMime: source.kind === 'pdf' ? 'application/pdf' : undefined,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            z: 0,
          }))
        : target
          ? [target]
          : [];
      const converted: CanvasObject[] = [];
      for (const object of [...sources, ...incoming]) {
        signal.throwIfAborted();
        if (
          object.type === 'document' &&
          documentKind(object.text || '', object.documentMime) !== 'pdf'
        )
          setComposerProgress(`Converting ${object.text || 'document'}…`);
        if (needsOfficeConversion(object)) {
          if (!window.canvas) throw Error('Office conversion is available in the desktop app.');
          const asset = await window.canvas.convertOffice({
            id: object.assetId!,
            name: object.text || 'Document',
          });
          signal.throwIfAborted();
          converted.push({
            ...object,
            assetId: asset.id,
            documentMime: 'application/pdf',
            documentBytes: asset.bytes,
            documentPreviewId: undefined,
            documentPageCount: undefined,
            documentExcerpt: undefined,
          });
        } else converted.push(...(await convertComposerInputs([object], signal)));
      }
      setComposerProgress('Preparing page previews…');
      const prepared = await prepareComposerSources(converted, signal);
      signal.throwIfAborted();
      if (!alive.current || engine.current !== e) return;
      const current = targetId ? e.objects.get(targetId) : undefined;
      if (
        targetId &&
        (!current || current.assetId !== target?.assetId || !!current.pdfComposer !== !!existing)
      )
        throw Error('The PDF target changed. Please drop the files again.');
      let frame: CanvasObject;
      if (current?.pdfComposer) {
        frame = {
          ...current,
          pdfComposer: appendPdfComposer(current.pdfComposer, prepared.slice(sources.length)),
        };
      } else {
        const anchor = current || incoming[0];
        frame = {
          id: uid(),
          type: 'frame',
          x: anchor.x,
          y: anchor.y,
          width: Math.max(480, Math.min(880, prepared.length * 216 + 32)),
          height: 520,
          z: e.topZ() + 1,
          text: 'PDF workspace',
          pdfComposer: createPdfComposer(prepared),
        };
      }
      e.apply({ upserts: [frame], deleted: [] });
      e.setSelection([frame.id]);
      setEditingComposerId(frame.id);
    });
  }
  function composerFiles(id: string, files: File[]) {
    return addToComposer(id, async () => {
      if (!files.every(convertibleFile))
        throw Error('Drop convertible documents or images into this workspace.');
      const assets = await importFiles(files);
      return assets.map(
        (asset) =>
          ({
            id: uid(),
            type: asset.mime.startsWith('image/') ? 'image' : 'document',
            assetId: asset.id,
            text: asset.name,
            documentMime: asset.mime,
            documentBytes: asset.bytes,
            x: 0,
            y: 0,
            width: 320,
            height: 400,
            z: 0,
          }) as CanvasObject,
      );
    });
  }
  async function exportComposer(id: string, columnId: string) {
    const composer = engine.current?.objects.get(id)?.pdfComposer;
    const column = composer?.columns.find((item) => item.id === columnId);
    if (!composer || !column) throw Error('The PDF workspace was removed.');
    setPdfExport({ composer: structuredClone(composer), columnId, name: column.name });
  }
  function removeImageBackground(object: CanvasObject) {
    if (engine.current?.objects.get(object.id)?.locked) return;
    const currentEngine = engine.current;
    if (!currentEngine || !object.assetId || backgroundJob.current || external.current) return;
    if (editingSession.current) finishEdit();
    if (cropSession.current) finishCrop();
    setRemovingBackground(true);
    const task = (async () => {
      try {
        const asset = await invoke<Asset>('removeBackground', { id: object.assetId });
        // Let an in-progress drag, crop or title edit commit its original snapshot
        // before replacing pixels; otherwise its final commit could undo the cutout.
        while (
          alive.current &&
          engine.current === currentEngine &&
          (currentEngine.hasActiveGesture ||
            editingSession.current?.object.id === object.id ||
            cropSession.current?.object.id === object.id)
        )
          await new Promise((resolve) => setTimeout(resolve, 32));
        if (!alive.current || engine.current !== currentEngine) return;
        const current = currentEngine.objects.get(object.id);
        if (
          !alive.current ||
          engine.current !== currentEngine ||
          !current ||
          current.assetId !== object.assetId
        )
          return;
        // Preserve any repositioning, crop or title edits made while processing.
        currentEngine.apply({ upserts: [{ ...current, assetId: asset.id }], deleted: [] });
      } catch (e) {
        if (alive.current) error(e);
      } finally {
        backgroundJob.current = null;
        if (alive.current) setRemovingBackground(false);
      }
    })();
    backgroundJob.current = task;
  }
  const flush = async (waitForExport = true) => {
    await pdfReader.current?.flush();
    await documentReader.current?.flush();
    arrowDraft.current?.flush();
    engine.current?.stopCameraAnimation();
    if (editingSession.current) finishEdit();
    if (cropSession.current) finishCrop();
    await Promise.all([...imports.current]);
    await composerTail.current;
    await backgroundJob.current;
    // A cut commits its deletion only after the clipboard write succeeds.
    // Finish that mutation before board switching or close flushes saved edits.
    await clipboardTask.current?.catch(() => {});
    await queue.current?.flush();
    await cameraQueue.current?.flush();
    if (waitForExport) await exportTask.current;
  };
  useImperativeHandle(ref, () => ({
    prepareExternal: async () => {
      external.current = true;
      engine.current?.prepareExternalEdit();
      await flush();
    },
    finishExternal: (updated) => {
      const e = engine.current;
      if (updated && e) {
        const ids = new Set(updated.objects.map((o) => o.id));
        const edit = {
          upserts: updated.objects.filter(
            (o) => JSON.stringify(e.objects.get(o.id)) !== JSON.stringify(o),
          ),
          deleted: e.all.filter((o) => !ids.has(o.id)).map((o) => o.id),
        };
        queue.current = new SaveQueue(doc.board.id, updated.revision, onSave, (args) =>
          invoke('patchBoard', { ...args }),
        );
        syncingExternal.current = true;
        try {
          if (edit.upserts.length || edit.deleted.length) e.acceptExternalEdit(edit);
        } finally {
          syncingExternal.current = false;
        }
      }
      external.current = false;
      if (e)
        for (const [id, preview] of deferredDocumentPreviews.current)
          e.hydrateDocument(id, preview.assetId, preview.metadata);
      deferredDocumentPreviews.current.clear();
    },
    flush,
    importMedia,
    fit: () => engine.current?.fit(),
  }));
  const pasteObjects = (
    objects: CanvasObject[],
    target?: GalleryTarget | null,
    point?: { x: number; y: number },
  ) => {
    const e = engine.current;
    if (!e || !objects.length) return;
    const groups = new Map<string, string>();
    const objectIds = new Map(objects.map((o) => [o.id, uid()]));
    const top = e.topZ();
    const bounds =
      point && objects.some((o) => o.type === 'image' || o.frameLink) ? boundsOf(objects) : null;
    const offset =
      point && bounds
        ? { x: point.x - bounds.x - bounds.width / 2, y: point.y - bounds.y - bounds.height / 2 }
        : { x: 30, y: 30 };
    const copies = objects.map((o, i) => {
      if (o.groupId && !groups.has(o.groupId)) groups.set(o.groupId, uid());
      return {
        ...o,
        id: objectIds.get(o.id)!,
        groupId: o.groupId ? groups.get(o.groupId) : undefined,
        galleryId: o.galleryId ? objectIds.get(o.galleryId) : undefined,
        galleryIndex: o.galleryId && objectIds.has(o.galleryId) ? o.galleryIndex : undefined,
        galleryRow: o.galleryId && objectIds.has(o.galleryId) ? o.galleryRow : undefined,
        galleryColumn: o.galleryId && objectIds.has(o.galleryId) ? o.galleryColumn : undefined,
        x: o.x + offset.x,
        y: o.y + offset.y,
        z: top + i + 1,
      };
    });
    const edit = insertGalleryImages(e.objects, copies, target);
    e.apply(edit);
    const gallery =
      target && edit.upserts.some((o) => o.galleryId === target.galleryId)
        ? target.galleryId
        : null;
    e.setSelection(gallery ? [gallery] : copies.filter((o) => !o.galleryId).map((o) => o.id));
    for (const o of copies) if (o.type === 'link' && !o.assetId) refreshLink(o, e);
  };
  const copyDesktop = (objects: CanvasObject[], cut = false) => {
    const e = engine.current;
    const snapshot = structuredClone(selectionWithGalleryImages(objects, e?.all || []));
    const task = window.canvas!.copyObjects(snapshot).then((copied) => {
      if (copied && cut && alive.current && engine.current === e)
        e?.apply({ upserts: [], deleted: snapshot.map((o) => o.id) });
      return copied;
    });
    setCopying(true);
    clipboardTask.current = task;
    void task.catch(error).finally(() => {
      if (clipboardTask.current === task) {
        clipboardTask.current = null;
        if (alive.current) setCopying(false);
      }
    });
    return task;
  };
  useEffect(() => {
    const rememberPointer = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    const typing = () =>
      !!editingSession.current ||
      !!document.querySelector('.pdf-workspace, .image-viewer') ||
      !!(document.activeElement as HTMLElement)?.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role=dialog]',
      );
    const paste = async (event: ClipboardEvent) => {
      if (typing() || readOnlyRef.current) return;
      const e = engine.current;
      if (!e) return;
      const data = event.clipboardData;
      if (!data) return;
      event.preventDefault();
      // Snapshot event data before awaiting a pending native image copy.
      const files = [...data.files];
      const json = data.getData('application/x-terra-board-objects');
      const text = data.getData('text/plain');
      const target = pasteTarget(),
        point = pastePoint();
      if (window.canvas) {
        try {
          await clipboardTask.current;
          const objects = await window.canvas.clipboardObjects();
          if (!alive.current || engine.current !== e) return;
          if (objects) {
            pasteObjects(clipboardObjects(objects), target, point);
            return;
          }
        } catch (reason) {
          error(reason);
          return;
        }
      }
      if (json) {
        try {
          pasteObjects(clipboardObjects(JSON.parse(json)), target, point);
        } catch {
          onError('The copied objects could not be pasted.');
        }
        return;
      }
      if (files.length) {
        await performImport(() => importFiles(files), point, target);
        return;
      }
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
        fontSize: url ? 22 : lastTextSize.current!,
        ...(url ? { url } : {}),
      };
      e.apply({
        upserts: [url ? fitTextObject(o) : fitTextToView(o, visibleBoardArea(e))],
        deleted: [],
      });
      e.setSelection([o.id]);
      if (url) enrichLink(o, e);
    };
    const copyEvent = (event: ClipboardEvent) => {
      if (typing() || !engine.current?.selected.length) {
        window.canvas?.cancelCopy();
        return;
      }
      event.preventDefault();
      const objects = engine.current.clipboardSelection;
      if (window.canvas) {
        void copyDesktop(objects);
        return;
      }
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
      const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
      const command = activeCommand(event, 'board');
      if (readOnlyRef.current) {
        if (command === 'view.fit' && !event.repeat) e.fit();
        return;
      }
      if (window.canvas && mod && ['KeyC', 'KeyX'].includes(event.code) && e.selected.length) {
        event.preventDefault();
        if (!event.repeat) void copyDesktop(e.selected, event.code === 'KeyX');
      } else if (window.canvas && mod && event.code === 'KeyV' && clipboardTask.current) {
        // Chromium emits no paste event for an empty clipboard. A fast Ctrl+C,
        // Ctrl+V must still wait for an image that is currently being prepared.
        event.preventDefault();
        const target = pasteTarget(),
          point = pastePoint();
        void clipboardTask.current
          .then(async (copied) => {
            if (!copied) return;
            const objects = await window.canvas!.clipboardObjects();
            if (objects && alive.current && engine.current === e)
              pasteObjects(clipboardObjects(objects), target, point);
          })
          .catch(error);
      } else if (event.key === 'Escape') {
        setMenu(null);
        e.setSelection([]);
        selectTool('select');
      } else if (command) {
        const tool = tools.find((t) => t.command === command);
        // The radial menu owns its own trigger.
        if (command === 'view.radial') return;
        event.preventDefault();
        if (tool) {
          if (!event.repeat) selectTool(tool.id);
          return;
        }
        if (command === 'edit.bold') toggleFormatting('bold');
        else if (command === 'edit.undo') e.undo();
        else if (command === 'edit.redo') e.redo();
        else if (command === 'edit.selectAll') e.setSelection(e.all.map((o) => o.id));
        else if (command === 'edit.duplicate') e.duplicate();
        else if (command === 'edit.group') e.group();
        else if (command === 'edit.ungroup') e.ungroup();
        else if (command === 'edit.save') queue.current?.flush().catch(error);
        else if (command === 'edit.delete') e.deleteSelected();
        else if (command === 'view.fit' && !event.repeat) e.fit();
      }
    };
    window.addEventListener('paste', paste);
    window.addEventListener('pointermove', rememberPointer, true);
    window.addEventListener('copy', copyEvent);
    const cut = (event: ClipboardEvent) => {
      if (typing() || readOnlyRef.current) {
        window.canvas?.cancelCopy();
        return;
      }
      if (window.canvas && engine.current?.selected.length) {
        event.preventDefault();
        void copyDesktop(engine.current.selected, true);
        return;
      }
      copyEvent(event);
      engine.current?.deleteSelected();
    };
    window.addEventListener('cut', cut);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('paste', paste);
      window.removeEventListener('pointermove', rememberPointer, true);
      window.removeEventListener('copy', copyEvent);
      window.removeEventListener('cut', cut);
      window.removeEventListener('keydown', key);
    };
  }, []);
  async function drop(e: React.DragEvent) {
    e.preventDefault();
    if (readOnlyRef.current) return;
    setPdfDropTarget(null);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const r = host.current!.getBoundingClientRect(),
      point = engine.current!.screenPoint({ x: e.clientX - r.left, y: e.clientY - r.top });
    const target = pdfComposerTargetAt(engine.current!.all, point);
    if (target && files.every(convertibleFile)) {
      await composerFiles(target.id, files).catch(error);
      return;
    }
    await performImport(() => importFiles(files), point);
  }
  function startExport(format: ExportFormat, quality: ExportQuality) {
    if (exportTask.current || !exportScope) return;
    const scope = exportScope;
    setExportScope(null);
    setExportResult(null);
    const progress = (value: number, label: string) => setExportProgress({ value, label });
    progress(0, 'Preparing canvas…');
    const task = (async () => {
      let canvas: HTMLCanvasElement | undefined;
      try {
        await flush(false);
        const current = engine.current;
        if (!current) throw Error('The canvas is not ready to export.');
        await refreshLinkedBoards.current();
        const rendered = await current.exportCanvas(
          scope,
          progress,
          mediaUrl,
          quality,
          assetDimensions,
        );
        canvas = rendered.canvas;
        const blob = await encodeExport(canvas, format, rendered.pageSize);
        const name = `${doc.board.name} - ${scope === 'selection' ? 'selection' : 'visible area'}`;
        progress(90, window.canvas ? 'Choose a location, then save…' : 'Preparing download…');
        // Let the final progress stage paint before opening the native dialog.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const result = window.canvas
          ? await window.canvas.exportImage({
              format,
              name,
              bytes: new Uint8Array(await blob.arrayBuffer()),
            })
          : (() => {
              download(blob, `${name}.${format}`);
              return { name: `${name}.${format}`, url: URL.createObjectURL(blob) };
            })();
        if (result)
          setExportResult({
            ...result,
            detail: `${canvas.width} × ${canvas.height} px${rendered.limited ? ' · Sized to the export limit' : ''}`,
          });
      } catch (e) {
        error(e);
      } finally {
        if (canvas) canvas.width = canvas.height = 1;
        setExportProgress(null);
      }
    })();
    exportTask.current = task;
    void task.finally(() => {
      exportTask.current = null;
    });
  }
  const selectionLocked = !!engine.current?.selectionLocked;
  const lockButton = (
    <ObjectLockButton
      key="lock"
      locked={selectionLocked}
      selectionKey={selected
        .map((o) => o.id)
        .sort()
        .join(',')}
      onChange={(locked) => {
        finishEdit();
        arrowDraft.current?.flush();
        setEditingListId(null);
        setEditingComposerId(null);
        const e = engine.current;
        if (!e) return;
        const ids = [...e.selection].sort().join(',');
        const applyLock = () => {
          if (alive.current && engine.current === e && [...e.selection].sort().join(',') === ids)
            e.setSelectionLocked(locked);
        };
        // A text attachment can have an unsaved draft in its reader. Save it
        // before making the attachment read-only, keeping failures editable.
        if (locked && documentReader.current)
          void documentReader.current.flush().then(applyLock).catch(error);
        else applyLock();
      }}
    />
  );
  const contextItems: (MenuItem | null)[] = [
    ...(selected.length === 1 && selected[0].type === 'frame'
      ? [
          {
            label: 'Find usages',
            icon: <Frame />,
            action: () =>
              setUsageTarget({
                source: frameReference(doc.board.id, selected[0]),
                name: selected[0].text || 'Untitled frame',
              }),
          },
          {
            label: 'Copy frame link',
            icon: <Link2 />,
            action: () => {
              void copyFrameLink(selected[0]).catch(error);
            },
          },
          ...(selected[0].frameLink
            ? [
                {
                  label: 'Open original frame',
                  icon: <ExternalLink />,
                  action: () => {
                    void openOriginalFrame(selected[0]).catch(error);
                  },
                },
              ]
            : []),
        ]
      : []),
    {
      label: 'Paste linked frame',
      icon: <Link2 />,
      action: pasteFrameLink,
      disabled: !frameClipboard,
    },
    null,
    ...(activeGallery
      ? [
          { label: 'Rename gallery', icon: <Type />, action: () => startEdit(activeGallery) },
          {
            label: 'Release images',
            icon: <Ungroup />,
            action: () => engine.current?.apply({ upserts: [], deleted: [activeGallery.id] }),
          },
          null,
        ]
      : []),
    ...(selected.length === 1 && selected[0].galleryId
      ? [
          {
            label: 'Remove from gallery',
            icon: <Ungroup />,
            action: () =>
              engine.current?.apply({
                upserts: [
                  {
                    ...selected[0],
                    galleryId: undefined,
                    galleryIndex: undefined,
                    galleryRow: undefined,
                    galleryColumn: undefined,
                  },
                ],
                deleted: [],
              }),
          },
          null,
        ]
      : []),
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
    ...(selected.length === 1 && selected[0].type === 'document'
      ? [
          {
            label: selected[0].documentTitle?.trim() ? 'Edit title' : 'Add title',
            icon: <Type />,
            action: () => startEdit(selected[0]),
          },
          {
            label: 'Preview document',
            icon: <FileText />,
            action: () => {
              void openDocument(selected[0]).catch(error);
            },
          },
          ...(documentKind(selected[0].text || '', selected[0].documentMime) === 'pdf'
            ? [
                {
                  label: 'Full PDF preview',
                  icon: <Maximize2 />,
                  action: () => {
                    void openPdfWorkspace(selected, 'preview').catch(error);
                  },
                },
                {
                  label: 'Edit PDF',
                  icon: <Pencil />,
                  action: () => {
                    void openPdfWorkspace(selected, 'edit').catch(error);
                  },
                },
              ]
            : isPdfComposerInput(selected[0])
              ? [
                  {
                    label: 'Convert to PDF',
                    icon: <FileText />,
                    action: () => {
                      void addToComposer(null, () => Promise.resolve(selected)).catch(error);
                    },
                  },
                ]
              : []),
          {
            label: 'Download',
            icon: <Download />,
            action: () => {
              void downloadDocument(selected[0]).catch(error);
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
          {
            label: 'Full image preview',
            icon: <Maximize2 />,
            action: () => {
              void openImageViewer(selected[0]).catch(error);
            },
          },
          {
            label: 'Convert to PDF',
            icon: <FileText />,
            action: () => {
              void openPdfWorkspace(selected, 'edit').catch(error);
            },
          },
          {
            label: removingBackground ? 'Removing background…' : 'Remove background',
            icon: <Eraser />,
            action: () => removeImageBackground(selected[0]),
            disabled: removingBackground,
          },
          ...(window.canvas
            ? [
                {
                  label: 'Copy as image',
                  icon: <Copy />,
                  action: () => {
                    void copyDesktop([selected[0]]);
                  },
                },
              ]
            : []),
          null,
        ]
      : []),
    ...(selected.length > 1 && selected.every(isPdfComposerInput)
      ? [
          {
            label: selected.every((o) => o.type === 'image') ? 'Convert to PDF' : 'Combine PDFs',
            icon: <Files />,
            action: () => {
              void addToComposer(null, () => Promise.resolve(selected)).catch(error);
            },
          },
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
    {
      label: 'Export selected…',
      icon: <Download />,
      action: () => setExportScope('selection'),
      disabled: !selected.length || !!exportProgress,
    },
    {
      label: 'Export visible area…',
      icon: <Download />,
      action: () => setExportScope('visible'),
      disabled: !!exportProgress,
    },
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
    <div
      className="whiteboard"
      onPointerLeave={() => hoverImage(null)}
      onPointerMove={(event) => {
        if (!(event.target as Element).closest('.canvas-surface,.gallery-insertion'))
          hoverImage(null);
      }}
    >
      {doc.board.backgroundAssetId && (
        <BackgroundImage
          key={doc.board.backgroundAssetId}
          assetId={doc.board.backgroundAssetId}
          appearance={backgroundPreview || doc.board.backgroundAppearance}
        />
      )}
      <div
        ref={host}
        tabIndex={0}
        aria-label="Whiteboard"
        className={'canvas-surface tool-' + tool}
        style={doc.board.backgroundAssetId ? { backgroundImage: 'none' } : undefined}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const canvas = engine.current;
            if (canvas)
              setPdfDropTarget(
                pdfComposerTargetAt(
                  canvas.all,
                  canvas.screenPoint({ x: e.clientX - r.left, y: e.clientY - r.top }),
                ),
              );
            hoverImage(
              engine.current?.galleryImageAt({ x: e.clientX - r.left, y: e.clientY - r.top }) ||
                null,
            );
          }
        }}
        onDrop={drop}
        onDragLeave={() => setPdfDropTarget(null)}
      />
      {!ready && <div className="canvas-loading">Opening canvas…</div>}
      {pdfDropTarget &&
        (() => {
          const origin = localToWorld(pdfDropTarget, { x: 0, y: 0 });
          return (
            <div
              className="pdf-composer-drop-target"
              style={{
                position: 'absolute',
                pointerEvents: 'none',
                left: origin.x * camera.zoom + camera.x,
                top: origin.y * camera.zoom + camera.y,
                width: pdfDropTarget.width,
                height: pdfDropTarget.height,
                transformOrigin: '0 0',
                transform: `scale(${camera.zoom}) rotate(${pdfDropTarget.rotation || 0}deg)`,
              }}
            >
              <ListEditOutline width={pdfDropTarget.width} height={pdfDropTarget.height} />
            </div>
          );
        })()}
      <CanvasPdfComposers
        objects={composerView.objects}
        camera={composerView.camera}
        selectedIds={selected.map((o) => o.id)}
        editingId={editingComposerId}
        onEdit={setEditingComposerId}
        interactive={tool === 'select'}
        onSelect={(id) => {
          finishEdit();
          engine.current?.setSelection([id]);
        }}
        onUpdate={(object) => {
          const e = engine.current,
            current = e?.objects.get(object.id);
          if (e && current?.pdfComposer && !external.current)
            e.apply({ upserts: [{ ...current, pdfComposer: object.pdfComposer }], deleted: [] });
        }}
        onPointerDown={(event) => engine.current?.beginOverlayPointer(event.nativeEvent)}
        onFiles={composerFiles}
        onExport={exportComposer}
        onUndo={() => engine.current?.undo()}
        onRedo={() => engine.current?.redo()}
        onError={error}
      />
      <CanvasLists
        view={listView}
        editingId={editingListId}
        onEdit={setEditingListId}
        host={host.current}
        interactive={tool === 'select'}
        beginPointer={(event) => engine.current?.beginOverlayPointer(event)}
        selected={selected.map((o) => o.id)}
        select={(id) => {
          finishEdit();
          engine.current?.setSelection([id]);
        }}
        update={(o) => {
          if (engine.current?.objects.get(o.id)?.locked) return;
          engine.current?.apply({ upserts: [o], deleted: [] });
          setListView((view) => ({
            ...view,
            objects: view.objects.map((item) => (item.id === o.id ? o : item)),
          }));
        }}
      />
      {readingDocument && (
        <DocumentReader
          key={`${readingDocument.id}:${readingDocument.assetId}`}
          ref={documentReader}
          object={readingDocument}
          camera={camera}
          onSave={saveDocument}
          onClose={() => closeDocument(documentSession)}
          onDownload={() => downloadDocument(readingDocument)}
          onExpandPdf={(edit) => {
            void openPdfWorkspace([readingDocument], edit ? 'edit' : 'preview').catch(error);
          }}
          onError={error}
        />
      )}
      {pdfWorkspace && (
        <PdfWorkspace
          key={pdfWorkspace.session}
          ref={pdfReader}
          objects={pdfWorkspace.objects}
          mode={pdfWorkspace.mode}
          onSave={(bytes, name, id, count) =>
            savePdfCopy(pdfWorkspace.objects[0], bytes, name, id, count)
          }
          onClose={() => {
            if (pdfSession.current !== pdfWorkspace.session) return;
            pdfSession.current++;
            setPdfWorkspace(null);
            host.current?.focus();
          }}
        />
      )}
      {previewingImage && (
        <ImageViewer
          key={`${previewingImage.id}:${previewingImage.assetId}`}
          object={previewingImage}
          onClose={() => {
            setPreviewingImage(null);
            host.current?.focus();
          }}
          onDownload={async () => {
            await downloadAsset(previewingImage.assetId!, previewingImage.text || 'Image');
          }}
        />
      )}
      {ready && !count && (
        <div className="empty-canvas">
          <h1>Room for your next idea.</h1>
          <p>Paste an image, drop a file, or add a note.</p>
          <button className="button" onClick={importMedia}>
            <ImagePlus size={16} />
            Add files
          </button>
        </div>
      )}
      {(busy > 0 || copying || removingBackground) && (
        <div className="import-status" role="status">
          <span>
            {removingBackground
              ? 'Removing background…'
              : copying
                ? 'Copying to clipboard…'
                : officeProgress || composerProgress || 'Importing files…'}
          </span>
          <div
            className="import-progress-track"
            role="progressbar"
            aria-label="File operation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              officeProgress.match(/(\d+)%/)
                ? Number(officeProgress.match(/(\d+)%/)![1])
                : undefined
            }
            data-indeterminate={!officeProgress.match(/(\d+)%/) || undefined}
          >
            <span
              style={
                officeProgress.match(/(\d+)%/)
                  ? { width: `${officeProgress.match(/(\d+)%/)![1]}%` }
                  : undefined
              }
            />
          </div>
        </div>
      )}
      {hoverImageId &&
        engine.current?.objects.get(hoverImageId)?.galleryId &&
        !editing &&
        !cropping && (
          <div className="gallery-insertion" ref={galleryTargetsRef}>
            {(['right', 'below'] as const).map((direction) => (
              <button
                key={direction}
                className={'gallery-insert-target ' + direction}
                aria-label={
                  direction === 'right' ? 'Insert image to the right' : 'Insert image below'
                }
                onPointerEnter={() => {
                  const o = engine.current?.objects.get(hoverImageId);
                  if (o?.galleryId)
                    galleryTarget.current = { galleryId: o.galleryId, anchorId: o.id, direction };
                }}
                onPointerLeave={() => {
                  galleryTarget.current = null;
                }}
                onFocus={() => {
                  const o = engine.current?.objects.get(hoverImageId);
                  if (o?.galleryId)
                    galleryTarget.current = { galleryId: o.galleryId, anchorId: o.id, direction };
                }}
                onBlur={() => {
                  galleryTarget.current = null;
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const o = engine.current?.objects.get(hoverImageId);
                  if (o?.galleryId)
                    galleryTarget.current = { galleryId: o.galleryId, anchorId: o.id, direction };
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const files = [...event.dataTransfer.files],
                    o = engine.current?.objects.get(hoverImageId);
                  if (files.length && o?.galleryId)
                    void performImport(() => importFiles(files), undefined, {
                      galleryId: o.galleryId,
                      anchorId: o.id,
                      direction,
                    });
                }}
              >
                {direction === 'right' ? <ArrowRight size={19} /> : <ArrowDown size={19} />}
                <span className="gallery-paste-hint">Paste or drop</span>
              </button>
            ))}
          </div>
        )}
      {activeGallery && !editing && (
        <div
          ref={toolsRef}
          className="selection-tools gallery-controls"
          role="toolbar"
          aria-label="Gallery layout"
        >
          <SelectionToolbar
            locked={selectionLocked}
            onLayoutChange={measureTools}
            contextKey={activeGallery.id}
          >
            {lockButton}
            {selected.length === 1 && selected[0].type === 'frame' && (
              <button
                key="copy-frame-link"
                className="icon-button"
                aria-label="Copy frame link"
                title="Copy frame link"
                onClick={() => {
                  void copyFrameLink(selected[0]).catch(error);
                }}
              >
                <Link2 size={16} />
              </button>
            )}
            {selected.length === 1 && selected[0].frameLink && (
              <button
                key="open-frame"
                className="icon-button"
                aria-label="Open original frame"
                title="Open original frame (double-click)"
                onClick={() => {
                  void openOriginalFrame(selected[0]).catch(error);
                }}
              >
                <ExternalLink size={16} />
              </button>
            )}
            {(['right', 'below'] as const).map((direction) => (
              <button
                key={direction}
                aria-pressed={activeGallery.gallery!.direction === direction}
                onClick={() => {
                  const o = engine.current?.objects.get(activeGallery.id);
                  if (o?.gallery)
                    engine.current?.apply({
                      upserts: [{ ...o, gallery: { ...o.gallery, direction } }],
                      deleted: [],
                    });
                  host.current?.focus();
                }}
              >
                {direction === 'right' ? <ArrowRight size={16} /> : <ArrowDown size={16} />}
                {direction === 'right' ? 'Right' : 'Below'}
              </button>
            ))}
            {exportSelectionButton}
            {bringToFrontButton}
          </SelectionToolbar>
        </div>
      )}
      {activeGallery &&
        !activeGallery.locked &&
        !galleryMembers(activeGallery.id, engine.current?.all || []).length &&
        camera.zoom > 0.35 && (
          <div
            ref={galleryHintRef}
            className="gallery-empty"
            style={{
              left: activeGallery.x * camera.zoom + camera.x,
              top: activeGallery.y * camera.zoom + camera.y,
              width: activeGallery.width * camera.zoom,
              height: activeGallery.height * camera.zoom,
            }}
          >
            <Images size={22} strokeWidth={1.4} />
            <span>Paste images here</span>
            <kbd>Ctrl V</kbd>
          </div>
        )}
      {selected.length > 0 && !cropping && !activeGallery && (
        <div
          ref={toolsRef}
          className="selection-tools"
          role="toolbar"
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
          <SelectionToolbar
            locked={selectionLocked}
            onLayoutChange={measureTools}
            contextKey={selected.map((object) => object.id).join(',')}
          >
            {lockButton}
            {selected.length === 1 && selected[0].type === 'frame' && (
              <button
                key="copy-frame-link"
                className="icon-button"
                aria-label="Copy frame link"
                title="Copy frame link"
                onClick={() => {
                  void copyFrameLink(selected[0]).catch(error);
                }}
              >
                <Link2 size={16} />
              </button>
            )}
            {selected.length === 1 && selected[0].frameLink && (
              <button
                key="open-frame"
                className="icon-button"
                aria-label="Open original frame"
                title="Open original frame (double-click)"
                onClick={() => {
                  void openOriginalFrame(selected[0]).catch(error);
                }}
              >
                <ExternalLink size={16} />
              </button>
            )}
            {selected.length === 1 && selected[0].type === 'arrow' && (
              <div key="arrow-style">
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
              </div>
            )}
            {selected.every(
              (o) => !['image', 'video', 'link', 'frame', 'arrow', 'list'].includes(o.type),
            ) && (
              <div key="colors" className="color-options">
                {(selected.every((o) => o.type === 'highlight') ? highlightColors : colors).map(
                  (color) => (
                    <button
                      key={color}
                      style={{ background: color }}
                      aria-label={'Set color ' + color}
                      title={color === '#000000' ? 'Black' : color}
                      onClick={() => setSelectionColor(color)}
                    />
                  ),
                )}
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
                key="open"
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
                  key="youtube"
                  className="icon-button"
                  aria-label="Open on YouTube"
                  onClick={() => openLink(selected[0].url!).catch(error)}
                >
                  <ExternalLink size={16} />
                </button>
              )}
            {selected.length > 1 && (
              <button
                key="group"
                className="icon-button"
                aria-label={
                  selected.some((o) => o.groupId) ? 'Ungroup selection' : 'Group selection'
                }
                onClick={() =>
                  selected.some((o) => o.groupId)
                    ? engine.current?.ungroup()
                    : engine.current?.group()
                }
              >
                {selected.some((o) => o.groupId) ? <Ungroup size={17} /> : <Group size={17} />}
              </button>
            )}
            {formattingSelection.length > 0 && (
              <>
                <button
                  key="bold"
                  className="icon-button"
                  aria-label="Bold"
                  title="Bold (Ctrl+B)"
                  aria-pressed={
                    formattingSelection.every((o) => o.bold)
                      ? true
                      : formattingSelection.some((o) => o.bold)
                        ? 'mixed'
                        : false
                  }
                  onClick={() => toggleFormatting('bold')}
                >
                  <Bold size={17} />
                </button>
                <button
                  key="strikethrough"
                  className="icon-button"
                  aria-label="Strikethrough"
                  title="Strikethrough"
                  aria-pressed={
                    formattingSelection.every((o) => o.strikethrough)
                      ? true
                      : formattingSelection.some((o) => o.strikethrough)
                        ? 'mixed'
                        : false
                  }
                  onClick={() => toggleFormatting('strikethrough')}
                >
                  <Strikethrough size={17} />
                </button>
              </>
            )}
            {alignmentSelection.length > 0 && (
              <>
                <button
                  key="center-x"
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
                  key="center-y"
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
            {selected.length === 1 && ['image', 'document'].includes(selected[0].type) && (
              <button
                key="title"
                className="icon-button"
                aria-label={
                  (selected[0].type === 'document'
                    ? selected[0].documentTitle
                    : selected[0].imageTitle
                  )?.trim()
                    ? 'Edit title'
                    : 'Add title'
                }
                title={
                  (selected[0].type === 'document'
                    ? selected[0].documentTitle
                    : selected[0].imageTitle
                  )?.trim()
                    ? 'Edit title'
                    : 'Add title'
                }
                onClick={() => startEdit(selected[0])}
              >
                <Type size={17} />
              </button>
            )}
            {canExportFromSelectionBar && exportSelectionButton}
            {selected.length === 1 && selected[0].type === 'document' && (
              <>
                <button
                  key="preview-document"
                  className="icon-button"
                  aria-label="Preview document"
                  title="Preview document"
                  onClick={() => void openDocument(selected[0]).catch(error)}
                >
                  <FileText size={16} />
                </button>
                {documentKind(selected[0].text || '', selected[0].documentMime) === 'pdf' && (
                  <>
                    <button
                      key="preview-pdf"
                      className="icon-button"
                      aria-label="Full PDF preview"
                      title="Full PDF preview"
                      onClick={() => void openPdfWorkspace(selected, 'preview').catch(error)}
                    >
                      <Maximize2 size={16} />
                    </button>
                    <button
                      key="edit-pdf"
                      className="icon-button"
                      aria-label="Edit PDF"
                      title="Edit PDF"
                      onClick={() => void openPdfWorkspace(selected, 'edit').catch(error)}
                    >
                      <Pencil size={16} />
                    </button>
                  </>
                )}
                <button
                  key="download"
                  className="icon-button"
                  aria-label="Download document"
                  title="Download document"
                  onClick={() => void downloadDocument(selected[0]).catch(error)}
                >
                  <Download size={16} />
                </button>
              </>
            )}
            {bringToFrontButton}
            <button
              key="duplicate"
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
              key="delete"
              className="icon-button"
              aria-label="Delete selection"
              onClick={() => {
                finishEdit();
                engine.current?.deleteSelected();
              }}
            >
              <Trash2 size={16} />
            </button>
          </SelectionToolbar>
        </div>
      )}
      {editing && editingAppearance && (
        <textarea
          ref={editorRef}
          className={'text-editor ' + (editing.type === 'note' ? 'note-editor' : '')}
          aria-label={
            editing.type === 'document'
              ? 'Edit document title'
              : editing.type === 'image'
                ? 'Edit image title'
                : editing.gallery
                  ? 'Edit gallery name'
                  : editing.type === 'frame'
                    ? 'Edit frame name'
                    : 'Edit canvas text'
          }
          placeholder={
            editing.type === 'document'
              ? 'Document title'
              : editing.type === 'image'
                ? 'Image title'
                : undefined
          }
          maxLength={100000}
          value={draft}
          onChange={(e) => {
            const session = editingSession.current,
              value = e.target.value;
            if (session) {
              session.draft = value;
              // Text pasted into free text can run far off screen on one line;
              // wrap it into view the way a paste onto the board is.
              if (
                engine.current &&
                session.object.type === 'text' &&
                !session.object.textBox &&
                (e.nativeEvent as InputEvent).inputType === 'insertFromPaste'
              ) {
                const fitted = fitTextToView(
                  { ...session.object, text: value },
                  visibleBoardArea(engine.current),
                  true,
                );
                if (fitted.textBox) {
                  session.object = { ...fitted, text: session.object.text };
                  setEditing(session.object);
                }
              }
            }
            setDraft(value);
          }}
          onBlur={(event) => {
            if (!toolsRef.current?.contains(event.relatedTarget)) finishEdit();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            if (isCommand(e.nativeEvent, 'edit.bold')) {
              e.preventDefault();
              toggleFormatting('bold');
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finishEdit(true);
            } else if (
              (e.ctrlKey ||
                e.metaKey ||
                (['frame', 'image', 'document'].includes(editing.type) && !e.shiftKey)) &&
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
              !['frame', 'image', 'document'].includes(editing.type) && editing.centerX
                ? 'center'
                : 'left',
            width: editingAppearance.wrapWidth * camera.zoom,
            fontSize: editingAppearance.fontSize * camera.zoom,
            lineHeight: `${editingAppearance.lineHeight * camera.zoom}px`,
            fontFamily: editingAppearance.fontFamily,
            fontWeight: editingAppearance.fontWeight,
            textDecoration: editing.strikethrough ? 'line-through' : 'none',
            color:
              theme === 'dark'
                ? nightInk(editing, editingAppearance.color)
                : editingAppearance.color,
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
      {!!window.canvas && (
        <CollabLayer engine={engine} host={host} camera={camera} boardId={doc.board.id} />
      )}
      {!readOnly && (
        <RadialMenu
          engine={engine}
          host={host}
          tools={[
            ...tools.map(({ id, label, icon }) => ({
              id,
              label,
              icon,
              action: () => selectTool(id),
            })),
            { id: 'list', label: 'List', icon: ListTodo, action: createList },
            { id: 'media', label: 'Files', icon: ImagePlus, action: importMedia },
            { id: 'gallery', label: 'Gallery', icon: Images, action: createGallery },
          ]}
          onChoose={(id, anchor, pointer) => {
            const e = engine.current,
              surface = host.current;
            if (!e || !surface) return;
            setMenu(null);
            if (id === 'arrow') {
              const rect = surface.getBoundingClientRect();
              e.beginQuickArrow(anchor, { x: pointer.x - rect.left, y: pointer.y - rect.top });
            } else if (id === 'list') createList(anchor);
            else if (id === 'gallery') createGallery(anchor);
            else if (id === 'media') void performImport(pickMedia, anchor);
            else if (id === 'select' || id === 'hand' || id === 'highlight') selectTool(id);
            else create(id, anchor);
          }}
        />
      )}
      {!readOnly && (
        <CanvasToolbar
          tools={[
            ...tools.map(({ id, label, icon, command }) => ({
              id,
              label,
              icon,
              shortcut: shortcutLabel(command),
              active: tool === id,
              action: () => selectTool(id),
            })),
            { id: 'list', label: 'Add list', icon: ListTodo, action: createList },
            { id: 'media', label: 'Add files', icon: ImagePlus, action: importMedia },
            { id: 'gallery', label: 'Gallery', icon: Images, action: createGallery },
          ]}
          options={
            tool === 'highlight' && (
              <div
                className="highlighter-options glass-surface"
                role="group"
                aria-label="Highlighter"
              >
                <div className="color-options">
                  {highlightColors.map((color) => (
                    <button
                      key={color}
                      style={{ background: color }}
                      aria-label={'Highlight color ' + color}
                      aria-pressed={highlightStyle.color === color}
                      onClick={() => setHighlightStyle((style) => ({ ...style, color }))}
                    />
                  ))}
                  <label className="custom-color" title="Custom color">
                    <Plus size={12} aria-hidden="true" />
                    <input
                      type="color"
                      aria-label="Custom highlight color"
                      value={highlightStyle.color}
                      onChange={(event) =>
                        setHighlightStyle((style) => ({ ...style, color: event.target.value }))
                      }
                    />
                  </label>
                </div>
                <input
                  type="range"
                  min={highlightSizeRange.min}
                  max={highlightSizeRange.max}
                  step="1"
                  aria-label="Highlighter size"
                  title="Size. Right-drag on the board: left is thinner, right is thicker"
                  value={highlightStyle.size}
                  onChange={(event) =>
                    setHighlightStyle((style) => ({ ...style, size: Number(event.target.value) }))
                  }
                />
                <output aria-hidden="true">{highlightStyle.size}</output>
              </div>
            )
          }
        />
      )}
      <div ref={zoomControls} className="canvas-zoom">
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
      {menu && !readOnly && (
        <ContextMenu
          {...menu}
          items={contextItems.map(
            (item) =>
              item && {
                ...item,
                disabled:
                  item.disabled ||
                  (selectionLocked &&
                    ![
                      'Undo',
                      'Redo',
                      'Duplicate',
                      'Fit board',
                      'Export selected…',
                      'Export visible area…',
                      'Download',
                      'Preview document',
                      'Full PDF preview',
                      'Full image preview',
                      'Copy as image',
                      'Find usages',
                    ].includes(item.label)),
              },
          )}
          onClose={() => setMenu(null)}
        />
      )}
      {usageTarget && (
        <FrameUsages
          {...usageTarget}
          prepare={() => flush(false)}
          onClose={() => setUsageTarget(null)}
          onOpen={onOpenFrame}
        />
      )}
      {pdfExport && (
        <PdfExportDialog
          name={pdfExport.name}
          onClose={() => setPdfExport(null)}
          onPrepare={(target, signal, progress) =>
            exportComposerColumn(
              pdfExport.composer,
              pdfExport.columnId,
              AbortSignal.any([signal, documentAbort.current.signal]),
              target,
              progress,
            )
          }
          onSave={async (result) => {
            const asset = await invoke<Asset>('importAsset', {
              name: result.name,
              bytes: result.bytes,
            });
            documentAbort.current.signal.throwIfAborted();
            return downloadAsset(asset.id, result.name);
          }}
        />
      )}
      <ExportControls
        scope={exportScope}
        progress={exportProgress}
        result={exportResult}
        onClose={() => setExportScope(null)}
        onExport={startExport}
        onDismiss={() => setExportResult(null)}
        onCopy={async () => {
          if (exportResult?.id) return window.canvas!.copyExport(exportResult.id);
          if (!exportResult?.url) throw Error('This export is no longer available.');
          const blob = await (await fetch(exportResult.url)).blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        }}
        onOpen={(folder) => {
          if (exportResult?.id)
            void window.canvas?.openExport(exportResult.id, folder).catch(error);
          else if (exportResult?.url)
            window.open(exportResult.url, '_blank', 'noopener,noreferrer');
        }}
      />
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
