// A Desktops frame (type 'file', kind 'desktops'): Windows' virtual desktops
// side by side with the windows open on each, live, like Task View. Clicking a
// window brings it forward (moving to its desktop first); clicking a desktop
// switches to it. Window titles are only shown, never stored in the board.
import { useState, type PointerEvent, type ReactNode } from 'react';
import { refreshDesktops, useDesktops } from './desktop-windows';
import { AppWindow, Copy, ExternalLink, Link2, Monitor, MonitorUp, X } from 'lucide-react';
import type { Camera, CanvasObject } from '../model';
import { localToWorld } from '../canvas/transform';
import { folderFooter, folderHeader, iconTier, type DesktopWindow } from '../canvas/file-link';
import type { MenuItem } from './Dialogs';
import { fileIcon, useFileIcons } from './file-icons';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const columnHeader = 68;
const rowHeight = 46;

export function AppIcon({ exe, size, zoom }: { exe: string; size: number; zoom: number }) {
  const url = exe ? fileIcon(exe, 0, iconTier(size * zoom * (window.devicePixelRatio || 1))) : null;
  return (
    <span className="cd-app-icon" style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <AppWindow size={size * 0.8} strokeWidth={1.5} />
      )}
    </span>
  );
}

function Wallpaper({ file, zoom }: { file: string; zoom: number }) {
  const url = file
    ? fileIcon(file, 0, iconTier(256 * zoom * (window.devicePixelRatio || 1)))
    : null;
  return url ? <img className="cd-wallpaper" src={url} alt="" draggable={false} /> : null;
}

