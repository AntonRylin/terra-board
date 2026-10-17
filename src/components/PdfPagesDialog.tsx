import { useEffect, useRef, useState } from 'react';
import { GalleryHorizontal, GalleryVertical } from 'lucide-react';
import { Modal } from './Dialogs';
import { clampGap, pageGap, type PageStack } from '../canvas/pdf-pages';
import './pdf-export-dialog.css';

const storageKey = 'terra-board.pdf-pages';
function remembered(): { stack: PageStack; gap: number } {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return {
      stack: value?.stack === 'horizontal' ? 'horizontal' : 'vertical',
      gap: clampGap(Number(value?.gap ?? pageGap.initial)),
    };
  } catch {
    return { stack: 'vertical', gap: pageGap.initial };
  }
}

export default function PdfPagesDialog({
  name,
  pageCount,
  onClose,
  onConvert,
}: {
  name: string;
  pageCount?: number;
  onClose: () => void;
  onConvert: (
    stack: PageStack,
    gap: number,
    signal: AbortSignal,
    progress: (done: number, total: number) => void,
  ) => Promise<void>;
}) {
  const [{ stack, gap }, setChoice] = useState(remembered);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const choose = (next: { stack: PageStack; gap: number }) => {
    setChoice(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  };
  const close = () => {
    active.current?.abort();
    onClose();
  };
  async function convert() {
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setProgress('Opening PDF…');
    try {
      await onConvert(stack, gap, controller.signal, (done, total) => {
        if (mounted.current)
          setProgress(`Rendering page ${Math.min(done + 1, total)} of ${total}…`);
      });
      if (mounted.current) onClose();
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'The pages could not be created.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  // A to-scale sketch: three A4 pages, 28 px wide for a 595 pt page.
  const scale = 28 / 595;
  const pages = Math.min(3, pageCount || 3);
  return (
    <Modal title="Pages to images" onClose={close}>
      <p className="export-description pdf-export-name">
        {name}
        {pageCount ? ` · ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : ''}
      </p>
      <div className="export-quality pdf-size-presets" role="group" aria-label="Page layout">
        {(
          [
            ['vertical', 'Vertical', 'Stacked top to bottom', GalleryVertical],
            ['horizontal', 'Horizontal', 'Side by side', GalleryHorizontal],
          ] as const
        ).map(([id, label, detail, Icon]) => (
          <button
            key={id}
            type="button"
            data-page-stack={id}
            aria-pressed={stack === id}
            disabled={busy}
            onClick={() => choose({ stack: id, gap })}
          >
            <strong>
              <Icon size={15} /> {label}
            </strong>
            <small>{detail}</small>
          </button>
        ))}
      </div>
      <label className="pdf-pages-gap">
        <span>
          Space between pages
          <input
            aria-label="Space between pages"
            type="number"
            min={pageGap.min}
            max={pageGap.max}
            step={pageGap.step}
            value={gap}
            disabled={busy}
            onChange={(event) => choose({ stack, gap: clampGap(Number(event.target.value)) })}
          />
        </span>
        <input
          type="range"
          aria-label="Space between pages slider"
          min={pageGap.min}
          max={pageGap.max}
          step={pageGap.step}
          value={gap}
          disabled={busy}
          onChange={(event) => choose({ stack, gap: clampGap(Number(event.target.value)) })}
        />
      </label>
      <div className="pdf-pages-sketch" data-stack={stack} aria-hidden="true">
        <div style={{ gap: Math.max(1, gap * scale) }}>
          {Array.from({ length: pages }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
      </div>
      <p className="export-quality-note">
        Each page becomes an image next to the PDF. Leave space for notes, then select the pages and
        choose Merge as PDF to make a PDF again.
      </p>
      {error && (
        <p role="alert" className="pdf-size-error">
          {error}
        </p>
      )}
      {busy && <p role="status">{progress}</p>}
      <div className="pdf-size-actions">
        <button className="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          data-pdf-pages-convert
          disabled={busy}
          onClick={() => void convert()}
        >
          Create images
        </button>
      </div>
    </Modal>
  );
}
