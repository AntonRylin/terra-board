-- Terra Board company server: server admins, people management, license key storage and the
-- audit log.
--
-- This file is under ee/LICENSE (Terra Board Enterprise License, commercial), not the MIT
-- license of supabase/migrations. It runs after every core migration in supabase/migrations
-- and never redefines a core function; it only adds tables, functions and triggers.
-- Safe to run twice: tables are created if missing, functions replaced, triggers recreated.
--
-- Setup adds the first admin by email, before that person has an account:
--   insert into public.server_admins (email) values ('it@acme.eu');
--
-- Calls (all security definer, granted to signed-in users; admin_* refuse anyone who is not a
-- server admin with errcode 42501):
--   company_status()                          -> { admin, license, people, freePeople, audit }
--   admin_people(p_search, p_limit, p_offset) -> jsonb array of
--       { id, email, created, lastSignIn, disabled, admin, devices, storageBytes }
--   admin_set_disabled(p_user, p_disabled)    -> void
--   admin_set_admin(p_email, p_admin)         -> void
--   admin_set_license(p_key)                  -> void
--   admin_set_audit(p_on)                     -> void
--   admin_audit(p_before, p_limit)            -> jsonb array, newest first, of
--       { id, at, actor, actorEmail, action, target, details }
-- Lists are jsonb arrays (camelCase keys, like every object this file returns), never table rows.
--
-- People = accounts that are not anonymous and not disabled. The free limit is 10 people;
-- above that the app asks for a license key. Nothing here blocks anyone.
-- Disabled = auth.users.banned_until in the future. Disabling sets it 100 years ahead (as the
-- Auth admin API's ban_duration does), not 'infinity': Auth reads banned_until into a Go time
-- value, which cannot hold infinity.

-- Server admins, by lowercase email. Admin = a signed-in, not anonymous, not disabled user
-- whose auth.users email (looked up by auth.uid(), never taken from the JWT) is listed here.
create table if not exists public.server_admins (
  email text primary key
    check (char_length(email) <= 320 and email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  added_at timestamptz not null default now(),
  -- Who added it (no reference, so deleting that user never touches this list).
  added_by uuid
);

-- Server-wide company settings, one row.
--   license_key    TBL1.<payload>.<signature>, checked by the app (Ed25519); null = free
--   audit_enabled  whether the audit log records events
create table if not exists public.company_settings (
  id boolean primary key default true check (id),
  license_key text check (char_length(license_key) <= 4096),
  audit_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.company_settings default values on conflict (id) do nothing;

-- What happened on the server and who did it. Only admins read it (admin_audit).
--   actor        the signed-in user that caused it (null for changes made outside the API)
--   actor_email  their email at the time
--   action       share.created, share.deleted, share.member_added, share.member_role_changed,
--                share.member_removed, board.created, board.deleted, board.restored,
--                device.added, device.removed, account.created, account.deleted,
--                person.disabled, person.enabled, admin.added, admin.removed,
--                license.set, license.cleared, audit.on, audit.off
--   target       the id of what it happened to (share, board, device or user id; admin email)
create table if not exists public.audit_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_email text,
  action text not null,
  target text,
  details jsonb not null default '{}'
);

alter table public.server_admins enable row level security;
alter table public.company_settings enable row level security;
alter table public.audit_events enable row level security;
-- server_admins and company_settings have no policies: only the functions below use them.

-- Emails are stored trimmed and lowercase, however setup writes them.
create or replace function public.server_admins_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;
drop trigger if exists normalize on public.server_admins;
create trigger normalize before insert or update on public.server_admins
  for each row execute function public.server_admins_normalize();

create or replace function public.is_server_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.server_admins a on a.email = lower(u.email)
    where u.id = auth.uid()
      and not coalesce(u.is_anonymous, false)
      and (u.banned_until is null or u.banned_until <= now())
  )
$$;

drop policy if exists "Server admins read the audit log" on public.audit_events;
create policy "Server admins read the audit log" on public.audit_events
  for select to authenticated using (public.is_server_admin());

create or replace function public.require_server_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_server_admin() then
    raise exception 'Only a server admin can do this' using errcode = '42501';
  end if;
end;
$$;

-- Records one event while the audit log is on (p_always: even when it is off, for turning
-- it off). Never fails: an event that can't be written is dropped, the change still happens.
create or replace function public.company_audit(
  p_action text,
  p_target text,
  p_details jsonb default '{}',
  p_always boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if not p_always and not coalesce(
    (select audit_enabled from public.company_settings where id), true) then
    return;
  end if;
  insert into public.audit_events (actor, actor_email, action, target, details)
  values (uid, (select email from auth.users where id = uid), p_action, p_target,
    coalesce(p_details, '{}'));
exception when others then
  null;
end;
$$;

-- Bytes of media in a workspace's folder of the assets bucket; null when storage can't be read.
create or replace function public.company_workspace_bytes(p_workspace uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_workspace is null then
    return 0;
  end if;
  return (
    select coalesce(sum(case when o.metadata ->> 'size' ~ '^[0-9]{1,18}$'
      then (o.metadata ->> 'size')::bigint else 0 end), 0)
    from storage.objects o
    where o.bucket_id = 'assets' and o.name like p_workspace::text || '/%'
  );
exception when insufficient_privilege or undefined_table or undefined_column then
  return null;
end;
$$;

-- Audit triggers. They only record; nothing they do can make the change itself fail.

create or replace function public.audit_shares()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform public.company_audit('share.created', new.id::text, jsonb_build_object(
        'workspace', new.workspace_id, 'kind', new.kind, 'targetId', new.target_id));
    elsif tg_op = 'DELETE' then
      perform public.company_audit('share.deleted', old.id::text, jsonb_build_object(
        'workspace', old.workspace_id, 'kind', old.kind, 'targetId', old.target_id));
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$$;
drop trigger if exists audit on public.shares;
create trigger audit after insert or delete on public.shares
  for each row execute function public.audit_shares();

create or replace function public.audit_share_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform public.company_audit('share.member_added', new.share_id::text, jsonb_build_object(
        'member', new.member_workspace, 'role', new.role,
        'memberName', (select display_name from public.workspaces where id = new.member_workspace)));
    elsif tg_op = 'UPDATE' then
      if new.role is distinct from old.role then
        perform public.company_audit('share.member_role_changed', new.share_id::text,
          jsonb_build_object('member', new.member_workspace, 'from', old.role, 'role', new.role,
            'memberName', (select display_name from public.workspaces where id = new.member_workspace)));
      end if;
    elsif tg_op = 'DELETE' then
      perform public.company_audit('share.member_removed', old.share_id::text, jsonb_build_object(
        'member', old.member_workspace, 'role', old.role,
        'memberName', (select display_name from public.workspaces where id = old.member_workspace)));
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$$;
drop trigger if exists audit on public.share_members;
create trigger audit after insert or update or delete on public.share_members
  for each row execute function public.audit_share_members();

-- Boards: a board row added, or its deleted flag flipping (objects never reach this function).
create or replace function public.audit_boards()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if tg_op = 'INSERT' then
      if not new.deleted then
        perform public.company_audit('board.created', new.id, jsonb_build_object(
          'workspace', new.workspace_id, 'name', new.data ->> 'name'));
      end if;
    elsif new.deleted and not old.deleted then
      perform public.company_audit('board.deleted', new.id, jsonb_build_object(
        'workspace', new.workspace_id, 'name', old.data ->> 'name'));
    elsif old.deleted and not new.deleted then
      perform public.company_audit('board.restored', new.id, jsonb_build_object(
        'workspace', new.workspace_id, 'name', new.data ->> 'name'));
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$$;
drop trigger if exists audit_board_insert on public.entities;
drop trigger if exists audit_board_update on public.entities;
create trigger audit_board_insert after insert on public.entities
  for each row when (new.kind = 'board' and new.board_id = '')
  execute function public.audit_boards();
create trigger audit_board_update after update on public.entities
  for each row when (new.kind = 'board' and new.board_id = '' and old.deleted is distinct from new.deleted)
  execute function public.audit_boards();

-- Devices: added (or signed in again after removal) and removed (signed out from the account,
-- or deleted with it).
create or replace function public.audit_devices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_user uuid;
  info jsonb;
begin
  begin
    row_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
    info := jsonb_build_object(
      'user', row_user,
      'email', (select email from auth.users where id = row_user),
      'name', case when tg_op = 'DELETE' then old.name else new.name end);
    if tg_op = 'INSERT' then
      if new.revoked_at is null then
        perform public.company_audit('device.added', new.id::text, info);
      end if;
    elsif tg_op = 'UPDATE' then
      if old.revoked_at is null and new.revoked_at is not null then
        perform public.company_audit('device.removed', new.id::text, info);
      elsif old.revoked_at is not null and new.revoked_at is null then
        perform public.company_audit('device.added', new.id::text, info);
      end if;
    elsif old.revoked_at is null then
      perform public.company_audit('device.removed', old.id::text, info);
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$$;
drop trigger if exists audit on public.devices;
create trigger audit after insert or update of revoked_at or delete on public.devices
  for each row execute function public.audit_devices();

-- Accounts: public.accounts gets its row the first time a signed-in person syncs or registers
-- a device (auth.users itself can't carry triggers on hosted Supabase).
create or replace function public.audit_accounts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform public.company_audit('account.created', new.user_id::text, jsonb_build_object(
        'email', (select email from auth.users where id = new.user_id)));
    elsif tg_op = 'DELETE' then
      perform public.company_audit('account.deleted', old.user_id::text, jsonb_build_object(
        'email', (select email from auth.users where id = old.user_id)));
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$$;
drop trigger if exists audit on public.accounts;
create trigger audit after insert or delete on public.accounts
  for each row execute function public.audit_accounts();

-- What every signed-in user may know about the server:
--   admin       whether the caller is a server admin
--   license     the license key, or null (the app checks its signature, seats and expiry)
--   people      accounts counted against the license: not anonymous, not disabled
--   freePeople  how many people a server may have without a license
--   audit       whether the audit log is on
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
      'audit', s.audit_enabled
    )
    from public.company_settings s
    where s.id
  );
end;
$$;

-- The people on the server (accounts, not anonymous computers), sorted by email.
-- p_search matches part of the email; p_limit 1..500 (default 100). Each entry:
--   { id, email, created, lastSignIn, disabled, admin, devices, storageBytes }
--   devices       computers signed in to the account (not removed)
--   storageBytes  media in the person's own library; null when storage can't be read
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
        (select personal_workspace from public.accounts where user_id = p.id))
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

-- Disables (or enables again) a person's sign-in. Disabling also ends their sessions at once.
create or replace function public.admin_set_disabled(p_user uuid, p_disabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  who text;
begin
  perform public.require_server_admin();
  if p_user is null or p_disabled is null then
    raise exception 'Choose a person and whether to disable them' using errcode = '22023';
  end if;
  if p_disabled and p_user = auth.uid() then
    raise exception 'You cannot disable your own account' using errcode = '22023';
  end if;
  select email into who from auth.users where id = p_user;
  if not found then
    raise exception 'This person is not on this server' using errcode = '22023';
  end if;
  begin
    update auth.users
    set banned_until = case when p_disabled then now() + interval '100 years' end
    where id = p_user;
  exception when insufficient_privilege then
    raise exception 'This server does not let Terra Board disable sign-ins. Disable the person in Supabase (Authentication → Users).'
      using errcode = '0A000';
  end;
  if p_disabled then
    begin
      delete from auth.sessions where user_id = p_user;
    exception when insufficient_privilege or undefined_table then
      null;
    end;
  end if;
  perform public.company_audit(
    case when p_disabled then 'person.disabled' else 'person.enabled' end,
    p_user::text, jsonb_build_object('email', who));
end;
$$;

-- Makes someone a server admin by email (they may not have an account yet), or removes them.
-- The server always keeps at least one admin who can sign in.
create or replace function public.admin_set_admin(p_email text, p_admin boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  addr text := lower(btrim(coalesce(p_email, '')));
begin
  perform public.require_server_admin();
  if p_admin is null then
    raise exception 'Choose whether to make them an admin' using errcode = '22023';
  end if;
  if char_length(addr) > 320 or addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('public.server_admins', 0));
  if p_admin then
    insert into public.server_admins (email, added_by) values (addr, auth.uid())
    on conflict (email) do nothing;
    if found then
      perform public.company_audit('admin.added', addr);
    end if;
  else
    delete from public.server_admins where email = addr;
    if not found then
      return;
    end if;
    if not exists (
      select 1 from public.server_admins a
      join auth.users u on lower(u.email) = a.email
      where not coalesce(u.is_anonymous, false)
        and (u.banned_until is null or u.banned_until <= now())
    ) then
      raise exception 'This is the last admin. Make someone else an admin first.'
        using errcode = '22023';
    end if;
    perform public.company_audit('admin.removed', addr);
  end if;
end;
$$;

-- Stores the license key; null or empty removes it. Only its shape is checked here; the app
-- checks the signature, seats, expiry and server.
create or replace function public.admin_set_license(p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  key text := nullif(btrim(coalesce(p_key, '')), '');
  payload text;
  info jsonb;
  details jsonb := '{}';
begin
  perform public.require_server_admin();
  if key is not null and (char_length(key) > 4096
    or key !~ '^TBL1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') then
    raise exception 'This is not a Terra Board license key' using errcode = '22023';
  end if;
  update public.company_settings set license_key = key, updated_at = now() where id;
  if key is null then
    perform public.company_audit('license.cleared', null);
    return;
  end if;
  -- Who the key is for, for the log (unverified; never the key itself).
  begin
    payload := translate(split_part(key, '.', 2), '-_', '+/');
    payload := payload || repeat('=', (4 - char_length(payload) % 4) % 4);
    info := convert_from(decode(payload, 'base64'), 'UTF8')::jsonb;
    if jsonb_typeof(info) = 'object' then
      details := jsonb_strip_nulls(jsonb_build_object(
        'license', info ->> 'id', 'customer', info ->> 'customer',
        'seats', info -> 'seats', 'expires', info ->> 'expires'));
    end if;
  exception when others then
    details := '{}';
  end;
  perform public.company_audit('license.set', info ->> 'id', details);
end;
$$;

-- Turns the audit log on or off. The switch itself is always recorded.
create or replace function public.admin_set_audit(p_on boolean)
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
  update public.company_settings set audit_enabled = p_on, updated_at = now() where id;
  perform public.company_audit(case when p_on then 'audit.on' else 'audit.off' end, null, '{}', true);
end;
$$;

-- The audit log, newest first: events with an id below p_before (all when null), at most
-- p_limit (1..1000, default 200). Page on with the id of the last event received.
create or replace function public.admin_audit(p_before bigint default null, p_limit int default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_server_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id,
      'at', e.at,
      'actor', e.actor,
      'actorEmail', e.actor_email,
      'action', e.action,
      'target', e.target,
      'details', e.details
    ) order by e.id desc)
    from (
      select * from public.audit_events
      where p_before is null or id < p_before
      order by id desc
      limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    ) e
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.server_admins_normalize() from public, anon, authenticated;
revoke execute on function public.company_audit(text, text, jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.company_workspace_bytes(uuid) from public, anon, authenticated;
revoke execute on function public.audit_shares() from public, anon, authenticated;
revoke execute on function public.audit_share_members() from public, anon, authenticated;
revoke execute on function public.audit_boards() from public, anon, authenticated;
revoke execute on function public.audit_devices() from public, anon, authenticated;
revoke execute on function public.audit_accounts() from public, anon, authenticated;
revoke execute on function public.is_server_admin() from public, anon;
revoke execute on function public.require_server_admin() from public, anon;
revoke execute on function public.company_status() from public, anon;
revoke execute on function public.admin_people(text, int, int) from public, anon;
revoke execute on function public.admin_set_disabled(uuid, boolean) from public, anon;
revoke execute on function public.admin_set_admin(text, boolean) from public, anon;
revoke execute on function public.admin_set_license(text) from public, anon;
revoke execute on function public.admin_set_audit(boolean) from public, anon;
revoke execute on function public.admin_audit(bigint, int) from public, anon;
grant execute on function public.is_server_admin() to authenticated;
grant execute on function public.require_server_admin() to authenticated;
grant execute on function public.company_status() to authenticated;
grant execute on function public.admin_people(text, int, int) to authenticated;
grant execute on function public.admin_set_disabled(uuid, boolean) to authenticated;
grant execute on function public.admin_set_admin(text, boolean) to authenticated;
grant execute on function public.admin_set_license(text) to authenticated;
grant execute on function public.admin_set_audit(boolean) to authenticated;
grant execute on function public.admin_audit(bigint, int) to authenticated;

-- Tables are readable only through the functions above and the audit policy.
revoke all on public.server_admins from anon, authenticated;
revoke all on public.company_settings from anon, authenticated;
revoke all on public.audit_events from anon;
revoke insert, update, delete, truncate on public.audit_events from authenticated;
revoke all on sequence public.audit_events_id_seq from anon, authenticated;
