-- afterhours — a group cover from the shelf (62)
--
-- A group can wear one of the photos the app ships with as its cover (club, crowd,
-- friends), not only a photo uploaded by a member: the path is then preset/<name>
-- instead of <user>/<file>. The app maps the name to its bundled picture; nothing is
-- uploaded. Asked by owner on 12.10.2026 so a group has a face from the first minute.

create or replace function public.group_set_cover(p_id uuid, p_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  was text;
begin
  perform public.need_member(p_id);
  if p_path is not null and p_path not like auth.uid()::text || '/%' and p_path !~ '^preset/[a-z0-9-]{1,32}$' then
    raise exception 'not your file';
  end if;
  select cover_path into was from public.groups where id = p_id;
  update public.groups set cover_path = p_path where id = p_id;
  return was;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('62_group_covers.sql', 'eb702e11de3ec89a90bfceca923dd764c80e2bb192bca1b827d781936580ec9d');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('62_group_covers.sql');
  end if;
end $$;
