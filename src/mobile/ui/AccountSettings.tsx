// Settings → Account on Android: which cloud this phone is connected to, sync
// status, boards shared with you, and signing out or switching account.
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { CloudStatus } from '../../bridge';
import { useCloudStatus } from '../../components/ShareDialog';
import { Group, Notice, Row, errorText, useNotice } from '../../components/settings/controls';
import { cloud } from '../cloud.ts';
import { call } from '../host.ts';
import type { Library } from '../../model';

function describe(status: CloudStatus) {
  if (status.state === 'syncing') return 'Syncing…';
  if (status.state === 'offline')
    return status.pending
      ? `Offline. ${status.pending} ${status.pending === 1 ? 'change waits' : 'changes wait'} to upload.`
      : 'Offline. Boards on this phone still open.';
  if (status.state === 'error') return status.error || 'Sync stopped.';
  if (status.lastSync)
    return (
      'Up to date · ' + new Date(status.lastSync).toLocaleTimeString([], { timeStyle: 'short' })
    );
  return 'Connected';
}

export function AccountSettings() {
  const status = useCloudStatus();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'sign-out' | 'switch' | null>(null);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useNotice();
  const [library, setLibrary] = useState<Library | null>(null);
  useEffect(() => {
    void call<Library>('library').then(setLibrary, () => {});
  }, [status?.lastSync, status?.sharedWithMe.length]);
  if (!status) return null;
  const itemName = (kind: 'folder' | 'board', id: string) =>
    (kind === 'folder' ? library?.folders : library?.boards)?.find((x) => x.id === id)?.name ||
    (kind === 'folder' ? 'A folder' : 'A board');

  const act = async (job: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await job();
      if (done) setNotice({ text: done });
    } catch (e) {
      setNotice({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  const pending = status.pending;
  const signOut = () =>
    act(async () => {
      // The storage worker clears the phone and the app reloads into sign-in.
      await cloud.signOut!();
    });

  return (
    <>
      <Group>
        <Row
          title={status.account?.email || status.account?.name || status.name || 'Your boards'}
          description={
            status.account?.state === 'signedIn'
              ? `Terra Cloud · Shown to others as ${status.name || status.account.name || 'you'}`
              : 'Terra Cloud · Connected without an account'
          }
        />
        <Row
          title="Sync"
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
          <Row
            title="Nothing shared with you yet"
            description="Enter an invite code someone sent you."
          />
        )}
        <Row
          title="Join with a code"
          below={
            <form
              className="cloud-join mobile-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!code.trim()) return;
                void act(async () => {
                  await cloud.join(code);
                  setCode('');
                }, 'Joined.');
              }}
            >
              <input
                className="mobile-code-input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Invite code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Invite code"
                disabled={busy}
              />
              <button type="submit" className="st-button" disabled={busy || !code.trim()}>
                Join
              </button>
            </form>
          }
        />
      </Group>

      <Group title="This phone">
        <Row title="Switch account" description="Sign out, then sign in with another account.">
          <button
            type="button"
            className="st-button"
            disabled={busy}
            onClick={() => setConfirm('switch')}
          >
            Switch
          </button>
        </Row>
        <Row
          title="Sign out"
          description="Deletes this phone's copy of your boards and removes it from your account. They stay in the cloud and on your computer."
          below={
            confirm && (
              <div className="mobile-confirm" role="alert">
                <p>
                  {pending
                    ? `${pending} ${pending === 1 ? 'change has' : 'changes have'} not reached the cloud yet. Signing out now loses ${pending === 1 ? 'it' : 'them'}.`
                    : 'Sign out and delete the boards on this phone?'}
                </p>
                <div>
                  {pending ? (
                    <button
                      type="button"
                      className="st-button primary"
                      disabled={busy}
                      onClick={() => act(() => cloud.syncNow())}
                    >
                      Sync now
                    </button>
                  ) : (
                    <button type="button" className="st-button" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    className="st-button danger"
                    disabled={busy}
                    onClick={signOut}
                  >
                    {pending ? 'Sign out anyway' : 'Sign out'}
                  </button>
                </div>
              </div>
            )
          }
        >
          <button
            type="button"
            className="st-button"
            disabled={busy}
            onClick={() => setConfirm('sign-out')}
          >
            Sign out
          </button>
        </Row>
      </Group>
      <Notice notice={notice} />
    </>
  );
}
