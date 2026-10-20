/* 06: the deck, keep and let go, what friends kept, the project page. */
import { build, check, mustBeRefused, asUser, asAnon, asService, rpc, one, people, befriend, ADA, BERK, CAN, finish } from "./lib.mjs";

const db = await build("06_deck.sql");
await people(db);

console.log("\n— the deck —");
{
  await asAnon(db);
  check((await rpc(db, "deck")).length === 10, "a guest sees all ten");
  check((await rpc(db, "deck", { p_country: "tr" })).length === 6, "six in türkiye");
  await mustBeRefused(db, `select public.join_set('koy-okulu-ogretmen', 'right')`, "a guest cannot keep");
  await mustBeRefused(db, `select * from public.projects_public`, "the view is not an API");
  await asUser(db, ADA);
  await db.exec(`select public.join_set('koy-okulu-ogretmen', 'right')`);
  await db.exec(`select public.join_set('afet-mesaj-siniflandirma', 'left')`);
  await mustBeRefused(db, `select public.join_set('nope', 'right')`, "an unknown slug is refused");
  await mustBeRefused(db, `select public.join_set('koy-okulu-ogretmen', 'up')`, "a direction is left or right");
  check((await rpc(db, "deck")).length === 8, "two swiped, eight left");
  const k = await rpc(db, "kept");
  check(k.length === 1 && k[0].slug === "koy-okulu-ogretmen", "kept lists the one kept");
  await db.exec(`select public.join_set('koy-okulu-ogretmen', 'left')`);
  check((await rpc(db, "kept")).length === 0, "swiping again overwrites");
  await db.exec(`select public.join_unset('koy-okulu-ogretmen')`);
  check((await rpc(db, "deck")).length === 9, "undo brings the card back");
  await db.exec(`select public.join_set('koy-okulu-ogretmen', 'right')`);
  check((await one(db, `select public.joins_reset() n`)).n === 2, "reset removes both");
  check((await rpc(db, "deck")).length === 10, "the deck is full again");
}

console.log("\n— friends and the page —");
{
  await asUser(db, ADA);
  await db.exec(`select public.join_set('koy-okulu-ogretmen', 'right')`);
  await befriend(db, ADA, BERK);
  await asUser(db, BERK);
  const fk = await rpc(db, "friends_kept");
  check(fk.length === 1 && fk[0].friend === "ada" && fk[0].slug === "koy-okulu-ogretmen", "berk sees what ada kept");
  await asUser(db, CAN);
  check((await rpc(db, "friends_kept")).length === 0, "a stranger sees nothing");
  await asService(db);
  await db.exec(`update public.profile_settings set kept_visibility = 'private' where user_id = '${ADA}'`);
  await asUser(db, BERK);
  check((await rpc(db, "friends_kept")).length === 0, "private: the friend sees nothing either");
  await asService(db);
  await db.exec(`update public.profile_settings set kept_visibility = 'friends' where user_id = '${ADA}'`);

  await asAnon(db);
  const pg = (await rpc(db, "project_page", { p_slug: "koy-okulu-ogretmen" }))[0];
  check(pg && pg.phones_in === 1 && pg.nights_done === 0 && pg.kept === false && pg.friends.length === 0, "a guest reads the page and its count");
  await asUser(db, BERK);
  const pb = (await rpc(db, "project_page", { p_slug: "koy-okulu-ogretmen" }))[0];
  check(pb.friends.length === 1 && pb.friends[0] === "ada", "the friend's name is on the page for berk");
  const pc = await rpc(db, "project_counts");
  check(pc.length === 1 && pc[0].n === 1, "project_counts: one keeps it");
}

finish();
