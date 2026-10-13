import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, RotateCcw, Settings2, X } from 'lucide-react';
import type { Engine } from '../canvas/engine';
import type { Point } from '../canvas/geometry';
import type { ToolbarAction } from './CanvasToolbar';
import type { ToolbarId } from './toolbar-layout';
import {
  defaultRadialLayout,
  radialSectors,
  radialSlot,
  radialStorageKey,
  readRadialLayout,
} from './radial-layout';
import './radial-menu.css';

type Session = { center: Point; anchor: Point; editing: boolean; armed: boolean };
export default function RadialMenu({
  engine,
  host,
  tools,
  onChoose,
}: {
  engine: RefObject<Engine | null>;
  host: RefObject<HTMLDivElement | null>;
  tools: ToolbarAction[];
  onChoose: (id: ToolbarId, anchor: Point, pointer: Point) => void;
}) {
  const [layout, setLayout] = useState(() => {
    try {
      return readRadialLayout(JSON.parse(localStorage.getItem(radialStorageKey) || 'null'));
    } catch {
      return defaultRadialLayout();
    }
  });
  const [session, setSession] = useState<Session | null>(null);
  const [slot, setSlot] = useState(5);
  const current = useRef(session);
  const pointer = useRef<Point | null>(null);
  const latest = useRef({ layout, onChoose });
  latest.current = { layout, onChoose };
  const panel = useRef<HTMLDivElement>(null);
  const update = (value: Session | null) => {
    current.current = value;
    setSession(value);
  };
  const close = () => {
    update(null);
    host.current?.focus();
  };
  const choose = (index: number, point: Point) => {
    const s = current.current;
    if (!s) return;
    close();
    latest.current.onChoose(latest.current.layout[index], s.anchor, point);
  };
  const save = (value: ToolbarId[]) => {
    setLayout(value);
    try {
      localStorage.setItem(radialStorageKey, JSON.stringify(value));
    } catch {}
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      const s = current.current;
      if (!s || s.editing || event.buttons) return;
      const dx = event.clientX - s.center.x,
        dy = event.clientY - s.center.y;
      // A wheel shifted away from an edge must be entered before flick selection arms.
      if (Math.hypot(dx, dy) < 60) s.armed = true;
      const index = radialSlot(dx, dy);
      if (s.armed && index !== null) choose(index, pointer.current);
    };
    const key = (event: KeyboardEvent) => {
      const s = current.current;
      if (s) {
        if (event.repeat && event.key === 'Tab') {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (event.key === 'Escape' || (event.key === 'Tab' && !s.editing)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          close();
          return;
        }
        if (s.editing) {
          if (event.key === 'Tab') {
            const buttons = [
              ...(panel.current?.querySelectorAll<HTMLButtonElement>('button') || []),
            ];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
            event.preventDefault();
            buttons[next]?.focus();
          } else if (event.key === 'Enter' || event.key === ' ') {
            const focused = document.activeElement as HTMLButtonElement;
            if (panel.current?.contains(focused) && focused.tagName === 'BUTTON') {
              event.preventDefault();
              focused.click();
            }
          }
          event.stopImmediatePropagation();
          return;
        }
        const sectors: Record<string, number> = {
          ArrowUp: 0,
          ArrowRight: 2,
          ArrowDown: 3,
          ArrowLeft: 5,
        };
        if (event.key in sectors) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const buttons = [
            ...(panel.current?.querySelectorAll<HTMLButtonElement>(
              '.radial-tool,.radial-settings',
            ) || []),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            index < 0
              ? event.key === 'ArrowDown'
                ? 7
                : sectors[event.key]
              : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) %
                buttons.length;
          buttons[next]?.focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
          const focused = document.activeElement as HTMLButtonElement;
          if (panel.current?.contains(focused) && focused.tagName === 'BUTTON') {
            event.preventDefault();
            event.stopImmediatePropagation();
            focused.click();
          }
        } else event.stopImmediatePropagation();
        return;
      }
      if (
        event.key !== 'Tab' ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const e = engine.current,
        p = pointer.current;
      if (!e?.canOpenQuickTools || !p) return;
      if (
        document.querySelector('[role="dialog"], .pdf-workspace, .image-viewer') ||
        (event.target as HTMLElement)?.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        )
      )
        return;
      const beneath = document.elementFromPoint(p.x, p.y);
      if (!beneath?.closest('.canvas-surface')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      e.stopCameraAnimation();
      const rect = host.current!.getBoundingClientRect();
      const center = {
        x: Math.max(150, Math.min(innerWidth - 150, p.x)),
        y: Math.max(150, Math.min(innerHeight - 195, p.y)),
      };
      setSlot(5);
      update({
        center,
        anchor: e.screenPoint({ x: p.x - rect.left, y: p.y - rect.top }),
        editing: false,
        armed: Math.hypot(center.x - p.x, center.y - p.y) < 60,
      });
    };
    const dismiss = () => update(null);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, []);
  useEffect(() => {
    if (session?.editing)
      panel.current?.querySelector<HTMLButtonElement>('.radial-palette button')?.focus();
  }, [session?.editing]);
  if (!session) return null;
  const byId = new Map(tools.map((t) => [t.id, t]));
  const selected = byId.get(layout[slot]);
  return createPortal(
    <div
      className="radial-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget || event.button === 2) {
          event.preventDefault();
          close();
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div
        ref={panel}
        className={'radial-menu' + (session.editing ? ' is-editing' : '')}
        role={session.editing ? 'dialog' : 'toolbar'}
        aria-label={session.editing ? 'Customize quick tools' : 'Quick tools'}
        aria-modal={session.editing || undefined}
        style={session.editing ? undefined : { left: session.center.x, top: session.center.y }}
      >
        <div className="radial-wheel">
          <svg className="radial-segments" viewBox="-140 -140 280 280" aria-hidden="true">
            {radialSectors.map((sector, index) => {
              const a = ((sector * 45 - 111) * Math.PI) / 180,
                b = ((sector * 45 - 69) * Math.PI) / 180;
              const point = (r: number, angle: number) =>
                `${r * Math.cos(angle)},${r * Math.sin(angle)}`;
              return (
                <path
                  key={sector}
                  data-active={(session.editing && slot === index) || undefined}
                  d={`M ${point(60, a)} L ${point(136, a)} A 136 136 0 0 1 ${point(136, b)} L ${point(60, b)} A 60 60 0 0 0 ${point(60, a)} Z`}
                />
              );
            })}
          </svg>
          <div className="radial-center" aria-hidden="true">
            <span>{session.editing ? selected?.label : 'Quick tools'}</span>
            <small>{session.editing ? 'Choose a slot' : 'Move to select'}</small>
          </div>
          {layout.map((id, index) => {
            const tool = byId.get(id)!;
            const angle = ((radialSectors[index] * 45 - 90) * Math.PI) / 180;
            return (
              <button
                key={index}
                className="radial-tool"
                data-radial-slot={index}
                data-radial-tool={id}
                aria-label={session.editing ? `Change ${tool.label} slot` : tool.label}
                aria-pressed={session.editing ? slot === index : undefined}
                style={{ left: 140 + Math.cos(angle) * 99, top: 140 + Math.sin(angle) * 99 }}
                onFocus={() => setSlot(index)}
                onClick={(event) =>
                  session.editing
                    ? setSlot(index)
                    : choose(
                        index,
                        event.detail
                          ? { x: event.clientX, y: event.clientY }
                          : pointer.current || session.center,
                      )
                }
              >
                <tool.icon size={23} strokeWidth={1.65} />
                <span>{tool.label}</span>
              </button>
            );
          })}
          <button
            className="radial-settings icon-button"
            aria-label={session.editing ? 'Done customizing' : 'Customize quick tools'}
            title={session.editing ? 'Done' : 'Customize quick tools'}
            onClick={() => {
              if (session.editing) close();
              else update({ ...session, editing: true });
            }}
          >
            {session.editing ? <Check size={20} /> : <Settings2 size={20} />}
          </button>
        </div>
        {session.editing && (
          <div className="radial-palette glass-surface">
            <div className="radial-palette-heading">
              <div>
                <strong>Quick tools</strong>
                <p>Choose a slot, then its tool.</p>
              </div>
              <button className="icon-button" aria-label="Close customization" onClick={close}>
                <X size={18} />
              </button>
            </div>
            <div className="radial-choices">
              {tools.map((tool) => (
                <button
                  key={tool.id}
                  aria-pressed={layout[slot] === tool.id}
                  onClick={() => save(layout.map((id, index) => (index === slot ? tool.id : id)))}
                >
                  <tool.icon size={19} />
                  <span>{tool.label}</span>
                </button>
              ))}
            </div>
            <button className="radial-reset" onClick={() => save(defaultRadialLayout())}>
              <RotateCcw size={14} />
              Restore defaults
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
