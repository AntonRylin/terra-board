-- Terra Board company edition (ee/): leaving a board or folder that a team gave you.
-- Licensed under ee/LICENSE (Terra Board Enterprise License), not MIT.
-- Runs after all core migrations and after 20261026090000_roles_teams.sql.
--
-- Before this, removing a team-given share_members row (the person leaving, or the owner
-- removing them) only dropped their direct role, and the team gave the access straight back.
-- Now such a removal is remembered in team_optouts: that person no longer gets that share
-- through any team, even when teams change later. A direct invite (a new share_members row
-- made outside the team sync) clears it, so the owner can always let them back in.

create table if not exists public.team_optouts (
  share_id uuid not null references public.shares (id) on delete cascade,
  member_workspace uuid not null references public.workspaces (id) on delete cascade,
  left_at timestamptz not null default now(),
  primary key (share_id, member_workspace)
);
create index if not exists team_optouts_member on public.team_optouts (member_workspace);
alter table public.team_optouts enable row level security;
revoke all on public.team_optouts from anon, authenticated;

-- Same as before, without the people who left this share.
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
    and not exists (
      select 1 from public.team_optouts o
      where o.share_id = p_share and o.member_workspace = a.personal_workspace)
  group by a.personal_workspace, a.user_id
$$;

-- A team-made row removed directly (leaving, or the owner removing the person): remember it,
-- so the team doesn't give the access back. Never fails the delete.
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
        insert into public.team_optouts (share_id, member_workspace)
        values (old.share_id, old.member_workspace)
        on conflict do nothing;
        perform public.team_sync_share(old.share_id);
      end if;
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;

-- A direct invite lets someone back in: their opt-out goes, and their teams count again.
create or replace function public.share_members_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('terra.team_sync', true) is distinct from 'on' then
    begin
      delete from public.team_optouts
      where share_id = new.share_id and member_workspace = new.member_workspace;
      if found then
        perform public.team_sync_share(new.share_id);
      end if;
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;
drop trigger if exists teams_added on public.share_members;
create trigger teams_added after insert on public.share_members
  for each row execute function public.share_members_added();

revoke execute on function public.share_members_added() from public, anon, authenticated;
