import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from 'react';
import { LocateFixed, PinOff } from 'lucide-react';
import type { CanvasObject, Document } from '../model';
import type { Engine } from '../canvas/engine';
import { invoke, mediaUrl } from '../bridge';
import { SaveQueue } from '../canvas/save-queue';
import { pictureBounds } from '../canvas/frame-label';
import {
  dragPin,
  fitAspect,
  pinBar,
  pinKey,
  pinKind,
  pinMinimum,
  pinnedObjects,
  clampPin,
  screenPins,
  setScreenPins,
  subscribeScreenPins,
  unionBounds,
  type ScreenPin,
} from '../canvas/pins';
import { ListCard } from './CanvasLists';
import { PaperName, PinnedPaperPages } from './CanvasPapers';
import './pinned-views.css';

type Board = { name: string; objects: CanvasObject[] | null; revision: number };
type Size = { width: number; height: number };

// Live pictures outlast the board they were drawn on, so switching boards
// shows pins at once; edits to boards that are not open are saved from here.
const pictures = new Map<string, { content: string; canvas: HTMLCanvasElement; pixels: number }>();
const queues = new Map<string, { queue: SaveQueue; busy: boolean }>();
let drawing: Promise<unknown> = Promise.resolve();

const typeNames: Partial<Record<CanvasObject['type'], string>> = {
  text: 'Text',
  note: 'Note',
  rect: 'Shape',
  ellipse: 'Shape',
  frame: 'Frame',
  image: 'Image',
  video: 'Video',
  document: 'File',
  link: 'Link',
  arrow: 'Arrow',
  highlight: 'Highlight',
  list: 'Checklist',
  paper: 'Document',
  html: 'Web page',
  browser: 'Website',
};
const objectName = (o: CanvasObject) =>
  (o.type === 'paper'
    ? o.documentTitle
    : o.type === 'image'
      ? o.imageTitle || o.album?.name
      : o.type === 'document'
        ? o.documentTitle || o.text
        : o.type === 'arrow' || o.type === 'highlight'
          ? undefined
          : o.text
  )
    ?.replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) ||
  typeNames[o.type] ||
  'Item';

const handles = ['e', 's', 'w', 'se', 'sw'];

