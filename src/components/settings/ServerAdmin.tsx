import { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, ScrollText, ShieldCheck, UserRound, Users } from 'lucide-react';
import type {
  AuditEvent,
  CloudStatus,
  CompanyPerson,
  CompanyStatus,
  CompanyTeam,
} from '../../bridge';
import { Group, Row, Select, Switch } from './controls';
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
    'role.set': `made ${person} a ${d.role === 'guest' ? 'guest' : 'member'}`,
    'role.default': `set new people to join as ${d.role === 'guest' ? 'guests' : 'members'}`,
    'sso.on': 'turned company sign-in on',
    'sso.off': 'turned company sign-in off',
    'team.created': `created the team ${d.name || ''}`,
    'team.renamed': `renamed a team to ${d.name || ''}`,
    'team.deleted': `deleted the team ${d.name || ''}`,
    'team.member_added': `added ${person} to ${d.team || 'a team'}`,
    'team.member_removed': `removed ${person} from ${d.team || 'a team'}`,
    'share.team_added': `shared ${thing} with ${d.teamName || 'a team'}`,
    'share.team_removed': `took ${thing} away from ${d.teamName || 'a team'}`,
    'share.team_role_changed': `changed what ${d.teamName || 'a team'} can do on ${thing}`,
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

function People({
  me,
  teams,
  busy,
  act,
}: {
  me?: string | null;
  teams: boolean;
  busy: boolean;
  act: Act;
}) {
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
          p.admin ? 'Admin' : p.role === 'guest' ? 'Guest' : 'Member',
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
              p.email && !p.admin && teams
                ? {
                    label: p.role === 'guest' ? 'Make member' : 'Make guest',
                    disabled: busy,
                    hint:
                      p.role === 'guest'
                        ? undefined
                        : 'Guests can only view what is shared with them, and cannot share.',
                    action: () =>
                      void change(
                        () =>
                          company()('setRole', p.email!, p.role === 'guest' ? 'member' : 'guest'),
                        p.role === 'guest' ? `${p.email} is a member.` : `${p.email} is a guest.`,
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

// Server-wide choices: the role new people get, and company sign-in.
function ServerChoices({ status, busy, act }: { status: CompanyStatus; busy: boolean; act: Act }) {
  return (
    <Group title="Server settings">
      <Row
        title="New people join as"
        description="Members can share boards. Guests can only view what is shared with them."
      >
        <Select
          label="New people join as"
          value={status.defaultRole}
          options={[
            { value: 'member', label: 'Member' },
            { value: 'guest', label: 'Guest' },
          ]}
          onChange={(role) =>
            void act(
              () => company()('setDefaultRole', role),
              role === 'guest' ? 'New people join as guests.' : 'New people join as members.',
            )
          }
        />
      </Row>
      <Row
        title="Company sign-in"
        description="Sign in through your identity provider (SAML). SAML must also be set up on the server."
      >
        <Switch
          label="Company sign-in"
          checked={status.sso}
          disabled={busy}
          onChange={(on) =>
            void act(
              () => company()('setSso', on),
              on ? 'Company sign-in is on.' : 'Company sign-in is off.',
            )
          }
        />
      </Row>
    </Group>
  );
}

// One team, opened: its members, adding someone, renaming and deleting it.
function TeamDetail({
  team,
  busy,
  act,
  onChanged,
}: {
  team: CompanyTeam;
  busy: boolean;
  act: Act;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<{ id: string; email: string | null }[] | null>(null);
  const [people, setPeople] = useState<CompanyPerson[]>([]);
  const [add, setAdd] = useState('');
  const [name, setName] = useState(team.name);
  const load = useCallback(() => {
    void company()('teamMembers', team.id)
      .then(setMembers)
      .catch(() => setMembers([]));
    void company()('people', { limit: 500 })
      .then(setPeople)
      .catch(() => {});
  }, [team.id]);
  useEffect(load, [load]);
  const change = (job: () => Promise<unknown>, done: string) =>
    act(async () => {
      await job();
      load();
      onChanged();
    }, done);
  const outside = people.filter((p) => !p.disabled && !members?.some((m) => m.id === p.id));
  return (
    <div className="server-panel">
      {members?.length === 0 && <p className="server-note">Nobody in this team yet.</p>}
      {members?.map((m) => (
        <div className="server-actions team-member" key={m.id}>
          <span className="server-note">{m.email || m.id}</span>
          <button
            type="button"
            className="st-button"
            disabled={busy}
            onClick={() =>
              void change(
                () => company()('setTeamMember', team.id, m.id, false),
                `${m.email || 'They'} left ${team.name}.`,
              )
            }
          >
            Remove
          </button>
        </div>
      ))}
      {outside.length > 0 && (
        <div className="server-actions">
          <Select
            label="Add to the team"
            value={add}
            options={[
              { value: '', label: 'Add someone…' },
              ...outside.map((p) => ({ value: p.id, label: p.email || p.id })),
            ]}
            onChange={setAdd}
          />
          <button
            type="button"
            className="st-button primary"
            disabled={busy || !add}
            onClick={() =>
              void change(async () => {
                await company()('setTeamMember', team.id, add, true);
                setAdd('');
              }, 'Added to the team.')
            }
          >
            Add
          </button>
        </div>
      )}
      <input
        aria-label="Team name"
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="server-actions">
        <button
          type="button"
          className="st-button"
          disabled={busy || !name.trim() || name.trim() === team.name}
          onClick={() => void change(() => company()('renameTeam', team.id, name), 'Team renamed.')}
        >
          Rename
        </button>
        <button
          type="button"
          className="st-button danger"
          disabled={busy}
          onClick={() =>
            void change(
              () => company()('deleteTeam', team.id),
              `${team.name} is deleted. Its members lose the access the team gave them.`,
            )
          }
        >
          Delete team
        </button>
      </div>
    </div>
  );
}

// Teams: share a board with a team once; people added to the team later get it too.
function Teams({ busy, act }: { busy: boolean; act: Act }) {
  const [teams, setTeams] = useState<CompanyTeam[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const load = useCallback(() => {
    void company()('teams')
      .then(setTeams)
      .catch(() => setTeams([]));
  }, []);
  useEffect(load, [load]);
  return (
    <Group title="Teams">
      {teams?.length === 0 && (
        <Row
          title="No teams yet"
          description="Share a board with a team once; people you add to the team later get it too."
        />
      )}
      {teams?.map((t) => (
        <ListRow
          key={t.id}
          icon={<Users size={18} />}
          title={t.name}
          subtitle={`${t.members} ${t.members === 1 ? 'person' : 'people'}`}
          open={open === t.id}
          onToggle={() => setOpen((o) => (o === t.id ? null : t.id))}
        >
          {open === t.id && <TeamDetail team={t} busy={busy} act={act} onChanged={load} />}
        </ListRow>
      ))}
      <div className="server-panel">
        <input
          aria-label="New team name"
          placeholder="New team, like Marketing"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="server-actions">
          <button
            type="button"
            className="st-button"
            disabled={busy || !name.trim()}
            onClick={() =>
              void act(async () => {
                await company()('createTeam', name);
                setName('');
                load();
              }, `${name.trim()} is created.`)
            }
          >
            Create team
          </button>
        </div>
      </div>
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
      {info.teams && <ServerChoices status={info} busy={busy} act={act} />}
      <People me={status.account.email} teams={info.teams} busy={busy} act={act} />
      {info.teams && <Teams busy={busy} act={act} />}
      <AuditLog status={info} busy={busy} act={act} />
    </>
  );
}
