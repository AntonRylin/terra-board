-- Terra Board company server: server roles (admin, member, guest), teams, and the company
-- edition marker the app looks for.
--
-- This file is under ee/LICENSE (Terra Board Enterprise License, commercial), not the MIT
-- license of supabase/migrations. It runs after every core migration in supabase/migrations
-- and after 20261025090000_company.sql. It never redefines a core function; it only adds
-- tables, functions and triggers, and replaces company_status and admin_people of the first
-- company migration (same signatures, every earlier key kept).
-- Safe to run twice: tables are created if missing, functions replaced, triggers recreated.
--
-- Calls (security definer; admin_* refuse anyone who is not a server admin with 42501):
--   company_info()                              -> { edition: 'company', sso }   (anon too)
--   my_server_role()                            -> 'admin' | 'member' | 'guest'
--   company_status()                            -> { admin, license, people, freePeople, audit,
--                                                    role, defaultRole, sso }
--   admin_people(p_search, p_limit, p_offset)   -> ... each entry also has role
--   admin_set_sso(p_on)                         -> void
--   admin_set_role(p_email, p_role)             -> void   ('member' | 'guest')
--   admin_set_default_role(p_role)              -> void   ('member' | 'guest')
--   company_teams()                             -> jsonb array of { id, name, members, mine }
--   admin_create_team(p_name)                   -> uuid
--   admin_rename_team(p_team, p_name)           -> void
--   admin_delete_team(p_team)                   -> void
--   admin_team_members(p_team)                  -> jsonb array of { id, email }
--   admin_set_team_member(p_team, p_user, p_in) -> void
--   share_with_team(p_share, p_team, p_role)    -> void   (the share's owner)
--   unshare_team(p_share, p_team)               -> void   (the share's owner)
--   share_teams(p_share)                        -> jsonb array of { team, name, role, members }
--
-- Roles. A person is an admin while their email is in server_admins (admin wins over any
-- role row), else the role in server_roles for their email, else company_settings.default_role.
-- Anonymous computers (pre-account devices) count as members, so nothing changes for them.
-- Guests may only view: they can't create invite codes or share with teams, and their access
-- to other people's shares is capped at view.
--
-- Teams. Sharing a board or folder with a team gives every team member who has a personal
-- workspace a row in the core share_members table, so the app's sync (shared_with_me, the
-- read and write policies) needs nothing new. team_grants remembers which rows a team made
-- and the direct role a person had before (direct_role). A person's role is the strongest of
-- their direct role and their teams' roles; when the last team grant goes, the direct role
-- comes back, or the row goes when there was none. team_sync_share recomputes one share from
-- scratch and runs whenever teams, their members, their shares or personal workspaces change.
-- Direct changes to a team-granted row by the core sharing calls: set_share_role changes the
-- direct role (the team role still applies on top); removing the row (remove_share_member,
-- leaving) removes the direct role and keeps the team access.

alter table public.company_settings
  add column if not exists sso_enabled boolean not null default true;
alter table public.company_settings
  add column if not exists default_role text not null default 'member'
    check (default_role in ('member', 'guest'));

-- Roles set by an admin, by lowercase email (the person may not have an account yet).
create table if not exists public.server_roles (
  email text primary key
    check (char_length(email) <= 320 and email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('member', 'guest')),
  set_at timestamptz not null default now(),
  set_by uuid
);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  created_at timestamptz not null default now(),
  -- No references to who did it, so deleting that user never touches a team.
  created_by uuid
);
create unique index if not exists teams_name on public.teams (lower(name));

create table if not exists public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid,
  primary key (team_id, user_id)
);
create index if not exists team_members_user on public.team_members (user_id);

create table if not exists public.team_shares (
  team_id uuid not null references public.teams (id) on delete cascade,
  share_id uuid not null references public.shares (id) on delete cascade,
  role text not null check (role in ('view', 'edit')),
  added_at timestamptz not null default now(),
  added_by uuid,
  primary key (team_id, share_id)
);
create index if not exists team_shares_share on public.team_shares (share_id);