function PinPicture({
  pin,
  objects,
  engine,
  height,
}: {
  pin: ScreenPin;
  objects: CanvasObject[];
  engine: Engine | null;
  height: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const key = pinKey(pin);
  const content = useMemo(() => JSON.stringify(objects), [objects]);
  const [empty, setEmpty] = useState(false);
  const pixels = Math.min(
    4096,
    Math.ceil(Math.max(pin.width, height) * (window.devicePixelRatio || 1)),
  );
  useLayoutEffect(() => {
    const cached = pictures.get(key);
    if (cached && box.current && cached.canvas.parentElement !== box.current)
      box.current.replaceChildren(cached.canvas);
  }, [key]);
  useEffect(() => {
    if (!engine) return;
    const cached = pictures.get(key);
    // A resize redraws only once the picture would look soft or wastefully large.
    if (cached?.content === content && pixels <= cached.pixels * 1.15 && pixels >= cached.pixels * 0.5)
      return;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        drawing = drawing
          .then(async () => {
            if (cancelled) return;
            const canvas = await engine.pinPicture(
              objects,
              { width: pixels, height: pixels },
              mediaUrl,
            );
            if (cancelled) {
              if (canvas) canvas.width = canvas.height = 1;
              return;
            }
            setEmpty(!canvas);
            if (!canvas) return;
            const previous = pictures.get(key);
            pictures.set(key, { content, canvas, pixels });
            box.current?.replaceChildren(canvas);
            if (previous && previous.canvas !== canvas)
              previous.canvas.width = previous.canvas.height = 1;
          })
          .catch(() => {});
      },
      cached ? 160 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [engine, key, content, pixels]);
  return (
    <div className="screen-pin-picture" ref={box} style={{ height }} data-empty={empty}>
      {empty && <span className="screen-pin-note">Hidden by a spoiler</span>}
    </div>
  );
}

function PinnedList({
  object: o,
  width,
  height,
  update,
  editing,
  setEditing,
  move,
}: {
  object: CanvasObject;
  width: number;
  height: number;
  update: (o: CanvasObject) => void;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  move: (event: PointerEvent) => void;
}) {
  const zoom = (width - 12) / o.width;
  // Shown upright at the pin's width; saving keeps the board's rotation.
  const shown = { ...o, rotation: 0 };
  return (
    <div className="screen-pin-scroll" style={{ height }}>
      <div className="screen-pin-list" style={{ height: o.height * zoom + 12 }}>
        <ListCard
          object={shown}
          camera={{ x: 6 - o.x * zoom, y: 2 - o.y * zoom, zoom }}
          update={(next) => {
            const { rotation: _, ...rest } = next;
            update(o.rotation ? { ...rest, rotation: o.rotation } : rest);
          }}
          select={() => {}}
          forward={move}
          active={false}
          editing={editing}
          setEditing={setEditing}
        />
      </div>
    </div>
  );
}

function Pin({
  pin,
  board,
  current,
  engine,
  view,
  editable,
  editing,
  setEditing,
  update,
  fit,
  open,
}: {
  pin: ScreenPin;
  board: Board | undefined;
  current: boolean;
  engine: Engine | null;
  view: Size;
  editable: boolean;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  update: (o: CanvasObject) => void;
  fit: (o: CanvasObject) => void;
  open: () => void;
}) {
  const all = board?.objects;
  const o = all?.find((item) => item.id === pin.objectId);
  const kind = o ? pinKind(o) : 'picture';
  const minimum = pinMinimum[kind];
  const previous = useRef<CanvasObject[]>([]);
  const objects = useMemo(() => {
    if (!all || kind !== 'picture') return previous.current;
    const next = pinnedObjects(all, pin.objectId);
    // Unchanged objects keep the same picture.
    if (next.length === previous.current.length && next.every((x, i) => x === previous.current[i]))
      return previous.current;
    return (previous.current = next);
  }, [all, kind, pin.objectId]);
  const aspect = useMemo(() => {
    if (kind !== 'picture' || !objects.length) return undefined;
    const b = unionBounds(objects.map(pictureBounds));
    return b.width / b.height;
  }, [kind, objects]);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const replace = (next: ScreenPin) =>
    setScreenPins((list) => list.map((item) => (pinKey(item) === pinKey(next) ? next : item)));
  // The original changed shape on its board: the picture follows.
  useEffect(() => {
    if (!aspect) return;
    const shown = pin.width / Math.max(1, pin.height - pinBar);
    if (Math.abs(shown - aspect) / aspect > 0.01)
      replace(clampPin(fitAspect(pin, aspect, true), view, minimum));
  }, [aspect]);
  const drag = (event: PointerEvent, handle: string | null) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY },
      from = pinRef.current;
    const moved = (e: globalThis.PointerEvent) =>
      replace(
        dragPin(from, handle, e.clientX - start.x, e.clientY - start.y, view, minimum, aspect),
      );
    const done = () => {
      target.removeEventListener('pointermove', moved);
      target.removeEventListener('pointerup', done);
      target.removeEventListener('pointercancel', done);
    };
    target.addEventListener('pointermove', moved);
    target.addEventListener('pointerup', done);
    target.addEventListener('pointercancel', done);
  };
  const body = pin.height - pinBar;
  const missing = board && (!all || !o);
  const title = o ? objectName(o) : board ? 'Unavailable' : 'Loading…';
  const canEdit = editable && !!o && !o.locked;
  return (
    <section
      className="screen-pin"
      data-pin-key={pinKey(pin)}
      data-kind={kind}
      data-editing={editing}
      aria-label={`Pinned ${title}`}
      style={{ left: pin.left, top: pin.top, width: pin.width, height: pin.height }}
      onPointerDownCapture={() =>
        // The pin pressed last comes to the front.
        setScreenPins((list) =>
          pinKey(list[list.length - 1] || pin) === pinKey(pin)
            ? list
            : [...list.filter((item) => pinKey(item) !== pinKey(pin)), pin],
        )
      }
    >
      <header className="screen-pin-bar" onPointerDown={(event) => drag(event, null)}>
        {o?.type === 'paper' && canEdit ? (
          <PaperName
            object={o}
            update={update}
            className="screen-pin-title"
            onPress={(event) => drag(event, null)}
          />
        ) : (
          <span className="screen-pin-title" title={title}>
            {title}
          </span>
        )}
        {!current && board?.name && <span className="screen-pin-board">{board.name}</span>}
        <span className="screen-pin-space" />
        {o && (
          <button
            className="icon-button"
            aria-label="Show on its board"
            title="Show on its board"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={open}
          >
            <LocateFixed size={15} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Unpin from screen"
          title="Unpin from screen"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() =>
            setScreenPins((list) => list.filter((item) => pinKey(item) !== pinKey(pin)))
          }
        >
          <PinOff size={15} />
        </button>
      </header>
      {missing ? (
        <div className="screen-pin-missing" style={{ height: body }}>
          <span className="screen-pin-note">
            {all ? 'The original is no longer on its board.' : 'Its board is unavailable.'}
          </span>
        </div>
      ) : o?.type === 'paper' ? (
        <PinnedPaperPages
          object={o}
          width={pin.width}
          height={body}
          update={(next) => canEdit && update(next)}
          fit={(next) => canEdit && fit(next)}
          editing={canEdit && editing}
          setEditing={(next) => canEdit && setEditing(next)}
        />
      ) : o?.type === 'list' ? (
        <PinnedList
          object={o}
          width={pin.width}
          height={body}
          update={(next) => canEdit && update(next)}
          editing={canEdit && editing}
          setEditing={(next) => canEdit && setEditing(next)}
          move={(event) => drag(event, null)}
        />
      ) : (
        <div
          className="screen-pin-content"
          onPointerDown={(event) => drag(event, null)}
          onDoubleClick={() => o && open()}
          title={o ? 'Double-click to show it on its board' : undefined}
        >
          <PinPicture pin={pin} objects={objects} engine={engine} height={body} />
        </div>
      )}
      {handles.map((handle) => (
        <i
          key={handle}
          className="screen-pin-handle"
          data-handle={handle}
          onPointerDown={(event) => drag(event, handle)}
        />
      ))}
    </section>
  );
}

