# kula decentralized ai

**your phone works a night for a project you chose.**

Forked from afterhours on 20.10.2026; the app lends the phone's idle, charging hours to a social-benefit AI project. The Kotlin measurement app lives in `../device-passport/`; the app carries a copy of its `Measure.kt`/`Passport.kt` in `app/modules/passport-measure/`.

---

_The notes below are the afterhours README the repo was forked from; parts of it no longer apply._

# afterhours

**find your night. one card at a time.**

Three things in one repository, sharing one Supabase project:

| Where | What |
|---|---|
| `/` (this folder) | **The website** — [kurtkurtkurt-del.github.io/afterhours](https://kurtkurtkurt-del.github.io/afterhours/). Plain HTML/CSS/JS, no build. The landing, the wall, the night pages, the account. |
| `app/` | **The app** — Expo / React Native, Android first. The deck, the map, yours, the collection, the djs, check-in and the room. §6 |
| `backend/` | **The database** — the SQL, the tests, the Ticketmaster sync, the backup. §8–§9 |

A night: rave, club night, konzert, festival, meetup, hausparty. Munich
first, Istanbul next, and the cities the sync reaches.

> **This file is the project's only reference** for all three. It is
> updated after every change — a new page, a new screen, a new rule gets
> written down here too. Someone arriving cold (or you in six months)
> should be able to read only this and carry on.

---

## 1. What it is trying to do

The product in three sentences:

1. **There is no search.** Anywhere. A night is not the thing you look for,
   it is the thing that comes to you. In the app the deck hands you one
   card: swipe right and you **keep** it, swipe left and you **let it go**.
   On the web the same nights hang on **the wall**, soonest first.
2. **What matters is not the night but the continuity.** Every night you go
   to turns into an *afterhours card*: the sound of that night, the talk,
   who was there. The collection holds the past; "now and next" lives
   somewhere else.
3. **A page does not sell you a night.** The night page does not say "here
   is what is on tonight", it says "this is how many times it has been
   you". There is a ticket button — one word, `ticket` — but it is not the
   centre of the page.

**Two surfaces, one product.** The app is where the night happens: the
deck, the map, who's coming, check-in, the room, the collection, the djs.
The web is the door and the archive: the landing, the wall, every night's
page with beforehours, the account and its settings — and for what lives
in the app, a page that says so (`friends/`, `maps/`, `djs/`: "only
available in the app."). The words are the same on both sides; the list
is in §6.

### The spirit

- Black and white on the web (`#000` on `#fff`); ink on paper in the app
  (`#0E0D0C` on `#F3F1EC`, one red `#D7261E`). Different on purpose.
  Colour otherwise lives only in the posters and the cards.
- The web: no boxes, no shadows, no rounded corners; the divider is a 1px
  hairline. The app, since 28.09.2026: **rounded everywhere**, from one
  scale in `app/src/theme/tokens.ts` (`radius`: xs 5 small squares and
  initials · sm 9 chips · md 14 buttons, panels, cards · lg 24 sheets,
  the card caption, the deck card, the paper that rides over the account
  poster · pill for small action buttons and switches). Still no shadows.
- One typeface on both: **Inter Tight** (the freely available answer to PP
  Neue Montreal). The small lines are Inter Tight too — 10px, 0.14–0.18em
  tracking, uppercase, 38–50% opacity. JetBrains Mono and Archivo survive
  only inside the drawn posters.
- The interface text is **English and lower case**; the code and this file
  are **English too** (they were Turkish until 30.08.2026 — see §13); the
  legal pages are **German**.
- Everything on the page was made by hand: the posters are hand-written
  SVG, the sound is synthesised. Apart from `foto.jpg`, the synced
  photographs and the app's music excerpts there is no media from outside.
- The site has no dependencies and no build step. No npm, no bundler.
  Whatever the browser understands, that is what is used. (The app is an
  Expo project and has both; see §6.)

---

## 2. Running it

**The site**

```bash
python3 -m http.server 4340
```

Then `http://localhost:4340`. Do not open it with `file://` — the SVG
posters load inside `<object>`, and external CSS and fonts do not arrive
that way. It works in full without a backend: with `config.js` empty the
data is read from `events-data.js` and the site behaves exactly the same.

**The app**

```bash
cd app && npm install && npx expo start
```

Expo Go on the phone reads the QR; `npx expo run:android` builds a
development client (the map needs one). `npx tsc --noEmit`,
`npx expo lint` and `npm test` (jest-expo; `src/__tests__/`: the offline
layer, the waves, the spark hints) before declaring anything done. Cloud builds and the Play
listing: §6.

---

## 3. The map of pages

| Path | What | State |
|---|---|---|
| `index.html` | The landing page, seven screens deep: the poster wall and the hero → how swiping works → a strip of cards → the room → who is playing → the turning city globe → a black footer screen with `go outside` and `get the app` | works |
| `explore/` | **The wall.** Every night that fits, six posters across, soonest first; the words come on hover. The filter line (country / city / kind / date) above it. The deck itself lives in the app | works |
| `explore/event/?slug=…` | **The night page** (a contact sheet): where · when · kind (ticket / szene), the ticket, who's coming, the after, beforehours, the card it leaves you. One shell for every night; the night is fetched by slug. §5 | works |
| `djs/` · `friends/` · `maps/` | **Closed on the web.** The title (`who is playing.` / `yours.` / `go local.`), then "only available in the app." and a `preview.` button that opens a phone (`phone.js`) playing the app's real screenshots from `phone/` with a finger tapping and dragging (`djs-1/2`, `yours-1/2`, `map-1/2/3` .jpg, portrait phone captures; finger positions per shot are set in `phone.js`) | closed, live in the app |
| `cards/` | **The collection** — afterhours cards. Three samples; empty when signed in until the first check-in | a skeleton |
| `login/` | Sign-in (`account` in the menu). Three columns: sign in · (first time? / settings) · give feedback | works |
| `register/` | **Registration** — two steps: email + password, then the handle (+ city). Not finished until a handle is chosen | works |
| `reset/` | **A new password** — sends the recovery link signed out; sets the new password once the link lands you back signed in. The app's reset mail points here too | works |
| `settings/` | **Settings** — profile (handle, name, one line, city) · privacy (who sees what you kept, findable by handle, email me) · account (download my data, delete account — type your handle to confirm) | works |
| `profile/?handle=…` | **Somebody's page** — how you reach them, what they kept, their cards | works |
| `feedback/` | **Feedback** — subject, message, an optional way to reach you. No sign-in needed | works |
| `passport/` | **Your devices together** (21.10.2026): one number — the tokens a second of every device together — a line per device, a field to paste another device's passport (the app: *copy json*), and this computer as a small qr code for the phone's passport tab (*connect*). The computer is measured as the page opens, in the browser and roughly (cores, `deviceMemory` or 8, a 64 MB Float32Array copy for bandwidth, a 256×256 matrix multiply on one worker per core for gflops), as `passport/0.2` with `kind: computer`, `approx: true`; the device id and the pasted devices live in localStorage. `passport/qr.js` is the encoder, by hand: byte mode, level M, checked module for module against the `qrcode` package | works |
| `help/` | How this works: the app's six steps (one card · it becomes a card · the room · who is going · near you · who is playing), then what the web shows. Two live numbers at the top from `health()` | works |
| `privacy/` | The English summary of the datenschutz page, covering the app too (20.10.2026: Google/Apple sign-in, messages, groups, sparks, posts, reports and blocks, Apple Music previews, what a deletion takes; in en · de · tr). The binding German page still lags behind it | works |
| `impressum/` `datenschutz/` `agb/` | The German legal pages | **placeholder** (the square brackets are still to be filled in) |
| `404.html` | "this one is gone for good." — four ways out | works |
| `admin/` | The admin panel: events, venues, types, feedback, comments, profiles, poster uploads | works, admins only |
| `sound/` · `posters/` | Empty index pages over the sound files and the drawn posters | leave them |
| `strip.html` | A parked sketch (horizontal strips) | leave it alone |

Every page has a **footer**: `© 2026 afterhours` + impressum · datenschutz
· agb. It has two forms: the normal one that sits in the flow, and
`foot thin` for the full-screen pages (`explore`, `maps`, `friends`,
`djs`) where it sits in the corner. Three pages have no footer:
`index.html` (it has its own black footer screen), `admin/` and
`strip.html`.

**The menu** is the app's tab order: `explore · djs · yours · map ·
collection · help · account` (`yours` → `friends/`, `map` → `maps/`,
`collection` → `cards/`, `account` → `login/`). Signed in, `account`
becomes "welcome <name> (:".

**Every surface.** The layout is desktop-first and narrows in bands, each
a `@media` block in `style.css`: below **1180px** the photo scales with
the viewport (`min(780px, 46vw)`), the intro starts under the sound rows
and the wall drops from six posters across to four; below **900px** the
globe screen moves the walking-distance list to the bottom of the frame,
the room and djs screens stack, and the footer screen gives the sónar
note its own line and the buttons a full row; below **720px** the rest
stacks — the menu wraps, the sound rows become a bottom bar, the photo
leaves, the wall is two across with the caption under the poster. The
desktop at 1440 is untouched by all of it: poster 146×219, photo 780px,
measured after every pass.

---

## 4. How the data flows

Both clients read the same Supabase project (`elmnnyxgavwjxvwjgjcu`) with
the same public key and the same RPCs — `deck`, `city_counts`,
`swipe_set`, `kept`, `friends_*`, `profile_*`, `event_people`,
`check_in`, `room_*`, `nights_near`, `export_me`, `delete_account` (§8).
The site's copy of the key is `config.js`, the app's is `app/.env`.

**On the site:**

```
config.js        Supabase URL + publishable key (both public)
   ↓
data.js          decides whether it is live or local
   ├── live   →  Supabase REST → turns the rows into the site's shape
   └── local  →  events-data.js, via data-fallback
   ↓
window.POSTERS   the nights: { slug, kind, title, meta, body, poster | image, startsAt, venue, city, source }
   ↓
data-after       the page's own scripts load ONLY after the data has arrived
```

The pattern on every page:

```html
<script src="../data.js?v=135"
        data-fallback="../events-data.js?v=135"
        data-after="wall.js?v=135, filters.js?v=135"></script>
```

The shared `AH` object: `AH.mode` (`live` / `local`), `AH.request()`,
`AH.errorText()`, `AH.session`, `AH.signedIn()`, `AH.sessionReady`
(a promise), `AH.onSessionChange(cb)`, `AH.refreshSession()` (renews an
expiring token; `AH.request` calls it before every request, so a page
left open past the hour keeps working), `AH.signUp()`,
`AH.signInWithPassword()`, `AH.requestRecovery()`, `AH.updatePassword()`,
`AH.events()`, `AH.kept()`, `AH.saveSwipe()`,
`AH.friends()`, `AH.comments()`, `AH.myProfile()`.

**Real events (Ticketmaster).** Since v141 the database also holds synced
nights: `source = 'ticketmaster'`, an `image_url` (a photograph instead of
a drawn poster), a `ticket_url` (a real ticket page) and an `external_id`
the daily sync upserts on, so a night keeps its uuid and the swipes on it
survive. The deck's default is now **everywhere** — `deck(null)` deals the
whole world, soonest first — and the explore filter opens on
everywhere/everywhere. A synced night renders as an `<img>` (2:3, cropped
with `object-fit: cover`) wherever a drawn night renders an `<object>`,
and its event page is the shared shell `explore/event/index.html?slug=...` — no
folder is generated for it. The landing is live, and its wall is CURATED:
`featured.js` names twenty hand-picked nights (01.10.2026 → 01.01.2027;
the best covers, the most gloriously absurd, the loudest names — The
Weeknd's After Hours Til Dawn leads, for the obvious reason) that hold
the wall in written order until their dates pass; each entry may carry a
`pos` (object-position) to seat its cover in the 2:3 frame, and a `body`
— the line the hover panel speaks for that night, each of the twenty in
a different register (a customs form, a shipping forecast, a bug ticket,
a diplomatic cable...) — and an `artist` + `song`: the act's most famous
track, hand-picked. On the event page a small chip sits ON the poster
(no height added) and plays the Apple Music preview of that song — no
key, no account; the arrow beside it leads to the store, which is the
use Apple hands the previews out for. The two non-music nights carry no
song and show no chip. Whatever the
calendar takes, a random hand covers: `data-sample="36"` on its data.js tag pulls a wide
pool (`deck(null)`, limit 300), keeps only nights with a photograph, hangs
a recurring show once, shuffles, and cuts to 36 — the wall shows the
first 20, the globe the lot. The drawn posters remain only as the offline
fallback and on the seed pages; they are being retired. The coverage (which cities exist at all) is
`backend/sql/16_coverage.sql` — all of Europe, key Asia, North America —
and it moves together with the city map in
`backend/tools/sync-ticketmaster.mjs`.

**Security:** the key in `config.js` is not a secret and does not need to
be one. What protects the data is the row-level rules in
`backend/sql/02_rls.sql`. The `service_role` key is **never** written into
this repository.

---

### Three languages — english · deutsch · türkçe

Since 27.09.2026 the whole site and the whole app speak three languages.
The database already had the column (`profile_settings.locale`, checked
against `en / de / tr`); what was missing was the words.

**On the site** `i18n.js` is the first script of every page, in the
`<head>`, blocking on purpose. It decides the language — `?lang=de` in
the address → what was chosen before (`localStorage afterhours.lang`) →
the browser's languages → english — writes it onto `<html lang>`, and
pulls in `lang/en.js` (always, it is the fallback) plus the chosen
dictionary with `document.write`, so every later script finds `AH.t()`
answering in the right language. No fetch, no module: the site is also
opened straight from disk.

| In the markup | Does |
|---|---|
| `data-i18n="key"` | textContent |
| `data-i18n-html="key"` | innerHTML, for text carrying `<br />`, `<span>`, `<a>` |
| `data-i18n-attr="placeholder:key; aria-label:key2"` | attributes (also `content:` on the meta description) |
| `data-lang-block="de"` | a long page written out once per language (the four legal pages); `style.css` shows the matching block |
| `data-lang-pick` | an empty element that becomes the `en de tr` switch (`data-lang-names` writes the names out) |

| In a script | Does |
|---|---|
| `AH.t("key", { name })` | the sentence, `{name}` filled in; a list comes back as a list (the content pools) |
| `AH.tn("key", n)` | picks `key.one` / `key.other`, `{n}` filled in |
| `AH.has("key")` | is there such a key — used for `type.<slug>` and `featured.<slug>.body` |
| `AH.i18nApply(el)` | translates markup a script has just built |
| `AH.setLang("tr")` | remembers, PATCHes `profile_settings.locale` when signed in, reloads |

The english text stays in the HTML: it is the fallback, and what a
crawler reads (`og:` tags are not translated — crawlers run no scripts).
While a page in another language is being swapped the body is hidden
(`html.i18n-wait`), for 1.5 s at the very most.

**The switch** sits at the right end of the menu on every page (beside
the logo on a phone, where the menu row scrolls sideways instead of
wrapping), written out in the landing's footer and in `settings/` —
where it works signed out too. A choice made on a device wins; somebody
who signs in on a device that has never chosen gets the language of
their account.

**The words** live in `lang/src/*.json`, the three languages side by
side, one file per area (`common` · `landing` · `explore` · `account` ·
`pages` · `legal`), each with its own key prefixes.
`python3 tools-lang.py` builds `lang/en.js`, `de.js`, `tr.js` and
refuses to if a key lacks a language, a translation lost a
`{placeholder}`, a pool has a different length, or a page or script
asks for a key nobody defined. CI runs it with `--check` (the `site`
job). **Edit the json, never the generated files.**

**What is not translated:** data — titles, venues, artists, cities,
handles, what people wrote; the brand words (afterhours, beforehours,
szene); the drawn artwork (posters, the afterhours card). Kinds of night
ARE translated, through `type.<slug>`. `404.html` loads no file from
outside, so it carries its own small three-language table inline.
The legal pages: german is the binding text, english and turkish say so
under their title.

**The voice** is the same in all three: lowercase, short, dry — german
nouns lowercase too (*finde deine nacht.*), `du` and `sen`. Where the
english is a sentence-case paragraph (help, the featured nights, the
manifesto) the translation uses its own orthography. The glossary:
night *nacht / gece* · keep *behalten / sakla* · let go *ziehen lassen /
bırak* · deck *stapel / deste* · card *karte / kart* · wall *wand /
duvar* · collection *sammlung / koleksiyon* · map *karte / harita* ·
yours *deins / seninkiler* · handle *handle / kullanıcı adı* · the room
*der raum / oda*.

**In the app** the same thing is `app/src/i18n/`: `index.tsx`
(`LanguageProvider`, `useLang()` → `t · tn · tx · up · lang · setLang`),
`dict.ts`, and the words in `parts/*.ts` (`common` · `home` · `tabs` ·
`pages`). The keys are TYPED — a key that does not exist fails `tsc`.
Every component that shows text calls the hook itself, which is what
redraws it when the language changes (no restart, no remount).
The language is chosen on the home screen and in onboarding
(`components/LangRow.tsx`, before signing in) and in settings; it is kept
in the kv-store and in `profile_settings.locale`, so the site and the
app follow the same account. Nothing is uppercased by style any more:
React Native uppercases with the PHONE's locale, so `up()` (the app's
language) and `upperData()` (data) do it by hand.

### File by file

**The root**

| File | Job |
|---|---|
| `data.js` | The data layer. It runs first, then loads the page's scripts |
| `config.js` | Supabase URL + anon key + the default city |
| `session.js` | The session: talks straight to Supabase Auth's REST, the token lives in `localStorage` |
| `i18n.js` | **The three languages.** First script of every page; decides the language, loads `lang/*.js`, translates the markup, builds the switch |
| `lang/src/*.json` → `lang/*.js` | The words, three languages side by side; the generated dictionaries the pages load |
| `tools-lang.py` | Builds the dictionaries and refuses a half-translated one (CI runs `--check`) |
| `menu.js` | The menu as the session leaves it: "welcome \<name\>", an admin link for the admin |
| `beforehours.js` | The comments before a night (reading is public, writing needs an account) |
| `app.js` | The landing page's seven screens, the poster wall, the scrolling logic |
| `globe.js` | The turning city globe. No Three.js — its own projection maths, drawn onto a canvas |
| `venues.js` | The schematic coordinates of the Munich venues |
| `cards.js` | **The afterhours card generator.** `CARDS.front(night, id)` / `CARDS.back(night, id)` return SVG. `app/src/content/cardsgen.js` is the same file with the app's font names — change both |
| `events-data.js` | The 36 events, the fallback used when the backend is off |
| `tools-event-pages.py` | Writes the shell of ALL 142 event pages and the sitemap (§5) |
| `tools-favicon.py` | Generates the favicons from the logo set: the `a.` mark on ink (16/32 a centred `a` without the dot, 48/64 `a.` centred, 180 the app icon with the mark bottom-left, 512 maskable). Type from `app/assets/fonts/ArchivoLogo.ttf` |
| `tools-previews.py` | Generates the `og/` previews for all 142 nights: the poster through Chrome to PNG, the card assembled with PIL |
| `tools-site-check.py` | Walks every reference on the site: every href/src resolves, every event has page+poster+og, one `?v=` (the CI `site` job) |
| `fonts/` | The three typefaces as woff2 + `fonts.css`, served from here — no request leaves for Google |
| `manifest.webmanifest` | The site as an installable app: name, colours, icons |

**The page scripts**

| File | Job |
|---|---|
| `explore/wall.js` | The wall: pulls the nights for the filter and hangs them; the date window cut client-side |
| `explore/filters.js` | Our own drop-downs (not a native `<select>`) |
| `explore/comment-pools.js` | The beforehours pool — per kind, chosen with a seed from the slug |
| `explore/event.js` | **The one template that builds the night page** (§5) |
| `explore/event-data.js` | The night page's content pools, per kind |
| `cards/cards.js` · `card-data.js` · `session-state.js` | The collection: sample cards, hidden according to the session |
| `login/login.js` · `shortcuts.js` | The sign-in form; the middle block changing with the session |
| `settings/settings.js` | The settings page: reads `profile_me()`, writes `profile_setup()`, PATCHes the switches straight onto `profile_settings` |
| `feedback/feedback.js` | Feedback: one job, adding what was written to the `feedback` table |
| `register/register.js` | Registration: `AH.signUp()` opens the account, `profile_setup()` writes the handle and finishes it |
| `maps/map.js` | Places the venues on the schematic (faded behind the closed page) |
| `admin/admin.js` | The admin panel |

---

## 5. The night page: a contact sheet

We do not write a page per night. **One layout, and the content comes
from the data.** The three fact rows are the app's: where · when · kind,
with `ticket` or `szene` after the kind; the date reads `thu 26.09` on
both.

The idea comes from photography: a contact sheet is not a result, it is an
inventory — "here is what I have". The page does not describe a single
night either, but this month's frame of something that keeps happening.

```
┌──────────┬────────────────────────────────┬──────────────┐
│ LEFT RAIL│ MIDDLE                         │ RIGHT        │
│ (fixed)  │                                │              │
│ poster   │ explore / <name>               │ which        │
│          │ edition 05 · your 3rd          │ friends are  │
│ credits: │ <TITLE>                        │ going        │
│ doors    │ kind · day date                │  ↓           │
│ curfew   │                                │ get the      │
│ capacity │ three paragraphs               │ ticket       │
│ door     │                                │  ↓           │
│ payment  │ THE AFTER — a bracket out of   │ beforehours  │
│ photos   │ the closing time  ■─┬──┬──┘     │ · friends    │
│ walk     │                                │              │
│ room     │ ─ the first screen ends here ─ │              │
│ from     │                                │              │
├──────────┴────────────────────────────────┴──────────────┤
│ IF YOU GO — a black band, both faces of the card the     │
│ night leaves you, with nothing written on them yet       │
└──────────────────────────────────────────────────────────┘
```

- **The left rail** stays put as the page scrolls. Deliberately dull: the
  identity of a series is not in what changes but in what does not. Only
  the things that are the same every edition live here.
- **The after** is the section this page exists for. A bracket drops out of
  the moment the room empties and every branch is a room that is still
  open, in the order they open — the time is the story, the walk is a
  footnote. No pictures in it on purpose: the poster is on the rail and the
  cards are at the foot, and between them this has to read like a departure
  board rather than a third gallery.
- **The right column** shows who is going first, then the ticket, then what
  your friends said about that night, that room or that date. The list is
  no longer only *your* friends, and that is the point of it: two of the
  five you know, the rest arrive **through** somebody. Each row is a face,
  a name, and an answer — `going`, `kept it` (the swipe, no ticket) or
  `can't` — and the answer is also readable without reading, because a
  face dims as the answer weakens. Hovering a row swaps the handle under
  the name for **the path back to you**: you as a filled square, then a
  small face per hop, then *friend of emre* or *friend of friend of deniz*.
  Somebody is going is not information; a friend of Emre is going is a
  plan. Where there is no pointer (`@media (hover: none)`) the path is
  simply always the one showing.
- **The band at the foot** is a sibling of the contact sheet, not a fourth
  item in it (see the traps). It is the only black on the page and the last thing
  on it: paper, then the band, then the metal. It carries **both faces** of
  the card this night would leave you — the front is who stood there, the
  back is what the night sounded like and what got said in it. Nothing on
  it has happened, so nothing on it is filled: `NOT YET`, dashed crew
  squares, `AUDIO —:—`, `ROOM OPEN`, `NO. NOT ISSUED`. The slots are drawn
  and left empty rather than hidden or blurred — **a blur says pay me, an
  empty slot says go.** It used to say "editions you were at", which we had
  no way of knowing.

### Where the content comes from

| Part | Source |
|---|---|
| Title, kind, meta, first paragraph, poster | The event's own data (`POSTERS`) |
| The credit lines, the after rooms, paragraphs, price, ticket wording, comments | `explore/event-data.js` — **pools per kind** |
| Which part lands on which night | **a mulberry32 seed made from the slug** |
| The card's metal and motif | `featured.js` for a hand-picked night, otherwise the seed |
| Everybody's face | `avatars.js` — drawn from the name, so a person keeps one |

So an event shows the same thing every time it is opened, and no two events
look alike. (`explore/comment-pools.js` uses the same pattern.)

What changes per kind — konzert says `get the ticket`, rave `get on the
list`, hausparty `ask for the address`, meetup `save a seat`; how long the
night runs before the after starts counting (`RUNS`: a konzert three hours,
a rave eight); the credits say `bring something` instead of `card only`.

### How the after keeps its clock

Doors plus the run of the kind is when the room empties, and the bracket
hangs off that. A room may only open between **21:00 and 04:00** — past
four nothing opens any more, and a night that already ran into the morning
simply has no after, which the section says out loud instead of inventing
one. A night that ends in the afternoon waits for nine. Closing times are
whole hours between four and eight hours out, so nothing shuts at two in
the afternoon.

### Somebody's page — `profile/?handle=…&via=…`

You get here from a name in the column of who is going, and the link
carries the path (`via=jonas,nils`), because a page about somebody you do
not know should open on how you know them. Three things from three
sketches, in the order the question arrives:

1. **The path** — you as the filled square, a face per hop, the person at
   the end, hairlines between; "friend of friend of jonas"; the last hop
   can introduce you. Each hop is a link to its own page, path included.
2. **The head and the roll** — face, name, `@handle · city · since`, one
   line; then the nights they kept as a **contact sheet**: nine real nights
   from the listings in their city, in colour (the proof-sheet grey was
   tried and taken off — on this page the nights are the person), numbered,
   each leading to its night, and a tenth frame "not shot yet".
3. **The shelf** — the same black band the event page ends on, with the
   cards those nights left them with on `cards.js` plates, metals dealt by
   the seed; and the sentence that none of them are real yet.

Everything is drawn from the handle with the event page's seed, so a
person looks the same from every night. **A real account** with that
handle (`profile_card`, callable signed out) takes over its own name, line,
city and date — and nothing from the pools is said about a real person: no
line if they wrote none, no counts the database did not hand over. What is
still missing for real people is their kept nights (no RPC lets one person
read another's; the roll shows their city's nights instead) and real
cards, which do not exist for anybody yet. Everybody is public for now,
as agreed.

### Real people on a night — `17_real_people.sql`

The column of who is going and the beforehours on an event page, and the
roll on somebody's page, are the database now (the pools only stand in
with the backend off):

| call | what it answers |
|---|---|
| `event_people(slug)` | everybody who kept the night, each with the path back to the caller: degree 1 a friend, 2 a friend of a friend (`via`), 3 one further (`via`, `via2`), 0 no path — signed out, everybody is 0 |
| `profile_kept(handle)` | the nights one person kept, newest first |
| `friends_of(uid)` | the helper under both; not callable from the browser |

Both readers are definer — swipes are closed to strangers by the rule in
02 and this is the one place they open, everybody being public for now by
decision, except a person whose `kept_visibility` is private. Nobody has
a ticket in the database, so everybody in the column "kept it".
Beforehours reads `comments_public` and writes through `AH.postComment`,
the same road explore takes; the write box shows signed in.

`seed-test-people.sql` is the one-shot that gives the test accounts a
life — friendships in a graph that shows every distance from owner2,
the Weeknd night kept by all of them plus a staggered handful of München
nights each, and one line each on the Weeknd. Paste order: rename, 17,
seed.

### The faces

Nobody has uploaded a photograph, and an initial in a box was standing in
for one. `avatars.js` draws the placeholder instead: **a frame shot in a
dark room** — one lamp, a silhouette cropped by the edge of the picture,
and grain over the top. You can tell two people apart and you cannot see
either of their faces, which is the honest amount to show for a night that
has not happened. Everything comes from the name, so a person wears the
same face on every page.

The crop is the whole trick and it took three passes to learn it: a head
that fits neatly inside a square, centred, with two clean shoulders under
it **is** the little grey person every site shows when there is no
photograph. So the head is drawn big enough that the frame cuts it, and it
is placed in the outer thirds and never in the middle. When real
photographs arrive the only thing to change is the `<img>` that replaces
what this function returns.

### The unearned card

`cards.js` draws the same plate either way; `blank: true` on the night is
what empties it. A hand-picked night in `featured.js` may carry `metal`,
`motif` and a `card` line of its own — The Weeknd gets **rose gold and the
moon motif**, because rose gold is the colour dawn actually is and the
motif runs three rows of phases down the plate. That is the tour name,
printed as metal. Everything else is dealt a metal from the slug, so a
night always turns up wearing the same card.

The plate is 400 units wide and a listing title is not: the card takes the
artist from `featured.js` when there is one, and otherwise cuts the title
at the colon — `Artist: Tour Name` is how the listings are written.

**Live, the rooms are our own nights** (since 06.10.2026, `realAfters()` in
`explore/event.js`): same city, starting from an hour before this one
empties until five in the morning, soonest first, one per venue, three at
most, each opening that night's page. Live and nothing later, the bracket
is one mark long and says so. The invented rooms (`AFTERS` in
`explore/event-data.js`) only stand in while the backend is off. Nothing
in the section is booked with the ticket, which is the entire point of it.

### Adding a new event

1. Write the line into `events-data.js` (or add it to the database) —
   `slug`, `kind`, `title`, `meta`, `body`, the poster number.
2. Put the poster at `posters/NN.svg` (2:3, `xmlns` is required, the fonts
   go in the SVG's own `<style>@import`).
3. Write the shell:

```bash
python3 tools-event-pages.py 136
```

The argument is the version number (§10). It creates the folder and the
`index.html`, and the layout follows by itself.

---

## 6. The app

`app/` — Expo SDK 57, React Native, Expo Router, TypeScript. Android
first (`app.afterhours.android`), iOS configured (`app.afterhours.ios`)
but not yet shipped. It came into this repository on 25.09.2026 with its
own history (65 commits); `app/AGENTS.md` is the working rulebook Expo
asks for and stays with it.

**Screens** (`app/src/app/`, every file a route):

| Route | What |
|---|---|
| `index` | The intro (the wordmark), then the home screen: a rotating tagline, `sign up`, `explore your city`, the sound toggle. Signed in, straight to `yours` |
| `film` | **The intro film**, second cut (12.10.2026; retimed 20.10.2026 to about 43 s with shorter lines so each can be read, D4; silent — the home screen's sound corner already plays). Written by hand: `app/tools/film/film.html` is the source, `npm run film` (in `app/`, `tools/build-film.mjs`) builds `assets/film/film.html` with the app's own photos (resized by `sips`) and the three typefaces inline, so it plays in the WebView offline. Nine scenes on one timeline: the red dot and the name; a concert photo with *your city. after dark.*; the flow card (design E) swiped right with the red tint and left with the paper one; the night page as a ticket (design B) and a tap on `get a ticket ↗`; people (design C) with the red rings and a wave chain *friends of friends · via berk*; a Berlin spark, *hike the grunewald to the teufelsberg.*, sent in one tap; the map with pins, radar rings and the card walking `‹ 3 of 8 ›`; the account sleeve with a card landing in the collection and the red messages button; the name and *explore your city*. Captions in en · de · tr (`__LANG__` in the source, written in by `film.tsx` before loading). `explore your city` on the home screen and settings → `show the intro again` open it; `skip` top right; it posts `end` and the app goes on to `signup` (members go back). `film.html#s4` in a browser holds one scene for looking at it. The first cut (Claude Design export) is gone. |
| `explore` | The old six onboarding slides + `where are you based?` — no longer linked |
| `(tabs)/flow` | **The deck.** One card; under the city a `tickets · spark` switch, and on `tickets` a third row with `all events · any time`. **The card** (11.10.2026, design E in `prototypes/ticket-card.html`, `components/CardFace.tsx`): the poster, with the date in its top left corner as an ink tag (`fri 17.10` in Archivo, `23:00` beside it; `date tba` when there is none) and the kind in a small one at its top right (`who is this?` and the share mark sit under it); under it the ink block holds only the title (red Archivo, a size larger), the venue (nothing when the night has none; the city stood in for a day on 12.10.2026 and read as a wrong place, so it went) and the friends who kept it; the block never shrinks under 124 px; `details ↓` on the left, `keep` on the right (no arrow since 11.10.2026). `ticket` is said once, by the hint that appears when the card is pulled up (one line, 13 px, air around the words) — until then the block stacked kind · ticket, venue and date under the title in mono, and said ticket twice. Under the card, with room around them, three buttons that do what a swipe does: ✕ let go · ↺ undo (small, faint while there is nothing to undo) · a red ♥ keep. **Keeping** shows a red heart and `KEPT` over the deck for a moment (not for sparks; a still fade when the phone asks for less motion). A night's card carries a **share** mark at its top right, under **who is this?** when it has a text (both below). `tickets` is the plain deck; `spark` holds only **sparks** (below) |
| `(tabs)/people` | **Connect** (12.10.2026, design A in `prototypes/connect.html`; the tab was people, the file keeps its name): the first two groups as covers side by side (a cover photo or the group's colour, the badge, one line: *live now*, the vote closing, the plan, *travel · 5 travelling*; more than two → *all groups · n ›*), then *with your people* (the gallery) and the decks; messages is the tab beside it (the floating red button and `MessagesButton` are gone). The two covers are smaller than the page, with air left and right (owner, 12.10.2026). The search and the faces of your people moved to the messages page; the floating red button is gone. Before: **People** (11.10.2026, in the place of the djs tab, which is gone; its DJ page `dj/[id]` stays, reached from a story). The hub yours was until then, minus the feed: a search field (typing replaces the page with people results), **groups** as one framed line (the 28 px badges of your open groups, `groups · 2 live now`, › → `groups/`; the row it was until 11.10.2026 made the groups look like a footnote — design C in `prototypes/people-groups.html`), then **with your people** — a gallery, one full photo per page (each page is the screen width, so a swipe always lands on a whole photo), sliding sideways and moving on by itself every 6 s (a finger restarts the count; dots and `03/08` show where you are). **First in it, the groups' plans and votes** (`group_plan()` for each living group, read on every visit): a group's **plan** is a card over the night's photo — the group's badge and name on top with `group plan` under it, `4 of 6 in` in red, the title, venue · day · time, the faces of who is in, and `i'm in` (red; `you're in` once you are — the same stored answer as `who's coming?`, `rsvp_set`); an open **vote** is a card over the leading night's photo — `group vote`, `2 of 5 voted · closes thu`, `3 nights to choose from`, their titles, your vote if you cast one, and `vote`; a tap on either opens the group on its plan tab (`groups/[id]?tab=plan`). A group with neither is only in the line. Then the nights your friends kept, most keepers first (a red `match` badge when you kept it too; **who kept it is the loudest line on the card**: their faces 36 px overlapping — photo or drawn face, red edge when out now, `+n` after four — their names large and `3 friends kept it · live` in red, and a tap on it opens who's coming; `me too` and `who's coming?` under it; `who's coming?` opens `components/WhoSheet.tsx`: your friends on that night — everyone who answered (coming first, then maybe, then not) and everyone who kept it — with their faces, their answer as a tag (coming in red) and where they are when out right now; a tap opens their profile; under them your answer, in · maybe · out, **stored** (`32_rsvp.sql`, `data/rsvp.ts`) so your confirmed friends see it — the same answer twice takes it back. The card itself says `2 coming` when friends (or you) said in), then the sparks waiting for your answer in gold → the spark page; a tap on a night opens it. Before you have friends the gallery is made of real nights coming up in your city (with sample friends on them), so a tap still opens a real night; **decks** (until a friend keeps something, friends' deck is a sample of real nights coming up here with sample friends on them; four card stacks — friends', yours, 2nd wave, 3rd wave — with their counts; a tap opens the viewer, which plays like the flow); and **your people** (62 px faces — a photo, or a drawn face made from the name, `components/Avatar.tsx`; a tap opens their profile; whoever is out right now first, ringed red with a breathing dot and where they are; wants in · asked · kept n; add + suggestions at the end). The old DJ tab (genre pill, now playing, clips over a record rack) is in this row's git history; `components/ClipShelf.tsx`, `content/clips.ts` and `audio/useTrack.ts` stay in the tree for the DJ page and for when the DJs come back |
| `(tabs)/yours` | **Hidden since 12.10.2026** (owner: a feed is the wrong shape for afterhours; no tab leads here, the file and the tables stay; the stories moved to the messages page). Before: **Yours, the feed** (redesigned 05.10.2026, that version is in `prototypes/yours-before-redesign.tsx.txt`; 11.10.2026: the search, groups, the gallery, the decks and the people row moved to the people tab, the stories came in from the djs tab): **stories** first (`components/StoryStrip.tsx`, ringed faces as on Instagram: DJs with a story first, a red ring unseen, grey seen, then the DJs you follow or everyone, your city's first; a tap plays the story in `components/StoryViewer.tsx`, a face without one opens the DJ page; still the sample stories of `content/stories.ts`), then one feed: the **posts** by you and your friends, newest first (`components/PostCard.tsx`, no heading of their own any more), and **from past nights**, an endless feed like a timeline (`past_feed()`, `31_past_feed.sql`): one post per past night with a photo, newest first, a year back, in your city plus wherever you or friends went — venue and date on top, the photo full width and square, then `you were there` / `berk, lina were there` in red and the title. Ten at a time, the next ten asked for near the bottom. The photos are the nights' own pictures. The sample posts that used to be mixed in (drawn faces, invented comments, marked sample) went on 11.10.2026: nothing invented sits in the feed any more; an empty feed stays empty. `+` (a new post) sits in the title band; messages are the red round button at the bottom right (`rooms` below) |
| `(tabs)/map` | **The map:** the top is the flow's: the city large (a tap opens the place picker), then pills `all events` · `this week` (the default since 07.10.2026) · `near me` (`components/Pill.tsx`, shared with the flow); the radius slider. Every mark sends out a **radar ring** every 3.2 s, each starting at its own moment (from its id) and staying small, so neighbours ripple one after another; the rings take the mark's colour (paper, red, gold) and hide while a night is picked. One-finger zoom as in Google Maps: tap, touch again and drag — down zooms in, up zooms out, around that spot; a double tap without a drag zooms in one step (`components/MapWeb.tsx`, touch handlers on window in the capture phase; Leaflet's own double-click zoom is off). Dragging the km slider moves the map live: the circle and the zoom follow the finger (unsnapped zoom, no animation), and it eases on release. While the map moves it stays lit: tiles load during the move (`updateWhenIdle: false`), six rings of tiles are kept around the screen, no fade-in, and the ground under a tile still on its way is the tiles' own tone (#1b1a19, measured) instead of black. **Sparks are on the map too** (`30_spark_map.sql`): a spark gets the spot where its host was when pressing create it (last known position, else a 6 s fix; no permission = no spot), and the map shows every spark you can see — yours, those ticked for you, those of your waves — as a **gold diamond**; `n sparks` in gold under the night count. A tap opens the same caption as a night, gold instead of red: kind · who started it, time · place · how many are in, your answer; `go →` opens the spark page (`spark/[kind]?invite=<id>`, now read with `spark_get()`, so it still opens after you answered; your own shows no buttons). The spot is sharp for the host and their friends and rounded to about a kilometre for the 2nd and 3rd wave, since it is often a home. You are a round puck — paper disc, ink gap, red rim and core, a slow red ping — so you never read as a night. **Nights are map pins** (07.10.2026): a rounded drop with an ink hole and a soft shadow, standing on its tip — paper, red when a friend kept it, the picked one larger and red with a paper ring; sparks are a rounded gold diamond. **Every time the map opens** it centres on you with a 5 km circle (the last known position at once, a fresh fix when it comes), filters kept; tapping the tab again also resets the filters. The zoom stays on whole levels (tiles are drawn for whole levels only; in between the names went blurry) except while the slider is dragged, the street names are at 90%, and the circle is only fitted once the WebView has a size (fitting into 0×0 zoomed all the way in) **The card walks the map** (11.10.2026): a swipe left on the night's card takes the next pin, right the one before, in the pins' order (nearest first; `‹ 2 of 8 ›` says so), and the map pans so the picked pin sits in the clear above the card (`panInside` in `components/MapWeb.tsx`). A swipe here is not keep / let go as on the flow: the card has `go →` and the night's page for that. |
| `(tabs)/account` | **Edit profile sits under the collection since 12.10.2026** (the first screen is you and your cards; the button is a paper line on ink after the cards' foot). **Under it, no paper any more** (design B in `prototypes/account-paper.html`): *coming up* as a rail of posters with the date on each and `ticket ✓` where you said you got one (`tickets_mine`), with *next · in n days* at the right; *your sparks* as cards, the first gold-framed, each with a bar of the answers (gold in, dark out, empty quiet) and the counts; *cities* as chips with the number of nights, the most first. **Account, a record sleeve** (06.10.2026, the same as someone else's profile, `components/Sleeve.tsx`): your photograph as a square cover with the name on it (tap it to change the photo), the record sliding out behind it on the right with a red label — in Munich the label reads `MÜNCHEN` over the Alps (a pale far range, the near range in rock, snow on the summits), elsewhere it carries the number of nights; the grooves are drawn light enough to read on ink. Under it the bio and the longer text, then **the links as round marks** (`components/LinkMarks.tsx`: instagram · spotify · x · whatsapp always, filled when added and only outlined when not — an empty one opens edit profile; tiktok, soundcloud, website once added), **two counts** (`events` = nights kept, `your people` = friends; each opens its list, `list/[kind]`), a full-width red `edit profile`, then the collection, placed so the first screen ends halfway down the cards. On paper below: coming up, your sparks, your cities. The photograph is chosen from the phone (`expo-image-picker`), cut down to 1080 px, kept on the phone and uploaded to the `photos` bucket (`24_photos.sql`), readable by you and CONFIRMED friends only. Sign out lives in settings |
| `night/[slug]` | **Since 12.10.2026:** the fixed sentence every listed night carried (*a real night, straight off the listings…*) is no longer shown (a night's own text still is, `isSyncedBody`), the room rule line (*opens at check-in, freezes 48h after*) is gone, the count says only *n checked in*, and a member can **nudge a friend** about the night (`components/NudgeSheet.tsx`: pick a friend by name, they get a direct message with the act, the day and the link, and the push a message brings; the pill then says *nudged berk ✓*). **The night page** (design B in `prototypes/night-page.html`, 12.10.2026): the top is a **ticket** — the photo, the title (red Archivo) and `club night · zenith`, a perforated line with two notches, a **stub** with the date, the doors and the venue large, and the red action: `get a ticket ↗` when there is one, else `check in` (or `the room` once you are in) over `szene · no ticket needed`. Under the ticket `check in` / `keep` (or `keep` / `share` for a night without a ticket), the room line, the text, the weekday line, beforehours. The where · when · kind rows went into the stub. **Did you get your ticket?** (12.10.2026, `60_tickets.sql`, `data/tickets.ts`): Ticketmaster tells nobody who bought what, so a tap on `get a ticket` keeps the night and, when the app comes back to the front, the page asks once — `got it` / `not this time`; the answer is stored (yours alone, goes with the account), the stub then says `ticket ✓ · you have your ticket`, and the night's card in your deck on people wears a paper `ticket ✓` tag |
| `(tabs)/passport` | **The device passport** (kula decentralized ai, 20.10.2026, design E in `prototypes/passport.html`): what this phone can carry at night, as a card — a red block with the largest Q4 model that fits and the rough tok/s, paper under it with ram, app cap, cpu, bandwidth, compute, disk and battery. Measured by device-passport's own code (21.10.2026): `modules/passport-measure` compiles `../device-passport/passport-core` (Measure.kt, Passport.kt, the `PassportCore` door) when it sits beside this repo, else the snapshot in `modules/passport-measure/vendor` (`npm run passport:sync` in `app/`; `passport:check` in the gate fails when the snapshot is behind). `src/passport/contract.ts` decides what kula reads: any `passport/0.x`, fields it does not know kept and sent on, a newer major or an API not in `SUPPORTED_API` falls back to the JS measurement (marked *approx*, also used in Expo Go and on iOS). The rules for changing the measurement: `passport-core/contract/CONTRACT.md` in device-passport; `src/__tests__/passport-contract.test.ts` holds kula to the same files, kept on the phone and sent to the account (`passport_save`, `07_passports.sql`). **Together** (21.10.2026, `components/Devices.tsx`): under the card one number — the tokens a second of this phone and the devices connected to it — a line per device, and two buttons: `show qr` draws the passport as a code (`passport/0.2`: now with `device_id`, `kind` phone · tablet · computer, and `os`), `connect` opens the camera on the other phone (`expo-camera`; `paste json` inside it, for a computer or where there is no camera). The list stays on the phone (kv-store `passport.linked`, at most 8, the same device again replaces itself). The speed adds up; the model does not (memory is not pooled) and is the best device's. A tablet runs the app itself; a computer has no app, so `passport/` on the site measures it in the browser and draws the code (§3). Then **tonight**: the night worker's state and counter (`night/useNight.ts`, a simulation for now), then the cards earned so far |
| `rooms` | **Messages, second cut, a tab of its own** (12.10.2026, design B in `prototypes/messages-page.html`; the page is `(tabs)/messages.tsx`, the chat icon second in the bar, connect in the middle; `/rooms` redirects to it): stories on top (`StoryStrip`), then two tabs — **tonight**: `+ new conversation`, your direct threads with the friends out right now first (a red ring and where they are, `friends_live`); **people**: find someone (name or @handle, the same results as before), the requests waiting for you with *accept*, your people as faces (red ring = out now, `+` adds by handle), suggested. Only direct messages live here now: the group chats are in the groups and a night's room on its night page. Before: **Messages** (11.10.2026, design D in `prototypes/messaging.html`; the route keeps its old name): the red round button at the bottom right of `yours` and `people`, above the tab bar, opens it — with what is new on it as a paper badge (`components/MessagesButton.tsx`). One list, `data/messages.ts`: `new conversation` on top (12.10.2026: a sheet with your confirmed friends, narrowed by what you type; a tap opens the thread, `dm/[id]`, `59_dms.sql`; messages are between friends only), then your direct threads (face, name, the last line, one unread when the last line is theirs and newer than you saw), then your open rooms (from `my_cards()`, the time left in red and the new lines counted), then your groups' chats (badge, name, the last line, the new lines counted), then the frozen rooms, dimmed; a row opens the room or the chat. What you have seen is kept on the phone, not the server: a room's line count and a chat's last line id, written while the room or the chat is open (kv-store, `ah.seen.*`). Until then rooms alone were behind a small chat mark in the title band of yours. Pulling down closes it |
| `room/[slug]` | **The room:** open for 48h after check-in, `two lines, at most`, then frozen |
| `dm/[id]` | **A direct conversation** (12.10.2026): you and one friend, bubbles as in a group chat, new lines every 3 s, a long press takes your own back. Notifications carry the name and `a new message`, never the words; a switch under notifications → together |
| `person/[handle]` · `list/[kind]` | **Someone's profile** (06.10.2026), opened from search, suggestions, your people, who's coming, the names in the feed: the same record sleeve as your account — their photo (friends only; otherwise their initial), the bio, their links (friends only), their two counts, a full-width red button that says what it does (`add friend` · `accept request` · `request sent` · `friends`), then their collection (`person_cards()`, `36_person_cards.sql`, friends only). Sample people (the names in the sample friends of the people tab) get a page drawn from the name, marked sample. `list/events` and `list/people` (`?handle=` for someone else, `38_profile_lists.sql`): the nights kept and the people, each row opens the night or the profile; pulls down to close |
| `dj/[id]` · `friend/[id]` · `friend/add` | A dj (follow, sets, next); **a friend, in the account page's language** — their photo (or drawn face) full-bleed with the name large and `live` when out, then on paper their kept nights as photo cards (tap = the night), their text and links, nights together, accept / remove; adding one by handle |
| `signup` · `welcome` | Email + password (or `leave both empty to look around first`), then the handle |
| `auth-callback` | Where Google sends you back (`afterhours://auth-callback`); sets the session from the address and goes on to `welcome` (handle) or `yours` |
| `settings` | **Grouped** (07.10.2026): a profile card on top (photo · name · `edit ›`), then one row per group with what is inside as its hint — **app** (language, background music, genre) · **privacy** · **notifications** (allow on this phone, then the switches in three groups: friends, nights, discovery; quiet hours 00:00–09:00; `lib/push.ts` + `26_push.sql`) · **account** (with delete account in a red box of its own) · **about**. Each opens its own page (`settings?section=…`), so every setting is one or two taps away. Every page closes by pulling down. `›` opens inside the app, `↗` leaves it. The version sits at the bottom of the home and about pages | `download my data` writes the export to a file and opens the share sheet (browser: a download; `expo-sharing`, 20.10.2026).
| `profile` | **Edit profile** — where `edit ›` leads: photo, name, handle (its status beside the label), bio (300, several lines), **about you** (1500), city, **elsewhere** (seven networks: instagram · tiktok · spotify · soundcloud · x · whatsapp · website; a leading @ is dropped, whatsapp keeps the digits; the spotify and whatsapp fields say in grey what to type; only friends see them); one `save profile` writes them through `profile_setup()`, `profile_about_set()` and `profile_links_set()` and goes back. Pulling down closes it |
| `credits` | The music (Free Music Archive, CC BY), the map tiles, the type |

**Google sign-in** (`auth/google.ts`): `continue with google` on the sign-up screen — one door for signing up and signing in. Supabase's Google provider through an in-app browser (`expo-web-browser`), back to `afterhours://auth-callback`, the session is set from the returned address (implicit tokens or a pkce code, both handled). A guest who presses it gets Google LINKED to the same user (`linkIdentity`, needs "manual linking" on in Supabase) so their swipes stay; if linking is off it falls back to a plain sign-in. First time in, the handle step (`welcome`) as with email. Needs, once: a Google Cloud OAuth client (web) with `https://<project>.supabase.co/auth/v1/callback`, the Google provider switched on in Supabase with that client, and `afterhours://auth-callback` in Supabase's redirect URLs.

**The decks on yours play like the flow** (05.10.2026, `components/DeckViewer.tsx` now wraps `Deck`): the card flies off right (keep) or left (let go, as in the flow it leaves your flow deck too), up = ticket, down = night page, `undo` in the top row takes the last swipe back (and its write); at the end `start over` deals the same deck again. Your own deck only browses — swiping there writes nothing. Sample wave cards write nothing either. Before, sideways was a paging list and keep was only the red strip.

**Waves** (`yours`): above `friends' deck` two more — **2nd wave** (nights kept by friends of your friends) and **3rd wave** (one step further), a way to meet the people around your people. Each card says where it came from (11.10.2026, design E in `prototypes/via-chain.html`): three rings, you in the middle and the card's wave in red, then `friends of friends` or `one step further` and one line, `tarık kept it · via lina` (two names through on the 3rd wave). Until then it drew the chain as squares, `you — L — T`, and said the same thing again in mono under them. The cards are real since 06.10.2026: `waves_kept()` (`backend/sql/33_waves.sql`) walks up to three steps of accepted friendships, keeps the shortest chain to each keeper and returns their upcoming keeps; anyone with `kept_visibility` private is neither shown nor named on someone else's chain (`data/waves.ts`, one card per night and wave). Keeping a wave card keeps the real night. While a wave is still empty the sample cards of `content/waves.ts` stand in, marked "sample".

**Sparks** (`spark` panel of the deck, 05.10.2026; first called `scene`, the stored choice still reads the old name). A spark is a night nobody has organised yet — thirty-one since 11.10.2026: **derby night at yours**, **grill by the river**, **a hike, out of the city**, and **meet the sunrise**, **breakfast club after the after**, **a rooftop hunt**, **a night swim**, **pub quiz, team of four**, **something new opened on your street**, **disposable camera night**, **someone else's festival** (the eleven of 07.10.2026), then the twenty of 11.10.2026: **karaoke, no shame** · **bring a record** · **a speaker and a park** · **ride the empty city** (bikes at midnight) · **the last screening** · **board games until someone flips the table** · **the flea market at seven** · **the parking garage at night** (skates) · **dinner for eight** · **sauna, then the cold** · **open mic, one of us goes up** · **ping pong under the streetlight** · **bouldering, then beer** · **wine on the grass at dusk** · **three bars we have never been to** · **leave the city for the stars** · **floodlights, five a side** · **the last tram, end to end** · **a jazz basement** · **walk the city until it is light** (`content/sparks.ts`, photos from Unsplash in `assets/sparks`, credited in `app/CREDITS.md`; the eight of October 6 and the twenty of October 11 borrow photos from the feed until their own arrive; the table takes them since `39_spark_kinds.sql` and `56_spark_kinds_2.sql`). The outdoor ones among the twenty (open air, picnic, ping pong, the ride, the flea market, the walk, five-a-side, the stars) read the forecast like their nearest cousin (`LIKE` in `data/sparkHints.ts`); in Munich the open air, the ride, the cinema, the flea market, the picnic, the stars and the jazz get real spots (Flaucher, the Isarradweg, Museum Lichtspiele, the Olympiapark flea market, the Englischer Garten, Kochel, Unterfahrt — from memory, not checked). **Berlin has all thirty-one** (12.10.2026, `LOCAL.berlin` in `content/sparks.ts`, words under `spark.berlin.*`): every title names its place — *hike the grunewald to the teufelsberg*, *grill on the tempelhofer feld*, *bearpit karaoke at the mauerpark*, *round the table at dr. pong*, *the m10 to the end of the line* — with a line and two real spots each (Markthalle Neun, Klunkerkranich, Schlachtensee, Hard Wax, Kino International, Spielwiese, Vabali, Boulderklub Kreuzberg, Archenhold-Sternwarte, A-Trane…), so a spark started in Berlin carries that title, not the general one (owner: a hike is not a spark, hike to somewhere is). **In Munich every spark has its own version** (`sparkIn()`, `LOCAL` in `content/sparks.ts`): the same kind and photo, its text and places rewritten with real spots — the grill at the Flaucher, the hike up the Herzogstand from Kochel, the sunrise on the Olympiaberg or at the Monopteros, Schmalznudeln at Café Frischhut, the Vorhoelzer Forum and the Werksviertel, the Feringasee, Kilians on the Frauenplatz, Gärtnerplatz, the Japanfest, the Auer Dult, Tollwood (chosen from memory, not checked against the places themselves); other cities keep the general text. The sunrise, the rooftops and the night swim read the forecast like the grill; the rest keep their own hour. The **spark** panel holds ONLY sparks — no ticketed nights, no type / time pills: friends' invites first, then the three to start yourself; `start over` just deals them again (ticket swipes are not touched). A spark is drawn exactly like a ticket card (`CardFace` with a bundled photo, `DeckCard.local`, and a `note` line: "swipe right to create your event", or for an invite "<name> is starting this · n in so far"); its red strip says `create →` (`i'm in →` for an invite). There is no ticket, so up does nothing; down / `details` opens its page. **Right opens the spark page** `spark/[kind]` — the night page's layout (photo, kicker, title) with **create it** right under the photo: name, the first of four start times, the first place and the 1st wave are suggested already, so one press creates it; below, `change it if you like` lets each be changed. **Who gets it is a wave, not a list** (`28_spark_waves.sql`): 1st wave = your friends, 2nd = their friends too, 3rd = one step further, each with how many people it holds (`spark_audience()`); everyone inside finds it in their spark panel and answers with a swipe. It is created even when the wave is still empty. Your own sparks are listed on account (`spark_mine()`); one opens as `spark/[kind]?invite=<id>` with who is in and who is not this time by name (`spark_people()`, `35_spark_people.sql`, 9 checks) and **call it off** (press twice, `spark_cancel`). `spark/[kind]?invite=<id>` is otherwise a friend's spark: `i'm in` / `not this time`, with started by · when · where · who. Sparks reach people inside the app only, on top of their spark panel (an invite card says the wave when it came from the 2nd or 3rd). Backend: `backend/sql/27_sparks.sql` (closed tables `sparks` + `spark_invites`, five definer calls, only confirmed friends can be invited — strangers in the list are dropped silently), `test/sparks.test.mjs` 24 checks; pasted into the live database on 05.10.2026. Then `28_spark_waves.sql` (`test/spark-waves.test.mjs` 22 checks). **Push** (`34_spark_push.sql`, 14 checks): `spark` when one reaches you — ticked by name, or inside its wave at the moment it is started (the 2nd and 3rd wave count against the ten a day) — opening `spark/[kind]?invite=<id>`; `spark_in` to the host when someone is in, once per person. One switch, **sparks**, under discovery (`notify_sparks`, added in `26_push.sql`). **Sparks read the world** (`data/sparkHints.ts`): on the spark page the **derby** suggests the real next matches of the city's team (TheSportsDB, free test key `3`; münchen: bayern, istanbul: galatasaray · fenerbahçe · beşiktaş, a match between two of them first), starting half an hour before kick-off and named after the match; the **grill** and the **hike** put first the days the forecast likes (Open-Meteo, no key: dry, warm enough for the grill, mild for the hike, weekends a little more), with "24° · dry" under the times. No answer, another city or no match in ten days: the spark's own hour on the next days, as before. Both answers are kept two at a time in the offline shelf.

**Listen to the artist** (12.10.2026, `63_previews.sql`, `data/previews.ts`, `components/Listen.tsx`, design D in `prototypes/listen.html`). A night with a preview shows a paper `♪ listen` pill under `who is this?` on its card; a tap plays the 30 second preview of the act over the poster, dimmed: a big ring fills with the seconds, the track name, *artist · 0:12 / 0:30 · apple music ↗* (the link opens Apple Music), ✕ or another tap or a swipe stops it (`useTrack`, one at a time, the ambient music hushed meanwhile). The previews are matched ahead of time by `backend/tools/previews.mjs`: the act of each upcoming night of a city is searched on Apple (the public search, no key), and only a result whose artist name is the act letter for letter is taken — no match, no row, no button (a wrong artist is worse than none); the tool writes `backend/sql/previews-<city>.sql` to paste. Munich on 12.10.2026: 38 of 50 nights. `previews_for(ids)` reads them, anyone; the table is closed. 4 tests in `backend/test/previews.test.mjs`.

**Who is this?** (07.10.2026, `40_event_about.sql`, `data/about.ts`, `components/About.tsx`). A night whose act has a text shows a red-into-gold `✦ who is this?` button on its card; it opens a sheet from the bottom: the kind and home, the name large, two or three sentences, two numbered facts, the source (a link) and `summarised with ai`; `keep` there throws the card right. The texts are written ahead of time per night and language (en · de · tr) from the act's Wikipedia summary and nothing else, read against it once more, and stored in `event_about` (readable by anyone through `about_for(ids, lang)`, written only by the service). A night without a text shows no button: nothing is better than an invented one. The first 18, all in Munich, came from `backend/sql/about-munich.sql`; 16 more on 12.10.2026 from `about-munich-2.sql` (every upcoming Munich night with a Wikipedia page; the 18 without one, or landing on the wrong one, were left out and are listed in the file); three searches landed on the wrong page ("Neunundneunzig" on the number 99, "Undeath" on the undead, "Gurriers" on a slang word) and were left out — the reason a future sync job must check the page is about the act before writing. Design: `prototypes/what-is-this.html`.

**Sharing** (07.10.2026, `lib/share.ts`, `components/ShareButton.tsx`): a round share mark on the night page's photograph (bottom right), on the photos of the past feed and on the flow's cards. The message is short enough for WhatsApp — the act (the tour name dropped), the day · hour · place, `coming?` and the link on its own line, so the preview card sits under it; only the message is passed (the link given separately as well appeared twice).

**Spark ideas, not built yet** (noted 06.10.2026). Each could become a spark like the three above (name, text, photo, default hour, three languages), and **each could get its own short video** for its card and page — a few seconds that show the idea instead of telling it. the owner's own: **football** and **basketball** (a pickup game), and **the new place on your street** (a restaurant that just opened: try it together). Then 25 more:

| | Spark | The idea |
|---|---|---|
| | **After the night** | |
| 1 | kebab run | 3 am out of the club, everyone walks to the nearest place still open |
| 2 | meet the sunrise | when the night ends, up a hill or onto a bridge to watch the sun come up |
| 3 | breakfast club | a breakfast table at 7 on Sunday for whoever comes out of the after |
| 4 | night bus to the end | one night line to its last stop, and see what is there |
| | **Music** | |
| 5 | record hunt | a flea market or record shops on Sunday; everyone picks one 10 € record, then they are played in turn at someone's place |
| 6 | headphone walk | everyone starts the same playlist at the same moment and walks the city in silence |
| 7 | living-room gig | a friend plays acoustic in someone's living room; a hat goes round |
| 8 | follow the DJ | the three places a DJ plays that week, all in one night, together |
| 9 | karaoke duel | two teams; each picks the other's songs |
| | **Finding the city** | |
| 10 | coin-flip walk | a coin at every corner: heads right, tails left; after an hour, a drink wherever you are |
| 11 | last stop | the end of a line nobody has taken, and whatever there is to do there |
| 12 | rooftop hunt | the public roofs and terrace bars of the city in one evening |
| 13 | night swim | a lake or the river on a summer night (in Munich: the Eisbach, the Isar) |
| 14 | lantern walk | a dark park, lights in hand, like a lantern procession |
| | **Food and the table** | |
| 15 | one country each | everyone brings a dish from a country drawn by lot |
| 16 | market closing | cook that evening with what the market had left when it closed |
| 17 | blind tasting | wines or beers with the labels covered; whoever finds the cheapest wins |
| 18 | the whole menu | a small place, every dish on the menu ordered and shared |
| | **Games** | |
| 19 | pub quiz team | a team of four for a bar's quiz night |
| 20 | bowling or pool | a midnight tournament; the loser buys the next round |
| 21 | park table tennis | the concrete tables in the park, first to 21 |
| 22 | chess café | quick games on a clock, everyone against everyone |
| | **Odd, and remembered** | |
| 23 | disposable camera night | a 27-shot camera each; the films are opened together a week later |
| 24 | someone else's festival | a neighbourhood festival of a culture none of you knows |
| 25 | one-word plan | the host writes only a word and an hour ("lake, 18:00"); the rest is decided there |

First picks (built since 07.10.2026: 2, 3, 12, 13, 19, 23, 24 and the new place on your street; see Sparks above): meet the sunrise, kebab run, record hunt, coin-flip walk, disposable camera night — the closest to what afterhours is about, and the easiest to show in a short video.

**The DJ tab, a vision** (07.10.2026, not built; the tab stays as it is for launch). Every other tab answers one question about a night in the same language — the flow *what* (a deck), the map *where*, yours *with whom*, account *mine* (a record sleeve, cards). The DJ tab speaks another app's language (stories, a clip rack, a search field) and leads to no night. Its own question would be *who is playing, and what do you hear*: a DJ's profile as the same record sleeve; following as keeping (a deck of DJs, swiped right, the same `KEPT`); their sets marked in the flow and on the map; the DJ who played a night you checked in to written on the back of that card; the app's background music coming from a DJ ("now playing: …"), with this tab as its source and remote; stories that live for one night only, like a room. Keep: sound and genre first, "playing now", the clips. Change: stories to the night's rule, the clip rack to a record rack, the profile to a sleeve. Drop: the separate search and genre tabs (done: one pill).

**Without internet** (`lib/offline.ts`). Every read that succeeds is written to the phone (kv-store, per account, per shelf: the deck per city/kind, kept, friends, cards, rooms, beforehours, the map around a spot, djs, cities, profile, settings, friends' photographs, and every night the app has seen so its page opens offline). Offline, the last saved copy is shown; a deck from the shelf drops the cards swiped on this phone meanwhile. **Since 06.10.2026 the saved copy comes first**: a read with a saved copy shows it at once and fetches a fresh one behind it; when that differs, the screens listening to that shelf (`useShelf`, `useRefreshOnFocus(…shelves)`) read again. Only a read with nothing saved waits. Lists that rarely change (cities, DJs, the places' photos, forecasts, fixtures) are not even asked again within their freshness window. Shelves live in memory and reach the phone's storage in one write a moment later. **Every write goes through one outbox** (`send()`, handlers registered by the data modules and all loaded at start by `data/jobs.ts`): keep / let go / undo, settings, check-in, comments, room lines, friend requests / accepts / removals, who's coming, DJ follows, spark answers and call-offs, the longer text and the links. Online with an empty outbox a write goes straight out; otherwise it waits in order and goes when the connection returns, retried at 2 s, 4 s … up to a minute while the server cannot be reached. Each job carries an id made on the phone and the time it was made: `37_offline.sql` stores a comment or room line sent twice once, and a check-in keeps the moment the button was pressed (at most 12 hours back). Screens show waiting work at once (a waiting card numbered ····, comments and lines marked "goes out when online"). A job the server refuses is dropped and the screens read again, which undoes what they showed. Starting a spark is the one write that still needs the connection (it sends invites and needs the id back). The bar at the top says offline · N waiting (tap it for what waits, by kind), "back online · sending…", and for five seconds "N could not be sent" after a refusal. **Warm-up** (`data/warm.ts`): when the app opens with an account, and when the connection returns, the pages people open most are read in the background — profile, cards, kept nights, friends and theirs, who is out, sparks, DJ follows, and every tab's first screen (the flow's deck, yours' gallery sample, the feed, the waves, the DJs); their pictures go to the disk cache. **The place picker's city photos** (`data/cityPhotos.ts`: each city's Wikipedia lead image, credited) are fetched at warm-up too, the country you are in first, and kept in the documents folder (the cache folder could be emptied by the system); the picker reads them from the disk the moment it opens (`cityPhotosNow`) and keeps the decoded pictures in memory, so since 12.10.2026 the cards no longer load from the start every time. **Pictures** are drawn with `expo-image` (disk cache, so they show at once and offline; it needs a new build for the stores). Yours keeps its last state in memory and holds the gallery's place while it loads, so nothing below it jumps. Tabs refresh themselves when the connection comes back. Two fixes that came with it: the session is no longer dropped when the token expires while offline (supabase could not refresh and returned no session — the app looked signed out), and signing out removes that account's saved copies.

**The tab bar sits 22 px higher on Android** (`LIFT` in `components/TabBar.tsx`, counted into `TAB_BAR_SPACE`): the system navigation bar is hidden, so the inset is 0 and taps near the bottom edge were swiping the system bar back instead of reaching the icons. The strip under the icons stays empty ink.

**Pressing the open tab again** takes it back to its start (`hooks/useTabReset.ts`, fired by `TabItem`): djs and yours scroll to the top and close what is open, account closes the card and rewinds its strip, the map drops the picked night and refits to 3 km around you tonight, the deck closes its pickers and is dealt again.

**Where you are.** `data/here.ts` is the one current city the whole app reads (the deck, the map, onboarding). The tabs shell asks for the position when the app opens and again when it comes back after half an hour; the city is worked out from the NIGHTS nearest to you (`nights_near`, 60 km, the majority city of the closest 30), not from the place name — a phone set to english says "Munich" and the list says "münchen". Only when there are no nights around does it fall back to matching the name. A city you pick by hand holds until you actually move to another city.

**Under `app/src/`:** `data/` (the RPC calls: `deck.ts`, `checkin.ts`,
`friends.ts`, `when.ts` — the time windows and the two date formatters),
`content/` (the sample djs, friends, music, taglines, and `cardsgen.js`),
`components/` (`Deck`, `NightCard`, `Onboarding`, `TabBar`, `MapWeb`),
`auth/AuthContext.tsx` (Supabase auth, guest sessions, the reset mail →
`reset/` on the site), `theme/tokens.ts` (ink, paper, blue, Inter Tight).
`app/store/listing.md` is the Play Console text; `app/CREDITS.md` the
music attribution; `app/tools/phone.sh` mirrors a USB phone with scrcpy.

**Building and shipping** (`app/eas.json`): `npx eas-cli build
--profile development` (a dev client, APK), `--profile preview` (APK to
hand around), `--profile production` (app bundle, auto-incrementing);
`npx eas-cli submit` goes to the Play internal track. Nothing native is
edited by hand: `ios/` and `android/` are generated.

**The app and the site.** Both directions are wired:

- *App → site.* `share` on a night page hands out that night's web address
  (`explore/event/index.html?slug=…`). The app opens the site for the
  poster SVGs (`SITE` in `data/deck.ts`), the password reset (`reset/`),
  the privacy page (`datenschutz/`) and "afterhours on the web" in
  settings → about; the Play listing names `settings/` as the
  account-deletion page. The night page reads **beforehours** from
  `comments_public` (`data/comments.ts`); writing still happens on the web
  ("say something on the web").
- *Site → app.* Every night page has **open in the app**
  (`afterhours://night/<slug>` — the route `night/[slug]` answers it) with
  "get the app" under it; the landing's footer screen, the three closed
  pages, the phone preview and the night page carry the **store badges** (`.stores`: google play → the Play listing; the app store box sits dimmed until `AH_CONFIG.app.ios` is set)
  (`AH_CONFIG.app` in `config.js` holds the addresses). `app.json`
  declares an Android intent filter for
  `https://kurtkurtkurt-del.github.io/afterhours/explore/event`, and
  `app/src/app/+native-intent.ts` turns that address into `/night/<slug>`
  when the app receives it. **App Links, half done (06.10.2026):** `.well-known/assetlinks.json` is
  written, with the SHA-256 of the EAS signing key (read off the preview
  APK with `apksigner verify --print-certs`). But Android looks for it at
  the root of the HOST — `https://kurtkurtkurt-del.github.io/.well-known/assetlinks.json` —
  and this repository is served under `/afterhours/`, so here it is only
  the copy to hand on. The root answers 404 today. Two ways to finish:
  a repository named `kurtkurtkurt-del.github.io` (a GitHub user site,
  served at the root) — its whole content is ready in `user-site/`, with
  the steps in `user-site/README.md` — or
  a custom domain for the site (then the intent filter's host changes
  too). When the app goes to Play with Play App Signing, the Play key's
  SHA-256 (Play Console → App integrity) joins the list in the file. The
  iOS entry in `AH_CONFIG.app` waits for the App Store.

### iOS: what stands between the app and the App Store (06.10.2026)

The code runs on iOS as it is (`app.afterhours.ios`; location and photo
texts set; `ITSAppUsesNonExemptEncryption: false` so every upload skips
the export question). What is missing is outside the code:

1. **An Apple Developer account** (99 USD a year); then
   `npx eas-cli@latest build -p ios --profile preview` makes the signing
   certificate and the push key (APNs) by itself.
2. **Sign in with Apple** (App Review rule 4.8) — written (`auth/apple.ts`,
   the button under Google on `signup`, iPhone only; `usesAppleSignIn`
   in `app.json`). Apple's sheet gives an identity token with a hashed
   nonce, Supabase's `signInWithIdToken` makes the session; the name,
   which Apple sends only once, goes into the user's metadata. Left for
   the dashboard: **Supabase → Authentication → Providers → Apple** on,
   with the bundle id `app.afterhours.ios` as the client id.
3. **TestFlight, then the listing**: screenshots at 6.9", the privacy
   answers (location, photos, account), the support and privacy URLs
   (`help/`, `privacy/` exist).
4. App Links on iOS (universal links) need
   `.well-known/apple-app-site-association` at the same host root as the
   Android file — the same `kurtkurtkurt-del.github.io` problem.

### One vocabulary

Decided on 25.09.2026, and the app's wording wins where the two disagree:

- a **night**, never an event; kinds lowercase (rave, club night, konzert,
  festival, meetup, hausparty); the filter reads **all nights**
- **keep / let go**; the kept list is **yours**
- **who's coming?** → i'm in · maybe · not tonight
- **where · when · kind**, with **ticket / szene** after the kind; the
  button is the one word **ticket**
- the date is **thu 26.09 · 20:00** (the card keeps `26.09.26`)
- the time filter is **tonight · tomorrow · this weekend · this week ·
  this month · any night**
- settings: who sees what you kept · findable by handle · email me ·
  download my data · delete account (the web asks you to type your handle,
  the app asks twice)
- the tagline is **find your night. one card at a time.**; UI text is
  lowercase English on both; the voice note is marked **soon** until it
  exists; the wording above is the ENGLISH of three languages
  (see *Three languages*), and the language setting is live on both
- the palettes stay different (see *The spirit*); the type is Inter Tight
  on both, so the card renders identically

### The PWA: the app in a browser (09.10.2026)

The same `app/` builds for the web, for trying it on an iPhone without the
App Store: <https://kurtkurtkurt-del.github.io/afterhours-pwa/> (Safari →
Share → Add to Home Screen; it then opens full screen, with its own sign-in,
separate from Safari's).

- the phone app is untouched: every web difference is in `app/src/web/`
  (stand-ins that `app/metro.config.js` swaps in for the web build only),
  `Platform.OS === 'web'` branches (Supabase session in localStorage and
  read back from the URL, Google sign-in as a full-page redirect, accent
  reload) or `app/public/` (the page, manifest and icons)
- `react-native-webview` becomes an iframe with the same bridge, so the map
  and the film work; `Alert.alert` becomes `confirm` / `alert`
- not in the browser: push, vibration, Sign in with Apple (until Supabase has
  the web Apple setup), background sound before the first tap; iOS may clear
  the stored data of a PWA left unopened for weeks
- publish: `cd app && tools/publish-pwa.sh` (export with the base URL,
  `404.html` for deep links, force-push to `afterhours-pwa` on `main`).
  Supabase → Authentication → URL Configuration → Redirect URLs needs
  `https://kurtkurtkurt-del.github.io/afterhours-pwa/**`

---

## 7. The afterhours card

`cards.js` builds an SVG card out of a night's data. Three places on the
site use it — the strip on the landing page, `cards/`, the past editions
on a night page — and the app draws the same SVG through
`app/src/content/cardsgen.js` (identical apart from the font names; the
app renders it with `SvgXml`). Both are set in Inter Tight; the voice note
line reads `VOICE NOTE · SOON` until recording exists.

```js
CARDS.front(night, "unique-id")   // the front
CARDS.back(night, "unique-id")    // the back: that night's timeline
```

The `night` object: `city t ty v d metal motif in out dur crew more aud
msg who froze no at1 at2 q1 q2`. See `cards/card-data.js` for an example.

- **Metals:** steel, gold, chrome, copper, gunmetal, brass, rose, titanium,
  nickel, anthracite
- **Motifs:** rays, oval, diagonal, orbit, grid, moon, moire, bands, iso,
  descend

---

**Account types and the panel** (07.10.2026, `41_account_types.sql`, `42_staff.sql`, `data/staff.ts`, `app/panel/*`, `app/panel/index.tsx`). Every profile has a type: **normal user**, **dj**, **community manager**, **admin**. (Groups, since 12.10.2026: a group is for good — the `just once` kind and its dates left the form and the wizard, whose last step asks only where; groups made once before keep their dates.) In settings → account a user switches between normal user and dj with a code that is the name itself (`normal user`, `dj`). **Community manager** is given by an admin in the panel; **admin** is `profiles.is_admin`, appointed in the SQL editor as before — the code cannot reach either (42 sent anyone who had typed their way there under 41 back to normal user). Admins and community managers open the **panel** from the panel mark beside the gear on the account page (11.10.2026; until then it was a sixth tab, and the bar is back to five): numbers, new night / new room / new dj, the nights made here (edit, hide, delete), and the newest comments (hide / show). The admin also sees **people and roles** (search, give a type), **feedback** (mark done) and **the log** (`staff_log`: who made, changed or deleted what). A dj gets **my dj page** in settings: one page on the djs tab of their own, and the nights they play. Every write goes through a function in `42_staff.sql` with its own check; nights made here carry `source = staff`, so the ticketmaster sync and the seed cleanup never touch them. A community manager deletes only their own nights, the admin any. 49 tests in `backend/test/staff.test.mjs`.

**The + on the flow** (07.10.2026, `43_event_submit.sql`, `app/panel/night.tsx`, `app/panel/pending.tsx`). Beside the centred `tickets · spark` switch, a + offers **with a ticket** or **among friends**. Among friends lists the eleven sparks and opens the chosen one's page, where title, time, place and wave are suggested and can be changed. With a ticket opens the night form: the staff publish at once; anyone else with an account (not a guest) sends it in (`event_submit`, a ticket link required, at most five waiting) and sees it under *what you sent in* as waiting, live, or not taken with the reason. The staff find it in the panel under **sent in** (also counted on the first page): let it through, edit it first, or turn it down with a line the sender sees. 22 tests in `backend/test/event-submit.test.mjs`.

**Groups** (07.10.2026, `44_groups.sql`, `data/groups.ts`, `app/groups/*`). Friends who find a night together, 2 to 12. Made from yours → groups: a name, an emoji, a colour, a cover photo (into your own folder of the photos bucket), lasting or just once (once has a last day and is archived after it), and the deck it swipes: a city (or everywhere) and a window of days. Friends are added directly; anyone else joins with a code (8 letters, 14 days, 20 uses) shown large, as a QR, and as a link (`g/?c=CODE` on the site, which opens `afterhours://groups/join?code=…`; the Android App Link needs the next build). A group page has three tabs: **swipe** (the group's deck, each in their own time; faces on a card are members who already said yes; your yes that completes everyone's stamps *everyone is in*), **matches** (match: all, most: more than half, some) and **live** (the same card for everyone there now, polled every 2.5 s, a heartbeat every 5 s, gone after 40 s; it moves on when all who are there have answered, or someone skips it for everyone). The deck is ordered by the group's taste: nights a member kept alone first, then the kinds the members keep most. Group answers never touch the personal deck. Yours also suggests a group when friends kept the same nights lately (`group_suggest`). 40 tests in `backend/test/groups.test.mjs`.

**Travel groups** (12.10.2026, `61_travel.sql`, design A in `prototypes/travel.html`, `components/Passport.tsx`, `components/DayPicker.tsx`). A new group is for **friends** or for **travel** (the first step of the wizard asks). A travel group has a **route** instead of a city: legs, one per city with its first and last day, in order of travel (`group_legs_set` writes the whole route, any member; `group_legs` reads it with counts). Its deck is the nights of each leg on its days, all legs together (`group_window`), so swipe, matches, the plan and live work as in any group; the group window follows the route. The page opens on the **passport**: one paper page per leg, swiped sideways — `PAGE n / N` and the country, the city large with the red dot, its days, a blue stamp (*arrived 03.11* · *in 12 days* · *been there*), the nights the group kept there with *x of y in* (`group_leg_nights`, past ones too: a trip is a memory), the travellers (a tap adds friends), and a red *photos · n* stamp (`group_leg_photos` counts them; it opens the memories). The city photo of the place picker lies under the page like a watermark. The route is edited in the wizard or the edit page: a leg card per city (city sheet, arrive and leave on a month calendar, `DayPicker`), a new leg starts the day the one before ends. 27 tests in `backend/test/travel.test.mjs`.

**A group decides** (07.10.2026, `46_group_plans.sql`, the **plan** tab of `app/groups/[id].tsx`, `app/groups/chat.tsx`). In matches, a tap opens the night or makes it the plan; *put to a vote* picks two or three and a length (1, 3, 12, 24 h). One vote each, changeable; it closes when the time is up or everyone voted, the most votes win (tie: more group yeses, then earlier) and the winner becomes the plan. The plan tab shows the open vote (bars, who voted what, *close it now* for whoever started it) and the plan: in · maybe · out (the same answers as yours, `rsvp_set`), *i have my ticket*, who still needs one, the ticket link, *drop the plan*. The group chat (the chat mark on the group page) is read every 3 s; plans, votes and results appear in it as small lines. 26 tests in `backend/test/group-plans.test.mjs`.

**After the night** (07.10.2026, `47_group_nights.sql`, `app/groups/memories.tsx`, `app/groups/album.tsx`). Tapping the group's name opens *our nights*: the vibe (the two kinds the group says yes to most, the hour its nights start — averaged from 18:00 so 23:00 and 01:00 make midnight — and its room), the numbers (nights this year, nights together, matches, votes, photos, who comes most) and the shelf: every night two or more members checked in to, with their card numbers and *all of us* when everyone was there. Nothing to press: the usual check-in is enough. Each of those nights, and the plan, has an album members add photos to (their own folder of the photos bucket; whoever added it or the owner takes it out). The owner can make the group visible; then a group with the same plan and a friend of yours in it shows on your plan as *… is going too*, with the friends. 22 tests in `backend/test/group-nights.test.mjs`.

**Posts** (07.10.2026, `45_posts.sql`, `data/posts.ts`, `app/post/new.tsx`, `components/PostCard.tsx`). The + at the top of yours makes a post: a photo, up to 500 characters, and if you like one of the nights you kept. You and your confirmed friends see it in yours under *from your people*, above the past feed. ··· deletes your own or reports someone else's (with an optional reason); the staff see reports in the panel under **reported posts** and hide or keep. At most 20 a day; guests make an account first. 20 tests in `backend/test/posts.test.mjs`.

**The chosen designs** (07.10.2026, `prototypes/new-pages-designs.html`, picks 1D 2A 3B 4B 5E 6D 7D 8C 9B 10D 11E 12B 13A 14E 15B 16C 17C). Tips are a full-screen demo with the title in the logo letters (`components/Tips.tsx`); **one tip per page** since 12.10.2026 (two pages were too many; the second's gist moved into the first's line, `got it` closes it). A post is camera first (`app/post/new.tsx`). Groups sit on a shelf as record sleeves; a new group is made in three steps (look, who, where and when); the group deck is a full photo with the score huge on top (`components/SwipeStack.tsx`, shared with the panel queues); matches are three shelves (everyone, most, some); the plan is the group's own flyer; live gives every card 15 seconds and passes for whoever has not answered; the chat has bubbles; joining and inviting show the invitation with the faces (`components/GroupInvitation.tsx`); our nights is a photo wall (`group_wall`, 49). The + on the flow opens `app/make.tsx`: two photo cards, then the spark kinds. A night is made on a poster, with a photo from the phone. The panel queues are piles: right lets through, left turns down, down edits. The account type code is typed at a door panel (`components/DoorCode.tsx`). People are found search first, by role (`admin_people_by`, 49).

**Blocking** (08.10.2026, `50_blocks.sql`, `data/friends.ts`, `components/People.tsx`). *block* sits under the button on someone's page and beside *remove friend* on a friend's page, asked first. Across a block, in both directions: no card, not found in search or suggestions, no friend request (it answers *not found*), no spark wave; the friendship or pending request goes, so everything for friends closes with it. They are not told. Settings → privacy → *blocked* lists them; unblocking does not bring the friendship back. 24 tests in `backend/test/blocks.test.mjs`.

**What the stores require** (08.10.2026, `51_safety.sql`, `data/safety.ts`, `components/TermsGate.tsx`, `components/ReportSheet.tsx`, `app/panel/reports.tsx`, `app/panel/errors.tsx`, `backend/functions/apple-revoke`). **The terms:** right after signing in (guests too) a full screen asks to confirm 18 or older and accept the terms and the privacy notice (links to `agb/` and `datenschutz/`), with the no-tolerance rule; nothing else works until it is accepted, *not for me* signs out. `TERMS_VERSION` in `data/safety.ts` asks everyone again when raised. **Reports:** besides posts, a long press reports a comment (or *report* under it), a room line, a group chat bubble, a group (long press on its name; *report this group* on the invitation); *report* on a person's page and *report this spark* on a spark. The staff get **reports** in the panel (count on the row): a pile, left removes (comment hidden; room or group message, spark, group deleted; profile cleared of bio, about, links and photo), right keeps; every decision goes to the log. At most 30 reports a day. **Deleting the account** now empties your folder of the photos bucket first (app and site), and an Apple account is unlinked from Apple through the `apple-revoke` Edge Function (see `backend/functions/README.md`). **Errors:** uncaught errors and screens that throw land in `client_errors` (a screen shows *something broke · try again*); the admin reads them in the panel under **app errors**, kept 30 days. The terms page now says 18+, no tolerance and in-app deletion; the privacy page says what is kept for safety and errors. 26 tests in `backend/test/safety.test.mjs`.

**Closing an account** (08.10.2026, `52_bans.sql`, `app/panel/people.tsx`, `app/panel/reports.tsx`, `components/TermsGate.tsx`). The admin taps a person in *people and roles*: change the role, or **close the account** with a reason (they see it); a *closed* chip filters them, and the same tap opens it again. In the reports pile, **down** removes the thing and closes the account behind it. Staff cannot be closed. A closed account: a trigger on every table a person writes to refuses it, its card disappears (search, suggestions, profile), its comments and posts are hidden, its upcoming sparks called off, its pending requests and reports settled; the app shows only *this account is closed*, the reason, and sign out. Opening it again leaves hidden content hidden. 22 tests in `backend/test/bans.test.mjs`.

**Trust** (08.10.2026, `53_trust.sql`, `components/NoticeSheet.tsx`, `app/panel/djs.tsx`). A dj page someone makes for themselves waits in the panel under **dj pages waiting** until the staff let it through (renaming it, or going back to normal user, takes it down again); the owner sees *your page waits for the team*. The admin gives **admin** from the same role list, and takes it away by tapping an admin; the last admin can never be taken away, from anywhere. People are told what the staff did to their things — a hidden comment or post, a removed message, spark or group, a cleared profile, a new role, a dj page let through or not — in a sheet *from the team* the next time the app opens. Settings → account changes the **email** (both inboxes confirm) and the **password**. Limits: 40 friend requests a day, 30 comments, 60 room and 120 group messages an hour, 10 groups, 10 sparks and 20 invite codes a day (the staff are exempt). Nobody joins or is added to a group across a block. 25 tests in `backend/test/trust.test.mjs`.

**Small actions as pills** (`components/PillAction.tsx`). Remove friend, cancel request, block, report, close, sign out, try again, clear: a rounded pill with a drawn glyph, quiet or red (danger), for dark pages and light cards, instead of underlined words.

**Upkeep** (08.10.2026, `54_upkeep.sql`, `.github/workflows/backup.yml`). Guest accounts unseen for 30 days are deleted every night (their comments stay, signed *someone*). When something starts waiting in the panel — a report, a reported post, a night sent in, a dj page — every admin and community manager gets a push (*the panel · 3 waiting…*), at most one an hour. The panel's admin section shows **database**: up to date, or which numbered SQL files were never pasted (`data/expectedSql.ts`, kept equal to `backend/tools/expected-sql.mjs` by the setup test). A GitHub Action backs the content up every night and keeps each copy 90 days. The *email me* switch is gone from the app and the site (nothing ever sent those emails); the site's settings list the people you blocked, with *unblock*. 11 tests in `backend/test/upkeep.test.mjs`.

**Likes and comments on posts** (09.10.2026, `55_post_social.sql`, `components/PostCard.tsx`, `components/PostBits.tsx`). A post reads like a photo app's: who and when, the photo full width, the heart and the speech mark, *n likes*, the words, the first two comments, *all n comments*, *add a comment*. Two taps on the photo like it (a heart blooms over it); the heart likes and unlikes. *n likes* opens who liked it, newest first (blocked people left out; a tap opens the person). The speech mark opens the comments: write one, a long press deletes your own (or any under your post) and reports someone else's. Whoever sees the post may like and comment; the author gets a push for each (switch: posts). Comments are reported, banned, limited (60 an hour) and noticed like everything else. 17 tests in `backend/test/post-social.test.mjs`.

**The site and the app, one account** (09.10.2026, `cards/session-state.js`, `session.js`, `explore/event.js`, `backend/README.md` "One account, app and site"). Both talk to the same Supabase project, so an account is one account. Signed in, the site's collection shows your own cards from `my_cards`, drawn as the app draws them; signed out, the three samples. Login and register offer *continue with apple* and *continue with google* (Supabase's web flow; set up once in the panel). A night's page on the site shows the night, the ticket and *open in the app* only: who is going, beforehours and where the night goes on are gone from it (they live in the app).

**One panel, app and site** (09.10.2026, `admin/admin.js`). The site's panel is rebuilt on the app's: the same gate (`my_role`: admins and community managers), the same sections (overview with what waits, nights with new / edit / delete, sent in, reports with remove / keep / close the account, reported posts, dj pages waiting, comments, make a venue or a dj; for the admin people and roles with bans, feedback, the log, app errors and the database) and the same database functions, so both do the same thing and the log shows both. The file list it checks the database against is kept equal to `backend/tools/expected-sql.mjs` by the setup test.

**The clipboard** (08.10.2026). `pbcopy` without a UTF-8 locale turns every non-ASCII letter into Mac Roman garbage on its way to the SQL editor; that is what broke the test groups' chat. `backend/sql/fix-clipboard-text.sql` (plain ASCII) repairs it in place; copy with `LANG=en_US.UTF-8 pbcopy`.

## 8. The backend

> **Live database (07.10.2026, evening):** `setup-1-structure.sql` and
> `setup-2-comments.sql` were pasted on 06.10.2026 (everything up to
> `38_profile_lists.sql`), then `cleanup-seed-events.sql` (the invented
> nights are gone; pasting setup again brings 36 of them back, so the
> cleanup has to follow it). On 07.10.2026 the owner pasted `41_account_types.sql`
> and `42_staff.sql`, then `43` to `47` in one paste, then `48_group_push.sql`
> with `seed-test-groups.sql` (six fake friends and the "(test)" groups to try
> the groups end to end; `cleanup-test-groups.sql` removes them), then
> `49_design_reads.sql`. **Not confirmed: `39_spark_kinds.sql`,
> `40_event_about.sql` and `about-munich.sql`** — without them the eight
> newer sparks cannot be started and no card shows *who is this?*. Check
> `select * from public.migrations` to be sure; `npm run health` names
> whatever is missing. The file list with every SQL file is in
> `backend/README.md`. The first admin is appointed in the SQL editor:
> `update public.profiles set is_admin = true, account_type = 'admin' where id = (select id from auth.users where email = '…');`

Postgres + Supabase. The tables: `cities`, `event_types`, `venues`,
`events`, `profiles`, `profile_settings`, `swipes`, `comments`,
`friendships`, `feedback`.

**The profile is split in two** — the public card (`profiles`: handle,
display name, one line, city, joined, last seen) and the settings only the
owner reads (`profile_settings`: who may see what you kept, whether you are
findable by name, email, language). Without the split, the read rule on
`profiles` would have opened the settings as well.

**The member list cannot be browsed.** The profile table is open directly
only to yourself, your confirmed friends, and anyone with a request pending
between you. Everything a stranger sees goes through functions that hand
back individually chosen fields: whoever knows your handle sees your card
(and that can be switched off in the settings), but cannot see how many
cards you kept, and last seen never leaves with its clock time — only as a
day, and only to a friend.

**A write may only say what the form asks.** The grants on `comments`,
`friendships`, `feedback` and `profiles` are per column: a comment arrives
as event, parent and body; a friend request as the two ends of it — born
`pending`, and only the side that received it may flip the status, so
consent cannot be skipped by inserting or self-accepting an `accepted`
row. `handled` belongs to the admin's PATCH, `created_at` to the clock,
`is_hidden` to a trigger that lets nobody but an admin move it (hiding a
comment is moderation, and moderation sticks). On the profile the direct
grant covers the four fields a person edits about themselves; joined,
last seen and onboarded move only through `seen()` and `profile_setup()`,
which are definer and set them honestly. The two owner-side functions —
`migration_done()` and `hide_past_events()` — had EXECUTE taken back from
the browser roles: the log and the cron job are not a public API.

**One door (12.10.2026, `57_doors.sql`).** "Who is asking?" and "may they see this
person?" have one answer each: `assert_member()` (signed in and not banned, else an
exception) is the first line of the group and post gates and of the big reads —
people search and suggestions, the posts feed, the past feed, the waves — so a banned
account reads nothing; `visible_to(viewer, other)` (no block either way, not banned,
a friend or discoverable) is what `card_visible` was, with the viewer named, and
`reachable()` its half without the discoverable part, which the spark waves use.
Before this the first question was asked in 33 places in its own words and the
second in four. `doors.test.mjs` holds both. **A push says a sentence and a name,
never the words** (`58_push_words.sql`): six kinds carried a member's text to the
lock screen; `push_text` now drops `text` whatever a trigger passes. **Direct
messages** (`59_dms.sql`): one thread per pair of confirmed friends, `dm_start` /
`dm_send` / `dm_thread` / `dm_list`, twenty lines a minute, a block or a ban closes
the thread, push kind `dm` with its own switch. **Travel groups** (`61_travel.sql`):
`group_legs` (a route of cities and days per group), `group_legs_set`, `group_legs`,
`group_leg_nights`, `group_leg_photos`; `group_window` unions the legs of a trip and
`group_get` carries the route. **A group cover from the shelf** (`62_group_covers.sql`):
`group_set_cover` also takes `preset/<name>` (club, crowd, friends — three photos the app
ships with, `PRESET_COVERS` in `data/groups.ts`), so a group has a face without an upload;
the wizard and the edit page show the shelf (none · the three · your own photo). **Listen to the artist** (`63_previews.sql`): `event_previews` (track, artist, preview address, link; service writes) and `previews_for(ids)`. The thirteen sentences the database
keeps, each with its SQL file and the test that proves it, are in
[backend/promises.md](backend/promises.md); the setup test refuses a row whose test
is gone.

**Which files have been run is written down.** The setup is pasted into
the Supabase editor by hand — or, since 12.10.2026, applied by `npm run migrate`
(`backend/tools/migrate.mjs`: asks `public.migrations` what is in, lists what is
missing, applies it in order with `--write`, each file its own transaction; needs
`SUPABASE_DB_URL`, the session-mode connection string) — and until then a project
could sit a file behind while everything still looked fine — a page just answers PGRST202 because the
function it wanted was never created. Every numbered file now stamps its
own name into `public.migrations` (00_migrations.sql), and
`npm run health` says how many of the thirteen are in and names the ones
that are not. Each file still runs on its own: the stamp is skipped when
the log is not there.

The signup flow: opening an account fires a trigger that creates the
profile **and** the settings row, but registration **does not count as
finished until a handle is chosen** (`onboarded_at`). The functions the
front end calls: `handle_status()`, `profile_setup()`, `profile_me()`,
`profile_card()`, `seen()`, `delete_account()`.

**A person can take their data with you.** `export_me()` hands back one
JSON object with everything tied to the caller — profile, settings, every
swipe named by its event slug, what they wrote, who they are connected to
and in which direction, and the feedback they left; since `64_export_more.sql`
also the direct messages they wrote (each with the friend it went to — the
other side's lines stay out) and their ticket answers. The settings page saves
it as a file. It is the GDPR right of access and portability, and
datenschutz now points at the button instead of asking for an email. The
function takes no argument, so there is no way to aim it at somebody else;
`export.test.mjs` checks both halves — that everything of mine is in, and
that nothing of anybody else's is.

**Deleting an account really deletes it** — the account, the profile, the
settings, the swipes and the friendships all go with it. Comments are the
one exception: the text stays and the name falls away (`someone`). Two
reasons — deleting a topic would take other people's replies with it, and
the constraint on the `comments` table refuses a row with no author. The
settings page says so before it deletes.
Since `65_account_delete.sql` the last admin cannot delete their account (the
same rule as `guard_last_admin`), and a group the person owned goes to its
longest member (as in `group_leave`) or, when they were alone in it, goes too.
`delete-account.test.mjs` puts the person in every table that names one,
deletes the account and walks every foreign key to `profiles`: no row is left
pointing at them. Lines in group chats and rooms stay, without a name, like
comments.

**The gate** (12.10.2026, `backend/tools/gate.mjs`, `npm run gate`): every check in one
command — the backend's on PGlite, the app's types, lint and unit tests, the site walk —
and then a proof, `.qa/gate-proof.json`, bound to the tree hash of the commit it checked.
The pre-push hook (`.githooks/pre-push`, installed by `npm install` in `backend/`) refuses
a push to `main` whose commit has no passing proof; a push of documents alone goes
through. Order: commit → `npm run gate` → push. "I ran the tests" is a file now.

For the setup, the tests (over 950 checks) and the local imitation of Supabase
(`tools/local-server.mjs`, PostgREST + GoTrue on top of PGlite) →
**[backend/README.md](backend/README.md)**

---

## 9. What runs on its own

**GitHub Actions** (`.github/workflows/test.yml`), on every push and pull
request. Three jobs, none of which needs a secret:

| job | what it refuses to let through |
|---|---|
| `backend` | the backend's checks (over 950), on a real Postgres (PGlite) |
| `app` | the app's types, lint and unit tests (since 12.10.2026; until then only the backend was checked here) |
| `generated` | SQL that has drifted from the files it was built from — it rebuilds and asks git whether anything moved |
| `versions` | more than one `?v=NN` across the pages, which would serve a stale script against a new stylesheet |
| `site` | a reference that leads nowhere — every href/src in every page, and page+poster+og for all 142 events |

A third workflow, `sync-events.yml`, pulls the real events: every morning
at 04:10 UTC it runs `backend/tools/sync-ticketmaster.mjs`, which asks
Ticketmaster city by city (the coverage of `16_coverage.sql`), files each
event under one of the six kinds, composes the meta line, picks a 16:9
photograph, upserts on `external_id` and **retires** the nights that have
passed (`is_published = false`, since 20.10.2026 — before that it deleted them,
and every check-in card, room, swipe and answer on them went too; `66_keep_past_nights.sql`).
A retired night stays off the deck and the map but on in the collection, the past feed
and the export; a synced night nobody ever touched is pruned after a year by
`events_prune_untouched()`, which refuses any row something still points at.

**Who is coming reaches the friends (20.10.2026, `69_rsvp_push.sql`):** an `in` answer sends the
same push a keep does — *{name} is going too*, the `match` kind and switch — to the friends who kept
that night or answered in themselves, once per answerer and night; maybe and out say nothing, and
someone whose keeps are private tells nobody. **The reporter hears the outcome (`68_report_answered.sql`):**
when the staff settle a report, everyone who reported that thing gets a notice — `report_removed` or
`report_kept` — naming the kind of thing and nobody. **A changed or cancelled night tells the people on it (`72_night_changed.sql`):** the sync now
reads Ticketmaster's `dates.status.code` into `events.status`; a cancelled night leaves the deck but stays in
collections, and whoever kept it, answered in or holds a ticket gets one push — *cancelled*, *postponed*,
*moved to thu 20:00* — in their own language, on the `notify_nights` switch. Health (`71_health_more.sql`)
now goes red when the newest synced night is older than three days, more than fifty past nights are still
published, or pushes sit unsent for six hours. **Samples are development only** (`content/samples.ts`, `SAMPLES = __DEV__`, 20.10.2026): a store
build shows no drawn friends, nights, waves, stories, djs or cards — an empty screen says what to do. **A deleted
account takes its room and group lines with it** (`73_messages_go.sql`); a comment on a night still stays as someone. **A ban stays** (`74_ban_stays.sql`): a banned account that deletes itself leaves a hash of its email
and its handle behind, so the same address is banned at birth and the handle stays taken; the room no longer
shows a banned account's lines. **A spark taken back** (`75_spark_off.sql`) tells everyone who said in. **A night sent in** (`76_sent_nights.sql`): the sender hears when it is let through or turned
down (with the note), can take a waiting one back (`event_withdraw()`, "take it back" under *panel → night*), and
a waiting night whose date passed leaves the queue by itself when the staff open it.
The deck and the counters stopped waiting for the jobs the same day (`67_deck_today.sql`):
a synced night leaves `deck()`, `event_counts()` and `city_counts()` by its own date, eight
hours after it starts, whether or not `hide_past_events` ever runs; the map had done so since 18. **Some names belong to nobody** (`77_reserved_handles.sql`): admin, afterhours…, support, staff, team and a few more read as taken for everyone but the staff — on every keystroke, at sign-up, in profile setup. **The oldest app that still works** (`78_min_version.sql`): an admin sets the floor with `set_min_app_version`; a build below it opens to a single door to the download page (`UpdateGate`) instead of failing call by call. **Words the staff want to see** (`79_word_watch.sql`): a short three-language list; a line, a name or a bio that holds one is written as usual and lands in the open reports with `filter: <word>` — watched, never refused; `watch_add`/`watch_drop` for the admin. **What a guest kept comes along** (`80_guest_merge.sql`): a guest who meets an existing email signs in and `guest_merge` carries the swipes over, then the guest user goes. **Posts are off** (`81_posts_off.sql`, `content/flags.ts` `POSTS_ON`): the yours tab, post/new and the past feed redirect, the setting is hidden and no post push leaves; the code and the tables stay for the day they return. **A file goes with its row** (`82_leftovers.sql`): a deleted or hidden post, a replaced face or cover, a group gone, an account or a pruned guest gone — the photos bucket is cleaned by triggers, never by the phone. **A DJ page after the DJ** (`83_dj_after.sql`): a page loses its check when its owner's account goes, the hourly DJ push goes only for checked pages, and the DJ's bio is on the page. **A report keeps a copy** (`84_report_snapshot.sql`): the text, the author and the time are copied into the report when it is made, so the panel still shows them after the line, the author or the reporter is gone. **A closed account may object** (`85_appeals.sql`): one objection from the closed screen, answered by the staff in the panel with open again or stays closed, told by notice. **The file on a person** (`86_person_file.sql`): one read for the staff — who closed them, what they were reported for, what they reported, their objections, the log — and a ban given by an admin is lifted by an admin only. **Is the clock running** (`87_cron_health.sql`): `cron_health()` reports pg_cron's jobs and last runs, and `npm run health` goes red when the last good run is over two hours old. **A check-in that means something** (`88_checkin_truth.sql`): the card is never refused, but friends hear "out now" only for a check-in inside the night's hours and near its door; within an hour `check_out` takes it back, pushes included. **The server's no, in your language** (`app/src/lib/serverText.ts`): the ~40 texts the SQL raises are mapped to three-language strings where they are shown; the SQL stays English. **The export, whole** (`89_export_all.sql`): `export_me` carries every table a person writes to. **Account security**: the confirmation mail can be sent again, a new password asks for the old one, deleting asks for the password, and "sign out everywhere" ends every session. **Messages that arrive** (`90_dm_seen.sql`): a line written offline waits in the outbox and leaves in order, the other phone is pinged over a realtime channel instead of polling every three seconds, and what you have read is kept by the server. **Previews for every city**: `tools/previews.mjs --all` runs after the daily sync and matches each new night to its thirty seconds on Apple. **A file remembers its own text** (`91_checksums.sql`, `npm run stamp`): every numbered file carries its sha256 in its stamp block, the log keeps it, and `npm run health` names a file edited after it was pasted; the gate refuses a stale stamp. **Crashes are seen**: `@sentry/react-native` is wired in `_layout.tsx` and sends only when `EXPO_PUBLIC_SENTRY_DSN` is set in `app/.env` (organization and project in `app.json`; `SENTRY_AUTH_TOKEN` at build time for source maps). **The hour a night starts, in its own city** (`92_timezones.sql`): cities and synced nights carry their zone, the sync writes the local hour with it, and the rows already there were moved once. **What the staff have left waiting** (`93_staff_backlog.sql`): `npm run health` goes red when a report has waited twenty hours, so the morning workflow mails. **Polish (20.10.2026)**: the intro film is 43 s with shorter lines in each language; pills shrink long German words instead of cutting them; the map says when it is offline or empty; the crash screen speaks three languages and reports to Sentry; settings link to help and feedback; invite, night and profile links show a preview card. **Delete from the web** (`delete/`): any account, also one made with Apple or Google, can be deleted with only its email — the recovery link signs the person in on that page, the word confirms; this is the deletion address for the stores. Site settings now change the email, link to the password change and sign out everywhere. Supabase → Auth → URL configuration must list `…/afterhours/login/` and `…/afterhours/delete/`. **What is kept, and for how long** (`94_retention.sql`): a nightly prune holds the database to the privacy notice — pushes 30 days (stuck ones 7), notices 90 days, settled reports and objections a year; the notice now lists every kind of data the app stores and each period. Three house rules hold, on the way in and swept over what is
already there: nothing before 18:00 (festivals and raves exempt — real
ones start in the afternoon), no add-on listings ("VIP Ticket",
"Box-Seat", "Parking permit" — receipts, not nights), and a show that
repeats is ONE package — the soonest night stands for the run and its
meta line carries the span ("Venue · 20.11.26 → 23.12.26 · 20:00"). Since
06.10.2026 it also files the **room**: each venue becomes a row in
`venues` (one per city and name-slug) and the night gets its `venue_id`
— before that every synced night counted as "no venue" in health and
the after on the night page had only titles to show. The first run after
that fills the 3822 already there. It needs the two secrets named inside it; run it by hand from the
Actions tab any time. `--dry` locally shows what it would write.

The site itself has no build step and nothing to check: it is plain HTML
the browser reads as it is. What can break in silence is the database and
the generated SQL, so that is what is watched.

`backup.yml` has a second job since 12.10.2026: a `pg_dump` of the public schema's
data — profiles, friendships, cards, groups, messages — encrypted with `gpg` and kept 30
days, once the two secrets `SUPABASE_DB_URL` and `BACKUP_PASSPHRASE` are set; without
them the job says so and ends green. The content backup above stays as it was.

A second workflow, `health.yml`, asks the live database how it is every
morning at 06:20 UTC — after the 05:30 job that drops past events, so what
it reports is the settled state. It needs no secret: the key in
`config.js` is the public one. `npm run health` exits non-zero when the
content is gone, when a SQL file has not been run, or when past events are
still on the deck, and a failed run is what sends the email.

`backend/package-lock.json` is committed — CI installs with `npm ci`, and
a lockfile is the only thing that makes that reproducible.

---

## 10. Publishing and caching

GitHub Pages, from `main`. `.nojekyll` is there (for the paths with an
underscore).

**Sharing and search.** Every page carries `description` + `og:*` tags; on
an event page the title, the description and the image come from the night
itself. `robots.txt` and `sitemap.xml` are at the root (`admin/` is
excluded). The preview images are regenerated with
`python3 tools-previews.py`.

**The version-number rule:** the `?v=NN` on every asset in every HTML file.
When CSS or a script changes, all of them go up together, otherwise the
browser keeps using the old file:

```bash
find . -name "*.html" -not -path "./.git/*" -not -path "./backend/*" -not -path "./app/*" | xargs perl -pi -e 's/\?v=135/?v=135/g'
```

The current version: **195**.

The explore date filter is real (every synced night carries a true
date): tonight / tomorrow / this weekend / this week / this month /
any night, cut client-side out of a date-ordered pull. Since v174 explore
is **the wall**, not the deck: the swiping moved into the app, and the web
shows every night that fits the filter as a grid of posters (`wall.js`).
The wall opens on the home city (`AH_CONFIG.city`) and any night — the
whole world for tonight is four hundred posters of somewhere else. And one type
rule: the small labels are Inter Tight like everything else — JetBrains
Mono lives on only inside the drawn poster and card artwork.

---

## 11. From nothing, step by step

The order matters: each step closes the road the one before it opened.

**Done**

- [x] The landing page, five screens (seven since 25.09.2026)
- [x] The deck: dragging, filters, three sources, the kept ones — since 25.09.2026 in the app; the web shows the wall
- [x] The beforehours comments (reading + writing)
- [x] Session, handle, friendship, what you kept
- [x] Backend: schema, RLS, seed, tests, the local imitation
- [x] The admin panel
- [x] The footer + the legal pages (placeholder)
- [x] The account page shortcuts
- [x] **The event page system** — 36 nights, one layout
- [x] **The profile structure** — card + settings, the signup step, the privacy rules, 57 tests
- [x] **The settings page** — `settings/`, working together with its backend
- [x] **Feedback** — `feedback/` + the `feedback` table, 16 tests
- [x] **Registration** — `register/`, two steps, unfinished until a handle is chosen
- [x] **Sharing and search** — meta/og tags, a preview image per night, robots, sitemap
- [x] **404, `maps/` in the menu, an accessibility pass, errors in human language**
- [x] **The feedback inbox** — in the admin panel
- [x] **The code translated into English** — classes, ids, filenames, the `AH` API, the data fields, the comments, the docs (§13)
- [x] **CI, a migration log, and a repeatable setup** — §9, and `npm run health` says which SQL is live
- [x] **A backup that is provably restorable** — `npm run restore`, checked field for field by `backup.test.mjs`
- [x] **Take your data with you** — `export_me()` and a button on the settings page (GDPR Art. 15 and 20)
- [x] **The whole audit closed** — 29 findings in three passes: consent, moderation, grants, session, and the rest (§8, §12)
- [x] **Every surface** — the width bands in §3, measured at five widths
- [x] **Fonts served from here** — `fonts/`, no request leaves for Google; datenschutz says so
- [x] **All 142 nights have pages** — world shells, og previews, sitemap; a missing slug is fetched live in `event.js`
- [x] **The landing page derives itself** — globe nights and the near list come from `POSTERS` (colour and minutes stay hand-picked per slug)
- [x] **Two help numbers are real** — `health()` counts swipes and friendships, `help.js` writes them in
- [x] **A new password** — `reset/`, request + set, and the forgot link under sign-in
- [x] **Replies, a deck count, and two ways out of an empty deck** — beforehours answers, "03 / 36", deal-again / try-another-city
- [x] **The site checks itself** — `tools-site-check.py` walks every reference; the CI `site` job runs it
- [x] **Real events** — the Ticketmaster sync (§4, §9): the worldwide deck, the everywhere filter, photographs and real ticket pages; the invented nights retire via `cleanup-seed-events.sql`
| `backend/sql/rename-test-users.sql` | One-shot for the live database: every account except `owner1` and `owner2` becomes `testuser1…n` in the order they were opened (handle and display name; sign-in is email and password and does not change) — paste into the Supabase SQL editor |
- [x] **Installable** — `manifest.webmanifest`, and the poster wall lazy-loads below the fold
- [x] **The app** — `app/`: deck, night pages, map, yours, djs, check-in, the room, the collection, guest mode, background music; first closed test on Play
- [x] **The web follows the app** — the wall instead of the deck, `friends/` `maps/` `djs/` closed, one vocabulary (§6), the landing's room and djs screens, the app in this repository
- [x] **App and site linked** — share → web page, open in the app → `afterhours://night/<slug>`, get the app → Play, beforehours read in the app (§6)

**Next (a suggested order)**

1. **Widening the event data.** Today there are five fields
   (`slug kind title meta body`). Everything on the event page — the
   line-up, the times, the capacity, the price, the rules — is currently
   invented from a pool. To make it real, fields have to be added to the
   `events` table. Once that is done the `event-data.js` pools become only
   a **fallback**.
2. **The card collection.** The heart of the concept and the most expensive
   part: past-night data, deciding what "that night's sound and talk" even
   means, and generating the cards.
3. **Filling in the legal pages** — the square brackets and a real Stand
   date.
4. **The after, wired to the listings** — the rooms come out of our own
   nights (same city, same night, a later start) instead of the
   placeholder pool.
5. **The third help number** — impossible before the card collection
   exists; the first two are live now.
6. **`assetlinks.json`** — so that a night's web address opens the app
   without asking (§6, "The app and the site"); and writing beforehours
   from the app.

---

## 12. Known traps

Every one of these cost us something:

- **A sticky grid item is clamped to the grid CONTAINER, not to its own
  row.** The card band began life as a fourth child of `.cs` spanning all
  three columns, and the sticky poster and the sticky right column slid
  straight down over the top of it — measured at 1111→1698 against a band
  that started at 1243. The band is a sibling of the contact sheet now,
  which also spared it the negative margins it needed to reach the edges.
- **Bare class names collide across pages.** The explore card was given
  `photo`, which the landing page's portrait block already owns and which
  is handed `width: min(780px, 46vw)` further down the same file. An empty
  card in a 317px deck measured 780px wide and every theory about grid
  containing blocks and `aspect-ratio` was wrong — the class list was the
  thing that needed reading. Explore classes keep the `ex-` prefix.
- **`filter` does not work on an SVG inside `<object>`** (it is a separate
  document). Anything that needs an SVG poster pulled to grey has to lay a
  `mix-blend-mode: saturation` layer over it instead.
- **An SVG inside `<img>` cannot load a webfont.** That is why the posters
  come through `<object>`; and `<object>` in turn wants
  `pointer-events: none`.
- **`[hidden]` loses to `display`.** That is why `style.css` has
  `[hidden] { display: none !important }`.
- **`lang="tr"` + `text-transform: uppercase`** turns i into İ in Turkish
  ("CLUB NİGHT"). The pages are `lang="en"`, the legal pages `lang="de"`.
- **`overflow-x: clip` on `body` alone does not clip** — it also needs
  `html:has(body.explore)`.
- **A flex/grid item without `min-width: 0`** lets a long paragraph push
  the page sideways.
- **Google Fonts** used to send the IP to Google with every page and
  every poster. The fonts live in `fonts/` now (woff2 + one CSS), the
  posters `@import` it relatively, and datenschutz says so. 404.html is
  the one page with NO webfont: it renders at any depth, so no relative
  href can be trusted there.
- **Adding a second `id` to a `<main>` breaks the page silently.** While
  adding `id="content"` for the skip link, two `<main>` elements already
  had their own `id`; the browser keeps the first, `getElementById` no
  longer finds the old one, and the admin panel would not open. In a bulk
  edit, look at the existing attribute first.
- **A test tied to the calendar breaks by itself.** `jobs.test.mjs` ran on
  the real dates in the seed; once 29.08.26 went past, the number it
  measured shifted. A test should measure the rule, not the day: the setup
  block now pushes every event into the future first.
- **The preview panel** does not repaint scrolled content; a screenshot
  needs a fresh load. For measuring, `getBoundingClientRect` is more
  reliable than the panel.
- **A bulk rename quietly breaks the tools nobody runs daily.** The English
  pass left `world-sql.mjs` reading a file that no longer existed,
  `build-seed.mjs` reading field names that had moved, `backup.mjs` writing
  into a folder that did not exist, two `<label for=…>` pointing at ids
  that had been renamed, and ten `"hata"` status classes the stylesheet no
  longer knew. None of it showed in the browser. After a rename, run every
  tool once and check every cross-file reference.
- **A rename that treats an object key and a property read differently
  breaks the page in silence.** A word-boundary regex that excludes a
  leading dot renames `east:` in an object literal but leaves `b.dogu`
  alone, so the read returns `undefined`. That is what froze the globe.
  Rename a key and every read of it in the same pass, and afterwards check
  that no property is read that no key defines.
- **Two Turkish names can translate to one English name.** `metin` (the
  textarea) and `yazi` (its trimmed text) both became `text`, producing
  `const text = text.value.trim()` — a ReferenceError on every click, and
  the feedback page could not send anything. A rename tool must refuse a
  target name that is already an identifier in that file.
- **`npm run backup` did not work at all.** The bulk rename of the `sira`
  column had also renamed PostgREST's `order=` query parameter to
  `sort_order=`, and the API answers 400 to that — so the tool failed on
  its first request. The local server had the mirror of it and ignored
  ordering entirely. A parameter that belongs to somebody else's API is not
  yours to rename.
- **`create or replace view` can add a column but never rename one.** The
  live project was built while the code was Turkish, so its `events_public`
  carried `type_sira`; today's file wanted `type_sort_order` and the paste
  stopped dead with `42P16: cannot change name of view column`. The same is
  true of a function's OUT parameters — `friends_list()` and `health()`
  came next. Both need a `drop` first, and `upgrade.test.mjs` now rebuilds
  the pre-rename database from git and pastes today's setup onto it, which
  is the only way to see this at all.
- **Pasting a setup file twice used to double every conversation.** The
  structure files were already repeatable (`on conflict do nothing`), but
  the comment seed had no guard. It now clears the previous sample set
  first, recognising it by `time_text` — the one column only the seed ever
  writes. `setup.test.mjs` runs the whole setup twice and insists nothing
  moved.
- **An apostrophe in a SQL comment breaks the Supabase editor.** Its parser
  counts quotes and counts the ones inside comments too, so a single `'`
  turns the rest of the file into code. `seed.test.mjs` enforces this.
- **`datetime-local` speaks local time; `toISOString()` speaks UTC.**
  Filling the field with `toISOString().slice(0, 16)` and reading it back
  with `new Date(value)` shifts the stored time by the UTC offset on
  every open-and-save — in Munich, two hours earlier each time, and the
  drift walked events into the cron job's "past" window. Build the field
  value from the local clock (`admin.js`, `localInputValue`).
- **A bare UPDATE slips past the read rule; a WHERE does not.** An update
  that has to READ the row (a `where id = …`, a `returning`) also obeys
  the SELECT policy, so a hidden comment cannot even be aimed at by its
  writer — but `update … set is_hidden = false` with no WHERE reads
  nothing and reaches every row the update rule allows, hidden included.
  A row an update rule exposes is only protected if a trigger or a column
  grant stands behind it; the write-a-test-first way is the only way this
  showed up at all.
- **`perl -pi -e` with `|` as the delimiter and a `?v=` pattern** is a way
  to shred a file: the escaping is nested three deep (shell, perl, regex).
  For version bumps, use the command above and read the diff afterwards.

---

### Traps of the three languages

- **`lang="tr"` + `text-transform: uppercase`** turns every `i` into `İ`.
  Right for turkish words, wrong for data (`PİTBULL`). An element that
  carries data and is uppercased by CSS needs its own `lang="en"`.
- **A script that writes into an element which also carries `data-i18n`**
  loses to the markup pass at DOMContentLoaded. Remove the attribute
  before writing (`settings.js` and `globe.js` do), or write from the
  script only.
- **Codes are not words.** `ok / taken / format`, `data-value`, the
  filter values and the feedback kinds go to the database as they are;
  only what is shown goes through `AH.t`.
- **Turkish suffixes depend on the word before them**, so a sentence
  never hangs a suffix on a `{placeholder}`: *katılım {when}*, not
  *{when}'den beri*.
- **After editing `lang/src/*.json` run `python3 tools-lang.py`** — the
  pages load the generated files, not the json.

---

## 13. The old names

**The code was translated into English on 30.08.2026.** Class names, ids,
filenames, the `AH` API, the data fields, the comments and the
documentation are all English now — a second pass on 31.08.2026 caught
the stragglers the first left behind (`egim2`, `enYakin`, `araAlan`,
`BOS_MESAJ`, the Turkish halves of mixed comments), so only `strip.html`
(parked, untouched on purpose) and the legacy `afterhours.oturum`
localStorage key (kept so old sessions still migrate) remember the old
names. This table is here for anyone reading
older commits:

| Old | Now |
|---|---|
| `ayar.js` / `oturum.js` / `veri.js` / `atislar.js` | `config.js` / `session.js` / `data.js` / `swipes.js` |
| `data-yedek` / `data-sonra` | `data-fallback` / `data-after` |
| `AH.durum` / `AH.istek` / `AH.girisliMi` | `AH.mode` / `AH.request` / `AH.signedIn` |
| `KARTLAR.on` / `KARTLAR.arka` | `CARDS.front` / `CARDS.back` |
| `deste` / `atis` / `ucur` | deck / swipe / fly the card away |
| `kirinti` / `dipnot` / `kunye` | breadcrumb / footer / colophon |
| `ray` / `kare` / `poz` | rail / frame / exposure |
| `oturum` / `girisli` / `jeton` | session / signed in / token |
| `serit` / `sehir` / `mekan` | strip / city / venue |
| `yorum` / `konu` / `cevap` | comment / thread / reply |
| `tohum` / `havuz` / `karistir` | seed / pool / shuffle |
| `sira` (SQL column) | `sort_order` |
| `yon` with `giden` / `gelen` | `direction` with `outgoing` / `incoming` |
| `hedef` (SQL variable) | `target` |
| `profiles_ad_uzunluk` / `profiles_bio_uzunluk` | `profiles_name_length` / `profiles_bio_length` |
| `feedback_yeni_idx` | `feedback_recent_idx` |
| `"posters yonetici yazar"` (policy) | `"posters admin writes"` |
| `afterhours-gecmisi-dusur` (cron job) | `afterhours-drop-past` |
| `ses/` | `sound/` |
| `backend/yedek/` | `backend/backup/` |
