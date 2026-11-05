# history

Where kula decentralized ai came from. The repository is older than kula: its first two
months belong to **afterhours**, a nightlife app, and for a few weeks the root of the tree
was still afterhours' website. This page keeps that story short; the full texts are in git
history, and the commit to look at is **`9d5919f`**, the last one that had everything
(`git show 9d5919f:AFTERHOURS.md`, `git show 9d5919f:index.html`,
`git checkout 9d5919f -- <path>` to bring a file back).

| when | what |
|---|---|
| 28.08.2026 | afterhours starts: the landing page, the website, then the backend |
| 25.09.2026 | the Expo app joins the repository with its own history (65 commits) |
| 20.10.2026 | the fork: "pasaport: copy of afterhours, package renamed"; the same day "poorman's ai", the passport tab and a swipe deck of projects |
| 21.10.2026 | the name **kula decentralized ai**, its own Supabase project, the measurement taken from device-passport, demo builds with an invented world, a computer's passport by Mac script |
| 4.11.2026 | llama.cpp b11157 on the phone, the models tab in the swipe deck's place, kula-node |
| 5.11.2026 | the real night worker, gate v2 (TLS), beyin v0 the auditor, the relay, CI; the afterhours website leaves the root |

## afterhours (28.08 – 20.10.2026)

*"find your night. one card at a time."* afterhours was a nightlife and events app: raves,
club nights, concerts, festivals, meetups, house parties; Munich first, Istanbul next. One
repository held three things sharing one Supabase project:

- **the website** at the root (plain HTML, CSS and JS, no build; published on GitHub Pages
  as `kurtkurtkurt-del.github.io/afterhours`): a landing page, *the wall* of upcoming nights
  as posters, a page per night (a "contact sheet" with the ticket, who is coming, the after
  and *beforehours*, the comments before the night), accounts, settings, legal pages in
  German and English, and pages for what lived only in the app;
- **the app** (`app/`, Expo, Android first as `app.afterhours.android`): *the deck* (no
  search: one card at a time, swipe right to keep a night, left to let it go), a map with
  radar rings, people and groups, *sparks* (small plans a friend starts), direct messages,
  a 48-hour room after check-in, DJs with clips, a record-sleeve profile, an intro film;
- **the backend** (`backend/`): Postgres on Supabase with row-level rules for every promise
  (nobody reads anyone else's swipes), about a hundred numbered SQL files, a daily
  Ticketmaster sync, nightly backups and a health check, all tested on PGlite.

Every night you went to became an *afterhours card*, an SVG drawn from the night's data in a
metal and a motif (`cards.js` on the site, `cardsgen.js` in the app). The web was black on
white with hairlines and no rounded corners; the app was ink on paper with one red. Words
were kept in three languages (en, de, tr) on both sides. All of it was documented in one
long file, `AFTERHOURS.md` (13 sections, 1300 lines), the project's only reference.

## the fork: pasaport, poorman's ai, kula (20–21.10.2026)

On 20.10.2026 afterhours was copied into a new project with its package renamed
(`app.pasaport.android`, scheme `pasaport://`, names that are still in `app.json`). The
idea: a phone lends its idle, charging night to a project by running a small language
model. The nightlife screens were bent to it in a day: *the flow tab* became a swipe deck of
**project cards** (keep / let go / undo, a country picker), a project page took the night
page's ticket shape, *the passport tab* measured the phone (RAM, bandwidth, compute,
thermals, battery) and said which model fits, and the afterhours card turned into the card
a night of work earned. For a day the name was *poorman's ai*.

On 21.10.2026 it became **kula decentralized ai**, with its own palette and logo (a heavy K
with a sage and a gold spark; the prototypes are in [design/](design/)), and:

- **its own live server.** Until then release builds and the website still talked to
  afterhours' Supabase project; `npm run release:check` now refuses that project by id.
- **the measurement from device-passport.** The Kotlin measuring app moved to its own
  repository (`../device-passport`); kula compiles its `passport-core` and holds it to a
  contract (`app/src/passport/contract.ts`). The early copy of `Measure.kt` in kula is gone
  and must not come back (see `CLAUDE.md`).
- **the demo world.** A build with no server swaps the Supabase client for one that answers
  from `src/demo/snapshot.json`: 14 invented people with their phones, friendships, kept
  projects, nights, messages, coops and calls, signed in as *deniz*. It let the app be shown
  without a backend; *enter as demo* on the first screen is its door
  ([SERVERS.md](SERVERS.md)).
- **a computer's passport.** A Mac script (`curl … | bash`) measures a computer natively and
  hands its passport to the phone by a six-letter connect id through the server, or as a
  QR code; the browser page did a rough measurement itself. It lives on as
  [web/](../web/README.md).

## the simulated night (20.10 – 4.11.2026)

The night was the product before there was a model. From 20.10.2026 a `SimulatedWorker`
counted "work" up at the rate the passport estimated, the card showed tokens and kWh, and the
backend recorded check-in, the card and credits (`08_contributions.sql`), coops of friends
working one project, and calls that travelled in waves. None of it ran a model. The simulated
worker is still there for Expo Go, iOS, the web and phones without a model
([NIGHT.md](NIGHT.md)).

## real models (4–5.11.2026)

On 4.11.2026 the swipe deck, `ProjectDeck`, the flow tab and its pickers were removed and
the **models tab** took their place; llama.cpp b11157 came in as a native module, ported
from PrivateLM / llama_flutter_android, with the three modes (alone, apart, split) and the
gate; kula-node let a computer join. The night became real: a `LlamaWorker` hands bundled
jobs to the devices in apart mode, a scheduler follows the charger, Wi-Fi and the battery,
and a morning report counts units, tokens and watt-hours. On 5.11.2026 a dozen parallel
branches added gate v2 (TLS), beyin v0 (the auditor and its signed ledger), the audit page,
the relay, the planner simulator, the backend's night reports, CI and these documents; they
were merged into `kula-main`. The day by day account is in Turkish in
[ILERLEME.md](ILERLEME.md); where things stand now is in [DURUM.md](DURUM.md).

## what was removed on 5.11.2026

From the root: the afterhours website, 289 files (the pages, `cards.js`, `events-data.js`,
`venues.js`, 143 posters, fonts, three languages in `lang/`, the radio and knob, the site
checks `tools-*.py`, `.well-known/assetlinks.json` for `app.afterhours.android`, `user-site/`,
`admin/`, `native/`, afterhours' prototypes and design briefs). Also `AFTERHOURS.md`, the
afterhours test workflow, `.claude/old/` (afterhours' SQL and tests) and `.claude/prompts/`
(working prompts from before the fork), `backend/model.md` and `backend/promises.md`
(afterhours' data model and its promises), and afterhours' credits for music and photos. What
kula still used moved to [web/](../web/README.md) and [tools/](../tools/); afterhours' legal
pages and the old browser passport page wait in `web/legacy/`.

Names that remain from those days and are not wrong, only old: the Android package and the
URL scheme (`pasaport`), the *pasaport* in the SQL files' header lines, the `deck()` function
in `06_deck.sql`, and the app's links to the legal pages on the `pasaport` repository's
GitHub Pages.
