-- afterhours — who may read what, and who may write it
-- This file IS the security. Hiding a page is not security; the rule is here.

-- ------------------------------------------------------------- helpers

-- profiles has RLS on it; reading profiles from inside a policy loops for
-- ever. Hence security definer: the function steps around RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.is_friend(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = other)
        or (f.addressee_id = auth.uid() and f.requester_id = other))
  );
$$;

-- Nobody may make themselves an admin.
create or replace function public.guard_is_admin()
returns trigger
language plpgsql
as $$
begin
  -- An empty auth.uid() means the request came from the service role or the
  -- SQL editor; that is where the first admin is appointed. Anonymous never
  -- gets this far, because profiles_update_own already stops it.
  if new.is_admin is distinct from old.is_admin
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'is_admin can only be changed by an admin';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin
  before update on public.profiles
  for each row execute function public.guard_is_admin();

-- ------------------------------------------------------------------ RLS

alter table public.cities       enable row level security;
alter table public.event_types  enable row level security;
alter table public.venues       enable row level security;
alter table public.events       enable row level security;
alter table public.profiles     enable row level security;
alter table public.swipes       enable row level security;
alter table public.comments     enable row level security;
alter table public.friendships  enable row level security;

-- ------------------------------- the catalogue: everyone reads, the admin writes

drop policy if exists cities_read on public.cities;
create policy cities_read on public.cities for select using (true);
drop policy if exists cities_write on public.cities;
create policy cities_write on public.cities for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists types_read on public.event_types;
create policy types_read on public.event_types for select using (true);
drop policy if exists types_write on public.event_types;
create policy types_write on public.event_types for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists venues_read on public.venues;
create policy venues_read on public.venues for select using (true);
drop policy if exists venues_write on public.venues;
create policy venues_write on public.venues for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- event

-- You can look around without signing in: published events are public.
drop policy if exists events_read on public.events;
create policy events_read on public.events for select
  using (is_published or public.is_admin());

drop policy if exists events_write on public.events;
create policy events_write on public.events for all
  using (public.is_admin()) with check (public.is_admin());

-- --------------------------------------------------------------- profile

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------- swipe

-- Your own swipes + what your confirmed friends swiped RIGHT.
-- What a friend swiped left concerns nobody but them.
drop policy if exists swipes_read on public.swipes;
create policy swipes_read on public.swipes for select
  using (
    user_id = auth.uid()
    or (direction = 'right' and public.is_friend(user_id))
  );

drop policy if exists swipes_insert_own on public.swipes;
create policy swipes_insert_own on public.swipes for insert
  with check (user_id = auth.uid());

drop policy if exists swipes_update_own on public.swipes;
create policy swipes_update_own on public.swipes for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists swipes_delete_own on public.swipes;
create policy swipes_delete_own on public.swipes for delete
  using (user_id = auth.uid());

-- ------------------------------------------------------------ beforehours

drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select
  using (not is_hidden or public.is_admin());

-- Writing needs an account, and nobody can write as somebody else.
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert
  with check (author_id = auth.uid());

drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());

drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete
  using (author_id = auth.uid() or public.is_admin());

-- Hiding a comment is moderation, and moderation has to stick: the
-- update rule above lets an author edit their own row, and without this
-- guard that included quietly writing is_hidden back to false.
create or replace function public.guard_comment_hidden()
returns trigger
language plpgsql
as $$
begin
  -- An empty auth.uid() is the service role or the SQL editor, same as
  -- in guard_is_admin above.
  if new.is_hidden is distinct from old.is_hidden
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'is_hidden can only be changed by an admin';
  end if;
  return new;
end;
$$;

drop trigger if exists comments_guard_hidden on public.comments;
create trigger comments_guard_hidden
  before update on public.comments
  for each row execute function public.guard_comment_hidden();

-- ------------------------------------------------------------ friendship

drop policy if exists friendships_read on public.friendships;
create policy friendships_read on public.friendships for select
  using (requester_id = auth.uid() or addressee_id = auth.uid());

-- A request is born pending. Without the status check here, a row could
-- be INSERTED as ’accepted’ and skip the other side’s consent entirely.
drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships for insert
  with check (requester_id = auth.uid() and status = 'pending');

-- Only the side that RECEIVED the request may change it: that is what
-- accepting is. The requester’s tools are insert and delete — with
-- update too, a requester could flip their own request to ’accepted’
-- and walk into everything a friend may see.
drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships for update
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid());

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships for delete
  using (requester_id = auth.uid() or addressee_id = auth.uid());

-- ------------------------------------------------------- the migration log

-- Only the admin reads the table itself. The public list goes through
-- migrations_applied(), which is security definer and returns nothing but
-- filenames and dates (00_migrations.sql).
-- Guarded the same way as the stamps: 02 has to run on its own too (the
-- test suites load it without 00).
do $$ begin
  if to_regclass('public.migrations') is not null then
    execute 'drop policy if exists migrations_read_admin on public.migrations';
    execute 'create policy migrations_read_admin on public.migrations
               for select using (public.is_admin())';
  end if;
end $$;


-- ------------------------------------------------------------ privileges

grant usage on schema public to anon, authenticated;

grant select on public.cities, public.event_types, public.venues,
                public.events, public.profiles, public.comments to anon, authenticated;

grant insert, update, delete on public.swipes to authenticated;
grant select on public.swipes, public.friendships to authenticated;

-- Comments and friendships accept writes only on the columns the site
-- actually sends. The others either default (author_id, created_at,
-- status) or belong to the seed and the tools, which run as the table
-- owner and are not bound by these grants. Grants pile up, so the old
-- broad ones are taken back first — a database that ran the previous
-- version of this file keeps them otherwise.
revoke insert, update on public.comments from authenticated;
grant delete                                  on public.comments to authenticated;
grant insert (event_id, parent_id, author_id, body) on public.comments to authenticated;
grant update (body, is_hidden)                on public.comments to authenticated;

revoke insert, update on public.friendships from authenticated;
grant delete                                  on public.friendships to authenticated;
grant insert (requester_id, addressee_id)     on public.friendships to authenticated;
grant update (status)                         on public.friendships to authenticated;
grant update on public.profiles to authenticated;
grant insert, update, delete on public.cities, public.event_types,
                                 public.venues, public.events to authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('02_rls.sql', '7a25fb9614f16ecda40d256ac2e47118f2eb534d11d689bcf286d1d32325c0ee');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('02_rls.sql');
  end if;
end $$;
