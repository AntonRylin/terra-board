import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const activeNames = new Map<symbol, () => Promise<void>>();
const pendingNames = new Set<Promise<void>>();
export async function flushInlineNames() {
  const active = [...activeNames.values()].map((finish) => finish());
  await Promise.all([...pendingNames, ...active]);
}

interface Props {
  value: string;
  label: string;
  className?: string;
  editRequest?: number;
  singleClick?: boolean;
  onCommit: (value: string) => Promise<void>;
}

// Keep the same element and typography when a title becomes editable.
export default function InlineName({
  value,
  label,
  className = '',
  editRequest = 0,
  singleClick = false,
  onCommit,
}: Props) {
  const ref = useRef<HTMLSpanElement>(null),
    active = useRef(false),
    pending = useRef<Promise<void> | null>(null);
  const session = useRef(Symbol('inline name')),
    finishRef = useRef<() => Promise<void>>(async () => {});
  const [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const begin = () => {
    if (active.current || pending.current) return;
    activeNames.set(session.current, () => finishRef.current());
    active.current = true;
    setError('');
    setEditing(true);
  };
  useEffect(
    () => () => {
      activeNames.delete(session.current);
    },
    [],
  );
  useEffect(() => {
    if (editRequest) begin();
  }, [editRequest]);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!active.current) el.textContent = value;
  }, [value, editing]);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!editing) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);
  const finish = (cancel = false): Promise<void> => {
    if (pending.current) return pending.current;
    if (!active.current) return Promise.resolve();
    const el = ref.current!;
    if (cancel) {
      activeNames.delete(session.current);
      active.current = false;
      el.textContent = value;
      setEditing(false);
      setError('');
      el.blur();
      return Promise.resolve();
    }
    const next = (el.textContent || '').replace(/[\r\n]+/g, ' ').trim();
    if (
      !next ||
      [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(next)].length > 120
    ) {
      const message = 'Use a name between 1 and 120 characters.';
      setError(message);
      el.focus();
      return Promise.reject(new Error(message));
    }
    // End input immediately on Enter/blur, before the async save can accept and
    // then overwrite another keystroke. A failed save restores the same draft.
    el.contentEditable = 'false';
    setSaving(true);
    const operation = Promise.resolve()
      .then(async () => {
        if (next !== value) await onCommit(next);
        activeNames.delete(session.current);
        active.current = false;
        el.textContent = next;
        setEditing(false);
        setError('');
        el.blur();
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        el.contentEditable = 'plaintext-only';
        el.focus();
        throw e;
      })
      .finally(() => {
        pendingNames.delete(operation);
        pending.current = null;
        setSaving(false);
      });
    pending.current = operation;
    pendingNames.add(operation);
    return operation;
  };
  finishRef.current = finish;
  const finishFromInput = (cancel = false) => {
    void finish(cancel).catch(() => {});
  };
  return (
    <span
      ref={ref}
      className={`inline-name ${className}`}
      role={editing ? 'textbox' : 'button'}
      aria-label={label}
      aria-invalid={!!error}
      aria-busy={saving}
      title={error || (singleClick ? 'Click to rename' : 'Double-click to rename')}
      tabIndex={0}
      contentEditable={editing && !saving ? 'plaintext-only' : false}
      suppressContentEditableWarning
      spellCheck={false}
      onDoubleClick={(e) => {
        e.stopPropagation();
        begin();
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (singleClick) begin();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onCopy={(e) => e.stopPropagation()}
      onCut={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      onBlur={() => finishFromInput()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (pending.current) {
          e.preventDefault();
          return;
        }
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape' && editing) {
          e.preventDefault();
          finishFromInput(true);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          editing ? finishFromInput() : begin();
        } else if (e.key === 'F2') {
          e.preventDefault();
          begin();
        }
      }}
    />
  );
}
