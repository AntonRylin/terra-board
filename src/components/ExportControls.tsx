import { Check, CircleAlert, Copy, Download, ExternalLink, FolderOpen, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Modal } from './Dialogs';
import type { ExportScope, ExportQuality } from '../canvas/export-plan';
import type { ExportFormat } from '../canvas/export-format';

export interface ExportProgress {
  value: number;
  label: string;
}
export interface ExportResult {
  detail?: string;
  id?: string;
  name: string;
  url?: string;
}
export default function ExportControls({
  scope,
  progress,
  result,
  onClose,
  onExport,
  onDismiss,
  onOpen,
  onCopy,
}: {
  scope: ExportScope | null;
  progress: ExportProgress | null;
  result: ExportResult | null;
  onClose: () => void;
  onExport: (format: ExportFormat, quality: ExportQuality) => void;
  onDismiss: () => void;
  onOpen: (folder: boolean) => void;
  onCopy: () => Promise<void>;
}) {
  const [quality, setQuality] = useState<ExportQuality>('full');
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => setCopied(null), [result]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      {scope && (
        <Modal
          title={scope === 'selection' ? 'Export selected items' : 'Export visible area'}
          onClose={onClose}
        >
          <p className="export-description">
            {scope === 'selection'
              ? 'Save the selected items together in one file.'
              : 'Save the area currently in view.'}
          </p>
          <div className="export-quality" role="group" aria-label="Export resolution">
            {(
              [
                ['full', 'Full quality', 'Original detail'],
                ['2k', '2K', '2048 px'],
                ['4k', '4K', '4096 px'],
              ] as const
            ).map(([value, label, detail]) => (
              <button
                key={value}
                type="button"
                data-quality={value}
                aria-pressed={quality === value}
                onClick={() => setQuality(value)}
              >
                <strong>{label}</strong>
                <small>{detail}</small>
              </button>
            ))}
          </div>
          <p className="export-quality-note">
            {quality === 'full'
              ? 'Original image detail and sharp text. Up to 8K / 32 megapixels.'
              : 'Sets the longest edge; keeps the original proportions.'}
          </p>
          <div className="export-formats">
            {(
              [
                ['png', 'PNG', 'Crisp images and text'],
                ['jpg', 'JPG', 'Smaller file, easy to share'],
                ['pdf', 'PDF', 'One page, ready to print'],
              ] as const
            ).map(([format, label, detail]) => (
              <button key={format} onClick={() => onExport(format, quality)}>
                <Download size={18} />
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {progress && (
        <div className="export-toast" role="status" aria-live="polite">
          <div className="export-toast-heading">
            <Download size={17} />
            <strong>Exporting…</strong>
            <span>{progress.value}%</span>
          </div>
          <progress aria-label="Export progress" value={progress.value} max={100} />
          <span className="export-detail">{progress.label}</span>
        </div>
      )}
      {!scope && !progress && result && (
        <div className="export-toast" role="status">
          <div className="export-toast-heading">
            <Check size={18} />
            <strong>Export complete</strong>
            <button
              className="icon-button"
              aria-label="Dismiss export notification"
              onClick={onDismiss}
            >
              <X size={16} />
            </button>
          </div>
          <span className="export-filename" title={result.name}>
            {result.name}
          </span>
          {result.detail && <span className="export-result-detail">{result.detail}</span>}
          <div className="export-actions">
            <button className="button" onClick={() => onOpen(false)}>
              <ExternalLink size={15} />
              Open file
            </button>
            {result.id && (
              <button className="button" onClick={() => onOpen(true)}>
                <FolderOpen size={15} />
                Open folder
              </button>
            )}
            {/\.(png|jpe?g)$/i.test(result.name) && (
              <button
                className="button export-copy"
                onClick={() =>
                  void onCopy().then(
                    () => setCopied('copied'),
                    () => setCopied('failed'),
                  )
                }
              >
                <Copy size={15} />
                Copy
              </button>
            )}
          </div>
          {copied && (
            <div className="toast export-copy-toast" role="status" data-state={copied}>
              {copied === 'copied' ? <Check size={15} /> : <CircleAlert size={15} />}
              {copied === 'copied' ? 'Copied' : 'Failed to copy'}
            </div>
          )}
        </div>
      )}
    </>
  );
}
