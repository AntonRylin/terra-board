-- Sharing needs an account. A computer that syncs without one (anonymous, from 0.1.28) keeps
-- its own boards in the cloud, but can no longer share them, create invite codes or join
-- someone else's share. People it already shared with keep their access.

create or replace function public.create_share(p_workspace uuid, p_kind text, p_target text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  share uuid;
begin
  if not public.signed_in_account() then
    raise exception 'Sign in to share boards' using errcode = '28000';
  end if;
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

create or replace function public.create_share_invite(p_share uuid, p_role text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_code text := 'S' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 9));
begin
  if not public.signed_in_account() then
    raise exception 'Sign in to share boards' using errcode = '28000';
  end if;
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
  if not public.signed_in_account() then
    raise exception 'Sign in to open boards people share with you' using errcode = '28000';
  end if;
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
