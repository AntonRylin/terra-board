import type {
  CanvasObject,
  TableCell,
  TableColumn,
  TableColumnType,
  TableData,
  TableOption,
  TableRow,
} from '../model';
import { localToWorld } from './transform.ts';

// A table ('table' object): typed columns and rows, laid out at a logical size
// and scaled to the object's rectangle. Its width follows the columns and its
// height the rows, so `scale` is always width / layout width.

export const tableColumnTypes: { type: TableColumnType; label: string }[] = [
  { type: 'text', label: 'Text' },
  { type: 'number', label: 'Number' },
  { type: 'select', label: 'Select' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'date', label: 'Date' },
  { type: 'progress', label: 'Progress' },
];
const types = new Set<string>(tableColumnTypes.map((t) => t.type));

// Option colors: light fill and ink, then night-mode fill and ink.
export const tableColors: Record<string, [string, string, string, string]> = {
  gray: ['#e9ecef', '#4b5560', '#3a4049', '#d5dbe2'],
  brown: ['#efe3da', '#6b4a36', '#4a3a30', '#e6cfbf'],
  orange: ['#fbe4cf', '#8a4b12', '#5a3b20', '#f5c79d'],
  yellow: ['#f8efc4', '#7a5d06', '#4f4520', '#efdc8f'],
  green: ['#dcefe2', '#2f6b45', '#24432f', '#a7dcb8'],
  blue: ['#dceaf7', '#28598a', '#233d57', '#a9cbef'],
  purple: ['#e9e1f5', '#5b3f8a', '#3a2f52', '#cdb9ef'],
  pink: ['#f6deea', '#8a3361', '#4f2a3e', '#f0b5d2'],
  red: ['#f8dcdc', '#9a2f2f', '#552a2a', '#f2b0b0'],
};
export const tableColorNames = Object.keys(tableColors);

export const tableLimits = { columns: 30, rows: 2000, options: 100, text: 10000, name: 120 };
export const tableColumnWidth = { min: 60, max: 1200 };
export const defaultColumnWidths: Record<TableColumnType, number> = {
  text: 200,
  number: 110,
  select: 140,
  checkbox: 80,
  date: 140,
  progress: 150,
};
// Card padding on each side, plus the column of row actions on the right.
export const tablePadding = 14;
export const tableRowActions = 30;
export const tableLayoutWidth = (columns: TableColumn[]) =>
  tablePadding * 2 + tableRowActions + columns.reduce((sum, column) => sum + column.width, 0);
export const tableScale = (o: Pick<CanvasObject, 'width' | 'table'>) =>
  o.width / tableLayoutWidth(o.table?.columns || []);

const idPattern = /^[\w-]{1,100}$/;
const text = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.slice(0, limit) : '';
export const isTableDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + 'T00:00:00Z'));

// The value a cell keeps in a column of this type, or undefined for empty.
// Used when loading, pasting and when a column changes type.
export function cellValue(column: TableColumn, value: unknown): TableCell | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  switch (column.type) {
    case 'text':
      return typeof value === 'string'
        ? value.slice(0, tableLimits.text)
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : undefined;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
      return Number.isFinite(n) && Math.abs(n) <= 1e15 ? n : undefined;
    }
    case 'progress': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[%\s]/g, ''));
      return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(100, n))) : undefined;
    }
    case 'checkbox':
      return value === true || value === 'true' || value === 1 ? true : undefined;
    case 'date':
      return isTableDate(value) ? value : undefined;
    case 'select': {
      const options = column.options || [];
      if (typeof value !== 'string') return undefined;
      return (
        options.find((o) => o.id === value)?.id ??
        options.find((o) => o.name.trim().toLowerCase() === value.trim().toLowerCase())?.id
      );
    }
  }
}

