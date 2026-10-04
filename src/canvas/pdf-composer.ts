import { uid, type PdfComposer, type PdfComposerColumn, type PdfComposerSource } from '../model.ts';

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
    const rows = new Set<number>();
    const pages = column.pages.map((page: any, index: number) => {
      if (!page) throw Error('Invalid PDF composer page.');
      const row = page.row ?? index;
      if (!Number.isInteger(row) || row < 0 || row >= 1000 || rows.has(row))
        throw Error('Invalid or duplicate PDF page slot');
      rows.add(row);
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
        ...(column.pages.some((p: any) => p.row !== undefined) ? { row } : {}),
      };
    });
    const slotCount = column.slotCount;
    if (
      slotCount !== undefined &&
      (!Number.isInteger(slotCount) ||
        slotCount < 0 ||
        slotCount > 1000 ||
        [...rows].some((row) => row >= slotCount))
    )
      throw Error('Invalid PDF column slot count');
    pages.sort(
      (a: any, b: any) =>
        (a.row ?? column.pages.findIndex((p: any) => p.id === a.id)) -
        (b.row ?? column.pages.findIndex((p: any) => p.id === b.id)),
    );
    return { id, name: column.name, pages, ...(slotCount !== undefined ? { slotCount } : {}) };
  });
  if (value.view !== undefined && !['stacked', 'full'].includes(value.view))
    throw Error('Invalid PDF view');
  if (
    value.zoom !== undefined &&
    (!Number.isFinite(value.zoom) || value.zoom < 0.75 || value.zoom > 3)
  )
    throw Error('Invalid PDF zoom');
  return {
    sources,
    columns,
    ...(value.view !== undefined ? { view: value.view } : {}),
    ...(value.zoom !== undefined ? { zoom: value.zoom } : {}),
  };
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

export function composerSlotCount(column: PdfComposerColumn) {
  return Math.max(
    column.slotCount ?? 0,
    ...column.pages.map((page, index) => (page.row ?? index) + 1),
  );
}

/** Persist empty positions, including the last sheet removed from a column. */
function slotted(composer: PdfComposer) {
  const result = pdfComposerValue(composer);
  for (const column of result.columns) {
    column.slotCount = composerSlotCount(column);
    column.pages = column.pages.map((page, index) => ({ ...page, row: page.row ?? index }));
  }
  return result;
}

export function removePdfComposerPages(composer: PdfComposer, ids: string[]) {
  const result = slotted(composer),
    selected = new Set(ids);
  for (const column of result.columns)
    column.pages = column.pages.filter((page) => !selected.has(page.id));
  return result;
}

/** Place sheets into fixed slots. Occupied slots exchange papers with the vacated slots;
 * unrelated papers never move. Selection order follows the table, not click order. */
export function movePdfComposerPages(
  composer: PdfComposer,
  ids: string[],
  columnId: string,
  row: number,
): PdfComposer {
  if (!Number.isSafeInteger(row) || row < 0 || row >= 1000)
    throw Error('Invalid PDF composer destination index.');
  const result = slotted(composer),
    selected = new Set(ids);
  const to = result.columns.find((column) => column.id === columnId);
  if (!to) throw Error('The PDF composer destination column no longer exists.');
  const moving = result.columns.flatMap((column) =>
    column.pages
      .filter((page) => selected.has(page.id))
      .map((page) => ({ column, page, row: page.row! })),
  );
  if (!moving.length || moving.length !== selected.size)
    throw Error('The PDF composer page no longer exists.');
  if (row + moving.length > 1000) throw Error('A PDF column is limited to 1000 slots.');
  const targets = new Set(moving.map((_, index) => row + index));
  const displaced = to.pages.filter((page) => targets.has(page.row!) && !selected.has(page.id));
  const vacancies = moving.filter((item) => item.column !== to || !targets.has(item.row));
  for (const column of result.columns)
    column.pages = column.pages.filter(
      (page) => !selected.has(page.id) && !displaced.includes(page),
    );
  displaced.forEach((page, index) => {
    const vacant = vacancies[index];
    vacant.column.pages.push({ ...page, row: vacant.row });
  });
  moving.forEach((item, index) => to.pages.push({ ...item.page, row: row + index }));
  to.slotCount = Math.max(to.slotCount!, row + moving.length);
  for (const column of result.columns) column.pages.sort((a, b) => a.row! - b.row!);
  return result;
}

export function movePdfComposerPage(
  composer: PdfComposer,
  pageId: string,
  columnId: string,
  row: number,
) {
  return movePdfComposerPages(composer, [pageId], columnId, row);
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
