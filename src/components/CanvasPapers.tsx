import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from 'react';
import { PinOff } from 'lucide-react';
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
// A document pinned to the view: where its panel sits on screen, in pixels.
// Local to this window only; the document itself stays where it is on the board.
export interface PaperPin {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}
type Press = { x: number; y: number; at: number } | null;

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const pinHandles = ['e', 's', 'w', 'se', 'sw'];
export const pinMinimum = { width: 260, height: 180 };
const pinHeader = 34;
// Room beside the pages for their shadow and the scrollbar.
const pinInset = 22;

// A document's name. Pressing it does what pressing the document does (select,
// drag); a double-click renames it. An empty name removes it.
function PaperName({
  object: o,
  update,
  onPress,
  className,
}: {
  object: CanvasObject;
  update: (o: CanvasObject) => void;
  onPress: (event: PointerEvent<HTMLSpanElement>) => void;
  className: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [renaming, setRenaming] = useState(false);
  const lastPress = useRef(0);
  const name = o.documentTitle?.trim() || '';
  useLayoutEffect(() => {
    const element = ref.current!;
    if (!renaming) {
      element.textContent = name || 'Untitled';
      return;
    }
    element.textContent = name;
    element.focus();
    document.getSelection()?.selectAllChildren(element);
  }, [renaming, name]);
  const finish = (save: boolean) => {
    if (!renaming) return;
    setRenaming(false);
    if (!save) return;
    const next = (ref.current?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (next === name) return;
    const { documentTitle: _, ...rest } = o;
    update(next ? { ...rest, documentTitle: next } : rest);
  };
  return (
    <span
      ref={ref}
      className={className}
      data-empty={!name && !renaming}
      data-renaming={renaming}
      role={renaming ? 'textbox' : undefined}
      aria-label="Document name"
      title={renaming ? undefined : 'Double-click to rename'}
      contentEditable={renaming ? 'plaintext-only' : false}
      suppressContentEditableWarning
      spellCheck={false}
      onPointerDown={(event) => {
        if (renaming) {
          event.stopPropagation();
          return;
        }
        // The first press may hand the pointer to the board, which then
        // receives the dblclick, so a second quick press counts here.
        const now = performance.now(),
          second = event.button === 0 && now - lastPress.current < 450;
        lastPress.current = event.button === 0 ? now : 0;
        if (second && !o.locked) {
          event.preventDefault();
          event.stopPropagation();
          lastPress.current = 0;
          setRenaming(true);
        } else onPress(event);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (!renaming) return;
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          finish(event.key === 'Enter');
        }
      }}
    />
  );
}

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

// The sheets and the text flowing across them, in document units.
function PaperSheets({
  object: o,
  editing,
  update,
  fit,
  field,
  press,
  hint = 'Double-click to write',
}: {
  object: CanvasObject;
  editing: boolean;
  update: (o: CanvasObject) => void;
  fit: (o: CanvasObject) => void;
  field: MutableRefObject<HTMLDivElement | null>;
  press: MutableRefObject<Press>;
  hint?: string;
}) {
  const pages = paperPages(o);
  // Each break pushes the lines that would cross a sheet's bottom margin onto
  // the next sheet. One spare break past the last sheet lets overflowing text
  // land where it will be once that sheet is added.
  const [breaks, setBreaks] = useState(pages + 1);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
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
    if (!editing || !field.current) return;
    const last = press.current;
    placeCaret(field.current, last && performance.now() - last.at < 1000 ? last : null);
    press.current = null;
  }, [editing]);
  return (
    <>
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
        {!o.text && !editing && <div className="canvas-paper-placeholder">{hint}</div>}
      </div>
    </>
  );
}

// Shared by board and pinned documents: presses while writing move the caret,
// and keys typed into the text never reach board shortcuts.
function writingHandlers(
  editing: boolean,
  setEditing: (editing: boolean) => void,
  field: MutableRefObject<HTMLDivElement | null>,
) {
  return {
    pressWhileEditing(event: PointerEvent) {
      const target = event.target as HTMLElement;
      // Inside the text the browser places the caret; elsewhere on the
      // sheets the press moves it to the nearest line.
      if (!target.closest('[contenteditable="true"]')) {
        event.preventDefault();
        if (field.current) placeCaret(field.current, { x: event.clientX, y: event.clientY });
      }
    },
    onKeyDown(event: ReactKeyboardEvent) {
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
    },
  };
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
  const press = useRef<Press>(null);
  const zoom = camera.zoom * paperScale(o);
  const writing = writingHandlers(editing, setEditing, field);
  useLayoutEffect(() => {
    if (!active && editing) setEditing(false);
  }, [active, editing]);
  const origin = localToWorld(o, { x: 0, y: 0 });
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
        height: paperHeight(paperPages(o)),
        transform: `scale(${zoom}) rotate(${o.rotation || 0}deg)`,
        ['--paper-px' as string]: `${1 / zoom}px`,
      }}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.button === 0 && target.closest('.rt-spoiler[data-hidden]')) {
          event.stopPropagation();
          return;
        }
        press.current = { x: event.clientX, y: event.clientY, at: performance.now() };
        if (editing && event.button === 0) {
          writing.pressWhileEditing(event);
          select(o.id);
          return;
        }
        forward(event);
      }}
      onDoubleClick={(event) => {
        if (editing) return;
        event.stopPropagation();
        press.current = { x: event.clientX, y: event.clientY, at: performance.now() };
        select(o.id);
        setEditing(true);
      }}
      onKeyDown={writing.onKeyDown}
    >
      <PaperSheets
        object={o}
        editing={editing}
        update={update}
        fit={fit}
        field={field}
        press={press}
      />
      <PaperName
        object={o}
        update={update}
        className="canvas-paper-name"
        onPress={(event) => {
          if (editing && event.button === 0) setEditing(false);
          event.stopPropagation();
          forward(event);
        }}
      />
      {active &&
        handles.map((handle) => (
          <i key={handle} className="canvas-paper-handle" data-handle={handle} />
        ))}
    </section>
  );
}

