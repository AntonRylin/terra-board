import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import type { CloudStatus, SharePerson, ShareRole } from '../bridge';
import type { Library } from '../model';
import './live-share.css';

export function useCloudStatus() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  useEffect(() => {
    const cloud = window.canvas?.cloud;
    if (!cloud) return;
    void cloud.status().then(setStatus);
    return cloud.onStatus(setStatus);
  }, []);
  return status;
}

const message = (e: unknown) =>
  String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');

function RoleSwitch({
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

// Who can see a folder or board, invites for more people, and leaving things others shared.
export function ShareDialog({
  kind,
  id,
  library,
  status,
  onClose,
}: {
  kind: 'folder' | 'board';
  id: string;
  library: Library;
  status: CloudStatus | null;
  onClose: () => void;
}) {
  const cloud = window.canvas?.cloud;
  const [people, setPeople] = useState<SharePerson[]>([]);
  const [shareId, setShareId] = useState<string | null>(null);
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
  const mark =
    kind === 'folder'
      ? library.sharing?.folders[id]
      : library.sharing?.boards[id] ||
        (board?.folderId ? library.sharing?.folders[board.folderId] : undefined);
  const received = mark && mark.shared !== 'owner';

  const load = useCallback(async () => {
    if (!cloud || !status?.identity || received) return;
    try {
      const result = await cloud.sharePeople(kind, id);
      setShareId(result.shareId);
      setPeople(result.people);
    } catch (e) {
      setError(message(e));
    }
  }, [cloud, status?.identity, kind, id, received]);
  useEffect(() => {
    void load();
  }, [load, status?.shared.length]);

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!cloud) return <p className="quiet">Sharing works in the desktop app.</p>;
  if (!status?.configured)
    return <p className="quiet">This build of Terra Board is not connected to a sync service.</p>;

  if (received) {
    const share = status.sharedWithMe.find(
      (s) =>
        (s.kind === 'folder' && (s.targetId === id || s.targetId === board?.folderId)) ||
        (s.kind === 'board' && s.targetId === id),
    );
    return (
      <>
        <p className="quiet">
          {mark.owner || 'Someone'} shared {kind === 'folder' ? 'this folder' : 'this board'} with
          you. You can {mark.shared === 'edit' ? 'view and edit it' : 'view it'}.
        </p>
        {error && <p className="live-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
          {share && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await cloud.leave(share.shareId);
                  onClose();
                })
              }
            >
              Leave
            </button>
          )}
        </div>
      </>
    );
  }

  const needsName = !status.identity;
  return (
    <>
      <p className="quiet">
        {kind === 'folder'
          ? `Invite people to “${item?.name || 'this folder'}”. Boards you move into this folder are shared too; your other boards stay private.`
          : `Invite people to “${item?.name || 'this board'}”. Your other boards stay private.`}
      </p>
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
      {people.length > 0 && (
        <div className="live-list">
          <h3>People with access</h3>
          {people.map((p) => (
            <div className="live-person" key={p.id}>
              <span className="live-name">{p.name}</span>
              <RoleSwitch
                value={p.role}
                label={`${p.name} can`}
                onChange={(next) =>
                  run(async () => {
                    await cloud.setPersonRole(shareId!, p.id, next);
                    await load();
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${p.name}`}
                title="Remove access"
                onClick={() =>
                  run(async () => {
                    await cloud.removePerson(shareId!, p.id);
                    await load();
                  })
                }
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="live-row">
        <span>Invite someone who can</span>
        <RoleSwitch value={role} onChange={setRole} label="Invited person can" />
      </div>
      {code ? (
        <div className="share-code">
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
          <p className="live-note">
            Send this code to one person. In Terra Board they choose “Join with a code”. It works
            once, for 7 days.
          </p>
        </div>
      ) : null}
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        {shareId && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await cloud.stopSharing(shareId);
                setShareId(null);
                setPeople([]);
                setCode('');
              })
            }
          >
            Stop sharing
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={busy || (needsName && !name.trim())}
          onClick={() =>
            run(async () => {
              setCode(await cloud.invite(kind, id, role, needsName ? name.trim() : undefined));
              await load();
            })
          }
        >
          {busy ? 'Working…' : code ? 'New invite code' : 'Create invite code'}
        </button>
      </div>
    </>
  );
}

export function JoinDialog({
  status,
  onClose,
}: {
  status: CloudStatus | null;
  onClose: () => void;
}) {
  const cloud = window.canvas?.cloud;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const clean = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const invite = clean.startsWith('S');
  const needsName = invite && !status?.identity;
  if (!cloud || !status?.configured)
    return <p className="quiet">Joining works in the desktop app with sync available.</p>;
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
      <p className="quiet">
        Enter an invite code someone sent you, or a code from another of your computers.
      </p>
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
