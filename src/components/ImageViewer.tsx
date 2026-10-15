import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, Download, Maximize2, Minus, Plus, Scan, ScanText } from 'lucide-react';
import type { CanvasObject } from '../model';
import { mediaUrl } from '../bridge';
import { canRecognizeText, imageAssetText } from '../canvas/page-text';
import { recognizedString, type RecognizedText } from '../canvas/recognized-text';
import TextLayer, { selectLayerText, startsTextSelection } from './TextLayer';
import './image-viewer.css';

interface Size {
  width: number;
  height: number;
}
interface ImageView {
  zoom: number;
  x: number;
  y: number;
}
interface Props {
  object: CanvasObject;
  onClose: () => void;
  onDownload: () => Promise<void>;
}

export function fitImageZoom(image: Size, viewport: Size): number {
  if (image.width <= 0 || image.height <= 0) return 1;
  return Math.min(
    1,
    Math.max(1, viewport.width - 48) / image.width,
    Math.max(1, viewport.height - 48) / image.height,
  );
}

export function clampImageView(view: ImageView, image: Size, viewport: Size): ImageView {
  const zoom = Math.max(
    Math.min(0.1, fitImageZoom(image, viewport)),
    Math.min(8, Number.isFinite(view.zoom) ? view.zoom : 1),
  );
  const bound = (value: number, extent: number) => {
    const limit = Math.max(0, extent / 2);
    return limit ? Math.max(-limit, Math.min(limit, Number.isFinite(value) ? value : 0)) : 0;
  };
  return {
    zoom,
    x: bound(view.x, image.width * zoom - viewport.width),
    y: bound(view.y, image.height * zoom - viewport.height),
  };
}

export function zoomImageView(
  view: ImageView,
  zoom: number,
  anchor: { x: number; y: number },
  image: Size,
  viewport: Size,
): ImageView {
  const next = clampImageView({ ...view, zoom }, image, viewport);
  const ratio = next.zoom / view.zoom;
  const x = anchor.x - viewport.width / 2,
    y = anchor.y - viewport.height / 2;
  return clampImageView(
    { zoom: next.zoom, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio },
    image,
    viewport,
  );
}

function Tool({
  label,
  children,
  ...props
}: { label: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-label={label} data-tooltip={label} {...props}>
      {children}
    </button>
  );
}

