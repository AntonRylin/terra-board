import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';

export type DockEdge = 'left' | 'right' | 'top' | 'bottom';
const storageKey = 'terra-board.launcher-edge',
  legacyStorageKey = 'local-canvas.launcher-edge';
export function readDockEdge(): DockEdge {
  try {
    const value = localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey);
    if (value === 'right' || value === 'top' || value === 'bottom') return value;
  } catch {}
  return 'left';
}

function targetEdge(x: number, y: number, bounds: DOMRect): DockEdge | null {
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
  const distances: [DockEdge, number][] = [
    ['left', x - bounds.left],
    ['right', bounds.right - x],
    ['top', y - bounds.top],
    ['bottom', bounds.bottom - y],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][1] <= Math.min(96, bounds.width / 4, bounds.height / 4)
    ? distances[0][0]
    : null;
}

export function useLauncherDock(
  rail: RefObject<HTMLElement | null>,
  edge: DockEdge,
  onDock: (edge: DockEdge) => void,
  onStart: () => void,
) {
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    rect: DOMRect;
    active: boolean;
    target: DockEdge | null;
  } | null>(null);
  const [floating, setFloating] = useState<CSSProperties | null>(null);
  const [target, setTarget] = useState<DockEdge | null>(null);
  const landing = useRef<DOMRect | null>(null);
  const animation = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const el = rail.current,
      from = landing.current;
    if (!el || !from || floating) return;
    landing.current = null;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const to = el.getBoundingClientRect();
    const appearance = getComputedStyle(el);
    animation.current = el.animate(
      [
        {
          transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`,
          width: `${from.width}px`,
          height: `${from.height}px`,
          borderRadius: '14px',
          boxShadow: '0 18px 48px #273c5a30',
        },
        {
          transform: 'translate(0, 0)',
          width: `${to.width}px`,
          height: `${to.height}px`,
          borderRadius: appearance.borderRadius,
          boxShadow: appearance.boxShadow,
        },
      ],
      { duration: 360, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
  }, [floating, edge, rail]);

  const finish = (cancel = false) => {
    const g = gesture.current,
      el = rail.current;
    if (!g || !el) return;
    gesture.current = null;
    if (g.active) {
      landing.current = el.getBoundingClientRect();
      if (!cancel && g.target) {
        onDock(g.target);
        try {
          localStorage.setItem(storageKey, g.target);
        } catch {}
      }
    }
    setFloating(null);
    setTarget(null);
    if (el.hasPointerCapture(g.id)) el.releasePointerCapture(g.id);
  };
  useEffect(() => {
    const cancel = () => finish(true);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gesture.current) {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', key);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
    };
  });
  useEffect(
    () => () => {
      animation.current?.cancel();
    },
    [],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (
      e.button !== 0 ||
      !e.isPrimary ||
      gesture.current ||
      (e.target as HTMLElement).closest('button,input,[contenteditable],[draggable="true"]')
    )
      return;
    animation.current?.cancel();
    const rect = e.currentTarget.getBoundingClientRect();
    gesture.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      rect,
      active: false,
      target: null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current,
      el = rail.current;
    if (!g || !el || g.id !== e.pointerId) return;
    if (!g.active && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 6) return;
    if (!g.active) {
      g.active = true;
      onStart();
    }
    const bounds = el.parentElement!.getBoundingClientRect();
    const horizontal = edge === 'top' || edge === 'bottom';
    const width = horizontal ? Math.min(g.rect.width, 520) : g.rect.width;
    const height = horizontal ? g.rect.height : Math.min(g.rect.height, 420);
    const left = Math.max(
      bounds.left + 4,
      Math.min(e.clientX - ((g.x - g.rect.left) / g.rect.width) * width, bounds.right - width - 4),
    );
    const top = Math.max(
      bounds.top + 4,
      Math.min(
        e.clientY - ((g.y - g.rect.top) / g.rect.height) * height,
        bounds.bottom - height - 4,
      ),
    );
    setFloating({
      inset: '0 auto auto 0',
      width,
      height,
      transform: `translate(${left - bounds.left - el.parentElement!.clientLeft}px, ${top - bounds.top - el.parentElement!.clientTop}px)`,
    });
    g.target = targetEdge(e.clientX, e.clientY, bounds);
    setTarget(g.target);
  };
  return {
    floating,
    target,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
        if (gesture.current?.id === e.pointerId) finish();
      },
      onPointerCancel: () => finish(true),
      onLostPointerCapture: () => finish(true),
    },
  };
}
