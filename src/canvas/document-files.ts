import type { CanvasObject } from '../model';

export function withDocumentTitle(
  current: CanvasObject,
  draft: CanvasObject,
  title: string,
): CanvasObject {
  return {
    ...current,
    documentTitle: title.trim(),
    bold: draft.bold,
    strikethrough: draft.strikethrough,
    color: draft.color,
    fontSize: draft.fontSize,
  };
}

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

export function documentKind(name: string, mime = ''): 'pdf' | 'docx' | 'text' | 'file' {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (
    ext === 'docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return 'docx';
  if (
    ['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml'].includes(
      ext || '',
    ) ||
    mime.startsWith('text/')
  )
    return 'text';
  return 'file';
}

export interface DecodedText {
  text: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  bom: boolean;
  newline: '\r\n' | '\n' | '\r';
}

export function decodeDocumentText(bytes: Uint8Array): DecodedText {
  if (bytes.length > MAX_TEXT_BYTES)
    throw Error('Text preview and editing are limited to 2 MB. You can still download this file.');
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  const bom = encoding !== 'utf-8' || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw Error(
      'This text encoding is not supported. Use UTF-8 or UTF-16, or download the original file.',
    );
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text))
    throw Error('This file contains binary data and cannot be edited as text.');
  const newline = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
  return { text: text.replace(/\r\n?/g, '\n'), encoding, bom, newline };
}

export function encodeDocumentText(
  text: string,
  format: Omit<DecodedText, 'text'>,
): Uint8Array<ArrayBuffer> {
  text = text.replace(/\r\n?/g, '\n').replace(/\n/g, format.newline);
  if (format.bom) text = '\ufeff' + text;
  let bytes: Uint8Array<ArrayBuffer>;
  if (format.encoding === 'utf-8') bytes = new TextEncoder().encode(text);
  else {
    bytes = new Uint8Array(text.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < text.length; i++)
      view.setUint16(i * 2, text.charCodeAt(i), format.encoding === 'utf-16le');
  }
  if (bytes.length > MAX_TEXT_BYTES)
    throw Error('Text editing is limited to 2 MB. Shorten the text before saving.');
  return bytes;
}
