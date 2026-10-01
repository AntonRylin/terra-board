import { useEffect, useState, useImperativeHandle, type Ref } from 'react';
import { ArrowLeftRight, Type, Spline } from 'lucide-react';
import type { CanvasObject, ArrowHead, ArrowStyle } from '../model';
import { arrowStyle } from '../canvas/arrows';

const heads: [ArrowHead, string][] = [
  ['none', 'None'],
  ['arrow', 'Arrow'],
  ['triangle', 'Triangle'],
  ['open', 'Open arrow'],
  ['diamond', 'Diamond'],
  ['circle', 'Circle'],
];
export default function ArrowControls({
  object,
  onChange,
  draftRef,
}: {
  draftRef: Ref<{ flush: () => void }>;
  object: CanvasObject;
  onChange: (patch: Partial<CanvasObject>) => void;
}) {
  const style = arrowStyle(object);
  const [label, setLabel] = useState(object.text || ''),
    [showLabel, setShowLabel] = useState(false);
  useEffect(() => setLabel(object.text || ''), [object.id, object.text]);
  const change = (patch: Partial<ArrowStyle>) => onChange({ arrow: { ...style, ...patch } });
  const save = () => {
    if (label !== (object.text || '')) onChange({ text: label });
  };
  useImperativeHandle(draftRef, () => ({ flush: save }));
  return (
    <div className="arrow-controls">
      <select
        aria-label="Start arrowhead"
        title="Start arrowhead"
        value={style.start}
        onChange={(e) => change({ start: e.target.value as ArrowHead })}
      >
        {heads.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      <button
        className="icon-button"
        aria-label="Swap arrowheads"
        title="Swap arrowheads"
        onClick={() => change({ start: style.end, end: style.start })}
      >
        <ArrowLeftRight size={17} />
      </button>
      <select
        aria-label="End arrowhead"
        title="End arrowhead"
        value={style.end}
        onChange={(e) => change({ end: e.target.value as ArrowHead })}
      >
        {heads.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      <details className="arrow-style-menu">
        <summary title="Line style" aria-label="Line style">
          <Spline size={19} />
        </summary>
        <div className="arrow-style-popover">
          <label>
            Path
            <select
              aria-label="Arrow path"
              value={style.line}
              onChange={(e) => change({ line: e.target.value as ArrowStyle['line'] })}
            >
              <option value="straight">Straight</option>
              <option value="elbow">Elbow</option>
              <option value="curve">Curved</option>
            </select>
          </label>
          <label>
            Stroke
            <select
              aria-label="Arrow stroke"
              value={style.dash}
              onChange={(e) => change({ dash: e.target.value as ArrowStyle['dash'] })}
            >
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
            </select>
          </label>
          <label>
            Thickness
            <select
              aria-label="Arrow thickness"
              value={style.thickness}
              onChange={(e) => change({ thickness: Number(e.target.value) })}
            >
              {[...new Set([1, 2, 3, 4, 6, 8, 12, style.thickness])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n}>{n}</option>
                ))}
            </select>
          </label>
          <small>Drag a dot to bend. Double-click a bend to remove it.</small>
        </div>
      </details>
      <input
        type="color"
        className="arrow-color"
        aria-label="Arrow color"
        title="Arrow color"
        value={object.color || '#333333'}
        onChange={(e) => onChange({ color: e.target.value })}
      />
      <button
        className="icon-button"
        aria-label="Arrow label"
        title="Arrow label"
        aria-pressed={showLabel}
        onClick={() => setShowLabel((v) => !v)}
      >
        <Type size={18} />
      </button>
      {showLabel && (
        <div className="arrow-label-popover">
          <input
            autoFocus
            aria-label="Arrow label text"
            placeholder="Add a label…"
            maxLength={500}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                save();
                setShowLabel(false);
              }
              if (e.key === 'Escape') {
                setLabel(object.text || '');
                setShowLabel(false);
              }
            }}
          />
          <select
            aria-label="Arrow label size"
            value={object.fontSize || 18}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          >
            {[...new Set([12, 14, 18, 24, 32, 48, object.fontSize || 18])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n}>{n}</option>
              ))}
          </select>
        </div>
      )}
    </div>
  );
}
