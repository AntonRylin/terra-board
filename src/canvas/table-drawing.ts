import type { CanvasObject, TableColumn } from '../model';
import { wrapListText } from './list-layout.ts';
import { cellLabel, tableColors, tableLayoutWidth, tablePadding, tableScale } from './table.ts';

// Draws a table card for exports, thumbnails and pins, at its layout size;
// on the board the card is HTML (src/components/CanvasTables.tsx).
export function drawTable(o: CanvasObject, resolution: number, dark = false): HTMLCanvasElement {
  const table = o.table || { columns: [], rows: [] };
  const scale = tableScale(o);
  const width = tableLayoutWidth(table.columns);
  const height = Math.max(1, o.height / scale);
  const pixels = Math.max(0.05, Math.min(resolution * scale, 8192 / width, 8192 / height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * pixels));
  canvas.height = Math.max(1, Math.ceil(height * pixels));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(pixels, pixels);
  const ink = dark ? '#e4ebf2' : '#29313b';
  const line = dark ? 'rgba(210,228,245,0.16)' : 'rgba(112,130,150,0.2)';
  const font = (size: number, weight = 400) => `${weight} ${size}px "Segoe UI", sans-serif`;

  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, width - 1, height - 1, 16);
  ctx.fillStyle = dark ? '#1f262e' : '#f4f7fa';
  ctx.fill();
  ctx.strokeStyle = dark ? '#3a4552' : '#d7e0e7';
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  ctx.font = font(16, 600);
  ctx.globalAlpha = o.text ? 1 : 0.4;
  ctx.fillText(
    clip(ctx, o.text || 'Untitled table', width - 2 * tablePadding - 8),
    tablePadding + 4,
    10 + 18,
  );
  ctx.globalAlpha = 1;

  let y = 10 + 36 + 6;
  const columnX = (index: number) =>
    tablePadding + table.columns.slice(0, index).reduce((sum, c) => sum + c.width, 0);
  const gridRight = columnX(table.columns.length);
  // Header.
  ctx.font = font(13, 600);
  ctx.globalAlpha = 0.75;
  table.columns.forEach((column, i) =>
    ctx.fillText(clip(ctx, column.name, column.width - 16), columnX(i) + 8, y + 17),
  );
  ctx.globalAlpha = 1;
  y += 34;
  const rule = (at: number) => {
    ctx.fillStyle = line;
    ctx.fillRect(tablePadding, at - 0.5, gridRight - tablePadding + 30, 1);
  };
  rule(y);

  ctx.font = font(14);
  const measure = (text: string) => ctx.measureText(text).width;
  for (const row of table.rows) {
    const lines = new Map<string, string[]>();
    let rowHeight = 38;
    for (const column of table.columns) {
      const value = row.cells[column.id];
      if (column.type !== 'text' || typeof value !== 'string') continue;
      const wrapped = wrapListText(value, column.width - 20, measure);
      lines.set(column.id, wrapped);
      rowHeight = Math.max(rowHeight, wrapped.length * 20 + 18);
    }
    if (y + rowHeight > height) break;
    table.columns.forEach((column, i) => {
      const x = columnX(i);
      const value = row.cells[column.id];
      if (i > 0) {
        ctx.fillStyle = line;
        ctx.fillRect(x - 0.5, y, 1, rowHeight);
      }
      drawCell(ctx, column, value, x, y, lines.get(column.id), ink, dark);
    });
    y += rowHeight;
    rule(y);
  }
  return canvas;
}

function clip(ctx: CanvasRenderingContext2D, text: string, width: number) {
  text = text.replace(/\s+/g, ' ');
  if (ctx.measureText(text).width <= width) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(text.slice(0, end) + '…').width > width) end--;
  return text.slice(0, end) + '…';
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  column: TableColumn,
  value: unknown,
  x: number,
  y: number,
  lines: string[] | undefined,
  ink: string,
  dark: boolean,
) {
  ctx.fillStyle = ink;
  ctx.font = '400 14px "Segoe UI", sans-serif';
  if (value === undefined) return;
  if (column.type === 'text' && lines) {
    lines.forEach((text, i) => ctx.fillText(text, x + 10, y + 19 + i * 20));
    return;
  }
  if (column.type === 'checkbox') {
    ctx.beginPath();
    ctx.roundRect(x + 10, y + 10, 18, 18, 5);
    ctx.fillStyle = '#4f8a6e';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 14, y + 19);
    ctx.lineTo(x + 18, y + 23);
    ctx.lineTo(x + 24, y + 15);
    ctx.stroke();
    ctx.lineWidth = 1;
    return;
  }
  if (column.type === 'progress' && typeof value === 'number') {
    const track = column.width - 20 - 44;
    ctx.fillStyle = 'rgba(112,130,150,0.2)';
    ctx.beginPath();
    ctx.roundRect(x + 10, y + 16, track, 6, 3);
    ctx.fill();
    ctx.fillStyle = '#4486d9';
    ctx.beginPath();
    ctx.roundRect(x + 10, y + 16, Math.max(0, (track * value) / 100), 6, 3);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.font = '400 12px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${value}%`, x + column.width - 10, y + 19);
    ctx.textAlign = 'left';
    return;
  }
  const label = cellLabel(column, value as never);
  if (column.type === 'select') {
    const option = column.options?.find((o) => o.id === value);
    if (!option) return;
    const [fill, text, darkFill, darkText] = tableColors[option.color] || tableColors.gray;
    ctx.font = '400 13px "Segoe UI", sans-serif';
    const shown = clip(ctx, label || 'Untitled', column.width - 32);
    const w = ctx.measureText(shown).width + 16;
    ctx.fillStyle = dark ? darkFill : fill;
    ctx.beginPath();
    ctx.roundRect(x + 8, y + 9, w, 22, 6);
    ctx.fill();
    ctx.fillStyle = dark ? darkText : text;
    ctx.fillText(shown, x + 16, y + 20);
    return;
  }
  const shown = clip(ctx, label, column.width - 20);
  if (column.type === 'number') {
    ctx.textAlign = 'right';
    ctx.fillText(shown, x + column.width - 10, y + 19);
    ctx.textAlign = 'left';
  } else ctx.fillText(shown, x + 10, y + 19);
}
