import { useCallback, useEffect, useState } from 'react';
import { Building2, LogOut, Mail, RefreshCw } from 'lucide-react';
import type { CloudDevice, CloudStatus, SignInProvider } from '../../bridge';
import type { Library } from '../../model';
import { Group, Notice, Row, errorText, useNotice } from './controls';
import { ServerSettings } from './ServerSettings';
import { LicenseNote, ServerAdmin } from './ServerAdmin';
import { unsentText } from './server-text';
import { placeBoards, type PlaceGroup } from './board-places';
import { BoardSummary, DeviceList } from './AccountLists';
import { Avatar } from './list';

type Act = (job: () => Promise<unknown>, done?: string) => Promise<void>;

// Supabase lets a new code go out once a minute per address.
const RESEND_AFTER = 60;

const GoogleMark = () => (
  <svg viewBox="0 0 48 48" width="15" height="15" aria-hidden="true">
    <path
      fill="#FFC107"
      d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"
    />
    <path
      fill="#FF3D00"
      d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
    />
    <path
      fill="#1976D2"
      d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"
    />
  </svg>
);

const MicrosoftMark = () => (
  <svg viewBox="0 0 21 21" width="14" height="14" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#F25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
    <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
    <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
  </svg>
);

const providerName = (provider: SignInProvider) =>
  provider === 'sso' ? 'your company' : provider === 'microsoft' ? 'Microsoft' : 'Google';

// The sign-in buttons and the email-code steps. Used signed out, and on a 0.1.28 computer
// (anonymous), where signing in also moves its cloud boards onto the account.
function SignIn({ status, busy, act }: { status: CloudStatus; busy: boolean; act: Act }) {
  const cloud = window.canvas!.cloud;
  const methods = status.methods ?? { email: true, google: false, microsoft: false };
  const [emailOpen, setEmailOpen] = useState(false);
  // Company sign-in: the work email's domain picks the company's sign-in page.
  const [companyOpen, setCompanyOpen] = useState(false);
  const [workEmail, setWorkEmail] = useState('');
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (!wait) return;
    const timer = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const send = (address: string) =>
    act(async () => {
      const sent = await cloud.sendCode(address);
      setSentTo(sent.email);
      setCode('');
      setWait(RESEND_AFTER);
    });
  const verify = () =>
    act(async () => {
      await cloud.verifyCode(sentTo, code);
      setEmailOpen(false);
      setSentTo('');
      setCode('');
    }, 'Signed in.');

  if (status.waiting)
    return (
      <div className="server-panel">
        <p className="server-note">
          Finish signing in with {providerName(status.waiting)} in your browser…
        </p>
        <div className="server-actions">
          <button type="button" className="st-button" onClick={() => void cloud.cancelSignIn()}>
            Cancel
          </button>
        </div>
      </div>
    );

  const company = () =>
    act(async () => {
      await cloud.signInWith('sso', workEmail);
      setCompanyOpen(false);
    }, 'Signed in.');

  if (companyOpen)
    return (
      <div className="server-panel">
        <p className="server-note">
          Enter your work email. Your company's sign-in page opens in the browser.
        </p>
        <input
          type="email"
          aria-label="Work email"
          placeholder="you@company.com"
          value={workEmail}
          autoFocus
          spellCheck={false}
          onChange={(e) => setWorkEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && workEmail.trim() && !busy) void company();
          }}
        />
        <div className="server-actions">
          <button
            type="button"
            className="st-button primary"
            disabled={busy || !workEmail.trim()}
            onClick={() => void company()}
          >
            Continue
          </button>
          <button
            type="button"
            className="st-button"
            disabled={busy}
            onClick={() => setCompanyOpen(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    );

  if (emailOpen)
    return (
      <div className="server-panel">
        {!sentTo ? (
          <>
            <input
              type="email"
              aria-label="Email address"
              placeholder="you@example.com"
              value={email}
              autoFocus
              spellCheck={false}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && email.trim() && !busy) void send(email);
              }}
            />
            <div className="server-actions">
              <button
                type="button"
                className="st-button primary"
                disabled={busy || !email.trim()}
                onClick={() => void send(email)}
              >
                {busy ? 'Sending…' : 'Send code'}
              </button>
              <button
                type="button"
                className="st-button"
                disabled={busy}
                onClick={() => setEmailOpen(false)}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="server-note">
              We sent a code to <strong>{sentTo}</strong>. It works for an hour.
            </p>
            <input
              className="account-code"
              aria-label="Code from the email"
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              maxLength={10}
              autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code.length >= 6 && !busy) void verify();
              }}
            />
            <div className="server-actions">
              <button
                type="button"
                className="st-button primary"
                disabled={busy || code.length < 6}
                onClick={() => void verify()}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <button
                type="button"
                className="st-button"
                disabled={busy || wait > 0}
                onClick={() => void send(sentTo)}
              >
                {wait > 0 ? `Send a new code (${wait})` : 'Send a new code'}
              </button>
              <button
                type="button"
                className="st-button"
                disabled={busy}
                onClick={() => {
                  setSentTo('');
                  setCode('');
                }}
              >
                Use another email
              </button>
            </div>
          </>
        )}
      </div>
    );

  const provider = (name: SignInProvider) => act(() => cloud.signInWith(name), 'Signed in.');
  return (
    <div className="account-buttons">
      {methods.sso && (
        <button
          type="button"
          className="st-button"
          disabled={busy}
          onClick={() => setCompanyOpen(true)}
        >
          <Building2 size={14} />
          Continue with company sign-in
        </button>
      )}
      {methods.google && (
        <button
          type="button"
          className="st-button"
          disabled={busy}
          onClick={() => void provider('google')}
        >
          <GoogleMark />
          Continue with Google
        </button>
      )}
      {methods.microsoft && (
        <button
          type="button"
          className="st-button"
          disabled={busy}
          onClick={() => void provider('microsoft')}
        >
          <MicrosoftMark />
          Continue with Microsoft
        </button>
      )}
      {methods.email && (
        <button
          type="button"
          className="st-button"
          disabled={busy}
          onClick={() => setEmailOpen(true)}
        >
          <Mail size={14} />
          Continue with email
        </button>
      )}
    </div>
  );
}

