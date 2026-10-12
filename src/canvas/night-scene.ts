import type { Camera, CanvasObject } from '../model';

export interface NightLight {
  id: string;
  x: number;
  y: number;
  radius: number;
  rgb: number[];
}
export interface NightShadow {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  dx: number;
  dy: number;
  ellipse: boolean;
}

export function nightScene(objects: CanvasObject[], camera: Camera, width: number, height: number) {
  const candidates = objects
    .map((o) => ({
      o,
      x: camera.x + (o.x + o.width / 2) * camera.zoom,
      y: camera.y + (o.y + o.height / 2) * camera.zoom,
      width: o.width * camera.zoom,
      height: o.height * camera.zoom,
      radius: Math.min(600, (Math.max(o.width, o.height) * 0.75 + 210) * camera.zoom),
    }))
    .filter(
      (p) =>
        p.x + p.radius >= 0 &&
        p.y + p.radius >= 0 &&
        p.x - p.radius <= width &&
        p.y - p.radius <= height,
    );
  const lights: NightLight[] = [];
  // Closest lights receive the budget, so very large boards stay responsive.
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x - width / 2, a.y - height / 2) - Math.hypot(b.x - width / 2, b.y - height / 2),
  );
  for (const p of candidates) {
    if (!['note', 'rect', 'ellipse'].includes(p.o.type) || !/^#[\da-f]{6}$/i.test(p.o.color || ''))
      continue;
    const rgb = [1, 3, 5].map((i) => parseInt(p.o.color!.slice(i, i + 2), 16));
    const max = Math.max(...rgb),
      min = Math.min(...rgb);
    if (max - min < 12 || max < 50 || p.radius < 5) continue;
    // Bring pastel paper colors back to a warm, visible light hue.
    const saturated = rgb.map((v) => Math.round(65 + ((v - min) / (max - min)) * 190));
    lights.push({ id: p.o.id, x: p.x, y: p.y, radius: p.radius, rgb: saturated });
    if (lights.length === 24) break;
  }
  const shadows: NightShadow[] = [];
  for (const p of candidates) {
    if (['text', 'arrow', 'highlight', 'frame'].includes(p.o.type)) continue;
    const closest = lights
      .filter(
        (l) =>
          l.id !== p.o.id &&
          Math.hypot(l.x - p.x, l.y - p.y) < l.radius + Math.max(p.width, p.height) / 2,
      )
      .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    const distance = closest ? Math.max(1, Math.hypot(p.x - closest.x, p.y - closest.y)) : 1;
    const length = Math.min(40, 22 * camera.zoom);
    shadows.push({
      id: p.o.id,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      rotation: ((p.o.rotation || 0) * Math.PI) / 180,
      dx: closest ? ((p.x - closest.x) / distance) * length : 0,
      dy: closest ? ((p.y - closest.y) / distance) * length : length / 2,
      ellipse: p.o.type === 'ellipse',
    });
    if (shadows.length === 100) break;
  }
  return { lights, shadows };
}
