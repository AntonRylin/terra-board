-- The record variable in redeem_share_invite was named `found`, which shadows
-- PL/pgSQL's FOUND flag and broke the "wrong or expired code" check.
create or replace function public.redeem_share_invite(p_code text, p_workspace uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite public.share_invites;
  target_share public.shares;
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
  select * into target_share from public.shares where id = invite.share_id;
  if target_share.workspace_id = p_workspace then
    raise exception 'This is your own share' using errcode = '22023';
  end if;
  insert into public.share_members (share_id, member_workspace, role)
  values (invite.share_id, p_workspace, invite.role)
  on conflict (share_id, member_workspace) do update set role = excluded.role;
  update public.share_invites set used_at = now() where code = invite.code;
  return jsonb_build_object('share', target_share.id, 'kind', target_share.kind, 'role', invite.role);
end;
$$;
