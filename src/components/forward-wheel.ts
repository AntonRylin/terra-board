// Board overlays (tables, lists, papers, PDF workspaces) sit above the board
// canvas, so the wheel lands on them. The engine only takes wheel input aimed
// at its own canvas, so they hand each turn to it: the board zooms (or pans)
// under the pointer as it does anywhere else.
type WheelLike = Pick<
  WheelEvent,
  | 'clientX'
  | 'clientY'
  | 'deltaX'
  | 'deltaY'
  | 'deltaMode'
  | 'ctrlKey'
  | 'metaKey'
  | 'shiftKey'
  | 'altKey'
  | 'target'
>;

// Whether the turn scrolls something inside the overlay, such as a dropdown.
function scrollsInside(e: WheelLike, stop: Element | null) {
  for (
    let el = e.target instanceof Element ? e.target : null;
    el && el !== stop;
    el = el.parentElement
  ) {
    const style = getComputedStyle(el);
    if (
      e.deltaY &&
      /auto|scroll|overlay/.test(style.overflowY) &&
      (e.deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)
    )
      return true;
    if (
      e.deltaX &&
      /auto|scroll|overlay/.test(style.overflowX) &&
      (e.deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    )
      return true;
  }
  return false;
}

/** Sends a wheel turn over an overlay to the board canvas inside host. */
export function forwardWheel(
  host: Element | null | undefined,
  e: WheelLike,
  { overlay = null as Element | null } = {},
) {
  const canvas = host?.querySelector(':scope > canvas:not(.night-lighting)');
  if (!canvas || (!e.ctrlKey && !e.metaKey && scrollsInside(e, overlay))) return false;
  canvas.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: e.clientX,
      clientY: e.clientY,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    }),
  );
  return true;
}
