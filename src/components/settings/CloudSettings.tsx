import { useCallback, useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import type { CloudDevice, CloudStatus } from '../../bridge';
import type { Library } from '../../model';
import { Group, Notice, Row, Switch, useNotice } from './controls';

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

const clean = (e: unknown) =>
  String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');

export function CloudSettings({
  library,
  onManageShare,
}: {
  library?: Library;
  onManageShare?: (kind: 'folder' | 'board', id: string) => void;
}) {
  const cloud = window.canvas?.cloud;
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [devices, setDevices] = useState<CloudDevice[]>([]);
  const [code, setCode] = useState('');
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

  const identity = !!status?.identity;
  const loadDevices = useCallback(() => {
    if (cloud && identity)
      void cloud
        .devices()
        .then(setDevices)
        .catch(() => {});
  }, [cloud, identity]);
  useEffect(loadDevices, [loadDevices]);

  const act = async (job: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await job();
      if (done) setNotice({ text: done });
    } catch (error) {
      setNotice({ text: clean(error), error: true });
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
  if (!status.configured)
    return (
      <Group>
        <Row
          title="Cloud sync"
          description="This build of Terra Board is not connected to a sync service."
        />
      </Group>
    );

  const itemName = (kind: 'folder' | 'board', id: string) =>
    (kind === 'folder'
      ? library?.folders.find((f) => f.id === id)?.name
      : library?.boards.find((b) => b.id === id)?.name) || 'Removed item';
  const join = (
    <Row id="cloudJoin">
      <span className="cloud-join">
        <input
          aria-label="Code you were given"
          placeholder="XXXXX-XXXXX"
          value={joinCode}
          maxLength={14}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
        />
        <button
          type="button"
          className="st-button"
          disabled={
            busy ||
            joinCode.replace(/[^0-9A-Z]/g, '').length < 10 ||
            (!identity && joinCode.startsWith('S') && !name.trim())
          }
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
              disabled={busy || !name.trim()}
              onClick={() => act(() => cloud.enable(name.trim()), 'Sync is on.')}
            >
              {busy ? 'Turning on…' : 'Turn on'}
            </button>
          </Row>
          {join}
        </Group>
        <p className="st-hint cloud-hint">
          No account needed. To share just one folder or board, choose Share… in its menu; the rest
          of your library stays on this computer.
        </p>
        <Notice notice={notice} />
      </>
    );

  return (
    <>
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

      <Group title="Your computers">
        <Row
          id="cloudAddDevice"
          below={
            code && (
              <div className="cloud-code">
                <code>{code.slice(0, 5) + '-' + code.slice(5)}</code>
                <button
                  type="button"
                  className="st-button"
                  onClick={() =>
                    void window.canvas
                      ?.copyText(code)
                      .then(() => setNotice({ text: 'Code copied.' }))
                  }
                >
                  <Copy size={14} />
                  Copy
                </button>
                <span>
                  Enter it on your other computer in Settings → Cloud sync. Works once, for 15
                  minutes.
                </span>
              </div>
            )
          }
        >
          <button
            type="button"
            className="st-button"
            disabled={busy}
            onClick={() =>
              act(async () => {
                setCode(await cloud.pairingCode());
                setTimeout(loadDevices, 20000);
              })
            }
          >
            {code ? 'New code' : 'Create code'}
          </button>
        </Row>
        {devices.map((d) => (
          <Row
            key={d.id}
            title={
              <>
                {d.name}
                {d.current && <span className="cloud-tag">This computer</span>}
              </>
            }
            description={'Added ' + new Date(d.joined).toLocaleDateString()}
          >
            {!d.current && (
              <button
                type="button"
                className="st-button"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await cloud.removeDevice(d.id);
                    loadDevices();
                  }, `${d.name} no longer syncs.`)
                }
              >
                Remove
              </button>
            )}
          </Row>
        ))}
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
      <p className="st-hint cloud-hint">
        Your cloud identity is tied to these computers, not to an email address. Keep at least one
        of them, or what is stored in the cloud cannot be recovered.
      </p>
      <Notice notice={notice} />
    </>
  );
}
