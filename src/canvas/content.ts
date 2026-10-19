import type { CanvasObject } from '../model';
import { pdfComposerValue } from './pdf-composer.ts';
import { sanitizeMarks } from './rich-text.ts';
import { htmlSourceLimit } from './html-card.ts';
import { albumValue } from './album.ts';
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
      ![
        'text',
        'note',
        'rect',
        'ellipse',
        'frame',
        'image',
        'video',
        'document',
        'link',
        'arrow',
        'highlight',
        'list',
        'paper',
        'html',
        'browser',
      ].includes(o.type)
    )
      throw Error('Invalid clipboard object');
    if (
      o.listScale !== undefined &&
      !(Number.isFinite(o.listScale) && o.listScale >= 1e-6 && o.listScale <= 1e6)
    )
      throw Error('Invalid clipboard list scale');
    if (
      o.frameLink !== undefined &&
      (o.type !== 'frame' ||
        !o.frameLink ||
        o.gallery !== undefined ||
        o.pdfComposer !== undefined ||
        ![o.frameLink.boardId, o.frameLink.frameId].every(
          (v) => typeof v === 'string' && /^[\w-]{1,100}$/.test(v),
        ))
    )
      throw Error('Invalid frame link');
    let pdfComposer;
    if (o.pdfComposer !== undefined) {
      if (o.type !== 'frame' || o.gallery !== undefined)
        throw Error('PDF composers must be non-gallery frames');
      pdfComposer = pdfComposerValue(o.pdfComposer);
    }
    if (
      o.type === 'list' &&
      (!Array.isArray(o.items) ||
        o.items.length > 1000 ||
        !o.items.every(
          (item: any) =>
            item &&
            typeof item.id === 'string' &&
            /^[\w-]{1,100}$/.test(item.id) &&
            typeof item.text === 'string' &&
            item.text.length <= 10000 &&
            typeof item.checked === 'boolean',
        ) ||
        new Set(o.items.map((item: any) => item.id)).size !== o.items.length)
    )
      throw Error('Invalid clipboard list items');
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
    for (const key of ['centerX', 'centerY', 'textBox', 'bold', 'strikethrough'])
      if (o[key] !== undefined && typeof o[key] !== 'boolean')
        throw Error('Invalid clipboard alignment or formatting');
    if (o.color !== undefined && !/^#[a-f0-9]{6}$/i.test(o.color))
      throw Error('Invalid clipboard color');
    if (
      o.gallery !== undefined &&
      (o.type !== 'frame' ||
        !o.gallery ||
        !['right', 'below'].includes(o.gallery.direction) ||
        !Number.isFinite(o.gallery.size) ||
        o.gallery.size < 32 ||
        o.gallery.size > 8192 ||
        !Number.isFinite(o.gallery.gap) ||
        o.gallery.gap < 0 ||
        o.gallery.gap > 200 ||
        (o.rotation || 0) !== 0)
    )
      throw Error('Invalid clipboard gallery');
    if (
      o.galleryId !== undefined &&
      (o.type !== 'image' ||
        typeof o.galleryId !== 'string' ||
        !/^[\w-]{1,100}$/.test(o.galleryId) ||
        !Number.isFinite(o.galleryIndex) ||
        o.galleryIndex < 0 ||
        o.galleryIndex > 1e7)
    )
      throw Error('Invalid clipboard gallery image');
    if (
      o.galleryId &&
      (o.galleryRow !== undefined || o.galleryColumn !== undefined) &&
      (!Number.isInteger(o.galleryRow) ||
        o.galleryRow < 0 ||
        o.galleryRow > 10000 ||
        !Number.isInteger(o.galleryColumn) ||
        o.galleryColumn < 0 ||
        o.galleryColumn > 10000)
    )
      throw Error('Invalid clipboard gallery cell');
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
    for (const [key, limit] of [
      ['documentTitle', 100000],
      ['documentMime', 200],
      ['documentExcerpt', 10000],
    ] as const)
      if (
        o[key] !== undefined &&
        ((o.type !== 'document' && !(o.type === 'paper' && key === 'documentTitle')) ||
          typeof o[key] !== 'string' ||
          o[key].length > limit)
      )
        throw Error('Invalid document metadata');
    for (const [key, min, max] of [
      ['documentBytes', 0, 256 * 1024 * 1024],
      ['documentPageCount', 1, 100000],
    ] as const)
      if (
        o[key] !== undefined &&
        (o.type !== 'document' || !Number.isInteger(o[key]) || o[key] < min || o[key] > max)
      )
        throw Error('Invalid document metadata');
    if (
      o.documentPreviewId !== undefined &&
      (o.type !== 'document' ||
        typeof o.documentPreviewId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(o.documentPreviewId))
    )
      throw Error('Invalid document preview');
    if (['image', 'video', 'document'].includes(o.type) && !/^[a-f0-9]{64}$/.test(o.assetId))
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
    if (
      o.html !== undefined &&
      (o.type !== 'html' || typeof o.html !== 'string' || o.html.length > htmlSourceLimit)
    )
      throw Error('Invalid HTML source');
    if (
      o.snapshotKey !== undefined &&
      ((o.type !== 'html' && o.type !== 'browser') ||
        typeof o.snapshotKey !== 'string' ||
        !/^[\w-]{1,100}$/.test(o.snapshotKey))
    )
      throw Error('Invalid HTML snapshot');
    if (
      (o.type === 'html' || o.type === 'browser') &&
      o.assetId &&
      !/^[a-f0-9]{64}$/.test(o.assetId)
    )
      throw Error('Invalid web page picture');
    if (o.type === 'browser') {
      let u;
      try {
        u = new URL(o.url);
      } catch {
        throw Error('Invalid browser address');
      }
      if (!['http:', 'https:'].includes(u.protocol) || o.url.length > 8192)
        throw Error('Invalid browser address');
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
    if (o.type === 'arrow') {
      const a = o.arrow;
      if (
        !a ||
        !Array.isArray(a.points) ||
        a.points.length < 2 ||
        a.points.length > 32 ||
        !a.points.every(
          (p: any) =>
            p &&
            Number.isFinite(p.x) &&
            Number.isFinite(p.y) &&
            p.x >= 0 &&
            p.x <= 1 &&
            p.y >= 0 &&
            p.y <= 1,
        ) ||
        !['straight', 'curve', 'elbow'].includes(a.line) ||
        !['none', 'arrow', 'triangle', 'open', 'diamond', 'circle'].includes(a.start) ||
        !['none', 'arrow', 'triangle', 'open', 'diamond', 'circle'].includes(a.end) ||
        !['solid', 'dashed', 'dotted'].includes(a.dash) ||
        !Number.isFinite(a.thickness) ||
        a.thickness < 0.5 ||
        a.thickness > 40
      )
        throw Error('Invalid arrow');
    }
    if (o.type === 'highlight') {
      const h = o.highlight;
      if (
        !h ||
        !Array.isArray(h.points) ||
        h.points.length < 2 ||
        h.points.length > 2000 ||
        !h.points.every(
          (p: any) =>
            p &&
            Number.isFinite(p.x) &&
            Number.isFinite(p.y) &&
            p.x >= 0 &&
            p.x <= 1 &&
            p.y >= 0 &&
            p.y <= 1,
        ) ||
        !Number.isFinite(h.size) ||
        h.size < 0.25 ||
        h.size > 10000
      )
        throw Error('Invalid highlight');
    }
    return {
      ...(pdfComposer === undefined ? {} : { pdfComposer }),
      ...(o.type === 'list'
        ? {
            items: o.items.map(({ id, text, checked, marks }: any) => {
              const value = sanitizeMarks(marks, text.length);
              return value ? { id, text, checked, marks: value } : { id, text, checked };
            }),
          }
        : {}),
      ...(o.type === 'arrow'
        ? { arrow: { ...o.arrow, points: o.arrow.points.map((p: any) => ({ x: p.x, y: p.y })) } }
        : {}),
      ...(o.type === 'highlight'
        ? {
            highlight: {
              points: o.highlight.points.map((p: any) => ({ x: p.x, y: p.y })),
              size: o.highlight.size,
            },
          }
        : {}),
      id: o.id,
      type: o.type,
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
      z: o.z,
      ...(o.text === undefined ? {} : { text: o.text }),
      ...(typeof o.text === 'string' && sanitizeMarks(o.textMarks, o.text.length)
        ? { textMarks: sanitizeMarks(o.textMarks, o.text.length) }
        : {}),
      ...(o.imageTitle === undefined ? {} : { imageTitle: o.imageTitle }),
      ...titleMarksOf(o),
      ...(o.frameLink
        ? { frameLink: { boardId: o.frameLink.boardId, frameId: o.frameLink.frameId } }
        : {}),
      ...(o.documentTitle === undefined ? {} : { documentTitle: o.documentTitle }),
      ...(o.documentMime === undefined ? {} : { documentMime: o.documentMime }),
      ...(o.documentBytes === undefined ? {} : { documentBytes: o.documentBytes }),
      ...(o.documentPreviewId === undefined ? {} : { documentPreviewId: o.documentPreviewId }),
      ...(o.documentExcerpt === undefined ? {} : { documentExcerpt: o.documentExcerpt }),
      ...(o.documentPageCount === undefined ? {} : { documentPageCount: o.documentPageCount }),
      ...(o.color === undefined ? {} : { color: o.color }),
      ...(o.fontSize === undefined ? {} : { fontSize: o.fontSize }),
      ...(o.listScale === undefined ? {} : { listScale: o.listScale }),
      ...(o.bold === undefined ? {} : { bold: o.bold }),
      ...(o.strikethrough === undefined ? {} : { strikethrough: o.strikethrough }),
      ...(o.centerX === undefined ? {} : { centerX: o.centerX }),
      ...(o.centerY === undefined ? {} : { centerY: o.centerY }),
      ...(o.rotation === undefined ? {} : { rotation: o.rotation }),
      ...(o.textBox === undefined ? {} : { textBox: o.textBox }),
      ...(o.groupId ? { groupId: o.groupId } : {}),
      ...(o.spoiler === true ? { spoiler: true } : {}),
      ...(o.gallery
        ? { gallery: { direction: o.gallery.direction, size: o.gallery.size, gap: o.gallery.gap } }
        : {}),
      ...(o.galleryId
        ? {
            galleryId: o.galleryId,
            galleryIndex: o.galleryIndex,
            ...(o.galleryRow !== undefined
              ? { galleryRow: o.galleryRow, galleryColumn: o.galleryColumn }
              : {}),
          }
        : {}),
      ...(o.assetId ? { assetId: o.assetId } : {}),
      ...(o.type === 'image' && o.album !== undefined && !o.galleryId
        ? { album: albumValue(o.album, o.assetId) }
        : {}),
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
      ...(o.type === 'html' && o.html !== undefined ? { html: o.html } : {}),
      ...((o.type === 'html' || o.type === 'browser') && o.snapshotKey !== undefined
        ? { snapshotKey: o.snapshotKey }
        : {}),
    };
  });
}
// Formatting of an image's or document's title, kept only over that title.
function titleMarksOf(o: any) {
  const title =
    o.type === 'image' ? o.imageTitle : o.type === 'document' ? o.documentTitle : undefined;
  const titleMarks =
    typeof title === 'string' ? sanitizeMarks(o.titleMarks, title.length) : undefined;
  return titleMarks ? { titleMarks } : {};
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
