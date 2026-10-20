-- afterhours — feedback
-- What sits behind the "give feedback → help us" page. One table, two rules:
-- everyone may write, only the admin may read.
--
-- You can write without signing in, because opening an account just to
-- report something broken is absurd. Whoever writes may then leave a
-- way to reach them; if not, what they wrote is still read, they just get
-- no answer.

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  -- If signed in, who wrote it is filled in automatically; if the account
  -- is deleted the text stays and the name falls away.
  author_id   uuid default auth.uid() references public.profiles on delete set null,
  -- An email or some other way back, left by a signed-out writer. Optional.
  contact     text check (contact is null or length(btrim(contact)) between 3 and 120),
  kind        text not null default 'other'
              check (kind in ('broken', 'idea', 'event', 'other')),
  body        text not null check (length(btrim(body)) between 10 and 2000),
  -- The "this has been dealt with" mark on the admin side.
  handled     boolean not null default false,
  created_at  timestamptz not null default now()
);

drop index if exists public.feedback_yeni_idx;   -- the name from before the code spoke English
create index if not exists feedback_recent_idx on public.feedback (created_at desc);

alter table public.feedback enable row level security;

-- Everyone writes, signed in or not. One condition: not in another name.
drop policy if exists feedback_write on public.feedback;
create policy feedback_write on public.feedback for insert
  with check (author_id is null or author_id = auth.uid());

-- Only the admin reads. Not even the writer can read their own back:
-- this is an inbox, not a conversation.
drop policy if exists feedback_read on public.feedback;
create policy feedback_read on public.feedback for select
  using (public.is_admin());

drop policy if exists feedback_handle on public.feedback;
create policy feedback_handle on public.feedback for update
  using (public.is_admin()) with check (public.is_admin());

-- The list the admin panel reads: the writer resolved, the newest on top.
drop function if exists public.feedback_list(int);
create or replace function public.feedback_list(p_limit int default 100)
returns table (
  id         uuid,
  kind       text,
  body       text,
  author     text,
  contact    text,
  handled    boolean,
  created_at timestamptz
)
language sql
stable
as $$
  select f.id, f.kind, f.body,
         public.author_name(f.author_id, null),
         f.contact, f.handled, f.created_at
  from public.feedback f
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- Writers may fill in exactly what the form asks: the subject, the words
-- and a way back. handled belongs to the admin’s PATCH, created_at to the
-- clock — neither is anyone’s to send. (The old broad grants are taken
-- back first; grants pile up on a database that ran an earlier version.)
revoke insert, update on public.feedback from anon, authenticated;
grant insert (author_id, kind, body, contact) on public.feedback to anon, authenticated;
grant update (handled) on public.feedback to authenticated;
grant select on public.feedback to authenticated;
grant execute on function public.feedback_list(int) to authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('13_feedback.sql', 'dea8158134bc7c0ce4786a39a1f7a9f11a5873d90caae10dc3fa604cd49f7cd2');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('13_feedback.sql');
  end if;
end $$;
