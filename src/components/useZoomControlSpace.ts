import { useLayoutEffect, useRef } from 'react';

export function useZoomControlSpace() {
  const zoom = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = zoom.current;
    const shell = element?.closest<HTMLElement>('.app-shell');
    const panel = shell?.querySelector<HTMLElement>('.launcher');
    const toolbar = shell?.querySelector<HTMLElement>('.canvas-toolbar');
    if (!element || !shell || !panel || !toolbar) return;
    let frame = 0;
    let settleUntil = 0;
    const measure = () => {
      if (panel.classList.contains('is-dragging')) return;
      const bounds = shell.getBoundingClientRect();
      // Always test the preferred corner, independent of the current animated
      // position, so moving away from an obstruction cannot cause oscillation.
      const right = bounds.right - 14;
      const bottom = bounds.bottom - 25;
      const left = right - element.offsetWidth;
      const top = bottom - element.offsetHeight;
      const overlaps = (obstacle: HTMLElement) => {
        const box = obstacle.getBoundingClientRect();
        const gap = 8;
        return (
          left < box.right + gap &&
          right > box.left - gap &&
          top < box.bottom + gap &&
          bottom > box.top - gap
        );
      };
      const clear =
        (shell.hasAttribute('data-panel-hidden') || !overlaps(panel)) && !overlaps(toolbar);
      element.dataset.cornerClear = String(clear);
    };
    const tick = () => {
      measure();
      frame = performance.now() < settleUntil ? requestAnimationFrame(tick) : 0;
    };
    const changed = () => {
      // Follow existing dock/hide transitions, then stop observing every frame.
      settleUntil = performance.now() + 450;
      if (!frame) frame = requestAnimationFrame(tick);
      measure();
    };
    const resize = new ResizeObserver(changed);
    [shell, panel, toolbar, element].forEach((node) => resize.observe(node));
    const changes = new MutationObserver(changed);
    changes.observe(shell, {
      attributes: true,
      attributeFilter: ['data-dock', 'data-panel-hidden'],
    });
    changes.observe(panel, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-centered', 'data-minimal'],
    });
    // The board remounts this control on every switch. Place it before the
    // first paint without animating from the dock fallback position.
    element.style.transition = 'none';
    measure();
    void element.offsetWidth;
    element.style.transition = '';
    return () => {
      resize.disconnect();
      changes.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return zoom;
}
