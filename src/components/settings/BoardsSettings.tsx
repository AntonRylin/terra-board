import { useCallback, useEffect, useState } from 'react';
import {
  CloudOff,
  HardDrive,
  Cloud,
  LogOut,
  Search,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { CloudStatus, SharePerson, ShareRole } from '../../bridge';
import type { Library } from '../../model';
import { AppIcon } from '../Launcher';
import { RoleSwitch } from '../ShareDialog';
import { Group, Notice, Row, errorText, useNotice } from './controls';
import { Avatar, ListRow, MoreMenu } from './list';
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

// What the row says on its right: where the board lives, in a word or two.
function Where({ item }: { item: PlacedBoard }) {
  if (item.place.kind === 'received')
    return (
      <span className="board-where" data-group="received">
        <Users size={14} />
        {item.place.owner}
      </span>
    );
  if (item.group === 'cloud')
    return (
      <span className="board-where" data-group="cloud">
        <Cloud size={14} />
        {item.people
          ? plural(item.people, 'person', 'people')
          : item.place.kind === 'owner'
            ? 'Shared'
            : 'Cloud'}
      </span>
    );
  return (
    <span className="board-where" data-group="local">
      <HardDrive size={14} />
      This computer
    </span>
  );
}

// The quieter line under a board's name: its folder, plus what the label on the right
// can't say in a word or two.
function subtitleOf(item: PlacedBoard) {
  const extra =
    item.place.kind === 'received'
      ? item.place.role === 'edit'
        ? 'You can edit'
        : 'You can view'
      : item.place.kind === 'kept'
        ? 'Removed from the cloud'
        : item.place.kind === 'owner' && !item.people
          ? 'Nobody has joined yet'
          : null;
  return [item.folder, extra].filter(Boolean).join(', ') || undefined;
}

function Person({
  person,
  busy,
  onRole,
  onRemove,
}: {
  person: SharePerson;
  busy: boolean;
  onRole: (role: ShareRole) => void;
  onRemove: () => void;
}) {
  return (
    <div className="board-person">
      <Avatar name={person.name} size={30} />
      <span className="board-person-name">{person.name}</span>
      <RoleSwitch value={person.role} label={`${person.name} can`} onChange={onRole} />
      <MoreMenu
        label={`More for ${person.name}`}
        items={[
          {
            label: 'Remove access',
            icon: <UserMinus />,
            danger: true,
            disabled: busy,
            action: onRemove,
          },
        ]}
      />
    </div>
  );
}

// Who can open a board you own: people invited to it, and people who reach it through a
// folder you share. Changes apply on the server at once; a removed person's app deletes
// its copy on its next sync.
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
  const [removing, setRemoving] = useState(false);
  const sharedFolder = item.place.kind === 'owner' && item.place.folder ? item.place.folder : null;
  const name = item.board.name || 'Untitled';

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

  const person = (access: Access, p: SharePerson, where: string) => (
    <Person
      key={p.id}
      person={p}
      busy={busy}
      onRole={(role) =>
        void act(
          async () => {
            await cloud.setPersonRole(access.shareId!, p.id, role);
            await load();
          },
          `${p.name} can ${role === 'edit' ? 'edit' : 'only view'} ${where} now.`,
        )
      }
      onRemove={() =>
        void act(async () => {
          await cloud.removePerson(access.shareId!, p.id);
          await load();
        }, `${p.name} can no longer open ${where}. It leaves their devices on their next sync.`)
      }
    />
  );

  if (error)
    return (
      <p className="st-callout" data-tone="danger">
        {error}
      </p>
    );
  if (!board) return <p className="board-quiet">Loading who has access…</p>;
  if (removing)
    return (
      <div className="st-callout">
        <span>
          Remove “{name}” from the cloud? Everyone you shared it with loses it and the cloud copy is
          deleted. It stays on this computer.
        </span>
        <span className="st-callout-actions">
          <button type="button" className="st-button" onClick={() => setRemoving(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="st-button danger"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await cloud.removeFromCloud(item.board.id);
                setRemoving(false);
              }, `“${name}” is only on this computer now.`)
            }
          >
            Remove
          </button>
        </span>
      </div>
    );

  const nobody = !board.people.length && !folder.people.length;
  return (
    <div className="board-access">
      <div className="board-access-head">
        <span>{nobody ? 'Only you can open this board' : 'People with access'}</span>
        {onManageShare && (
          <button
            type="button"
            className="st-button primary"
            onClick={() => onManageShare('board', item.board.id)}
          >
            <UserPlus size={15} />
            Invite
          </button>
        )}
        <MoreMenu
          label={`More for ${name}`}
          items={[
            board.shareId
              ? {
                  label: 'Stop sharing',
                  icon: <X />,
                  disabled: busy,
                  action: () =>
                    void act(async () => {
                      await cloud.stopSharing(board.shareId!);
                      await load();
                    }, `“${name}” is no longer shared.`),
                }
              : null,
            {
              label: 'Remove from cloud…',
              icon: <CloudOff />,
              danger: true,
              action: () => setRemoving(true),
            },
          ]}
        />
      </div>
      {board.people.map((p) => person(board, p, `“${name}”`))}
      {sharedFolder && folder.people.length > 0 && (
        <>
          <p className="board-access-sub">Through the folder “{sharedFolder.name}”</p>
          {folder.people.map((p) => person(folder, p, `the folder “${sharedFolder.name}”`))}
        </>
      )}
    </div>
  );
}

