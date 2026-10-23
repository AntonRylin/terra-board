import { useLayoutEffect, useRef } from 'react';

// Places the zoom bar in the first free spot, tested in this order: the bottom-right
// corner; beside a panel docked on the right; above a panel docked at the bottom.
// "Free" means clear of the board panel and the canvas toolbar. Where none is free the
// stylesheet's position applies (above the toolbar). `key` re-measures when something
// the hook cannot observe changes, such as the toolbar being hidden or shown.
export function useZoomControlSpace(key?: unknown) {
  const zoom = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = zoom.current;
    const shell = element?.closest<HTMLElement>('.app-shell');
    const panel = shell?.querySelector<HTMLElement>('.launcher');
    if (!element || !shell || !panel) return;
    let frame = 0;
    let settleUntil = 0;
    const margin = { right: 14, bottom: 25 };
    const gap = 8;
    const measure = () => {
      if (panel.classList.contains('is-dragging')) return;
      const bounds = shell.getBoundingClientRect();
      const toolbar = shell.querySelector<HTMLElement>('.canvas-toolbar');
      const panelShown = !shell.hasAttribute('data-panel-hidden');
      const panelBox = panel.getBoundingClientRect();
      const width = element.offsetWidth,
        height = element.offsetHeight;
      const overlaps = (right: number, bottom: number, box: DOMRect) => {
        const r = bounds.right - right,
          b = bounds.bottom - bottom;
        return (
          r - width < box.right + gap &&
          r > box.left - gap &&
          b - height < box.bottom + gap &&
          b > box.top - gap
        );
      };
      // Tested independent of the bar's current, possibly animating, position, so moving
      // away from an obstacle cannot make it oscillate.
      const candidates = [
        margin,
        { right: bounds.right - panelBox.left + 10, bottom: margin.bottom },
        { right: margin.right, bottom: bounds.bottom - panelBox.top + 10 },
      ];
      const spot = candidates.find(
        (c) =>
          c.right >= margin.right &&
          c.bottom >= margin.bottom &&
          c.right + width < bounds.width &&
          c.bottom + height < bounds.height &&
          !(panelShown && overlaps(c.right, c.bottom, panelBox)) &&
          !(toolbar && overlaps(c.right, c.bottom, toolbar.getBoundingClientRect())),
      );
      element.dataset.cornerClear = String(spot === margin);
      element.style.right = spot ? `${Math.round(spot.right)}px` : '';
      element.style.bottom = spot ? `${Math.round(spot.bottom)}px` : '';
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
    [shell, panel, element].forEach((node) => resize.observe(node));
    const toolbar = shell.querySelector<HTMLElement>('.canvas-toolbar');
    if (toolbar) resize.observe(toolbar);
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
  }, [key]);
  return zoom;
}
