-- afterhours — likes and comments on posts (55, after 45, 48, 51 to 53)
--
--   post_likes            one per person and post
--   post_comments         up to 300 characters; hidden by the staff, deleted by their
--                         author or the author of the post
--   post_like(id, on)     a double tap or the heart; anyone who can see the post
--   post_likers(id)       who liked it, newest first (blocked people left out)
--   post_comment_add(id, body) / post_comment_delete(id) / post_comments_of(id)
--   posts_feed(…)         as in 45, plus likes, liked (by you), comments and the
--                         first two comments, so the card needs one read
--
-- Whoever sees the post (its author and their confirmed friends) may like and
-- comment. The author is told by push (post_like, post_comment in 48). Reports
-- (51), bans (52), notices and limits (53) cover comments too.

create table if not exists public.post_likes (
  post_id     uuid not null references public.posts on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists post_likes_user on public.post_likes (user_id);

create table if not exists public.post_comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts on delete cascade,
  author_id   uuid not null references public.profiles on delete cascade,
  body        text not null check (length(btrim(body)) between 1 and 300),
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists post_comments_post on public.post_comments (post_id, created_at);

alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;
revoke all on public.post_likes, public.post_comments from public, anon, authenticated;

-- Reports may name a comment on a post (the table in 51 predates it).
alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports add constraint reports_kind_check
  check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark', 'post_comment'));

create or replace function public.need_post(p_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select author_id into a from public.posts where id = p_id and not is_hidden;
  if a is null or not public.can_see_post(a) then raise exception 'no such post'; end if;
  return a;
end;
$$;
revoke all on function public.need_post(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ likes

create or replace function public.post_like(p_id uuid, p_on boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_post(p_id);
  if coalesce(p_on, true) then
    insert into public.post_likes (post_id, user_id) values (p_id, auth.uid()) on conflict do nothing;
  else
    delete from public.post_likes where post_id = p_id and user_id = auth.uid();
  end if;
  return (select count(*)::int from public.post_likes where post_id = p_id);
end;
$$;

create or replace function public.post_likers(p_id uuid)
returns table (id uuid, handle text, name text, mine boolean, at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_post(p_id);
  return query
    select p.id, p.handle, p.display_name, p.id = auth.uid(), l.created_at
    from public.post_likes l join public.profiles p on p.id = l.user_id
    where l.post_id = p_id and (p.id = auth.uid() or (not public.is_blocked(p.id) and p.banned_at is null))
    order by l.created_at desc
    limit 200;
end;
$$;

-- ------------------------------------------------------------ comments

create or replace function public.post_comment_add(p_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r uuid;
begin
  perform public.need_account();
  perform public.need_post(p_id);
  if length(btrim(coalesce(p_body, ''))) = 0 then raise exception 'a few words'; end if;
  if length(p_body) > 300 then raise exception 'at most 300 characters'; end if;
  insert into public.post_comments (post_id, author_id, body) values (p_id, auth.uid(), btrim(p_body)) returning id into r;
  return r;
end;
$$;

-- Your own comment, or any comment under your post.
create or replace function public.post_comment_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
begin
  select pc.author_id, p.author_id as owner into c
  from public.post_comments pc join public.posts p on p.id = pc.post_id where pc.id = p_id;
  if c is null then return; end if;
  if auth.uid() is distinct from c.author_id and auth.uid() is distinct from c.owner and not public.is_staff() then
    raise exception 'not yours' using errcode = '42501';
  end if;
  delete from public.post_comments where id = p_id;
end;
$$;

create or replace function public.post_comments_of(p_id uuid)
returns table (id uuid, author_id uuid, handle text, name text, body text, created_at timestamptz, mine boolean, can_delete boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  owner := public.need_post(p_id);
  return query
    select c.id, c.author_id, p.handle, p.display_name, c.body, c.created_at,
           c.author_id = auth.uid(), c.author_id = auth.uid() or owner = auth.uid()
    from public.post_comments c join public.profiles p on p.id = c.author_id
    where c.post_id = p_id and not c.is_hidden
      and (c.author_id = auth.uid() or (not public.is_blocked(c.author_id) and p.banned_at is null))
    order by c.created_at
    limit 300;
end;
$$;

revoke execute on function public.post_like(uuid, boolean)       from public, anon;
revoke execute on function public.post_likers(uuid)              from public, anon;
revoke execute on function public.post_comment_add(uuid, text)   from public, anon;
revoke execute on function public.post_comment_delete(uuid)      from public, anon;
revoke execute on function public.post_comments_of(uuid)         from public, anon;
grant execute on function public.post_like(uuid, boolean)        to authenticated;
grant execute on function public.post_likers(uuid)               to authenticated;
grant execute on function public.post_comment_add(uuid, text)    to authenticated;
grant execute on function public.post_comment_delete(uuid)       to authenticated;
grant execute on function public.post_comments_of(uuid)          to authenticated;

-- ------------------------------------------------------------ the feed

drop function if exists public.posts_feed(timestamptz, int);
create or replace function public.posts_feed(p_before timestamptz default null, p_limit int default 20)
returns table (id uuid, author_id uuid, handle text, name text, body text, photo_path text,
               event_slug text, event_title text, created_at timestamptz, mine boolean,
               likes int, liked boolean, comments int, first_comments jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.author_id, pr.handle, pr.display_name, p.body, p.photo_path, e.slug, e.title, p.created_at,
         p.author_id = auth.uid(),
         (select count(*)::int from public.post_likes l where l.post_id = p.id),
         exists (select 1 from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
         (select count(*)::int from public.post_comments c where c.post_id = p.id and not c.is_hidden),
         coalesce((select jsonb_agg(jsonb_build_object('who', coalesce(x.handle, x.display_name), 'text', x.body) order by x.created_at)
                   from (select c.body, c.created_at, q.handle, q.display_name
                         from public.post_comments c join public.profiles q on q.id = c.author_id
                         where c.post_id = p.id and not c.is_hidden
                           and (c.author_id = auth.uid() or (not public.is_blocked(c.author_id) and q.banned_at is null))
                         order by c.created_at limit 2) x), '[]'::jsonb)
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  left join public.events e on e.id = p.event_id
  where auth.uid() is not null
    and not p.is_hidden
    and public.can_see_post(p.author_id)
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;
revoke execute on function public.posts_feed(timestamptz, int) from public, anon;
grant execute on function public.posts_feed(timestamptz, int) to authenticated;

-- ------------------------------------------------------------ guards, notices, push

do $$
declare t text;
begin
  foreach t in array array['post_likes', 'post_comments'] loop
    if to_regprocedure('public.guard_banned()') is not null then
      execute format('drop trigger if exists guard_banned on public.%I', t);
      execute format('create trigger guard_banned before insert or update on public.%I for each row execute function public.guard_banned()', t);
    end if;
  end loop;
  if to_regprocedure('public.guard_rate()') is not null then
    drop trigger if exists guard_rate on public.post_comments;
    create trigger guard_rate before insert on public.post_comments
      for each row execute function public.guard_rate('author_id', '1 hour', '60');
  end if;
  if to_regprocedure('public.notice_hidden()') is not null then
    drop trigger if exists notice_hidden on public.post_comments;
    create trigger notice_hidden after update of is_hidden on public.post_comments
      for each row execute function public.notice_hidden();
  end if;
end $$;

create or replace function public.push_post_social()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.posts%rowtype;
  -- the two tables name the person differently; read it by name
  who uuid := coalesce(to_jsonb(new) ->> 'user_id', to_jsonb(new) ->> 'author_id')::uuid;
begin
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is null then return null; end if;
  select * into p from public.posts where id = new.post_id;
  if p.author_id is null or p.author_id = who then return null; end if;
  if TG_TABLE_NAME = 'post_likes' then
    perform public.push_enqueue(p.author_id, 'post_like', format('post_like:%s:%s', p.id, who),
      jsonb_build_object('name', public.push_name(who), 'text', left(coalesce(nullif(p.body, ''), '📷'), 80), 'url', '/yours'));
  else
    perform public.push_enqueue(p.author_id, 'post_comment', format('post_comment:%s', to_jsonb(new) ->> 'id'),
      jsonb_build_object('name', public.push_name(who), 'text', left(to_jsonb(new) ->> 'body', 80), 'url', '/yours'));
  end if;
  return null;
end;
$$;
do $$ begin
  if to_regprocedure('public.push_name(uuid)') is not null then
    drop trigger if exists push_post_social on public.post_likes;
    create trigger push_post_social after insert on public.post_likes for each row execute function public.push_post_social();
    drop trigger if exists push_post_social on public.post_comments;
    create trigger push_post_social after insert on public.post_comments for each row execute function public.push_post_social();
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('55_post_social.sql', '56ec67e5452e57f8d7d44f8cc1424a5abf2d7bc1f46590c8de02439415414676');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('55_post_social.sql');
  end if;
end $$;
