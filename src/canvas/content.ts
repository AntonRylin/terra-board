import type { CanvasObject } from '../model';
export function pastedUrl(text: string): string | null {
  const value = text.trim();
  if (value.length > 8192 || !/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.href.length <= 8192 ? url.href : null;
  } catch {
    return null;
  }
}
export function clipboardObjects(input: unknown): CanvasObject[] {
  if (!Array.isArray(input) || input.length > 10000)
    throw Error('Unsupported clipboard content; copy up to 10,000 objects at once');
  return input.map((o: any) => {
    if (
      !o ||
      typeof o !== 'object' ||
      !['text', 'note', 'rect', 'ellipse', 'frame', 'image', 'video', 'link'].includes(o.type)
    )
      throw Error('Invalid clipboard object');
    if (
      !['x', 'y', 'width', 'height', 'z'].every(
        (k) => typeof o[k] === 'number' && Number.isFinite(o[k]) && Math.abs(o[k]) < 1e9,
      ) ||
      o.width < 1 ||
      o.height < 1 ||
      o.width > 1e6 ||
      o.height > 1e6 ||
      Math.abs(o.z) > 1e7
    )
      throw Error('Invalid clipboard geometry');
    if (
      typeof o.id !== 'string' ||
      !/^[\w-]{1,100}$/.test(o.id) ||
      (o.groupId && !/^[\w-]{1,100}$/.test(o.groupId))
    )
      throw Error('Invalid identifier');
    if (
      o.rotation !== undefined &&
      !(Number.isFinite(o.rotation) && o.rotation >= 0 && o.rotation <= 360)
    )
      throw Error('Invalid clipboard rotation');
    for (const key of ['centerX', 'centerY', 'textBox'])
      if (o[key] !== undefined && typeof o[key] !== 'boolean')
        throw Error('Invalid clipboard alignment');
    if (o.color !== undefined && !/^#[a-f0-9]{6}$/i.test(o.color))
      throw Error('Invalid clipboard color');
    if (
      o.fontSize !== undefined &&
      !(Number.isFinite(o.fontSize) && o.fontSize >= 8 && o.fontSize <= 300)
    )
      throw Error('Invalid font size');
    if (o.text !== undefined && (typeof o.text !== 'string' || o.text.length > 100000))
      throw Error('Invalid clipboard text');
    if (
      o.imageTitle !== undefined &&
      (o.type !== 'image' || typeof o.imageTitle !== 'string' || o.imageTitle.length > 100000)
    )
      throw Error('Invalid image title');
    if (['image', 'video'].includes(o.type) && !/^[a-f0-9]{64}$/.test(o.assetId))
      throw Error('Invalid media identifier');
    if (o.crop !== undefined) {
      const c = o.crop;
      if (
        o.type !== 'image' ||
        !c ||
        !['x', 'y', 'width', 'height'].every(
          (k) => typeof c[k] === 'number' && Number.isFinite(c[k]),
        ) ||
        c.x < 0 ||
        c.y < 0 ||
        c.width < 1e-6 ||
        c.height < 1e-6 ||
        c.x + c.width > 1 + 1e-9 ||
        c.y + c.height > 1 + 1e-9
      )
        throw Error('Invalid image crop');
    }
    if (o.type === 'link') {
      if (o.linkCompact !== undefined && typeof o.linkCompact !== 'boolean')
        throw Error('Invalid link appearance');
      if (
        o.linkPreviewHeight !== undefined &&
        !(
          typeof o.linkPreviewHeight === 'number' &&
          Number.isFinite(o.linkPreviewHeight) &&
          o.linkPreviewHeight >= 1 &&
          o.linkPreviewHeight <= 1e6
        )
      )
        throw Error('Invalid link preview height');
      if (
        o.linkDescription !== undefined &&
        (typeof o.linkDescription !== 'string' || o.linkDescription.length > 500)
      )
        throw Error('Invalid link description');
      if (o.assetId && !/^[a-f0-9]{64}$/.test(o.assetId)) throw Error('Invalid preview image');
      if (o.linkIconId && !/^[a-f0-9]{64}$/.test(o.linkIconId)) throw Error('Invalid site icon');
      let u;
      try {
        u = new URL(o.url);
      } catch {
        throw Error('Invalid link');
      }
      if (!['http:', 'https:'].includes(u.protocol) || o.url.length > 8192)
        throw Error('Invalid link');
    }
    return {
      id: o.id,
      type: o.type,
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
      z: o.z,
      ...(o.text === undefined ? {} : { text: o.text }),
      ...(o.imageTitle === undefined ? {} : { imageTitle: o.imageTitle }),
      ...(o.color === undefined ? {} : { color: o.color }),
      ...(o.fontSize === undefined ? {} : { fontSize: o.fontSize }),
      ...(o.centerX === undefined ? {} : { centerX: o.centerX }),
      ...(o.centerY === undefined ? {} : { centerY: o.centerY }),
      ...(o.rotation === undefined ? {} : { rotation: o.rotation }),
      ...(o.textBox === undefined ? {} : { textBox: o.textBox }),
      ...(o.groupId ? { groupId: o.groupId } : {}),
      ...(o.assetId ? { assetId: o.assetId } : {}),
      ...(o.type === 'link' && o.linkIconId ? { linkIconId: o.linkIconId } : {}),
      ...(o.type === 'link' && o.linkCompact !== undefined ? { linkCompact: o.linkCompact } : {}),
      ...(o.type === 'link' && o.linkPreviewHeight !== undefined
        ? { linkPreviewHeight: o.linkPreviewHeight }
        : {}),
      ...(o.crop
        ? { crop: { x: o.crop.x, y: o.crop.y, width: o.crop.width, height: o.crop.height } }
        : {}),
      ...(o.url ? { url: o.url } : {}),
      ...(o.type === 'link' && o.linkDescription !== undefined
        ? { linkDescription: o.linkDescription }
        : {}),
    };
  });
}
export function previewText(text: string, width: number, height: number, font: number): string {
  const cols = Math.max(1, Math.floor(Math.min(width, 2048) / (font * 1.1))),
    lines = Math.max(1, Math.min(64, Math.floor(Math.min(height, 2048) / (font * 1.45))));
  let remaining = lines;
  const result: string[] = [];
  for (const line of text.split('\n')) {
    if (remaining <= 0) break;
    const capacity = remaining * cols;
    if (line.length > capacity) {
      result.push(line.slice(0, Math.max(1, capacity - 1)) + '…');
      remaining = 0;
      break;
    }
    result.push(line);
    remaining -= Math.max(1, Math.ceil(line.length / cols));
  }
  return result.join('\n');
}
