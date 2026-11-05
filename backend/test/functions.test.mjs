/* The edge functions' shared check (functions/_shared/night.ts), run on node: only numbers
   and names pass, the bounds match 18_night.sql, and a prompt in the body never survives. */
import { check, finish } from "./lib.mjs";
import { checkReport, checkUnits, daysBetween, LIMITS } from "../functions/_shared/night.ts";

const TODAY = "2026-11-05";
const good = (p = {}) => ({ id: "2026-11-05", slug: "koy-okulu-ogretmen", device_id: "9a2b3c4d-0000-4000-8000-00000000000b", units: 300, checked: 40, wrong: 4, tokens: 36000, seconds: 3600, segments: 2, tps: 10, wh: 3.2, model: "tiny", real: true, app_version: "1.4.0",
  devices: [{ id: "me", name: "this phone", tokens: 24000, units: 200, tps: 6.7 }, { id: "p1", name: "tablet", tokens: 12000, units: 100, tps: 3.3 }], ...p });
const refused = (p, re, name) => { const r = checkReport(good(p), TODAY); check(!r.ok && re.test(r.error), name + (r.ok ? " (went through)" : ` (${r.error})`)); };

console.log("\n— a good report —");
const ok = checkReport(good(), TODAY);
check(ok.ok, "the phone's report passes");
if (ok.ok) {
  check(ok.report.units === 300 && ok.report.tps === 10 && ok.report.real === true && ok.report.devices.length === 2, "the numbers come through");
  check(!("name" in ok.report.devices[0]), "a device's name does not travel, only its id and numbers");
  const withText = checkReport(good({ prompt: "translate this", answers: ["x"], samples: [{ text: "y" }] }), TODAY);
  check(withText.ok && !("prompt" in withText.report) && !("answers" in withText.report) && !("samples" in withText.report), "a prompt or an answer in the body is dropped, never forwarded");
  check(JSON.stringify(withText.ok && withText.report).indexOf("translate") === -1, "…and nothing of it remains in what is sent on");
}
const noTps = checkReport(good({ tps: undefined }), TODAY);
check(noTps.ok && noTps.report.tps === 10, "no tps: worked out from tokens and seconds");
const sim = checkReport({ id: "2026-11-04", slug: "x", device_id: "9a2b3c4d-0000-4000-8000-00000000000b", units: 10, tokens: 100, seconds: 50, real: false }, TODAY);
check(sim.ok && sim.report.checked === 0 && sim.report.model === null && sim.report.devices.length === 1 && sim.report.segments === 1, "a bare sim report: zeros and one device");

console.log("\n— what is refused —");
refused({ id: "2026-10-20" }, /out of range/, "eight days back or more");
refused({ id: "2026-11-07" }, /out of range/, "two days ahead");
refused({ id: "yesterday" }, /not a date/, "a word for a date");
refused({ slug: "Köy Okulu" }, /slug/, "a slug with spaces and capitals");
refused({ device_id: "phone-1" }, /device id/, "a device id that is not a uuid");
refused({ checked: 400 }, /add up/, "more checked than units");
refused({ wrong: 50 }, /add up/, "more wrong than checked");
refused({ tokens: -5 }, /add up/, "a negative number");
refused({ seconds: 0, tokens: 100 }, /add up/, "tokens in zero seconds");
refused({ tps: 500 }, /add up/, "a tok/s the tokens and seconds do not give");
refused({ devices: [{ id: "a", tokens: 50000, units: 1 }] }, /add up/, "devices that made more tokens than the night");
refused({ seconds: LIMITS.seconds + 1 }, /out of bounds/, "more than a day");
refused({ units: LIMITS.units + 1 }, /out of bounds/, "too many units");
refused({ wh: LIMITS.wh + 1 }, /out of bounds/, "an impossible wh");
refused({ pad: "x".repeat(LIMITS.bytes) }, /too large/, "over 16 kb");
check(!checkReport("hello", TODAY).ok && !checkReport(null, TODAY).ok && !checkReport([1], TODAY).ok, "a string, null or an array is not a report");
check(checkReport(good({ units: "300" }), TODAY).ok === false || checkReport(good({ units: "300" }), TODAY).report?.units === 0, "a number sent as a string counts as nothing, not as a number");

console.log("\n— the unit lines —");
check(checkUnits(undefined).ok && checkUnits(undefined).units.length === 0, "no detail: an empty list");
const u = checkUnits([{ idx: 0, tokens: 120, ms: 900, ok: true, text: "the answer" }, { idx: 1, tokens: 80, ms: 700 }]);
check(u.ok && u.units.length === 2 && !("text" in u.units[0]) && u.units[0].ok === true && !("ok" in u.units[1]), "idx, tokens, ms, ok — and nothing else");
check(!checkUnits("x").ok && !checkUnits([{ idx: -1 }]).ok && !checkUnits(Array(2001).fill({ idx: 1 })).ok, "not a list, a negative idx, more than 2000: refused");

console.log("\n— days —");
check(daysBetween("2026-11-01", "2026-11-05") === 4 && daysBetween("2026-10-31", "2026-11-01") === 1 && daysBetween("2026-11-05", "2026-11-04") === -1, "daysBetween across a month end");

finish();