function ImageViewerSession({ object, onClose, onDownload }: Props) {
  const root = useRef<HTMLElement>(null),
    stage = useRef<HTMLDivElement>(null);
  const alive = useRef(false),
    downloadPending = useRef(false);
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [manualView, setManualView] = useState<ImageView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(
    object.assetId ? 'loading' : 'error',
  );
  const [downloading, setDownloading] = useState(false),
    [downloadError, setDownloadError] = useState('');
  const [panning, setPanning] = useState(false);
  const [text, setText] = useState<RecognizedText | null>(null),
    [textState, setTextState] = useState<'reading' | 'ready' | 'error' | 'off'>(
      canRecognizeText() && object.assetId ? 'reading' : 'off',
    ),
    [copied, setCopied] = useState(false);
  const textLayer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; startX: number; startY: number; x: number; y: number } | null>(
    null,
  );
  const view = manualView
    ? clampImageView(manualView, natural, viewport)
    : { zoom: fitImageZoom(natural, viewport), x: 0, y: 0 };
  const live = useRef({ natural, viewport, view, ready: false });
  live.current = { natural, viewport, view, ready: state === 'ready' };
  const title = object.imageTitle || object.text || 'Image';
  const pannable =
    state === 'ready' &&
    (natural.width * view.zoom > viewport.width || natural.height * view.zoom > viewport.height);

  const setView = (next: ImageView) => {
    live.current.view = next;
    setManualView(next);
  };
  const fit = () => {
    live.current.view = {
      zoom: fitImageZoom(live.current.natural, live.current.viewport),
      x: 0,
      y: 0,
    };
    setManualView(null);
  };
  const actualSize = () => setView({ zoom: 1, x: 0, y: 0 });
  const zoomBy = (factor: number) => {
    const current = live.current;
    if (!current.ready) return;
    setView(
      zoomImageView(
        current.view,
        current.view.zoom * factor,
        { x: current.viewport.width / 2, y: current.viewport.height / 2 },
        current.natural,
        current.viewport,
      ),
    );
  };
  const download = async () => {
    if (downloadPending.current) return;
    downloadPending.current = true;
    root.current?.focus({ preventScroll: true });
    setDownloading(true);
    setDownloadError('');
    try {
      await onDownload();
    } catch (error) {
      if (alive.current) setDownloadError(error instanceof Error ? error.message : String(error));
    } finally {
      downloadPending.current = false;
      if (alive.current) {
        setDownloading(false);
        if (!root.current?.contains(document.activeElement))
          root.current?.focus({ preventScroll: true });
      }
    }
  };

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const app = document.getElementById('root');
    const wasInert = !!app?.inert && !app.hasAttribute('data-mcp-inert');
    if (app) app.inert = true;
    root.current?.focus();
    return () => {
      alive.current = false;
      drag.current = null;
      if (app) app.inert = wasInert || app.hasAttribute('data-mcp-inert');
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const host = stage.current,
      dialog = root.current;
    if (!host || !dialog) return;
    const measure = () => setViewport({ width: host.clientWidth, height: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const current = live.current;
      if (!host.contains(event.target as Node) || !current.ready || drag.current) return;
      const rect = host.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.viewport.height : 1;
      const delta = Math.max(-150, Math.min(150, event.deltaY * unit));
      setView(
        zoomImageView(
          current.view,
          current.view.zoom * Math.exp(-delta * 0.002),
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          current.natural,
          current.viewport,
        ),
      );
    };
    dialog.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      dialog.removeEventListener('wheel', wheel);
    };
  }, []);

  useEffect(() => {
    if (!root.current?.contains(document.activeElement))
      root.current?.focus({ preventScroll: true });
  }, [state, view.zoom, downloading]);

  useEffect(() => {
    if (state !== 'ready' || textState !== 'reading' || !object.assetId) return;
    let cancelled = false;
    imageAssetText(object.assetId).then(
      (value) => {
        if (cancelled) return;
        setText(value);
        setTextState('ready');
      },
      () => !cancelled && setTextState('error'),
    );
    return () => {
      cancelled = true;
    };
  }, [state]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const textCount = text ? recognizedString(text).length : 0;
  const copyText = () => {
    if (!text || !textCount) return;
    void window.canvas
      ?.copyText(recognizedString(text))
      .then(() => alive.current && setCopied(true));
  };

  return createPortal(
    <section
      ref={root}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      data-image-id={object.id}
      data-state={state}
      tabIndex={-1}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (startsTextSelection(event.target)) root.current?.focus({ preventScroll: true });
        else if (!(event.target as HTMLElement).closest('button')) {
          event.preventDefault();
          root.current?.focus({ preventScroll: true });
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Tab') {
          const controls = [
            ...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
          ].filter((item) => item.getClientRects().length);
          const first = controls[0],
            last = controls.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === root.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          if (!event.repeat) void download();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          selectLayerText(textLayer.current);
          return;
        }
        if (event.altKey) return;
        if (['+', '=', '-', '_', '0', '1'].includes(event.key)) {
          event.preventDefault();
          if (state !== 'ready') return;
          if (event.key === '0') fit();
          else if (event.key === '1') actualSize();
          else zoomBy(event.key === '+' || event.key === '=' ? 1.25 : 0.8);
        }
      }}
    >
      <header className="image-viewer-header">
        <Tool label="Close image preview" onClick={onClose}>
          <ChevronLeft size={19} />
        </Tool>
        <div className="image-viewer-title">
          <span>{title}</span>
        </div>
        {textState !== 'off' && (
          <Tool
            label={
              copied
                ? 'Copied'
                : textState === 'reading'
                  ? 'Reading text…'
                  : textState === 'error'
                    ? 'Text could not be read'
                    : textCount
                      ? 'Copy text'
                      : 'No text found'
            }
            className="image-viewer-copy-text"
            data-state={textState}
            disabled={!textCount}
            onClick={copyText}
          >
            {copied ? <Check size={18} /> : <ScanText size={18} />}
          </Tool>
        )}
        <Tool label="Download image" disabled={downloading} onClick={() => void download()}>
          <Download size={18} />
        </Tool>
      </header>
      <div
        ref={stage}
        className="image-viewer-stage"
        data-zoom={view.zoom}
        data-image-width={natural.width}
        data-image-height={natural.height}
        data-pannable={pannable || undefined}
        data-panning={panning || undefined}
        aria-busy={state === 'loading'}
        onPointerDown={(event) => {
          if (event.button !== 0 || startsTextSelection(event.target)) return;
          event.preventDefault();
          root.current?.focus({ preventScroll: true });
          getSelection()?.removeAllRanges();
          if (!pannable) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            x: live.current.view.x,
            y: live.current.view.y,
          };
          setPanning(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current,
            current = live.current;
          if (!start || start.id !== event.pointerId) return;
          setView(
            clampImageView(
              {
                zoom: current.view.zoom,
                x: start.x + event.clientX - start.startX,
                y: start.y + event.clientY - start.startY,
              },
              current.natural,
              current.viewport,
            ),
          );
        }}
        onPointerUp={(event) => {
          if (drag.current?.id !== event.pointerId) return;
          drag.current = null;
          setPanning(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPanning(false);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setPanning(false);
        }}
      >
        {object.assetId && (
          <img
            className="image-viewer-image"
            src={mediaUrl(object.assetId, 'export')}
            alt={title}
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            style={{
              width: natural.width || undefined,
              height: natural.height || undefined,
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
              visibility: state === 'ready' ? 'visible' : 'hidden',
            }}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (!image.naturalWidth || !image.naturalHeight) {
                setState('error');
                return;
              }
              setNatural({ width: image.naturalWidth, height: image.naturalHeight });
              setState('ready');
            }}
            onError={() => setState('error')}
          />
        )}
        {text && state === 'ready' && (
          <TextLayer
            ref={textLayer}
            text={text}
            width={natural.width}
            height={natural.height}
            style={{
              left: '50%',
              top: '50%',
              transformOrigin: 'center',
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            }}
          />
        )}
        {state === 'loading' && (
          <div className="image-viewer-message" role="status">
            Opening image…
          </div>
        )}
        {state === 'error' && (
          <div className="image-viewer-message image-viewer-load-error" role="alert">
            This image could not be opened.<span>You can still download the original.</span>
          </div>
        )}
      </div>
      <footer className="image-viewer-controls" aria-label="Image view">
        <Tool
          label="Zoom image out"
          disabled={
            state !== 'ready' || view.zoom <= Math.min(0.1, fitImageZoom(natural, viewport))
          }
          onClick={() => zoomBy(0.8)}
        >
          <Minus size={17} />
        </Tool>
        <span className="image-viewer-zoom">
          {state === 'ready' ? `${Math.round(view.zoom * 100)}%` : '—'}
        </span>
        <Tool
          label="Zoom image in"
          disabled={state !== 'ready' || view.zoom >= 8}
          onClick={() => zoomBy(1.25)}
        >
          <Plus size={17} />
        </Tool>
        <span className="image-viewer-divider" />
        <Tool
          label="Fit image"
          disabled={state !== 'ready'}
          aria-pressed={!manualView}
          onClick={fit}
        >
          <Maximize2 size={17} />
        </Tool>
        <Tool
          label="Actual image size"
          disabled={state !== 'ready'}
          aria-pressed={!!manualView && view.zoom === 1}
          onClick={actualSize}
        >
          <Scan size={17} />
        </Tool>
      </footer>
      {downloadError && (
        <div className="image-viewer-download-error" role="alert">
          {downloadError}
        </div>
      )}
    </section>,
    document.body,
  );
}

export default function ImageViewer(props: Props) {
  return <ImageViewerSession key={`${props.object.id}:${props.object.assetId || ''}`} {...props} />;
}
