-- afterhours - ONE-SHOT: repair text that was broken on its way through the clipboard
--
-- pbcopy without a UTF-8 locale read the files as Mac Roman, so every non-ASCII
-- letter that reached the SQL editor arrived as two or three wrong ones
-- (one Turkish letter became two odd ones, an emoji four). Where text came in that way (the test
-- groups, their chat, the fake people), this turns it back: each character is
-- read as the Mac Roman byte it stood for, and the bytes as UTF-8. Text that does
-- not decode that way (real German or Turkish words) is left exactly as it is.
--
-- This file is plain ASCII on purpose, so the clipboard cannot break it too.
-- Safe to run twice: repaired text no longer decodes and stays as it is.

create or replace function pg_temp.unmangle(t text)
returns text
language plpgsql
immutable
as $$
declare
  mac int[] := array[196,197,199,201,209,214,220,225,224,226,228,227,229,231,233,232,234,235,237,236,238,239,241,243,242,244,246,245,250,249,251,252,8224,176,162,163,167,8226,182,223,174,169,8482,180,168,8800,198,216,8734,177,8804,8805,165,181,8706,8721,8719,960,8747,170,186,937,230,248,191,161,172,8730,402,8776,8710,171,187,8230,160,192,195,213,338,339,8211,8212,8220,8221,8216,8217,247,9674,255,376,8260,8364,8249,8250,64257,64258,8225,183,8218,8222,8240,194,202,193,203,200,205,206,207,204,211,212,63743,210,218,219,217,305,710,732,175,728,729,730,184,733,731,711];
  b bytea := ''::bytea;
  c int;
  i int;
  k int;
begin
  if t is null or t ~ '^[[:ascii:]]*$' then return t; end if;
  for i in 1 .. length(t) loop
    c := ascii(substr(t, i, 1));
    if c < 128 then
      b := b || set_byte('\x00'::bytea, 0, c);
    else
      k := array_position(mac, c);
      if k is null then return t; end if;
      b := b || set_byte('\x00'::bytea, 0, 127 + k);
    end if;
  end loop;
  return convert_from(b, 'UTF8');
exception when others then
  return t;
end;
$$;

do $$
declare
  r record;
  n int;
  total int := 0;
begin
  for r in select * from (values
    ('group_messages', 'body'), ('groups', 'name'), ('groups', 'emoji'),
    ('profiles', 'display_name'), ('profiles', 'bio'), ('profiles', 'about'),
    ('posts', 'body'), ('sparks', 'title'), ('sparks', 'place'),
    ('room_posts', 'body'), ('comments', 'body'), ('comments', 'author_name')
  ) v(tbl, col)
  loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    execute format('update public.%I set %I = pg_temp.unmangle(%I) where %I is distinct from pg_temp.unmangle(%I)',
                   r.tbl, r.col, r.col, r.col, r.col);
    get diagnostics n = row_count;
    if n > 0 then raise notice '%.%: % repaired', r.tbl, r.col, n; end if;
    total := total + n;
  end loop;
  raise notice 'repaired % values in all', total;
end $$;
