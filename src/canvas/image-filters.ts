// Image looks shared by the image editor and the board icon dialog. Each is a
// CSS filter, so the preview (an <img> style) and the saved pixels (a canvas
// `filter`) match.
export const imageFilterPresets = [
  { id: 'original', label: 'Original', css: '' },
  { id: 'mono', label: 'Black & white', css: 'grayscale(1)' },
  { id: 'noir', label: 'Noir', css: 'grayscale(1) contrast(1.35) brightness(0.95)' },
  { id: 'sepia', label: 'Sepia', css: 'sepia(0.85)' },
  {
    id: 'vintage',
    label: 'Vintage',
    css: 'sepia(0.35) contrast(1.1) saturate(0.85) brightness(1.05)',
  },
  { id: 'warm', label: 'Warm', css: 'sepia(0.22) saturate(1.25) hue-rotate(-8deg)' },
  { id: 'vivid', label: 'Vivid', css: 'saturate(1.55) contrast(1.08)' },
  { id: 'fade', label: 'Fade', css: 'contrast(0.82) brightness(1.1) saturate(0.7)' },
] as const;
export type ImageFilterId = (typeof imageFilterPresets)[number]['id'];

export interface ImageAdjustments {
  filter: ImageFilterId;
  /** Percentages; 100 leaves the image unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
}
export const defaultImageAdjustments: ImageAdjustments = {
  filter: 'original',
  brightness: 100,
  contrast: 100,
  saturation: 100,
};

export function isUnchanged(edit: ImageAdjustments) {
  return (
    edit.filter === 'original' &&
    edit.brightness === 100 &&
    edit.contrast === 100 &&
    edit.saturation === 100
  );
}

export function imageFilterCss(edit: Partial<ImageAdjustments>) {
  const preset = imageFilterPresets.find((p) => p.id === edit.filter)?.css || '';
  const parts = [preset];
  if (edit.brightness !== undefined && edit.brightness !== 100)
    parts.push(`brightness(${edit.brightness / 100})`);
  if (edit.contrast !== undefined && edit.contrast !== 100)
    parts.push(`contrast(${edit.contrast / 100})`);
  if (edit.saturation !== undefined && edit.saturation !== 100)
    parts.push(`saturate(${edit.saturation / 100})`);
  return parts.filter(Boolean).join(' ') || 'none';
}

/** Draws `source` with the edit applied, at its natural size. */
export async function renderFilteredImage(
  source: HTMLImageElement,
  edit: ImageAdjustments,
  type: 'image/png' | 'image/jpeg',
) {
  const canvas = document.createElement('canvas');
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw Error('This image is too large to edit.');
  if (type === 'image/jpeg') {
    // JPEG has no transparency; keep it white rather than black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.filter = imageFilterCss(edit);
  context.drawImage(source, 0, 0);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error('This image is too large to edit.'))),
      type,
      0.92,
    ),
  );
}