function BoardDetails({
  item,
  status,
  busy,
  act,
  onManageShare,
  onSignIn,
}: {
  item: PlacedBoard;
  status: CloudStatus | null;
  busy: boolean;
  act: Act;
  onManageShare?: (kind: 'folder' | 'board', id: string) => void;
  onSignIn?: () => void;
}) {
  const cloud = window.canvas?.cloud;
  const signedIn = status?.account.state === 'signedIn';
  if (item.place.kind === 'received') {
    const { owner, role } = item.place;
    const share = status?.sharedWithMe.find(
      (s) =>
        (s.kind === 'board' && s.targetId === item.board.id) ||
        (s.kind === 'folder' && s.boards.includes(item.board.id)),
    );
    return (
      <div className="board-access">
        <div className="board-person">
          <Avatar name={owner} size={30} />
          <span className="board-person-name">
            {owner}
            <span className="board-person-note">
              Owner{share?.kind === 'folder' ? ', shared through a folder' : ''}
            </span>
          </span>
          <span className="board-role">{role === 'edit' ? 'You can edit' : 'You can view'}</span>
          {share && cloud && (
            <button
              type="button"
              className="st-button"
              disabled={busy}
              onClick={() =>
                void act(
                  () => cloud.leave(share.shareId),
                  share.kind === 'folder' ? `You left ${owner}'s folder.` : 'You left the board.',
                )
              }
            >
              <LogOut size={14} />
              Leave
            </button>
          )}
        </div>
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
      <div className="board-access-head">
        <span>
          {item.place.kind === 'kept'
            ? 'You removed this board from the cloud. Nobody else can open it.'
            : 'Nobody else can open this board. It is not uploaded anywhere.'}
        </span>
        {signedIn && onManageShare ? (
          <button
            type="button"
            className="st-button primary"
            onClick={() => onManageShare('board', item.board.id)}
          >
            <UserPlus size={15} />
            Share
          </button>
        ) : (
          onSignIn && (
            <button type="button" className="st-button" onClick={onSignIn}>
              Sign in to share
            </button>
          )
        )}
      </div>
    </div>
  );
}

// Every board in one list: only on this computer, in the cloud, or shared with you, and
// for cloud boards who can open them.
export function BoardsSettings({
  library,
  initialFilter = 'all',
  onManageShare,
  onSignIn,
}: {
  library?: Library;
  initialFilter?: Filter;
  onManageShare?: (kind: 'folder' | 'board', id: string) => void;
  onSignIn?: () => void;
}) {
  const cloud = window.canvas?.cloud;
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [filter, setFilter] = useState<Filter>(initialFilter);
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
  const signedIn = status?.account.state === 'signedIn';
  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: all.length },
    { id: 'local', label: 'This computer', count: counts.local },
    { id: 'cloud', label: 'Cloud', count: counts.cloud },
    { id: 'received', label: 'Shared with you', count: counts.received },
  ];

  return (
    <>
      {status?.configured && !signedIn && (
        <div className="st-callout boards-signin">
          <span>
            Sign in to put boards in the cloud and share them. Boards you don't share stay on this
            computer.
          </span>
          {onSignIn && (
            <button type="button" className="st-button primary" onClick={onSignIn}>
              Sign in
            </button>
          )}
        </div>
      )}
      <div className="boards-toolbar">
        <div className="boards-filters" role="tablist" aria-label="Show boards">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setOpen(null);
              }}
            >
              {f.label}
              <span className="boards-count">{f.count}</span>
            </button>
          ))}
        </div>
        <label className="boards-search">
          <Search size={15} />
          <input
            value={query}
            placeholder="Search"
            aria-label="Search boards"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <Group>
        {shown.length ? (
          shown.map((item) => (
            <ListRow
              key={item.board.id}
              icon={<AppIcon board={item.board} />}
              title={item.board.name || 'Untitled'}
              subtitle={subtitleOf(item)}
              meta={<Where item={item} />}
              open={open === item.board.id}
              onToggle={() => setOpen(open === item.board.id ? null : item.board.id)}
            >
              <BoardDetails
                item={item}
                status={status}
                busy={busy}
                act={act}
                onManageShare={onManageShare}
                onSignIn={onSignIn}
              />
            </ListRow>
          ))
        ) : (
          <p className="st-list-empty">
            {needle
              ? `No board called “${query.trim()}”.`
              : filter === 'received'
                ? 'Nobody has shared a board with you yet.'
                : filter === 'cloud'
                  ? 'No boards in the cloud yet. Share a board to put it there.'
                  : 'No boards here.'}
          </p>
        )}
      </Group>
      <Notice notice={notice} />
    </>
  );
}
