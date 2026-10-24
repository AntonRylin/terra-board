import { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, ScrollText, ShieldCheck, UserRound } from 'lucide-react';
import type { AuditEvent, CloudStatus, CompanyPerson, CompanyStatus } from '../../bridge';
import { Group, Row, Switch } from './controls';
import { ListRow } from './list';

type Act = (job: () => Promise<unknown>, done?: string) => Promise<void>;

const company = () => window.canvas!.cloud.company!;

const size = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${Math.round(bytes / 1e6)} MB`
      : bytes > 0
        ? `${Math.max(1, Math.round(bytes / 1e3))} KB`
        : null;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

// An audit event in words: "anton@acme.eu shared a board".
export function auditText(e: AuditEvent) {
  const d = e.details as Record<string, string | number | null | undefined>;
  const who = e.actorEmail || 'Someone';
  const thing = d.kind === 'folder' ? 'a folder' : 'a board';
  const member = d.memberName ? String(d.memberName) : 'someone';
  const board = d.name ? `board “${d.name}”` : 'a board';
  const device = d.name ? `“${d.name}”` : 'a device';
  const person = d.email ? String(d.email) : 'a person';
  const words: Record<string, string> = {
    'share.created': `shared ${thing}`,
    'share.deleted': `stopped sharing ${thing}`,
    'share.member_added': `gave ${member} ${d.role === 'edit' ? 'edit' : 'view'} access to a share`,
    'share.member_role_changed': `changed ${member} from ${d.from} to ${d.role} on a share`,
    'share.member_removed': `removed ${member} from a share`,
    'board.created': `created ${board}`,
    'board.deleted': `deleted ${board}`,
    'board.restored': `restored ${board}`,
    'device.added': `signed in on ${device}`,
    'device.removed': `signed out ${device}`,
    'account.created': `created an account for ${person}`,
    'account.deleted': `deleted the account of ${person}`,
    'person.disabled': `disabled the sign-in of ${person}`,
    'person.enabled': `enabled the sign-in of ${person}`,
    'admin.added': `made ${e.target || 'someone'} an admin`,
    'admin.removed': `removed admin rights from ${e.target || 'someone'}`,
    'license.set': `added a license key${d.customer ? ` for ${d.customer}, ${d.seats} people` : ''}`,
    'license.cleared': 'removed the license key',
    'audit.on': 'turned the audit log on',
    'audit.off': 'turned the audit log off',
  };
  return `${who} ${words[e.action] || e.action}`;
}

// One line under the server name for everyone on a server over its free or licensed limit.
export function LicenseNote({ company }: { company?: CompanyStatus | null }) {
  const note = company?.summary.note;
  if (!note) return null;
  return (
    <p className="st-hint cloud-hint" role="status">
      {note}
    </p>
  );
}

function License({ status, busy, act }: { status: CompanyStatus; busy: boolean; act: Act }) {
  const [key, setKey] = useState('');
  const [open, setOpen] = useState(false);
  const { license, summary } = status;
  const title = license
    ? license.state === 'valid' || license.state === 'grace'
      ? `${license.customer} · ${license.seats} people`
      : 'License key not accepted'
    : 'Free self-hosting';
  const subtitle = license
    ? license.message
    : `${status.people} of ${status.freePeople} people. Above ${status.freePeople}, this server needs a license key.`;
  return (
    <Group title="Server license">
      <ListRow
        icon={<KeyRound size={18} />}
        title={title}
        subtitle={subtitle}
        meta={
          <span className="st-list-count">
            {summary.people}/{summary.limit}
          </span>
        }
        open={open}
        onToggle={() => setOpen((o) => !o)}
      >
        <div className="server-panel">
          <input
            aria-label="License key"
            placeholder="TBL1.…"
            value={key}
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
          />
          <div className="server-actions">
            <button
              type="button"
              className="st-button primary"
              disabled={busy || !key.trim()}
              onClick={() =>
                void act(async () => {
                  await company()('setLicense', key.trim());
                  setKey('');
                  setOpen(false);
                }, 'License key saved.')
              }
            >
              Save key
            </button>
            {license && (
              <button
                type="button"
                className="st-button"
                disabled={busy}
                onClick={() =>
                  void act(() => company()('setLicense', null), 'License key removed.')
                }
              >
                Remove key
              </button>
            )}
          </div>
          <p className="server-note">
            Free for up to {status.freePeople} people (accounts that can sign in). The key is
            checked in the app; nothing stops working without one.
          </p>
        </div>
      </ListRow>
    </Group>
  );
}

function People({ me, busy, act }: { me?: string | null; busy: boolean; act: Act }) {
  const [people, setPeople] = useState<CompanyPerson[] | null>(null);
  const [search, setSearch] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (text: string) =>
      company()('people', { search: text, limit: 200 })
        .then((list) => {
          setPeople(list);
          setError(null);
        })
        .catch((e) => setError(String(e?.message || e))),
    [],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(search), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [search, load]);
  const change = (job: () => Promise<unknown>, done: string) =>
    act(async () => {
      await job();
      await load(search);
    }, done);

  return (
    <Group title="People on this server">
      <div className="server-panel">
        <input
          type="search"
          aria-label="Search people"
          placeholder="Search by email"
          value={search}
          spellCheck={false}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {error && <Row title="Could not load the people" description={error} />}
      {people?.length === 0 && !error && (
        <Row title={search ? 'Nobody matches' : 'Nobody has signed in yet'} />
      )}
      {people?.map((p) => {
        const self = !!me && p.email?.toLowerCase() === me.toLowerCase();
        const facts = [
          p.admin ? 'Admin' : null,
          p.disabled ? 'Disabled' : null,
          p.lastSignIn ? `Last sign-in ${when(p.lastSignIn)}` : 'Never signed in',
          p.devices ? `${p.devices} device${p.devices === 1 ? '' : 's'}` : null,
          size(p.storageBytes),
        ].filter(Boolean);
        return (
          <ListRow
            key={p.id}
            icon={p.admin ? <ShieldCheck size={18} /> : <UserRound size={18} />}
            title={p.email || p.id}
            subtitle={facts.join(' · ')}
            menu={[
              p.email
                ? {
                    label: p.admin ? 'Remove admin rights' : 'Make admin',
                    disabled: busy,
                    action: () =>
                      void change(
                        () => company()('setAdmin', p.email!, !p.admin),
                        p.admin ? `${p.email} is no longer an admin.` : `${p.email} is an admin.`,
                      ),
                  }
                : null,
              self
                ? null
                : {
                    label: p.disabled ? 'Enable sign-in' : 'Disable sign-in',
                    danger: !p.disabled,
                    disabled: busy,
                    hint: p.disabled
                      ? undefined
                      : 'Signs them out everywhere. Their cloud boards stay.',
                    action: () =>
                      void change(
                        () => company()('setDisabled', p.id, !p.disabled),
                        p.disabled
                          ? `${p.email} can sign in again.`
                          : `${p.email} is signed out and can't sign in.`,
                      ),
                  },
            ]}
          />
        );
      })}
      <div className="server-panel">
        <p className="server-note">Add an admin by email. It works before they first sign in.</p>
        <input
          type="email"
          aria-label="Admin email"
          placeholder="it@company.com"
          value={adminEmail}
          spellCheck={false}
          onChange={(e) => setAdminEmail(e.target.value)}
        />
        <div className="server-actions">
          <button
            type="button"
            className="st-button"
            disabled={busy || !adminEmail.trim()}
            onClick={() =>
              void change(async () => {
                await company()('setAdmin', adminEmail, true);
                setAdminEmail('');
              }, `${adminEmail.trim()} is an admin.`)
            }
          >
            Add admin
          </button>
        </div>
      </div>
    </Group>
  );
}