-- share_members rows that exist (or have their role) because of teams.
--   direct_role  the role the person had without teams; null = no access without teams
create table if not exists public.team_grants (
  share_id uuid not null references public.shares (id) on delete cascade,
  member_workspace uuid not null references public.workspaces (id) on delete cascade,
  direct_role text check (direct_role in ('view', 'edit')),
  primary key (share_id, member_workspace)
);
create index if not exists team_grants_member on public.team_grants (member_workspace);

alter table public.server_roles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_shares enable row level security;
alter table public.team_grants enable row level security;
-- No policies: only the functions below use these tables.

-- Emails are stored trimmed and lowercase (the same trigger function as server_admins).
drop trigger if exists normalize on public.server_roles;
create trigger normalize before insert or update on public.server_roles
  for each row execute function public.server_admins_normalize();

-- The edition marker: the app shows company sign-in only on servers where this exists.
create or replace function public.company_info()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'edition', 'company',
    'sso', coalesce((select s.sso_enabled from public.company_settings s where s.id), true)
  )
$$;

-- 'admin', 'member' or 'guest' for a user. Internal (not granted).
create or replace function public.server_role(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when u.id is null or coalesce(u.is_anonymous, false) then 'member'
    when exists (select 1 from public.server_admins a where a.email = lower(u.email)) then 'admin'
    else coalesce(
      (select r.role from public.server_roles r where r.email = lower(u.email)),
      (select s.default_role from public.company_settings s where s.id),
      'member')
  end
  from (select p_user as id) x
  left join auth.users u on u.id = x.id
$$;

create or replace function public.my_server_role()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  return public.server_role(auth.uid());
end;
$$;

-- The role of the person whose personal workspace this is ('member' for other workspaces).
create or replace function public.workspace_server_role(p_workspace uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select public.server_role(a.user_id) from public.accounts a
     where a.personal_workspace = p_workspace),
    'member')
$$;

