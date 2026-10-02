export type ExportFormat = 'png' | 'jpg' | 'pdf';

/** A single raster page at 96 dpi, with byte-accurate PDF stream/xref offsets. */
export function imagePdf(jpeg: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets = [0];
  let length = 0;
  const append = (data: string | Uint8Array) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, content: string) => {
    offsets[id] = length;
    append(`${id} 0 obj\n${content}\nendobj\n`);
  };
  const w = width * 0.75,
    h = height * 0.75;
  append('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Image 4 0 R >> >> /Contents 5 0 R >>`,
  );
  offsets[4] = length;
  append(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  append(jpeg);
  append('\nendstream\nendobj\n');
  const commands = `q\n${w} 0 0 ${h} 0 0 cm\n/Image Do\nQ\n`;
  object(5, `<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}endstream`);
  const xref = length;
  append('xref\n0 6\n0000000000 65535 f \n');
  for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const result = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
}

export async function encodeExport(canvas: HTMLCanvasElement, format: ExportFormat) {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(Error('Could not encode the export.'))),
      format === 'png' ? 'image/png' : 'image/jpeg',
      0.95,
    ),
  );
  return format === 'pdf'
    ? new Blob([imagePdf(new Uint8Array(await blob.arrayBuffer()), canvas.width, canvas.height)], {
        type: 'application/pdf',
      })
    : blob;
}
