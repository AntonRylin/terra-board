-- Settings → Account lists each device with where and when it signed in, so people can spot
-- one they don't recognise and sign it out.
--   ip           the address the server saw on the device's latest start
--   location     "Vienna, Austria", looked up by the device itself (approximate, from its IP)
--   first_seen   when the device was first added (unknown for devices from before this)
--   signed_in_at when its current session began (unknown until it signs in again)
alter table public.devices
  add column ip text check (char_length(ip) <= 64),
  add column location text check (char_length(location) <= 120),
  add column first_seen timestamptz,
  add column signed_in_at timestamptz;
alter table public.devices alter column first_seen set default now();

-- Same as before, plus the address and location. Apps that send only the first three
-- arguments still reach this function (p_location defaults to null).
drop function public.register_device(uuid, text, text);
create function public.register_device(
  p_id uuid,
  p_name text,
  p_version text,
  p_location text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  addr text := left(btrim(split_part(coalesce(
    headers ->> 'cf-connecting-ip',
    headers ->> 'x-real-ip',
    headers ->> 'x-forwarded-for',
    ''), ',', 1)), 64);
  place text := left(nullif(btrim(p_location), ''), 120);
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
  insert into public.devices (user_id, id, name, app_version, session_id, last_seen, revoked_at,
    ip, location, first_seen, signed_in_at)
  values (uid, p_id, coalesce(left(nullif(btrim(p_name), ''), 80), 'Computer'),
    left(p_version, 40), sid, now(), null, nullif(addr, ''), place, now(), now())
  on conflict (user_id, id) do update
    set name = excluded.name,
      app_version = excluded.app_version,
      session_id = excluded.session_id,
      last_seen = excluded.last_seen,
      revoked_at = null,
      ip = coalesce(excluded.ip, devices.ip),
      location = coalesce(excluded.location, devices.location),
      signed_in_at = case
        when devices.session_id is distinct from excluded.session_id
          or devices.revoked_at is not null then now()
        else devices.signed_in_at
      end;
  return jsonb_build_object('revoked', false);
end;
$$;

revoke execute on function public.register_device(uuid, text, text, text) from public, anon;
grant execute on function public.register_device(uuid, text, text, text) to authenticated;
