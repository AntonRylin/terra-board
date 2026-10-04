// Small, deterministic, offline document fixtures shared by document checks.
import { zipSync, strToU8 } from 'fflate';

export const originalDocumentText =
  'Terra notes — café, 日本語, українська, 🚀\nSecond line with <plain text> & symbols.\n';
export const editedDocumentText =
  'Updated notes — café, 日本語, 🚀\nSaved from the on-board document reader.\n';
export const shortcutDocumentUrl = 'https://docs.google.com/document/d/terra-offline-fixture/edit';

export function twoPagePdf() {
  const streams = [
    '0.90 0.17 0.23 rg 36 620 540 100 re f\n0 0 0 rg BT /F1 24 Tf 50 570 Td (Terra PDF page one) Tj ET\n',
    '0.13 0.36 0.83 rg 36 620 540 100 re f\n0 0 0 rg BT /F1 24 Tf 50 570 Td (Terra PDF page two) Tj ET\n',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(streams[0])} >>\nstream\n${streams[0]}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(streams[1])} >>\nstream\n${streams[1]}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function simpleDocx() {
  return Buffer.from(
    zipSync(
      {
        '[Content_Types].xml': strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        '_rels/.rels': strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        ),
        'word/document.xml': strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>Terra DOCX fixture</w:t></w:r></w:p><w:p><w:r><w:t>Offline Word preview — café, 日本語, українська.</w:t></w:r></w:p><w:p><w:r><w:t>Original formatting and downloadable bytes.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>',
        ),
      },
      { level: 0, mtime: new Date('2020-01-01T00:00:00Z') },
    ),
  );
}

export function documentFixtures() {
  return [
    {
      key: 'text',
      name: 'Überblick 日本語.txt',
      kind: 'text',
      bytes: Buffer.from(originalDocumentText),
    },
    { key: 'pdf', name: 'Two page reference.pdf', kind: 'pdf', bytes: twoPagePdf() },
    {
      key: 'malformed',
      name: 'Damaged reference.pdf',
      kind: 'pdf',
      bytes: Buffer.from('%PDF-1.7\nDamaged content with no catalog, pages, or trailer.\n'),
    },
    { key: 'docx', name: 'Word reference.docx', kind: 'docx', bytes: simpleDocx() },
    { key: 'empty', name: 'Empty notes.txt', kind: 'text', bytes: Buffer.alloc(0) },
    {
      key: 'xlsx',
      name: 'Budget attachment.xlsx',
      kind: 'file',
      bytes: Buffer.from('Excel attachment fixture\0\x01\xff', 'latin1'),
    },
    {
      key: 'gdoc',
      name: 'Shared draft.gdoc',
      kind: 'file',
      bytes: Buffer.from(
        JSON.stringify({ url: shortcutDocumentUrl, doc_id: 'terra-offline-fixture' }),
      ),
    },
    {
      key: 'binary',
      name: 'Archive bundle.bin',
      kind: 'file',
      bytes: Buffer.from([0, 255, 1, 128, 13, 10, 42, 0, 200]),
    },
  ];
}
