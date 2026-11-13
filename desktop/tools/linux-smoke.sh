#!/usr/bin/env bash
# The Linux desktop app's smoke test on a GitHub Ubuntu 24.04 runner (.github/workflows/desktop-linux.yml),
# steps 1-6 of T2 in the orkestra plan of 13.11.2026:
#   1 static: the four names, the deb's control fields, no other email, sha256sums
#   2 facts: the userns sysctl, libfuse2t64, os.freemem() against MemAvailable
#   3 the deb as shipped, first launch (setup downloads llama.cpp), the chat page checks
#   4 llama.cpp: the picked asset, sha256, --version, the rpc server on 127.0.0.1, ldd in a clean ubuntu
#   5 quit: SIGTERM, then the port is free and nothing is left
#   6 the AppImage as shipped, then APPIMAGE_EXTRACT_AND_RUN=1 and/or userns=0 only as needed
# Only xvfb is installed beforehand. The Chromium sandbox stays on: nothing here passes --no-sandbox.
# usage: linux-smoke.sh <x64|arm64> <dir with the four files and sha256sums-linux.txt>
# prints CHECK <name> PASS|FAIL <detail>, FACT ..., APPIMAGE ...; exits 1 when any CHECK failed
# (step 6's AppImage checks are printed but not counted: the AppImage is not shipped).
set -euo pipefail

ARCH="${1:?arch: x64 or arm64}"
DIR="$(cd "${2:?dir with the files}" && pwd)"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${SMOKE_OUT:-${RUNNER_TEMP:-/tmp}/smoke}"
H="${RUNNER_TEMP:-/tmp}/h"                     # KULA_NODE_HOME (node/src/paths.ts:10)
REL="$OUT/rel.json"                            # KULA_RELEASE_JSON (node/src/llama.ts:251), absolute: kula-node runs with cwd = its own folder
PORT=50590                                     # the app's default (desktop/src/main.js:17)
EMAIL='noreply@users.noreply.github.com'
MAINTAINER="kula <$EMAIL>"
mkdir -p "$OUT" "$H"

case "$ARCH" in
  x64) DEB_ARCH=amd64; UNAME=x86_64 ;;
  arm64) DEB_ARCH=arm64; UNAME=aarch64 ;;
  *) echo "unknown arch $ARCH"; exit 2 ;;
esac
TAG="$(grep -oE "export const TAG = '[^']+'" "$REPO/node/src/llama.ts" | grep -oE "b[0-9]+")"
TAGNUM="${TAG#b}"
VERSION="$(node -p "require('$REPO/desktop/package.json').version")"
DEB="$DIR/kula-linux-$ARCH.deb"
APPIMG="$DIR/kula-linux-$ARCH.AppImage"

FAILS=0
DONE=0
pass() { echo "CHECK $1 PASS ${*:2}"; }
fail() { echo "CHECK $1 FAIL ${*:2}"; FAILS=$((FAILS + 1)); }
fact() { echo "FACT $*"; }
oneline() { tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/ $//'; }

# the app's processes: the main one and its children all have comm "kula" (children carry --type=)
kula_pids() { pgrep -x kula || true; }
main_pid() {
  local p c
  for p in $(kula_pids); do
    c="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null || true)"
    case "$c" in *--type=*|'') ;; *) echo "$p"; return 0 ;; esac
  done
}
nosandbox_count() {
  local p
  for p in $(kula_pids); do tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null || true; done | grep -cx -- '--no-sandbox' || true
}
leftovers() {   # extra pgrep -f pattern as $1 (the AppImage runtime, xvfb-run)
  { kula_pids; pgrep -x llama-server || true; pgrep -x ggml-rpc-server || true; pgrep -x rpc-server || true
    if [ -n "${1:-}" ]; then pgrep -f -- "$1" || true; fi; } | sort -u | oneline
}
port_listen() { ss -ltnH "sport = :$1" | awk '{print $4}' | sort -u | oneline; }
ps_dump() { ps -eo pid,ppid,args | grep -E 'kula|llama|rpc-server|AppRun|xvfb' | grep -v grep > "$1" || true; }