export function DesktopsCard({
  object: o,
  camera,
  active,
  host,
  select,
  forward,
  onError,
  openMenu,
  addAppIcon,
  addAppFrame,
}: {
  object: CanvasObject;
  camera: Camera;
  active: boolean;
  host: HTMLDivElement | null;
  select: (id: string) => void;
  forward: (event: PointerEvent) => void;
  onError: (message: string) => void;
  openMenu: (menu: { x: number; y: number; items: (MenuItem | null)[] } | null) => void;
  addAppIcon: (exe: string, name: string) => void;
  addAppFrame: (w: DesktopWindow) => void;
}) {
  useFileIcons();
  const files = window.canvas?.files;
  const state = useDesktops();
  const [status, setStatus] = useState('');

  const run = async (working: string, task: () => Promise<void>) => {
    setStatus(working);
    try {
      await task();
    } catch (error) {
      onError(message(error));
    } finally {
      setStatus('');
      refreshDesktops(450);
    }
  };
  const live = state?.supported ? state : null;
  const desktops = live?.desktops ?? [];
  const currentIndex = live ? desktops.findIndex((d) => d.id === live.current) : -1;
  const stepsTo = (desktop: string) => {
    const index = desktops.findIndex((d) => d.id === desktop);
    return index < 0 || currentIndex < 0 ? 0 : index - currentIndex;
  };
  const focus = (w: DesktopWindow) =>
    files &&
    void run('Switching…', () => files.focusWindow({ id: w.id, steps: stepsTo(w.desktop) }));
  const switchTo = (desktop: string) => {
    const steps = stepsTo(desktop);
    if (files && steps) void run('Switching desktop…', () => files.switchDesktop({ steps }));
  };
  const windowMenu = (w: DesktopWindow): (MenuItem | null)[] => [
    { label: 'Switch to window', icon: <MonitorUp />, action: () => focus(w) },
    ...(w.exe
      ? [
          // Terra's own window can't sit inside itself.
          ...(/[\\/]Terra Board\.exe$/i.test(w.exe)
            ? []
            : [
                {
                  label: 'Put window on the board',
                  icon: <AppWindow />,
                  action: () => addAppFrame(w),
                },
              ]),
          {
            label: 'Add app icon to board',
            icon: <Link2 />,
            action: () => addAppIcon(w.exe, w.app || w.title),
          },
          {
            label: 'Show app in Explorer',
            icon: <ExternalLink />,
            action: () => void files?.reveal({ path: w.exe }),
          },
        ]
      : []),
    {
      label: 'Copy title',
      icon: <Copy />,
      action: () => void navigator.clipboard.writeText(w.title),
    },
    null,
    {
      label: 'Close window',
      icon: <X />,
      danger: true,
      action: () => files && void run('Closing…', () => files.closeWindow({ id: w.id })),
    },
  ];

  // Windows on every desktop (or whose desktop Windows doesn't say) get their own column.
  const known = new Set(desktops.map((d) => d.id));
  const everywhere = live ? live.windows.filter((w) => !known.has(w.desktop)) : [];
  const columns = [
    ...desktops.map((d, index) => ({
      key: d.id,
      name: d.name,
      wallpaper: d.wallpaper,
      current: index === currentIndex,
      windows: live!.windows.filter((w) => w.desktop === d.id),
    })),
    ...(everywhere.length
      ? [
          {
            key: 'all',
            name: 'On all desktops',
            wallpaper: '',
            current: false,
            windows: everywhere,
          },
        ]
      : []),
  ];
  const bodyHeight = Math.max(20, o.height - folderHeader - folderFooter);
  const columnWidth = Math.max(
    240,
    columns.length ? (o.width - 2 - 16 - (columns.length - 1) * 12) / columns.length : 240,
  );
  const tiny = camera.zoom < 0.18;

  let content: ReactNode;
  if (!files || (state && !state.supported))
    content = (
      <div className="cf-message">
        <Monitor size={36} strokeWidth={1.5} />
        <p>
          {files && state && !state.supported
            ? state.message
            : 'Virtual desktops show in Terra Board for Windows.'}
        </p>
      </div>
    );
  else if (!live) content = <div className="cf-message">Reading desktops…</div>;
  else if (tiny)
    content = (
      <div className="cf-message cf-summary">
        {desktops.length} · {live.windows.length}
      </div>
    );
  else
    content = (
      <div className="cd-columns">
        {columns.map((column) => (
          <section
            key={column.key}
            className="cd-column"
            data-current={column.current || undefined}
            style={{ width: columnWidth, height: bodyHeight - 16 }}
          >
            <button
              className="cd-head"
              style={{ height: columnHeader }}
              title={
                column.current
                  ? 'The desktop you are on'
                  : column.key === 'all'
                    ? undefined
                    : `Switch to ${column.name}`
              }
              disabled={column.key === 'all'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => switchTo(column.key)}
              onContextMenu={(event) => {
                if (column.key === 'all') return;
                event.preventDefault();
                event.stopPropagation();
                openMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    {
                      label: column.current ? 'You are on this desktop' : 'Switch to this desktop',
                      icon: <MonitorUp />,
                      disabled: column.current,
                      action: () => switchTo(column.key),
                    },
                  ],
                });
              }}
            >
              <Wallpaper file={column.wallpaper} zoom={camera.zoom} />
              <span className="cd-name">{column.name}</span>
              {column.current && <span className="cd-badge">Current</span>}
            </button>
            <div className="cd-windows" style={{ maxHeight: bodyHeight - 16 - columnHeader }}>
              {column.windows.length ? (
                column.windows.map((w) => (
                  <button
                    key={w.id}
                    className="cd-window"
                    data-focused={w.focused || undefined}
                    data-minimized={w.minimized || undefined}
                    style={{ height: rowHeight }}
                    title={`${w.title}\n${w.app}${w.minimized ? ' · minimized' : ''}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => focus(w)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openMenu({ x: event.clientX, y: event.clientY, items: windowMenu(w) });
                    }}
                  >
                    <AppIcon exe={w.exe} size={26} zoom={camera.zoom} />
                    <span className="cd-text">
                      <span className="cd-title">{w.title}</span>
                      <span className="cd-app">
                        {w.app}
                        {w.minimized ? ' · minimized' : ''}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="cd-empty">No windows</p>
              )}
            </div>
          </section>
        ))}
      </div>
    );

  const origin = localToWorld(o, { x: 0, y: 0 });
  const windowCount = live?.windows.length ?? 0;
  return (
    <section
      className="canvas-folder canvas-desktops"
      data-file-id={o.id}
      data-selected={active || undefined}
      aria-label="Desktops"
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: o.width,
        height: o.height,
        transform: `scale(${camera.zoom}) rotate(${o.rotation || 0}deg)`,
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
        forward(event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        select(o.id);
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
      <header className="cf-header">
        <span className="cf-title-icon">
          <Monitor size={18} />
        </span>
        <span className="cf-title">Desktops</span>
      </header>
      <div className="cf-body cd-body" style={{ height: bodyHeight }}>
        {content}
      </div>
      <footer className="cf-footer">
        <span>
          {live
            ? `${desktops.length === 1 ? '1 desktop' : `${desktops.length} desktops`} · ${
                windowCount === 1 ? '1 window' : `${windowCount} windows`
              }${desktops.length === 1 ? ' · Win+Ctrl+D adds a desktop' : ''}`
            : ''}
        </span>
        <span className="cf-status">{status}</span>
      </footer>
    </section>
  );
}
