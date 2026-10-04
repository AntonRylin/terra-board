import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { Check, Pencil, Plus, X } from 'lucide-react';
import type { Camera, CanvasObject, ListItem } from '../model';
import { uid } from '../model';
import { localToWorld } from '../canvas/transform';
import './canvas-lists.css';

export interface ListView {
  objects: CanvasObject[];
  camera: Camera;
}
export const listHeight = (count: number) => 100 + count * 44;

function ListCard({
  object: o,
  camera,
  update,
  select,
  forward,
  active,
}: {
  object: CanvasObject;
  camera: Camera;
  update: (o: CanvasObject) => void;
  select: (id: string) => void;
  forward: (event: PointerEvent) => void;
  active: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const name = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const items = o.items || [];
  useLayoutEffect(() => {
    if (!active) {
      setEditing(false);
      pendingFocus.current = null;
    }
  }, [active]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const input = inputs.current.get(pendingFocus.current);
    if (input) {
      input.focus();
      pendingFocus.current = null;
    }
  });
  const changeItems = (next: ListItem[]) =>
    update({ ...o, items: next, height: listHeight(next.length) });
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
      className="canvas-list glass-surface"
      data-list-id={o.id}
      data-selected={active}
      data-editing={editing}
      aria-label={o.text || 'List'}
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: o.width,
        height: o.height,
        borderColor: active ? '#4486d9' : undefined,
        transform: `scale(${camera.zoom}) rotate(${o.rotation || 0}deg)`,
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !(event.target as HTMLElement).closest('button,input'))
          forward(event);
        else select(o.id);
      }}
      onKeyDown={(event) => {
        if (
          (event.target as HTMLElement).closest('input') ||
          event.key === ' ' ||
          event.key === 'Enter'
        )
          event.stopPropagation();
      }}
    >
      <header className="canvas-list-header">
        {o.text || editing ? (
          <input
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
                event.currentTarget.blur();
                if (event.key === 'Escape') setEditing(false);
              }
            }}
          />
        ) : (
          <span className="canvas-list-name-space" />
        )}
        <button
          className="canvas-list-action"
          aria-label={editing ? 'Finish editing list' : 'Edit list'}
          aria-pressed={editing}
          onClick={() => {
            setEditing(!editing);
            pendingFocus.current = null;
          }}
        >
          {editing ? <Check size={16} /> : <Pencil size={15} />}
        </button>
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
            <input
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
                update({
                  ...o,
                  items: items.map((row) =>
                    row.id === item.id ? { ...row, text: event.target.value } : row,
                  ),
                })
              }
              onKeyDown={(event) => {
                if (!editing || event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') {
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
                if (event.key === 'ArrowUp' && index > 0) {
                  event.preventDefault();
                  focus(items[index - 1].id);
                }
                if (event.key === 'ArrowDown' && index < items.length - 1) {
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
}: {
  view: ListView;
  update: (o: CanvasObject) => void;
  select: (id: string) => void;
  selected: string[];
  host: HTMLDivElement | null;
  interactive: boolean;
  beginPointer: (event: globalThis.PointerEvent) => void;
}) {
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
          forward={(event) => {
            event.preventDefault();
            beginPointer(event.nativeEvent);
          }}
        />
      ))}
    </div>
  );
}
