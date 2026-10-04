import { useEffect, useMemo, useRef } from 'react';

// Sample by distance so the waves stay evenly spaced through the rounded corners.
function outlinePoints(width: number, height: number) {
  const w = width - 1,
    h = height - 1,
    r = Math.min(19.5, w / 2, h / 2);
  const horizontal = w - 2 * r,
    vertical = h - 2 * r,
    arc = (Math.PI * r) / 2;
  const lengths = [horizontal, arc, vertical, arc, horizontal, arc, vertical, arc];
  const perimeter = lengths.reduce((a, b) => a + b, 0);
  const count = Math.min(1200, Math.max(80, Math.ceil(perimeter / 3)));
  const waves = Math.max(4, Math.round(perimeter / 22));
  return Array.from({ length: count }, (_, i) => {
    let distance = (i / count) * perimeter,
      segment = 0;
    while (segment < 7 && distance > lengths[segment]) distance -= lengths[segment++];
    let x: number, y: number, nx: number, ny: number;
    if (segment % 2) {
      const corner = (segment - 1) / 2;
      const angle = -Math.PI / 2 + (corner * Math.PI) / 2 + distance / r;
      nx = Math.cos(angle);
      ny = Math.sin(angle);
      x = (corner < 2 ? w - r : r) + nx * r;
      y = (corner === 0 || corner === 3 ? r : h - r) + ny * r;
    } else if (segment === 0) {
      x = r + distance;
      y = 0;
      nx = 0;
      ny = -1;
    } else if (segment === 2) {
      x = w;
      y = r + distance;
      nx = 1;
      ny = 0;
    } else if (segment === 4) {
      x = w - r - distance;
      y = h;
      nx = 0;
      ny = 1;
    } else {
      x = 0;
      y = h - r - distance;
      nx = -1;
      ny = 0;
    }
    return { x: x + 0.5, y: y + 0.5, nx, ny, phase: (i / count) * waves * Math.PI * 2 };
  });
}

export default function ListEditOutline({ width, height }: { width: number; height: number }) {
  const path = useRef<SVGPathElement>(null);
  const points = useMemo(() => outlinePoints(width, height), [width, height]);
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const started = performance.now();
    const draw = (now: number) => {
      const phase = ((now - started) / 2400) * Math.PI * 2;
      // Ease the ripple in without moving the card or its contents.
      const amplitude = reduced.matches ? 0 : 1.2 * Math.min(1, (now - started) / 200);
      path.current?.setAttribute(
        'd',
        points
          .map((p, i) => {
            const wave = amplitude * Math.sin(p.phase - phase);
            return `${i ? 'L' : 'M'}${(p.x + p.nx * wave).toFixed(2)},${(p.y + p.ny * wave).toFixed(2)}`;
          })
          .join(' ') + ' Z',
      );
      if (!reduced.matches) frame = requestAnimationFrame(draw);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      draw(performance.now());
    };
    reduced.addEventListener('change', restart);
    restart();
    return () => {
      cancelAnimationFrame(frame);
      reduced.removeEventListener('change', restart);
    };
  }, [points]);
  return (
    <svg className="canvas-list-edit-outline" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path ref={path} />
    </svg>
  );
}
