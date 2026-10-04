import { composerSlotCount } from './pdf-composer';
import type { CanvasObject } from '../model';
import { ComposerPreviewPool } from './pdf-composer-files';
import { renderPdfSheet } from './pdf-render';

/** A bounded board-export snapshot; column PDF exports retain the original vectors. */
export async function composerSnapshot(object: CanvasObject, requestedScale: number) {
  const composer = object.pdfComposer!;
  const zoom = composer.zoom ?? 1,
    width = 162 * zoom,
    height = 234 * zoom;
  const pitch = (composer.view === 'full' ? 248 : 76) * zoom;
  const scale = Math.min(
    requestedScale,
    4096 / object.width,
    4096 / object.height,
    Math.sqrt(8_000_000 / object.width / object.height),
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(object.width * scale));
  canvas.height = Math.max(1, Math.ceil(object.height * scale));
  const context = canvas.getContext('2d')!;
  context.scale(scale, scale);
  context.fillStyle = '#f4f7fa';
  context.fillRect(0, 0, object.width, object.height);
  context.fillStyle = '#344456';
  context.font = '13px system-ui';
  context.fillText(object.text || 'PDF workspace', 18, 25, object.width - 36);
  const pool = new ComposerPreviewPool();
  const sources = new Map(composer.sources.map((source) => [source.id, source]));
  try {
    for (let index = 0; index < composer.columns.length; index++) {
      const column = composer.columns[index],
        x = 29 + index * (width + 44);
      if (x >= object.width) break;
      context.fillStyle = '#344456';
      context.font = '12px system-ui';
      context.fillText(column.name, x, 73, 162);
      context.font = '10px system-ui';
      context.fillText(`${column.pages.length} pages`, x, 94, 162);
      const leases = new Map<string, Awaited<ReturnType<ComposerPreviewPool['acquire']>>>();
      try {
        for (let row = 0; row < composerSlotCount(column); row++) {
          const page = column.pages.find((item, index) => (item.row ?? index) === row),
            y = 113 + row * pitch;
          if (y >= object.height) break;
          if (!page) {
            context.strokeStyle = '#dce3eb';
            context.setLineDash([3, 4]);
            context.strokeRect(x, y, width, height);
            context.setLineDash([]);
            continue;
          }
          context.fillStyle = '#ffffff';
          context.fillRect(x, y, width, height);
          const source = sources.get(page.sourceId);
          const sheet = document.createElement('canvas');
          try {
            if (!source) throw Error('Source unavailable');
            if (!leases.has(source.id)) leases.set(source.id, await pool.acquire(source));
            await renderPdfSheet(
              leases.get(source.id)!.pdf,
              page,
              sheet,
              Math.max(1, (width - 12) * scale),
              undefined,
              2_000_000,
            );
            const fit = Math.min((width - 12) / sheet.width, (height - 24) / sheet.height);
            context.drawImage(
              sheet,
              x + (width - sheet.width * fit) / 2,
              y + 18,
              sheet.width * fit,
              sheet.height * fit,
            );
          } catch {
            context.fillStyle = '#64748b';
            context.font = '11px system-ui';
            context.fillText('Preview unavailable', x + 12, y + 28, 168);
          } finally {
            sheet.width = sheet.height = 1;
          }
          context.strokeStyle = '#dce3eb';
          context.lineWidth = 1;
          context.strokeRect(x, y, width, height);
          context.fillStyle = '#607084';
          context.font = '10px system-ui';
          context.fillText(String(row + 1), x + 8, y + 13);
        }
      } finally {
        for (const lease of leases.values()) lease.release();
      }
    }
    return canvas;
  } finally {
    await pool.dispose();
  }
}
