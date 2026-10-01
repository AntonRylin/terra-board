export function iconCrop(width: number, height: number, zoom: number, cx: number, cy: number) {
  const size = Math.min(width, height) / Math.max(1, zoom);
  return {
    x: Math.max(0, Math.min(width - size, cx * width - size / 2)),
    y: Math.max(0, Math.min(height - size, cy * height - size / 2)),
    size,
  };
}
