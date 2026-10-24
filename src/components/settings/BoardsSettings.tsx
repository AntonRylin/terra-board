import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Cloud, HardDrive, Search, Users } from 'lucide-react';
import type { CloudStatus, SharePerson, ShareRole } from '../../bridge';
import type { Library } from '../../model';
import { PeopleList } from '../ShareDialog';
import { placeText } from '../board-info-text';
import { Group, Notice, Row, errorText, useNotice } from './controls';
import {
  countPlaces,
  placeBoards,
  plural,
  type PlaceGroup,
  type PlacedBoard,
} from './board-places';

type Filter = 'all' | PlaceGroup;
type Act = (job: () => Promise<unknown>, done?: string) => Promise<void>;
type Access = { shareId: string | null; people: SharePerson[] };
const none: Access = { shareId: null, people: [] };

function Tag({ item }: { item: PlacedBoard }) {
  if (item.group === 'received')
    return (
      <span className="board-tag received">
        <Users size={12} />
        From {item.place.kind === 'received' ? item.place.owner : 'someone'}
      </span>
    );
  if (item.group === 'cloud')
    return (
      <span className="board-tag cloud">
        <Cloud size={12} />
        {item.people ? `Cloud · ${plural(item.people, 'person', 'people')}` : 'Cloud'}
      </span>
    );
  return (
    <span className="board-tag local">
      <HardDrive size={12} />
      Local
    </span>
  );
}

// Who can open a board you own: people invited to the board, and people who reach it
// through a folder you share. Changing a role or removing someone takes effect on the
// server at once; their app drops the board on its next sync.
function BoardAccess({
  item,
  status,
  busy,
  act,
  onManageShare,
}: {
  item: PlacedBoard;
  status: CloudStatus;
  busy: boolean;
  act: Act;
  onManageShare?: (kind: 'folder' | 'board', id: string) => void;
}) {
  const cloud = window.canvas!.cloud;
  const [board, setBoard] = useState<Access | null>(null);
  const [folder, setFolder] = useState<Access>(none);
  const [error, setError] = useState('');
  const sharedFolder = item.place.kind === 'owner' && item.place.folder ? item.place.folder : null;

  const load = useCallback(async () => {
    try {
      setBoard(await cloud.sharePeople('board', item.board.id));
      setFolder(sharedFolder ? await cloud.sharePeople('folder', sharedFolder.id) : none);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [cloud, item.board.id, sharedFolder?.id]);
  useEffect(() => {
    void load();
  }, [load, status.shared]);

  const change = (access: Access, person: SharePerson, role: ShareRole) =>
    act(async () => {
      await cloud.setPersonRole(access.shareId!, person.id, role);
      await load();
    }, `${person.name} can ${role} now.`);
  const remove = (access: Access, person: SharePerson, what: string) =>
    act(async () => {
      await cloud.removePerson(access.shareId!, person.id);
      await load();
    }, `${person.name} no longer has access to ${what}. It disappears from their devices on their next sync.`);

  if (error) return <p className="st-row-problem">{error}</p>;
  if (!board) return <p className="server-note">Loading who has access…</p>;
  const nobody = !board.people.length && !folder.people.length;
  return (
    <div className="board-access">
      {nobody && (
        <p className="server-note">
          {item.place.kind === 'library'
            ? 'In your cloud library, so it syncs to every device you sign in on. Only you can open it.'
            : 'Shared, but nobody has joined yet.'}
        </p>
      )}
      <PeopleList
        title="People with access to this board"
        people={board.people}
        busy={busy}
        onRole={(p, role) => void change(board, p, role)}
        onRemove={(p) => void remove(board, p, `“${item.board.name}”`)}
      />
      {sharedFolder && folder.people.length > 0 && (
        <>
          <PeopleList
            title={`Through the folder “${sharedFolder.name}”`}
            people={folder.people}
            busy={busy}
            onRole={(p, role) => void change(folder, p, role)}
            onRemove={(p) => void remove(folder, p, `the folder “${sharedFolder.name}”`)}
          />
          <p className="board-access-note">
            Changes here apply to the whole folder “{sharedFolder.name}”.
          </p>
        </>
      )}
      <div className="server-actions">
        {onManageShare && (
          <button
            type="button"
            className="st-button"
            onClick={() => onManageShare('board', item.board.id)}
          >
            Invite people…
          </button>
        )}
        {board.shareId && (
          <button
            type="button"
            className="st-button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await cloud.stopSharing(board.shareId!);
                await load();
              }, `“${item.board.name}” is no longer shared.`)
            }
          >
            Stop sharing this board
          </button>
        )}
      </div>
    </div>
  );
}

