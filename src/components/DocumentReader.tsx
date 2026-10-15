import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Maximize2,
  Pencil,
  Minus,
  Plus,
  ScanText,
  X,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Camera, CanvasObject } from '../model';
import { localToWorld } from '../canvas/transform';
import {
  documentKind,
  decodeDocumentText,
  encodeDocumentText,
  MAX_TEXT_BYTES,
  type DecodedText,
} from '../canvas/document-files';
import { documentBytes, docxHtml, loadPdf, paintPdfPage } from '../canvas/document-preview';
import { pdfPageText } from '../canvas/page-text';
import { recognizedString, type RecognizedText } from '../canvas/recognized-text';
import TextLayer, { selectLayerText } from './TextLayer';
import './document-reader.css';

export interface DocumentReaderHandle {
  flush: () => Promise<void>;
}
interface Props {
  object: CanvasObject;
  camera: Camera;
  onSave: (object: CanvasObject, bytes: Uint8Array<ArrayBuffer>, excerpt: string) => Promise<void>;
  onClose: () => void;
  onDownload: () => Promise<void>;
  onExpandPdf: (edit: boolean) => void;
  onError: (error: unknown) => void;
}

const DocumentReader = forwardRef<DocumentReaderHandle, Props>(function DocumentReader(
  { object: o, camera, onSave, onClose, onDownload, onExpandPdf, onError },
  ref,
) {
  const kind = documentKind(o.text || '', o.documentMime);
  const root = useRef<HTMLElement>(null),
    pageHost = useRef<HTMLDivElement>(null);
  const draft = useRef(''),
    original = useRef(''),
    format = useRef<DecodedText | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const [text, setText] = useState(''),
    [html, setHtml] = useState('');
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(kind !== 'file'),
    [pageLoading, setPageLoading] = useState(false);
  const [saving, setSaving] = useState(false),
    [message, setMessage] = useState('');
  const [sheet, setSheet] = useState<{ width: number; height: number } | null>(null),
    [pageText, setPageText] = useState<{ page: number; text: RecognizedText } | null>(null),
    [copied, setCopied] = useState(false);
  const textLayer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let cancelled = false,
      loadedPdf: PDFDocumentProxy | undefined;
    root.current?.focus({ preventScroll: true });
    if (kind !== 'file')
      void (async () => {
        try {
          const bytes = await documentBytes(
            o,
            kind === 'text' ? MAX_TEXT_BYTES : undefined,
            controller.signal,
          );
          if (cancelled) return;
          if (kind === 'text') {
            format.current = decodeDocumentText(bytes);
            original.current = draft.current = format.current.text;
            setText(format.current.text);
          } else if (kind === 'docx') {
            const content = await docxHtml(bytes);
            if (!cancelled) setHtml(content);
          } else {
            loadedPdf = await loadPdf(bytes, controller.signal);
            if (cancelled) await loadedPdf.loadingTask.destroy();
            else setPdf(loadedPdf);
          }
        } catch (error) {
          if (!cancelled)
            setMessage(
              error instanceof Error
                ? error.message
                : 'This file cannot be previewed. You can still download it.',
            );
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    return () => {
      cancelled = true;
      mounted.current = false;
      controller.abort();
      void loadedPdf?.loadingTask.destroy();
    };
  }, []);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    const controller = new AbortController();
    setPageLoading(true);
    void (async () => {
      try {
        const pdfPage = await pdf.getPage(page),
          canvas = document.createElement('canvas');
        const width = Math.max(1, (pageHost.current?.clientWidth || o.width) - 24) * zoom;
        await paintPdfPage(
          pdfPage,
          canvas,
          Math.min(3000, width * Math.max(1, camera.zoom) * devicePixelRatio),
          controller.signal,
        );
        if (cancelled) {
          canvas.width = canvas.height = 1;
          return;
        }
        canvas.style.width = `${width}px`;
        canvas.setAttribute('aria-label', `PDF page ${page} of ${pdf.numPages}`);
        pageHost.current?.replaceChildren(canvas);
        setSheet({ width, height: (width * canvas.height) / canvas.width });
      } catch (error) {
        if (!cancelled)
          setMessage(error instanceof Error ? error.message : 'This page could not be rendered.');
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [pdf, page, zoom, o.width, camera.zoom]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    void pdfPageText(pdf, page - 1).then(
      (text) => !cancelled && setPageText({ page, text }),
      () => !cancelled && setPageText(null),
    );
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const visibleText = pageText?.page === page ? pageText.text : null;
  const visibleString = visibleText ? recognizedString(visibleText) : '';

  const commit = async () => {
    if (pending.current) return pending.current;
    if (!format.current || draft.current === original.current) return;
    const value = draft.current;
    const bytes = encodeDocumentText(value, format.current);
    setSaving(true);
    const task = onSave(o, bytes, value.slice(0, 10000)).then(() => {
      original.current = value;
    });
    pending.current = task;
    try {
      await task;
    } finally {
      pending.current = null;
      if (mounted.current) setSaving(false);
    }
  };
  useImperativeHandle(ref, () => ({ flush: commit }));
  const close = () => {
    void commit().then(onClose).catch(onError);
  };
  const origin = localToWorld(o, { x: 0, y: 0 });
  return (
    <section
      ref={root}
      className="document-reader"
      data-document-id={o.id}
      data-kind={kind}
      aria-label={o.documentTitle || o.text || 'Document'}
      tabIndex={-1}
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: o.width,
        height: o.height,
        transform: `scale(${camera.zoom}) rotate(${o.rotation || 0}deg)`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (kind === 'pdf' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          selectLayerText(textLayer.current);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          if (!saving) onClose();
        } else if (
          (event.ctrlKey || event.metaKey) &&
          (event.key === 'Enter' || event.key.toLowerCase() === 's')
        ) {
          event.preventDefault();
          close();
        }
      }}
    >
      <header className="document-reader-toolbar">
        <FileText size={16} aria-hidden="true" />
        <span className="document-reader-name">{o.text || 'Document'}</span>
        {kind === 'pdf' && (
          <>
            {window.canvas && (
              <button
                aria-label="Copy page text"
                data-tooltip={
                  copied ? 'Copied' : visibleString ? 'Copy page text' : 'No text on this page'
                }
                disabled={!visibleString}
                onClick={() =>
                  void window.canvas?.copyText(visibleString).then(() => setCopied(true))
                }
              >
                {copied ? <Check size={15} /> : <ScanText size={15} />}
              </button>
            )}
            <button
              aria-label="Full PDF preview"
              data-tooltip="Full preview"
              onClick={() => onExpandPdf(false)}
            >
              <Maximize2 size={15} />
            </button>
            <button
              disabled={o.locked}
              aria-label="Edit PDF"
              data-tooltip="Edit PDF"
              onClick={() => onExpandPdf(true)}
            >
              <Pencil size={15} />
            </button>
          </>
        )}
        {kind === 'text' && format.current && (
          <>
            <button
              aria-label="Cancel changes"
              data-tooltip="Cancel changes"
              disabled={saving}
              onClick={onClose}
            >
              <X size={15} />
            </button>
            <button
              aria-label="Save document"
              data-tooltip="Save document"
              disabled={saving}
              onClick={close}
            >
              <Check size={16} />
            </button>
          </>
        )}
        <button
          aria-label="Download document"
          data-tooltip="Download"
          disabled={saving}
          onClick={() => void onDownload().catch(onError)}
        >
          <Download size={16} />
        </button>
        <button aria-label="Close document" data-tooltip="Close" disabled={saving} onClick={close}>
          <X size={16} />
        </button>
      </header>
      {pdf && (
        <nav className="document-page-controls" aria-label="PDF pages">
          <button
            aria-label="Previous page"
            data-tooltip="Previous page"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <span className="document-page-number">
            {page} / {pdf.numPages}
          </span>
          <button
            aria-label="Next page"
            data-tooltip="Next page"
            disabled={page === pdf.numPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={17} />
          </button>
          <span className="document-controls-spacer" />
          <button
            aria-label="Zoom document out"
            data-tooltip="Zoom out"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
          >
            <Minus size={15} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            aria-label="Zoom document in"
            data-tooltip="Zoom in"
            disabled={zoom >= 4}
            onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
          >
            <Plus size={15} />
          </button>
        </nav>
      )}
      {loading ? (
        <div className="document-reader-message" role="status">
          Opening document…
        </div>
      ) : message ? (
        <div className="document-reader-message" role="status">
          <FileText size={32} />
          <p>{message}</p>
        </div>
      ) : kind === 'text' ? (
        <textarea
          readOnly={o.locked}
          className="document-text-editor"
          aria-label="Edit document text"
          spellCheck={false}
          autoFocus
          disabled={saving}
          value={text}
          onChange={(event) => {
            draft.current = event.target.value;
            setText(event.target.value);
          }}
        />
      ) : kind === 'docx' && html ? (
        <iframe
          className="document-word-preview"
          title="Word document preview"
          sandbox=""
          srcDoc={html}
        />
      ) : kind === 'pdf' ? (
        <div className="document-pdf-page" aria-busy={pageLoading}>
          <div className="document-pdf-sheet">
            <div ref={pageHost} />
            {sheet && visibleText && !pageLoading && (
              <TextLayer
                ref={textLayer}
                text={visibleText}
                width={sheet.width}
                height={sheet.height}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="document-reader-message">
          <FileText size={34} />
          <p>
            {/\.(gdoc|gsheet|gslides)$/i.test(o.text || '')
              ? 'This is a Google Workspace shortcut. For an offline preview, import a PDF, Word, or Excel export of the document.'
              : 'This file is stored on your board. Download it to open it in its original app.'}
          </p>
          <button className="button" onClick={() => void onDownload().catch(onError)}>
            <Download size={16} />
            Download file
          </button>
        </div>
      )}
      {kind === 'text' && format.current && (
        <footer className="document-reader-footer">
          {saving
            ? 'Saving…'
            : text !== original.current
              ? 'Unsaved changes · Ctrl+Enter to save'
              : `${format.current.encoding.toUpperCase()} · Edit the board copy`}
        </footer>
      )}
    </section>
  );
});
export default DocumentReader;
