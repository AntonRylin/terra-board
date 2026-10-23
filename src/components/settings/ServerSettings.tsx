import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { CloudStatus, ServerInput } from '../../bridge';
import { Group, Row } from './controls';
import { serverDescription, switchWarning, unsentLoss, unsentText } from './server-text';

type Act = (job: () => Promise<unknown>, done?: string) => Promise<void>;
type Target = ServerInput | { terra: true };

// Where cloud boards are kept. Changing it checks the server first, and while
// sync is on it asks before turning sync off.
export function ServerSettings({
  status,
  connectAddress,
  busy,
  act,
}: {
  status: CloudStatus;
  connectAddress?: string;
  busy: boolean;
  act: Act;
}) {
  const cloud = window.canvas!.cloud;
  const server = status.server;
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  // A server that was checked, ready to connect to.
  const [found, setFound] = useState<{ name: string; host: string; input: ServerInput } | null>(
    null,
  );
  // A switch waiting for the person to confirm turning sync off.
  const [confirm, setConfirm] = useState<{ target: Target; name: string } | null>(null);

  // A terraboard://connect link opens the panel with the address filled in.
  // It only fills it in; the person still checks and connects.
  useEffect(() => {
    if (!connectAddress || server?.locked) return;
    setOpen(true);
    setAdvanced(false);
    setAddress(connectAddress);
    setFound(null);
    setConfirm(null);
  }, [connectAddress, server?.locked]);

  const close = () => {
    setOpen(false);
    setFound(null);
    setConfirm(null);
  };
  const edited = () => {
    setFound(null);
    setConfirm(null);
  };

  const input: ServerInput | null = advanced
    ? url.trim() && key.trim()
      ? { url: url.trim(), key: key.trim() }
      : null
    : address.trim()
      ? { address: address.trim() }
      : null;

  const check = () =>
    input &&
    act(async () => {
      const preview = await cloud.serverTest(input);
      setFound({ name: preview.name, host: preview.host, input });
    });

  const connect = (target: Target, name: string) =>
    act(async () => {
      try {
        // The app checks the server, then turns sync off, then switches; a failed check
        // leaves sync on.
        await cloud.serverSet(target, { turnOffSync: true });
        close();
        setAddress('');
        setUrl('');
        setKey('');
      } finally {
        setConfirm(null);
      }
    }, `Connected to ${name}.`);

  // Signed in or with sync on, ask first. Otherwise switch right away.
  const involved = status.identity || status.account.state === 'signedIn';
  const choose = (target: Target, name: string) =>
    involved ? setConfirm({ target, name }) : connect(target, name);

  const unsent = unsentText(status.pending);
  const confirming = confirm && involved ? confirm : null;

  const panel = open && (
    <div className="server-panel">
      {confirming ? (
        <>
          <p className="server-note">
            {switchWarning}
            {unsent && (
              <>
                {' '}
                <strong>{unsent}</strong> {unsentLoss}
              </>
            )}
          </p>
          <div className="server-actions">
            {/* With changes waiting, Sync now is the default and Switch the other choice. */}
            {status.pending > 0 && (
              <button
                type="button"
                className="st-button primary"
                autoFocus
                disabled={busy || status.state === 'syncing'}
                onClick={() => act(() => cloud.syncNow())}
              >
                <RefreshCw size={14} />
                Sync now
              </button>
            )}
            <button
              type="button"
              className={status.pending > 0 ? 'st-button' : 'st-button primary'}
              disabled={busy}
              onClick={() => connect(confirming.target, confirming.name)}
            >
              Switch
            </button>
            <button type="button" className="st-button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {advanced ? (
            <>
              <input
                aria-label="Supabase URL"
                placeholder="Supabase URL"
                value={url}
                spellCheck={false}
                onChange={(e) => {
                  setUrl(e.target.value);
                  edited();
                }}
              />
              <input
                aria-label="Public key"
                placeholder="Public key"
                value={key}
                spellCheck={false}
                onChange={(e) => {
                  setKey(e.target.value);
                  edited();
                }}
              />
            </>
          ) : (
            <input
              aria-label="Server address"
              placeholder="terra.example.com"
              value={address}
              spellCheck={false}
              autoFocus
              onChange={(e) => {
                setAddress(e.target.value);
                edited();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void check();
              }}
            />
          )}
          {found && (
            <p className="server-note">
              Found <strong>{found.name}</strong> at {found.host}.
            </p>
          )}
          <div className="server-actions">
            {found ? (
              <button
                type="button"
                className="st-button primary"
                disabled={busy}
                onClick={() => choose(found.input, found.name)}
              >
                Connect
              </button>
            ) : (
              <button
                type="button"
                className="st-button primary"
                disabled={busy || !input}
                onClick={() => void check()}
              >
                {busy ? 'Checking…' : 'Check'}
              </button>
            )}
            {server?.kind !== 'terra' && (
              <button
                type="button"
                className="st-button"
                disabled={busy}
                onClick={() => choose({ terra: true }, 'Terra Cloud')}
              >
                Use Terra Cloud
              </button>
            )}
            <button
              type="button"
              className="st-button"
              disabled={busy}
              onClick={() => {
                setAdvanced(!advanced);
                edited();
              }}
            >
              {advanced ? 'Use an address' : 'Advanced'}
            </button>
            <button type="button" className="st-button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <Group>
      <Row id="cloudServer" description={serverDescription(server)} below={panel}>
        {server?.locked || open ? undefined : (
          <button type="button" className="st-button" disabled={busy} onClick={() => setOpen(true)}>
            Change
          </button>
        )}
      </Row>
    </Group>
  );
}
