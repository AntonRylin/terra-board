-- Board edits travel live to the other people on a board, ahead of sync, on the private
-- Realtime channel 'edits:<board id>' (electron/cloud-sync.cjs sendEdit). Everyone who can
-- see the board may join it and receive; only people who may change the board may send,
-- the same people push_entities accepts board objects from. Realtime checks both when the
-- channel is joined. Cursors and presence stay on 'board:<board id>', open to viewers too.

create or replace function public.can_use_channel(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_topic like 'board:%' or p_topic like 'edits:%' then exists (
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

create function public.can_send_on_channel(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_topic like 'edits:%' then exists (
      select 1 from public.entities e
      where e.kind = 'board' and e.board_id = '' and e.id = substr(p_topic, 7) and not e.deleted
        and (coalesce(public.workspace_role(e.workspace_id), '') in ('owner', 'admin', 'editor')
          or public.board_share_role(e.workspace_id, e.id) = 'edit'))
    else public.can_use_channel(p_topic)
  end
$$;

revoke execute on function public.can_send_on_channel(text) from public, anon;
grant execute on function public.can_send_on_channel(text) to authenticated;

drop policy "Board and workspace people send live messages" on realtime.messages;
create policy "Board and workspace people send live messages" on realtime.messages
  for insert to authenticated with check (
    realtime.messages.extension in ('presence', 'broadcast')
    and public.can_send_on_channel((select realtime.topic()))
  );