stop_all() {
  local mp i
  mp="$(main_pid)"
  [ -n "$mp" ] && kill -TERM "$mp" 2>/dev/null || true
  for ((i = 0; i < 10; i++)); do [ -z "$(kula_pids | oneline)" ] && break; sleep 1; done
  pkill -KILL -x kula 2>/dev/null || true
  pkill -KILL -x llama-server 2>/dev/null || true
  pkill -KILL -x ggml-rpc-server 2>/dev/null || true
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  sleep 1
}

on_exit() {
  local rc=$?
  stop_all || true
  if [ "$DONE" != 1 ]; then echo "CHECK script-finished FAIL stopped early (exit $rc)"; exit 1; fi
  exit "$rc"
}
trap on_exit EXIT
trap 'echo "ERROR line $LINENO: $BASH_COMMAND"' ERR

# launches the app under xvfb in the background; extra NAME=value pairs after the program
start_app() {
  local log=$1 png=$2 exe=$3; shift 3
  env KULA_NODE_HOME="$H" KULA_RELEASE_JSON="$REL" KULA_NVIDIA=0 KULA_SNAP="$png" "$@" \
    xvfb-run -a "$exe" > "$log" 2>&1 &
  APP_PID=$!
}

# waits for the line main.js prints when it opens the page (desktop/src/main.js:123)
wait_open() {
  local log=$1 secs=$2 i u
  OPEN_URL=''
  for ((i = 0; i < secs; i++)); do
    u="$(grep -oE "kula: opening http://127\.0\.0\.1:$PORT/[0-9a-f]+/" "$log" 2>/dev/null | head -1 || true)"
    if [ -n "$u" ]; then OPEN_URL="${u#kula: opening }"; return 0; fi
    kill -0 "$APP_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

# the chat page checks of step 3 (also for the AppImage in step 6)
page_checks() {
  local t=$1 log=$2 png=$3 url=$4 code body listen size i n
  code="$(curl -s -o "$OUT/$t-health.txt" -w '%{http_code}' "${url}health" || true)"
  body="$(cat "$OUT/$t-health.txt" 2>/dev/null || true)"
  if [ "$code" = 200 ] && [ "$body" = '{"kula":"ui"}' ]; then pass "$t-health" "200 $body"; else fail "$t-health" "code=$code body=$body"; fi
  code="$(curl -s -o "$OUT/$t-index.html" -w '%{http_code}' "$url" || true)"
  if [ "$code" = 200 ] && grep -qF '<script type="module" src="app.js">' "$OUT/$t-index.html"; then pass "$t-page" "200 with app.js"
  else fail "$t-page" "code=$code, app.js script tag $(grep -cF '<script type="module" src="app.js">' "$OUT/$t-index.html" 2>/dev/null || echo 0)x"; fi
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
  if [ "$code" = 404 ]; then pass "$t-root-404" "404"; else fail "$t-root-404" "code=$code"; fi
  listen="$(port_listen "$PORT")"
  if [ "$listen" = "127.0.0.1:$PORT" ]; then pass "$t-listen-loopback" "$listen"; else fail "$t-listen-loopback" "listening on: ${listen:-nothing}"; fi
  if grep -q 'could not load' "$log"; then fail "$t-no-load-error" "$(grep -m1 'could not load' "$log")"; else pass "$t-no-load-error" "no 'could not load' in the log"; fi
  # main.js prints this right after the window's loadURL resolved
  for ((i = 0; i < 30; i++)); do grep -q 'kula: page loaded' "$log" && break; sleep 1; done
  if grep -q 'kula: page loaded' "$log"; then pass "$t-page-loaded" "'kula: page loaded' in the log"; else fail "$t-page-loaded" "no 'kula: page loaded' in the log"; fi
  # KULA_SNAP: main.js tries up to 6 times (4 s after the load, then 2 s apart, 5 s each at most)
  size=0
  for ((i = 0; i < 60; i++)); do
    size="$(stat -c %s "$png" 2>/dev/null || echo 0)"
    [ "$size" -gt 10240 ] && break
    sleep 1
  done
  if [ "$size" -gt 10240 ]; then pass "$t-png" "$(basename "$png") $size bytes"
  else
    local what
    if [ -f "$png" ]; then what="empty ($size bytes)"; else what=missing; fi
    fail "$t-png" "$(basename "$png") $what; log: $(grep 'kula: snap' "$log" 2>/dev/null | oneline || true)"
  fi
  ps_dump "$OUT/$t-ps.txt"
  n="$(nosandbox_count)"
  if [ "$n" = 0 ]; then pass "$t-sandbox-on" "no kula process has --no-sandbox ($(kula_pids | wc -l) processes)"
  else fail "$t-sandbox-on" "$n kula processes carry --no-sandbox"; fi
}

# step 5: SIGTERM to the main pid, then within 10 s the port is free and nothing is left
quit_checks() {
  local t=$1 extra=${2:-} mp i listen left
  mp="$(main_pid)"
  if [ -z "$mp" ]; then fail "$t-quit" "no main kula process found"; return 0; fi
  kill -TERM "$mp"
  for ((i = 1; i <= 10; i++)); do
    sleep 1
    listen="$(port_listen "$PORT")"; left="$(leftovers "$extra")"
    if [ -z "$listen" ] && [ -z "$left" ]; then pass "$t-quit" "pid $mp gone in ${i}s, port $PORT free, nothing left"; return 0; fi
  done
  ps_dump "$OUT/$t-quit-ps.txt"
  fail "$t-quit" "after 10 s: port ${listen:-free}, left: ${left:-none}"
  stop_all
}

echo "== kula linux smoke: arch $ARCH, version $VERSION, llama.cpp $TAG, files in $DIR"

# ---------- step 1: static ----------
want="kula-linux-arm64.AppImage kula-linux-arm64.deb kula-linux-x64.AppImage kula-linux-x64.deb sha256sums-linux.txt"
got="$(ls -1 "$DIR" | sort | oneline)"
if [ "$got" = "$want" ]; then pass names "$got"; else fail names "got: $got; want: $want"; fi

for f in Maintainer Architecture Version; do
  case $f in Maintainer) w="$MAINTAINER" ;; Architecture) w="$DEB_ARCH" ;; Version) w="$VERSION" ;; esac
  v="$(dpkg-deb -f "$DEB" "$f" 2>/dev/null || true)"
  if [ "$v" = "$w" ]; then pass "deb-$f" "$v"; else fail "deb-$f" "got '$v', want '$w'"; fi
