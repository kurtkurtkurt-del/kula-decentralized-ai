---
name: dene
description: Ship kula as it stands on kula-main, end to end, in five steps - write the brain map, push to GitHub, build the apk (release key) and the Mac app, update the README, site and GitHub release, and update the kula app on this Mac. Use when the user types /dene.
---

# /dene — ship what is on kula-main

The user made this skill on 11.11.2026 ("bunu da /dene diye bir skill'e koy deyince direkt bu 5
adımı tekrarla"). Typing `/dene` is their go-ahead for every step below, including the push, the
release and the writes to the brain map. Do them in order, without asking again; stop and say why
only when a step fails in a way you cannot fix. Report to the user in Turkish, short.

Read `CLAUDE.md` first (release apks only through `npm run apk`; vendor/ and the llama.cpp tree are
never edited). Work on branch `kula-main` in this checkout. Never `--no-verify`, never force-push,
never delete a release or a tag, never print or move the release key or its password.

## 0. ready

- `git status`: everything that should ship is committed. Uncommitted work that is not yours:
  stop and ask. Your own unfinished edits: finish and commit them, or set them aside.
- Note the last release (`gh release list`) and what landed since (`git log <last tag>..kula-main`).

## 1. the brain map

The map is a Claude artifact with a database: https://claude.ai/artifact/XdUbnR74Y1gTzeBfcZCe7K
(deck: https://claude.ai/artifact/1xG19vLYVT9UmrH1atUxd1). Load `ArtifactData` with ToolSearch.
Collections: `dugumler` (nodes), `detaylar` (deep dives, doc id = node id), `notlar`, `ceviri` (`tr`,
`de`). Bring it in step with what landed since the last release:
- a merged feature: its node's `aciklama` starts "Built · v0" (or "Built in part"), `asama`, and
  `detaylar.insa` names the files and tests; a short note (`yazan: "claude"`).
- a decision the user stated in the chat since the last /dene: their words in `senin_kararin`
  (plus a short English gloss), `karar_zamani` now, `durum: "karar"`, a note "the person's
  decision, <date> (in the chat)". Only what they actually said; nothing invented.
- new nodes get `ceviri/tr` and `ceviri/de` entries.
Read first, pin every write with `if_version`, send one `batch` (≤ 50 writes per call). Nothing is
ever deleted. Nothing changed since the last release: skip this step and say so.

## 2. version, README, site

- Version: minor for new features, patch for fixes only. Bump `node/package.json`,
  `node/package-lock.json`, `desktop/package.json`, `desktop/package-lock.json`, `app/app.json`
  (`expo.version`); then `cd node && node tools/release-files.mjs --drafts`.
- `README.md`: a "what's new in X.Y.Z" section above the previous one, in plain words (what a
  person sees, not internals). `web/site/index.html`: the version in the comment, the kicker and the
  footer, and a "what's new" list. Check `node tools/docs-links.mjs`.
- Commit (message ends with the Co-Authored-By line the session gives).

## 3. gate and push

- `cd backend && npm run gate` on a clean tree (the pre-push hook refuses main without a passing
  proof of the exact tree). Timing tests in `node/test/godseye-eye-box.test.ts` can fail on a
  loaded machine: rerun that file alone before calling anything broken.
- `git push origin kula-main:refs/heads/main kula-main:refs/heads/kula-main`.

## 4. build (in the background, one script, log to the scratchpad)

- apk: `cd app && npm run apk` (JDK 17: `/Users/ahmetselcukkurt/Library/Java/JavaVirtualMachines/jdk-17.0.20.1+1/Contents/Home`).
  It signs with the release key `~/.kula-signing/kula-release.p12`, password from the macOS
  Keychain (`kula-release-keystore`), by itself. Check:
  `apksigner verify --print-certs` shows the certificate whose SHA-256 is the one in
  `OFFICIAL_SIGNERS` (`node/src/attest.ts`), never "Android Debug".
- the terminal binary: `cd node && node tools/pack.mjs --cache .pack-cache --out <scratchpad>/out`
  (gives `kula-node-mac-arm64`; its smoke run must print the new version).
- the Mac app: `cd desktop && rm -rf release && npm run dist:mac`; check
  `codesign --verify --deep --strict release/mac-arm64/kula.app`.

## 5. GitHub release and site

- Assets, exactly these names (the site links to them): `kula-android.apk`,
  `kula-mac-arm64.dmg`, `kula-node-mac-arm64`, `sha256sums.txt` (shasum -a 256 of the three).
- `git tag -a vX.Y.Z -m "kula vX.Y.Z" kula-main && git push origin refs/tags/vX.Y.Z`, then
  `gh release create vX.Y.Z <assets> --title "kula vX.Y.Z: <a few words>" --notes-file <notes> --latest`.
  Notes: what's new (from the README), the files, how to install, known limits (what has not
  run on a real phone). Download one asset back with `gh release download` and compare its sha256.
- The site is the `gh-pages` branch holding only `web/site` (and `.nojekyll`): rebuild it from
  the tree (`git rev-parse kula-main:web/site`, add `.nojekyll` with `git mktree`, `git commit-tree`
  with the previous gh-pages commit as parent) and push `gh-pages`. Check
  https://kurtkurtkurt-del.github.io/kula-decentralized-ai/ shows the new version once Pages built.

## 6. the kula app on this Mac

- Quit a running kula (`osascript -e 'quit app "kula"'`), replace `/Applications/kula.app` with
  `desktop/release/mac-arm64/kula.app` (`ditto`), and open it once with
  `KULA_SNAP=<scratchpad>/app.png /Applications/kula.app/Contents/MacOS/kula` for ~20 s: its log
  says "opening http://127.0.0.1:…" and the picture shows the chat page. Then quit that run and
  `open -a /Applications/kula.app` so the person finds it running.

## report

Five lines: the version, what changed on the map, the push (commit), the release link with its
files, and the app on this Mac. Then what was not checked (anything that needs a real phone).
