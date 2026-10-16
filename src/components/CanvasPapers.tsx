import { Fragment, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { Camera, CanvasObject } from '../model';
import { localToWorld } from '../canvas/transform';
import {
  paperContentHeight,
  paperContentWidth,
  paperGap,
  paperHeight,
  paperMargin,
  paperMaxPages,
  paperMaxText,
  paperPageHeight,
  paperPageTop,
  paperPages,
  paperScale,
  paperWidth,
  withPaperPages,
} from '../canvas/paper-layout';
import RichTextField, { focusField } from './RichTextField';
import './canvas-papers.css';

export interface PaperView {
  objects: CanvasObject[];
  camera: Camera;
}

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// Puts the caret at a screen point inside the text, or at the end when the
// point is below the last line.
function placeCaret(field: HTMLElement, point: { x: number; y: number } | null) {
  focusField(field, 'end');
  if (!point) return;
  const box = field.getBoundingClientRect();
  if (point.y > box.bottom) return;
  const x = Math.min(box.right - 1, Math.max(box.left + 1, point.x));
  const y = Math.max(box.top + 1, point.y);
  const position = document.caretPositionFromPoint?.(x, y);
  if (position && field.contains(position.offsetNode))
    document.getSelection()?.collapse(position.offsetNode, position.offset);
}

function PaperCard({
  object: o,
  camera,
  update,
  fit,
  select,
  forward,
  active,
  editing,
  setEditing,
}: {
  object: CanvasObject;
  camera: Camera;
  update: (o: CanvasObject) => void;
  fit: (o: CanvasObject) => void;
  select: (id: string) => void;
  forward: (event: PointerEvent) => void;
  active: boolean;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  const field = useRef<HTMLDivElement | null>(null);
  const lastPress = useRef<{ x: number; y: number; at: number } | null>(null);
  const pages = paperPages(o);
  // Each break pushes the lines that would cross a sheet's bottom margin onto
  // the next sheet. One spare break past the last sheet lets overflowing text
  // land where it will be once that sheet is added.
  const [breaks, setBreaks] = useState(pages + 1);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const scale = paperScale(o);
  const zoom = camera.zoom * scale;
  useLayoutEffect(() => {
    const text = field.current;
    if (!text) return;
    const bottom = text.offsetTop + text.offsetHeight;
    const needed = Math.min(
      paperMaxPages,
      Math.max(1, Math.ceil((bottom - 0.5) / (paperPageHeight + paperGap))),
    );
    if (needed + 1 > breaks) {
      setBreaks(needed + 1);
      return;
    }
    if (needed !== pages && !o.locked) fit(withPaperPages(o, needed));
  }, [o.text, o.textMarks, o.width, o.height, breaks, editing]);
  useLayoutEffect(() => {
    if (!active && editing) setEditing(false);
  }, [active, editing]);
  useLayoutEffect(() => {
    if (!editing || !field.current) return;
    const press = lastPress.current;
    placeCaret(field.current, press && performance.now() - press.at < 1000 ? press : null);
    lastPress.current = null;
  }, [editing]);
  const origin = localToWorld(o, { x: 0, y: 0 });
  const empty = !o.text;
  return (
    <section
      className="canvas-paper"
      data-paper-id={o.id}
      data-selected={active}
      data-editing={editing}
      aria-label="Document"
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: paperWidth,
        height: paperHeight(pages),
        transform: `scale(${zoom}) rotate(${o.rotation || 0}deg)`,
        ['--paper-px' as string]: `${1 / zoom}px`,
      }}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.button === 0 && target.closest('.rt-spoiler[data-hidden]')) {
          event.stopPropagation();
          return;
        }
        lastPress.current = { x: event.clientX, y: event.clientY, at: performance.now() };
        if (editing && event.button === 0) {
          // Inside the text the browser places the caret; elsewhere on the
          // sheets the press moves it to the nearest line.
          if (!target.closest('[contenteditable="true"]')) {
            event.preventDefault();
            if (field.current) placeCaret(field.current, { x: event.clientX, y: event.clientY });
          }
          select(o.id);
          return;
        }
        forward(event);
      }}
      onDoubleClick={(event) => {
        if (editing) return;
        event.stopPropagation();
        lastPress.current = { x: event.clientX, y: event.clientY, at: performance.now() };
        select(o.id);
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && editing) {
          event.stopPropagation();
          setEditing(false);
          (event.target as HTMLElement).blur();
          return;
        }
        if (event.key === 'Tab' && editing && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          document.execCommand('insertText', false, '\t');
        }
        if ((event.target as HTMLElement).closest('[contenteditable="true"]'))
          event.stopPropagation();
      }}
    >
      {Array.from({ length: pages }, (_, index) => (
        <div
          key={index}
          className="canvas-paper-sheet"
          style={{ top: paperPageTop(index), height: paperPageHeight }}
        >
          {pages > 1 && <span className="canvas-paper-number">{index + 1}</span>}
        </div>
      ))}
      <div
        className="canvas-paper-flow"
        style={{ left: paperMargin, top: paperMargin, width: paperContentWidth }}
      >
        {Array.from({ length: breaks }, (_, index) => (
          <Fragment key={index}>
            <i className="canvas-paper-space" style={{ height: paperContentHeight }} />
            <i className="canvas-paper-break" style={{ height: paperMargin * 2 + paperGap }} />
          </Fragment>
        ))}
        <RichTextField
          fieldRef={(element) => {
            field.current = element;
          }}
          className="canvas-paper-text"
          label="Document text"
          value={o.text || ''}
          marks={o.textMarks}
          maxLength={paperMaxText}
          editable={editing}
          onChange={(text, textMarks) => update({ ...o, text, textMarks })}
          revealed={(start) => revealed.has(start)}
          onSpoiler={(start) =>
            setRevealed((current) => {
              const next = new Set(current);
              if (!next.delete(start)) next.add(start);
              return next;
            })
          }
        />
        {empty && !editing && <div className="canvas-paper-placeholder">Double-click to write</div>}
      </div>
      {active &&
        handles.map((handle) => (
          <i key={handle} className="canvas-paper-handle" data-handle={handle} />
        ))}
    </section>
  );
}