function BoardDetails({
  item,
  status,
  busy,
  act,
  onManageShare,
}: {
  item: PlacedBoard;
  status: CloudStatus | null;
  busy: boolean;
  act: Act;
  onManageShare?: (kind: 'folder' | 'board', id: string) => void;
}) {
  const cloud = window.canvas?.cloud;
  const signedIn = status?.account.state === 'signedIn' || !!status?.identity;
  if (item.place.kind === 'received') {
    const { owner, role } = item.place;
    const share = status?.sharedWithMe.find(
      (s) =>
        (s.kind === 'board' && s.targetId === item.board.id) ||
        (s.kind === 'folder' && s.boards.includes(item.board.id)),
    );
    return (
      <div className="board-access">
        <p className="server-note">
          {owner} shared this {share?.kind === 'folder' ? 'board through a folder' : 'board'} with
          you. You can {role === 'edit' ? 'view and edit it' : 'view it'}.
        </p>
        {share && cloud && (
          <div className="server-actions">
            <button
              type="button"
              className="st-button"
              disabled={busy}
              onClick={() =>
                void act(
                  () => cloud.leave(share.shareId),
                  share.kind === 'folder'
                    ? `You left ${owner}'s folder.`
                    : `You left “${item.board.name}”.`,
                )
              }
            >
              {share.kind === 'folder' ? 'Leave the folder' : 'Leave this board'}
            </button>
          </div>
        )}
      </div>
    );
  }
  if (item.group === 'cloud' && status && cloud)
    return (
      <BoardAccess
        item={item}
        status={status}
        busy={busy}
        act={act}
        onManageShare={onManageShare}
      />
    );
  return (
    <div className="board-access">
      <p className="server-note">
        {item.place.kind === 'kept'
          ? 'You removed this board from the cloud. It stays only on this computer and nobody else can open it.'
          : 'Only on this computer. Nobody else can open it, and it is not uploaded anywhere.'}
        {signedIn && !status?.library
          ? ' Share it to put it in the cloud, or turn on “Sync my whole library” in Cloud sync.'
          : ''}
      </p>
      {onManageShare && signedIn && (
        <div className="server-actions">
          <button
            type="button"
            className="st-button"
            onClick={() => onManageShare('board', item.board.id)}
          >
            Share…
          </button>
        </div>
      )}
    </div>
  );
}

// Every board in one list: only on this computer, in the cloud, or shared with you, and
// for cloud boards who can open them.
export function BoardsSettings({
  library,
  onManageShare,
  onSignIn,
}: {
  library?: Library;
  onManageShare?: (kind: 'folder' | 'board', id: string) => void;
  onSignIn?: () => void;
}) {
  const cloud = window.canvas?.cloud;
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNotice();

  useEffect(() => {
    if (!cloud) return;
    void cloud.status().then(setStatus);
    return cloud.onStatus(setStatus);
  }, [cloud]);

  const act: Act = async (job, done) => {
    setBusy(true);
    try {
      await job();
      if (done) setNotice({ text: done });
    } catch (error) {
      setNotice({ text: errorText(error), error: true });
    } finally {
      setBusy(false);
    }
  };

  if (!library)
    return (
      <Group>
        <Row id="boardsList" description="Open a board first." />
      </Group>
    );
  const all = placeBoards(library, status);
  const counts = countPlaces(all);
  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    (b) =>
      (filter === 'all' || b.group === filter) &&
      (!needle ||
        b.board.name.toLowerCase().includes(needle) ||
        b.folder?.toLowerCase().includes(needle)),
  );
  const signedOut = !status?.identity && status?.account.state !== 'signedIn';
  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: all.length },
    { id: 'local', label: 'On this computer', count: counts.local },
    { id: 'cloud', label: 'In the cloud', count: counts.cloud },
    { id: 'received', label: 'Shared with you', count: counts.received },
  ];

  return (
    <>
      {signedOut && status?.configured && (
        <Group>
          <Row
            title="All your boards are only on this computer"
            description="Sign in to put boards in the cloud and share them. Boards you don't share stay private."
          >
            {onSignIn && (
              <button type="button" className="st-button primary" onClick={onSignIn}>
                Sign in…
              </button>
            )}
          </Row>
        </Group>
      )}
      <div className="boards-toolbar">
        <div className="boards-filters" role="tablist" aria-label="Show boards">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="boards-count">{f.count}</span>
            </button>
          ))}
        </div>
        <label className="boards-search">
          <Search size={14} />
          <input
            value={query}
            placeholder="Find a board"
            aria-label="Find a board"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <Group>
        {shown.length ? (
          shown.map((item) => {
            const expanded = open === item.board.id;
            return (
              <Row
                key={item.board.id}
                title={
                  <button
                    type="button"
                    className="board-row-toggle"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : item.board.id)}
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="board-dot" style={{ background: item.board.color }} />
                    <span className="board-row-name">{item.board.name || 'Untitled'}</span>
                  </button>
                }
                description={[item.folder, placeText(item.place)].filter(Boolean).join(' · ')}
                below={
                  expanded && (
                    <BoardDetails
                      item={item}
                      status={status}
                      busy={busy}
                      act={act}
                      onManageShare={onManageShare}
                    />
                  )
                }
              >
                <Tag item={item} />
              </Row>
            );
          })
        ) : (
          <Row
            title={needle ? 'No board matches' : 'No boards here'}
            description={needle ? 'Try another name.' : undefined}
          />
        )}
      </Group>
      <Notice notice={notice} />
    </>
  );
}
