import { type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  MoreHorizontal,
  PanelBottomClose,
  Plus,
  SquareDashed,
  type LucideIcon,
} from 'lucide-react';
import {
  defaultToolbarLayout,
  phoneToolbarLayout,
  readToolbarLayout,
  moveToolbarTool,
  toolbarStorageKey,
  type ToolbarId,
  type ToolbarZone,
} from './toolbar-layout';
import { useToolbarReorder } from './useToolbarReorder';
import { android } from '../bridge';
import './canvas-toolbar.css';
export type ToolbarAction = {
  id: ToolbarId;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  active?: boolean;
  action: () => void;
};
export default function CanvasToolbar({
  tools,
  options,
  onHide,
  onMore,
}: {
  tools: ToolbarAction[];
  // The canvas menu (…), shown at the end of the bar where the zoom bar gives way
  // (Android, portrait: canvas-toolbar.css).
  onMore?: (anchor: DOMRect) => void;
  // Hides the whole toolbar (the last item of the "more tools" menu).
  onHide?: () => void;
  // Settings of the active tool, shown above the bar while the tool menu is closed.
  options?: ReactNode;
}) {
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
    gesture,
    preview,
    save,
    start,
  } = useToolbarReorder({
    // A layout the person arranged is kept (localStorage); until then the default for
    // this kind of device.
    initialLayout: () => {
      const fallback = android ? phoneToolbarLayout() : defaultToolbarLayout();
      try {
        const saved = JSON.parse(localStorage.getItem(toolbarStorageKey) || 'null');
        return saved ? readToolbarLayout(saved) : fallback;
      } catch {
        return fallback;
      }
    },
    available: tools.map((tool) => tool.id),
    onSave: (next) => {
      try {
        localStorage.setItem(toolbarStorageKey, JSON.stringify(next));
      } catch {}
    },
  });
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const renderTool = (id: ToolbarId, zone: ToolbarZone) => {
    const item = toolsById.get(id)!;
    const name =
      id === 'list'
        ? 'List'
        : id === 'table'
          ? 'Table'
          : id === 'paper'
            ? 'Document'
            : id === 'html'
              ? 'HTML embed'
              : id === 'browser'
                ? 'Browser'
                : id === 'folder'
                  ? 'Folder'
                  : id === 'desktops'
                    ? 'Desktops'
                : id === 'media'
                  ? 'Images and video'
                  : item.label;
    const Icon = item.icon;
    return (
      <div
        className="toolbar-slot"
        data-tool-id={id}
        data-held={dragging === id || undefined}
        key={id}
      >
        <button
          className="icon-button"
          aria-label={item.label}
          aria-pressed={item.active}
          aria-description="Drag to rearrange. Alt and arrow keys move this tool. Alt and Enter moves it between the toolbar and more tools."
          data-tool-label={zone === 'bar' ? name : undefined}
          data-tool-shortcut={zone === 'bar' && item.shortcut ? item.shortcut : undefined}
          aria-keyshortcuts={item.shortcut || undefined}
          draggable={false}
          onPointerDown={(event) => start(event, id)}
          onClick={() => {
            item.action();
            if (zone === 'inventory') setOpen(false);
          }}
          onKeyDown={(event) => {
            if (
              !event.altKey ||
              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const destination =
              event.key === 'Enter' ? (zone === 'bar' ? 'inventory' : 'bar') : zone;
            const index =
              destination !== zone
                ? current.current[destination].length
                : current.current[zone].indexOf(id) +
                  (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
            const next = moveToolbarTool(current.current, id, destination, index);
            setOpen(true);
            preview(next);
            save(next);
            requestAnimationFrame(() =>
              root.current
                ?.querySelector<HTMLButtonElement>(`[data-tool-id="${id}"] button`)
                ?.focus(),
            );
          }}
        >
          <Icon size={19} strokeWidth={1.7} />
          {zone === 'inventory' && <span className="tool-inventory-name">{name}</span>}
        </button>
      </div>
    );
  };
  const DragIcon = dragging ? toolsById.get(dragging)!.icon : null;
  return (
    <>
      <div
        ref={root}
        className="canvas-toolbar customizable-toolbar"
        role="toolbar"
        aria-label="Canvas tools"
        data-reordering={!!dragging || undefined}
        style={{ '--tool-count': layout.bar.length } as CSSProperties}
      >
        <div ref={surface} className="toolbar-glass glass-surface" aria-hidden="true" />
        <div ref={bar} className="toolbar-slots" data-tool-zone="bar">
          {layout.bar.map((id) => renderTool(id, 'bar'))}
        </div>
        <button
          ref={plus}
          className="icon-button toolbar-insert"
          aria-label="Insert"
          aria-expanded={open}
          aria-controls="tool-inventory"
          data-tool-label="More tools"
          onClick={() => setOpen((value) => !value)}
        >
          <Plus size={19} strokeWidth={1.7} />
        </button>
        {onMore && (
          <button
            className="icon-button toolbar-more"
            aria-label="Canvas options"
            onClick={(e) => {
              // One menu at a time: the + menu closes.
              setOpen(false);
              onMore(e.currentTarget.getBoundingClientRect());
            }}
          >
            <MoreHorizontal size={19} strokeWidth={1.7} />
          </button>
        )}
        {open && (
          <div
            ref={inventory}
            id="tool-inventory"
            className="tool-inventory tool-menu insert-menu glass-surface"
            role="group"
            aria-label="More tools"
            data-tool-zone="inventory"
          >
            {/* First, so it shows without scrolling the menu (short in landscape). */}
            {onHide && !dragging && (
              <button
                type="button"
                className="icon-button toolbar-hide"
                onClick={() => {
                  setOpen(false);
                  onHide();
                }}
              >
                <PanelBottomClose size={19} strokeWidth={1.7} />
                <span className="tool-inventory-name">Hide toolbar</span>
              </button>
            )}
            {layout.inventory.map((id) => renderTool(id, 'inventory'))}
            {!layout.inventory.length && (
              <SquareDashed className="inventory-empty" size={24} aria-hidden="true" />
            )}
          </div>
        )}
        {!open && !dragging && options}
      </div>
      {dragging &&
        DragIcon &&
        createPortal(
          <div
            ref={avatar}
            className="toolbar-held-icon glass-surface"
            aria-hidden="true"
            style={{ width: gesture.current?.width, height: gesture.current?.height }}
          >
            <DragIcon size={19} strokeWidth={1.7} />
          </div>,
          document.body,
        )}
    </>
  );
}
