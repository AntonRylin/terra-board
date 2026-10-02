import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Upload, RotateCcw, Eraser } from 'lucide-react';
import { chooseFiles, importFiles, invoke, mediaUrl } from '../bridge';
import type { Asset } from '../model';
import { BoardGlyph } from './Icon';
import { iconCrop } from '../canvas/icon-crop';

export interface BoardIconImageHandle {
  save: () => Promise<string>;
  clear: () => void;
  importFile: (file?: File) => Promise<void>;
}
const viewport = 200;
async function decodeIcon(id: string) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  // Crop the lossless, orientation-correct original, including its alpha channel.
  image.src = mediaUrl(id, 'export');
  await image.decode();
  return image;
}
const BoardIconImage = forwardRef<
  BoardIconImageHandle,
  {
    value: string;
    color: string;
    shape: 'rounded' | 'circle';
    onBusy: (busy: boolean) => void;
    onClear: () => void;
    boardName: string;
    showInitial: boolean;
    initialFile?: File;
  }
>(({ value, color, shape, onBusy, onClear, boardName, showInitial, initialFile }, ref) => {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState({ x: 0.5, y: 0.5 });
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [source, setSource] = useState<{ id: string; image: HTMLImageElement } | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const reset = () => {
    setZoom(1);
    setCenter({ x: 0.5, y: 0.5 });
  };
  const crop = image
    ? iconCrop(image.naturalWidth, image.naturalHeight, zoom, center.x, center.y)
    : null;
  async function load(file?: File) {
    if (!file || pending.current) return;
    const token = ++generation.current;
    pending.current = true;
    setLoading(true);
    onBusy(true);
    setError('');
    try {
      const [asset] = await importFiles([file]);
      if (!asset.mime.startsWith('image/')) throw Error('Choose an image for your board icon.');
      const next = await decodeIcon(asset.id);
      if (token !== generation.current) return;
      setSource({ id: asset.id, image: next });
      setImage(next);
      setRemoved(false);
      reset();
    } catch (e) {
      if (token === generation.current) setError(String(e).replace(/^Error: /, ''));
    } finally {
      if (token === generation.current) {
        pending.current = false;
        setLoading(false);
        setRemoving(false);
        onBusy(false);
      }
    }
  }
  async function removeBackground() {
    if (pending.current) return;
    if (removed && source) {
      setImage(source.image);
      setRemoved(false);
      return;
    }
    const id = source?.id || (/^asset-[a-f0-9]{64}$/.test(value) ? value.slice(6) : null);
    if (!id) return;
    const token = ++generation.current;
    pending.current = true;
    setLoading(true);
    setRemoving(true);
    setError('');
    onBusy(true);
    try {
      const original = source || { id, image: await decodeIcon(id) };
      if (token !== generation.current) return;
      setSource(original);
      setImage(original.image);
      const cutout = await invoke<Asset>('removeBackground', { id, icon: true });
      const next = await decodeIcon(cutout.id);
      if (token !== generation.current) return;
      setImage(next);
      setRemoved(true);
    } catch (e) {
      if (token === generation.current) setError(String(e).replace(/^Error: /, ''));
    } finally {
      if (token === generation.current) {
        pending.current = false;
        setLoading(false);
        setRemoving(false);
        onBusy(false);
      }
    }
  }
  const loadedFile = useRef<File | null>(null);
  useEffect(() => {
    if (initialFile && initialFile !== loadedFile.current) {
      loadedFile.current = initialFile;
      void load(initialFile);
    }
  }, [initialFile]);
  useImperativeHandle(ref, () => ({
    importFile: load,
    clear() {
      generation.current++;
      pending.current = false;
      setLoading(false);
      setRemoving(false);
      setRemoved(false);
      setSource(null);
      setImage(null);
      setError('');
      reset();
    },
    async save() {
      if (pending.current) throw Error('Wait for the icon to finish processing.');
      if (!image || !crop) return value;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 512;
      const context = canvas.getContext('2d')!;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, 512, 512);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(Error('Could not crop this image.'))),
          'image/png',
        ),
      );
      const asset = await invoke<Asset>('importAsset', {
        name: 'Board icon.png',
        bytes: await blob.arrayBuffer(),
      });
      return 'asset-' + asset.id;
    },
  }));
  return (
    <section
      className={'board-icon-upload' + (over ? ' drag-over' : '')}
      aria-label="Upload board icon"
      aria-busy={loading}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void load(e.dataTransfer.files[0]);
      }}
    >
      {image && crop ? (
        <>
          <div
            className={'board-icon-crop shape-' + shape}
            role="group"
            aria-label="Move image to crop"
            tabIndex={0}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.focus();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, left: crop.x, top: crop.y };
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              const x = Math.max(
                0,
                Math.min(
                  image.naturalWidth - crop.size,
                  drag.current.left - ((e.clientX - drag.current.x) * crop.size) / viewport,
                ),
              );
              const y = Math.max(
                0,
                Math.min(
                  image.naturalHeight - crop.size,
                  drag.current.top - ((e.clientY - drag.current.y) * crop.size) / viewport,
                ),
              );
              setCenter({
                x: (x + crop.size / 2) / image.naturalWidth,
                y: (y + crop.size / 2) / image.naturalHeight,
              });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
              e.preventDefault();
              const step = crop.size / 20;
              const x =
                crop.x + (e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0);
              const y = crop.y + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0);
              const next = iconCrop(
                image.naturalWidth,
                image.naturalHeight,
                zoom,
                (x + crop.size / 2) / image.naturalWidth,
                (y + crop.size / 2) / image.naturalHeight,
              );
              setCenter({
                x: (next.x + crop.size / 2) / image.naturalWidth,
                y: (next.y + crop.size / 2) / image.naturalHeight,
              });
            }}
          >
            <img
              key={image.src}
              src={image.src}
              alt="Icon crop preview"
              draggable={false}
              style={{
                width: (image.naturalWidth / crop.size) * viewport,
                height: (image.naturalHeight / crop.size) * viewport,
                left: (-crop.x / crop.size) * viewport,
                top: (-crop.y / crop.size) * viewport,
              }}
            />
            <span className="icon-crop-grid" aria-hidden="true" />
          </div>
          <div className="icon-crop-controls">
            <label>
              Zoom
              <input
                aria-label="Icon zoom"
                type="range"
                min="1"
                max="4"
                step="0.01"
                value={zoom}
                onChange={(e) => {
                  setCenter({
                    x: (crop.x + crop.size / 2) / image.naturalWidth,
                    y: (crop.y + crop.size / 2) / image.naturalHeight,
                  });
                  setZoom(Number(e.target.value));
                }}
              />
            </label>
            <button
              type="button"
              className="icon-button"
              aria-label="Reset icon crop"
              onClick={reset}
            >
              <RotateCcw size={16} />
            </button>
          </div>
          <p>Drag to position. Save to use this crop.</p>
        </>
      ) : (
        <button
          type="button"
          className={'icon-preview app-icon ' + color + ' shape-' + shape}
          aria-label={value === 'none' ? 'Color only icon' : 'Remove selected icon'}
          disabled={loading || value === 'none'}
          onClick={onClear}
        >
          <BoardGlyph name={value} size={30} boardName={boardName} showInitial={showInitial} />
        </button>
      )}
      <button
        type="button"
        className="button"
        disabled={loading}
        onClick={async () => {
          const [file] = await chooseFiles('image/*,.ico,.tif,.tiff');
          await load(file);
        }}
      >
        <Upload size={15} />
        {removing
          ? 'Removing background…'
          : loading
            ? 'Loading image…'
            : image
              ? 'Choose another image'
              : 'Upload image'}
      </button>
      <p>{over ? 'Drop image here' : 'or drag an image here'}</p>
      {(image || value.startsWith('asset-')) && (
        <button
          type="button"
          className="button icon-background-action"
          disabled={loading}
          onClick={() => void removeBackground()}
        >
          {removed ? <RotateCcw size={14} /> : <Eraser size={14} />}
          {removed ? 'Restore original' : 'Remove background'}
        </button>
      )}
      {removing && <p role="status">Removing background on your computer…</p>}
      {image && (
        <button
          type="button"
          className="button remove-icon-image"
          disabled={loading}
          onClick={() => {
            setImage(null);
            reset();
            onClear();
          }}
        >
          Remove image
        </button>
      )}
      {error && (
        <p className="icon-upload-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
});
export default BoardIconImage;
