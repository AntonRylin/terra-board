import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  CloudOff,
  Copy,
  Eye,
  Folder as FolderIcon,
  LogOut,
  Pencil,
  UserMinus,
  UserPlus,
  UserX,
} from 'lucide-react';
import type { CloudStatus, SharePerson, ShareRole } from '../bridge';
import { cloudApi } from '../bridge';
import type { Library } from '../model';
import { AppIcon } from './Launcher';
import { Avatar, MoreMenu } from './settings/list';
import './live-share.css';

export function useCloudStatus() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  useEffect(() => {
    const cloud = cloudApi;
    if (!cloud) return;
    void cloud.status().then(setStatus);
    return cloud.onStatus(setStatus);
  }, []);
  return status;
}

const message = (e: unknown) =>
  String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');

export function RoleSwitch({
  value,
  onChange,
  label,
}: {
  value: ShareRole;
  onChange: (role: ShareRole) => void;
  label: string;
}) {
  return (
    <div className="live-segments" role="radiogroup" aria-label={label}>
      {(['view', 'edit'] as const).map((role) => (
        <button
          key={role}
          type="button"
          role="radio"
          aria-checked={value === role}
          onClick={() => value !== role && onChange(role)}
        >
          {role === 'view' ? 'View' : 'Edit'}
        </button>
      ))}
    </div>
  );
}

type Step = 'people' | 'invite' | 'code' | 'stop' | 'remove' | 'leave';

