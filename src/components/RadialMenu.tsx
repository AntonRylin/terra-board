import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, RotateCcw, Settings2, X } from 'lucide-react';
import type { Engine } from '../canvas/engine';
import type { Point } from '../canvas/geometry';
import type { ToolbarAction } from './CanvasToolbar';
import type { ToolbarId } from './toolbar-layout';
import { defaultRadialLayout, radialSectors, radialSlot } from './radial-layout';
import { updatePreferences, usePreferences } from '../settings/preferences';
import { isCommand } from '../shortcuts/active';
import './radial-menu.css';

// One ring tile, in wheel pixels (0-280) with the wheel's middle at 140,140.
function sectorPath(sector: number) {
  const a = ((sector * 45 - 111.5) * Math.PI) / 180,
    b = ((sector * 45 - 68.5) * Math.PI) / 180;
  const point = (r: number, angle: number) =>
    `${140 + r * Math.cos(angle)},${140 + r * Math.sin(angle)}`;
  return `M ${point(56, a)} L ${point(136, a)} A 136 136 0 0 1 ${point(136, b)} L ${point(56, b)} A 56 56 0 0 0 ${point(56, a)} Z`;
}

type Session = {
  center: Point;
  anchor: Point;
  origin: Point;
  code: string;
  editing: boolean;
  armed: boolean;
  held: boolean;
};
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
  const layout = usePreferences().radial;
  const [session, setSession] = useState<Session | null>(null);
  const [slot, setSlot] = useState(5);
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const current = useRef(session);
  const pointer = useRef<Point | null>(null);
  const latest = useRef({ layout, onChoose });
  latest.current = { layout, onChoose };
  const panel = useRef<HTMLDivElement>(null);
  const wheel = useRef<HTMLDivElement>(null);
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
  const save = (value: ToolbarId[]) => updatePreferences({ radial: value });
  // Pointer position translated into a wheel slot, whatever size the wheel renders at.
  const slotAt = (point: Point) => {
    const rect = wheel.current?.getBoundingClientRect();
    if (!rect) return null;
    const scale = rect.width / 280;
    return radialSlot(
      (point.x - rect.left - rect.width / 2) / scale,
      (point.y - rect.top - rect.width / 2) / scale,
    );
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      const s = current.current;
      if (!s || s.editing || event.buttons) return;
      // Highlighting arms only after deliberate movement, so releasing the trigger
      // right away never picks whatever sector the stale cursor happened to sit in.
      if (!s.armed && Math.hypot(event.clientX - s.origin.x, event.clientY - s.origin.y) > 16)
        s.armed = true;
      setHover(s.armed ? slotAt(pointer.current) : null);
    };
    const release = (event: KeyboardEvent) => {
      const s = current.current;
      if (!s || s.editing || !s.held || event.code !== s.code) return;
      const p = pointer.current;
      const index = s.armed && p ? slotAt(p) : null;
      if (p && index !== null) choose(index, p);
      // A tap without movement leaves the wheel open for click or keyboard selection.
      else update({ ...s, held: false });
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
      if (event.repeat || !isCommand(event, 'view.radial')) return;
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
      setSlot(5);
      setHover(null);
      setFocused(null);
      update({
        center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        anchor: e.screenPoint({ x: p.x - rect.left, y: p.y - rect.top }),
        origin: { ...p },
        code: event.code,
        editing: false,
        armed: false,
        held: true,
      });
    };
    const dismiss = () => update(null);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', release, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', release, true);
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
  const active = (index: number) =>
    session.editing ? slot === index : (hover ?? focused) === index;
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
        // The wheel sits on the middle of the board, not the middle of the whole window.
        style={session.editing ? undefined : { left: session.center.x, top: session.center.y }}
      >
        <div
          className="radial-wheel"
          ref={wheel}
          // Clicks anywhere in a sector pick it, not just on its icon.
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('button')) return;
            const point = { x: event.clientX, y: event.clientY };
            const index = slotAt(point);
            if (index === null) return;
            if (session.editing) setSlot(index);
            else choose(index, point);
          }}
        >
          {/* Backdrop blur needs real elements, so each tile is a clipped glass layer. */}
          {radialSectors.map((sector) => (
            <div
              key={sector}
              className="radial-glass glass-surface"
              style={{ clipPath: `path('${sectorPath(sector)}')` }}
              aria-hidden="true"
            />
          ))}
          <svg className="radial-segments" viewBox="0 0 280 280" aria-hidden="true">
            {radialSectors.map((sector, index) => (
              <path key={sector} data-active={active(index) || undefined} d={sectorPath(sector)} />
            ))}
          </svg>
          {session.editing && (
            <div className="radial-center" aria-hidden="true">
              <span>{selected?.label}</span>
              <small>Choose a slot</small>
            </div>
          )}
          {layout.map((id, index) => {
            const tool = byId.get(id)!;
            const angle = ((radialSectors[index] * 45 - 90) * Math.PI) / 180;
            return (
              <button
                key={index}
                className="radial-tool"
                data-radial-slot={index}
                data-radial-tool={id}
                data-active={active(index) || undefined}
                aria-label={session.editing ? `Change ${tool.label} slot` : tool.label}
                aria-pressed={session.editing ? slot === index : undefined}
                style={{ left: 140 + Math.cos(angle) * 98, top: 140 + Math.sin(angle) * 98 }}
                onFocus={() => {
                  setSlot(index);
                  setFocused(index);
                }}
                onBlur={() => setFocused(null)}
                onClick={(event) =>
                  session.editing
                    ? setSlot(index)
                    : choose(
                        index,
                        event.detail
                          ? { x: event.clientX, y: event.clientY }
                          : pointer.current || session.origin,
                      )
                }
              >
                <tool.icon size={20} strokeWidth={1.75} />
                <span>{tool.label}</span>
              </button>
            );
          })}
          <button
            className="radial-settings icon-button glass-surface"
            aria-label={session.editing ? 'Done customizing' : 'Customize quick tools'}
            title={session.editing ? 'Done' : 'Customize quick tools'}
            onClick={() => {
              if (session.editing) close();
              else update({ ...session, editing: true });
            }}
          >
            {session.editing ? <Check size={16} /> : <Settings2 size={16} />}
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