// Signing out and deleting both ask first when changes haven't uploaded yet.
function Unsent({ status, busy, act }: { status: CloudStatus; busy: boolean; act: Act }) {
  const unsent = unsentText(status.pending);
  if (!unsent) return null;
  return (
    <>
      <p className="server-note">
        <strong>{unsent}</strong> Your own boards keep their edits on this computer. Edits to boards
        other people shared with you are lost with those boards.
      </p>
      <div className="server-actions">
        <button
          type="button"
          className="st-button primary"
          autoFocus
          disabled={busy || status.state === 'syncing'}
          onClick={() => void act(() => cloud().syncNow())}
        >
          <RefreshCw size={14} />
          Sync now
        </button>
      </div>
    </>
  );
}
const cloud = () => window.canvas!.cloud;

export function AccountSettings({
  connectAddress,
  library,
  onOpenBoards,
}: {
  connectAddress?: string;
  library?: Library;
  onOpenBoards?: (filter: PlaceGroup) => void;
}) {
  const bridge = window.canvas?.cloud;
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [devices, setDevices] = useState<CloudDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNotice();
  const [confirm, setConfirm] = useState<'signOut' | 'delete' | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!bridge) return;
    void bridge.status().then(setStatus);
    void bridge
      .signInMethods()
      .then(setStatus)
      .catch(() => {});
    return bridge.onStatus(setStatus);
  }, [bridge]);

  const signedIn = status?.account.state === 'signedIn';
  const loadDevices = useCallback(() => {
    if (bridge && signedIn)
      void bridge
        .devices()
        .then(setDevices)
        .catch(() => {});
    else setDevices([]);
  }, [bridge, signedIn]);
  useEffect(loadDevices, [loadDevices]);

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

  if (!bridge || !status)
    return (
      <Group>
        <Row title="Account" description="Available in the desktop app." />
      </Group>
    );

  const server = (
    <ServerSettings status={status} connectAddress={connectAddress} busy={busy} act={act} />
  );
  if (!status.configured)
    return (
      <>
        {server}
        <p className="st-hint cloud-hint">Choose a server to sign in.</p>
        <Notice notice={notice} />
      </>
    );

  const account = status.account;
  const boards = library ? placeBoards(library, status) : null;
  const otherServer = status.server && status.server.kind !== 'terra' ? status.server.name : null;
  // Typing the email (or "delete" without one) confirms deleting the account.
  const confirmWord = account.email || 'delete';
  const deletePanel = confirm === 'delete' && (
    <div className="server-panel">
      <p className="server-note">
        This deletes your cloud library, its files and everything you share, and your sign-in.
        People you shared with lose those boards. <strong>Boards on this computer stay.</strong>{' '}
        This can't be undone.
      </p>
      <Unsent status={status} busy={busy} act={act} />
      <input
        aria-label={`Type ${confirmWord} to confirm`}
        placeholder={`Type ${confirmWord} to confirm`}
        value={typed}
        spellCheck={false}
        autoFocus={!status.pending}
        onChange={(e) => setTyped(e.target.value)}
      />
      <div className="server-actions">
        <button
          type="button"
          className="st-button danger"
          disabled={busy || typed.trim().toLowerCase() !== confirmWord.toLowerCase()}
          onClick={() =>
            void act(async () => {
              const result = await bridge.deleteCloudData();
              setConfirm(null);
              setTyped('');
              setNotice({
                text: result.userDeleted
                  ? 'Your cloud data and sign-in are deleted.'
                  : 'Your cloud data is deleted. Your sign-in is removed within 30 days.',
              });
            })
          }
        >
          {busy ? 'Deleting…' : 'Delete everything in the cloud'}
        </button>
        <button
          type="button"
          className="st-button"
          disabled={busy}
          onClick={() => {
            setConfirm(null);
            setTyped('');
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
  const deleteRow = (
    <Group>
      <Row id={signedIn ? 'accountDelete' : 'accountDeleteAnonymous'} below={deletePanel}>
        {confirm !== 'delete' && (
          <button
            type="button"
            className="st-button"
            disabled={busy}
            onClick={() => setConfirm('delete')}
          >
            {signedIn ? 'Delete account…' : 'Delete…'}
          </button>
        )}
      </Row>
    </Group>
  );

  if (account.state !== 'signedIn')
    return (
      <>
        <Group>
          <Row
            id={account.state === 'anonymous' ? 'accountClaim' : 'accountSignIn'}
            below={<SignIn status={status} busy={busy} act={act} />}
          />
        </Group>
        {server}
        {account.state === 'anonymous' && deleteRow}
        <p className="st-hint cloud-hint">
          Boards on this computer never need an account. Signing in only adds sync between your
          computers and sharing.
        </p>
        <Notice notice={notice} />
      </>
    );

  const signOutPanel = confirm === 'signOut' && (
    <div className="server-panel">
      <Unsent status={status} busy={busy} act={act} />
      <p className="server-note">
        Boards other people shared with you are removed from this computer; your own boards stay.
      </p>
      <div className="server-actions">
        <button
          type="button"
          className={status.pending > 0 ? 'st-button' : 'st-button primary'}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await bridge.signOut();
              setConfirm(null);
            }, 'Signed out.')
          }
        >
          {status.pending > 0 ? 'Sign out anyway' : 'Sign out'}
        </button>
        <button
          type="button"
          className="st-button"
          disabled={busy}
          onClick={() => setConfirm(null)}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <>
      <Group>
        <div className="st-row st-profile" id="setting-accountSignedIn">
          <div className="st-row-main">
            <Avatar name={account.name || account.email || '?'} size={48} />
            <div className="st-row-text st-profile-text">
              <div className="st-profile-name">{account.name || account.email || 'Signed in'}</div>
              <p className="st-profile-email">
                {[account.name ? account.email : null, otherServer].filter(Boolean).join(', ')}
              </p>
            </div>
            {confirm !== 'signOut' && (
              <button
                type="button"
                className="st-button"
                disabled={busy}
                onClick={() => setConfirm('signOut')}
              >
                <LogOut size={14} />
                Sign out
              </button>
            )}
          </div>
          {signOutPanel}
        </div>
      </Group>

      {boards && <BoardSummary boards={boards} onOpen={onOpenBoards} />}

      <DeviceList
        devices={devices}
        busy={busy}
        onRetry={loadDevices}
        onSignOut={(d) =>
          act(async () => {
            await bridge.removeDevice(d.id);
            loadDevices();
          }, `${d.name} is signed out.`)
        }
      />

      {server}
      <LicenseNote company={status.company} />
      <ServerAdmin status={status} busy={busy} act={act} />
      {deleteRow}
      <Notice notice={notice} />
    </>
  );
}
