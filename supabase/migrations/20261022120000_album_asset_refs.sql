-- Album images on shared boards. push_entities records which media each board
-- uses, so people a board is shared with may download them; it left out the
-- images inside albums (data.album.images[].assetId), so guests couldn't see them.

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

-- Albums already synced before this fix.
insert into public.asset_refs (workspace_id, board_id, asset_id)
select distinct e.workspace_id, e.board_id, i ->> 'assetId'
from public.entities e
cross join lateral jsonb_array_elements(e.data -> 'album' -> 'images') as i
where e.kind = 'object'
  and not e.deleted
  and jsonb_typeof(e.data -> 'album' -> 'images') = 'array'
  and (i ->> 'assetId') ~ '^[a-f0-9]{64}$'
on conflict do nothing;
