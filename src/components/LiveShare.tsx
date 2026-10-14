import { useEffect, useState } from 'react';
import { Check, Copy, Radio, UserPlus, X } from 'lucide-react';
import type { LivePermission, LiveStatus } from '../bridge';
import './live-share.css';

const inactive: LiveStatus = { active: false };

export function useLiveStatus() {
  const [status, setStatus] = useState<LiveStatus>(inactive);
  useEffect(() => {
    const live = window.canvas?.live;
    if (!live) return;
    void live.status().then(setStatus);
    return live.onStatus(setStatus);
  }, []);
  return status;
}

function PermissionSwitch({
  value,
  onChange,
  label,
}: {
  value: LivePermission;
  onChange: (value: LivePermission) => void;
  label: string;
}) {
  return (
    <div className="live-segments" role="radiogroup" aria-label={label}>
      {(['view', 'edit'] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => value !== option && onChange(option)}
        >
          {option === 'view' ? 'View' : 'Edit'}
        </button>
      ))}
    </div>
  );
}

function TailscaleNote() {
  return (
    <p className="live-note">
      Friends not on your Wi-Fi? Install{' '}
      <button
        type="button"
        className="live-link"
        onClick={() => void window.canvas?.openExternal('https://tailscale.com/download')}
      >
        Tailscale
      </button>{' '}
      (free) on both computers and sign in to the same Tailscale network. A Tailscale link then
      appears here and works from anywhere, encrypted, without opening your router.
    </p>
  );
}

export function LiveShareDialog({
  boardId,
  boardName,
  sharedName,
  status,
  onClose,
}: {
  boardId: string;
  boardName: string;
  sharedName?: string;
  status: LiveStatus;
  onClose: () => void;
}) {
  const live = window.canvas?.live;
  const [permission, setPermission] = useState<LivePermission>('view');
  const [ask, setAsk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (e) {
      setError(
        String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''),
      );
    } finally {
      setBusy(false);
    }
  };
  if (!live) return <p className="quiet">Live sharing works in the desktop app.</p>;

  if (status.active && status.boardId !== boardId)
    return (
      <>
        <p className="quiet">
          You are sharing “{sharedName || 'another board'}” right now. Stop it to share this board
          instead.
        </p>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => run(() => live.stop())}
          >
            Stop sharing
          </button>
        </div>
      </>
    );

  if (!status.active)
    return (
      <>
        <p className="quiet">
          People on the same Wi-Fi open a link in their browser and see “{boardName}” live. It comes
          straight from this computer while Terra Board is open. Nothing is uploaded.
        </p>
        <div className="live-row">
          <span>Guests can</span>
          <PermissionSwitch value={permission} onChange={setPermission} label="Guests can" />
        </div>
        <label className="live-row live-check">
          <span>Ask me before someone joins</span>
          <input type="checkbox" checked={ask} onChange={(e) => setAsk(e.target.checked)} />
        </label>
        <TailscaleNote />
        {error && (
          <p className="live-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => run(() => live.start({ boardId, permission, ask }))}
          >
            {busy ? 'Starting…' : 'Start sharing'}
          </button>
        </div>
      </>
    );

  const links = status.links || [];
  const hasTailscale = links.some((l) => l.label === 'Tailscale');
  return (
    <>
      <div className="live-links">
        {links.length ? (
          links.map((link) => (
            <div className="live-link-row" key={link.url}>
              <div>
                <strong>{link.label}</strong>
                <code>{link.url.replace(/\?k=.*/, '?k=…')}</code>
              </div>
              <button
                type="button"
                className="button"
                aria-label={`Copy ${link.label} link`}
                onClick={() =>
                  void window.canvas?.copyText(link.url).then(() => setCopied(link.url))
                }
              >
                {copied === link.url ? <Check size={15} /> : <Copy size={15} />}
                {copied === link.url ? 'Copied' : 'Copy link'}
              </button>
            </div>
          ))
        ) : (
          <p className="quiet">No network found. Connect to Wi-Fi, then reopen this window.</p>
        )}
      </div>
      {!hasTailscale && <TailscaleNote />}
      <div className="live-row">
        <span>New guests can</span>
        <PermissionSwitch
          value={status.permission || 'view'}
          onChange={(p) => run(() => live.configure({ permission: p }))}
          label="New guests can"
        />
      </div>
      <label className="live-row live-check">
        <span>Ask me before someone joins</span>
        <input
          type="checkbox"
          checked={!!status.ask}
          onChange={(e) => void run(() => live.configure({ ask: e.target.checked }))}
        />
      </label>
      {!!status.requests?.length && (
        <div className="live-list">
          <h3>Waiting to join</h3>
          {status.requests.map((r) => (
            <div className="live-person" key={r.id}>
              <UserPlus size={15} />
              <span className="live-name">{r.name}</span>
              <button
                type="button"
                className="button"
                onClick={() => run(() => live.answer(r.id, false))}
              >
                Deny
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => run(() => live.answer(r.id, true))}
              >
                Let in
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="live-list">
        <h3>Guests</h3>
        {status.guests?.length ? (
          status.guests.map((g) => (
            <div className="live-person" key={g.id}>
              <span className="live-dot" data-online={g.online || undefined} />
              <span className="live-name">{g.name}</span>
              <PermissionSwitch
                value={g.permission}
                onChange={(p) => run(() => live.setGuestPermission(g.id, p))}
                label={`${g.name} can`}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${g.name}`}
                onClick={() => run(() => live.removeGuest(g.id))}
              >
                <X size={15} />
              </button>
            </div>
          ))
        ) : (
          <p className="quiet small">Nobody has joined yet. Send them a link.</p>
        )}
      </div>
      <p className="live-note">
        Only computers on your network or Tailscale can connect. Anyone you let in sees this board
        and nothing else on your computer.
      </p>
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => run(() => live.stop())}
        >
          Stop sharing
        </button>
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}

// Join requests pop up wherever the host is, so nobody waits unseen.
export function LiveRequests({ status }: { status: LiveStatus }) {
  const live = window.canvas?.live;
  if (!live || !status.active || !status.requests?.length) return null;
  return (
    <div className="live-requests" role="region" aria-label="Join requests">
      {status.requests.map((r) => (
        <div className="live-request glass-surface" key={r.id} role="alert">
          <UserPlus size={16} />
          <span>
            <strong>{r.name}</strong> wants to join
          </span>
          <button type="button" className="button" onClick={() => void live.answer(r.id, false)}>
            Deny
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => void live.answer(r.id, true)}
          >
            Let in
          </button>
        </div>
      ))}
    </div>
  );
}

export function LiveBadge({ status, onOpen }: { status: LiveStatus; onOpen: () => void }) {
  if (!status.active) return null;
  const online = status.guests?.filter((g) => g.online).length || 0;
  return (
    <button type="button" className="live-badge glass-surface" onClick={onOpen}>
      <Radio size={14} />
      Live
      <span>
        {online} {online === 1 ? 'guest' : 'guests'}
      </span>
    </button>
  );
}
