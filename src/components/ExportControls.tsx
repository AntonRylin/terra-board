import { Check, Download, ExternalLink, FolderOpen, X } from 'lucide-react';
import { Modal } from './Dialogs';
import type { ExportScope } from '../canvas/export-plan';
import type { ExportFormat } from '../canvas/export-format';

export interface ExportProgress {
  value: number;
  label: string;
}
export interface ExportResult {
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
}: {
  scope: ExportScope | null;
  progress: ExportProgress | null;
  result: ExportResult | null;
  onClose: () => void;
  onExport: (format: ExportFormat) => void;
  onDismiss: () => void;
  onOpen: (folder: boolean) => void;
}) {
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
          <div className="export-formats">
            {(
              [
                ['png', 'PNG', 'Crisp images and text'],
                ['jpg', 'JPG', 'Smaller file, easy to share'],
                ['pdf', 'PDF', 'One page, ready to print'],
              ] as const
            ).map(([format, label, detail]) => (
              <button key={format} onClick={() => onExport(format)}>
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
      {!progress && result && (
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
          </div>
        </div>
      )}
    </>
  );
}