-- What a share's teams give: one row per team member's personal workspace (never the share's
-- own workspace), with the strongest role of their teams; guests get view.
create or replace function public.team_share_roles(p_share uuid)
returns table (member_workspace uuid, user_id uuid, role text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.personal_workspace, a.user_id,
    case when bool_or(ts.role = 'edit') and public.server_role(a.user_id) <> 'guest'
      then 'edit' else 'view' end
  from public.team_shares ts
  join public.shares s on s.id = ts.share_id
  join public.team_members tm on tm.team_id = ts.team_id
  join public.accounts a on a.user_id = tm.user_id
  join public.workspaces w on w.id = a.personal_workspace
  where ts.share_id = p_share and a.personal_workspace <> s.workspace_id
  group by a.personal_workspace, a.user_id
$$;

-- Recomputes the share_members rows a share's teams make. Its own writes to share_members
-- are marked with the transaction setting terra.team_sync, so the share_members triggers
-- below don't take them for direct changes.
create or replace function public.team_sync_share(p_share uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  prev text := current_setting('terra.team_sync', true);
  owner_ws uuid;
  r record;
  direct text;
  eff text;
begin
  if p_share is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('public.team_sync:' || p_share::text, 0));
  perform set_config('terra.team_sync', 'on', true);
  select workspace_id into owner_ws from public.shares where id = p_share;
  if owner_ws is null then
    delete from public.team_grants where share_id = p_share;
    perform set_config('terra.team_sync', coalesce(prev, ''), true);
    return;
  end if;

  -- Team access that went away: back to the direct role, or no access.
  for r in
    select g.member_workspace, g.direct_role
    from public.team_grants g
    where g.share_id = p_share
      and not exists (
        select 1 from public.team_share_roles(p_share) d
        where d.member_workspace = g.member_workspace)
  loop
    if r.direct_role is null or r.member_workspace = owner_ws then
      delete from public.share_members
      where share_id = p_share and member_workspace = r.member_workspace;
    else
      update public.share_members set role = r.direct_role
      where share_id = p_share and member_workspace = r.member_workspace
        and role is distinct from r.direct_role;
    end if;
    delete from public.team_grants
    where share_id = p_share and member_workspace = r.member_workspace;
  end loop;

  -- Team access that is (still) there.
  for r in
    select d.member_workspace, d.user_id, d.role,
      g.share_id is not null as granted, g.direct_role,
      m.share_id is not null as has_row, m.role as had_role
    from public.team_share_roles(p_share) d
    left join public.team_grants g
      on g.share_id = p_share and g.member_workspace = d.member_workspace
    left join public.share_members m
      on m.share_id = p_share and m.member_workspace = d.member_workspace
  loop
    if r.granted then
      direct := r.direct_role;
    else
      direct := r.had_role;
      insert into public.team_grants (share_id, member_workspace, direct_role)
      values (p_share, r.member_workspace, direct);
    end if;
    eff := case when (r.role = 'edit' or direct = 'edit')
      and public.server_role(r.user_id) <> 'guest' then 'edit' else 'view' end;
    if r.has_row then
      update public.share_members set role = eff
      where share_id = p_share and member_workspace = r.member_workspace
        and role is distinct from eff;
    else
      insert into public.share_members (share_id, member_workspace, role)
      values (p_share, r.member_workspace, eff);
    end if;
  end loop;
  perform set_config('terra.team_sync', coalesce(prev, ''), true);
end;
$$;

-- Every share given to any team the user is in.
create or replace function public.team_sync_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s uuid;
begin
  for s in
    select distinct ts.share_id from public.team_shares ts
    join public.team_members tm on tm.team_id = ts.team_id
    where tm.user_id = p_user
  loop
    perform public.team_sync_share(s);
  end loop;
end;
$$;

-- After a person's role may have changed: a guest's edit access becomes view (direct and
-- team-given), and their team shares are recomputed (a member gets team edit access back).
create or replace function public.company_role_changed(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  prev text := current_setting('terra.team_sync', true);
  ws uuid;
begin
  select personal_workspace into ws from public.accounts where user_id = p_user;
  if ws is not null and public.server_role(p_user) = 'guest' then
    perform set_config('terra.team_sync', 'on', true);
    update public.share_members set role = 'view' where member_workspace = ws and role = 'edit';
    update public.team_grants set direct_role = 'view'
    where member_workspace = ws and direct_role = 'edit';
    perform set_config('terra.team_sync', coalesce(prev, ''), true);
  end if;
  perform public.team_sync_user(p_user);
end;
$$;

-- Guests can't create invite codes.
create or replace function public.guard_share_invites()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.server_role(auth.uid()) = 'guest' then
    raise exception 'Guests can''t invite people on this server' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists guests on public.share_invites;
create trigger guests before insert on public.share_invites
  for each row execute function public.guard_share_invites();

-- share_members writes: a guest's role is capped at view, and a direct change to a row that
-- a team made changes its direct role (the team role still applies on top). Never fails the
-- write.
create or replace function public.guard_share_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  team_role text;
begin
  begin
    if new.role = 'edit' and public.workspace_server_role(new.member_workspace) = 'guest' then
      new.role := 'view';
    end if;
    if tg_op = 'UPDATE' and current_setting('terra.team_sync', true) is distinct from 'on' then
      update public.team_grants set direct_role = new.role
      where share_id = new.share_id and member_workspace = new.member_workspace;
      if found then
        select d.role into team_role from public.team_share_roles(new.share_id) d
        where d.member_workspace = new.member_workspace;
        if team_role = 'edit' then
          new.role := 'edit';
        end if;
      end if;
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;
drop trigger if exists guard on public.share_members;
create trigger guard before insert or update of role on public.share_members
  for each row execute function public.guard_share_members();

-- A team-made row removed directly: the direct role is gone, the team access stays.
create or replace function public.share_members_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('terra.team_sync', true) is distinct from 'on' then
    begin
      delete from public.team_grants
      where share_id = old.share_id and member_workspace = old.member_workspace;
      if found then
        perform public.team_sync_share(old.share_id);
      end if;
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;
drop trigger if exists teams on public.share_members;
create trigger teams after delete on public.share_members
  for each row execute function public.share_members_removed();

-- Team changes recompute the shares they touch.
create or replace function public.team_shares_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s uuid;
begin
  for s in select distinct share_id from changed loop
    perform public.team_sync_share(s);
  end loop;
  return null;
end;
$$;
drop trigger if exists sync_insert on public.team_shares;
drop trigger if exists sync_update on public.team_shares;
drop trigger if exists sync_delete on public.team_shares;
create trigger sync_insert after insert on public.team_shares
  referencing new table as changed
  for each statement execute function public.team_shares_changed();
create trigger sync_update after update on public.team_shares
  referencing new table as changed
  for each statement execute function public.team_shares_changed();
create trigger sync_delete after delete on public.team_shares
  referencing old table as changed
  for each statement execute function public.team_shares_changed();

create or replace function public.team_members_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s uuid;
begin
  for s in
    select distinct ts.share_id from public.team_shares ts
    where ts.team_id in (select c.team_id from changed c)
  loop
    perform public.team_sync_share(s);
  end loop;
  return null;
end;
$$;
drop trigger if exists sync_insert on public.team_members;
drop trigger if exists sync_delete on public.team_members;
create trigger sync_insert after insert on public.team_members
  referencing new table as changed
  for each statement execute function public.team_members_changed();
create trigger sync_delete after delete on public.team_members
  referencing old table as changed
  for each statement execute function public.team_members_changed();

-- A person getting (or changing) their personal workspace gets their teams' shares there.
create or replace function public.accounts_teams()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.personal_workspace is not distinct from new.personal_workspace then
    return null;
  end if;
  begin
    perform public.team_sync_user(new.user_id);
  exception when others then
    null;
  end;
  return null;
end;
$$;
drop trigger if exists teams on public.accounts;
create trigger teams after insert or update of personal_workspace on public.accounts
  for each row execute function public.accounts_teams();

-- A share moving to another workspace (retire_workspace) never grants the new owner itself.
create or replace function public.shares_teams()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.workspace_id is distinct from new.workspace_id then
    begin
      perform public.team_sync_share(new.id);
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;
drop trigger if exists teams on public.shares;
create trigger teams after update of workspace_id on public.shares
  for each row execute function public.shares_teams();

-- What every signed-in user may know about the server:
--   admin        whether the caller is a server admin
--   license      the license key, or null (the app checks its signature, seats and expiry)
--   people       accounts counted against the license: not anonymous, not disabled
--   freePeople   how many people a server may have without a license
--   audit        whether the audit log is on
--   role         the caller's role: admin, member or guest
--   defaultRole  the role of people an admin has not given one: member or guest
--   sso          whether company sign-in (SSO) is on
create or replace function public.company_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  return (
    select jsonb_build_object(
      'admin', public.is_server_admin(),
      'license', s.license_key,
      'people', (
        select count(*)::int from auth.users u
        where not coalesce(u.is_anonymous, false)
          and (u.banned_until is null or u.banned_until <= now())),
      'freePeople', 10,
      'audit', s.audit_enabled,
      'role', public.server_role(auth.uid()),
      'defaultRole', s.default_role,
      'sso', s.sso_enabled
    )
    from public.company_settings s
    where s.id
  );
end;
$$;

-- The people on the server (accounts, not anonymous computers), sorted by email.
-- p_search matches part of the email; p_limit 1..500 (default 100). Each entry:
--   { id, email, created, lastSignIn, disabled, admin, devices, storageBytes, role }
--   devices       computers signed in to the account (not removed)
--   storageBytes  media in the person's own library; null when storage can't be read
--   role          admin, member or guest
create or replace function public.admin_people(
  p_search text default null,
  p_limit int default 100,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pattern text := '%' || replace(replace(replace(
    coalesce(btrim(p_search), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  perform public.require_server_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id,
      'email', p.email,
      'created', p.created_at,
      'lastSignIn', p.last_sign_in_at,
      'disabled', coalesce(p.banned_until > now(), false),
      'admin', exists (select 1 from public.server_admins a where a.email = lower(p.email)),
      'devices', (
        select count(*)::int from public.devices d
        where d.user_id = p.id and d.revoked_at is null),
      'storageBytes', public.company_workspace_bytes(
        (select personal_workspace from public.accounts where user_id = p.id)),
      'role', public.server_role(p.id)
    ) order by p.sort_email, p.id)
    from (
      select u.id, u.email, u.created_at, u.last_sign_in_at, u.banned_until,
        lower(coalesce(u.email, '')) as sort_email
      from auth.users u
      where not coalesce(u.is_anonymous, false)
        and coalesce(u.email, '') ilike pattern
      order by lower(coalesce(u.email, '')), u.id
      limit least(greatest(coalesce(p_limit, 100), 1), 500)
      offset greatest(coalesce(p_offset, 0), 0)
    ) p
  ), '[]'::jsonb);
end;
$$;

-- Turns company sign-in (SSO) on or off.
create or replace function public.admin_set_sso(p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_server_admin();
  if p_on is null then
    raise exception 'Choose on or off' using errcode = '22023';
  end if;
  update public.company_settings set sso_enabled = p_on, updated_at = now() where id;
  perform public.company_audit(case when p_on then 'sso.on' else 'sso.off' end, null);
end;
$$;

-- Gives someone a role by email (they may not have an account yet). Admins stay admins.
create or replace function public.admin_set_role(p_email text, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  addr text := lower(btrim(coalesce(p_email, '')));
  who uuid;
begin
  perform public.require_server_admin();
  if p_role is null or p_role not in ('member', 'guest') then
    raise exception 'Choose member or guest' using errcode = '22023';
  end if;
  if char_length(addr) > 320 or addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  insert into public.server_roles (email, role, set_at, set_by)
  values (addr, p_role, now(), auth.uid())
  on conflict (email) do update
    set role = excluded.role, set_at = excluded.set_at, set_by = excluded.set_by;
  for who in
    select u.id from auth.users u
    where lower(u.email) = addr and not coalesce(u.is_anonymous, false)
  loop
    perform public.company_role_changed(who);
  end loop;
  perform public.company_audit('role.set', addr, jsonb_build_object('email', addr, 'role', p_role));
end;
$$;

-- The role of everyone an admin has not given one.
create or replace function public.admin_set_default_role(p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous text;
  who uuid;
begin
  perform public.require_server_admin();
  if p_role is null or p_role not in ('member', 'guest') then
    raise exception 'Choose member or guest' using errcode = '22023';
  end if;
  select default_role into previous from public.company_settings where id for update;
  update public.company_settings set default_role = p_role, updated_at = now() where id;
  if previous is not distinct from p_role then
    return;
  end if;
  for who in
    select a.user_id from public.accounts a
    join auth.users u on u.id = a.user_id
    where not coalesce(u.is_anonymous, false)
      and not exists (select 1 from public.server_roles r where r.email = lower(u.email))
  loop
    perform public.company_role_changed(who);
  end loop;
  perform public.company_audit('role.default', null, jsonb_build_object('from', previous, 'role', p_role));
end;
$$;

-- Teams.

create or replace function public.team_name_check(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  shown text := btrim(coalesce(p_name, ''));
begin
  if shown = '' then
    raise exception 'Enter a team name' using errcode = '22023';
  end if;
  if char_length(shown) > 80 then
    raise exception 'A team name has at most 80 characters' using errcode = '22023';
  end if;
  return shown;
end;
$$;

-- The server's teams, for anyone signed in with an account: { id, name, members, mine }.
create or replace function public.company_teams()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null or not exists (
    select 1 from auth.users u where u.id = uid and not coalesce(u.is_anonymous, false)
  ) then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id,
      'name', t.name,
      'members', (select count(*)::int from public.team_members m where m.team_id = t.id),
      'mine', exists (
        select 1 from public.team_members m where m.team_id = t.id and m.user_id = uid)
    ) order by lower(t.name), t.id)
    from public.teams t
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_create_team(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  shown text;
  team uuid;
begin
  perform public.require_server_admin();
  shown := public.team_name_check(p_name);
  begin
    insert into public.teams (name, created_by) values (shown, auth.uid()) returning id into team;
  exception when unique_violation then
    raise exception 'A team with this name already exists' using errcode = '22023';
  end;
  perform public.company_audit('team.created', team::text, jsonb_build_object('name', shown));
  return team;
end;
$$;

create or replace function public.admin_rename_team(p_team uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  shown text;
  previous text;
begin
  perform public.require_server_admin();
  shown := public.team_name_check(p_name);
  select name into previous from public.teams where id = p_team for update;
  if not found then
    raise exception 'This team does not exist' using errcode = '22023';
  end if;
  if previous = shown then
    return;
  end if;
  begin
    update public.teams set name = shown where id = p_team;
  exception when unique_violation then
    raise exception 'A team with this name already exists' using errcode = '22023';
  end;
  perform public.company_audit('team.renamed', p_team::text,
    jsonb_build_object('from', previous, 'name', shown));
end;
$$;

-- Deleting a team takes away the access it gave (direct access stays).
create or replace function public.admin_delete_team(p_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  shown text;
begin
  perform public.require_server_admin();
  select name into shown from public.teams where id = p_team for update;
  if not found then
    raise exception 'This team does not exist' using errcode = '22023';
  end if;
  -- Shares first, so removing the members has nothing left to recompute.
  delete from public.team_shares where team_id = p_team;
  delete from public.teams where id = p_team;
  perform public.company_audit('team.deleted', p_team::text, jsonb_build_object('name', shown));
end;
$$;

create or replace function public.admin_team_members(p_team uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_server_admin();
  if not exists (select 1 from public.teams where id = p_team) then
    raise exception 'This team does not exist' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email)
      order by lower(coalesce(u.email, '')), u.id)
    from public.team_members m
    join auth.users u on u.id = m.user_id
    where m.team_id = p_team
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_set_team_member(p_team uuid, p_user uuid, p_in boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  team_name text;
  who text;
begin
  perform public.require_server_admin();
  if p_team is null or p_user is null or p_in is null then
    raise exception 'Choose a team, a person and whether they are in it' using errcode = '22023';
  end if;
  select name into team_name from public.teams where id = p_team;
  if not found then
    raise exception 'This team does not exist' using errcode = '22023';
  end if;
  if p_in then
    select email into who from auth.users
    where id = p_user and not coalesce(is_anonymous, false);
    if not found then
      raise exception 'This person is not on this server' using errcode = '22023';
    end if;
    insert into public.team_members (team_id, user_id, added_by)
    values (p_team, p_user, auth.uid())
    on conflict (team_id, user_id) do nothing;
    if found then
      perform public.company_audit('team.member_added', p_team::text,
        jsonb_build_object('team', team_name, 'user', p_user, 'email', who));
    end if;
  else
    select email into who from auth.users where id = p_user;
    delete from public.team_members where team_id = p_team and user_id = p_user;
    if found then
      perform public.company_audit('team.member_removed', p_team::text,
        jsonb_build_object('team', team_name, 'user', p_user, 'email', who));
    end if;
  end if;
end;
$$;

-- Shares a board or folder with a team (or changes the team's role on it).
create or replace function public.share_with_team(p_share uuid, p_team uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  team_name text;
  share_kind text;
  previous text;
begin
  if not public.signed_in_account() then
    raise exception 'Sign in to share boards' using errcode = '28000';
  end if;
  perform public.share_owner_check(p_share);
  if public.server_role(auth.uid()) = 'guest' then
    raise exception 'Guests can''t share on this server' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('view', 'edit') then
    raise exception 'Choose view or edit' using errcode = '22023';
  end if;
  select name into team_name from public.teams where id = p_team;
  if not found then
    raise exception 'This team does not exist' using errcode = '22023';
  end if;
  select kind into share_kind from public.shares where id = p_share;
  select role into previous from public.team_shares
  where team_id = p_team and share_id = p_share for update;
  if previous is not distinct from p_role then
    return;
  end if;
  if previous is null then
    insert into public.team_shares (team_id, share_id, role, added_by)
    values (p_team, p_share, p_role, auth.uid());
    perform public.company_audit('share.team_added', p_share::text, jsonb_build_object(
      'team', p_team, 'teamName', team_name, 'kind', share_kind, 'role', p_role));
  else
    update public.team_shares set role = p_role where team_id = p_team and share_id = p_share;
    perform public.company_audit('share.team_role_changed', p_share::text, jsonb_build_object(
      'team', p_team, 'teamName', team_name, 'kind', share_kind, 'from', previous, 'role', p_role));
  end if;
end;
$$;

create or replace function public.unshare_team(p_share uuid, p_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous text;
begin
  perform public.share_owner_check(p_share);
  delete from public.team_shares where team_id = p_team and share_id = p_share
  returning role into previous;
  if found then
    perform public.company_audit('share.team_removed', p_share::text, jsonb_build_object(
      'team', p_team,
      'teamName', (select name from public.teams where id = p_team),
      'kind', (select kind from public.shares where id = p_share),
      'role', previous));
  end if;
end;
$$;

-- The teams a share is given to: { team, name, role, members }, sorted by name.
create or replace function public.share_teams(p_share uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.share_owner_check(p_share);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'team', t.id,
      'name', t.name,
      'role', ts.role,
      'members', (select count(*)::int from public.team_members m where m.team_id = t.id)
    ) order by lower(t.name), t.id)
    from public.team_shares ts
    join public.teams t on t.id = ts.team_id
    where ts.share_id = p_share
  ), '[]'::jsonb);
end;
$$;

-- Internal functions and triggers: nobody calls them through the API.
revoke execute on function public.server_role(uuid) from public, anon, authenticated;
revoke execute on function public.workspace_server_role(uuid) from public, anon, authenticated;
revoke execute on function public.team_share_roles(uuid) from public, anon, authenticated;
revoke execute on function public.team_sync_share(uuid) from public, anon, authenticated;
revoke execute on function public.team_sync_user(uuid) from public, anon, authenticated;
revoke execute on function public.company_role_changed(uuid) from public, anon, authenticated;
revoke execute on function public.team_name_check(text) from public, anon, authenticated;
revoke execute on function public.guard_share_invites() from public, anon, authenticated;
revoke execute on function public.guard_share_members() from public, anon, authenticated;
revoke execute on function public.share_members_removed() from public, anon, authenticated;
revoke execute on function public.team_shares_changed() from public, anon, authenticated;
revoke execute on function public.team_members_changed() from public, anon, authenticated;
revoke execute on function public.accounts_teams() from public, anon, authenticated;
revoke execute on function public.shares_teams() from public, anon, authenticated;

revoke execute on function public.company_info() from public;
revoke execute on function public.my_server_role() from public, anon;
revoke execute on function public.company_status() from public, anon;
revoke execute on function public.admin_people(text, int, int) from public, anon;
revoke execute on function public.admin_set_sso(boolean) from public, anon;
revoke execute on function public.admin_set_role(text, text) from public, anon;
revoke execute on function public.admin_set_default_role(text) from public, anon;
revoke execute on function public.company_teams() from public, anon;
revoke execute on function public.admin_create_team(text) from public, anon;
revoke execute on function public.admin_rename_team(uuid, text) from public, anon;
revoke execute on function public.admin_delete_team(uuid) from public, anon;
revoke execute on function public.admin_team_members(uuid) from public, anon;
revoke execute on function public.admin_set_team_member(uuid, uuid, boolean) from public, anon;
revoke execute on function public.share_with_team(uuid, uuid, text) from public, anon;
revoke execute on function public.unshare_team(uuid, uuid) from public, anon;
revoke execute on function public.share_teams(uuid) from public, anon;
grant execute on function public.company_info() to anon, authenticated;
grant execute on function public.my_server_role() to authenticated;
grant execute on function public.company_status() to authenticated;
grant execute on function public.admin_people(text, int, int) to authenticated;
grant execute on function public.admin_set_sso(boolean) to authenticated;
grant execute on function public.admin_set_role(text, text) to authenticated;
grant execute on function public.admin_set_default_role(text) to authenticated;
grant execute on function public.company_teams() to authenticated;
grant execute on function public.admin_create_team(text) to authenticated;
grant execute on function public.admin_rename_team(uuid, text) to authenticated;
grant execute on function public.admin_delete_team(uuid) to authenticated;
grant execute on function public.admin_team_members(uuid) to authenticated;
grant execute on function public.admin_set_team_member(uuid, uuid, boolean) to authenticated;
grant execute on function public.share_with_team(uuid, uuid, text) to authenticated;
grant execute on function public.unshare_team(uuid, uuid) to authenticated;
grant execute on function public.share_teams(uuid) to authenticated;

-- Tables are readable only through the functions above.
revoke all on public.server_roles from anon, authenticated;
revoke all on public.teams from anon, authenticated;
revoke all on public.team_members from anon, authenticated;
revoke all on public.team_shares from anon, authenticated;
revoke all on public.team_grants from anon, authenticated;
