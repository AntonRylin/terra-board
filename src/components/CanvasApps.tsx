// App frames (type 'file', kind 'app'): a running program inside the board.
// Its real window waits hidden just behind Terra's window, and the frame shows
// a live picture of it (captured by Windows while the frame is on screen).
// Terra is the app's mouse and keyboard: pointer, wheel and keys on the frame
// are sent to the hidden window as the input Windows would deliver, and it is
// told it has the focus, so the app is used in place and never comes forward.
// "Open as a window" lays the real window over the frame instead, for apps
// that ignore such input. Deleting the frame, closing the board or Terra
// gives the window back as it was. The board stores the program only.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { AppWindow, Check, ExternalLink, Play, X } from 'lucide-react';
import type { Camera, CanvasObject } from '../model';
import { localToWorld, worldToLocal } from '../canvas/transform';
import {
  appLabelHeight,
  fileLinkLabel,
  type AppInputEvent,
  type FileSource,
} from '../canvas/file-link';
import { AppIcon } from './CanvasDesktops';
import { appWindowFor, isAppWindowBound, refreshDesktops, useDesktops } from './desktop-windows';
import { useFileIcons } from './file-icons';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Captures running at once; frames beyond show the app's icon until one stops.
const captureLimit = 6;
const captures = new Set<string>();
// Keys Windows marks as extended (the arrows and the block above them, and
// the right-hand Ctrl and Alt).
const extendedKeys = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Insert',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'NumpadEnter',
  'NumpadDivide',
  'ControlRight',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'ContextMenu',
]);

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
  // Used in place: Terra is the app's mouse and keyboard. The real window
  // stays hidden behind Terra; what happens on the frame is sent to it as the
  // input Windows itself would deliver, and it is told it has the focus.
  const section = useRef<HTMLElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const winRef = useRef(win);
  winRef.current = win;
  const send = (event: AppInputEvent) => {
    const target = winRef.current;
    if (files && target) files.appInput({ id: target.id, event });
  };
  // A spot of the window's picture from a pointer on the screen, in
  // ten-thousandths of the picture (zoom and rotation allowed for).
  const spotOf = (clientX: number, clientY: number) => {
    const parent = section.current?.offsetParent?.getBoundingClientRect();
    if (!parent) return null;
    const local = worldToLocal(o, {
      x: (clientX - parent.left - camera.x) / camera.zoom,
      y: (clientY - parent.top - camera.y) / camera.zoom,
    });
    return {
      x: Math.round((local.x / o.width) * 10000),
      y: Math.round(((local.y - appLabelHeight) / bodyHeight) * 10000),
    };
  };
  // Mouse buttons and keys held, as Windows passes them with mouse messages.
  const mouseKeys = (e: { buttons: number; shiftKey: boolean; ctrlKey: boolean }) =>
    (e.buttons & 1 ? 1 : 0) |
    (e.buttons & 2 ? 2 : 0) |
    (e.buttons & 4 ? 0x10 : 0) |
    (e.shiftKey ? 4 : 0) |
    (e.ctrlKey ? 8 : 0);
  const focusApp = () => {
    keys.current?.focus({ preventScroll: true });
    if (focusedRef.current) return;
    focusedRef.current = true;
    setFocused(true);
    send({ type: 'focus', on: true });
  };
  const blurApp = () => {
    if (!focusedRef.current) return;
    focusedRef.current = false;
    setFocused(false);
    send({ type: 'focus', on: false });
    // A menu or list the app opened would otherwise stay over the board.
    const target = winRef.current;
    if (files && target)
      void files.appPopup({ id: target.id }).then((open) => {
        if (!open) return;
        send({ type: 'key', vk: 0x1b, down: true, mods: 0 });
        send({ type: 'key', vk: 0x1b, down: false, mods: 0 });
      });
  };
  useEffect(() => () => blurApp(), []);
  // Pointer moves go once per frame, the newest only.
  const move = useRef<{ x: number; y: number; keys: number } | null>(null);
  const moveFrame = useRef(0);
  const flushMove = () => {
    cancelAnimationFrame(moveFrame.current);
    moveFrame.current = 0;
    const m = move.current;
    move.current = null;
    if (m) send({ type: 'mouse', kind: 'move', ...m });
  };
  const lastDown = useRef({ at: 0, x: 0, y: 0, button: -1 });
  const inPlace = !!win && !live && !win.minimized;
  const pointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!win || live || e.button > 2) return;
    e.preventDefault();
    e.stopPropagation();
    if (win.minimized) {
      // Back from the taskbar into the board.
      void park(win.id).then(() => refreshDesktops(300));
      focusApp();
      return;
    }
    const spot = spotOf(e.clientX, e.clientY);
    if (!spot) return;
    focusApp();
    e.currentTarget.setPointerCapture(e.pointerId);
    flushMove();
    const now = performance.now(),
      last = lastDown.current;
    const double =
      last.button === e.button &&
      now - last.at < 500 &&
      Math.hypot(e.clientX - last.x, e.clientY - last.y) < 5;
    lastDown.current = double
      ? { at: 0, x: 0, y: 0, button: -1 }
      : { at: now, x: e.clientX, y: e.clientY, button: e.button };
    send({
      type: 'mouse',
      kind: double ? 'double' : 'down',
      ...spot,
      button: e.button,
      keys: mouseKeys(e),
    });
  };
  const pointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!inPlace) return;
    const spot = spotOf(e.clientX, e.clientY);
    if (!spot) return;
    move.current = { ...spot, keys: mouseKeys(e) };
    if (!moveFrame.current) moveFrame.current = requestAnimationFrame(flushMove);
  };
  const pointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!inPlace || e.button > 2) return;
    e.stopPropagation();
    flushMove();
    const spot = spotOf(e.clientX, e.clientY);
    if (spot) send({ type: 'mouse', kind: 'up', ...spot, button: e.button, keys: mouseKeys(e) });
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // The wheel scrolls the app (Ctrl+wheel still zooms the board).
  const wheelRest = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const element = body.current;
    if (!element || !inPlace) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const spot = spotOf(e.clientX, e.clientY);
      if (!spot) return;
      const unit = e.deltaMode === 1 ? 33.3 : e.deltaMode === 2 ? 1000 : 1;
      // One notch is about 100 pixels here and 120 units in Windows.
      const rest = wheelRest.current;
      rest.y += (-e.deltaY * unit * 120) / 100;
      rest.x += (e.deltaX * unit * 120) / 100;
      const dy = Math.trunc(rest.y),
        dx = Math.trunc(rest.x);
      rest.y -= dy;
      rest.x -= dx;
      const held = (e.shiftKey ? 4 : 0) | (e.ctrlKey ? 8 : 0);
      if (dy) send({ type: 'mouse', kind: 'wheel', ...spot, delta: dy, keys: held });
      if (dx) send({ type: 'mouse', kind: 'hwheel', ...spot, delta: dx, keys: held });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });
  // Keys go to the app while it has the focus; typed text (input methods
  // and dead keys too) comes from the hidden field as characters.
  const composing = useRef(false);
  const textKey = (e: KeyboardEvent<HTMLTextAreaElement>) =>
    e.key.length === 1 && (!(e.ctrlKey || e.altKey || e.metaKey) || (e.ctrlKey && e.altKey));
  const modifiers = (e: KeyboardEvent<HTMLTextAreaElement>) =>
    (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0);
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || composing.current || e.key === 'Process' || e.key === 'Dead')
      return;
    if (textKey(e)) return;
    e.preventDefault();
    if (e.keyCode)
      send({
        type: 'key',
        vk: e.keyCode,
        extended: extendedKeys.has(e.code),
        down: true,
        mods: modifiers(e),
      });
  };
  const keyUp = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (composing.current || textKey(e)) return;
    e.preventDefault();
    if (e.keyCode)
      send({
        type: 'key',
        vk: e.keyCode,
        extended: extendedKeys.has(e.code),
        down: false,
        mods: modifiers(e),
      });
  };
  const typed = (field: HTMLTextAreaElement) => {
    if (field.value) send({ type: 'text', text: field.value });
    field.value = '';
  };

  // The board's own double-click (see Whiteboard activate) gives it the keys.
  useEffect(() => {
    const request = (event: Event) => {
      if ((event as CustomEvent<string>).detail === o.id && win && !live) focusApp();
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
                ? `${name} is minimized. Click to bring it back here.`
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
      ref={section}
      className="canvas-app"
      data-file-id={o.id}
      data-selected={active || undefined}
      data-live={live ? true : undefined}
      data-focused={focused || undefined}
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
        // The name moves and selects the frame; a running app takes its own presses.
        if (target.closest('.ca-label') || !win) forward(event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        // Inside a running app, the app's own menu (sent as a right-click).
        if (win && (event.target as HTMLElement).closest('.ca-body')) {
          event.stopPropagation();
          return;
        }
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
                title="Open as a window (for apps that don't respond in the board)"
                aria-label="Open as a window"
                onClick={() => use(null)}
              >
                <ExternalLink size={14} />
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
      <div
        ref={body}
        className="ca-body"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onPointerLeave={(e) => {
          if (inPlace && !e.buttons) {
            flushMove();
            send({ type: 'mouse', kind: 'leave', x: 0, y: 0 });
          }
        }}
        onDoubleClick={(e) => win && e.stopPropagation()}
      >
        {content}
        {win && (
          <textarea
            ref={keys}
            className="ca-keys"
            aria-label={`Type into ${name}`}
            tabIndex={-1}
            onKeyDown={keyDown}
            onKeyUp={keyUp}
            onInput={(e) => {
              if (!composing.current && !(e.nativeEvent as InputEvent).isComposing)
                typed(e.currentTarget);
            }}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={(e) => {
              composing.current = false;
              typed(e.currentTarget);
            }}
            onBlur={blurApp}
          />
        )}
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
