// App frames (type 'file', kind 'app'): a running program's window on the
// board. While nobody uses it, the board shows a live picture of the window
// (captured by Windows, only while the frame is on screen). Using it lays the
// real window exactly over the frame, owned by Terra's window, so typing,
// scrolling and video are the app's own; any click back on the board hands
// the window back to where it was. The board stores the program, never the
// window or what it shows.
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { AppWindow, Check, MousePointerClick, Play, X } from 'lucide-react';
import type { Camera, CanvasObject } from '../model';
import { localToWorld } from '../canvas/transform';
import { fileLinkLabel, folderHeader, type FileSource } from '../canvas/file-link';
import { AppIcon } from './CanvasDesktops';
import { appWindowFor, refreshDesktops, releaseAppWindow, useDesktops } from './desktop-windows';
import { useFileIcons } from './file-icons';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Captures running at once; frames beyond show the app's icon until one stops.
const captureLimit = 6;
const captures = new Set<string>();

export function AppFrame({
  object: o,
  camera,
  active,
  host,
  select,
  forward,
  onError,
}: {
  object: CanvasObject;
  camera: Camera;
  active: boolean;
  host: HTMLDivElement | null;
  select: (id: string) => void;
  forward: (event: PointerEvent) => void;
  onError: (message: string) => void;
}) {
  useFileIcons();
  const files = window.canvas?.files;
  const link = o.file!;
  const state = useDesktops();
  const name = fileLinkLabel(link, o.text);
  const sourceKey = JSON.stringify([link.root, link.path]);
  // The program's full path on this computer.
  const [exe, setExe] = useState<string | null | false>(null);
  useEffect(() => {
    if (!files) return;
    const source: FileSource = link.root
      ? { root: link.root, path: link.path }
      : { path: link.path };
    void files
      .list({ source })
      .then((listing) => setExe(listing.state === 'missing' ? false : listing.dir))
      .catch(() => setExe(false));
  }, [files, sourceKey]);
  const windows = state?.supported ? state.windows : [];
  const win = appWindowFor(o.id, exe || null, windows);
  useEffect(() => () => releaseAppWindow(o.id), [o.id]);

  // The live picture.
  const video = useRef<HTMLVideoElement>(null);
  const [captureError, setCaptureError] = useState('');
  const [capturing, setCapturing] = useState(false);
  const shown = camera.zoom * o.width > 80;
  const canCapture = !!win && !win.minimized && shown;
  useEffect(() => {
    if (!canCapture || !win) return;
    if (captures.size >= captureLimit && !captures.has(o.id)) return;
    captures.add(o.id);
    let stream: MediaStream | null = null,
      cancelled = false;
    setCaptureError('');
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: `window:${win.id}:0`,
            maxWidth: 2560,
            maxHeight: 1600,
            maxFrameRate: 30,
          },
        } as MediaTrackConstraints,
      })
      .then((s) => {
        if (cancelled) s.getTracks().forEach((t) => t.stop());
        else {
          stream = s;
          if (video.current) video.current.srcObject = s;
          setCapturing(true);
        }
      })
      .catch((error) => !cancelled && setCaptureError(message(error)));
    // A hidden Terra window needs no picture.
    const visibility = () =>
      stream?.getVideoTracks().forEach((t) => (t.enabled = document.visibilityState === 'visible'));
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelled = true;
      captures.delete(o.id);
      document.removeEventListener('visibilitychange', visibility);
      stream?.getTracks().forEach((t) => t.stop());
      if (video.current) video.current.srcObject = null;
      setCapturing(false);
    };
  }, [canCapture, win?.id]);

  // Using the app: its real window over the frame.
  const body = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<string | null>(null);
  const liveRef = useRef<string | null>(null);
  liveRef.current = live;
  const rotated = !!(o.rotation && Math.round(o.rotation) % 360);
  const place = (activate: boolean) => {
    const r = body.current?.getBoundingClientRect();
    if (!files || !win || !r) return Promise.resolve();
    return files.dockWindow({
      id: win.id,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      activate,
    });
  };
  const use = () => {
    if (!files || !win || liveRef.current) return;
    if (rotated) {
      onError('Straighten the frame to use the app in it.');
      return;
    }
    setLive(win.id);
    liveRef.current = win.id;
    place(true).catch((error) => {
      setLive(null);
      onError(message(error));
    });
  };
  const stop = () => {
    if (!files || !live) return;
    const id = live;
    setLive(null);
    void files.undockWindow({ id }).catch(() => {});
  };
  // Any press on the board (outside the app's window) gives it back.
  useEffect(() => {
    if (!live || !files) return;
    const press = (event: globalThis.PointerEvent) => {
      if ((event.target as HTMLElement).closest(`[data-file-id="${o.id}"] .ca-keep`)) return;
      stop();
    };
    const off = files.onUndocked((id) => id === live && setLive(null));
    window.addEventListener('pointerdown', press, true);
    return () => {
      off();
      window.removeEventListener('pointerdown', press, true);
    };
  }, [live]);
  // The frame moved, resized or the board zoomed while in use: follow it.
  useEffect(() => {
    if (!live) return;
    const frame = requestAnimationFrame(() => void place(false).catch(() => {}));
    return () => cancelAnimationFrame(frame);
  }, [live, camera.x, camera.y, camera.zoom, o.x, o.y, o.width, o.height]);
  // Gone from the board, or its window closed: hand it back.
  useEffect(() => {
    if (live && win?.id !== live) stop();
  }, [win?.id]);
  useEffect(
    () => () => {
      if (liveRef.current) void files?.undockWindow({ id: liveRef.current }).catch(() => {});
    },
    [],
  );
  // The board's own double-click (see Whiteboard activate) asks to use it.
  useEffect(() => {
    const request = (event: Event) => {
      if ((event as CustomEvent<string>).detail === o.id) use();
    };
    window.addEventListener('terra-use-app', request);
    return () => window.removeEventListener('terra-use-app', request);
  });

  const start = () => {
    if (!files || !exe) return;
    void files
      .open({ path: exe })
      .then(() => refreshDesktops(1500))
      .catch((error) => onError(message(error)));
  };
  const closeApp = () => {
    if (!files || !win) return;
    stop();
    void files
      .closeWindow({ id: win.id })
      .then(() => refreshDesktops(600))
      .catch((error) => onError(message(error)));
  };

  let content: ReactNode;
  if (!files || (state && !state.supported))
    content = (
      <div className="cf-message">
        <AppWindow size={36} strokeWidth={1.5} />
        <p>Apps on the board run in Terra Board for Windows.</p>
      </div>
    );
  else if (exe === false)
    content = (
      <div className="cf-message">
        <AppWindow size={36} strokeWidth={1.5} />
        <p>{name} isn’t installed on this computer.</p>
      </div>
    );
  else if (!state || exe === null) content = <div className="cf-message">Looking for {name}…</div>;
  else if (!win)
    content = (
      <div className="cf-message">
        <AppIcon exe={exe} size={56} zoom={camera.zoom} />
        <p>{name} isn’t running.</p>
        <button
          className="button ca-keep"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={start}
        >
          <Play size={15} /> Start {name}
        </button>
      </div>
    );
  else
    content = (
      <>
        <video ref={video} className="ca-video" autoPlay muted playsInline />
        {(win.minimized || !shown || captureError || !capturing) && !live && (
          <div className="cf-message ca-cover">
            <AppIcon exe={win.exe} size={56} zoom={camera.zoom} />
            <p>
              {win.minimized
                ? `${name} is minimized. Use it to bring it back.`
                : captureError
                  ? `Windows didn’t share a picture of ${name} (${captureError}).`
                  : name}
            </p>
          </div>
        )}
        {live && (
          <div className="cf-message ca-cover ca-live">Using {name}. Click the board to stop.</div>
        )}
      </>
    );

  const origin = localToWorld(o, { x: 0, y: 0 });
  return (
    <section
      className="canvas-folder canvas-app"
      data-file-id={o.id}
      data-selected={active || undefined}
      data-live={live ? true : undefined}
      aria-label={name}
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
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        event.stopPropagation();
        use();
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
          {exe ? <AppIcon exe={exe} size={20} zoom={camera.zoom} /> : <AppWindow size={18} />}
        </span>
        <span className="cf-title" title={win?.title}>
          {name}
          {win && win.title !== name && <span className="cf-crumb"> · {win.title}</span>}
        </span>
        {win &&
          (live ? (
            <button
              className="cf-button ca-keep ca-use"
              title="Done: back to the board"
              aria-label="Done"
              onClick={stop}
            >
              <Check size={17} />
            </button>
          ) : (
            <button
              className="cf-button ca-use"
              title="Use the app (or double-click it)"
              aria-label="Use the app"
              onClick={use}
            >
              <MousePointerClick size={17} />
            </button>
          ))}
        {win && (
          <button
            className="cf-button ca-keep"
            title={`Close ${name}`}
            aria-label={`Close ${name}`}
            onClick={closeApp}
          >
            <X size={17} />
          </button>
        )}
      </header>
      <div ref={body} className="ca-body" style={{ height: Math.max(20, o.height - folderHeader) }}>
        {content}
      </div>
    </section>
  );
}

/** Asks an app frame to start being used (the board's double-click). */
export function requestAppUse(id: string) {
  window.dispatchEvent(new CustomEvent('terra-use-app', { detail: id }));
}
