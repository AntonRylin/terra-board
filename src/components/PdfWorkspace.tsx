import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FilePlus2,
  FileText,
  Maximize2,
  Minus,
  MoveHorizontal,
  Pencil,
  Plus,
  Redo2,
  RotateCw,
  Undo2,
  X,
  Trash2,
} from 'lucide-react';
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import { uid, type Asset, type CanvasObject } from '../model';
import { downloadAsset, invoke } from '../bridge';
import { createPdfPreviewWorker, documentBytes, loadPdf } from '../canvas/document-preview';
import {
  MAX_PDF_PAGES,
  MAX_PDF_WORKSPACE_BYTES,
  type PdfPageSpec,
  type PdfSource,
} from '../canvas/pdf-edit';
import { assemblePdfLocal, inspectPdfSourceLocal } from '../canvas/pdf-edit-client';
import { convertPdfPages, renderPdfSheet } from '../canvas/pdf-render';
import './pdf-workspace.css';

export interface PdfWorkspaceHandle {
  flush: () => Promise<void>;
}
interface Props {
  objects: CanvasObject[];
  mode: 'preview' | 'edit';
  onSave: (
    bytes: Uint8Array<ArrayBuffer>,
    name: string,
    id: string,
    pageCount: number,
  ) => Promise<void>;
  onClose: () => void;
}
interface SourceView {
  input: PdfSource;
  pdf: PDFDocumentProxy;
  hasForms: boolean;
}
const signature = (pages: PdfPageSpec[]) => JSON.stringify(pages);
const baseName = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, 160) || 'Document';
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Tool({
  label,
  children,
  ...props
}: { label: string; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-label={label} data-tooltip={label} {...props}>
      {children}
    </button>
  );
}

// Normalize image orientation before embedding (including camera JPEG EXIF), without changing its asset.
async function imageSource(
  bytes: Uint8Array<ArrayBuffer>,
  name: string,
  signal: AbortSignal,
): Promise<PdfSource> {
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    if (bitmap.width * bitmap.height > 32_000_000 || Math.max(bitmap.width, bitmap.height) > 16384)
      throw Error('This image is too large to convert. Use an image below 32 megapixels.');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(Error('This image could not be converted.'))),
        'image/png',
      ),
    );
    signal.throwIfAborted();
    if (blob.size > MAX_PDF_WORKSPACE_BYTES)
      throw Error('The converted image exceeds the 64 MB PDF workspace limit.');
    return { id: uid(), name, kind: 'png', bytes: new Uint8Array(await blob.arrayBuffer()) };
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 1;
  }
}

function Thumbnail({
  source,
  page,
  index,
  selected,
  ...handlers
}: {
  source: SourceView;
  page: PdfPageSpec;
  index: number;
  selected: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const root = useRef<HTMLButtonElement>(null),
    host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: root.current?.parentElement,
      rootMargin: '160px',
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController(),
      canvas = document.createElement('canvas');
    void renderPdfSheet(source.pdf, page, canvas, 180, controller.signal, 200_000)
      .then(() => {
        if (!controller.signal.aborted) host.current?.replaceChildren(canvas);
      })
      .catch(() => {
        /* The large page view reports rendering failures. */
      });
    return () => {
      controller.abort();
      canvas.width = canvas.height = 1;
      host.current?.replaceChildren();
    };
  }, [visible, source, page.pageIndex, page.rotation]);
  return (
    <button
      ref={root}
      className="pdf-page-tile"
      data-page-id={page.id}
      data-source-page={page.pageIndex + 1}
      aria-label={`Page ${index + 1}`}
      aria-pressed={selected}
      {...handlers}
    >
      <span ref={host} className="pdf-thumbnail-paper" aria-hidden="true" />
      <span className="pdf-thumbnail-number">{index + 1}</span>
    </button>
  );
}

