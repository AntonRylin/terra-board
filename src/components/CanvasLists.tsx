import { useEffect, useLayoutEffect, useRef, type PointerEvent } from 'react';
import { Check, Plus, X } from 'lucide-react';
import type { Camera, CanvasObject, ListItem } from '../model';
import { uid } from '../model';
import { localToWorld } from '../canvas/transform';
import { fitListHeight, listLayout, withListItems } from '../canvas/list-layout';
import ListEditOutline from './ListEditOutline';
import './canvas-lists.css';

export interface ListView {
  objects: CanvasObject[];
  camera: Camera;
}
export { listHeight } from '../canvas/list-layout';

function ListCard({
  object: o,
  camera,
  update,
  select,
  forward,
  active,
  editing,
  setEditing,
}: {
  object: CanvasObject;
  camera: Camera;
  update: (o: CanvasObject) => void;
  select: (id: string) => void;
  forward: (event: PointerEvent) => void;
  active: boolean;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  const inputs = useRef(new Map<string, HTMLTextAreaElement>());
  const name = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const items = o.items || [];
  const layout = listLayout(o);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    for (const input of element.querySelectorAll('textarea')) {
      input.style.height = '0px';
      input.style.height = `${input.scrollHeight}px`;
    }
    const header = element.querySelector<HTMLElement>('.canvas-list-header')!;
    const rows = element.querySelector<HTMLElement>('.canvas-list-items')!;
    // Reserve the add control even outside editing, so entering/leaving edit
    // mode never changes wrapping or moves the card.
    const needed = (62 + header.offsetHeight + 6 + rows.scrollHeight) * layout.scale;
    if (needed > o.height + 0.5) update(fitListHeight(o, needed));
  }, [o, editing, layout.width]);
  useLayoutEffect(() => {
    if (!active && editing) {
      setEditing(false);
    }
    if (!editing) {
      pendingFocus.current = null;
    }
  }, [active, editing]);
  useLayoutEffect(() => {
    if (editing) name.current?.focus({ preventScroll: true });
  }, [editing]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const input = inputs.current.get(pendingFocus.current);
    if (input) {
      input.focus();
      pendingFocus.current = null;
    }
  });
  const changeItems = (next: ListItem[]) => update(withListItems(o, next));
  const focus = (id: string) => {
    const input = inputs.current.get(id);
    if (input) input.focus();
    else pendingFocus.current = id;
  };
  const add = (after = items.length - 1) => {
    if (items.length >= 1000) return;
    const item = { id: uid(), text: '', checked: false };
    const next = [...items];
    next.splice(after + 1, 0, item);
    changeItems(next);
    focus(item.id);
  };
  const remove = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    changeItems(items.filter((item) => item.id !== id));
    const neighbor = items[index - 1] || items[index + 1];
    if (neighbor) focus(neighbor.id);
  };
  const origin = localToWorld(o, { x: 0, y: 0 });
  return (
    <section
      ref={card}
      className="canvas-list glass-surface"
      data-list-id={o.id}
      data-list-scale={layout.scale}
      data-selected={active}
      data-editing={editing}
      aria-label={o.text || 'List'}
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: layout.width,
        height: layout.height,
        borderColor: editing ? 'transparent' : active ? '#4486d9' : undefined,
        transform: `scale(${camera.zoom * layout.scale}) rotate(${o.rotation || 0}deg)`,
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !(event.target as HTMLElement).closest('button,textarea'))
          forward(event);
        else select(o.id);
      }}
      onDoubleClick={(event) => {
        if (editing || (event.target as HTMLElement).closest('button')) return;
        event.stopPropagation();
        select(o.id);
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && editing) {
          event.stopPropagation();
          setEditing(false);
          (event.target as HTMLElement).blur();
        }
        if (
          (event.target as HTMLElement).closest('textarea') ||
          event.key === ' ' ||
          event.key === 'Enter'
        )
          event.stopPropagation();
      }}
    >
      {editing && <ListEditOutline width={layout.width} height={layout.height} />}
      <header className="canvas-list-header">
        {o.text || editing ? (
          <textarea
            rows={1}
            ref={name}
            className="canvas-list-name"
            aria-label="List name"
            value={o.text || ''}
            maxLength={120}
            readOnly={!editing}
            tabIndex={editing ? 0 : -1}
            style={{
              fontWeight: o.bold ? 700 : 400,
              textDecoration: o.strikethrough ? 'line-through' : 'none',
            }}
            onChange={(event) => update({ ...o, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault();
                event.currentTarget.blur();
                if (event.key === 'Escape') setEditing(false);
              }
            }}
          />
        ) : (
          <span className="canvas-list-name-space" />
        )}
      </header>
      <div className="canvas-list-items">
        {items.map((item, index) => (
          <div className="canvas-list-row" key={item.id} data-checked={item.checked}>
            <button
              className="canvas-list-circle"
              role="checkbox"
              aria-checked={item.checked}
              aria-label={item.text || `Item ${index + 1}`}
              onPointerDown={(event) => {
                if (event.button === 0) event.stopPropagation();
              }}
              onClick={() =>
                update({
                  ...o,
                  items: items.map((row) =>
                    row.id === item.id ? { ...row, checked: !row.checked } : row,
                  ),
                })
              }
            >
              {item.checked && <Check size={13} strokeWidth={2.3} />}
            </button>
            <textarea
              rows={1}
              ref={(el) => {
                if (el) inputs.current.set(item.id, el);
                else inputs.current.delete(item.id);
              }}
              aria-label={`List item ${index + 1}`}
              value={item.text}
              maxLength={10000}
              readOnly={!editing}
              tabIndex={editing ? 0 : -1}
              onChange={(event) =>
                changeItems(
                  items.map((row) =>
                    row.id === item.id ? { ...row, text: event.target.value } : row,
                  ),
                )
              }
              onKeyDown={(event) => {
                if (!editing || event.nativeEvent.isComposing) return;
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  add(index);
                }
                if (event.key === 'Backspace' && !item.text) {
                  event.preventDefault();
                  remove(item.id);
                }
                if (event.key === 'Escape') {
                  event.currentTarget.blur();
                  setEditing(false);
                }
                if (
                  event.key === 'ArrowUp' &&
                  index > 0 &&
                  event.currentTarget.selectionStart === 0
                ) {
                  event.preventDefault();
                  focus(items[index - 1].id);
                }
                if (
                  event.key === 'ArrowDown' &&
                  index < items.length - 1 &&
                  event.currentTarget.selectionStart === item.text.length
                ) {
                  event.preventDefault();
                  focus(items[index + 1].id);
                }
              }}
            />
            {editing && (
              <button
                className="canvas-list-action canvas-list-remove"
                aria-label={`Remove item ${index + 1}`}
                onClick={() => remove(item.id)}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <button
          className="canvas-list-action canvas-list-add"
          aria-label="Add list item"
          disabled={items.length >= 1000}
          onClick={() => add()}
        >
          <Plus size={19} strokeWidth={1.7} />
        </button>
      )}
    </section>
  );
}

export default function CanvasLists({
  view,
  update,
  select,
  selected,
  host,
  interactive,
  beginPointer,
  editingId,
  onEdit,
}: {
  view: ListView;
  update: (o: CanvasObject) => void;
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
      if (target.closest('.selection-tools')) return;
      if (target.closest<HTMLElement>('.canvas-list')?.dataset.listId !== editingId) onEdit(null);
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
      className="canvas-lists"
      data-interactive={interactive}
      onWheel={(event) => {
        host?.dispatchEvent(
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
        <ListCard
          key={o.id}
          object={o}
          camera={view.camera}
          update={update}
          select={select}
          active={selected.includes(o.id)}
          editing={editingId === o.id}
          setEditing={(editing) => onEdit(editing ? o.id : null)}
          forward={(event) => {
            event.preventDefault();
            beginPointer(event.nativeEvent);
          }}
        />
      ))}
    </div>
  );
}