// Someone with access: initials, name, what they can do, and a ⋯ menu to remove them.
function PersonRow({
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
    <div className="share-person">
      <Avatar name={person.name} size={32} />
      <span className="share-person-name">{person.name}</span>
      <RoleSwitch value={person.role} label={`${person.name} can`} onChange={onRole} />
      <MoreMenu
        label={`More for ${person.name}`}
        buttonClass="icon-button"
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

// A yes/no step inside the dialog for something that can't be undone.
function Confirm({
  text,
  action,
  busy,
  error,
  onBack,
  onConfirm,
}: {
  text: string;
  action: string;
  busy: boolean;
  error: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <p className="share-text">{text}</p>
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onBack}>
          Cancel
        </button>
        <button type="button" className="button danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : action}
        </button>
      </div>
    </>
  );
}

// Sharing a folder or board, one step at a time: who has access, inviting someone, the
// invite code, and confirm steps for stopping or leaving.
export function ShareDialog({
  kind,
  id,
  library,
  status,
  onClose,
  onSignIn,
}: {
  kind: 'folder' | 'board';
  id: string;
  library: Library;
  status: CloudStatus | null;
  onClose: () => void;
  onSignIn?: () => void;
}) {
  const cloud = cloudApi;
  const [step, setStep] = useState<Step>('people');
  const [people, setPeople] = useState<SharePerson[] | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  // A board in a shared folder: the people who reach it through the folder.
  const [folderAccess, setFolderAccess] = useState<{
    shareId: string | null;
    people: SharePerson[];
  }>({ shareId: null, people: [] });
  const [role, setRole] = useState<ShareRole>('edit');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const item =
    kind === 'folder'
      ? library.folders.find((f) => f.id === id)
      : library.boards.find((b) => b.id === id);
  const board = kind === 'board' ? library.boards.find((b) => b.id === id) : undefined;
  const itemName = item?.name || (kind === 'folder' ? 'this folder' : 'this board');
  const mark =
    kind === 'folder'
      ? library.sharing?.folders[id]
      : library.sharing?.boards[id] ||
        (board?.folderId ? library.sharing?.folders[board.folderId] : undefined);
  const received = mark && mark.shared !== 'owner';
  const localOnly = kind === 'board' && !!library.sharing?.local?.includes(id);
  const sharedFolder =
    kind === 'board' &&
    board?.folderId &&
    library.sharing?.folders[board.folderId]?.shared === 'owner'
      ? library.folders.find((f) => f.id === board.folderId)
      : undefined;
  const inCloud =
    !localOnly &&
    (!!mark || !!sharedFolder || (!!status?.identity && !!status?.library && kind === 'board'));

  const load = useCallback(async () => {
    if (!cloud || !status?.identity || received) return setPeople([]);
    try {
      const result = await cloud.sharePeople(kind, id);
      setShareId(result.shareId);
      setPeople(result.people);
      setFolderAccess(
        sharedFolder
          ? await cloud.sharePeople('folder', sharedFolder.id)
          : { shareId: null, people: [] },
      );
    } catch (e) {
      setError(message(e));
      setPeople([]);
    }
  }, [cloud, status?.identity, kind, id, received, sharedFolder?.id]);
  useEffect(() => {
    void load();
  }, [load, status?.shared.length]);

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await job();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const go = (next: Step) => {
    setError('');
    setStep(next);
  };

  if (!cloud) return <p className="quiet">Sharing works in the desktop app.</p>;
  if (!status?.configured)
    return <p className="quiet">This build of Terra Board is not connected to a sync service.</p>;
  if (!status.identity && status.account.state === 'signedOut')
    return <SignInFirst onSignIn={onSignIn} onClose={onClose} what="share" />;

  const heading = (
    <div className="share-item">
      {board ? (
        <AppIcon board={board} />
      ) : (
        <span className="share-item-folder">
          <FolderIcon size={18} />
        </span>
      )}
      <span className="share-item-text">
        <strong>{itemName}</strong>
        <span>
          {received
            ? `Shared by ${mark.owner || 'someone'}`
            : inCloud
              ? kind === 'folder'
                ? 'Cloud folder'
                : 'Cloud'
              : 'Local'}
        </span>
      </span>
    </div>
  );

  if (received) {
    const share = status.sharedWithMe.find(
      (s) =>
        (s.kind === 'folder' && (s.targetId === id || s.targetId === board?.folderId)) ||
        (s.kind === 'board' && s.targetId === id),
    );
    if (step === 'leave' && share)
      return (
        <Confirm
          text={`Leave “${itemName}”? It disappears from your devices. ${mark.owner || 'The owner'} can invite you again.`}
          action="Leave"
          busy={busy}
          error={error}
          onBack={() => go('people')}
          onConfirm={() => void run(() => cloud.leave(share.shareId)).then((ok) => ok && onClose())}
        />
      );
    return (
      <>
        {heading}
        <div className="share-person">
          <Avatar name={mark.owner || 'Someone'} size={32} />
          <span className="share-person-name">
            {mark.owner || 'Someone'}
            <small>Owner</small>
          </span>
          <span className="share-person-role">
            {mark.shared === 'edit' ? 'You can edit' : 'You can view'}
          </span>
        </div>
        {error && <p className="live-error">{error}</p>}
        <div className="dialog-actions">
          {share && (
            <button
              type="button"
              className="button share-left"
              disabled={busy}
              onClick={() => go('leave')}
            >
              <LogOut size={15} />
              Leave
            </button>
          )}
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </div>
      </>
    );
  }

  // Sharing needs an account; a computer that syncs without one can still leave shares.
  if (status.account.state !== 'signedIn')
    return <SignInFirst onSignIn={onSignIn} onClose={onClose} what="share" />;

  if (step === 'remove')
    return (
      <Confirm
        text={`Remove “${itemName}” from the cloud? Everyone you shared it with loses it, and the cloud copy is deleted. It stays on this computer as a local board.`}
        action="Remove from cloud"
        busy={busy}
        error={error}
        onBack={() => go('people')}
        onConfirm={() =>
          void run(async () => {
            await cloud.removeFromCloud(id);
            setShareId(null);
            setPeople([]);
            setStep('people');
          })
        }
      />
    );
  if (step === 'stop')
    return (
      <Confirm
        text={`Stop sharing “${itemName}”? Everyone you invited loses access, and it leaves their devices on their next sync. It stays in your cloud.`}
        action="Stop sharing"
        busy={busy}
        error={error}
        onBack={() => go('people')}
        onConfirm={() =>
          void run(async () => {
            await cloud.stopSharing(shareId!);
            setShareId(null);
            setPeople([]);
            setStep('people');
          })
        }
      />
    );

  // The name defaults to the account's; people may set another.
  const needsName = !status.identity && !status.account.name;
  if (step === 'invite')
    return (
      <>
        <p className="share-text">
          {kind === 'folder'
            ? `Invite someone to “${itemName}”. Boards in this folder are shared with them; your other boards stay private.`
            : `Invite someone to “${itemName}”. Your other boards stay private.`}
        </p>
        <div className="share-roles" role="radiogroup" aria-label="They can">
          {(
            [
              ['edit', 'Can edit', 'Add and change things', Pencil],
              ['view', 'Can view', 'Look and follow along', Eye],
            ] as const
          ).map(([value, title, text, Icon]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={role === value}
              onClick={() => setRole(value)}
            >
              <Icon size={18} />
              <span>
                <strong>{title}</strong>
                <span>{text}</span>
              </span>
            </button>
          ))}
        </div>
        {needsName && (
          <label className="share-name">
            Your name, shown to the people you invite
            <input
              value={name}
              maxLength={60}
              autoFocus
              placeholder="Your name"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {localOnly && (
          <p className="live-note">This is a local board. Inviting someone puts it in the cloud.</p>
        )}
        {error && (
          <p className="live-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={() => go('people')}>
            Back
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || (needsName && !name.trim())}
            onClick={() =>
              void run(async () => {
                setCode(await cloud.invite(kind, id, role, needsName ? name.trim() : undefined));
                await load();
                setStep('code');
              })
            }
          >
            {busy ? 'Creating…' : 'Create invite code'}
          </button>
        </div>
      </>
    );

  if (step === 'code')
    return (
      <>
        <p className="share-text">
          Send this code to the person you want to invite. In Terra Board they choose Join with a
          code. It works once, for 7 days.
        </p>
        <div className="share-code-big">
          <code>{code.slice(0, 5) + '-' + code.slice(5)}</code>
          <button
            type="button"
            className="button"
            onClick={() =>
              void window.canvas?.copyText(code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="share-hint">
          They can {role === 'edit' ? 'edit' : 'view'} “{itemName}”.
        </p>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => go('invite')}>
            Invite another
          </button>
          <button type="button" className="button primary" onClick={() => go('people')}>
            Done
          </button>
        </div>
      </>
    );

  const changeRole = (share: string, p: SharePerson, next: ShareRole) =>
    void run(async () => {
      await cloud.setPersonRole(share, p.id, next);
      await load();
    });
  const removePerson = (share: string, p: SharePerson) =>
    void run(async () => {
      await cloud.removePerson(share, p.id);
      await load();
    });
  const nobody = people !== null && !people.length && !folderAccess.people.length;
  return (
    <>
      <div className="share-head">
        {heading}
        <MoreMenu
          label="More sharing options"
          buttonClass="icon-button"
          items={[
            shareId ? { label: 'Stop sharing…', icon: <UserX />, action: () => go('stop') } : null,
            kind === 'board' && status.identity && inCloud
              ? {
                  label: 'Remove from cloud…',
                  icon: <CloudOff />,
                  danger: true,
                  action: () => go('remove'),
                }
              : null,
          ]}
        />
      </div>
      <h3 className="share-section">People with access</h3>
      {people === null ? (
        <p className="share-empty">Loading…</p>
      ) : nobody ? (
        <p className="share-empty">Only you. Invite someone to work on it together.</p>
      ) : (
        <>
          {people.map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              busy={busy}
              onRole={(next) => changeRole(shareId!, p, next)}
              onRemove={() => removePerson(shareId!, p)}
            />
          ))}
          {folderAccess.people.length > 0 && (
            <>
              <h3 className="share-section">Through the folder “{sharedFolder?.name}”</h3>
              {folderAccess.people.map((p) => (
                <PersonRow
                  key={p.id}
                  person={p}
                  busy={busy}
                  onRole={(next) => changeRole(folderAccess.shareId!, p, next)}
                  onRemove={() => removePerson(folderAccess.shareId!, p)}
                />
              ))}
            </>
          )}
        </>
      )}
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          Done
        </button>
        <button type="button" className="button primary" onClick={() => go('invite')}>
          <UserPlus size={15} />
          Invite
        </button>
      </div>
    </>
  );
}

// Sharing needs an account; the person's own boards never do.
function SignInFirst({
  what,
  onSignIn,
  onClose,
}: {
  what: 'share' | 'join';
  onSignIn?: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <p className="quiet">
        {what === 'share'
          ? 'Sharing needs an account. Sign in to share; only what you share is uploaded, and your other boards stay on this computer.'
          : 'Sign in to open boards people share with you.'}
      </p>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          autoFocus
          onClick={() => {
            onClose();
            onSignIn?.();
          }}
        >
          Sign in…
        </button>
      </div>
    </>
  );
}

export function JoinDialog({
  status,
  onClose,
  onSignIn,
}: {
  status: CloudStatus | null;
  onClose: () => void;
  onSignIn?: () => void;
}) {
  const cloud = cloudApi;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const clean = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const invite = clean.startsWith('S');
  const needsName = invite && !status?.identity && !status?.account.name;
  if (!cloud || !status?.configured)
    return <p className="quiet">Joining works in the desktop app with sync available.</p>;
  if (status.account.state !== 'signedIn')
    return <SignInFirst onSignIn={onSignIn} onClose={onClose} what="join" />;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        cloud
          .join(code, needsName ? name.trim() : undefined)
          .then(onClose)
          .catch((err) => setError(message(err)))
          .finally(() => setBusy(false));
      }}
    >
      <p className="quiet">Enter an invite code someone sent you.</p>
      <label>
        Code
        <input
          value={code}
          autoFocus
          maxLength={14}
          placeholder="SXXXX-XXXXX"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
      </label>
      {needsName && (
        <label>
          Your name, shown to the person who invited you
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      {error && <p className="live-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={busy || clean.length < 10 || (needsName && !name.trim())}
        >
          {busy ? 'Joining…' : 'Join'}
        </button>
      </div>
    </form>
  );
}
