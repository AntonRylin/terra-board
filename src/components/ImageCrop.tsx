import { useLayoutEffect, useRef, useState } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import type { Camera, CanvasObject, ImageCrop as Crop } from '../model';
import { adjustCrop, fullCrop } from '../canvas/crop';
import { localToWorld, rotatePoint, objectBounds } from '../canvas/transform';

type Edge = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const handles: [Edge, string, number, number][] = [
  ['nw', 'top left', 0, 0],
  ['n', 'top', 0.5, 0],
  ['ne', 'top right', 1, 0],
  ['e', 'right', 1, 0.5],
  ['se', 'bottom right', 1, 1],
  ['s', 'bottom', 0.5, 1],
  ['sw', 'bottom left', 0, 1],
  ['w', 'left', 0, 0.5],
];
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export default function ImageCrop({
  image,
  camera,
  value,
  onChange,
  onApply,
  onCancel,
}: {
  image: CanvasObject;
  camera: Camera;
  value: Crop;
  onChange: (crop: Crop) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ edge: Edge; x: number; y: number; crop: Crop } | null>(null);
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
  useLayoutEffect(() => {
    root.current!.focus();
    const observer = new ResizeObserver(() =>
      setViewport({ width: root.current!.clientWidth, height: root.current!.clientHeight }),
    );
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  const width = image.width * camera.zoom,
    height = image.height * camera.zoom;
  const minWidth = Math.min(1, Math.max(1e-6, 1 / image.width, 12 / width));
  const minHeight = Math.min(1, Math.max(1e-6, 1 / image.height, 12 / height));
  const adjust = (before: Crop, edge: Edge, dx: number, dy: number) => {
    onChange(adjustCrop(before, edge, dx, dy, minWidth, minHeight));
  };
  const center = localToWorld(image, {
    x: (value.x + value.width / 2) * image.width,
    y: (value.y + value.height / 2) * image.height,
  });
  const box = {
    left: center.x * camera.zoom + camera.x - (value.width * width) / 2,
    top: center.y * camera.zoom + camera.y - (value.height * height) / 2,
    width: value.width * width,
    height: value.height * height,
    transform: `rotate(${image.rotation || 0}deg)`,
  };
  const bounds = objectBounds({
    ...image,
    x: box.left,
    y: box.top,
    width: box.width,
    height: box.height,
  });
  const start = (e: React.PointerEvent, edge: Edge) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    (e.currentTarget as HTMLElement).focus();
    drag.current = { edge, x: e.clientX, y: e.clientY, crop: { ...value } };
  };
  return (
    <div
      ref={root}
      className="crop-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Crop image"
      tabIndex={-1}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          root.current?.focus();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) {
          const delta = rotatePoint(
            { x: e.clientX - d.x, y: e.clientY - d.y },
            -(image.rotation || 0),
          );
          adjust(d.crop, d.edge, delta.x / width, delta.y / height);
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        if (drag.current) onChange(drag.current.crop);
        drag.current = null;
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter' && !(e.target as HTMLElement).closest('.crop-toolbar')) {
          e.preventDefault();
          onApply();
        } else if (e.key === 'Tab') {
          const items = [...root.current!.querySelectorAll<HTMLElement>('button,[tabindex="0"]')];
          const index = items.indexOf(document.activeElement as HTMLElement);
          e.preventDefault();
          items[(index + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
        } else if (e.key.startsWith('Arrow')) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          adjust(
            value,
            ((e.target as HTMLElement).dataset.edge as Edge) || 'move',
            (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0) / width,
            (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) / height,
          );
        }
      }}
    >
      <div
        className="crop-window"
        style={box}
        tabIndex={0}
        aria-label="Move crop area"
        onPointerDown={(e) => start(e, 'move')}
      >
        <div className="crop-grid" aria-hidden="true" />
        {handles.map(([edge, label, x, y]) => (
          <button
            key={edge}
            className={'crop-handle crop-' + edge}
            aria-label={'Crop ' + label}
            data-edge={edge}
            style={{ left: x * 100 + '%', top: y * 100 + '%' }}
            onPointerDown={(e) => start(e, edge)}
          />
        ))}
      </div>
      <div
        className="crop-toolbar"
        style={{
          left: clamp(bounds.x + bounds.width / 2, 160, viewport.width - 160),
          top: clamp(bounds.y + bounds.height + 18, 12, viewport.height - 62),
        }}
      >
        <button
          className="button"
          onClick={() => onChange({ ...fullCrop })}
          title="Restore the full image"
        >
          <RotateCcw size={15} />
          Reset
        </button>
        <span className="divider" />
        <button className="button" onClick={onCancel}>
          <X size={15} />
          Cancel
        </button>
        <button className="button primary" onClick={onApply}>
          <Check size={15} />
          Apply
        </button>
      </div>
      <div className="crop-hint">Drag the edges to crop</div>
    </div>
  );
}