// Keeps a pinned panel on screen and at least its minimum size.
export function clampPin(pin: PaperPin, view: { width: number; height: number }): PaperPin {
  const width = Math.max(pinMinimum.width, Math.min(view.width - 16, pin.width));
  const height = Math.max(pinMinimum.height, Math.min(view.height - 16, pin.height));
  return {
    ...pin,
    width,
    height,
    left: Math.max(8, Math.min(view.width - width - 8, pin.left)),
    top: Math.max(8, Math.min(view.height - height - 8, pin.top)),
  };
}

function PinnedPaper({
  object: o,
  pin,
  update,
  fit,
  move,
  unpin,
  editing,
  setEditing,
}: {
  object: CanvasObject;
  pin: PaperPin;
  update: (o: CanvasObject) => void;
  fit: (o: CanvasObject) => void;
  move: (pin: PaperPin) => void;
  unpin: () => void;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  const field = useRef<HTMLDivElement | null>(null);
  const press = useRef<Press>(null);
  const writing = writingHandlers(editing, setEditing, field);
  const scale = (pin.width - pinInset) / paperWidth;
  const pages = paperPages(o);
  const title = o.documentTitle?.trim() || 'Untitled';
  // Moving and resizing change the panel on screen, never the board.
  const drag = (event: PointerEvent<HTMLElement>, handle: string | null) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY },
      from = pin;
    const view = target.closest('.canvas-paper-pins')!.getBoundingClientRect();
    const moved = (e: globalThis.PointerEvent) => {
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      let next = { ...from };
      if (!handle) next = { ...from, left: from.left + dx, top: from.top + dy };
      else {
        if (handle.includes('e')) next.width = from.width + dx;
        if (handle.includes('s')) next.height = from.height + dy;
        if (handle.includes('w')) {
          next.width = Math.max(pinMinimum.width, from.width - dx);
          next.left = from.left + from.width - next.width;
        }
      }
      move(clampPin(next, view));
    };
    const done = () => {
      target.removeEventListener('pointermove', moved);
      target.removeEventListener('pointerup', done);
      target.removeEventListener('pointercancel', done);
    };
    target.addEventListener('pointermove', moved);
    target.addEventListener('pointerup', done);
    target.addEventListener('pointercancel', done);
  };
  return (
    <section
      className="canvas-paper-pinned"
      data-paper-id={o.id}
      data-editing={editing}
      aria-label={`Pinned document: ${title}`}
      style={{ left: pin.left, top: pin.top, width: pin.width, height: pin.height }}
      onKeyDown={writing.onKeyDown}
    >
      <header className="canvas-paper-pin-bar" onPointerDown={(event) => drag(event, null)}>
        <PaperName
          object={o}
          update={update}
          className="canvas-paper-pin-title"
          onPress={(event) => drag(event, null)}
        />
        <span className="canvas-paper-pin-space" />
        <button
          className="icon-button"
          aria-label="Unpin from view"
          title="Unpin from view"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={unpin}
        >
          <PinOff size={15} />
        </button>
      </header>
      <div
        className="canvas-paper-scroll"
        style={{ height: pin.height - pinHeader }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if ((event.target as HTMLElement).closest('.rt-spoiler[data-hidden]')) return;
          press.current = { x: event.clientX, y: event.clientY, at: performance.now() };
          if (editing) writing.pressWhileEditing(event);
          else if (!o.locked) {
            // Pinned documents are for writing: one click starts.
            event.preventDefault();
            setEditing(true);
          }
        }}
      >
        <div
          className="canvas-paper-pin-pages"
          style={{ width: paperWidth * scale, height: paperHeight(pages, scale) }}
        >
          <div
            className="canvas-paper"
            data-editing={editing}
            style={{
              width: paperWidth,
              height: paperHeight(pages),
              transform: `scale(${scale})`,
            }}
          >
            <PaperSheets
              object={o}
              editing={editing}
              update={update}
              fit={fit}
              field={field}
              press={press}
              hint="Click to write"
            />
          </div>
        </div>
      </div>
      {pinHandles.map((handle) => (
        <i
          key={handle}
          className="canvas-paper-pin-handle"
          data-handle={handle}
          onPointerDown={(event) => drag(event, handle)}
        />
      ))}
    </section>
  );
}

export function PinnedPapers({
  pins,
  objects,
  update,
  fit,
  move,
  unpin,
  editingId,
  onEdit,
}: {
  pins: PaperPin[];
  objects: Map<string, CanvasObject>;
  update: (o: CanvasObject) => void;
  fit: (o: CanvasObject) => void;
  move: (pin: PaperPin) => void;
  unpin: (id: string) => void;
  editingId: string | null;
  onEdit: (id: string | null) => void;
}) {
  return (
    <div className="canvas-paper-pins">
      {pins.map((pin) => {
        const o = objects.get(pin.id);
        if (!o) return null;
        return (
          <PinnedPaper
            key={pin.id}
            object={o}
            pin={pin}
            update={(next) => {
              if (!o.locked) update(next);
            }}
            fit={fit}
            move={move}
            unpin={() => unpin(pin.id)}
            editing={!o.locked && editingId === o.id}
            setEditing={(editing) => {
              if (!o.locked) onEdit(editing ? o.id : null);
            }}
          />
        );
      })}
    </div>
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
      if (target.closest<HTMLElement>('[data-paper-id]')?.dataset.paperId !== editingId)
        onEdit(null);
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