function AuditLog({ status, busy, act }: { status: CompanyStatus; busy: boolean; act: Act }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const page = 50;
  const load = useCallback((before: number | null) => {
    void company()('audit', { before, limit: page })
      .then((list) => {
        setEvents((old) => (before && old ? [...old, ...list] : list));
        setMore(list.length === page);
      })
      .catch(() => setEvents((old) => old ?? []));
  }, []);
  useEffect(() => load(null), [load, status.audit]);
  const bridge = window.canvas!.cloud;
  return (
    <Group
      title="Audit log"
      action={
        <button
          type="button"
          className="st-button"
          disabled={busy || !events?.length}
          onClick={() =>
            void act(async () => {
              const count = await bridge.companyExportAudit!();
              if (count === false) return;
            }, 'Audit log saved.')
          }
        >
          <Download size={14} />
          Export CSV
        </button>
      }
    >
      <Row
        title="Keep an audit log"
        description="Records sharing, board creation and deletion, devices and admin actions, with who did them."
      >
        <Switch
          label="Keep an audit log"
          checked={status.audit}
          disabled={busy}
          onChange={(on) =>
            void act(
              () => company()('setAudit', on),
              on ? 'The audit log is on.' : 'The audit log is off.',
            )
          }
        />
      </Row>
      {events?.length === 0 && <Row title="Nothing recorded yet" />}
      {events?.map((e) => (
        <ListRow
          key={e.id}
          icon={<ScrollText size={18} />}
          title={auditText(e)}
          subtitle={when(e.at)}
        />
      ))}
      {more && (
        <div className="server-panel">
          <div className="server-actions">
            <button
              type="button"
              className="st-button"
              onClick={() => load(events?.at(-1)?.id ?? null)}
            >
              Show older
            </button>
          </div>
        </div>
      )}
    </Group>
  );
}

// Settings → Account → Server admin, for admins of a company server (ee/).
export function ServerAdmin({
  status,
  busy,
  act,
}: {
  status: CloudStatus;
  busy: boolean;
  act: Act;
}) {
  const info = status.company;
  if (!info?.admin || !window.canvas?.cloud.company) return null;
  return (
    <>
      <License status={info} busy={busy} act={act} />
      <People me={status.account.email} busy={busy} act={act} />
      <AuditLog status={info} busy={busy} act={act} />
    </>
  );
}
