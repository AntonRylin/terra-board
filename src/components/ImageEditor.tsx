import { useEffect, useRef, useState } from 'react';
import { Eraser, RotateCcw } from 'lucide-react';
import { importFiles, invoke, mediaUrl } from '../bridge';
import type { Asset, CanvasObject } from '../model';
import {
  defaultImageAdjustments,
  imageFilterCss,
  isUnchanged,
  renderFilteredImage,
  type ImageAdjustments,
} from '../canvas/image-filters';
import { Modal } from './Dialogs';
import {
  BackgroundRemovalInstall,
  ImageFilterStrip,
  useBackgroundRemovalReady,
} from './ImageFilters';

const sliders = [
  { key: 'brightness', label: 'Brightness', min: 40, max: 160 },
  { key: 'contrast', label: 'Contrast', min: 40, max: 160 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 200 },
] as const;

async function loadImage(id: string) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  // The lossless, upright original, with its transparency.
  image.src = mediaUrl(id, 'export');
  await image.decode();
  return image;
}
async function originalType(id: string) {
  try {
    const response = await fetch(mediaUrl(id, 'original'));
    const type = response.headers.get('content-type');
    void response.body?.cancel();
    return type;
  } catch {
    return null;
  }
}
const errorText = (e: unknown) => String(e).replace(/^Error: /, '');

/**
 * Filters, adjustments and background removal for one image on the board.
 * Saving makes a new asset, so undo brings the original back.
 */
export default function ImageEditor({
  image,
  onApply,
  onClose,
}: {
  image: CanvasObject;
  onApply: (assetId: string) => void;
  onClose: () => void;
}) {
  const sourceId = image.assetId!;
  const [workingId, setWorkingId] = useState(sourceId);
  const [picture, setPicture] = useState<HTMLImageElement | null>(null);
  const [edit, setEdit] = useState<ImageAdjustments>(defaultImageAdjustments);
  const [busy, setBusy] = useState<'removing' | 'saving' | null>(null);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState(false);
  const removalReady = useBackgroundRemovalReady();
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    let live = true;
    setPicture(null);
    loadImage(workingId)
      .then((next) => live && setPicture(next))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [workingId]);
  const removed = workingId !== sourceId;

  // `installed` skips the check right after the install card finishes, before
  // the extension list has caught up here.
  async function removeBackground(installed = false) {
    if (busy) return;
    if (removed) {
      setWorkingId(sourceId);
      return;
    }
    if (!removalReady && !installed) {
      setInstalling(true);
      return;
    }
    setInstalling(false);
    setBusy('removing');
    setError('');
    try {
      const cutout = await invoke<Asset>('removeBackground', { id: sourceId });
      if (alive.current) setWorkingId(cutout.id);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  async function save() {
    if (busy) return;
    if (isUnchanged(edit)) {
      if (removed) onApply(workingId);
      else onClose();
      return;
    }
    if (!picture) return;
    setBusy('saving');
    setError('');
    try {
      const jpeg = !removed && /^image\/jpe?g$/.test((await originalType(sourceId)) || '');
      const type = jpeg ? 'image/jpeg' : 'image/png';
      const blob = await renderFilteredImage(picture, edit, type);
      const base = (image.text || 'Image').replace(/\.[a-z0-9]{1,5}$/i, '');
      const [asset] = await importFiles([
        new File([blob], `${base} (edited).${jpeg ? 'jpg' : 'png'}`, { type }),
      ]);
      if (alive.current) onApply(asset.id);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const changed = removed || !isUnchanged(edit);
  return (
    <Modal title="Edit image" onClose={() => !busy && onClose()} wide>
      <div className="image-editor">
        <div className="image-editor-preview" aria-busy={!picture || busy === 'removing'}>
          {picture ? (
            <img
              src={picture.src}
              alt="Edited image preview"
              draggable={false}
              style={{ filter: imageFilterCss(edit) }}
            />
          ) : (
            !error && <span className="image-editor-status">Loading image…</span>
          )}
          {busy === 'removing' && (
            <span className="image-editor-status overlay" role="status">
              Removing background on your computer…
            </span>
          )}
        </div>
        <div className="image-editor-controls">
          <section>
            <h3>Filters</h3>
            <ImageFilterStrip
              src={mediaUrl(workingId)}
              value={edit.filter}
              disabled={!!busy}
              onChange={(filter) => setEdit((e) => ({ ...e, filter }))}
            />
          </section>
          <section>
            <h3>Adjust</h3>
            {sliders.map((slider) => (
              <label key={slider.key} className="image-editor-slider">
                <span>
                  {slider.label}
                  <output>
                    {edit[slider.key] - 100 > 0 ? '+' : ''}
                    {edit[slider.key] - 100}
                  </output>
                </span>
                <input
                  type="range"
                  min={slider.min}
                  max={slider.max}
                  step="1"
                  value={edit[slider.key]}
                  disabled={!!busy}
                  onChange={(e) =>
                    setEdit((current) => ({ ...current, [slider.key]: Number(e.target.value) }))
                  }
                  onDoubleClick={() => setEdit((current) => ({ ...current, [slider.key]: 100 }))}
                />
              </label>
            ))}
          </section>
          <section>
            <h3>Background</h3>
            {installing ? (
              <BackgroundRemovalInstall
                onReady={() => void removeBackground(true)}
                onCancel={() => setInstalling(false)}
              />
            ) : (
              <button
                type="button"
                className="button image-editor-action"
                disabled={!!busy}
                onClick={() => void removeBackground()}
              >
                {removed ? <RotateCcw size={15} /> : <Eraser size={15} />}
                {busy === 'removing'
                  ? 'Removing background…'
                  : removed
                    ? 'Restore background'
                    : 'Remove background'}
              </button>
            )}
          </section>
          {error && (
            <p className="image-editor-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="dialog-actions image-editor-actions">
        <button
          type="button"
          className="button"
          disabled={!!busy || !changed}
          onClick={() => {
            setEdit(defaultImageAdjustments);
            setWorkingId(sourceId);
          }}
        >
          <RotateCcw size={14} />
          Reset
        </button>
        <span className="image-editor-spacer" />
        <button type="button" className="button" disabled={!!busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!!busy || !picture}
          onClick={() => void save()}
        >
          {busy === 'saving' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
