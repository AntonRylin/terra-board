-- Terra Board cloud sync: workspaces, membership, synced library entities and device pairing.
-- Clients read through RLS and write only through the security definer functions below.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My boards' check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'commenter', 'viewer')),
  device_name text check (char_length(device_name) <= 80),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user on public.workspace_members (user_id);

create sequence public.entity_seq;

create table public.entities (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('board', 'folder', 'object', 'asset')),
  board_id text not null default '' check (char_length(board_id) <= 200),
  id text not null check (char_length(id) between 1 and 200),
  data jsonb check (data is null or octet_length(data::text) <= 4000000),
  deleted boolean not null default false,
  seq bigint not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, kind, board_id, id)
);
create index entities_feed on public.entities (workspace_id, seq);

create table public.pairing_codes (
  code text primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'commenter', 'viewer')),
  created_by uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.entities enable row level security;
alter table public.pairing_codes enable row level security;

create function public.workspace_role(p_workspace uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.workspace_members
  where workspace_id = p_workspace and user_id = auth.uid()
$$;

create policy "Members read their workspace" on public.workspaces
  for select to authenticated using (public.workspace_role(id) is not null);
create policy "Members read the member list" on public.workspace_members
  for select to authenticated using (public.workspace_role(workspace_id) is not null);
create policy "Members read synced entities" on public.entities
  for select to authenticated using (public.workspace_role(workspace_id) is not null);
-- pairing_codes has no policies: only the functions below can use it.

create function public.create_workspace(p_name text, p_device text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  insert into public.workspaces (name, created_by)
  values (coalesce(nullif(btrim(p_name), ''), 'My boards'), auth.uid())
  returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role, device_name)
  values (ws, auth.uid(), 'owner', left(p_device, 80));
  return ws;
end;
$$;

create function public.push_entities(p_workspace uuid, p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  top bigint;
begin
  if coalesce(public.workspace_role(p_workspace), '') not in ('owner', 'admin', 'editor') then
    raise exception 'You cannot edit this workspace' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'A sync batch holds at most 500 changes' using errcode = '22023';
  end if;
  -- Serialize writers per workspace so seq values become visible in order and
  -- readers following a cursor never skip a row committed late.
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
  select coalesce(max(seq), 0) into top from public.entities where workspace_id = p_workspace;
  return top;
end;
$$;

create function public.create_pairing_code(p_workspace uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_code text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
begin
  if coalesce(public.workspace_role(p_workspace), '') <> 'owner' then
    raise exception 'Only an owner can add devices' using errcode = '42501';
  end if;
  delete from public.pairing_codes where expires_at < now() - interval '1 day';
  insert into public.pairing_codes (code, workspace_id, role, created_by, expires_at)
  values (new_code, p_workspace, 'owner', auth.uid(), now() + interval '15 minutes');
  return new_code;
end;
$$;

create function public.redeem_pairing_code(p_code text, p_device text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  found_code public.pairing_codes;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  select * into found_code from public.pairing_codes
  where code = upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'))
    and used_at is null and expires_at > now()
  for update;
  if not found then
    raise exception 'This code is wrong or has expired' using errcode = '22023';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role, device_name)
  values (found_code.workspace_id, auth.uid(), found_code.role, left(p_device, 80))
  on conflict (workspace_id, user_id) do nothing;
  update public.pairing_codes set used_at = now() where code = found_code.code;
  return found_code.workspace_id;
end;
$$;

create function public.remove_member(p_workspace uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Anyone may leave; only owners remove someone else.
  if p_user <> auth.uid() and coalesce(public.workspace_role(p_workspace), '') <> 'owner' then
    raise exception 'Only an owner can remove devices' using errcode = '42501';
  end if;
  delete from public.workspace_members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

revoke execute on function public.workspace_role(uuid) from public, anon;
revoke execute on function public.create_workspace(text, text) from public, anon;
revoke execute on function public.push_entities(uuid, jsonb) from public, anon;
revoke execute on function public.create_pairing_code(uuid) from public, anon;
revoke execute on function public.redeem_pairing_code(text, text) from public, anon;
revoke execute on function public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.workspace_role(uuid) to authenticated;
grant execute on function public.create_workspace(text, text) to authenticated;
grant execute on function public.push_entities(uuid, jsonb) to authenticated;
grant execute on function public.create_pairing_code(uuid) to authenticated;
grant execute on function public.redeem_pairing_code(text, text) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

-- Media files: private, content-addressed by SHA-256 under the workspace id.
insert into storage.buckets (id, name, public, file_size_limit)
values ('assets', 'assets', false, 268435456)
on conflict (id) do nothing;

create function public.asset_workspace(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f-]{36}$' then split_part(p_name, '/', 1)::uuid
  end
$$;

create policy "Members read workspace media" on storage.objects
  for select to authenticated
  using (bucket_id = 'assets' and public.workspace_role(public.asset_workspace(name)) is not null);
create policy "Editors upload workspace media" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'assets'
    and coalesce(public.workspace_role(public.asset_workspace(name)), '') in ('owner', 'admin', 'editor')
  );
