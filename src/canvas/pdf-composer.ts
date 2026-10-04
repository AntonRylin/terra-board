import { uid, type PdfComposer, type PdfComposerSource } from '../model.ts';

const LIMIT = 500;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const validName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 100000;

function sourceValue(value: any): PdfComposerSource {
  if (
    !value ||
    !validId(value.id) ||
    typeof value.assetId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.assetId) ||
    !validName(value.name) ||
    !['pdf', 'image'].includes(value.kind) ||
    !Number.isInteger(value.pageCount) ||
    value.pageCount < 1 ||
    value.pageCount > LIMIT
  )
    throw Error('Invalid PDF composer source; files need an asset and 1–500 pages.');
  return {
    id: value.id,
    assetId: value.assetId,
    name: value.name,
    kind: value.kind,
    pageCount: value.pageCount,
  };
}

/** Validate and deep-copy only saved metadata; runtime buffers are never retained. */
export function pdfComposerValue(input: unknown): PdfComposer {
  const value = input as any;
  if (!value || !Array.isArray(value.sources) || !Array.isArray(value.columns))
    throw Error('Invalid PDF composer sources or columns.');
  if (value.sources.length > LIMIT || value.columns.length > LIMIT)
    throw Error('A PDF composer is limited to 500 sources and 500 columns.');
  const ids = new Set<string>();
  const claim = (id: unknown) => {
    if (!validId(id) || ids.has(id))
      throw Error('PDF composer identifiers must be valid and unique.');
    ids.add(id);
    return id;
  };
  const sources = value.sources.map((source: unknown) => {
    const result = sourceValue(source);
    claim(result.id);
    return result;
  }) as PdfComposerSource[];
  const byId = new Map(sources.map((source) => [source.id, source]));
  let count = 0;
  const columns = value.columns.map((column: any) => {
    if (!column || !validName(column.name) || !Array.isArray(column.pages))
      throw Error('Invalid PDF composer column.');
    const id = claim(column.id);
    count += column.pages.length;
    if (count > LIMIT) throw Error('A PDF composer is limited to 500 page references.');
    const pages = column.pages.map((page: any) => {
      if (!page) throw Error('Invalid PDF composer page.');
      const pageId = claim(page.id);
      const source = byId.get(page.sourceId);
      if (
        !source ||
        !Number.isInteger(page.pageIndex) ||
        page.pageIndex < 0 ||
        page.pageIndex >= source.pageCount
      )
        throw Error('A PDF composer page must reference an existing source page.');
      if (!Number.isSafeInteger(page.rotation) || page.rotation % 90 !== 0)
        throw Error('PDF composer page rotation must use whole 90-degree turns.');
      return {
        id: pageId,
        sourceId: source.id,
        pageIndex: page.pageIndex,
        rotation: page.rotation,
      };
    });
    return { id, name: column.name, pages };
  });
  return { sources, columns };
}

function allIds(composer: PdfComposer) {
  return new Set([
    ...composer.sources.map((source) => source.id),
    ...composer.columns.flatMap((column) => [column.id, ...column.pages.map((page) => page.id)]),
  ]);
}

function nextId(ids: Set<string>) {
  let id = uid();
  while (ids.has(id)) id = uid();
  ids.add(id);
  return id;
}

export function createPdfComposer(sources: PdfComposerSource[]): PdfComposer {
  return appendPdfComposer({ sources: [], columns: [] }, sources);
}

/** Each descriptor adds a separate source/column, even when its asset was already added. */
export function appendPdfComposer(
  composer: PdfComposer,
  sources: PdfComposerSource[],
): PdfComposer {
  const result = pdfComposerValue(composer);
  if (!Array.isArray(sources)) throw Error('Invalid PDF composer sources.');
  if (
    result.sources.length + sources.length > LIMIT ||
    result.columns.length + sources.length > LIMIT
  )
    throw Error('A PDF composer is limited to 500 sources and 500 columns.');
  const incoming = sources.map(sourceValue);
  const total =
    result.columns.reduce((n, column) => n + column.pages.length, 0) +
    incoming.reduce((n, source) => n + source.pageCount, 0);
  if (total > LIMIT) throw Error('A PDF composer is limited to 500 page references.');
  const ids = allIds(result);
  for (const source of incoming) {
    if (ids.has(source.id)) source.id = nextId(ids);
    else ids.add(source.id);
    result.sources.push(source);
    result.columns.push({
      id: nextId(ids),
      name: source.name,
      pages: Array.from({ length: source.pageCount }, (_, pageIndex) => ({
        id: nextId(ids),
        sourceId: source.id,
        pageIndex,
        rotation: 0,
      })),
    });
  }
  return result;
}

function finalIndex(index: number, length: number) {
  if (!Number.isSafeInteger(index)) throw Error('Invalid PDF composer destination index.');
  return Math.max(0, Math.min(length, index));
}

/** toIndex is the final index after removing the page, also for same-column moves. */
export function movePdfComposerPage(
  composer: PdfComposer,
  pageId: string,
  columnId: string,
  toIndex: number,
): PdfComposer {
  const result = pdfComposerValue(composer);
  const from = result.columns.find((column) => column.pages.some((page) => page.id === pageId));
  const to = result.columns.find((column) => column.id === columnId);
  if (!from) throw Error('The PDF composer page no longer exists.');
  if (!to) throw Error('The PDF composer destination column no longer exists.');
  const [page] = from.pages.splice(
    from.pages.findIndex((page) => page.id === pageId),
    1,
  );
  to.pages.splice(finalIndex(toIndex, to.pages.length), 0, page);
  return result;
}

/** toIndex is the column's final index after removing it from its old position. */
export function movePdfComposerColumn(
  composer: PdfComposer,
  columnId: string,
  toIndex: number,
): PdfComposer {
  const result = pdfComposerValue(composer);
  const from = result.columns.findIndex((column) => column.id === columnId);
  if (from < 0) throw Error('The PDF composer column no longer exists.');
  const [column] = result.columns.splice(from, 1);
  result.columns.splice(finalIndex(toIndex, result.columns.length), 0, column);
  return result;
}

export function addPdfComposerColumn(composer: PdfComposer, name = 'New PDF'): PdfComposer {
  const result = pdfComposerValue(composer);
  if (result.columns.length >= LIMIT) throw Error('A PDF composer is limited to 500 columns.');
  if (!validName(name)) throw Error('Invalid PDF composer column name.');
  result.columns.push({ id: nextId(allIds(result)), name, pages: [] });
  return result;
}
