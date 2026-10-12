import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Modal } from './Dialogs';
import './pdf-export-dialog.css';

export interface PreparedPdf {
  bytes: Uint8Array<ArrayBuffer>;
  name: string;
  pageCount: number;
}
const presets = [
  ['email', 'Email', 'Up to 10 MB'],
  ['small', 'Small', 'Up to 2 MB'],
  ['original', 'Original', 'Full detail'],
  ['custom', 'Custom', 'Your size'],
] as const;
type Preset = (typeof presets)[number][0];
export default function PdfExportDialog({
  name,
  onClose,
  onPrepare,
  onSave,
}: {
  name: string;
  onClose: () => void;
  onPrepare: (
    target: number | undefined,
    signal: AbortSignal,
    progress: (message: string) => void,
  ) => Promise<PreparedPdf>;
  onSave: (pdf: PreparedPdf) => Promise<boolean>;
}) {
  const [preset, setPreset] = useState<Preset>('email');
  const [custom, setCustom] = useState('10');
  const [result, setResult] = useState<PreparedPdf | null>(null);
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
  const targetMb =
    preset === 'original'
      ? undefined
      : preset === 'email'
        ? 10
        : preset === 'small'
          ? 2
          : Number(custom);
  const valid =
    targetMb === undefined || (Number.isFinite(targetMb) && targetMb >= 0.1 && targetMb <= 50);
  const change = () => {
    setResult(null);
    setError('');
  };
  async function prepare() {
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setResult(null);
    setProgress('Preparing PDF…');
    try {
      const pdf = await onPrepare(
        targetMb === undefined ? undefined : Math.floor(targetMb * 1_000_000),
        controller.signal,
        (message) => {
          if (mounted.current) setProgress(message);
        },
      );
      controller.signal.throwIfAborted();
      if (mounted.current) setResult(pdf);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'PDF export failed.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function save() {
    if (!result) return;
    setBusy(true);
    setProgress('Choose where to save…');
    setError('');
    try {
      if (await onSave(result)) onClose();
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : 'The PDF could not be saved.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="Export PDF"
      onClose={() => {
        active.current?.abort();
        onClose();
      }}
    >
      <p className="export-description pdf-export-name">{name}</p>
      <div className="export-quality pdf-size-presets" role="group" aria-label="PDF file size">
        {presets.map(([id, label, detail]) => (
          <button
            key={id}
            type="button"
            data-pdf-size={id}
            aria-pressed={preset === id}
            disabled={busy}
            onClick={() => {
              setPreset(id);
              change();
            }}
          >
            <strong>{label}</strong>
            <small>{detail}</small>
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <label className="pdf-size-target">
          Target size
          <span>
            <input
              aria-label="Target size in MB"
              type="number"
              min="0.1"
              max="50"
              step="0.1"
              value={custom}
              disabled={busy}
              onChange={(event) => {
                setCustom(event.target.value);
                change();
              }}
            />{' '}
            MB
          </span>
        </label>
      )}
      <p className="export-quality-note">
        {preset === 'original'
          ? 'Preserves selectable text and original detail. Large image batches are resized only when needed.'
          : 'Compresses only if needed to meet the size target. Compressed pages become images; text may no longer be selectable. Originals stay unchanged.'}
      </p>
      {!valid && (
        <p role="alert" className="pdf-size-error">
          Choose a target from 0.1 to 50 MB.
        </p>
      )}
      {error && (
        <p role="alert" className="pdf-size-error">
          {error}
        </p>
      )}
      {busy && <p role="status">{progress}</p>}
      {result && !busy && (
        <div className="pdf-size-result" role="status" data-pdf-bytes={result.bytes.length}>
          <strong>{(result.bytes.length / 1_000_000).toFixed(2)} MB</strong>
          <span>
            {result.pageCount} {result.pageCount === 1 ? 'page' : 'pages'} · Ready to save
          </span>
        </div>
      )}
      <div className="pdf-size-actions">
        <button
          className="button"
          onClick={() => {
            active.current?.abort();
            onClose();
          }}
        >
          Cancel
        </button>
        {result ? (
          <button
            className="button primary"
            data-pdf-save
            disabled={busy}
            onClick={() => void save()}
          >
            <Download size={16} /> Save PDF
          </button>
        ) : (
          <button
            className="button primary"
            data-pdf-prepare
            disabled={busy || !valid}
            onClick={() => void prepare()}
          >
            Prepare PDF
          </button>
        )}
      </div>
    </Modal>
  );
}
