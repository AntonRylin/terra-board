import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Plus, SquareDashed, type LucideIcon } from 'lucide-react';
import {
  defaultToolbarLayout,
  readToolbarLayout,
  moveToolbarTool,
  toolbarStorageKey,
  type ToolbarId,
  type ToolbarLayout,
  type ToolbarZone,
} from './toolbar-layout';
import './canvas-toolbar.css';

export type ToolbarAction = {
  id: ToolbarId;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  action: () => void;
};
type Gesture = {
  id: ToolbarId;
  pointer: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  base: ToolbarLayout;
  active: boolean;
  released: boolean;
  valid: boolean;
};
const inside = (x: number, y: number, r: DOMRect, slack = 0) =>
  x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function CanvasToolbar({ tools }: { tools: ToolbarAction[] }) {
  const [layout, setLayout] = useState<ToolbarLayout>(() => {
    try {
      return readToolbarLayout(JSON.parse(localStorage.getItem(toolbarStorageKey) || 'null'));
    } catch {
      return defaultToolbarLayout();
    }
  });
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<ToolbarId | null>(null);
  const current = useRef(layout);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const inventory = useRef<HTMLDivElement>(null);
  const avatar = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const before = useRef(new Map<string, DOMRect>());
  const animations = useRef(new Map<Element, Animation>());
  const settle = useRef<Animation | null>(null);
  const settleFrame = useRef(0);
  const suppressClick = useRef(0);
  const plus = useRef<HTMLButtonElement>(null);
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const nodes = () =>
    Array.from(root.current?.querySelectorAll<HTMLElement>('[data-tool-id]') || []);
  const snapshot = () => {
    before.current = new Map(nodes().map((el) => [el.dataset.toolId!, el.getBoundingClientRect()]));
    if (surface.current) before.current.set('surface', surface.current.getBoundingClientRect());
  };
  const preview = (next: ToolbarLayout) => {
    if (JSON.stringify(next) === JSON.stringify(current.current)) return;
    snapshot();
    current.current = next;
    setLayout(next);
  };
  const save = (next: ToolbarLayout) => {
    try {
      localStorage.setItem(toolbarStorageKey, JSON.stringify(next));
    } catch {}
  };
  useLayoutEffect(() => {
    // Layout uses its final size immediately. Only the glass stretches, so a growing
    // bar never wraps icons into a temporary row during the width animation.
    const glass = surface.current;
    const previousGlass = before.current.get('surface');
    if (glass && previousGlass) {
      animations.current.get(glass)?.cancel();
      animations.current.delete(glass);
      const next = glass.getBoundingClientRect();
      if (!reducedMotion()) {
        const dx = previousGlass.left + previousGlass.width / 2 - next.left - next.width / 2;
        const dy = previousGlass.top + previousGlass.height / 2 - next.top - next.height / 2;
        const animation = glass.animate(
          [
            {
              transform: `translate(${dx}px, ${dy}px) scale(${previousGlass.width / next.width}, ${previousGlass.height / next.height})`,
            },
            { transform: 'none' },
          ],
          { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' },
        );
        animations.current.set(glass, animation);
        animation.onfinish = () => {
          if (animations.current.get(glass) === animation) animations.current.delete(glass);
        };
      }
    }
    for (const el of nodes()) {
      const previous = before.current.get(el.dataset.toolId!);
      animations.current.get(el)?.cancel();
      animations.current.delete(el);
      if (!previous || reducedMotion()) continue;
      const next = el.getBoundingClientRect();
      const dx = previous.left - next.left,
        dy = previous.top - next.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      const animation = el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
      animations.current.set(el, animation);
      animation.onfinish = () => {
        if (animations.current.get(el) === animation) animations.current.delete(el);
      };
    }
    before.current.clear();
  }, [layout]);

  const positionAvatar = () => {
    const g = gesture.current;
    if (!g || !avatar.current) return;
    avatar.current.style.left = `${g.x - g.offsetX}px`;
    avatar.current.style.top = `${g.y - g.offsetY}px`;
  };
  useLayoutEffect(positionAvatar, [dragging]);
  const clear = () => {
    const pointer = gesture.current?.pointer;
    gesture.current = null;
    if (pointer !== undefined && root.current?.hasPointerCapture(pointer))
      root.current.releasePointerCapture(pointer);
    setDragging(null);
    document.body.classList.remove('toolbar-reordering');
  };
  const finish = (cancel = false) => {
    const g = gesture.current;
    if (!g || g.released) return;
    if (!g.active) {
      clear();
      return;
    }
    g.released = true;
    suppressClick.current = performance.now() + 350;
    if (cancel || !g.valid) preview(g.base);
    else save(current.current);
    // Let React place the final slot before gliding the held icon into it.
    settleFrame.current = requestAnimationFrame(() => {
      const target = nodes()
        .find((el) => el.dataset.toolId === g.id)
        ?.querySelector('svg')
        ?.getBoundingClientRect();
      const held = avatar.current;
      if (!target || !held || reducedMotion()) {
        clear();
        return;
      }
      settle.current = held.animate(
        [
          { transform: 'translate(0, 0) scale(1.06)' },
          {
            transform: `translate(${target.left + (target.width - g.width) / 2 - (g.x - g.offsetX)}px, ${target.top + (target.height - g.height) / 2 - (g.y - g.offsetY)}px) scale(1)`,
          },
        ],
        { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' },
      );
      settle.current.onfinish = clear;
    });
  };
  const move = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.released || event.pointerId !== g.pointer) return;
    g.x = event.clientX;
    g.y = event.clientY;
    if (!g.active) {
      if (Math.hypot(g.x - g.startX, g.y - g.startY) < 6) return;
      g.active = true;
      root.current?.setPointerCapture(g.pointer);
      setDragging(g.id);
      setOpen(true);
      document.body.classList.add('toolbar-reordering');
    }
    event.preventDefault();
    positionAvatar();
    const panel = inventory.current?.getBoundingClientRect();
    const strip = root.current?.getBoundingClientRect();
    const zone: ToolbarZone | null =
      panel && inside(g.x, g.y, panel, 6)
        ? 'inventory'
        : strip && inside(g.x, g.y, strip, 10)
          ? 'bar'
          : null;
    g.valid = !!zone;
    if (!zone) return;
    const container = zone === 'bar' ? bar.current : inventory.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const slots = Array.from(container.querySelectorAll<HTMLElement>('[data-tool-id]'));
    // Use layout positions, not the animated transforms, so the target stays stable.
    const positions = slots.map((el) => ({
      id: el.dataset.toolId!,
      x: bounds.left + el.offsetLeft + el.offsetWidth / 2,
      y: bounds.top + el.offsetTop + el.offsetHeight / 2 - container.scrollTop,
      width: el.offsetWidth,
    }));
    let index = 0;
    if (positions.length) {
      const nearest = positions.reduce(
        (best, item, i) => {
          const distance = Math.hypot(g.x - item.x, g.y - item.y);
          return distance < best.distance ? { index: i, distance } : best;
        },
        { index: 0, distance: Infinity },
      ).index;
      index = nearest;
      if (
        !current.current[zone].includes(g.id) &&
        (zone === 'inventory' ? g.y > positions[nearest].y : g.x > positions[nearest].x)
      )
        index++;
    }
    preview(moveToolbarTool(current.current, g.id, zone, index));
  };
  const handlers = useRef({ move, finish });
  handlers.current = { move, finish };
  useEffect(() => {
    const onMove = (e: PointerEvent) => handlers.current.move(e);
    const onUp = (e: PointerEvent) => {
      if (gesture.current?.pointer === e.pointerId) handlers.current.finish();
    };
    const cancel = () => handlers.current.finish(true);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (gesture.current) {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else {
        if (inventory.current?.contains(document.activeElement)) plus.current?.focus();
        setOpen(false);
      }
    };
    const down = (e: PointerEvent) => {
      if (!gesture.current && !root.current?.contains(e.target as Node)) setOpen(false);
    };
    const click = (e: MouseEvent) => {
      if (performance.now() < suppressClick.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        suppressClick.current = 0;
      }
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('lostpointercapture', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', down);
    window.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('click', click, true);
      cancelAnimationFrame(settleFrame.current);
      settle.current?.cancel();
      for (const animation of animations.current.values()) animation.cancel();
      document.body.classList.remove('toolbar-reordering');
    };
  }, []);
  const start = (event: ReactPointerEvent<HTMLButtonElement>, id: ToolbarId) => {
    if (event.button !== 0 || gesture.current) return;
    const r = event.currentTarget.getBoundingClientRect();
    const size = Math.min(r.height, 34);
    gesture.current = {
      id,
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      offsetX: size / 2,
      offsetY: size / 2,
      width: size,
      height: size,
      base: current.current,
      active: false,
      released: false,
      valid: false,
    };
  };
  const renderTool = (id: ToolbarId, zone: ToolbarZone) => {
    const item = toolsById.get(id)!;
    const name = id === 'list' ? 'List' : id === 'media' ? 'Images and video' : item.label;
    const Icon = item.icon;
    return (
      <div
        className="toolbar-slot"
        data-tool-id={id}
        data-held={dragging === id || undefined}
        key={id}
      >
        <button
          className="icon-button"
          aria-label={item.label}
          aria-pressed={item.active}
          aria-description="Drag to rearrange. Alt and arrow keys move this tool. Alt and Enter moves it between the toolbar and more tools."
          data-tool-label={zone === 'bar' ? name : undefined}
          draggable={false}
          onPointerDown={(event) => start(event, id)}
          onClick={() => {
            item.action();
            if (zone === 'inventory') setOpen(false);
          }}
          onKeyDown={(event) => {
            if (
              !event.altKey ||
              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const destination =
              event.key === 'Enter' ? (zone === 'bar' ? 'inventory' : 'bar') : zone;
            const index =
              destination !== zone
                ? current.current[destination].length
                : current.current[zone].indexOf(id) +
                  (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
            const next = moveToolbarTool(current.current, id, destination, index);
            setOpen(true);
            preview(next);
            save(next);
            requestAnimationFrame(() =>
              root.current
                ?.querySelector<HTMLButtonElement>(`[data-tool-id="${id}"] button`)
                ?.focus(),
            );
          }}
        >
          <Icon size={19} strokeWidth={1.7} />
          {zone === 'inventory' && <span className="tool-inventory-name">{name}</span>}
        </button>
      </div>
    );
  };
  const DragIcon = dragging ? toolsById.get(dragging)!.icon : null;
  return (
    <>
      <div
        ref={root}
        className="canvas-toolbar customizable-toolbar"
        role="toolbar"
        aria-label="Canvas tools"
        data-reordering={!!dragging || undefined}
        style={{ '--tool-count': layout.bar.length } as CSSProperties}
      >
        <div ref={surface} className="toolbar-glass glass-surface" aria-hidden="true" />
        <div ref={bar} className="toolbar-slots" data-tool-zone="bar">
          {layout.bar.map((id) => renderTool(id, 'bar'))}
        </div>
        <button
          ref={plus}
          className="icon-button toolbar-insert"
          aria-label="Insert"
          aria-expanded={open}
          aria-controls="tool-inventory"
          data-tool-label="More tools"
          onClick={() => setOpen((value) => !value)}
        >
          <Plus size={19} strokeWidth={1.7} />
        </button>
        {open && (
          <div
            ref={inventory}
            id="tool-inventory"
            className="tool-inventory insert-menu glass-surface"
            role="group"
            aria-label="More tools"
            data-tool-zone="inventory"
          >
            {layout.inventory.map((id) => renderTool(id, 'inventory'))}
            {!layout.inventory.length && (
              <SquareDashed className="inventory-empty" size={24} aria-hidden="true" />
            )}
          </div>
        )}
      </div>
      {dragging &&
        DragIcon &&
        createPortal(
          <div
            ref={avatar}
            className="toolbar-held-icon glass-surface"
            aria-hidden="true"
            style={{ width: gesture.current?.width, height: gesture.current?.height }}
          >
            <DragIcon size={19} strokeWidth={1.7} />
          </div>,
          document.body,
        )}
    </>
  );
}