// Validates a stored or pasted table. Broken structure throws; cells that do
// not fit their column are dropped. electron/store.cjs keeps an equal copy.
export function tableValue(value: unknown): TableData {
  const input = value as { columns?: unknown; rows?: unknown } | null;
  if (
    !input ||
    typeof input !== 'object' ||
    !Array.isArray(input.columns) ||
    !Array.isArray(input.rows) ||
    input.columns.length < 1 ||
    input.columns.length > tableLimits.columns ||
    input.rows.length > tableLimits.rows
  )
    throw Error('Invalid table');
  const columns: TableColumn[] = input.columns.map((raw: any) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.id !== 'string' ||
      !idPattern.test(raw.id) ||
      !types.has(raw.type) ||
      (raw.name !== undefined && typeof raw.name !== 'string')
    )
      throw Error('Invalid table column');
    const width = Number.isFinite(raw.width)
      ? raw.width
      : defaultColumnWidths[raw.type as TableColumnType];
    const column: TableColumn = {
      id: raw.id,
      name: text(raw.name, tableLimits.name),
      type: raw.type,
      width: Math.max(tableColumnWidth.min, Math.min(tableColumnWidth.max, width)),
    };
    if (raw.type === 'select') {
      const options = Array.isArray(raw.options) ? raw.options : [];
      if (options.length > tableLimits.options) throw Error('Too many table options');
      const seen = new Set<string>();
      column.options = options.flatMap((option: any): TableOption[] => {
        if (
          !option ||
          typeof option.id !== 'string' ||
          !idPattern.test(option.id) ||
          seen.has(option.id)
        )
          return [];
        seen.add(option.id);
        return [
          {
            id: option.id,
            name: text(option.name, tableLimits.name),
            color: tableColorNames.includes(option.color) ? option.color : 'gray',
          },
        ];
      });
    }
    return column;
  });
  if (new Set(columns.map((c) => c.id)).size !== columns.length)
    throw Error('Duplicate table column');
  const rows: TableRow[] = input.rows.map((raw: any) => {
    if (!raw || typeof raw.id !== 'string' || !idPattern.test(raw.id))
      throw Error('Invalid table row');
    const cells: Record<string, TableCell> = {};
    const source = raw.cells && typeof raw.cells === 'object' ? raw.cells : {};
    for (const column of columns) {
      if (!Object.prototype.hasOwnProperty.call(source, column.id)) continue;
      const cell = cellValue(column, source[column.id]);
      if (cell !== undefined) cells[column.id] = cell;
    }
    return { id: raw.id, cells };
  });
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw Error('Duplicate table row');
  return { columns, rows };
}

// Words a search can find: column and option names and every cell.
export function tableText(table: TableData | undefined): string {
  if (!table) return '';
  const parts: string[] = [];
  for (const column of table.columns) parts.push(column.name);
  for (const row of table.rows)
    for (const column of table.columns) {
      const value = row.cells[column.id];
      if (value !== undefined && value !== false) parts.push(cellLabel(column, value));
    }
  return parts.filter(Boolean).join(' ');
}

export function formatTableDate(value: string) {
  const date = new Date(value + 'T00:00:00');
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Plain text for a cell, as exports and search show it.
export function cellLabel(column: TableColumn, value: TableCell | undefined): string {
  if (value === undefined) return '';
  switch (column.type) {
    case 'select':
      return column.options?.find((o) => o.id === value)?.name || '';
    case 'checkbox':
      return value ? '✓' : '';
    case 'progress':
      return `${value}%`;
    case 'date':
      return formatTableDate(String(value));
    case 'number':
      return typeof value === 'number' ? value.toLocaleString() : String(value);
    default:
      return String(value);
  }
}

// Changes the table and keeps the scale and the top-left corner where they are.
export function withTable(o: CanvasObject, table: TableData): CanvasObject {
  const scale = tableScale(o);
  const resized = { ...o, table, width: Math.min(1e6, tableLayoutWidth(table.columns) * scale) };
  if (o.rotation) {
    const before = localToWorld(o, { x: 0, y: 0 });
    const after = localToWorld(resized, { x: 0, y: 0 });
    resized.x += before.x - after.x;
    resized.y += before.y - after.y;
  }
  return resized;
}

// Fits the object's height to its rows, measured at scale 1. Null when it fits.
export function fitTableHeight(o: CanvasObject, layoutHeight: number): CanvasObject | null {
  const height = Math.min(1e6, Math.max(1, layoutHeight * tableScale(o)));
  if (Math.abs(height - o.height) < 0.5) return null;
  const resized = { ...o, height };
  if (o.rotation) {
    const before = localToWorld(o, { x: 0, y: 0 });
    const after = localToWorld(resized, { x: 0, y: 0 });
    resized.x += before.x - after.x;
    resized.y += before.y - after.y;
  }
  return resized;
}

export const newTableColumn = (
  id: string,
  type: TableColumnType,
  name: string,
  options?: TableOption[],
): TableColumn => ({
  id,
  name,
  type,
  width: defaultColumnWidths[type],
  ...(type === 'select' ? { options: options || [] } : {}),
});

// What a new table starts with.
export function starterTable(id: () => string): TableData {
  const status = newTableColumn(id(), 'select', 'Status', [
    { id: id(), name: 'To do', color: 'gray' },
    { id: id(), name: 'In progress', color: 'blue' },
    { id: id(), name: 'Done', color: 'green' },
  ]);
  return {
    columns: [newTableColumn(id(), 'text', 'Name'), status, newTableColumn(id(), 'date', 'Date')],
    rows: [
      { id: id(), cells: {} },
      { id: id(), cells: {} },
      { id: id(), cells: {} },
    ],
  };
}

// Header and title heights at scale 1, for a new table's first rectangle;
// the card measures itself afterwards.
export const estimatedTableHeight = (rows: number) => 64 + 38 + rows * 38 + 40 + tablePadding;
