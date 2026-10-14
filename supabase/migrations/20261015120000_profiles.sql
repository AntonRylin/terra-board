-- Profile pictures and entrance songs. Files live in the private `profiles`
-- bucket under the person's workspace id; versions tell other people's apps
-- when to fetch a new copy.

alter table public.workspaces
  add column avatar_version bigint not null default 0,
  add column song_version bigint not null default 0;

create function public.set_profile_media(p_workspace uuid, p_avatar bigint, p_song bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.workspace_role(p_workspace) is null then
    raise exception 'Not your profile' using errcode = '42501';
  end if;
  update public.workspaces
  set avatar_version = coalesce(p_avatar, avatar_version),
    song_version = coalesce(p_song, song_version)
  where id = p_workspace;
end;
$$;

create function public.my_profile(p_workspace uuid)
returns table (display_name text, avatar_version bigint, song_version bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.workspace_role(p_workspace) is null then
    raise exception 'Not your profile' using errcode = '42501';
  end if;
  return query
    select w.display_name, w.avatar_version, w.song_version
    from public.workspaces w where w.id = p_workspace;
end;
$$;

revoke execute on function public.set_profile_media(uuid, bigint, bigint) from public, anon;
revoke execute on function public.my_profile(uuid) from public, anon;
grant execute on function public.set_profile_media(uuid, bigint, bigint) to authenticated;
grant execute on function public.my_profile(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('profiles', 'profiles', false, 10485760)
on conflict (id) do nothing;

-- Anyone signed in may see profile media (paths are unguessable workspace ids);
-- only a person's own computers may change theirs.
create policy "Signed-in people read profiles" on storage.objects
  for select to authenticated using (bucket_id = 'profiles');
create policy "People upload their own profile" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profiles' and public.workspace_role(public.asset_workspace(name)) is not null
  );
create policy "People replace their own profile" on storage.objects
  for update to authenticated
  using (bucket_id = 'profiles' and public.workspace_role(public.asset_workspace(name)) is not null)
  with check (
    bucket_id = 'profiles' and public.workspace_role(public.asset_workspace(name)) is not null
  );
create policy "People remove their own profile" on storage.objects
  for delete to authenticated
  using (bucket_id = 'profiles' and public.workspace_role(public.asset_workspace(name)) is not null);
