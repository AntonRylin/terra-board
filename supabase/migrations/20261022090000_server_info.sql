-- Server identity and protocol version.
-- The app calls server_info() before it uses a server, to check the server speaks a protocol it understands.

-- One row of server-wide settings. Clients never read it directly; server_info() exposes the public parts.
create table public.server_settings (
  id boolean primary key default true check (id),
  name text not null default 'Terra Board server',
  billing_enabled boolean not null default false
);

insert into public.server_settings default values;

alter table public.server_settings enable row level security;

-- schema: the protocol version of this server.
-- minClientSchema: the oldest app protocol this server still accepts.
-- The next migration that changes the protocol must bump these two literals.
create function public.server_info()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schema', 1,
    'minClientSchema', 1,
    'name', name,
    'billing', billing_enabled
  )
  from public.server_settings
  where id
$$;

revoke execute on function public.server_info() from public;
grant execute on function public.server_info() to anon, authenticated;
