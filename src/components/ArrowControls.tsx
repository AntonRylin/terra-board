import { useEffect, useState, useRef, useImperativeHandle, type Ref } from 'react';
import { ArrowLeftRight, ChevronDown, Type, Spline } from 'lucide-react';
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
function HeadPreview({ kind, start = false }: { kind: ArrowHead; start?: boolean }) {
  return (
    <svg width="46" height="24" viewBox="0 0 46 24" aria-hidden="true">
      <g transform={start ? 'translate(46 0) scale(-1 1)' : undefined}>
        <path
          d="M5 12H39"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {kind === 'arrow' && <path d="M40 12 27 5 31 12 27 19Z" fill="currentColor" />}
        {kind === 'triangle' && <path d="M40 12 28 5V19Z" fill="currentColor" />}
        {kind === 'open' && (
          <path
            d="m29 5 11 7-11 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        )}
        {kind === 'diamond' && <path d="m40 12-8-7-8 7 8 7Z" fill="currentColor" />}
        {kind === 'circle' && <circle cx="34" cy="12" r="6" fill="currentColor" />}
      </g>
    </svg>
  );
}
function LinePreview({ line, dash }: { line?: ArrowStyle['line']; dash?: ArrowStyle['dash'] }) {
  return (
    <svg width="48" height="26" viewBox="0 0 48 26" aria-hidden="true">
      <path
        d={
          line === 'curve'
            ? 'M5 19C16 -6 32 32 43 7'
            : line === 'elbow'
              ? 'M5 20H24V6H43'
              : line === 'straight'
                ? 'M5 20 43 6'
                : 'M5 13H43'
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={dash === 'dashed' ? '7 6' : dash === 'dotted' ? '0.1 6' : undefined}
      />
    </svg>
  );
}
export default function ArrowControls({
  object,
  onChange,
  draftRef,
  onCommitThickness,
}: {
  draftRef: Ref<{ flush: () => void }>;
  object: CanvasObject;
  onChange: (patch: Partial<CanvasObject>, record?: boolean) => void;
  onCommitThickness: (before: number) => void;
}) {
  const style = arrowStyle(object);
  const [label, setLabel] = useState(object.text || ''),
    [showLabel, setShowLabel] = useState(false),
    [menu, setMenu] = useState<'start' | 'end' | 'style' | null>(null);
  const root = useRef<HTMLDivElement>(null),
    thicknessBefore = useRef<number | null>(null);
  const commitThickness = () => {
    if (thicknessBefore.current === null) return;
    const before = thicknessBefore.current;
    thicknessBefore.current = null;
    onCommitThickness(before);
  };
  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  useEffect(() => setLabel(object.text || ''), [object.id, object.text]);
  const change = (patch: Partial<ArrowStyle>) => onChange({ arrow: { ...style, ...patch } });
  const save = () => {
    if (label !== (object.text || '')) onChange({ text: label });
  };
  useImperativeHandle(draftRef, () => ({
    flush: () => {
      commitThickness();
      save();
    },
  }));
  const headMenu = (end: 'start' | 'end') => (
    <div className="arrow-head-menu">
      <button
        className="arrow-head-trigger"
        aria-label={`${end === 'start' ? 'Start' : 'End'} arrowhead`}
        title={`${end === 'start' ? 'Start' : 'End'} arrowhead`}
        aria-expanded={menu === end}
        onClick={() => setMenu(menu === end ? null : end)}
      >
        <HeadPreview kind={style[end]} start={end === 'start'} />
        <ChevronDown size={12} />
      </button>
      {menu === end && (
        <div className="arrow-head-popover" role="group" aria-label={`${end} arrowhead choices`}>
          {heads.map(([id, name]) => (
            <button
              key={id}
              title={name}
              aria-label={`${end} ${name}`}
              aria-pressed={style[end] === id}
              onClick={() => {
                change({ [end]: id });
                setMenu(null);
              }}
            >
              <HeadPreview kind={id} start={end === 'start'} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <div
      className="arrow-controls"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !showLabel) {
          e.stopPropagation();
          commitThickness();
          setMenu(null);
        }
      }}
    >
      {headMenu('start')}
      <button
        className="icon-button"
        aria-label="Swap arrowheads"
        title="Swap arrowheads"
        onClick={() => change({ start: style.end, end: style.start })}
      >
        <ArrowLeftRight size={17} />
      </button>
      {headMenu('end')}
      <div className="arrow-style-menu">
        <button
          className="icon-button"
          title="Line style"
          aria-label="Line style"
          aria-expanded={menu === 'style'}
          onClick={() => setMenu(menu === 'style' ? null : 'style')}
        >
          <Spline size={19} />
        </button>
        {menu === 'style' && (
          <div className="arrow-style-popover">
            <div className="arrow-thickness-heading">
              <label htmlFor="arrow-thickness">Thickness</label>
              <output>{style.thickness}</output>
            </div>
            <input
              id="arrow-thickness"
              className="arrow-thickness"
              type="range"
              min="0.5"
              max="40"
              step="0.5"
              aria-label="Arrow thickness"
              value={style.thickness}
              onPointerDown={(e) => {
                thicknessBefore.current = style.thickness;
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onChange={(e) => {
                thicknessBefore.current ??= style.thickness;
                onChange({ arrow: { ...style, thickness: Number(e.target.value) } }, false);
              }}
              onPointerUp={commitThickness}
              onPointerCancel={commitThickness}
              onLostPointerCapture={commitThickness}
              onKeyUp={commitThickness}
              onBlur={commitThickness}
            />
            <fieldset>
              <legend>Path</legend>
              <div className="arrow-options">
                {(['straight', 'elbow', 'curve'] as const).map((line) => (
                  <button
                    key={line}
                    title={line === 'curve' ? 'Curved' : line === 'elbow' ? 'Elbow' : 'Straight'}
                    aria-label={`Arrow path ${line}`}
                    aria-pressed={style.line === line}
                    onClick={() => change({ line })}
                  >
                    <LinePreview line={line} />
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Stroke</legend>
              <div className="arrow-options">
                {(['solid', 'dashed', 'dotted'] as const).map((dash) => (
                  <button
                    key={dash}
                    title={dash}
                    aria-label={`Arrow stroke ${dash}`}
                    aria-pressed={style.dash === dash}
                    onClick={() => change({ dash })}
                  >
                    <LinePreview dash={dash} />
                  </button>
                ))}
              </div>
            </fieldset>
            <small>Drag a dot to bend. Double-click a bend to remove it.</small>
          </div>
        )}
      </div>
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