done
dpkg-deb -f "$DEB" > "$OUT/deb-control.txt" || true
fact "deb Package: $(dpkg-deb -f "$DEB" Package 2>/dev/null || true)"
fact "deb Depends: $(dpkg-deb -f "$DEB" Depends 2>/dev/null || true)"
# llama.cpp's ubuntu binaries need libgomp.so.1; the deb must bring it (desktop/package.json build.deb.depends)
deps="$(dpkg-deb -f "$DEB" Depends 2>/dev/null || true)"
if grep -qE '(^|[ ,])libgomp1([ ,(]|$)' <<< "$deps"; then pass deb-depends-libgomp "libgomp1 in Depends"
else fail deb-depends-libgomp "no libgomp1 in Depends: ${deps:-none}"; fi
others="$(grep -oE '[^[:space:]<>]*@[^[:space:]<>]*' "$OUT/deb-control.txt" | grep -vxF "$EMAIL" | sort -u | oneline || true)"
if [ -z "$others" ]; then pass deb-control-email "only $EMAIL"; else fail deb-control-email "other @: $others"; fi

mkdir -p "$OUT/deb-root"
dpkg-deb --fsys-tarfile "$DEB" | tar -x -C "$OUT/deb-root" --wildcards '*.desktop' 2>/dev/null || true
desk="$(find "$OUT/deb-root" -name '*.desktop' | head -1)"
if [ -n "$desk" ]; then
  cp "$desk" "$OUT/deb.desktop"
  fact "deb desktop file: ${desk#"$OUT/deb-root"}, $(grep -m1 '^Exec=' "$desk" || true)"
  others="$(grep -oE '[^[:space:]<>]*@[^[:space:]<>]*' "$desk" | grep -vxF "$EMAIL" | sort -u | oneline || true)"
  if [ -z "$others" ]; then pass deb-desktop-email "no other @"; else fail deb-desktop-email "other @: $others"; fi
  if grep -q -- '--no-sandbox' "$desk"; then fail deb-desktop-sandbox "$(grep -m1 '^Exec=' "$desk")"; else pass deb-desktop-sandbox "no --no-sandbox"; fi
