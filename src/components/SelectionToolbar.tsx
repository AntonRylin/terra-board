import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, EyeOff, Palette, Plus, SquareDashed } from 'lucide-react';
import { ContextMenu } from './Dialogs';
import { ObjectLockGlyph } from './ObjectLockButton';
import {
  readSelectionToolbarLayout,
  selectionToolLabels,
  selectionToolbarStorageKey,
  selectionToolbarLayoutKey,
  type SelectionToolId,
} from './selection-toolbar-layout';
import { type ToolbarZone } from './toolbar-layout';
import { useToolbarReorder } from './useToolbarReorder';
import './canvas-toolbar.css';
import './selection-toolbar.css';

type ControlProps = ButtonHTMLAttributes<HTMLButtonElement> & { 'data-tool-label'?: string };
function controlsFrom(children: ReactNode): ReactElement<ControlProps>[] {
  const controls: ReactElement<ControlProps>[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ControlProps>(child)) return;
    if (child.type === Fragment) controls.push(...controlsFrom(child.props.children));
    else controls.push(child);
  });
  return controls;
}

export default function SelectionToolbar({
  children,
  onLayoutChange,
  contextKey,
  locked = false,
}: {
  children: ReactNode;
  onLayoutChange: () => void;
  contextKey: string;
  locked?: boolean;
}) {
  const controls = controlsFrom(children);
  const byId = new Map(controls.map((control) => [control.key as SelectionToolId, control]));
  const [menu, setMenu] = useState<{ id: SelectionToolId; x: number; y: number } | null>(null);
  const available = [...byId.keys()];
  const anchor = useRef<{ right: number; top: number; bottom: number; onTop: boolean } | null>(
    null,
  );
  const {
    layout,
    open,
    setOpen,
    dragging,
    current,
    root,
    bar,
    inventory,
    avatar,
    surface,
    plus,
    start,
    moveTool,
  } = useToolbarReorder({
    initialLayout: () => {
      try {
        return readSelectionToolbarLayout(
          JSON.parse(localStorage.getItem(selectionToolbarLayoutKey) || 'null'),
          JSON.parse(localStorage.getItem(selectionToolbarStorageKey) || 'null'),
        );
      } catch {
        return readSelectionToolbarLayout(null);
      }
    },
    available,
    onSave: (next) => {
      try {
        localStorage.setItem(selectionToolbarLayoutKey, JSON.stringify(next));
      } catch {}
    },
    onLayout: () => {
      onLayoutChange();
      positionMenu();
    },
    context: contextKey + ':' + locked + ':' + available.join(','),
    preserveSelectionOnEscape: true,
  });

  function positionMenu() {
    const panel = inventory.current,
      strip = root.current;
    if (!panel || !strip) return;
    const r = strip.getBoundingClientRect();
    const above = r.top - 20,
      below = innerHeight - r.bottom - 20;
    // Keep the drop target steady while removing wide controls shifts the ribbon.
    if (!dragging || !anchor.current)
      anchor.current = {
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        onTop: above >= Math.min(panel.scrollHeight, 360) || above > below,
      };
    const a = anchor.current;
    const space = a.onTop ? a.top - 20 : innerHeight - a.bottom - 20;
    panel.style.maxHeight = `${Math.max(40, Math.min(360, space))}px`;
    panel.style.left = `${Math.max(10, Math.min(a.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 10)) - r.left}px`;
    panel.style.top = `${(a.onTop ? a.top - panel.offsetHeight - 12 : a.bottom + 12) - r.top}px`;
    panel.style.visibility = 'visible';
  }
  useLayoutEffect(() => {
    if (!open) {
      anchor.current = null;
      return;
    }
    let frame = 0;
    const position = () => {
      positionMenu();
      frame = requestAnimationFrame(position);
    };
    position();
    return () => cancelAnimationFrame(frame);
  }, [open, dragging]);
  useLayoutEffect(() => setMenu(null), [contextKey, locked]);

  const name = (id: SelectionToolId) =>
    byId.get(id)?.props['aria-label'] || selectionToolLabels[id];
  const icon = (id: SelectionToolId) =>
    id === 'lock' ? (
      <ObjectLockGlyph locked={locked} />
    ) : id === 'colors' ? (
      <Palette size={19} strokeWidth={1.7} />
    ) : id === 'arrow-style' ? (
      <ArrowUpRight size={19} strokeWidth={1.7} />
    ) : (
      Children.toArray(byId.get(id)?.props.children).find((child) => isValidElement(child))
    );
  const keyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    id: SelectionToolId,
    zone: ToolbarZone,
  ) => {
    if (
      !event.altKey ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const destination = event.key === 'Enter' ? (zone === 'bar' ? 'inventory' : 'bar') : zone;
    const visible = current.current[zone].filter((tool) => byId.has(tool));
    const index =
      destination !== zone
        ? current.current[destination].filter((tool) => byId.has(tool)).length
        : visible.indexOf(id) + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
    setOpen(true);
    moveTool(id, destination, index);
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLButtonElement>(`[data-tool-id="${id}"] button`)?.focus(),
    );
  };
  const renderTool = (id: SelectionToolId, zone: ToolbarZone) => {
    const control = byId.get(id)!;
    const compound = control.type !== 'button' && id !== 'lock';
    const handlers: ControlProps = {
      draggable: false,
      title: undefined,
      'aria-label': name(id),
      'aria-description':
        'Drag to rearrange. Alt and arrow keys move this tool. Alt and Enter moves it between the ribbon and more tools.',
      'data-tool-label': zone === 'bar' && id !== 'lock' ? name(id) : undefined,
      onPointerDown: (event) => start(event, id),
      onKeyDown: (event) => keyboard(event, id, zone),
    };
    return (
      <div
        key={id}
        className={
          'selection-tool-slot' + (compound && zone === 'bar' ? ' selection-tool-compound' : '')
        }
        data-tool-id={id}
        data-held={dragging === id || undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (zone === 'bar') setMenu({ id, x: event.clientX, y: event.clientY });
        }}
      >
        {compound ? (
          <>
            <button
              {...handlers}
              className="icon-button"
              onClick={() => {
                if (zone === 'inventory') {
                  moveTool(id, 'bar', current.current.bar.filter((tool) => byId.has(tool)).length);
                  setOpen(false);
                }
              }}
            >
              {icon(id)}
              {zone === 'inventory' && <span className="tool-inventory-name">{name(id)}</span>}
            </button>
            {zone === 'bar' && control}
          </>
        ) : id === 'lock' ? (
          cloneElement(control, {
            ...handlers,
            children:
              zone === 'inventory' ? (
                <span className="tool-inventory-name">{name(id)}</span>
              ) : undefined,
          })
        ) : (
          cloneElement(control, {
            ...handlers,
            className: 'icon-button',
            onClick: (event) => {
              control.props.onClick?.(event);
              if (zone === 'inventory') setOpen(false);
            },
            children:
              zone === 'inventory' ? (
                <>
                  {icon(id)}
                  <span className="tool-inventory-name">{name(id)}</span>
                </>
              ) : (
                control.props.children
              ),
          })
        )}
      </div>
    );
  };
  const visibleBar = layout.bar.filter((id) => byId.has(id));
  const visibleInventory = layout.inventory.filter((id) => byId.has(id));
  useLayoutEffect(() => {
    if (!visibleInventory.length && !dragging) setOpen(false);
  }, [visibleInventory.length, dragging]);
  return (
    <>
      <div
        ref={root}
        className="selection-toolbar-content customizable-toolbar"
        data-reordering={!!dragging || undefined}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') event.stopPropagation();
        }}
      >
        <div ref={surface} className="selection-toolbar-surface glass-surface" aria-hidden="true" />
        {locked && byId.get('lock')}
        {!locked && (
          <>
            <div ref={bar} className="selection-toolbar-slots" data-tool-zone="bar">
              {visibleBar.map((id) => renderTool(id, 'bar'))}
            </div>
            {visibleInventory.length > 0 && (
              <button
                ref={plus}
                className="icon-button selection-toolbar-plus"
                aria-label="Customize object tools"
                aria-expanded={open}
                aria-controls="selection-tool-menu"
                data-tool-label="More tools"
                onClick={() => setOpen((value) => !value)}
              >
                <Plus size={19} strokeWidth={1.7} />
              </button>
            )}
            {open && (!!visibleInventory.length || !!dragging) && (
              <div
                ref={inventory}
                id="selection-tool-menu"
                className="selection-tool-menu glass-surface"
                role="group"
                aria-label="More object tools"
                data-tool-zone="inventory"
              >
                {visibleInventory.map((id) => renderTool(id, 'inventory'))}
                {!visibleInventory.length && (
                  <SquareDashed
                    className="inventory-empty"
                    size={24}
                    aria-label="Drag tools here to hide them"
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
      {menu &&
        !locked &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            placement="pointer"
            className="selection-tool-context-menu"
            onClose={() => setMenu(null)}
            items={[
              {
                label: 'Hide',
                icon: <EyeOff size={16} />,
                action: () => {
                  moveTool(menu.id, 'inventory', visibleInventory.length);
                  setOpen(false);
                },
              },
            ]}
          />,
          document.body,
        )}
      {dragging &&
        createPortal(
          <div
            ref={avatar}
            className="toolbar-held-icon glass-surface"
            aria-hidden="true"
            style={{ width: 34, height: 34 }}
          >
            {icon(dragging)}
          </div>,
          document.body,
        )}
    </>
  );
}
