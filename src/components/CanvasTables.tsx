import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  CircleChevronDown,
  Hash,
  Percent,
  Plus,
  SquareCheck,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import type {
  Camera,
  CanvasObject,
  TableCell,
  TableColumn,
  TableColumnType,
  TableData,
  TableOption,
  TableRow,
} from '../model';
import { uid } from '../model';
import { localToWorld } from '../canvas/transform';
import {
  cellValue,
  formatTableDate,
  newTableColumn,
  tableColorNames,
  tableColors,
  tableColumnTypes,
  tableColumnWidth,
  tableLayoutWidth,
  tableLimits,
  tableScale,
  withTable,
} from '../canvas/table';
import ListEditOutline from './ListEditOutline';
import './canvas-tables.css';
import { forwardWheel } from './forward-wheel';

export interface TableView {
  objects: CanvasObject[];
  camera: Camera;
}

const typeIcons: Record<TableColumnType, typeof Type> = {
  text: Type,
  number: Hash,
  select: CircleChevronDown,
  checkbox: SquareCheck,
  date: Calendar,
  progress: Percent,
};

const pillStyle = (option: TableOption) => {
  const [fill, ink, darkFill, darkInk] = tableColors[option.color] || tableColors.gray;
  return {
    '--pill-fill': fill,
    '--pill-ink': ink,
    '--pill-dark-fill': darkFill,
    '--pill-dark-ink': darkInk,
  } as CSSProperties;
};

function Pill({ option }: { option: TableOption }) {
  return (
    <span className="ct-pill" style={pillStyle(option)}>
      {option.name || 'Untitled'}
    </span>
  );
}

// A number typed freely, saved when the field is left or Enter is pressed.
function NumberField({
  value,
  label,
  onCommit,
  onKeyDown,
  register,
}: {
  value: TableCell | undefined;
  label: string;
  onCommit: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  register: (element: HTMLElement | null) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  return (
    <input
      ref={register}
      className="ct-input ct-number"
      aria-label={label}
      inputMode="decimal"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(draft);
        onKeyDown(event);
      }}
    />
  );
}

type Popup =
  { kind: 'column'; columnId: string } | { kind: 'select'; rowId: string; columnId: string };