const PdfWorkspace = forwardRef<PdfWorkspaceHandle, Props>(function PdfWorkspace(
  { objects, mode, onSave, onClose },
  ref,
) {
  const root = useRef<HTMLElement>(null),
    stage = useRef<HTMLDivElement>(null),
    pageHost = useRef<HTMLDivElement>(null),
    picker = useRef<HTMLInputElement>(null);
  const lifetime = useRef(new AbortController()),
    resources = useRef(new Set<PDFDocumentProxy>());
  const previewWorker = useRef<PDFWorker | null>(null);
  const sourcesRef = useRef<SourceView[]>([]),
    pagesRef = useRef<PdfPageSpec[]>([]),
    baseline = useRef('');
  const past = useRef<PdfPageSpec[][]>([]),
    future = useRef<PdfPageSpec[][]>([]);
  const operation = useRef<Promise<void> | null>(null),
    saving = useRef<Promise<void> | null>(null),
    copyId = useRef(uid());
  const operationAbort = useRef<AbortController | null>(null);
  const conversionSeed = useRef(objects.length > 1 || objects[0].type === 'image');
  const [sources, setSources] = useState<SourceView[]>([]),
    [pages, setPages] = useState<PdfPageSpec[]>([]);
  const [selected, setSelected] = useState(''),
    [editing, setEditing] = useState(mode === 'edit');
  const [busy, setBusy] = useState(''),
    [loading, setLoading] = useState(true),
    [pageLoading, setPageLoading] = useState(true);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [convert, setConvert] = useState(false),
    [confirmClose, setConfirmClose] = useState(false);
  const [fit, setFit] = useState<'page' | 'width' | null>('page'),
    [zoom, setZoom] = useState(1),
    [actualZoom, setActualZoom] = useState(1);
  const [size, setSize] = useState({ width: 900, height: 700 }),
    [dragOver, setDragOver] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const drag = useRef<{ id: string; x: number; y: number; over: string; moved: boolean } | null>(
    null,
  );
  const name = baseName(objects[0].text || objects[0].imageTitle || 'Document');
  const outputName = `${name}${objects[0].type === 'image' ? '' : '-edited'}.pdf`;
  const index = Math.max(
      0,
      pages.findIndex((p) => p.id === selected),
    ),
    current = pages[index];
  const source = current && sources.find((s) => s.input.id === current.sourceId);
  const dirty = conversionSeed.current || signature(pages) !== baseline.current;

  const updatePages = (next: PdfPageSpec[], focus = selected, record = true) => {
    if (record) {
      past.current = [...past.current.slice(-49), pagesRef.current];
      future.current = [];
    }
    pagesRef.current = next;
    setPages(next);
    setSelected(
      next.some((p) => p.id === focus) ? focus : next[Math.min(index, next.length - 1)]?.id || '',
    );
    setHistoryVersion((v) => v + 1);
    setNotice('');
  };
  const undo = () => {
    const next = past.current.pop();
    if (next) {
      future.current.push(pagesRef.current);
      updatePages(next, selected, false);
    }
  };
  const redo = () => {
    const next = future.current.pop();
    if (next) {
      past.current.push(pagesRef.current);
      updatePages(next, selected, false);
    }
  };
  const move = (id: string, to: number) => {
    const next = [...pagesRef.current],
      from = next.findIndex((p) => p.id === id);
    if (from < 0 || to < 0 || to >= next.length || from === to) return;
    next.splice(to, 0, next.splice(from, 1)[0]);
    updatePages(next, id);
  };
  const showError = (e: unknown) => {
    if (!lifetime.current.signal.aborted && !(e instanceof DOMException && e.name === 'AbortError'))
      setError(messageOf(e));
  };
  const run = (label: string, fn: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (operation.current) return operation.current;
    const controller = new AbortController();
    operationAbort.current = controller;
    const signal = AbortSignal.any([lifetime.current.signal, controller.signal]);
    setBusy(label);
    setError('');
    setNotice('');
    setConvert(false);
    const task = Promise.resolve()
      .then(() => fn(signal))
      .finally(() => {
        operation.current = null;
        operationAbort.current = null;
        if (!lifetime.current.signal.aborted) setBusy('');
      });
    operation.current = task;
    return task;
  };
  const loadSource = async (
    input: PdfSource,
    signal = lifetime.current.signal,
  ): Promise<SourceView> => {
    const metadata = await inspectPdfSourceLocal(input, signal);
    const preview =
      input.kind === 'pdf'
        ? input.bytes.slice()
        : await assemblePdfLocal(
            [input],
            [{ id: uid(), sourceId: input.id, pageIndex: 0, rotation: 0 }],
            signal,
          );
    // One PDF.js worker serves the entire workspace, including merged image pages.
    if (!previewWorker.current) {
      const worker = await createPdfPreviewWorker(signal);
      if (signal.aborted) {
        worker.destroy();
        signal.throwIfAborted();
      }
      previewWorker.current = worker;
    }
    let pdf: PDFDocumentProxy;
    try {
      pdf = await loadPdf(preview, signal, previewWorker.current);
    } catch (e) {
      signal.throwIfAborted();
      throw e;
    }
    if (signal.aborted) {
      await pdf.loadingTask.destroy();
      signal.throwIfAborted();
    }
    resources.current.add(pdf);
    return { input, pdf, hasForms: metadata.hasForms };
  };
  const release = (items: SourceView[]) => {
    for (const s of items) {
      resources.current.delete(s.pdf);
      void s.pdf.loadingTask.destroy();
    }
  };
  const append = (items: SourceView[], initial = false) => {
    const nextSources = [...sourcesRef.current, ...items];
    const nextPages = [
      ...pagesRef.current,
      ...items.flatMap((s) =>
        Array.from({ length: s.pdf.numPages }, (_, pageIndex) => ({
          id: uid(),
          sourceId: s.input.id,
          pageIndex,
          rotation: 0,
        })),
      ),
    ];
    if (nextPages.length > MAX_PDF_PAGES)
      throw Error(`A PDF workspace can contain up to ${MAX_PDF_PAGES} pages.`);
    if (nextSources.reduce((n, s) => n + s.input.bytes.length, 0) > MAX_PDF_WORKSPACE_BYTES)
      throw Error('These files exceed the 64 MB PDF workspace limit.');
    sourcesRef.current = nextSources;
    setSources(nextSources);
    if (initial) baseline.current = signature(nextPages);
    updatePages(
      nextPages,
      initial ? nextPages[0].id : nextPages[pagesRef.current.length].id,
      !initial,
    );
  };

  useEffect(() => {
    const signal = lifetime.current.signal;
    const previous = document.activeElement as HTMLElement | null,
      app = document.getElementById('root');
    const wasInert = !!app?.inert && !app.hasAttribute('data-mcp-inert');
    if (app) app.inert = true;
    root.current?.focus();
    void (async () => {
      const loaded: SourceView[] = [];
      try {
        let total = 0,
          count = 0;
        for (const o of objects) {
          const bytes = await documentBytes(o, MAX_PDF_WORKSPACE_BYTES - total, signal);
          const input: PdfSource =
            o.type === 'image'
              ? await imageSource(bytes, o.text || 'Image.png', signal)
              : { id: uid(), name: o.text || 'Document.pdf', kind: 'pdf', bytes };
          total += input.bytes.length;
          if (total > MAX_PDF_WORKSPACE_BYTES)
            throw Error('These files exceed the 64 MB PDF workspace limit.');
          loaded.push(await loadSource(input));
          count += loaded.at(-1)!.pdf.numPages;
          if (count > MAX_PDF_PAGES)
            throw Error(`A PDF workspace can contain up to ${MAX_PDF_PAGES} pages.`);
        }
        signal.throwIfAborted();
        append(loaded, true);
      } catch (e) {
        release(loaded);
        showError(e);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    })();
    return () => {
      lifetime.current.abort();
      const worker = previewWorker.current;
      void Promise.allSettled(
        [...resources.current].map((pdf) => pdf.loadingTask.destroy()),
      ).finally(() => worker?.destroy());
      resources.current.clear();
      if (app) app.inert = wasInert || app.hasAttribute('data-mcp-inert');
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: host.clientWidth, height: host.clientHeight }),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!current || !source) return;
    const controller = new AbortController(),
      canvas = document.createElement('canvas');
    setPageLoading(true);
    pageHost.current?.replaceChildren();
    void (async () => {
      try {
        const page = await source.pdf.getPage(current.pageIndex + 1);
        controller.signal.throwIfAborted();
        const natural = page.getViewport({
          scale: 1,
          rotation: (((page.rotate + current.rotation) % 360) + 360) % 360,
        });
        const scale = fit
          ? Math.max(
              0.05,
              Math.min(
                (size.width - 64) / natural.width,
                fit === 'page' ? (size.height - 48) / natural.height : Infinity,
              ),
            )
          : zoom;
        await renderPdfSheet(
          source.pdf,
          current,
          canvas,
          natural.width * scale * devicePixelRatio,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        canvas.style.width = `${natural.width * scale}px`;
        canvas.style.height = `${natural.height * scale}px`;
        canvas.setAttribute('aria-label', `PDF page ${index + 1} of ${pages.length}`);
        pageHost.current?.replaceChildren(canvas);
        setActualZoom(scale);
      } catch (e) {
        if (!controller.signal.aborted) showError(e);
      } finally {
        if (!controller.signal.aborted) setPageLoading(false);
      }
    })();
    return () => {
      controller.abort();
      canvas.width = canvas.height = 1;
    };
  }, [source, current, fit, zoom, size, index, pages.length]);
  useEffect(() => {
    root.current
      ?.querySelector<HTMLElement>(`.pdf-page-tile[data-page-id="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected, editing, historyVersion]);
  useEffect(() => {
    if (confirmClose)
      root.current?.querySelector<HTMLElement>('.pdf-close-actions button')?.focus();
    else root.current?.focus({ preventScroll: true });
  }, [confirmClose]);
  useEffect(() => {
    // Removing a popover or disabling its focused command can leave focus on body.
    if (!convert && !busy && !root.current?.contains(document.activeElement))
      root.current?.focus({ preventScroll: true });
  }, [convert, busy]);

  const addFiles = (files: File[]) => {
    if (!files.length || operation.current || loading) return;
    void run('Adding pages…', async (signal) => {
      const added: SourceView[] = [];
      let total = sourcesRef.current.reduce((n, s) => n + s.input.bytes.length, 0),
        count = pagesRef.current.length;
      try {
        for (const file of files) {
          signal.throwIfAborted();
          if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) throw Error('Add PDF, PNG or JPG files.');
          if (total + file.size > MAX_PDF_WORKSPACE_BYTES)
            throw Error('These files exceed the 64 MB PDF workspace limit.');
          const bytes = new Uint8Array(await file.arrayBuffer());
          const input: PdfSource = /\.pdf$/i.test(file.name)
            ? { id: uid(), name: file.name, kind: 'pdf', bytes }
            : await imageSource(bytes, file.name, signal);
          total += input.bytes.length;
          if (total > MAX_PDF_WORKSPACE_BYTES)
            throw Error('These files exceed the 64 MB PDF workspace limit.');
          const view = await loadSource(input, signal);
          added.push(view);
          count += view.pdf.numPages;
          if (count > MAX_PDF_PAGES)
            throw Error(`A PDF workspace can contain up to ${MAX_PDF_PAGES} pages.`);
        }
        signal.throwIfAborted();
        append(added);
        setEditing(true);
      } catch (e) {
        release(added);
        throw e;
      }
    }).catch(showError);
  };
  const commit = (): Promise<void> => {
    if (saving.current) return saving.current;
    const value = pagesRef.current;
    if (!value.length || (!conversionSeed.current && signature(value) === baseline.current))
      return Promise.resolve();
    const task = run('Saving copy…', async (signal) => {
      const bytes = await assemblePdfLocal(
        sourcesRef.current.map((s) => s.input),
        value,
        signal,
      );
      signal.throwIfAborted();
      await onSave(bytes, outputName, copyId.current, value.length);
      baseline.current = signature(value);
      conversionSeed.current = false;
      setHistoryVersion((v) => v + 1);
    });
    saving.current = task;
    void task
      .finally(() => {
        saving.current = null;
      })
      .catch(() => {});
    return task;
  };
  useImperativeHandle(ref, () => ({
    flush: async () => {
      await operation.current;
      await commit();
    },
  }));
  const saveAndClose = () => {
    void commit().then(onClose).catch(showError);
  };
  const close = () => {
    if (busy) return;
    if (!loading && dirty && pages.length) setConfirmClose(true);
    else onClose();
  };
  const downloadBytes = async (
    bytes: Uint8Array<ArrayBuffer>,
    filename: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const asset = await invoke<Asset>('importAsset', { name: filename, bytes });
    signal.throwIfAborted();
    const saved = await downloadAsset(asset.id, filename);
    if (saved && !signal.aborted) setNotice('Downloaded');
  };
  const convertPages = (format: 'png' | 'jpg' | 'txt') => {
    void run('Converting…', async (signal) => {
      const output = await convertPdfPages(
        new Map(sourcesRef.current.map((s) => [s.input.id, s.pdf])),
        pagesRef.current,
        format,
        `${name}.pdf`,
        signal,
        (done, total) => {
          if (!lifetime.current.signal.aborted) setBusy(`Converting ${done} / ${total}…`);
        },
      );
      signal.throwIfAborted();
      await downloadBytes(output.bytes, output.name, signal);
    }).catch(showError);
  };
  const extract = () => {
    if (!current) return;
    void run('Extracting page…', async (signal) => {
      const bytes = await assemblePdfLocal(
        sourcesRef.current.map((s) => s.input),
        [current],
        signal,
      );
      signal.throwIfAborted();
      await downloadBytes(bytes, `${name}-page-${index + 1}.pdf`, signal);
    }).catch(showError);
  };
  const zoomBy = (step: number) => {
    setZoom(Math.max(0.1, Math.min(4, actualZoom + step)));
    setFit(null);
  };
  const selectedPage = (next: number) => {
    const page = pagesRef.current[next];
    if (page) {
      setSelected(page.id);
      if (stage.current) stage.current.scrollTop = 0;
    }
  };
  const disable = loading || !!busy || !current;
  return createPortal(
    <section
      ref={root}
      className="pdf-workspace"
      role="dialog"
      aria-modal="true"
      aria-label="PDF workspace"
      tabIndex={-1}
      data-mode={editing ? 'edit' : 'preview'}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        addFiles([...e.dataTransfer.files]);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Tab') {
          const items = [
            ...(root.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
            ) || []),
          ].filter((el) => el.getClientRects().length && !el.closest('[inert]'));
          const first = items[0],
            last = items.at(-1);
          if (
            e.shiftKey &&
            (document.activeElement === first || document.activeElement === root.current)
          ) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          if (convert) setConvert(false);
          else if (confirmClose) setConfirmClose(false);
          else close();
        }
        if ((e.ctrlKey || e.metaKey) && ['s', 'z', 'y'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          if (disable || confirmClose) return;
          if (e.key.toLowerCase() === 's') saveAndClose();
          else if (editing) {
            if (e.shiftKey || e.key.toLowerCase() === 'y') redo();
            else undo();
          }
        }
        if (disable || confirmClose || (e.target as HTMLElement).matches('input')) return;
        if (
          ['ArrowLeft', 'ArrowUp', 'PageUp', 'ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)
        ) {
          e.preventDefault();
          const delta = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key) ? -1 : 1;
          if (e.altKey && editing) move(selected, index + delta);
          else selectedPage(index + delta);
        }
      }}
    >
      <header className="pdf-workspace-header" inert={confirmClose || undefined}>
        <Tool label="Close PDF workspace" disabled={!!busy} onClick={close}>
          <ChevronLeft size={19} />
        </Tool>
        <div className="pdf-workspace-title">
          <span>
            {objects[0].documentTitle || objects[0].imageTitle || objects[0].text || 'Document'}
          </span>
        </div>
        <div className="pdf-workspace-actions">
          <Tool
            label="Edit PDF pages"
            aria-pressed={editing}
            disabled={disable}
            onClick={() => setEditing((v) => !v)}
          >
            <Pencil size={16} />
            <span>Edit</span>
          </Tool>
          <div className="pdf-convert-anchor">
            <Tool
              label="Convert PDF"
              aria-expanded={convert}
              disabled={disable}
              onClick={() => setConvert((v) => !v)}
            >
              <Download size={17} />
            </Tool>
            {convert && (
              <div className="pdf-convert-menu" role="group" aria-label="PDF conversion">
                <button onClick={() => convertPages('png')} aria-label="Download PNG pages">
                  PNG images
                </button>
                <button onClick={() => convertPages('jpg')} aria-label="Download JPG pages">
                  JPG images
                </button>
                <button onClick={() => convertPages('txt')} aria-label="Download text">
                  Text file
                </button>
                <span className="pdf-menu-divider" />
                <button onClick={extract} aria-label="Extract current page">
                  Extract this page
                </button>
              </div>
            )}
          </div>
          {editing && (
            <button
              className="pdf-save-copy"
              aria-label="Save PDF copy"
              disabled={disable || !dirty}
              onClick={saveAndClose}
            >
              <Check size={16} />
              <span>Save copy</span>
            </button>
          )}
        </div>
      </header>
      <div className="pdf-workspace-body" inert={confirmClose || undefined}>
        {editing && (
          <aside className="pdf-pages-sidebar" aria-label="PDF pages">
            <div className="pdf-pages-heading">
              <span>{pages.length} pages</span>
              <Tool
                label="Add PDF or images"
                disabled={disable}
                onClick={() => picker.current?.click()}
              >
                <FilePlus2 size={17} />
              </Tool>
            </div>
            <div className="pdf-thumbnails">
              {pages.map((page, i) => {
                const src = sources.find((s) => s.input.id === page.sourceId);
                return (
                  src && (
                    <Thumbnail
                      key={page.id}
                      source={src}
                      page={page}
                      index={i}
                      selected={page.id === selected}
                      disabled={!!busy}
                      data-drop-target={dragOver === page.id || undefined}
                      onClick={() => selectedPage(i)}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || busy) return;
                        setSelected(page.id);
                        e.currentTarget.setPointerCapture(e.pointerId);
                        drag.current = {
                          id: page.id,
                          x: e.clientX,
                          y: e.clientY,
                          over: page.id,
                          moved: false,
                        };
                      }}
                      onPointerMove={(e) => {
                        const d = drag.current;
                        if (!d) return;
                        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5 && !d.moved) return;
                        d.moved = true;
                        const hit = document
                          .elementFromPoint(e.clientX, e.clientY)
                          ?.closest<HTMLElement>('.pdf-page-tile');
                        if (hit?.dataset.pageId) {
                          d.over = hit.dataset.pageId;
                          setDragOver(d.over);
                        }
                        const list = e.currentTarget.parentElement!;
                        const r = list.getBoundingClientRect();
                        if (e.clientY < r.top + 32) list.scrollTop -= 16;
                        if (e.clientY > r.bottom - 32) list.scrollTop += 16;
                      }}
                      onPointerUp={(e) => {
                        const d = drag.current;
                        drag.current = null;
                        setDragOver('');
                        if (e.currentTarget.hasPointerCapture(e.pointerId))
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        if (d?.moved)
                          move(
                            d.id,
                            pagesRef.current.findIndex((p) => p.id === d.over),
                          );
                      }}
                      onPointerCancel={() => {
                        drag.current = null;
                        setDragOver('');
                      }}
                    />
                  )
                );
              })}
            </div>
          </aside>
        )}
        <main className="pdf-workspace-main">
          {editing && (
            <div className="pdf-edit-tools" role="toolbar" aria-label="PDF page editing">
              <Tool
                label="Move page earlier"
                disabled={disable || index === 0}
                onClick={() => move(selected, index - 1)}
              >
                <ArrowUp size={16} />
              </Tool>
              <Tool
                label="Move page later"
                disabled={disable || index === pages.length - 1}
                onClick={() => move(selected, index + 1)}
              >
                <ArrowDown size={16} />
              </Tool>
              <span className="pdf-tool-divider" />
              <Tool
                label="Rotate page"
                disabled={disable}
                onClick={() =>
                  updatePages(
                    pages.map((p) =>
                      p.id === selected ? { ...p, rotation: (p.rotation + 90) % 360 } : p,
                    ),
                  )
                }
              >
                <RotateCw size={16} />
              </Tool>
              <Tool
                label="Duplicate page"
                disabled={disable || pages.length >= MAX_PDF_PAGES}
                onClick={() => {
                  const copy = { ...current, id: uid() };
                  const next = [...pages];
                  next.splice(index + 1, 0, copy);
                  updatePages(next, copy.id);
                }}
              >
                <Copy size={16} />
              </Tool>
              <Tool
                label="Remove page"
                disabled={disable || pages.length <= 1}
                onClick={() => updatePages(pages.filter((p) => p.id !== selected))}
              >
                <Trash2 size={16} />
              </Tool>
              <span className="pdf-tool-divider" />
              <Tool label="Undo PDF edit" disabled={disable || !past.current.length} onClick={undo}>
                <Undo2 size={16} />
              </Tool>
              <Tool
                label="Redo PDF edit"
                disabled={disable || !future.current.length}
                onClick={redo}
              >
                <Redo2 size={16} />
              </Tool>
            </div>
          )}
          <div ref={stage} className="pdf-workspace-stage">
            <div ref={pageHost} className="pdf-workspace-page" aria-busy={pageLoading || loading} />
            {(loading || (current && pageLoading)) && !error && (
              <div className="pdf-workspace-loading" role="status">
                {loading ? 'Opening PDF…' : 'Loading page…'}
              </div>
            )}
          </div>
          <footer className="pdf-view-controls" aria-label="PDF view">
            <Tool
              label="Previous PDF page"
              disabled={disable || index === 0}
              onClick={() => selectedPage(index - 1)}
            >
              <ChevronLeft size={17} />
            </Tool>
            <label className="pdf-page-counter">
              <input
                key={index}
                type="number"
                aria-label="PDF page number"
                min="1"
                max={pages.length || 1}
                defaultValue={index + 1}
                disabled={disable}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  selectedPage(Math.min(pages.length - 1, Math.max(0, Math.floor(n || 1) - 1)));
                  e.target.value = String(index + 1);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <span>/ {pages.length}</span>
            </label>
            <Tool
              label="Next PDF page"
              disabled={disable || index === pages.length - 1}
              onClick={() => selectedPage(index + 1)}
            >
              <ChevronRight size={17} />
            </Tool>
            <span className="pdf-tool-divider" />
            <Tool
              label="Zoom PDF out"
              disabled={disable || actualZoom <= 0.1}
              onClick={() => zoomBy(-0.25)}
            >
              <Minus size={16} />
            </Tool>
            <span className="pdf-zoom-value">{Math.round(actualZoom * 100)}%</span>
            <Tool
              label="Zoom PDF in"
              disabled={disable || actualZoom >= 4}
              onClick={() => zoomBy(0.25)}
            >
              <Plus size={16} />
            </Tool>
            <span className="pdf-tool-divider" />
            <Tool
              label="Fit PDF page"
              aria-pressed={fit === 'page'}
              disabled={disable}
              onClick={() => setFit('page')}
            >
              <Maximize2 size={16} />
            </Tool>
            <Tool
              label="Fit PDF width"
              aria-pressed={fit === 'width'}
              disabled={disable}
              onClick={() => setFit('width')}
            >
              <MoveHorizontal size={17} />
            </Tool>
          </footer>
        </main>
      </div>
      <input
        ref={picker}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg"
        multiple
        hidden
        aria-label="PDF pages to add"
        onChange={(e) => {
          addFiles([...(e.target.files || [])]);
          e.target.value = '';
        }}
      />
      {(busy || error || notice || (editing && sources.some((s) => s.hasForms))) && (
        <div
          className={'pdf-workspace-status' + (error ? ' has-error' : '')}
          role={error ? 'alert' : 'status'}
        >
          <span>{error || busy || notice || 'Form fields become static in the saved copy.'}</span>
          {error && !!pages.length && (
            <Tool label="Dismiss PDF error" onClick={() => setError('')}>
              <X size={14} />
            </Tool>
          )}
          {busy && !saving.current && (
            <Tool
              label="Cancel PDF operation"
              onClick={() => {
                operationAbort.current?.abort();
                setNotice('Cancelled');
              }}
            >
              <X size={14} />
            </Tool>
          )}
        </div>
      )}
      {confirmClose && (
        <div className="pdf-close-prompt" role="alertdialog" aria-label="Unsaved PDF changes">
          <div>
            <FileText size={22} />
            <p>Save your edited copy?</p>
            <span>Your original file stays on the board.</span>
            <div className="pdf-close-actions">
              <button disabled={!!busy} onClick={() => setConfirmClose(false)}>
                Keep editing
              </button>
              <button disabled={!!busy} aria-label="Discard PDF changes" onClick={onClose}>
                Discard
              </button>
              <button className="pdf-save-copy" disabled={!!busy} onClick={saveAndClose}>
                Save copy
              </button>
            </div>
          </div>
        </div>
      )}
    </section>,
    document.body,
  );
});
export default PdfWorkspace;
