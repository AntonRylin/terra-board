import { useState, type ReactNode } from 'react';
import {
  Cloud,
  HardDrive,
  Laptop,
  LogOut,
  Monitor,
  RotateCw,
  Smartphone,
  Users,
} from 'lucide-react';
import type { CloudDevice } from '../../bridge';
import { relativeTime } from '../board-info-text';
import { Group, Row } from './controls';
import { ListRow } from './list';
import { countPlaces, type PlaceGroup, type PlacedBoard } from './board-places';

const platformName: Record<string, string> = {
  win32: 'Windows',
  darwin: 'Mac',
  linux: 'Linux',
  android: 'Android',
  ios: 'iPhone',
};

const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

function DeviceIcon({ platform }: { platform: string | null }) {
  if (platform === 'android' || platform === 'ios') return <Smartphone size={18} />;
  if (platform === 'darwin') return <Laptop size={18} />;
  return <Monitor size={18} />;
}

// Every device signed in to the account. A row opens to where and when it signed in;
// its ⋯ menu signs it out after a confirm step.
export function DeviceList({
  devices,
  busy,
  onRetry,
  onSignOut,
}: {
  devices: CloudDevice[];
  busy: boolean;
  onRetry: () => void;
  onSignOut: (device: CloudDevice) => Promise<void>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const names = new Map<string, number>();
  for (const d of devices) names.set(d.name, (names.get(d.name) || 0) + 1);
  const repeated = [...names.values()].some((n) => n > 1);
  if (!devices.length)
    return (
      <Group title="Devices">
        <Row id="accountDevices" />
      </Group>
    );
  return (
    <Group title="Devices">
      {devices.map((d) => {
        const system = d.platform ? platformName[d.platform] || d.platform : null;
        const facts: [string, string | null][] = [
          ['Location', d.location],
          ['IP address', d.ip],
          ['Signed in', d.signedInAt ? dateText(d.signedInAt) : null],
          ['Last active', d.current ? 'Now' : relativeTime(Date.parse(d.lastSeen))],
          ['App', d.version ? `Terra Board ${d.version}` : null],
        ];
        const asking = confirm === d.id;
        return (
          <ListRow
            key={d.id}
            icon={<DeviceIcon platform={d.platform} />}
            title={
              <>
                {d.name}
                {d.current && <span className="st-badge">This device</span>}
              </>
            }
            subtitle={[system, d.location].filter(Boolean).join(', ') || undefined}
            meta={d.current ? 'Active now' : relativeTime(Date.parse(d.lastSeen))}
            open={open === d.id || asking || !!d.problem}
            onToggle={() => {
              setConfirm(null);
              setOpen(open === d.id ? null : d.id);
            }}
            menu={
              d.current
                ? []
                : [
                    {
                      label: 'Sign out…',
                      icon: <LogOut />,
                      danger: true,
                      action: () => setConfirm(d.id),
                    },
                  ]
            }
          >
            {d.problem ? (
              <div className="st-callout" data-tone="danger">
                <span>This device isn't on your account yet. {d.problem}</span>
                <button type="button" className="st-button" disabled={busy} onClick={onRetry}>
                  <RotateCw size={14} />
                  Try again
                </button>
              </div>
            ) : asking ? (
              <div className="st-callout">
                <span>
                  Sign out of {d.name}? It stops syncing at once and needs to sign in again. Boards
                  on it stay there.
                </span>
                <span className="st-callout-actions">
                  <button
                    type="button"
                    className="st-button"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="st-button danger"
                    disabled={busy}
                    onClick={() => void onSignOut(d).then(() => setConfirm(null))}
                  >
                    Sign out
                  </button>
                </span>
              </div>
            ) : (
              <dl className="st-facts">
                {facts.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd data-unknown={!value || undefined}>{value || 'Not known yet'}</dd>
                  </div>
                ))}
              </dl>
            )}
          </ListRow>
        );
      })}
      {repeated && (
        <p className="st-list-foot">
          Reinstalling the app adds a device again. Sign out the ones you no longer use.
        </p>
      )}
    </Group>
  );
}

// Where the boards are, each line leading to that part of the Boards page.
export function BoardSummary({
  boards,
  onOpen,
}: {
  boards: PlacedBoard[];
  onOpen?: (filter: PlaceGroup) => void;
}) {
  const counts = countPlaces(boards);
  const lines: { group: PlaceGroup; label: string; icon: ReactNode; count: number }[] = [
    {
      group: 'local',
      label: 'On this computer',
      icon: <HardDrive size={18} />,
      count: counts.local,
    },
    { group: 'cloud', label: 'In the cloud', icon: <Cloud size={18} />, count: counts.cloud },
    {
      group: 'received',
      label: 'Shared with you',
      icon: <Users size={18} />,
      count: counts.received,
    },
  ];
  return (
    <Group title="Boards">
      {lines.map((l) => (
        <ListRow
          key={l.group}
          icon={l.icon}
          title={l.label}
          meta={<span className="st-list-count">{l.count}</span>}
          onClick={onOpen ? () => onOpen(l.group) : undefined}
        />
      ))}
    </Group>
  );
}
