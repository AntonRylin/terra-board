import { CanvasSource, Container, Sprite, Texture } from 'pixi.js';
import type { CanvasObject } from '../model';

// The complete page, including its type badge and footer, scales with the object.
// The optional external title is rendered separately using image-title styling.
const cardWidth = 320;
const cardHeight = 400;

export function documentPreviewBox(o: Pick<CanvasObject, 'width' | 'height'>) {
  return {
    x: (14 / cardWidth) * o.width,
    y: (14 / cardHeight) * o.height,
    width: (292 / cardWidth) * o.width,
    height: (320 / cardHeight) * o.height,
  };
}

function fileKind(o: CanvasObject) {
  const extension = /\.([a-z0-9]{1,12})$/i.exec(o.text || '')?.[1].toUpperCase();
  if (extension) return extension;
  const mime = o.documentMime || '';
  if (mime === 'application/pdf') return 'PDF';
  if (/wordprocessingml/.test(mime)) return 'DOCX';
  if (/msword/.test(mime)) return 'DOC';
  if (/spreadsheetml/.test(mime)) return 'XLSX';
  if (/ms-excel/.test(mime)) return 'XLS';
  if (mime.startsWith('text/')) return 'TXT';
  return 'FILE';
}

function fileSize(bytes: number | undefined) {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 * 1024 ? 1024 : 1024 * 1024;
  return `${Number((bytes / unit).toFixed(bytes < unit * 10 ? 1 : 0))} ${unit === 1024 ? 'KB' : 'MB'}`;
}

function fitLine(context: CanvasRenderingContext2D, value: string, width: number, ellipsis = true) {
  if (context.measureText(value).width <= width) return value;
  const suffix = ellipsis ? '…' : '';
  let low = 0,
    high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (context.measureText(value.slice(0, mid) + suffix).width <= width) low = mid;
    else high = mid - 1;
  }
  // Avoid clipping between the two halves of a UTF-16 character.
  if (low && /[\uD800-\uDBFF]/.test(value[low - 1])) low--;
  return value.slice(0, low) + suffix;
}

function excerptLines(context: CanvasRenderingContext2D, value: string) {
  const rows: string[] = [];
  const paragraphs = value.slice(0, 10000).replace(/\r\n?/g, '\n').split('\n');
  for (let p = 0; p < paragraphs.length && rows.length < 13; p++) {
    let remaining = paragraphs[p].replace(/[\t ]+/g, ' ').trim();
    if (!remaining) {
      rows.push('');
      continue;
    }
    while (remaining && rows.length < 13) {
      const last = rows.length === 12;
      let row = fitLine(context, remaining, 260, last);
      if (last) {
        if (p < paragraphs.length - 1 && !row.endsWith('…'))
          row = fitLine(context, row + ' …', 260);
        rows.push(row);
        return rows;
      }
      if (row.length < remaining.length) {
        const space = row.lastIndexOf(' ');
        if (space > 0) row = row.slice(0, space);
      }
      if (!row) break;
      rows.push(row);
      remaining = remaining.slice(row.length).trimStart();
    }
  }
  return rows;
}

export function renderDocumentCard(
  o: CanvasObject,
  preview: Texture | null,
  resolution: number,
  region: { x: number; y: number; width: number; height: number },
  dark: boolean,
) {
  const container = new Container();
  const left = Math.max(0, region.x),
    top = Math.max(0, region.y),
    right = Math.min(o.width, region.x + region.width),
    bottom = Math.min(o.height, region.y + region.height);
  if (right > left && bottom > top) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil((right - left) * resolution));
    canvas.height = Math.max(1, Math.ceil((bottom - top) * resolution));
    const context = canvas.getContext('2d')!;
    context.scale(resolution, resolution);
    context.translate(-left, -top);
    context.scale(o.width / cardWidth, o.height / cardHeight);
    const ink = dark ? '#e4eaf2' : '#293545';
    const muted = dark ? '#9dabbd' : '#8491a1';
    const kind = fileKind(o);
    const accent = /^PDF$/.test(kind)
      ? dark
        ? '#e5949a'
        : '#b55b65'
      : /^(DOCX?|ODT)$/.test(kind)
        ? dark
          ? '#92b9eb'
          : '#5b84b8'
        : /^(XLSX?|CSV|ODS)$/.test(kind)
          ? dark
            ? '#8bc5a6'
            : '#5a9274'
          : muted;
    context.beginPath();
    context.roundRect(0.5, 0.5, 319, 399, 12);
    context.fillStyle = dark ? '#1c2632' : '#ffffff';
    context.fill();
    context.lineWidth = 1;
    context.strokeStyle = dark ? '#3a485b' : '#dce3eb';
    context.stroke();
    context.beginPath();
    context.roundRect(14, 14, 292, 320, 5);
    context.fillStyle = dark ? '#253142' : '#f4f6f9';
    context.fill();
    if (!preview) {
      if (o.documentExcerpt?.trim()) {
        context.font = '600 10px "Segoe UI", sans-serif';
        context.fillStyle = accent;
        context.fillText(kind, 30, 43);
        context.font = '12.5px "Segoe UI", sans-serif';
        context.fillStyle = dark ? '#c4cfdd' : '#5e6b7c';
        excerptLines(context, o.documentExcerpt).forEach((line, i) =>
          context.fillText(line, 30, 71 + i * 19),
        );
      } else {
        context.beginPath();
        context.moveTo(117, 100);
        context.lineTo(174, 100);
        context.lineTo(203, 129);
        context.lineTo(203, 223);
        context.lineTo(117, 223);
        context.closePath();
        context.fillStyle = dark ? '#303f52' : '#ffffff';
        context.fill();
        context.strokeStyle = dark ? '#607187' : '#cbd5e1';
        context.lineWidth = 1.5;
        context.stroke();
        context.beginPath();
        context.moveTo(174, 101);
        context.lineTo(174, 129);
        context.lineTo(202, 129);
        context.stroke();
        context.font = '600 19px "Segoe UI", sans-serif';
        context.fillStyle = accent;
        const badge = fitLine(context, kind, 72);
        context.fillText(badge, 160 - context.measureText(badge).width / 2, 169);
        context.strokeStyle = dark ? '#56677d' : '#dce3eb';
        context.beginPath();
        context.moveTo(133, 188);
        context.lineTo(187, 188);
        context.moveTo(133, 198);
        context.lineTo(171, 198);
        context.stroke();
      }
    }
    context.font = '600 13px "Segoe UI", sans-serif';
    context.fillStyle = ink;
    context.fillText(fitLine(context, (o.text || 'Document').replace(/\s+/g, ' '), 288), 16, 360);
    const metadata = [
      kind,
      fileSize(o.documentBytes),
      o.documentPageCount
        ? `${o.documentPageCount} ${o.documentPageCount === 1 ? 'page' : 'pages'}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    context.font = '11px "Segoe UI", sans-serif';
    context.fillStyle = muted;
    context.fillText(fitLine(context, metadata, 288), 16, 381);
    const texture = new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
    const body = new Sprite(texture);
    body.position.set(left, top);
    body.once('destroyed', () => texture.destroy(true));
    container.addChild(body);
  }
  if (preview) {
    const box = documentPreviewBox(o);
    const scale = Math.min(box.width / preview.width, box.height / preview.height);
    const page = new Sprite(preview);
    page.width = preview.width * scale;
    page.height = preview.height * scale;
    page.position.set(box.x + (box.width - page.width) / 2, box.y + (box.height - page.height) / 2);
    container.addChild(page);
  }
  return container;
}
