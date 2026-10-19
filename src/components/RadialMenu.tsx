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

type Session = {
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
      update({
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
  const hovered = hover === null ? undefined : byId.get(layout[hover]);
  // The wheel fills most of the screen's smaller dimension; zoom keeps text crisp.
  const grow = Math.max(1, (Math.min(innerWidth, innerHeight) * 0.85) / 330);
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
        style={session.editing ? undefined : { zoom: grow }}
      >
        <div className="radial-wheel" ref={wheel}>
          <svg className="radial-segments" viewBox="-140 -140 280 280" aria-hidden="true">
            {radialSectors.map((sector, index) => {
              const a = ((sector * 45 - 111) * Math.PI) / 180,
                b = ((sector * 45 - 69) * Math.PI) / 180;
              const point = (r: number, angle: number) =>
                `${r * Math.cos(angle)},${r * Math.sin(angle)}`;
              return (
                <path
                  key={sector}
                  data-active={(session.editing ? slot === index : hover === index) || undefined}
                  d={`M ${point(60, a)} L ${point(136, a)} A 136 136 0 0 1 ${point(136, b)} L ${point(60, b)} A 60 60 0 0 0 ${point(60, a)} Z`}
                />
              );
            })}
          </svg>
          <div className="radial-center" aria-hidden="true">
            <span>{session.editing ? selected?.label : (hovered?.label ?? 'Quick tools')}</span>
            <small>
              {session.editing
                ? 'Choose a slot'
                : session.held
                  ? hovered
                    ? 'Release to select'
                    : 'Move to a tool'
                  : 'Click to select'}
            </small>
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
                data-hover={(!session.editing && hover === index) || undefined}
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
                          : pointer.current || session.origin,
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