else
  fail deb-desktop-email "no .desktop file in the deb"
fi

chmod +x "$APPIMG"
mkdir -p "$OUT/appx"
( cd "$OUT/appx" && "$APPIMG" --appimage-extract '*.desktop' > /dev/null 2>&1 && "$APPIMG" --appimage-extract AppRun > /dev/null 2>&1 ) || true
adesk="$(find "$OUT/appx/squashfs-root" -maxdepth 1 -name '*.desktop' 2>/dev/null | head -1)"
if [ -n "$adesk" ]; then
  cp "$adesk" "$OUT/appimage.desktop"
  fact "appimage desktop file: $(grep -m1 '^Exec=' "$adesk" || true)"
  others="$(grep -oE '[^[:space:]<>]*@[^[:space:]<>]*' "$adesk" | grep -vxF "$EMAIL" | sort -u | oneline || true)"
  if [ -z "$others" ]; then pass appimage-desktop-email "no other @"; else fail appimage-desktop-email "other @: $others"; fi
  if grep -q -- '--no-sandbox' "$adesk"; then fail appimage-desktop-sandbox "$(grep -m1 '^Exec=' "$adesk")"; else pass appimage-desktop-sandbox "no --no-sandbox"; fi
else
  fact "appimage desktop file: could not extract"
fi
if [ -f "$OUT/appx/squashfs-root/AppRun" ]; then
  cp "$OUT/appx/squashfs-root/AppRun" "$OUT/AppRun.txt"
  if grep -q 'NO_SANDBOX=(--no-sandbox)' "$OUT/AppRun.txt"; then
    fact "appimage AppRun adds --no-sandbox when 'unshare -Ur true' fails (electron-builder's launcher)"
  else
    fact "appimage AppRun has no --no-sandbox fallback"
  fi
else
  fact "appimage AppRun: could not extract"
fi

if ( cd "$DIR" && sha256sum -c sha256sums-linux.txt ) > "$OUT/sha256-check.txt" 2>&1; then pass sha256sums "$(oneline < "$OUT/sha256-check.txt")"
else fail sha256sums "$(oneline < "$OUT/sha256-check.txt")"; fi

# ---------- step 2: environment facts ----------
USERNS="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
fact "kernel.apparmor_restrict_unprivileged_userns=$USERNS"
fact "libfuse2t64: $(dpkg -s libfuse2t64 2>/dev/null | grep -m1 '^Status:' || echo 'Status: not installed')"
fact "uname -m: $(uname -m) (want $UNAME), $(. /etc/os-release && echo "$PRETTY_NAME"), kernel $(uname -r)"
fm="$(node -e 'console.log(require("os").freemem())')"
ma="$(awk '/^MemAvailable:/ { printf "%d", $2 * 1024 }' /proc/meminfo)"
fact "os.freemem()=$fm MemAvailable=$ma"
if [ "$(awk -v a="$fm" -v b="$ma" 'BEGIN { d = a - b; if (d < 0) d = -d; print (b > 0 && d / b <= 0.15) ? "yes" : "no" }')" = yes ]; then
  pass freemem "os.freemem() within 15% of MemAvailable"
else
  fail freemem "os.freemem()=$fm vs MemAvailable=$ma"
fi

# the release list for llama.ts, fetched with the workflow's token (the app's own call is unauthenticated)
if command -v gh > /dev/null; then
  gh api "repos/ggml-org/llama.cpp/releases/tags/$TAG" > "$REL" 2> "$OUT/rel-err.txt" || true
else
  curl -fsSL -H "Authorization: Bearer ${GH_TOKEN:-}" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$TAG" > "$REL" 2> "$OUT/rel-err.txt" || true
fi
nassets="$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).assets.length) } catch { console.log(0) }' "$REL")"
if [ "$nassets" -gt 0 ]; then pass release-json "$TAG: $nassets assets"; else fail release-json "$(oneline < "$OUT/rel-err.txt")"; fi

