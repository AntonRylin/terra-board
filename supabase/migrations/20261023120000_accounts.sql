-- Accounts: people sign in with an email code or Google instead of being one anonymous
-- user per computer. An account has one personal workspace (the person, as sharing already
-- treats it) and a list of devices. Computers set up anonymously by 0.1.28 move onto an
-- account with the claim below. Anyone can delete their cloud data and sign-in.

-- Deleting a user never deletes a workspace by itself any more: the claim re-points
-- workspaces before it deletes the anonymous user, and this is the safety net.
alter table public.workspaces alter column created_by drop not null;
alter table public.workspaces drop constraint workspaces_created_by_fkey;
alter table public.workspaces add constraint workspaces_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

-- Every computer of an account is the same user, so a pull can't tell its own pushes from
-- those of the person's other computers by user id. Pushes name the device that sent them.
alter table public.entities add column updated_device uuid;

create table public.accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  personal_workspace uuid references public.workspaces (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index accounts_personal_workspace on public.accounts (personal_workspace)
  where personal_workspace is not null;

-- The computers signed in to an account. id is created once per installation.
create table public.devices (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  name text not null check (char_length(name) between 1 and 80),
  app_version text check (char_length(app_version) <= 40),
  session_id uuid,
  last_seen timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (user_id, id)
);

-- One-time secrets that let an account take over an anonymous computer's workspace.
create table public.account_claims (
  secret_hash text primary key,
  anon_user uuid not null references auth.users (id) on delete cascade,
  -- The workspace the computer syncs with now (it may be a member of older ones too).
  workspace uuid,
  expires_at timestamptz not null
);

-- Deletions whose sign-in could not be removed from SQL (see delete_my_cloud_data).
-- The data is already gone; an admin removes the user from Authentication → Users.
create table public.deletion_requests (
  user_id uuid primary key,
  requested_at timestamptz not null default now()
);

alter table public.accounts enable row level security;
alter table public.devices enable row level security;
alter table public.account_claims enable row level security;
alter table public.deletion_requests enable row level security;

create policy "People read their account" on public.accounts
  for select to authenticated using (user_id = auth.uid());
create policy "People read their devices" on public.devices
  for select to authenticated using (user_id = auth.uid());
-- account_claims and deletion_requests have no policies: only the functions below use them.

-- Signed in with an email code, Google or another provider, not anonymously.
create function public.signed_in_account()
returns boolean
language sql
stable
set search_path = ''
as $$
  select auth.uid() is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
$$;

-- The account's personal workspace, created the first time it syncs or shares.
-- Returns { workspace, name, created }; name is the one people see, which the first
-- computer chose and the others take over.
create function public.ensure_personal_workspace(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  ws uuid;
  shown text;
begin
  if not public.signed_in_account() then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  insert into public.accounts (user_id) values (uid) on conflict (user_id) do nothing;
  select personal_workspace into ws from public.accounts where user_id = uid for update;
  if ws is not null and exists (
    select 1 from public.workspace_members where workspace_id = ws and user_id = uid
  ) then
    select display_name into shown from public.workspaces where id = ws;
    return jsonb_build_object('workspace', ws, 'name', shown, 'created', false);
  end if;
  shown := left(nullif(btrim(p_name), ''), 60);
  insert into public.workspaces (name, created_by, display_name)
  values ('My boards', uid, shown)
  returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, uid, 'owner');
  update public.accounts set personal_workspace = ws where user_id = uid;
  return jsonb_build_object('workspace', ws, 'name', shown, 'created', true);
end;
$$;

create function public.my_account()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'userId', auth.uid(),
    'email', auth.jwt() ->> 'email',
    'anonymous', coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false),
    'personalWorkspace', a.personal_workspace,
    'name', w.display_name
  )
  from (select auth.uid() as uid) me
  left join public.accounts a on a.user_id = me.uid
  left join public.workspaces w on w.id = a.personal_workspace
$$;

