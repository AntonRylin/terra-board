import { useState, type ReactNode } from 'react';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { ContextMenu, type MenuItem } from '../Dialogs';

// List rows for Settings pages that show things (boards, devices, people) rather than
// options: an icon tile, a title with a quieter line under it, an optional value on the
// right, and a disclosure chevron when the row opens.

export function ListRow({
  icon,
  title,
  subtitle,
  meta,
  menu,
  open,
  onToggle,
  onClick,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  menu?: (MenuItem | null)[];
  /** The row opens to show children; onToggle flips it. */
  open?: boolean;
  onToggle?: () => void;
  /** Or the row leads somewhere else. */
  onClick?: () => void;
  children?: ReactNode;
}) {
  const press = onToggle || onClick;
  const body = (
    <>
      <span className="st-list-icon">{icon}</span>
      <span className="st-list-text">
        <span className="st-list-title">{title}</span>
        {subtitle && <span className="st-list-subtitle">{subtitle}</span>}
      </span>
      {meta && <span className="st-list-meta">{meta}</span>}
      {press && (
        <ChevronRight
          className="st-list-chevron"
          data-open={onToggle ? !!open : undefined}
          size={16}
          aria-hidden="true"
        />
      )}
    </>
  );
  return (
    <div className="st-list-row" data-open={open || undefined}>
      <div className="st-list-line">
        {press ? (
          <button
            type="button"
            className="st-list-main"
            aria-expanded={onToggle ? !!open : undefined}
            onClick={press}
          >
            {body}
          </button>
        ) : (
          <div className="st-list-main">{body}</div>
        )}
        {menu && <MoreMenu items={menu} label="More" />}
      </div>
      {open && children && <div className="st-list-detail">{children}</div>}
    </div>
  );
}

// "⋯": the actions a row has besides opening it.
export function MoreMenu({ items, label }: { items: (MenuItem | null)[]; label: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // No actions: an empty slot of the same width keeps the rows' values lined up.
  if (!items.some(Boolean)) return <span className="st-icon-button" aria-hidden="true" />;
  return (
    <>
      <button
        type="button"
        className="st-icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.right, y: r.bottom + 4 });
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {at && (
        <ContextMenu
          x={at.x}
          y={at.y}
          items={items}
          placement="left"
          className="st-menu"
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0]?.toLocaleUpperCase() || '')
    .join('') || '?';

// A round tile with someone's initials; the hue comes from the name so it stays the same.
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  return (
    <span
      className="st-avatar"
      style={{ width: size, height: size, fontSize: size * 0.38, ['--hue' as string]: hash % 360 }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
