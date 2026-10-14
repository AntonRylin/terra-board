-- Sharing folders and boards with other people.
-- A person is a personal workspace; the devices that are members of it act for
-- that person. A share grants another person's workspace view or edit access to
-- one folder (and every board currently in it) or one board of the owner.

alter table public.workspaces
  add column display_name text check (char_length(display_name) <= 60);

create function public.my_workspaces()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select workspace_id from public.workspace_members where user_id = auth.uid()
$$;

create table public.shares (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('folder', 'board')),
  target_id text not null check (char_length(target_id) between 1 and 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, target_id)
);

create table public.share_members (
  share_id uuid not null references public.shares (id) on delete cascade,
  member_workspace uuid not null references public.workspaces (id) on delete cascade,
  role text not null check (role in ('view', 'edit')),
  added_at timestamptz not null default now(),
  primary key (share_id, member_workspace)
);
create index share_members_member on public.share_members (member_workspace);

create table public.share_invites (
  code text primary key,
  share_id uuid not null references public.shares (id) on delete cascade,
  role text not null check (role in ('view', 'edit')),
  created_by uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Which boards use which media, so shared boards can show their images.
create table public.asset_refs (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  board_id text not null,
  asset_id text not null,
  primary key (workspace_id, board_id, asset_id)
);
create index asset_refs_asset on public.asset_refs (workspace_id, asset_id);

alter table public.shares enable row level security;
alter table public.share_members enable row level security;
alter table public.share_invites enable row level security;
alter table public.asset_refs enable row level security;

-- The caller's strongest right on a board of another workspace, through shares.
create function public.board_share_role(p_workspace uuid, p_board text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when bool_or(m.role = 'edit') then 'edit' when count(*) > 0 then 'view' end
  from public.shares s
  join public.share_members m on m.share_id = s.id
  where s.workspace_id = p_workspace
    and m.member_workspace in (select public.my_workspaces())
    and (
      (s.kind = 'board' and s.target_id = p_board)
      or (s.kind = 'folder' and s.target_id = (
        select e.data ->> 'folderId' from public.entities e
        where e.workspace_id = p_workspace and e.kind = 'board' and e.board_id = '' and e.id = p_board
          and not e.deleted))
    )
$$;

create function public.has_edit_share(p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.shares s
    join public.share_members m on m.share_id = s.id
    where s.workspace_id = p_workspace and m.role = 'edit'
      and m.member_workspace in (select public.my_workspaces())
  )
$$;

create function public.can_read_entity(p_workspace uuid, p_kind text, p_board text, p_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.workspace_role(p_workspace) is not null
    or (p_kind = 'board' and public.board_share_role(p_workspace, p_id) is not null)
    or (p_kind = 'object' and public.board_share_role(p_workspace, p_board) is not null)
    or (p_kind = 'folder' and exists (
      select 1 from public.shares s
      join public.share_members m on m.share_id = s.id
      where s.workspace_id = p_workspace and s.kind = 'folder' and s.target_id = p_id
        and m.member_workspace in (select public.my_workspaces())))
    or (p_kind = 'asset' and exists (
      select 1 from public.asset_refs r
      where r.workspace_id = p_workspace and r.asset_id = p_id
        and public.board_share_role(p_workspace, r.board_id) is not null))
$$;

drop policy "Members read synced entities" on public.entities;
create policy "Members and share guests read synced entities" on public.entities
  for select to authenticated using (public.can_read_entity(workspace_id, kind, board_id, id));

create policy "People see the people they share with" on public.workspaces
  for select to authenticated using (
    exists (
      select 1 from public.shares s join public.share_members m on m.share_id = s.id
      where (s.workspace_id = workspaces.id and m.member_workspace in (select public.my_workspaces()))
        or (m.member_workspace = workspaces.id and s.workspace_id in (select public.my_workspaces()))
    )
  );
create policy "Owners and members read shares" on public.shares
  for select to authenticated using (
    workspace_id in (select public.my_workspaces())
    or exists (
      select 1 from public.share_members m
      where m.share_id = shares.id and m.member_workspace in (select public.my_workspaces())
    )
  );
create policy "Owners and members read share members" on public.share_members
  for select to authenticated using (
    member_workspace in (select public.my_workspaces())
    or exists (
      select 1 from public.shares s
      where s.id = share_members.share_id and s.workspace_id in (select public.my_workspaces())
    )
  );

-- Writes: workspace editors write anything; share guests with edit rights may
-- change objects on boards shared with them and add media those objects use.
create or replace function public.push_entities(p_workspace uuid, p_rows jsonb)
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
    (workspace_id, kind, board_id, id, data, deleted, seq, updated_by, updated_at)
  select p_workspace, x.kind, coalesce(x.board_id, ''), x.id,
    case when coalesce(x.deleted, false) then null else x.data end,
    coalesce(x.deleted, false), nextval('public.entity_seq'), auth.uid(), now()
  from jsonb_to_recordset(p_rows) as x (kind text, board_id text, id text, data jsonb, deleted boolean)
  on conflict (workspace_id, kind, board_id, id) do update
    set data = excluded.data,
      deleted = excluded.deleted,
      seq = excluded.seq,
      updated_by = excluded.updated_by,
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

create function public.set_display_name(p_workspace uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.workspace_role(p_workspace) is null then
    raise exception 'Not your workspace' using errcode = '42501';
  end if;
  update public.workspaces set display_name = left(nullif(btrim(p_name), ''), 60)
  where id = p_workspace;
end;
$$;

create function public.create_share(p_workspace uuid, p_kind text, p_target text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  share uuid;
begin
  if coalesce(public.workspace_role(p_workspace), '') not in ('owner', 'admin') then
    raise exception 'Only the owner can share this' using errcode = '42501';
  end if;
  insert into public.shares (workspace_id, kind, target_id, created_by)
  values (p_workspace, p_kind, p_target, auth.uid())
  on conflict (workspace_id, kind, target_id) do update set kind = excluded.kind
  returning id into share;
  return share;
end;
$$;

create function public.share_owner_check(p_share uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ws uuid;
begin
  select workspace_id into ws from public.shares where id = p_share;
  if ws is null or coalesce(public.workspace_role(ws), '') not in ('owner', 'admin') then
    raise exception 'Only the owner can manage this share' using errcode = '42501';
  end if;
  return ws;
end;
$$;

create function public.delete_share(p_share uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.share_owner_check(p_share);
  delete from public.shares where id = p_share;
end;
$$;

create function public.create_share_invite(p_share uuid, p_role text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_code text := 'S' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 9));
begin
  perform public.share_owner_check(p_share);
  if p_role not in ('view', 'edit') then
    raise exception 'Choose view or edit' using errcode = '22023';
  end if;
  delete from public.share_invites where expires_at < now() - interval '1 day';
  insert into public.share_invites (code, share_id, role, created_by, expires_at)
  values (new_code, p_share, p_role, auth.uid(), now() + interval '7 days');
  return new_code;
end;
$$;

create function public.redeem_share_invite(p_code text, p_workspace uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite public.share_invites;
  found public.shares;
begin
  if public.workspace_role(p_workspace) is null then
    raise exception 'Turn on sync first' using errcode = '42501';
  end if;
  select * into invite from public.share_invites
  where code = upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'))
    and used_at is null and expires_at > now()
  for update;
  if not found then
    raise exception 'This code is wrong or has expired' using errcode = '22023';
  end if;
  select * into found from public.shares where id = invite.share_id;
  if found.workspace_id = p_workspace then
    raise exception 'This is your own share' using errcode = '22023';
  end if;
  insert into public.share_members (share_id, member_workspace, role)
  values (invite.share_id, p_workspace, invite.role)
  on conflict (share_id, member_workspace) do update set role = excluded.role;
  update public.share_invites set used_at = now() where code = invite.code;
  return jsonb_build_object('share', found.id, 'kind', found.kind, 'role', invite.role);
end;
$$;

create function public.share_people(p_share uuid)
returns table (workspace_id uuid, name text, role text, added_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.share_owner_check(p_share);
  return query
    select m.member_workspace, coalesce(w.display_name, 'Someone'), m.role, m.added_at
    from public.share_members m join public.workspaces w on w.id = m.member_workspace
    where m.share_id = p_share
    order by m.added_at;
end;
$$;

create function public.set_share_role(p_share uuid, p_member uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.share_owner_check(p_share);
  if p_role not in ('view', 'edit') then
    raise exception 'Choose view or edit' using errcode = '22023';
  end if;
  update public.share_members set role = p_role
  where share_id = p_share and member_workspace = p_member;
end;
$$;

create function public.remove_share_member(p_share uuid, p_member uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Members may leave on their own; owners may remove anyone.
  if not (p_member in (select public.my_workspaces())) then
    perform public.share_owner_check(p_share);
  end if;
  delete from public.share_members where share_id = p_share and member_workspace = p_member;
end;
$$;

-- Everything the caller's workspace shares, with how many people have access.
create function public.my_shares(p_workspace uuid)
returns table (share_id uuid, kind text, target_id text, people int)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.workspace_role(p_workspace) is null then
    raise exception 'Not your workspace' using errcode = '42501';
  end if;
  return query
    select s.id, s.kind, s.target_id,
      (select count(*)::int from public.share_members m where m.share_id = s.id)
    from public.shares s where s.workspace_id = p_workspace
    order by s.created_at;
end;
$$;

-- Everything shared with the caller, and which boards that currently covers.
create function public.shared_with_me()
returns table (
  share_id uuid,
  workspace_id uuid,
  owner_name text,
  kind text,
  target_id text,
  role text,
  boards text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.workspace_id, coalesce(w.display_name, 'Someone'), s.kind, s.target_id, m.role,
    case when s.kind = 'board' then array[s.target_id]
      else coalesce(array(
        select e.id from public.entities e
        where e.workspace_id = s.workspace_id and e.kind = 'board' and e.board_id = ''
          and not e.deleted and e.data ->> 'folderId' = s.target_id
      ), '{}')
    end
  from public.shares s
  join public.share_members m on m.share_id = s.id
  join public.workspaces w on w.id = s.workspace_id
  where m.member_workspace in (select public.my_workspaces())
$$;

revoke execute on function public.my_workspaces() from public, anon;
revoke execute on function public.board_share_role(uuid, text) from public, anon;
revoke execute on function public.has_edit_share(uuid) from public, anon;
revoke execute on function public.can_read_entity(uuid, text, text, text) from public, anon;
revoke execute on function public.set_display_name(uuid, text) from public, anon;
revoke execute on function public.create_share(uuid, text, text) from public, anon;
revoke execute on function public.share_owner_check(uuid) from public, anon;
revoke execute on function public.delete_share(uuid) from public, anon;
revoke execute on function public.create_share_invite(uuid, text) from public, anon;
revoke execute on function public.redeem_share_invite(text, uuid) from public, anon;
revoke execute on function public.share_people(uuid) from public, anon;
revoke execute on function public.set_share_role(uuid, uuid, text) from public, anon;
revoke execute on function public.remove_share_member(uuid, uuid) from public, anon;
revoke execute on function public.my_shares(uuid) from public, anon;
revoke execute on function public.shared_with_me() from public, anon;
grant execute on function public.my_workspaces() to authenticated;
grant execute on function public.board_share_role(uuid, text) to authenticated;
grant execute on function public.has_edit_share(uuid) to authenticated;
grant execute on function public.can_read_entity(uuid, text, text, text) to authenticated;
grant execute on function public.set_display_name(uuid, text) to authenticated;
grant execute on function public.create_share(uuid, text, text) to authenticated;
grant execute on function public.share_owner_check(uuid) to authenticated;
grant execute on function public.delete_share(uuid) to authenticated;
grant execute on function public.create_share_invite(uuid, text) to authenticated;
grant execute on function public.redeem_share_invite(text, uuid) to authenticated;
grant execute on function public.share_people(uuid) to authenticated;
grant execute on function public.set_share_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_share_member(uuid, uuid) to authenticated;
grant execute on function public.my_shares(uuid) to authenticated;
grant execute on function public.shared_with_me() to authenticated;

-- Media on shared boards is readable by the people they are shared with, and
-- guests with edit rights may add media to the owner's workspace.
drop policy "Members read workspace media" on storage.objects;
drop policy "Editors upload workspace media" on storage.objects;
create policy "Members and share guests read media" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'assets'
    and public.can_read_entity(public.asset_workspace(name), 'asset', '', split_part(name, '/', 2))
  );
create policy "Editors and editing guests upload media" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'assets'
    and (
      coalesce(public.workspace_role(public.asset_workspace(name)), '') in ('owner', 'admin', 'editor')
      or public.has_edit_share(public.asset_workspace(name))
    )
  );
