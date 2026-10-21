import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  boardInfo,
  boardSyncs,
  type BoardInfo,
  type CloudStatus,
  type SharePerson,
} from '../bridge';
import type { Board, Library } from '../model';
import {
  boardPlace,
  mergePeople,
  placeText,
  relativeTime,
  roleText,
  sizeText,
} from './board-info-text';

type People = { state: 'loading' } | { state: 'error' } | { state: 'done'; people: SharePerson[] };

const showDelay = 350;
const hideDelay = 120;
const editing = (anchor: HTMLElement) =>
  !!anchor.querySelector('[contenteditable="plaintext-only"], [contenteditable="true"]');

/**
 * Where the open board lives, how big it is, when it was made and changed, and
 * who has access: shown while the pointer rests on the board name or icon.
 */
export default function BoardInfoCard({
  anchor,
  board,
  library,
  status,
  saved,
}: {
  anchor: RefObject<HTMLElement | null>;
  board: Board;
  library: Library;
  status: CloudStatus | null;
  /** All edits are saved; a change to it refreshes the numbers while open. */
  saved: boolean;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<BoardInfo | null>(null);
  const [syncs, setSyncs] = useState<boolean | undefined>(undefined);
  const [people, setPeople] = useState<People>({ state: 'loading' });

  useEffect(() => {
    const target = anchor.current,
      tip = card.current;
    if (!target || !tip) return;
    let showTimer: ReturnType<typeof setTimeout> | undefined,
      hideTimer: ReturnType<typeof setTimeout> | undefined;
    // After a click or Esc the card stays away until the pointer leaves.
    let suppressed = false,
      byFocus = false;
    const clear = () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
    const show = () => {
      clear();
      if (!editing(target)) setOpen(true);
    };
    const dismiss = () => {
      clear();
      byFocus = false;
      setOpen(false);
    };
    const hideSoon = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(dismiss, hideDelay);
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.buttons || suppressed) return;
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      showTimer = setTimeout(show, showDelay);
    };
    const leave = () => {
      suppressed = false;
      clearTimeout(showTimer);
      if (!byFocus) hideSoon();
    };
    const press = () => {
      suppressed = true;
      dismiss();
    };
    const focusIn = (event: FocusEvent) => {
      if (event.target === target && target.matches(':focus-visible')) {
        byFocus = true;
        show();
      } else dismiss();
    };
    const focusOut = (event: FocusEvent) => {
      if (!target.contains(event.relatedTarget as Node | null)) dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' &&
        !(event.target === target && ['Enter', ' ', 'F2'].includes(event.key))
      )
        return;
      suppressed = target.matches(':hover');
      dismiss();
    };
    const stay = () => clearTimeout(hideTimer);
    target.addEventListener('pointerenter', enter);
    target.addEventListener('pointerleave', leave);
    target.addEventListener('pointerdown', press, true);
    target.addEventListener('contextmenu', press, true);
    target.addEventListener('focusin', focusIn);
    target.addEventListener('focusout', focusOut);
    tip.addEventListener('pointerenter', stay);
    tip.addEventListener('pointerleave', hideSoon);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      clear();
      target.removeEventListener('pointerenter', enter);
      target.removeEventListener('pointerleave', leave);
      target.removeEventListener('pointerdown', press, true);
      target.removeEventListener('contextmenu', press, true);
      target.removeEventListener('focusin', focusIn);
      target.removeEventListener('focusout', focusOut);
      tip.removeEventListener('pointerenter', stay);
      tip.removeEventListener('pointerleave', hideSoon);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [anchor]);

  // A different board starts with nothing known.
  useEffect(() => setOpen(false), [board.id]);

  useEffect(() => {
    if (!open) {
      setInfo(null);
      setSyncs(undefined);
      return;
    }
    if (!saved) return;
    let current = true;
    boardInfo(board.id).then(
      (value) => current && setInfo(value),
      () => {},
    );
    boardSyncs(board.id).then(
      (value) => current && setSyncs(value),
      () => current && setSyncs(false),
    );
    return () => {
      current = false;
    };
  }, [open, board.id, board.updated, saved]);

  const cloud = window.canvas?.cloud;
  const place = boardPlace({
    boardId: board.id,
    folderId: board.folderId,
    library,
    configured: cloud ? status?.configured : false,
    librarySync: !!status?.library,
    syncs,
  });
  // Who has access is asked of the server once per opening.
  const owned = place?.kind === 'owner' ? place : null;
  const peopleKey = owned ? `${owned.board}:${owned.folder?.id || ''}` : '';
  useEffect(() => {
    if (!open || !owned || !cloud) return;
    let current = true;
    setPeople({ state: 'loading' });
    Promise.all([
      owned.board ? cloud.sharePeople('board', board.id) : null,
      owned.folder ? cloud.sharePeople('folder', owned.folder.id) : null,
    ]).then(
      (lists) =>
        current &&
        setPeople({
          state: 'done',
          people: mergePeople(...lists.map((list) => list?.people || [])),
        }),
      () => current && setPeople({ state: 'error' }),
    );
    return () => {
      current = false;
    };
  }, [open, board.id, peopleKey]);

  useLayoutEffect(() => {
    const tip = card.current,
      target = anchor.current;
    if (!tip) return;
    if (!open || !target?.isConnected) {
      if (tip.matches(':popover-open')) tip.hidePopover();
      return;
    }
    if (!tip.matches(':popover-open')) tip.showPopover();
    const r = target.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(r.bottom + 8, innerHeight - height - 8))}px`;
  });

  const date = (time: number) =>
    new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div
      ref={card}
      id="board-info-card"
      className="board-info-card"
      role="tooltip"
      popover="manual"
    >
      {open && (
        <>
          <dl>
            <dt>Where</dt>
            <dd>{place ? placeText(place) : '…'}</dd>
            <dt>Size</dt>
            <dd>{info ? sizeText(info) : '…'}</dd>
            <dt>Created</dt>
            <dd>{!info ? '…' : info.created ? date(info.created) : 'not recorded'}</dd>
            <dt>Last changed</dt>
            <dd>
              {info ? (
                <>
                  {relativeTime(info.updated)}{' '}
                  <span className="board-info-muted">{date(info.updated)}</span>
                </>
              ) : (
                '…'
              )}
            </dd>
            {place?.kind === 'received' && (
              <>
                <dt>People</dt>
                <dd>
                  <ul>
                    <li>{place.owner} — owner</li>
                    <li>You — {roleText(place.role)}</li>
                  </ul>
                </dd>
              </>
            )}
            {owned && (
              <>
                <dt>People</dt>
                <dd>
                  <ul>
                    <li>You — owner</li>
                    {people.state === 'loading' && (
                      <li className="board-info-muted">Loading people…</li>
                    )}
                    {people.state === 'error' && (
                      <li className="board-info-muted">Couldn’t load people</li>
                    )}
                    {people.state === 'done' &&
                      people.people.map((p) => (
                        <li key={p.id}>
                          {p.name} — {roleText(p.role)}
                        </li>
                      ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
          <p className="board-info-hint">Click to show or hide the board panel</p>
        </>
      )}
    </div>
  );
}
