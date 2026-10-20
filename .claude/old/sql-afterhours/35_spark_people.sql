-- afterhours — who answered a spark, by name
-- spark_mine (27, 28) counts the answers; the host could not see WHO. Now:
--
--   spark_people(spark)   names and answers (in first), newest answer first
--
-- Read by the host, and by anyone who is in themselves (people going to the
-- same thing may know who else is going). Someone who said out sees nothing;
-- an unanswered invite is not listed. The name is the handle, else the
-- display name, as everywhere.

create or replace function public.spark_people(p_spark uuid)
returns table (name text, answer text, answered_at timestamptz, me boolean)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.handle, p.display_name, 'someone'), i.answer, i.answered_at, i.user_id = auth.uid()
  from public.spark_invites i
  join public.profiles p on p.id = i.user_id
  join public.sparks s on s.id = i.spark_id
  where i.spark_id = p_spark
    and i.answer in ('in', 'out')
    and auth.uid() is not null
    and (
      s.host_id = auth.uid()
      or exists (select 1 from public.spark_invites m
                 where m.spark_id = p_spark and m.user_id = auth.uid() and m.answer = 'in')
    )
    -- someone who is in sees the others who are in, not who said no
    and (s.host_id = auth.uid() or i.answer = 'in')
  order by (i.answer = 'in') desc, i.answered_at desc nulls last;
$$;

revoke execute on function public.spark_people(uuid) from public, anon;
grant execute on function public.spark_people(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('35_spark_people.sql', '796468d9e9f4598be3cb72f4610369a1866c08b105699e1855a4ef9fc8fb37fb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('35_spark_people.sql');
  end if;
end $$;
