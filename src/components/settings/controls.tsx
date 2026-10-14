import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { rows, type RowId } from './settings-index';

export function Group({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="st-group">
      {(title || action) && (
        <div className="st-group-head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      <div className="st-card">{children}</div>
    </section>
  );
}

// A settings row. Known rows take their text from the search index.
export function Row({
  id,
  title,
  description,
  children,
  below,
}: {
  id?: RowId | string;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  below?: ReactNode;
}) {
  const info = id && id in rows ? rows[id as RowId] : undefined;
  const heading = title ?? info?.title;
  const text = description ?? (info && 'description' in info ? info.description : undefined);
  const descriptionId = useId();
  return (
    <div className="st-row" data-setting={id} id={id ? 'setting-' + id : undefined}>
      <div className="st-row-main">
        <div className="st-row-text">
          <div className="st-row-title">{heading}</div>
          {text && (
            <p className="st-row-description" id={descriptionId}>
              {text}
            </p>
          )}
        </div>
        {children !== undefined && <div className="st-row-control">{children}</div>}
      </div>
      {below}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="st-switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export type Option<T extends string> = { value: T; label: string; description?: string };

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const show = () => {
    setActive(Math.max(0, options.indexOf(current)));
    setOpen(true);
  };
  const choose = (option: Option<T>) => {
    setOpen(false);
    button.current?.focus();
    if (option.value !== value) onChange(option.value);
  };
  return (
    <div
      className="st-select"
      ref={root}
      onKeyDown={(event) => {
        if (!open) {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            show();
          }
          return;
        }
        if (event.key === 'Escape' || event.key === 'Tab') {
          // Escape closes the list, not the whole settings page.
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
          }
          setOpen(false);
          button.current?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setActive((i) => (i + step + options.length) % options.length);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          choose(options[active]);
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="st-select-button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? setOpen(false) : show())}
      >
        {current.label}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="st-select-list" role="listbox" id={listId} aria-label={label}>
          {options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className="st-select-option"
              data-active={index === active || undefined}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              <div>
                <div className="st-select-label">{option.label}</div>
                {option.description && (
                  <div className="st-select-description">{option.description}</div>
                )}
              </div>
              {option.value === value && <Check size={15} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function useNotice() {
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice] as const;
}

export function Notice({ notice }: { notice: { text: string; error?: boolean } | null }) {
  if (!notice) return null;
  return (
    <p
      className={'st-notice' + (notice.error ? ' error' : '')}
      role={notice.error ? 'alert' : 'status'}
    >
      {notice.text}
    </p>
  );
}
