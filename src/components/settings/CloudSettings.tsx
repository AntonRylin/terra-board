import { useCallback, useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import type { CloudDevice, CloudStatus } from '../../bridge';
import { Group, Notice, Row, useNotice } from './controls';

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

export function CloudSettings() {
  const cloud = window.canvas?.cloud;
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [devices, setDevices] = useState<CloudDevice[]>([]);
  const [code, setCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNotice();
  const [, tick] = useState(0);

  useEffect(() => {
    if (!cloud) return;
    void cloud.status().then(setStatus);
    const stop = cloud.onStatus(setStatus);
    const timer = setInterval(() => tick((n) => n + 1), 15000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [cloud]);

  const on = !!status && status.state !== 'off';
  const loadDevices = useCallback(() => {
    if (cloud && on)
      void cloud
        .devices()
        .then(setDevices)
        .catch(() => {});
  }, [cloud, on]);
  useEffect(loadDevices, [loadDevices]);

  const act = async (job: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await job();
      if (done) setNotice({ text: done });
    } catch (error) {
      setNotice({ text: String(error).replace(/^Error: /, ''), error: true });
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

  if (!on)
    return (
      <>
        <Group>
          <Row id="cloudEnable">
            <button
              type="button"
              className="st-button primary"
              disabled={busy}
              onClick={() => act(() => cloud.enable(), 'Sync is on.')}
            >
              {busy ? 'Turning on…' : 'Turn on'}
            </button>
          </Row>
          <Row id="cloudJoin">
            <span className="cloud-join">
              <input
                aria-label="Code from your other computer"
                placeholder="XXXXX-XXXXX"
                value={joinCode}
                maxLength={11}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && joinCode.trim())
                    void act(() => cloud.join(joinCode), 'Joined. Your boards are syncing.');
                }}
              />
              <button
                type="button"
                className="st-button"
                disabled={busy || joinCode.replace(/[^0-9A-Z]/g, '').length < 10}
                onClick={() => act(() => cloud.join(joinCode), 'Joined. Your boards are syncing.')}
              >
                Join
              </button>
            </span>
          </Row>
        </Group>
        <p className="st-hint cloud-hint">
          No account needed. Boards already on this computer are added to the synced library.
        </p>
        <Notice notice={notice} />
      </>
    );

  return (
    <>
      <Group>
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
                  Enter it on the other computer in Settings → Cloud sync. Works once, for 15
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
      </Group>
      <Group title="Computers">
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
        {!devices.length && <Row title="Loading…" />}
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
        Your synced library is tied to these computers, not to an email address. Keep at least one
        of them, or the cloud copy cannot be recovered.
      </p>
      <Notice notice={notice} />
    </>
  );
}
