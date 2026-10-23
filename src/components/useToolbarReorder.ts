import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { moveVisibleToolbarTool, type ToolLayout, type ToolbarZone } from './toolbar-layout';

type Gesture<Id extends string> = {
  id: Id;
  pointer: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  base: ToolLayout<Id>;
  active: boolean;
  released: boolean;
  valid: boolean;
  // Fingers pick a tool up by holding it still (HOLD_MS); moving first is a tap or a swipe.
  touch: boolean;
  hold: number;
};
const HOLD_MS = 450;
const inside = (x: number, y: number, r: DOMRect, slack = 0) =>
  x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useToolbarReorder<Id extends string>({
  initialLayout,
  available,
  onSave,
  onLayout,
  context = '',
  preserveSelectionOnEscape = false,
}: {
  initialLayout: () => ToolLayout<Id>;
  available: readonly Id[];
  onSave: (layout: ToolLayout<Id>) => void;
  onLayout?: () => void;
  context?: string;
  preserveSelectionOnEscape?: boolean;
}) {
  const [layout, setLayout] = useState(initialLayout);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [dragging, setDragging] = useState<Id | null>(null);
  const current = useRef(layout);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const inventory = useRef<HTMLDivElement>(null);
  const avatar = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture<Id> | null>(null);
  const before = useRef(new Map<string, DOMRect>());
  const animations = useRef(new Map<Element, Animation>());
  const settle = useRef<Animation | null>(null);
  const settleFrame = useRef(0);
  const suppressClick = useRef(0);
  const plus = useRef<HTMLButtonElement>(null);
  const nodes = () =>
    Array.from(root.current?.querySelectorAll<HTMLElement>('[data-tool-id]') || []);
  const snapshot = () => {
    before.current = new Map(nodes().map((el) => [el.dataset.toolId!, el.getBoundingClientRect()]));
    if (surface.current) before.current.set('surface', surface.current.getBoundingClientRect());
  };
  const preview = (next: ToolLayout<Id>) => {
    if (JSON.stringify(next) === JSON.stringify(current.current)) return;
    snapshot();
    current.current = next;
    setLayout(next);
  };
  const save = onSave;
  useLayoutEffect(() => {
    onLayout?.();
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
    clearTimeout(gesture.current?.hold);
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
  const activate = (g: Gesture<Id>) => {
    g.active = true;
    if (root.current && !root.current.hasPointerCapture(g.pointer))
      root.current.setPointerCapture(g.pointer);
    setDragging(g.id);
    setOpen(true);
    document.body.classList.add('toolbar-reordering');
  };
  const move = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.released || event.pointerId !== g.pointer) return;
    g.x = event.clientX;
    g.y = event.clientY;
    if (!g.active) {
      const moved = Math.hypot(g.x - g.startX, g.y - g.startY);
      if (g.touch) {
        // Moved before the hold finished: not a pick-up.
        if (moved > 10) {
          clearTimeout(g.hold);
          gesture.current = null;
        }
        return;
      }
      if (moved < 6) return;
      activate(g);
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
    preview(moveVisibleToolbarTool(current.current, g.id, zone, index, available));
  };
  const handlers = useRef({ move, finish });
  handlers.current = { move, finish };
  useEffect(() => {
    const onMove = (e: PointerEvent) => handlers.current.move(e);
    const onUp = (e: PointerEvent) => {
      if (gesture.current?.pointer === e.pointerId) handlers.current.finish();
    };
    const cancel = () => handlers.current.finish(true);
    // Only the toolbar losing its capture ends a drag. A finger's button holds the
    // pointer until the drag takes it over, and its lostpointercapture bubbles here too.
    const lost = (e: PointerEvent) => {
      if (e.target === root.current) cancel();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (gesture.current) {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else {
        if (preserveSelectionOnEscape && openRef.current) {
          e.preventDefault();
          e.stopPropagation();
        }
        if (inventory.current?.contains(document.activeElement)) plus.current?.focus();
        setOpen(false);
      }
    };
    const down = (e: PointerEvent) => {
      if (!gesture.current && !root.current?.contains(e.target as Node)) setOpen(false);
    };
    const click = (e: MouseEvent) => {
      if (e.detail > 0 && performance.now() < suppressClick.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        suppressClick.current = 0;
      }
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('lostpointercapture', lost);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', down);
    window.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('lostpointercapture', lost);
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
  const start = (event: ReactPointerEvent<HTMLElement>, id: Id) => {
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
      touch: event.pointerType === 'touch',
      hold: 0,
    };
    const g = gesture.current;
    if (g.touch)
      g.hold = window.setTimeout(() => {
        if (gesture.current !== g || g.released) return;
        // A short buzz says the tool is picked up (Android: the VIBRATE permission).
        navigator.vibrate?.(25);
        activate(g);
        positionAvatar();
      }, HOLD_MS);
  };

  useLayoutEffect(() => {
    const g = gesture.current;
    if (g) {
      preview(g.base);
      settle.current?.cancel();
      clear();
    }
    setOpen(false);
  }, [context]);
  const moveTool = (id: Id, zone: ToolbarZone, index: number) => {
    const next = moveVisibleToolbarTool(current.current, id, zone, index, available);
    preview(next);
    save(next);
  };
  return {
    layout,
    open,
    setOpen,
    dragging,
    current,
    root,
    bar,
    inventory,
    avatar,
    surface,
    plus,
    gesture,
    preview,
    save,
    start,
    moveTool,
  };
}