export default function CanvasPapers({
  view,
  update,
  fit,
  select,
  selected,
  host,
  interactive,
  beginPointer,
  editingId,
  onEdit,
}: {
  view: PaperView;
  update: (o: CanvasObject) => void;
  fit: (o: CanvasObject) => void;
  select: (id: string) => void;
  selected: string[];
  host: HTMLDivElement | null;
  interactive: boolean;
  beginPointer: (event: globalThis.PointerEvent) => void;
  editingId: string | null;
  onEdit: (id: string | null) => void;
}) {
  useEffect(() => {
    if (!editingId) return;
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.selection-tools, .rich-format-bar')) return;
      if (target.closest<HTMLElement>('.canvas-paper')?.dataset.paperId !== editingId) onEdit(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onEdit(null);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [editingId, onEdit]);
  return (
    <div
      className="canvas-papers"
      data-interactive={interactive}
      onWheel={(event) => {
        // The engine only takes wheel input aimed at its own canvas.
        (host?.querySelector('canvas') || host)?.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
          }),
        );
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        host?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
          }),
        );
      }}
    >
      {view.objects.map((o) => (
        <PaperCard
          key={o.id}
          object={o}
          camera={view.camera}
          update={(next) => {
            if (!o.locked) update(next);
          }}
          fit={fit}
          select={select}
          active={selected.includes(o.id)}
          editing={!o.locked && editingId === o.id}
          setEditing={(editing) => {
            if (!o.locked) onEdit(editing ? o.id : null);
          }}
          forward={(event) => {
            event.preventDefault();
            beginPointer(event.nativeEvent);
          }}
        />
      ))}
    </div>
  );
}