# ---------- step 3: the deb, first launch ----------
if ( cd "$DIR" && sudo apt-get install -y "./kula-linux-$ARCH.deb" ) > "$OUT/apt-install.log" 2>&1; then pass deb-install "apt-get install ./kula-linux-$ARCH.deb"
else fail deb-install "$(tail -n 5 "$OUT/apt-install.log" | oneline)"; fi
fact "chrome-sandbox: $(stat -c '%a %U' /opt/kula/chrome-sandbox 2>/dev/null || echo missing); apparmor profile /etc/apparmor.d/kula: $([ -f /etc/apparmor.d/kula ] && echo present || echo absent)"
fact "host ldd /opt/kula/kula not found: $(ldd /opt/kula/kula 2>/dev/null | grep 'not found' | oneline || true)"

DEBLOG="$OUT/deb.log"
start_app "$DEBLOG" "$OUT/deb.png" /opt/kula/kula
if wait_open "$DEBLOG" 300; then
  pass deb-opening "$OPEN_URL"
  page_checks deb "$DEBLOG" "$OUT/deb.png" "$OPEN_URL"
else
  fail deb-opening "no 'kula: opening http://127.0.0.1:$PORT/<hex>/' in 300 s; last: $(tail -n 5 "$DEBLOG" | oneline)"
fi
if [ "$USERNS" = 1 ]; then pass userns-restricted "the sandbox ran with apparmor_restrict_unprivileged_userns=1"
else fail userns-restricted "sysctl was $USERNS: the sandbox claim under the 24.04 restriction is unproven"; fi

# ---------- step 4: llama.cpp ----------
asset="llama-$TAG-bin-ubuntu-$ARCH.tar.gz"
if grep -qF "$asset" "$DEBLOG"; then pass llama-asset "$asset"; else fail llama-asset "no $asset in the log; $(grep -m3 -E 'setup: .*(llama-|for linux)' "$DEBLOG" | oneline || true)"; fi
if grep -q 'sha256 ok' "$DEBLOG"; then pass llama-sha256 "sha256 ok"; else fail llama-sha256 "no 'sha256 ok' in the log"; fi
LBIN="$H/llama-$TAG/bin"
LS="$(find "$LBIN" -type f -name llama-server 2>/dev/null | head -1 || true)"
RPC="$(find "$LBIN" -type f \( -name ggml-rpc-server -o -name rpc-server -o -name llama-rpc-server \) 2>/dev/null | head -1 || true)"
fact "llama programs: ${LS:-no llama-server}, ${RPC:-no rpc server}"
if [ -n "$LS" ]; then
  if v="$("$LS" --version 2>&1)"; then
    if grep -q "$TAGNUM" <<< "$v"; then pass llama-version "$(grep -m1 "$TAGNUM" <<< "$v")"; else fail llama-version "no $TAGNUM in: $(oneline <<< "$v")"; fi
  else fail llama-version "exit non-zero: $(oneline <<< "$v")"; fi
else fail llama-version "llama-server not found under $LBIN"; fi
if [ -n "$RPC" ]; then
  RPCPORT=50052
  "$RPC" -H 127.0.0.1 -p "$RPCPORT" -c > "$OUT/rpc-server.log" 2>&1 &
  RPCPID=$!
  listen=''
  for ((i = 0; i < 15; i++)); do listen="$(port_listen "$RPCPORT")"; [ -n "$listen" ] && break; sleep 1; done
  if [ "$listen" = "127.0.0.1:$RPCPORT" ]; then pass rpc-loopback "$(basename "$RPC") on $listen"; else fail rpc-loopback "listening on: ${listen:-nothing}; $(tail -n 3 "$OUT/rpc-server.log" | oneline)"; fi
  kill "$RPCPID" 2>/dev/null || true
  wait "$RPCPID" 2>/dev/null || true
