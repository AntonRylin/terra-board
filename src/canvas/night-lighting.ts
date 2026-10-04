import type { Camera, CanvasObject } from '../model';
import { nightScene } from './night-scene';

/** A bounded, half-resolution light layer, redrawn only when the board changes. */
export class NightLighting {
  readonly canvas = document.createElement('canvas');
  private signature = '';
  constructor(host: HTMLElement) {
    this.canvas.className = 'night-lighting';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.prepend(this.canvas);
  }
  draw(objects: CanvasObject[], camera: Camera, width: number, height: number, enabled: boolean) {
    this.canvas.hidden = !enabled;
    if (!enabled) {
      this.signature = '';
      return;
    }
    const scene = nightScene(objects, camera, width, height);
    const signature = JSON.stringify([width, height, scene]);
    if (signature === this.signature) return;
    this.signature = signature;
    const scale = 0.6;
    const pixelWidth = Math.ceil(width * scale),
      pixelHeight = Math.ceil(height * scale);
    // Resizing resets the backing surface. Keep it alive throughout camera
    // animation and clear pixels explicitly, avoiding compositor churn.
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(scale, scale);
    ctx.globalCompositeOperation = 'screen';
    for (const light of scene.lights) {
      const { x, y, radius: r, rgb } = light;
      const color = rgb.join(',');
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, `rgba(${color},0.28)`);
      gradient.addColorStop(0.3, `rgba(${color},0.15)`);
      gradient.addColorStop(0.65, `rgba(${color},0.045)`);
      gradient.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const s of scene.shadows) {
      ctx.save();
      ctx.translate(s.x + s.dx, s.y + s.dy);
      ctx.rotate(s.rotation);
      ctx.filter = 'blur(14px)';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
      ctx.beginPath();
      if (s.ellipse) ctx.ellipse(0, 0, s.width / 2, s.height / 2, 0, 0, Math.PI * 2);
      else ctx.roundRect(-s.width / 2, -s.height / 2, s.width, s.height, 8);
      ctx.fill();
      ctx.restore();
    }
  }
  destroy() {
    this.canvas.remove();
  }
}
