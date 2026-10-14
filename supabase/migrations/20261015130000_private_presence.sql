-- Live presence, cursors and change pings travel on private Realtime channels.
-- 'board:<board id>' is open to members of the workspace that owns the board and
-- to people with a share covering it (the board itself or its folder).
-- 'terra:<workspace id>' is open to members of that workspace and to people with
-- any share from it. Realtime checks this when a channel is joined, so someone
-- removed from a share can no longer join.

create index entities_boards on public.entities (id) where kind = 'board' and board_id = '';

create function public.can_use_channel(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_topic like 'board:%' then exists (
      select 1 from public.entities e
      where e.kind = 'board' and e.board_id = '' and e.id = substr(p_topic, 7) and not e.deleted
        and (public.workspace_role(e.workspace_id) is not null
          or public.board_share_role(e.workspace_id, e.id) is not null))
    when p_topic like 'terra:%' then exists (
      select 1 from public.my_workspaces() as w (id) where w.id::text = substr(p_topic, 7)
    ) or exists (
      select 1 from public.shares s
      join public.share_members m on m.share_id = s.id
      where s.workspace_id::text = substr(p_topic, 7)
        and m.member_workspace in (select public.my_workspaces()))
    else false
  end
$$;

revoke execute on function public.can_use_channel(text) from public, anon;
grant execute on function public.can_use_channel(text) to authenticated;

create policy "Board and workspace people receive live messages" on realtime.messages
  for select to authenticated using (
    realtime.messages.extension in ('presence', 'broadcast')
    and public.can_use_channel((select realtime.topic()))
  );

create policy "Board and workspace people send live messages" on realtime.messages
  for insert to authenticated with check (
    realtime.messages.extension in ('presence', 'broadcast')
    and public.can_use_channel((select realtime.topic()))
  );