export function TableCard({
  object: o,
  camera,
  update,
  fit,
  select,
  forward,
  active,
  editing,
  setEditing,
}: {
  object: CanvasObject;
  camera: Camera;
  update: (o: CanvasObject) => void;
  fit: (o: CanvasObject, layoutHeight: number) => void;
  select: (id: string) => void;
  forward: (event: PointerEvent) => void;
  active: boolean;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  const table: TableData = o.table || { columns: [], rows: [] };
  const card = useRef<HTMLElement>(null);
  const fields = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<string | null>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [query, setQuery] = useState('');
  // Column width while its edge is dragged; saved once on release.
  const [dragWidth, setDragWidth] = useState<{ id: string; width: number } | null>(null);
  const columns = table.columns.map((column) =>
    dragWidth?.id === column.id ? { ...column, width: dragWidth.width } : column,
  );
  const scale = tableScale(o);
  const layoutWidth = tableLayoutWidth(columns);

  useLayoutEffect(() => {
    const element = card.current;
    if (element && !o.locked) fit(o, element.offsetHeight);
  });
  useLayoutEffect(() => {
    if (!editing) setPopup(null);
  }, [editing]);
  useLayoutEffect(() => {
    if (!active && editing) setEditing(false);
  }, [active, editing]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const field = fields.current.get(pendingFocus.current);
    if (field) {
      field.focus();
      if (field instanceof HTMLTextAreaElement)
        field.setSelectionRange(field.value.length, field.value.length);
      pendingFocus.current = null;
    }
  });
  useEffect(() => {
    if (!popup) return;
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.ct-popup, .ct-popup-anchor')) setPopup(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [popup]);

  const change = (next: TableData) => update(withTable(o, next));
  const changeColumn = (id: string, patch: (column: TableColumn) => TableColumn) =>
    change({ ...table, columns: table.columns.map((c) => (c.id === id ? patch(c) : c)) });
  const setCell = (rowId: string, column: TableColumn, value: unknown) => {
    const cell = cellValue(column, value);
    change({
      ...table,
      rows: table.rows.map((row) => {
        if (row.id !== rowId) return row;
        const cells = { ...row.cells };
        if (cell === undefined) delete cells[column.id];
        else cells[column.id] = cell;
        return { ...row, cells };
      }),
    });
  };
  const focus = (rowId: string, columnId: string) => {
    pendingFocus.current = `${rowId}:${columnId}`;
  };
  const addRow = (after = table.rows.length - 1, columnId?: string) => {
    if (table.rows.length >= tableLimits.rows) return;
    const row: TableRow = { id: uid(), cells: {} };
    const rows = [...table.rows];
    rows.splice(after + 1, 0, row);
    change({ ...table, rows });
    const target =
      columnId ?? table.columns.find((c) => c.type === 'text' || c.type === 'number')?.id;
    if (target) focus(row.id, target);
  };
  const removeRow = (id: string) =>
    change({ ...table, rows: table.rows.filter((row) => row.id !== id) });
  const addColumn = () => {
    if (table.columns.length >= tableLimits.columns) return;
    const column = newTableColumn(uid(), 'text', `Column ${table.columns.length + 1}`);
    change({ ...table, columns: [...table.columns, column] });
    setPopup({ kind: 'column', columnId: column.id });
  };
  const setType = (column: TableColumn, type: TableColumnType) => {
    if (column.type === type) return;
    const options =
      type === 'select'
        ? column.options ||
          // Turning text into a select makes an option for each distinct value.
          [
            ...new Set(
              table.rows
                .map((row) => row.cells[column.id])
                .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
                .map((v) => String(v).trim())
                .filter(Boolean),
            ),
          ]
            .slice(0, tableLimits.options)
            .map((name, i) => ({
              id: uid(),
              name: name.slice(0, tableLimits.name),
              color: tableColorNames[(i + 1) % tableColorNames.length],
            }))
        : undefined;
    const next: TableColumn = {
      ...column,
      type,
      ...(options ? { options } : {}),
    };
    if (type !== 'select') delete next.options;
    // Values that read the same in the new type are kept.
    const readable = (value: TableCell) =>
      column.type === 'select'
        ? column.options?.find((option) => option.id === value)?.name
        : value;
    change({
      columns: table.columns.map((c) => (c.id === column.id ? next : c)),
      rows: table.rows.map((row) => {
        const cells = { ...row.cells };
        const value = cells[column.id];
        delete cells[column.id];
        const converted = value === undefined ? undefined : cellValue(next, readable(value));
        if (converted !== undefined) cells[column.id] = converted;
        return { ...row, cells };
      }),
    });
  };
  const moveColumn = (id: string, by: number) => {
    const index = table.columns.findIndex((c) => c.id === id);
    const target = index + by;
    if (index < 0 || target < 0 || target >= table.columns.length) return;
    const next = [...table.columns];
    const [column] = next.splice(index, 1);
    next.splice(target, 0, column);
    change({ ...table, columns: next });
  };
  const removeColumn = (id: string) => {
    if (table.columns.length <= 1) return;
    setPopup(null);
    change({
      columns: table.columns.filter((c) => c.id !== id),
      rows: table.rows.map((row) => {
        const cells = { ...row.cells };
        delete cells[id];
        return { ...row, cells };
      }),
    });
  };
  const addOption = (column: TableColumn, name: string): TableOption | null => {
    const options = column.options || [];
    if (options.length >= tableLimits.options || !name.trim()) return null;
    const option = {
      id: uid(),
      name: name.trim().slice(0, tableLimits.name),
      color: tableColorNames[options.length % tableColorNames.length],
    };
    return option;
  };

  // Enter moves down a row (adding one at the end); Escape leaves editing.
  const cellKeys =
    (rowIndex: number, column: TableColumn) => (event: KeyboardEvent<HTMLElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        (event.currentTarget as HTMLElement).blur();
        setEditing(false);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const next = table.rows[rowIndex + 1];
        if (next) {
          const field = fields.current.get(`${next.id}:${column.id}`);
          if (field) field.focus();
        } else addRow(rowIndex, column.id);
      }
    };

  const renderCell = (row: TableRow, rowIndex: number, column: TableColumn) => {
    const value = row.cells[column.id];
    const key = `${row.id}:${column.id}`;
    const label = `${column.name || 'Column'}, row ${rowIndex + 1}`;
    const register = (element: HTMLElement | null) => {
      if (element) fields.current.set(key, element);
      else fields.current.delete(key);
    };
    const stop = (event: PointerEvent) => {
      if (event.button === 0) event.stopPropagation();
    };
    switch (column.type) {
      case 'checkbox':
        return (
          <button
            className="ct-check"
            role="checkbox"
            aria-checked={value === true}
            aria-label={label}
            onPointerDown={stop}
            onClick={() => setCell(row.id, column, value === true ? undefined : true)}
          >
            {value === true && <Check size={13} strokeWidth={2.4} />}
          </button>
        );
      case 'select': {
        const option = column.options?.find((o) => o.id === value);
        const open =
          popup?.kind === 'select' && popup.rowId === row.id && popup.columnId === column.id;
        return (
          <>
            <button
              className="ct-select ct-popup-anchor"
              aria-label={label}
              aria-expanded={open}
              ref={register}
              onPointerDown={stop}
              onClick={() => {
                select(o.id);
                setQuery('');
                setPopup(open ? null : { kind: 'select', rowId: row.id, columnId: column.id });
              }}
            >
              {option ? <Pill option={option} /> : <span className="ct-empty" />}
            </button>
            {open && (
              <div className="ct-popup ct-options" role="listbox" aria-label={column.name}>
                <input
                  className="ct-popup-input"
                  autoFocus
                  placeholder="Find or add an option"
                  value={query}
                  maxLength={tableLimits.name}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Escape') setPopup(null);
                    if (event.key !== 'Enter') return;
                    const match = (column.options || []).find(
                      (o) => o.name.toLowerCase() === query.trim().toLowerCase(),
                    );
                    if (match) {
                      setCell(row.id, column, match.id);
                      setPopup(null);
                      return;
                    }
                    const created = addOption(column, query);
                    if (!created) return;
                    const next = { ...column, options: [...(column.options || []), created] };
                    change({
                      columns: table.columns.map((c) => (c.id === column.id ? next : c)),
                      rows: table.rows.map((r) =>
                        r.id === row.id
                          ? { ...r, cells: { ...r.cells, [column.id]: created.id } }
                          : r,
                      ),
                    });
                    setPopup(null);
                  }}
                />
                {(column.options || [])
                  .filter((o) => o.name.toLowerCase().includes(query.trim().toLowerCase()))
                  .map((choice) => (
                    <button
                      key={choice.id}
                      role="option"
                      aria-selected={choice.id === value}
                      className="ct-option"
                      onClick={() => {
                        setCell(row.id, column, choice.id);
                        setPopup(null);
                      }}
                    >
                      <Pill option={choice} />
                      {choice.id === value && <Check size={14} />}
                    </button>
                  ))}
                {query.trim() &&
                  !(column.options || []).some(
                    (o) => o.name.toLowerCase() === query.trim().toLowerCase(),
                  ) && <div className="ct-popup-hint">Enter adds “{query.trim()}”</div>}
                {value !== undefined && (
                  <button
                    className="ct-option ct-clear"
                    onClick={() => {
                      setCell(row.id, column, undefined);
                      setPopup(null);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </>
        );
      }
      case 'progress': {
        const percent = typeof value === 'number' ? value : 0;
        return (
          <div className="ct-progress" data-empty={value === undefined}>
            <div className="ct-progress-track">
              <div className="ct-progress-fill" style={{ width: `${percent}%` }} />
              {editing && (
                <input
                  ref={register}
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  aria-label={label}
                  value={percent}
                  onPointerDown={stop}
                  onChange={(event) =>
                    setCell(row.id, column, Number(event.target.value) || undefined)
                  }
                />
              )}
            </div>
            <span className="ct-progress-label">{value === undefined ? '' : `${percent}%`}</span>
          </div>
        );
      }
      default:
        break;
    }
    if (!editing) {
      if (column.type === 'date')
        return <div className="ct-text">{value ? formatTableDate(String(value)) : ''}</div>;
      if (column.type === 'number')
        return (
          <div className="ct-text ct-number">
            {typeof value === 'number' ? value.toLocaleString() : ''}
          </div>
        );
      return <div className="ct-text">{value === undefined ? '' : String(value)}</div>;
    }
    if (column.type === 'date')
      return (
        <input
          ref={register}
          type="date"
          required
          className="ct-input ct-date"
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => setCell(row.id, column, event.target.value)}
          onKeyDown={cellKeys(rowIndex, column)}
        />
      );
    if (column.type === 'number')
      return (
        <NumberField
          value={value}
          label={label}
          register={register}
          onCommit={(draft) => {
            const next = cellValue(column, draft.trim());
            if (next !== value) setCell(row.id, column, draft.trim());
          }}
          onKeyDown={cellKeys(rowIndex, column)}
        />
      );
    return (
      <textarea
        ref={register}
        className="ct-input"
        aria-label={label}
        rows={1}
        maxLength={tableLimits.text}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => setCell(row.id, column, event.target.value)}
        onKeyDown={cellKeys(rowIndex, column)}
      />
    );
  };

  const columnMenu = (column: TableColumn, index: number) => (
    <div className="ct-popup ct-column-menu" role="dialog" aria-label={`${column.name} column`}>
      <input
        className="ct-popup-input"
        aria-label="Column name"
        autoFocus
        value={column.name}
        maxLength={tableLimits.name}
        onChange={(event) => changeColumn(column.id, (c) => ({ ...c, name: event.target.value }))}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' || event.key === 'Escape') setPopup(null);
        }}
      />
      <div className="ct-menu-label">Type</div>
      <div className="ct-types" role="radiogroup" aria-label="Column type">
        {tableColumnTypes.map(({ type, label }) => {
          const Icon = typeIcons[type];
          return (
            <button
              key={type}
              role="radio"
              aria-checked={column.type === type}
              className="ct-type"
              onClick={() => setType(column, type)}
            >
              <Icon size={14} />
              {label}
            </button>
          );
        })}
      </div>
      {column.type === 'select' && (
        <>
          <div className="ct-menu-label">Options</div>
          <div className="ct-option-editor">
            {(column.options || []).map((option) => (
              <div className="ct-option-row" key={option.id}>
                <button
                  className="ct-swatch"
                  style={pillStyle(option)}
                  aria-label={`Change color of ${option.name || 'option'}`}
                  title="Change color"
                  onClick={() =>
                    changeColumn(column.id, (c) => ({
                      ...c,
                      options: c.options!.map((o) =>
                        o.id === option.id
                          ? {
                              ...o,
                              color:
                                tableColorNames[
                                  (tableColorNames.indexOf(o.color) + 1) % tableColorNames.length
                                ],
                            }
                          : o,
                      ),
                    }))
                  }
                />
                <input
                  className="ct-option-name"
                  aria-label="Option name"
                  value={option.name}
                  maxLength={tableLimits.name}
                  onChange={(event) =>
                    changeColumn(column.id, (c) => ({
                      ...c,
                      options: c.options!.map((o) =>
                        o.id === option.id ? { ...o, name: event.target.value } : o,
                      ),
                    }))
                  }
                  onKeyDown={(event) => event.stopPropagation()}
                />
                <button
                  className="ct-icon-button"
                  aria-label={`Remove ${option.name || 'option'}`}
                  onClick={() =>
                    change({
                      columns: table.columns.map((c) =>
                        c.id === column.id
                          ? { ...c, options: c.options!.filter((o) => o.id !== option.id) }
                          : c,
                      ),
                      rows: table.rows.map((row) => {
                        if (row.cells[column.id] !== option.id) return row;
                        const cells = { ...row.cells };
                        delete cells[column.id];
                        return { ...row, cells };
                      }),
                    })
                  }
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              className="ct-menu-item"
              disabled={(column.options || []).length >= tableLimits.options}
              onClick={() => {
                const option = addOption(column, `Option ${(column.options || []).length + 1}`);
                if (option)
                  changeColumn(column.id, (c) => ({
                    ...c,
                    options: [...(c.options || []), option],
                  }));
              }}
            >
              <Plus size={14} /> Add option
            </button>
          </div>
        </>
      )}
      <div className="ct-menu-divider" />
      <div className="ct-menu-actions">
        <button
          className="ct-icon-button"
          aria-label="Move column left"
          title="Move left"
          disabled={index === 0}
          onClick={() => moveColumn(column.id, -1)}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="ct-icon-button"
          aria-label="Move column right"
          title="Move right"
          disabled={index === table.columns.length - 1}
          onClick={() => moveColumn(column.id, 1)}
        >
          <ArrowRight size={14} />
        </button>
        <button
          className="ct-menu-item ct-danger"
          disabled={table.columns.length <= 1}
          onClick={() => removeColumn(column.id)}
        >
          <Trash2 size={14} /> Delete column
        </button>
      </div>
    </div>
  );

  const beginResize = (column: TableColumn) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const startX = event.clientX,
      startY = event.clientY,
      start = column.width,
      factor = camera.zoom * scale,
      angle = ((o.rotation || 0) * Math.PI) / 180;
    let width = start;
    const move = (e: globalThis.PointerEvent) => {
      // Along the table's own horizontal axis, so rotated tables resize too.
      const along = (e.clientX - startX) * Math.cos(angle) + (e.clientY - startY) * Math.sin(angle);
      width = Math.round(
        Math.max(tableColumnWidth.min, Math.min(tableColumnWidth.max, start + along / factor)),
      );
      setDragWidth({ id: column.id, width });
    };
    const end = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', end);
      element.removeEventListener('pointercancel', end);
      setDragWidth(null);
      if (width !== start) changeColumn(column.id, (c) => ({ ...c, width }));
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
  };

  const origin = localToWorld(o, { x: 0, y: 0 });
  return (
    <section
      ref={card}
      className="canvas-table glass-surface"
      data-table-id={o.id}
      data-selected={active}
      data-editing={editing}
      aria-label={o.text || 'Table'}
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: layoutWidth,
        borderColor: editing ? 'transparent' : active ? '#4486d9' : undefined,
        transform: `scale(${camera.zoom * scale}) rotate(${o.rotation || 0}deg)`,
      }}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.button !== 0 || !target.closest('button,input,textarea,.ct-popup,.ct-resize'))
          forward(event);
        else select(o.id);
      }}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button,.ct-popup')) return;
        // Double-clicking a cell starts typing in it. The board may already
        // have opened editing from the same double-click and taken focus.
        const key = target.closest<HTMLElement>('[data-cell]')?.dataset.cell;
        const field = key ? fields.current.get(key) : undefined;
        if (field && document.activeElement !== field) {
          field.focus();
          if (field instanceof HTMLTextAreaElement)
            field.setSelectionRange(field.value.length, field.value.length);
        } else if (key && !field) pendingFocus.current = key;
        if (editing) return;
        event.stopPropagation();
        select(o.id);
        setEditing(true);
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key === 'Escape' && (editing || popup)) {
          event.stopPropagation();
          if (popup) setPopup(null);
          else {
            setEditing(false);
            target.blur();
          }
          return;
        }
        if (target.closest('input,textarea,button,.ct-popup')) event.stopPropagation();
      }}
    >
      {editing && <ListEditOutline width={layoutWidth} height={o.height / scale} />}
      <header className="canvas-table-header">
        {editing ? (
          <input
            className="canvas-table-name"
            aria-label="Table name"
            placeholder="Untitled table"
            value={o.text || ''}
            maxLength={tableLimits.name}
            onChange={(event) => update({ ...o, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.currentTarget as HTMLElement).blur();
            }}
          />
        ) : (
          <div className="canvas-table-name" data-empty={!o.text}>
            {o.text || 'Untitled table'}
          </div>
        )}
      </header>
      <div className="ct-grid" role="table" aria-label={o.text || 'Table'}>
        <div className="ct-row ct-head" role="row">
          {columns.map((column, index) => {
            const Icon = typeIcons[column.type];
            const open = popup?.kind === 'column' && popup.columnId === column.id;
            return (
              <div
                key={column.id}
                className="ct-cell ct-th"
                role="columnheader"
                style={{ width: column.width }}
              >
                {editing ? (
                  <button
                    className="ct-th-button ct-popup-anchor"
                    aria-expanded={open}
                    aria-label={`${column.name || 'Column'} column options`}
                    onClick={() => setPopup(open ? null : { kind: 'column', columnId: column.id })}
                  >
                    <Icon size={13} className="ct-th-icon" />
                    <span className="ct-th-name">{column.name}</span>
                    <ChevronDown size={13} className="ct-th-more" />
                  </button>
                ) : (
                  <div className="ct-th-button">
                    <Icon size={13} className="ct-th-icon" />
                    <span className="ct-th-name">{column.name}</span>
                  </div>
                )}
                {editing && (
                  <div
                    className="ct-resize"
                    aria-hidden="true"
                    onPointerDown={beginResize(column)}
                  />
                )}
                {open && columnMenu(table.columns[index], index)}
              </div>
            );
          })}
          <div className="ct-cell ct-actions" role="presentation">
            {editing && (
              <button
                className="ct-icon-button"
                aria-label="Add column"
                title="Add column"
                disabled={table.columns.length >= tableLimits.columns}
                onClick={addColumn}
              >
                <Plus size={15} />
              </button>
            )}
          </div>
        </div>
        {table.rows.map((row, rowIndex) => (
          <div className="ct-row" role="row" key={row.id}>
            {columns.map((column) => (
              <div
                key={column.id}
                className="ct-cell"
                role="cell"
                data-type={column.type}
                data-cell={`${row.id}:${column.id}`}
                style={{ width: column.width }}
              >
                {renderCell(row, rowIndex, column)}
              </div>
            ))}
            <div className="ct-cell ct-actions" role="presentation">
              {editing && (
                <button
                  className="ct-icon-button ct-remove-row"
                  aria-label={`Remove row ${rowIndex + 1}`}
                  onClick={() => removeRow(row.id)}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <button
        className="ct-add-row"
        disabled={table.rows.length >= tableLimits.rows}
        onClick={() => {
          select(o.id);
          if (!editing) setEditing(true);
          addRow();
        }}
      >
        <Plus size={15} /> New row
      </button>
    </section>
  );
}

export default function CanvasTables({
  view,
  update,
  fit,
  select,
  selected,
  host,
  interactive,
  beginPointer,
  editingId,
  onEdit,
}: {
  view: TableView;
  update: (o: CanvasObject) => void;
  fit: (o: CanvasObject, layoutHeight: number) => void;
  select: (id: string) => void;
  selected: string[];
  host: HTMLDivElement | null;
  interactive: boolean;
  beginPointer: (event: globalThis.PointerEvent) => void;
  editingId: string | null;
  onEdit: (id: string | null) => void;
}) {
  useEffect(() => {
    if (!editingId) return;
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.selection-tools')) return;
      if (target.closest<HTMLElement>('.canvas-table')?.dataset.tableId !== editingId) onEdit(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [editingId, onEdit]);
  return (
    <div
      className="canvas-tables"
      data-interactive={interactive}
      onWheel={(event) => forwardWheel(host, event.nativeEvent, { overlay: event.currentTarget })}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('input,textarea')) return;
        event.preventDefault();
        host?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
          }),
        );
      }}
    >
      {view.objects.map((o) => (
        <TableCard
          key={o.id}
          object={o}
          camera={view.camera}
          update={(next) => {
            if (!o.locked) update(next);
          }}
          fit={fit}
          select={select}
          active={selected.includes(o.id)}
          editing={!o.locked && editingId === o.id}
          setEditing={(editing) => {
            if (!o.locked) onEdit(editing ? o.id : null);
          }}
          forward={(event) => {
            event.preventDefault();
            beginPointer(event.nativeEvent);
          }}
        />
      ))}
    </div>
  );
}