// Objects pinned to the screen, from this board and any other: each a live
// copy floating above the board, moved and resized on screen only.
export default function PinnedViews({
  boardId,
  boardName,
  engine,
  objects,
  readOnly,
  update,
  fit,
  open,
  onError,
}: {
  boardId: string;
  boardName: string;
  engine: Engine | null;
  // The open board's objects; a new array after every edit.
  objects: CanvasObject[] | null;
  readOnly: boolean;
  update: (o: CanvasObject) => void;
  fit: (o: CanvasObject) => void;
  open: (boardId: string, objectId: string) => void;
  onError: (message: string) => void;
}) {
  const pins = useSyncExternalStore(subscribeScreenPins, screenPins);
  const layer = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Size>({ width: 0, height: 0 });
  const [boards, setBoards] = useState(() => new Map<string, Board>());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const otherBoards = useMemo(
    () => [...new Set(pins.map((pin) => pin.boardId))].filter((id) => id !== boardId).sort(),
    [pins, boardId],
  );
  useLayoutEffect(() => {
    const element = layer.current!;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      if (!next.width || !next.height) return;
      setView(next);
      // A smaller window keeps every pin in reach.
      setScreenPins((list) => {
        const fitted = list.map((pin) => clampPin(pin, next, { width: 80, height: pinBar + 48 }));
        return fitted.every((pin, i) => pin === list[i] || JSON.stringify(pin) === JSON.stringify(list[i]))
          ? list
          : fitted;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Pins from boards that are not open follow their boards' saved state.
  const otherKey = otherBoards.join('\n');
  useEffect(() => {
    if (!otherBoards.length) return;
    let stopped = false;
    const load = async () => {
      for (const id of otherBoards) {
        // A write still on its way would be undone by an older read.
        if (queues.get(id)?.busy) continue;
        let board: Board;
        try {
          const d = await invoke<Document>('loadBoard', { id });
          board = {
            name: d.board.name,
            objects: d.board.trashed ? null : d.objects,
            revision: d.revision,
          };
        } catch {
          board = { name: '', objects: null, revision: 0 };
        }
        if (stopped || queues.get(id)?.busy) return;
        setBoards((current) => {
          const known = current.get(id);
          if (known && JSON.stringify(known) === JSON.stringify(board)) return current;
          return new Map(current).set(id, board);
        });
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [otherKey]);
  // Linked frames inside pinned frames draw from their own boards too.
  useEffect(() => {
    for (const [id, board] of boards) engine?.setFrameBoard(id, board.objects);
  }, [engine, boards]);
  useEffect(() => {
    if (!editingKey) return;
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.rich-format-bar')) return;
      if (target.closest<HTMLElement>('.screen-pin')?.dataset.pinKey !== editingKey)
        setEditingKey(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [editingKey]);
  const writeElsewhere = (id: string, o: CanvasObject) => {
    const board = boards.get(id);
    if (!board?.objects) return;
    let entry = queues.get(id);
    if (!entry) {
      const created: { queue: SaveQueue; busy: boolean } = {
        busy: false,
        queue: new SaveQueue(
          id,
          board.revision,
          (state, message) => {
            created.busy = state !== 'saved' && state !== 'error';
            if (state === 'error' && message) onError(message);
          },
          (args) => invoke('patchBoard', { ...args }),
        ),
      };
      queues.set(id, (entry = created));
    }
    entry.busy = true;
    entry.queue.enqueue({ upserts: [o], deleted: [] });
    // Saved at once, so opening that board right after shows the change.
    entry.queue.flush().catch(() => {});
    setBoards((current) =>
      new Map(current).set(id, {
        ...board,
        objects: board.objects!.map((item) => (item.id === o.id ? o : item)),
      }),
    );
  };
  const shown = useMemo(() => {
    const map = new Map(boards);
    // The open board shows its pins once its canvas has loaded.
    if (objects) map.set(boardId, { name: boardName, objects, revision: 0 });
    else map.delete(boardId);
    return map;
  }, [boards, boardId, boardName, objects]);
  return (
    <div className="screen-pins" ref={layer}>
      {!!view.width &&
        pins.map((pin) => {
          const key = pinKey(pin);
          const current = pin.boardId === boardId;
          return (
            <Pin
              key={key}
              pin={pin}
              board={shown.get(pin.boardId)}
              current={current}
              engine={engine}
              view={view}
              editable={current ? !readOnly : true}
              editing={editingKey === key}
              setEditing={(editing) =>
                setEditingKey((now) => (editing ? key : now === key ? null : now))
              }
              update={(o) => (current ? update(o) : writeElsewhere(pin.boardId, o))}
              fit={(o) => (current ? fit(o) : writeElsewhere(pin.boardId, o))}
              open={() => open(pin.boardId, pin.objectId)}
            />
          );
        })}
    </div>
  );
}
