import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { CloudStatus } from '../../bridge';
import type { Library } from '../../model';
import { Group, Notice, Row, Switch, errorText, useNotice } from './controls';

const since = (time: number | null) => {
  if (!time) return '';
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : new Date(time).toLocaleTimeString();
};

function describe(status: CloudStatus) {
  if (status.state === 'syncing')
    return status.pending
      ? `Syncing ${status.pending} change${status.pending === 1 ? '' : 's'}…`
      : 'Syncing…';
  if (status.state === 'offline')
    return 'Offline. Changes are kept and sync when you are back online.';
  if (status.state === 'error') return status.error || 'Sync stopped because of an error.';
  return `Up to date${status.lastSync ? ' · ' + since(status.lastSync) : ''}`;
}

export function CloudSettings({
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
  const [joinCode, setJoinCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNotice();
  const [, tick] = useState(0);

  useEffect(() => {
    if (!cloud) return;
    void cloud.status().then((s) => {
      setStatus(s);
      setName(s.name || '');
    });
    const stop = cloud.onStatus(setStatus);
    const timer = setInterval(() => tick((n) => n + 1), 15000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [cloud]);
  // Signed in on a new computer: the name comes from the account.
  useEffect(() => {
    if (status?.name) setName((n) => n || status.name);
  }, [status?.name]);

  const act = async (job: () => Promise<unknown>, done?: string) => {
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

  if (!cloud || !status)
    return (
      <Group>
        <Row title="Cloud sync" description="Available in the desktop app." />
      </Group>
    );
  const identity = status.identity;
  const signedOut = status.account.state === 'signedOut';
  const signedIn = status.account.state === 'signedIn';

  // Sync needs a sign-in; a 0.1.28 computer (anonymous) keeps syncing without one.
  if (!status.configured || (signedOut && !identity))
    return (
      <>
        <Group>
          <Row
            id="cloudSignIn"
            title="Sign in to sync"
            description={
              status.configured
                ? 'Sign in to keep your boards on every computer you use and to share them.'
                : 'Choose a server in Account to use cloud sync.'
            }
          >
            <button type="button" className="st-button primary" onClick={onSignIn}>
              {status.configured ? 'Sign in…' : 'Account…'}
            </button>
          </Row>
        </Group>
        {status.error && <p className="st-hint cloud-hint">{status.error}</p>}
        <Notice notice={notice} />
      </>
    );

  const itemName = (kind: 'folder' | 'board', id: string) =>
    (kind === 'folder'
      ? library?.folders.find((f) => f.id === id)?.name
      : library?.boards.find((b) => b.id === id)?.name) || 'Removed item';
  const join = signedIn ? (
    <Row id="cloudJoin">
      <span className="cloud-join">
        <input
          aria-label="Code you were given"
          placeholder="SXXXX-XXXXX"
          value={joinCode}
          maxLength={14}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
        />
        <button
          type="button"
          className="st-button"
          disabled={busy || joinCode.replace(/[^0-9A-Z]/g, '').length < 10}
          onClick={() =>
            act(async () => {
              await cloud.join(joinCode, name.trim() || undefined);
              setJoinCode('');
            }, 'Joined.')
          }
        >
          Join
        </button>
      </span>
    </Row>
  ) : (
    <Row
      id="cloudJoin"
      description="Sign in to open boards people share with you. Sharing needs an account."
    >
      <button type="button" className="st-button" onClick={onSignIn}>
        Sign in…
      </button>
    </Row>
  );
  const nameRow = (
    <Row id="cloudName">
      <span className="cloud-join">
        <input
          className="st-name-input"
          aria-label="Your name"
          placeholder="Your name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
        {identity && name.trim() && name.trim() !== status.name && (
          <button
            type="button"
            className="st-button"
            disabled={busy}
            onClick={() => act(() => cloud.rename(name.trim()), 'Name saved.')}
          >
            Save
          </button>
        )}
      </span>
    </Row>
  );

  if (!identity)
    return (
      <>
        <Group>
          {nameRow}
          <Row id="cloudEnable">
            <button
              type="button"
              className="st-button primary"
              disabled={busy}
              onClick={() => act(() => cloud.enable(name.trim() || undefined), 'Sync is on.')}
            >
              {busy ? 'Turning on…' : 'Turn on'}
            </button>
          </Row>
          {join}
        </Group>
        <p className="st-hint cloud-hint">
          To share just one folder or board, choose Share… in its menu; the rest of your library
          stays on this computer.
        </p>
        <Notice notice={notice} />
      </>
    );

  return (
    <>
      {status.account.state === 'anonymous' && (
        <Group>
          <Row id="accountClaim">
            <button type="button" className="st-button primary" onClick={onSignIn}>
              Sign in…
            </button>
          </Row>
        </Group>
      )}
      <Group>
        {nameRow}
        <Row
          id="cloudLibrary"
          description={
            status.library
              ? 'Every board is kept on all your computers.'
              : 'Only folders and boards you share are uploaded.'
          }
        >
          <Switch
            label="Sync my whole library"
            checked={status.library}
            disabled={busy}
            onChange={(on) => act(() => cloud.setLibrary(on))}
          />
        </Row>
        <Row
          id="cloudStatus"
          description={
            <span className="cloud-status">
              <span className="cloud-dot" data-state={status.state} />
              {describe(status)}
            </span>
          }
        >
          <button
            type="button"
            className="st-button"
            disabled={busy || status.state === 'syncing'}
            onClick={() => act(() => cloud.syncNow())}
          >
            <RefreshCw size={14} />
            Sync now
          </button>
        </Row>
      </Group>

      <Group title="Shared by you">
        {status.shared.length ? (
          status.shared.map((s) => (
            <Row
              key={s.shareId}
              title={itemName(s.kind, s.targetId)}
              description={`${s.kind === 'folder' ? 'Folder' : 'Board'} · ${
                s.people === 1 ? '1 person' : `${s.people} people`
              }`}
            >
              <button
                type="button"
                className="st-button"
                onClick={() => onManageShare?.(s.kind, s.targetId)}
              >
                Manage
              </button>
            </Row>
          ))
        ) : (
          <Row id="cloudShared" description="Choose Share… in a folder's or board's menu." />
        )}
      </Group>

      <Group title="Shared with you">
        {status.sharedWithMe.length ? (
          status.sharedWithMe.map((s) => (
            <Row
              key={s.shareId}
              title={itemName(s.kind, s.targetId)}
              description={`From ${s.owner} · ${s.role === 'edit' ? 'Can edit' : 'View only'}`}
            >
              <button
                type="button"
                className="st-button"
                disabled={busy}
                onClick={() => act(() => cloud.leave(s.shareId), 'Left.')}
              >
                Leave
              </button>
            </Row>
          ))
        ) : (
          <Row id="cloudReceived" description="Join with a code someone sent you." />
        )}
        {join}
      </Group>

      <Group>
        <Row id="cloudDisable">
          <button
            type="button"
            className="st-button"
            disabled={busy}
            onClick={() => act(() => cloud.disable(), 'Sync is off on this computer.')}
          >
            Turn off
          </button>
        </Row>
      </Group>
      {status.account.state === 'anonymous' && (
        <p className="st-hint cloud-hint">
          This computer syncs without an account. Keep at least one of your computers, or sign in,
          or what is stored in the cloud cannot be recovered.
        </p>
      )}
      <Notice notice={notice} />
    </>
  );
}