else fail rpc-loopback "no rpc server under $LBIN"; fi
if [ -n "$LS" ] && [ -n "$RPC" ]; then
  BD="$(dirname "$LS")"
  # a clean ubuntu:24.04 with only the deb's Depends (not the deb itself: its postinst loads AppArmor)
  # the script inside always exits 0: what happened is read from its output; a non-zero exit is docker's own
  if docker run --rm -v "$BD:/b:ro" -v "$DIR:/d:ro" ubuntu:24.04 sh -c "
      export DEBIAN_FRONTEND=noninteractive
      if apt-get update > /dev/null && apt-get install -y --no-install-recommends \$(dpkg-deb -f /d/kula-linux-$ARCH.deb Depends | tr ',' ' ') > /dev/null
      then echo 'kula: depends installed'; else echo 'kula: depends install failed'; exit 0; fi
      ldd /b/$(basename "$LS"); ldd /b/$(basename "$RPC")
      /b/$(basename "$LS") --version 2>&1
      exit 0" > "$OUT/ldd-docker.txt" 2>&1; then
    if ! grep -q 'kula: depends installed' "$OUT/ldd-docker.txt"; then fail llama-ldd "installing the deb's Depends failed: $(tail -n 3 "$OUT/ldd-docker.txt" | oneline)"
    elif grep -q 'not found' "$OUT/ldd-docker.txt"; then fail llama-ldd "$(grep 'not found' "$OUT/ldd-docker.txt" | sort -u | oneline)"
    elif ! grep -q "$TAGNUM" "$OUT/ldd-docker.txt"; then fail llama-ldd "no $TAGNUM in llama-server --version: $(tail -n 3 "$OUT/ldd-docker.txt" | oneline)"
    else pass llama-ldd "ubuntu:24.04 with the deb's Depends: every library found, $(grep -m1 "$TAGNUM" "$OUT/ldd-docker.txt")"; fi
  else fail llama-ldd "docker run failed: $(tail -n 3 "$OUT/ldd-docker.txt" | oneline)"; fi
else fail llama-ldd "programs missing"; fi

# ---------- step 5: quit ----------
quit_checks deb

# ---------- step 6: the AppImage, home already seeded ----------
# measured only: the AppImage is not shipped (D2), so its checks do not count toward the exit code
FAILS_BEFORE_APPIMAGE=$FAILS
appimage_try() {
  local label=$1 log n; shift
  log="$OUT/appimage-$label.log"
  start_app "$log" "$OUT/appimage-$label.png" "$APPIMG" "$@"
  n='?'
  if wait_open "$log" 120; then
    sleep 2
    n="$(nosandbox_count)"
    if [ "$n" = 0 ]; then R=starts; else R=no-sandbox-added; fi
  elif grep -qiE 'fuse' "$log"; then R=fuse-error
  elif grep -qiE 'sandbox' "$log"; then R=sandbox-error
  else R=no-start; fi
  ps_dump "$OUT/appimage-$label-ps.txt"
  echo "APPIMAGE $label result=$R env=[$*] no-sandbox-processes=$n log=$(basename "$log") last: $(tail -n 3 "$log" | oneline)"
  if [ "$R" != starts ]; then stop_all; fi
  ALOG="$log"; APNG="$OUT/appimage-$label.png"
}
ENVS=()
appimage_try shipped
SHIPPED="$R"
if [ "$R" = fuse-error ]; then
  ENVS+=(APPIMAGE_EXTRACT_AND_RUN=1)
  appimage_try extract-and-run "${ENVS[@]}"
fi
if [ "$R" = no-sandbox-added ] || [ "$R" = sandbox-error ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 > /dev/null
  fact "sysctl kernel.apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent) for the AppImage"
  appimage_try "userns0$([ ${#ENVS[@]} -gt 0 ] && echo -extract || true)" "${ENVS[@]}"
fi
echo "APPIMAGE summary shipped=$SHIPPED final=$R env=[${ENVS[*]}] userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
if [ "$R" = starts ]; then
  pass appimage-start "$OPEN_URL"
  page_checks appimage "$ALOG" "$APNG" "$OPEN_URL"
  quit_checks appimage "kula-linux-$ARCH.AppImage"
else
  fail appimage-start "final result $R"
fi
fact "appimage: $((FAILS - FAILS_BEFORE_APPIMAGE)) failed check(s), not shipped, not counted"
FAILS=$FAILS_BEFORE_APPIMAGE

DONE=1
echo "== $FAILS failed check(s)"
[ "$FAILS" = 0 ]