-- Runs after sign-in and on every start. Returns { revoked: true } when this computer was
-- removed from the account and is still using the session it had then; the app then
-- signs out on this computer. Signing in again gives a new session and clears it.
create function public.register_device(p_id uuid, p_name text, p_version text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  known public.devices;
begin
  if not public.signed_in_account() then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  if p_id is null then
    raise exception 'Missing device id' using errcode = '22023';
  end if;
  select * into known from public.devices where user_id = uid and id = p_id for update;
  if found and known.revoked_at is not null
    and (sid is null or known.session_id is not distinct from sid) then
    return jsonb_build_object('revoked', true);
  end if;
  insert into public.accounts (user_id) values (uid) on conflict (user_id) do nothing;
  insert into public.devices (user_id, id, name, app_version, session_id, last_seen, revoked_at)
  values (uid, p_id, coalesce(left(nullif(btrim(p_name), ''), 80), 'Computer'),
    left(p_version, 40), sid, now(), null)
  on conflict (user_id, id) do update
    set name = excluded.name,
      app_version = excluded.app_version,
      session_id = excluded.session_id,
      last_seen = excluded.last_seen,
      revoked_at = null;
  return jsonb_build_object('revoked', false);
end;
$$;

-- Removes a computer from the account. Its session ends at once when the database allows
-- it; otherwise the computer finds out on its next start (register_device).
create function public.revoke_device(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sid uuid;
begin
  if not public.signed_in_account() then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  update public.devices set revoked_at = now()
  where user_id = uid and id = p_id
  returning session_id into sid;
  if not found then
    raise exception 'This computer is not on your account' using errcode = '22023';
  end if;
  if sid is not null then
    begin
      delete from auth.sessions where id = sid and user_id = uid;
    exception when insufficient_privilege or undefined_table then
      null;
    end;
  end if;
end;
$$;

-- Step 1 of the claim, run by the anonymous computer before it signs in. The secret is
-- returned once and kept only as a hash, for 15 minutes. p_workspace: the workspace this
-- computer syncs with now; it must own it.
create function public.begin_claim(p_workspace uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  secret text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if uid is null or not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Only a computer without an account can be claimed' using errcode = '22023';
  end if;
  if p_workspace is not null and coalesce(public.workspace_role(p_workspace), '') <> 'owner' then
    raise exception 'This computer does not sync with that workspace' using errcode = '42501';
  end if;
  delete from public.account_claims where expires_at < now() or anon_user = uid;
  insert into public.account_claims (secret_hash, anon_user, workspace, expires_at)
  values (encode(sha256(convert_to(secret, 'UTF8')), 'hex'), uid, p_workspace,
    now() + interval '15 minutes');
  return secret;
end;
$$;

-- Step 2, run by the account after signing in. The anonymous computer's workspace becomes
-- the account's personal workspace, or the account's existing one is kept:
--   moved    the anonymous workspace is now the personal workspace;
--   joined   both were already the same workspace, or the anonymous computer had none;
--   combine  the account already has another workspace: the app moves its library there and
--            then calls retire_workspace(retire, workspace);
--   none     neither has a workspace (or the anonymous one belongs to another account):
--            the app creates one with ensure_personal_workspace.
create function public.finish_claim(p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  claim public.account_claims;
  anon_ws uuid;
  personal uuid;
  taken boolean;
  outcome jsonb;
begin
  if not public.signed_in_account() then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  delete from public.account_claims
  where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex')
    and expires_at > now()
  returning * into claim;
  if not found then
    raise exception 'This sign-in took too long. Try again.' using errcode = '22023';
  end if;
  if claim.anon_user = uid then
    raise exception 'Sign in first' using errcode = '28000';
  end if;

  -- The workspace the computer named, else (an older app) its first one.
  select workspace_id into anon_ws from public.workspace_members
  where user_id = claim.anon_user and role = 'owner'
  order by workspace_id is distinct from claim.workspace, joined_at limit 1;
  insert into public.accounts (user_id) values (uid) on conflict (user_id) do nothing;
  select personal_workspace into personal from public.accounts where user_id = uid for update;
  if personal is not null and not exists (
    select 1 from public.workspace_members where workspace_id = personal and user_id = uid
  ) then
    personal := null;
  end if;
  -- Another account already owns that library: this account does not get into it.
  taken := anon_ws is not null and exists (
    select 1 from public.accounts where personal_workspace = anon_ws and user_id <> uid
  );

  if not taken then
    -- Never into a library that is another account's.
    insert into public.workspace_members (workspace_id, user_id, role)
    select m.workspace_id, uid, m.role from public.workspace_members m
    where m.user_id = claim.anon_user and not exists (
      select 1 from public.accounts a
      where a.personal_workspace = m.workspace_id and a.user_id <> uid)
    on conflict (workspace_id, user_id) do nothing;
    update public.workspaces set created_by = uid where created_by = claim.anon_user;
    update public.shares set created_by = uid where created_by = claim.anon_user;
    update public.share_invites set created_by = uid where created_by = claim.anon_user;
  else
    anon_ws := null;
  end if;
  delete from public.workspace_members where user_id = claim.anon_user;
  delete from public.pairing_codes where created_by = claim.anon_user;

  if anon_ws is null then
    outcome := jsonb_build_object(
      'result', case when personal is null then 'none' else 'joined' end,
      'workspace', personal);
  elsif personal is null then
    update public.accounts set personal_workspace = anon_ws where user_id = uid;
    outcome := jsonb_build_object('result', 'moved', 'workspace', anon_ws);
  elsif personal = anon_ws then
    outcome := jsonb_build_object('result', 'joined', 'workspace', personal);
  else
    outcome := jsonb_build_object('result', 'combine', 'workspace', personal, 'retire', anon_ws);
  end if;

  -- Last, once nothing points at it any more. Where the database does not allow it, the
  -- user is left without data for the later cleanup of unused anonymous users.
  begin
    delete from auth.users where id = claim.anon_user;
  exception when insufficient_privilege or foreign_key_violation then
    null;
  end;
  return outcome;
end;
$$;

-- After a combine: the old workspace's shares and the shares it was a guest of move to the
-- account's personal workspace, then the old workspace is deleted with its rows. Its media
-- files are removed by the app first (Storage API). Boards keep their ids, so people it
-- was shared with keep the same boards.
create function public.check_retire(p_old uuid, p_new uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.signed_in_account() then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  if p_old is null or p_new is null or p_old = p_new
    or (select personal_workspace from public.accounts where user_id = auth.uid())
      is distinct from p_new
    or coalesce(public.workspace_role(p_new), '') <> 'owner'
    or coalesce(public.workspace_role(p_old), '') <> 'owner'
    or exists (select 1 from public.accounts where personal_workspace = p_old) then
    raise exception 'You cannot combine these libraries' using errcode = '42501';
  end if;
end;
$$;

create function public.retire_workspace(p_old uuid, p_new uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.check_retire(p_old, p_new);
  perform pg_advisory_xact_lock(hashtextextended(p_old::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_new::text, 0));

  -- A folder or board shared from both: its people join the new share.
  insert into public.share_members (share_id, member_workspace, role)
  select n.id, m.member_workspace, m.role
  from public.shares o
  join public.shares n on n.workspace_id = p_new and n.kind = o.kind and n.target_id = o.target_id
  join public.share_members m on m.share_id = o.id
  where o.workspace_id = p_old and m.member_workspace <> p_new
  on conflict (share_id, member_workspace) do update
    set role = case when public.share_members.role = 'edit' or excluded.role = 'edit'
      then 'edit' else 'view' end;
  delete from public.shares o
  where o.workspace_id = p_old and exists (
    select 1 from public.shares n
    where n.workspace_id = p_new and n.kind = o.kind and n.target_id = o.target_id);
  delete from public.share_members m
  using public.shares s
  where m.share_id = s.id and s.workspace_id = p_old and m.member_workspace = p_new;
  update public.shares set workspace_id = p_new where workspace_id = p_old;

  -- Shares the old workspace was a guest of, except the account's own.
  insert into public.share_members (share_id, member_workspace, role, added_at)
  select m.share_id, p_new, m.role, m.added_at
  from public.share_members m join public.shares s on s.id = m.share_id
  where m.member_workspace = p_old and s.workspace_id <> p_new
  on conflict (share_id, member_workspace) do update
    set role = case when public.share_members.role = 'edit' or excluded.role = 'edit'
      then 'edit' else 'view' end;

  -- The board list of shared folders comes from entities, so folder shares need the
  -- library to be in the new workspace already: the app retires only after its upload.
  delete from public.workspaces where id = p_old;
end;
$$;

-- Workspaces delete_my_cloud_data removes: those the caller owns, except a library that is
-- another account's (an anonymous computer paired to it only leaves it).
create function public.my_deletable_workspaces()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.workspace_id order by m.joined_at), '{}')
  from public.workspace_members m
  where m.user_id = auth.uid() and m.role = 'owner'
    and not exists (
      select 1 from public.accounts a
      where a.personal_workspace = m.workspace_id and a.user_id <> auth.uid())
$$;

-- Right to erasure: the caller's workspaces with everything in them (boards, shares, people
-- they were shared with), devices, and the sign-in itself. The app removes the media files
-- first with the Storage API, because storage files can't be deleted from SQL.
-- Returns { userDeleted }. If the database refuses to delete the sign-in, the data is still
-- gone and the request is recorded for an admin.
create function public.delete_my_cloud_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  delete from public.workspaces where id = any (public.my_deletable_workspaces());
  delete from public.workspace_members where user_id = uid;
  delete from public.devices where user_id = uid;
  delete from public.accounts where user_id = uid;
  delete from public.account_claims where anon_user = uid;
  delete from public.pairing_codes where created_by = uid;
  delete from public.share_invites where created_by = uid;
  begin
    delete from auth.users where id = uid;
  exception when insufficient_privilege or foreign_key_violation then
    insert into public.deletion_requests (user_id) values (uid) on conflict (user_id) do nothing;
    return jsonb_build_object('userDeleted', false);
  end;
  return jsonb_build_object('userDeleted', true);
end;
$$;

-- An account's own library can't be taken from it by another member (a 0.1.28 computer
-- that was paired to it before the account claimed it).
create or replace function public.remove_member(p_workspace uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user <> auth.uid() and coalesce(public.workspace_role(p_workspace), '') <> 'owner' then
    raise exception 'Only an owner can remove devices' using errcode = '42501';
  end if;
  if p_user <> auth.uid() and exists (
    select 1 from public.accounts where user_id = p_user and personal_workspace = p_workspace
  ) then
    raise exception 'This library belongs to an account' using errcode = '42501';
  end if;
  delete from public.workspace_members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

-- push_entities gains p_device (optional, so 0.1.28 apps keep working).
drop function public.push_entities(uuid, jsonb);
create function public.push_entities(p_workspace uuid, p_rows jsonb, p_device uuid default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  top bigint;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'A sync batch holds at most 500 changes' using errcode = '22023';
  end if;
  if coalesce(public.workspace_role(p_workspace), '') not in ('owner', 'admin', 'editor')
    and exists (
      select 1 from jsonb_to_recordset(p_rows) as x (kind text, board_id text, id text)
      where not (
        (x.kind = 'object' and public.board_share_role(p_workspace, coalesce(x.board_id, '')) = 'edit')
        or (x.kind = 'asset' and public.has_edit_share(p_workspace))
      )
    ) then
    raise exception 'You cannot edit this workspace' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text, 0));
  insert into public.entities as e
    (workspace_id, kind, board_id, id, data, deleted, seq, updated_by, updated_device, updated_at)
  select p_workspace, x.kind, coalesce(x.board_id, ''), x.id,
    case when coalesce(x.deleted, false) then null else x.data end,
    coalesce(x.deleted, false), nextval('public.entity_seq'), auth.uid(), p_device, now()
  from jsonb_to_recordset(p_rows) as x (kind text, board_id text, id text, data jsonb, deleted boolean)
  on conflict (workspace_id, kind, board_id, id) do update
    set data = excluded.data,
      deleted = excluded.deleted,
      seq = excluded.seq,
      updated_by = excluded.updated_by,
      updated_device = excluded.updated_device,
      updated_at = excluded.updated_at;
  insert into public.asset_refs (workspace_id, board_id, asset_id)
  select distinct p_workspace, refs.board, refs.asset
  from (
    select case when x.kind = 'board' then x.id else coalesce(x.board_id, '') end as board,
      unnest(
        array[
          x.data ->> 'assetId',
          x.data ->> 'linkIconId',
          x.data ->> 'documentPreviewId',
          x.data ->> 'backgroundAssetId',
          case when x.data ->> 'icon' like 'asset-%' then substr(x.data ->> 'icon', 7) end
        ] || coalesce(
          array(
            select s ->> 'assetId'
            from jsonb_array_elements(
              case when jsonb_typeof(x.data -> 'pdfComposer' -> 'sources') = 'array'
                then x.data -> 'pdfComposer' -> 'sources' else '[]'::jsonb end
            ) as s
          ),
          '{}'
        ) || coalesce(
          array(
            select i ->> 'assetId'
            from jsonb_array_elements(
              case when jsonb_typeof(x.data -> 'album' -> 'images') = 'array'
                then x.data -> 'album' -> 'images' else '[]'::jsonb end
            ) as i
          ),
          '{}'
        )
      ) as asset
    from jsonb_to_recordset(p_rows) as x (kind text, board_id text, id text, data jsonb, deleted boolean)
    where x.kind in ('board', 'object') and not coalesce(x.deleted, false) and x.data is not null
  ) as refs
  where refs.asset ~ '^[a-f0-9]{64}$'
  on conflict do nothing;
  select coalesce(max(seq), 0) into top from public.entities where workspace_id = p_workspace;
  return top;
end;
$$;

-- Owners may remove their workspace's media: deleting cloud data and retiring a workspace
-- go through the Storage API, which checks this.
create policy "Owners remove workspace media" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'assets'
    and coalesce(public.workspace_role(public.asset_workspace(name)), '') = 'owner'
  );

-- Protocol 2: accounts. Apps from before accounts (protocol 1) still work.
create or replace function public.server_info()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schema', 2,
    'minClientSchema', 1,
    'name', name,
    'billing', billing_enabled
  )
  from public.server_settings
  where id
$$;

revoke execute on function public.signed_in_account() from public, anon;
revoke execute on function public.ensure_personal_workspace(text) from public, anon;
revoke execute on function public.my_account() from public, anon;
revoke execute on function public.register_device(uuid, text, text) from public, anon;
revoke execute on function public.revoke_device(uuid) from public, anon;
revoke execute on function public.begin_claim(uuid) from public, anon;
revoke execute on function public.check_retire(uuid, uuid) from public, anon;
revoke execute on function public.finish_claim(text) from public, anon;
revoke execute on function public.retire_workspace(uuid, uuid) from public, anon;
revoke execute on function public.my_deletable_workspaces() from public, anon;
revoke execute on function public.delete_my_cloud_data() from public, anon;
revoke execute on function public.push_entities(uuid, jsonb, uuid) from public, anon;
grant execute on function public.signed_in_account() to authenticated;
grant execute on function public.ensure_personal_workspace(text) to authenticated;
grant execute on function public.my_account() to authenticated;
grant execute on function public.register_device(uuid, text, text) to authenticated;
grant execute on function public.revoke_device(uuid) to authenticated;
grant execute on function public.begin_claim(uuid) to authenticated;
grant execute on function public.check_retire(uuid, uuid) to authenticated;
grant execute on function public.finish_claim(text) to authenticated;
grant execute on function public.retire_workspace(uuid, uuid) to authenticated;
grant execute on function public.my_deletable_workspaces() to authenticated;
grant execute on function public.delete_my_cloud_data() to authenticated;
grant execute on function public.push_entities(uuid, jsonb, uuid) to authenticated;
