import { useEffect, useRef } from 'react';
import { Download, X } from 'lucide-react';
import { useExtensionInstalled, useExtensions } from '../extensions';
import { imageFilterCss, imageFilterPresets, type ImageFilterId } from '../canvas/image-filters';
import './image-editor.css';

/** A row of looks to pick from, each previewed on the image itself. */
export function ImageFilterStrip({
  src,
  value,
  onChange,
  disabled,
  compact = false,
}: {
  src: string;
  value: ImageFilterId;
  onChange: (id: ImageFilterId) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={'image-filter-strip' + (compact ? ' compact' : '')}
      role="radiogroup"
      aria-label="Filters"
      onWheel={(e) => {
        // A mouse wheel scrolls the single row sideways.
        if (!compact || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.currentTarget.scrollLeft += e.deltaY;
      }}
    >
      {imageFilterPresets.map((preset) => (
        <button
          key={preset.id}
          type="button"
          role="radio"
          aria-checked={value === preset.id}
          className="image-filter-choice"
          disabled={disabled}
          title={preset.label}
          onClick={() => onChange(preset.id)}
        >
          <span className="image-filter-thumb">
            <img
              src={src}
              alt=""
              draggable={false}
              style={{ filter: imageFilterCss({ filter: preset.id }) }}
            />
          </span>
          <span className="image-filter-name">{preset.label}</span>
        </button>
      ))}
    </div>
  );
}

// Background removal is an extension. Outside the desktop app the local
// server does the work, so it always counts as ready there.
export function useBackgroundRemovalReady() {
  const installed = useExtensionInstalled('background-removal');
  return !window.canvas || installed;
}

const megabytes = (bytes: number) => {
  const mb = bytes / 1048576;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
};

/** Offers to install background removal, then calls `onReady` once it's in. */
export function BackgroundRemovalInstall({
  onReady,
  onCancel,
}: {
  onReady: () => void;
  onCancel: () => void;
}) {
  const list = useExtensions();
  const extension = list?.find((e) => e.id === 'background-removal');
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    if (extension?.state === 'installed') ready.current();
  }, [extension?.state]);
  const api = window.canvas?.extensions;
  if (!api || !extension) return null;
  if (extension.state === 'installing') {
    const total = extension.progress?.total || extension.downloadBytes;
    const received = Math.min(extension.progress?.received ?? 0, total);
    const percent = total ? Math.round((received * 100) / total) : 0;
    return (
      <div className="extension-install-card" role="status">
        <b>Installing background removal…</b>
        <div
          className="extension-install-progress"
          role="progressbar"
          aria-label="Installing background removal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="extension-install-row">
          <span>
            {megabytes(received)} of {megabytes(total)}
          </span>
          <button
            type="button"
            className="button"
            onClick={() => {
              void api.cancel(extension.id).catch(() => {});
            }}
          >
            <X size={14} />
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="extension-install-card"
      role="alertdialog"
      aria-label="Install background removal"
    >
      <b>Background removal isn't installed</b>
      <p>
        It's an extension that works on your computer, so your images never leave it.{' '}
        {megabytes(extension.downloadBytes)} download. You can remove it later in Settings →
        Extensions.
      </p>
      {extension.error && (
        <p className="extension-install-error" role="alert">
          {extension.error}
        </p>
      )}
      <div className="extension-install-row end">
        <button type="button" className="button" onClick={onCancel}>
          Not now
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            void api.install(extension.id).catch(() => {});
          }}
        >
          <Download size={14} />
          Install
        </button>
      </div>
    </div>
  );
}
