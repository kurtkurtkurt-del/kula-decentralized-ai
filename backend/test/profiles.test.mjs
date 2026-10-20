/* 04: the card, the settings, the search, leaving. */
import { build, check, mustBeRefused, asUser, asAnon, asService, rpc, one, people, befriend, ADA, BERK, CAN, DILA, finish } from "./lib.mjs";

const db = await build("04_profiles.sql");
await people(db);

console.log("\n— handle and setup —");
{
  await asAnon(db);
  check((await one(db, `select public.handle_status('ada') s`)).s === "taken", "ada is taken");
  check((await one(db, `select public.handle_status('A!') s`)).s === "format", "format is checked");
  check((await one(db, `select public.handle_status('admin') s`)).s === "taken", "reserved names belong to nobody");
  check((await one(db, `select public.handle_status('zeyno') s`)).s === "ok", "zeyno is free");
  await mustBeRefused(db, `select public.profile_setup('zeyno')`, "signed out, no setup");
  await asUser(db, BERK);
  check((await one(db, `select public.handle_status('berk') s`)).s === "yours", "your own handle says yours");
  check((await one(db, `select public.profile_setup('berk', 'Berk', 'nowhere') s`)).s === "nocity", "an unknown city is refused");
  check((await one(db, `select public.profile_setup('berk', 'Berk', 'istanbul', '  night owl ') s`)).s === "ok", "setup with a city and a bio");
  const me = (await rpc(db, "profile_me"))[0];
  check(me.display_name === "Berk" && me.city_slug === "istanbul" && me.bio === "night owl" && me.onboarded === true, "profile_me reads it back");
  check(me.night_from === "23:00" && me.night_to === "07:30" && me.wifi_only === true, "the night window defaults");
}

console.log("\n— settings —");
{
  await asUser(db, BERK);
  await db.exec(`select public.settings_set('{"night_from":"22:30","wifi_only":false,"discoverable":false,"bio":"","locale":"tr"}')`);
  const me = (await rpc(db, "profile_me"))[0];
  check(me.night_from === "22:30" && me.wifi_only === false && me.discoverable === false && me.bio === null && me.locale === "tr", "only the keys sent change");
  await mustBeRefused(db, `select public.settings_set('{"locale":"xx"}')`, "an unknown locale is refused");
  await db.exec(`select public.settings_set('{"discoverable":true}')`);
}

console.log("\n— the card of somebody —");
{
  await befriend(db, ADA, BERK);
  await asUser(db, ADA);
  await db.exec(`select public.seen()`);
  await asUser(db, BERK);
  const c = (await rpc(db, "profile_card", { p_handle: "@ada" }))[0];
  check(c && c.relation === "friend" && c.last_seen_day !== null && c.kept_count === 0, "a friend sees the day and the count");
  await asUser(db, CAN);
  const s = (await rpc(db, "profile_card", { p_handle: "ada" }))[0];
  check(s && s.relation === "none" && s.last_seen_day === null && s.kept_count === null, "a stranger sees neither");
  await asService(db);
  await db.exec(`update public.profile_settings set discoverable = false where user_id = '${ADA}'`);
  await asUser(db, CAN);
  check((await rpc(db, "profile_card", { p_handle: "ada" })).length === 0, "not discoverable: no card for a stranger");
  await asUser(db, BERK);
  check((await rpc(db, "profile_card", { p_handle: "ada" })).length === 1, "…the friend still gets it");
  await asService(db);
  await db.exec(`update public.profile_settings set discoverable = true where user_id = '${ADA}'`);
}

console.log("\n— search and suggestions —");
{
  await asUser(db, CAN);
  check((await rpc(db, "people_search", { p_query: "a" })).length === 0, "one letter finds nothing");
  const r = await rpc(db, "people_search", { p_query: "ad" });
  check(r.length === 1 && r[0].handle === "ada" && r[0].relation === "none", "ad finds ada");
  check((await rpc(db, "people_search", { p_query: "%" })).length === 0, "% is a letter, not a wildcard");
  await befriend(db, CAN, BERK);
  await asUser(db, CAN);
  const sg = await rpc(db, "people_suggested", { p_limit: 5 });
  check(sg.length === 2 && sg[0].handle === "ada" && sg[0].reason === "mutual" && sg[0].mutual === 1, "ada is suggested through berk");
  await asUser(db, ADA);
  await db.exec(`select public.block_user('${CAN}')`);
  await asUser(db, CAN);
  check((await rpc(db, "people_search", { p_query: "ada" })).length === 0, "blocked, ada is not found");
  await asUser(db, ADA);
  await db.exec(`select public.unblock_user('${CAN}')`);
}

console.log("\n— export and delete —");
{
  await asUser(db, BERK);
  const x = (await one(db, `select public.export_me() j`)).j;
  check(x.profile.handle === "berk" && x.friends.length === 2 && x.profile.is_admin === undefined, "the export carries the profile and the friends");
  await db.exec(`select public.delete_account()`);
  await asService(db);
  check((await one(db, `select count(*)::int n from public.profiles where id = '${BERK}'`)).n === 0, "the profile is gone");
  check((await one(db, `select count(*)::int n from public.friendships where '${BERK}' in (requester_id, addressee_id)`)).n === 0, "and the friendships with it");
}

finish();
