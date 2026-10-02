import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { DockEdge } from './useLauncherDock';

export function useLauncherAlignment(
  rail: RefObject<HTMLElement | null>,
  centered: boolean,
  edge: DockEdge,
) {
  const previous = useRef<boolean | null>(null);
  const animations = useRef<Animation[]>([]);
  const stop = useCallback(() => {
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
  }, []);

  useLayoutEffect(() => {
    const strip = rail.current;
    if (!strip) return;
    const changed = previous.current !== null && previous.current !== centered;
    const items = [...strip.querySelectorAll<HTMLElement>('.launcher-scroll > *')];
    // Read the currently visible positions before interrupting a previous slide.
    const before = items.map((item) => item.getBoundingClientRect());
    stop();
    strip.dataset.centered = String(centered);
    previous.current = centered;
    if (!changed || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    animations.current = items.flatMap((item, index) => {
      const after = item.getBoundingClientRect();
      const x = before[index].left - after.left;
      const y = before[index].top - after.top;
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return [];
      // Translate separately from the transforms used for pointer reordering.
      const animation = item.animate([{ translate: `${x}px ${y}px` }, { translate: '0px 0px' }], {
        duration: 320,
        easing: 'cubic-bezier(.22, 1, .36, 1)',
      });
      animation.id = 'launcher-alignment';
      return [animation];
    });
  }, [rail, centered, edge, stop]);

  useEffect(() => {
    const strip = rail.current;
    // New gestures and resizing should use the final, stable layout slots.
    strip?.addEventListener('pointerdown', stop, true);
    strip?.addEventListener('scroll', stop, true);
    window.addEventListener('resize', stop);
    return () => {
      strip?.removeEventListener('pointerdown', stop, true);
      strip?.removeEventListener('scroll', stop, true);
      window.removeEventListener('resize', stop);
      stop();
    };
  }, [rail, stop]);
}
