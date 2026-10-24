// App frames (type 'file', kind 'app'): a running program's window on the
// board. While nobody uses it, the real window waits hidden just behind
// Terra's window and the frame shows a live picture of it (captured by
// Windows, only while the frame is on screen). A click lays the real window
// exactly over the frame, owned by Terra's window, so typing, scrolling and
// video are the app's own; a click back on the board puts it behind again.
// Deleting the frame, closing the board or Terra gives the window back as it
// was. The board stores the program, never the window or what it shows.
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { AppWindow, Check, MousePointerClick, Play, X } from 'lucide-react';
import type { Camera, CanvasObject } from '../model';
import { localToWorld } from '../canvas/transform';
import { appLabelHeight, fileLinkLabel, type FileSource } from '../canvas/file-link';
import { AppIcon } from './CanvasDesktops';
import { appWindowFor, isAppWindowBound, refreshDesktops, useDesktops } from './desktop-windows';
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
  // The window stays this frame's while it is on the board (scrolled out of
  // view too); the board releases it when the frame is deleted or it closes.
  const win = appWindowFor(o.id, exe || null, windows);

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
            maxWidth: 3840,
            maxHeight: 2400,
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

  // Where the real window is. Not in use, it is parked: hidden just behind
  // Terra's window at the frame's size (at 100% zoom), so Windows keeps
  // drawing it for the picture. In use, it lies exactly over the frame.
  const body = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<string | null>(null);
  const liveRef = useRef<string | null>(null);
  liveRef.current = live;
  const rotated = !!(o.rotation && Math.round(o.rotation) % 360);
  const bodyHeight = Math.max(20, o.height - appLabelHeight);
  const area = () => {
    const r = body.current?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0
      ? { x: r.left, y: r.top, width: r.width, height: r.height }
      : null;
  };
  const park = (id: string) => {
    const rect = area();
    if (!files || !rect) return Promise.resolve();
    return files.parkWindow({ id, rect, size: { width: o.width, height: bodyHeight } });
  };
  const dock = (id: string, activate: boolean, click: { x: number; y: number } | null) => {
    const rect = area();
    if (!files || !rect) return Promise.resolve();
    return files.dockWindow({ id, rect, activate, click });
  };
  // Parked when the frame (or its window) appears, and again after the board,
  // the frame or Terra's window settles. A window someone minimized after it
  // was parked here stays minimized until the frame is clicked.
  const parkedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!files || !win || live) return;
    if (win.minimized && parkedFor.current === win.id) return;
    const first = parkedFor.current !== win.id;
    const timer = window.setTimeout(
      () => {
        parkedFor.current = win.id;
        void park(win.id)
          .then(() => first && refreshDesktops(300))
          .catch(() => {});
      },
      first ? 0 : 250,
    );
    return () => window.clearTimeout(timer);
  }, [win?.id, win?.minimized, live, camera.x, camera.y, camera.zoom, o.x, o.y, o.width, o.height]);

  // click: where on the screen a real click on the picture started it.
  const use = (click: { x: number; y: number } | null) => {
    if (!files || !win || liveRef.current) return;
    if (rotated) {
      onError('Straighten the frame to use the app in it.');
      return;
    }
    setLive(win.id);
    liveRef.current = win.id;
    // At 100% the window already has the frame's size, so the click that
    // started it goes on to what was clicked in the picture.
    const pass =
      click && capturing && !win.minimized && Math.abs(camera.zoom - 1) < 0.01 ? click : null;
    dock(win.id, true, pass).catch((error) => {
      setLive(null);
      liveRef.current = null;
      onError(message(error));
    });
  };
  const stop = () => {
    const id = liveRef.current;
    if (!files || !id) return;
    setLive(null);
    liveRef.current = null;
    void park(id).catch(() => {});
  };
  // Any press on the board (outside the app's window) puts it back behind.
  useEffect(() => {
    if (!live) return;
    const press = (event: globalThis.PointerEvent) => {
      if ((event.target as HTMLElement).closest(`[data-file-id="${o.id}"] .ca-keep`)) return;
      stop();
    };
    window.addEventListener('pointerdown', press, true);
    return () => window.removeEventListener('pointerdown', press, true);
  }, [live]);
  // In use while the frame moves or the board zooms: the window follows.
  useEffect(() => {
    if (!live) return;
    const frame = requestAnimationFrame(() => void dock(live, false, null).catch(() => {}));
    return () => cancelAnimationFrame(frame);
  }, [live, camera.x, camera.y, camera.zoom, o.x, o.y, o.width, o.height]);
  // Terra's window moved, resized or came back from being minimized.
  useEffect(
    () =>
      files?.onRepark(() => {
        if (liveRef.current) void dock(liveRef.current, false, null).catch(() => {});
        else if (win) void park(win.id).catch(() => {});
      }),
    [files, win?.id, o.x, o.y, o.width, o.height],
  );
  // Its window closed while in use.
  useEffect(() => {
    if (live && win?.id !== live) {
      setLive(null);
      liveRef.current = null;
    }
  }, [win?.id]);
  // Scrolled out of view or the board closing while in use: behind Terra again.
  useEffect(
    () => () => {
      // Unless the board already gave the window back (deleted or closing).
      if (liveRef.current && isAppWindowBound(o.id, liveRef.current))
        void park(liveRef.current).catch(() => {});
    },
    [],
  );
  // The board's own double-click (see Whiteboard activate) asks to use it.
  useEffect(() => {
    const request = (event: Event) => {
      if ((event as CustomEvent<string>).detail === o.id) use(null);
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
        <video
          ref={video}
          className="ca-video"
          autoPlay
          muted
          playsInline
          style={pictureCrop(win.width, win.height, win.border)}
        />
        {(win.minimized || !shown || captureError || !capturing) && !live && (
          <div className="cf-message ca-cover">
            <AppIcon exe={win.exe} size={56} zoom={camera.zoom} />
            <p>
              {win.minimized
                ? `${name} is minimized. Click to show it here.`
                : captureError
                  ? `Windows didn’t share a picture of ${name} (${captureError}).`
                  : name}
            </p>
          </div>
        )}
      </>
    );

  const origin = localToWorld(o, { x: 0, y: 0 });
  return (
    <section
      className="canvas-app"
      data-file-id={o.id}
      data-selected={active || undefined}
      data-live={live ? true : undefined}
      data-running={win ? true : undefined}
      aria-label={name}
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: o.width,
        height: o.height,
        transform: `scale(${camera.zoom}) rotate(${o.rotation || 0}deg)`,
      }}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.button !== 0 || target.closest('button')) return;
        if (target.closest('.ca-label')) {
          forward(event);
          return;
        }
        // A press on a running app selects it, and the click starts using it.
        if (win) {
          event.stopPropagation();
          select(o.id);
          return;
        }
        forward(event);
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (!win || target.closest('button') || !target.closest('.ca-body')) return;
        use(event.isTrusted ? { x: event.screenX, y: event.screenY } : null);
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
      <div className="ca-label" title={win?.title}>
        {exe ? <AppIcon exe={exe} size={18} zoom={camera.zoom} /> : <AppWindow size={16} />}
        <span className="ca-name">{name}</span>
        {win && win.title !== name && <span className="ca-window-title">{win.title}</span>}
        {win && (
          <span className="ca-actions">
            {live ? (
              <button
                className="ca-keep"
                title="Done: back to the board"
                aria-label="Done"
                onClick={stop}
              >
                <Check size={14} />
              </button>
            ) : (
              <button
                title="Use the app (or click it)"
                aria-label="Use the app"
                onClick={() => use(null)}
              >
                <MousePointerClick size={14} />
              </button>
            )}
            <button
              className="ca-keep"
              title={`Close ${name}`}
              aria-label={`Close ${name}`}
              onClick={closeApp}
            >
              <X size={14} />
            </button>
          </span>
        )}
      </div>
      <div ref={body} className="ca-body">
        {content}
      </div>
    </section>
  );
}

// A window's picture includes its invisible resize border; the video is
// enlarged and shifted so only what you see of the window fills the frame.
function pictureCrop(width: number, height: number, border?: [number, number, number, number]) {
  if (!width || !height || !border) return undefined;
  const [l, t, r, b] = border;
  return {
    left: `${(-l / width) * 100}%`,
    top: `${(-t / height) * 100}%`,
    width: `${((width + l + r) / width) * 100}%`,
    height: `${((height + t + b) / height) * 100}%`,
    inset: 'auto',
    objectFit: 'fill' as const,
  };
}

/** Asks an app frame to start being used (the board's double-click). */
export function requestAppUse(id: string) {
  window.dispatchEvent(new CustomEvent('terra-use-app', { detail: id }));
}
