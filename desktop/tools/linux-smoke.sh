#!/usr/bin/env bash
# The Linux desktop app's smoke test on a GitHub Ubuntu 24.04 runner (.github/workflows/desktop-linux.yml),
# steps 1-6 of T2 in the orkestra plan of 13.11.2026:
#   1 static: the four names, the deb's control fields, no other email, sha256sums
#   2 facts: the userns sysctl, libfuse2t64, os.freemem() against MemAvailable
#   3 the deb as shipped, first launch (setup downloads llama.cpp), the chat page checks
#   4 llama.cpp: the picked asset, sha256, --version, the rpc server on 127.0.0.1, ldd in a clean ubuntu
#   4b a model, here: the running app loads Qwen3 0.6B Q8_0 through its own page api (download,
#      sha256, llama-server on 127.0.0.1) and answers one question; tok/s is a FACT, no threshold
#   5 quit with the model still loaded: SIGTERM, then the port is free and nothing is left
#   5b nvidia: `kula-node setup` in a home of its own with a fake nvidia-smi (the real detection,
#      not KULA_NVIDIA=1): the cuda build and its cudart are picked, sha-checked, unpacked, the cudart
#      files land beside llama-server, `setup --check` moves them there in a home of the first debs,
#      and ldd (LD_LIBRARY_PATH as children.ts sets it) in a clean ubuntu finds everything but the
#      driver's libcuda.so.1. The gpu itself is not used.
#   6 the AppImage as shipped, then APPIMAGE_EXTRACT_AND_RUN=1 and/or userns=0 only as needed
# Only xvfb is installed beforehand. The Chromium sandbox stays on: nothing here passes --no-sandbox.
# usage: linux-smoke.sh <x64|arm64> <dir with the four files and sha256sums-linux.txt>
#        linux-smoke.sh --model-only <OPEN_URL> <KULA_NODE_HOME> <OUTDIR>
#          step 4b alone against any running kula page (a Mac too): OPEN_URL is the page's address
#          (http://127.0.0.1:<port>/<prefix>/), KULA_NODE_HOME that app's home; never quits the app.
#          There a model already here or loaded is reported, not failed, and the loopback check
#          is skipped without ss.
# prints CHECK <name> PASS|FAIL <detail>, FACT ..., APPIMAGE ...; exits 1 when any CHECK failed
# (step 6's AppImage checks are printed but not counted: the AppImage is not shipped).
set -euo pipefail

# the model of step 4b, as node/src/ui/catalog.ts has it (UI_CATALOG's first entry); the app fetches
# it itself from huggingface (catalog.ts modelUrl) and checks the sha256 (ui/engine.ts fetchChecked)
MODEL_ID='qwen3-0.6b-q8'
MODEL_FILE='Qwen3-0.6B-Q8_0.gguf'
MODEL_SIZE=639446688
MODEL_SHA='9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031'
export MODEL_ID MODEL_FILE MODEL_SIZE MODEL_SHA

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "${1:-}" = --model-only ]; then
  MODE=model-only
  OPEN_URL="${2:?usage: linux-smoke.sh --model-only <OPEN_URL> <KULA_NODE_HOME> <OUTDIR>}"
  H="${3:?usage: linux-smoke.sh --model-only <OPEN_URL> <KULA_NODE_HOME> <OUTDIR>}"
  OUT="${4:?usage: linux-smoke.sh --model-only <OPEN_URL> <KULA_NODE_HOME> <OUTDIR>}"
  case "$OPEN_URL" in */) ;; *) OPEN_URL="$OPEN_URL/" ;; esac
  mkdir -p "$OUT"
else
  MODE=full
  ARCH="${1:?arch: x64 or arm64}"
  DIR="$(cd "${2:?dir with the files}" && pwd)"
  OUT="${SMOKE_OUT:-${RUNNER_TEMP:-/tmp}/smoke}"
  H="${RUNNER_TEMP:-/tmp}/h"                   # KULA_NODE_HOME (node/src/paths.ts:10)
  mkdir -p "$OUT" "$H"
fi
REL="$OUT/rel.json"                            # KULA_RELEASE_JSON (node/src/llama.ts:251), absolute: kula-node runs with cwd = its own folder
PORT=50590                                     # the app's default (desktop/src/main.js:17)
EMAIL='noreply@users.noreply.github.com'
MAINTAINER="kula <$EMAIL>"

if [ "$MODE" = full ]; then
  case "$ARCH" in
    x64) DEB_ARCH=amd64; UNAME=x86_64 ;;
    arm64) DEB_ARCH=arm64; UNAME=aarch64 ;;
    *) echo "unknown arch $ARCH"; exit 2 ;;
  esac
fi
TAG="$(grep -oE "export const TAG = '[^']+'" "$REPO/node/src/llama.ts" | grep -oE "b[0-9]+")"
TAGNUM="${TAG#b}"
VERSION="$(node -p "require('$REPO/desktop/package.json').version")"
DEB="${DIR:-}/kula-linux-${ARCH:-}.deb"
APPIMG="${DIR:-}/kula-linux-${ARCH:-}.AppImage"

FAILS=0
DONE=0
pass() { echo "CHECK $1 PASS ${*:2}"; }
fail() { echo "CHECK $1 FAIL ${*:2}"; FAILS=$((FAILS + 1)); }
fact() { echo "FACT $*"; }
oneline() { tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/ $//'; }

# jsf FILE 'body': runs body as a function of x (FILE parsed as JSON; null when it is not) and
# prints what it returns. Never fails: a missing file or a throw comes back as text.
jsf() {
  node -e 'let x = null; try { x = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {}
    let r; try { r = new Function("x", process.argv[2])(x); } catch (err) { r = "FAIL js: " + err.message; }
    console.log(r == null ? "" : String(r));' "$1" "$2" || true
}
# ssef FILE 'body': FILE is a saved SSE answer (lines "data: {json}"); body runs with evs (every
# event that parsed) and e (the last data: line parsed; {unparsed} when it is cut off, null when
# there is none) and prints what it returns. Never fails.
ssef() {
  node -e 'let t = ""; try { t = require("fs").readFileSync(process.argv[1], "utf8"); } catch {}
    const evs = []; let last = null;
    for (const l of t.split(/\r?\n/)) { if (!l.startsWith("data:")) continue; last = l.slice(5).trim(); try { evs.push(JSON.parse(last)); } catch {} }
    let e = null; if (last !== null) { try { e = JSON.parse(last); } catch { e = { unparsed: last.slice(0, 200) }; } }
    let r; try { r = new Function("evs", "e", process.argv[2])(evs, e); } catch (err) { r = "FAIL js: " + err.message; }
    console.log(r == null ? "" : String(r));' "$1" "$2" || true
}
# verdict NAME "PASS detail" | "FAIL detail"
verdict() { case "$2" in "PASS "*) pass "$1" "${2#PASS }" ;; *) fail "$1" "${2#FAIL }" ;; esac; }
sha256_of() { if command -v sha256sum > /dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
size_of() { node -p 'require("fs").statSync(process.argv[1]).size' "$1" 2>/dev/null || echo 0; }

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
# --model-only never stops anything: the app there is someone's own
if [ "$MODE" = full ]; then trap on_exit EXIT
else trap 'rc=$?; if [ "$DONE" != 1 ]; then echo "CHECK script-finished FAIL stopped early (exit $rc)"; exit 1; fi' EXIT; fi
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

# step 4b: a model, here, through the page's own api (node/src/ui/server.ts): GET status and models;
# POST load and chat answer as SSE (data: {...} lines; the last is {done:true,...} or {error}).
# A POST needs Origin == http://<the Host header> (server.ts sameOrigin), so the page's own host:port.
# Every answer is kept as $OUT/model-*.txt (the artifact takes txt and log only).
model_steps() {
  local api origin code rc t0 secs v f had nc
  local strict=1
  [ "$MODE" = model-only ] && strict=0
  export STRICT=$strict
  api="${OPEN_URL}api"
  origin="$(printf '%s' "$OPEN_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
  fact "model: $MODEL_ID ($MODEL_FILE, $MODEL_SIZE bytes) at $api, Origin $origin, home $H"

  # model-known: kula's catalog has it, llama.cpp is here, nothing loaded, the row has the size
  code="$(curl -sS --max-time 10 -o "$OUT/model-status-before.txt" -w '%{http_code}' "$api/status" 2>> "$OUT/model-curl.log" || true)"
  code="$code/$(curl -sS --max-time 10 -o "$OUT/model-models.txt" -w '%{http_code}' "$api/models" 2>> "$OUT/model-curl.log" || true)"
  v="$(jsf "$OUT/model-status-before.txt" 'if (!x) return "FAIL status is not json";
    const why = [];
    if (x.llama !== true) why.push("llama " + JSON.stringify(x.llama));
    if (x.loaded !== null && process.env.STRICT === "1") why.push("loaded " + JSON.stringify(x.loaded && x.loaded.model));
    return (why.length ? "FAIL " + why.join(", ") : "PASS llama true, loaded " + (x.loaded ? x.loaded.mode + " " + x.loaded.model.id + " (model-only: not required)" : "null"));')"
  had="$(jsf "$OUT/model-models.txt" 'const r = Array.isArray(x) ? x.find((m) => m && m.id === process.env.MODEL_ID) : null; return r ? String(r.here === true) : "";')"
  if ! grep -q "$MODEL_SHA" "$REPO/node/src/ui/catalog.ts"; then fail model-known "sha $MODEL_SHA not in node/src/ui/catalog.ts"
  else
    case "$v" in
      "PASS "*)
        v="$(jsf "$OUT/model-models.txt" 'if (!Array.isArray(x)) return "FAIL models is not a list";
          const r = x.find((m) => m && m.id === process.env.MODEL_ID);
          if (!r) return "FAIL no row " + process.env.MODEL_ID + " in " + x.length + " rows";
          if (r.size !== Number(process.env.MODEL_SIZE)) return "FAIL size " + r.size + ", want " + process.env.MODEL_SIZE;
          if (r.here !== false && process.env.STRICT === "1") return "FAIL here " + JSON.stringify(r.here) + ", want false";
          return "PASS row " + r.id + " size " + r.size + " here " + r.here + (r.here ? " (model-only: not required)" : "");')"
        verdict model-known "$v (http $code)" ;;
      *) fail model-known "${v#FAIL } (http $code)" ;;
    esac
  fi

  # model-load: the page's own body (node/src/ui/static/app.js, the load button)
  t0="$(date +%s)"
  rc=0
  code="$(curl -sS -N --max-time 600 -o "$OUT/model-load.txt" -w '%{http_code}' -H 'content-type: application/json' -H "Origin: $origin" \
    --data-binary "{\"model\":\"$MODEL_ID\",\"mode\":\"here\",\"peers\":[],\"ctx\":4096}" "$api/load" 2>> "$OUT/model-curl.log")" || rc=$?
  secs=$(( $(date +%s) - t0 ))
  v="$(ssef "$OUT/model-load.txt" 'if (!e) return "FAIL";
    if (e.done === true) { const l = e.status && e.status.loaded; return "PASS done: " + (l ? l.model.name + " " + l.mode + ", ctx " + l.ctx : "no loaded in status"); }
    if (typeof e.error === "string") return "FAIL " + e.error;
    return "FAIL";')"
  if [ "$v" = FAIL ]; then v="FAIL http ${code:-none}, curl exit $rc: $(head -c 200 "$OUT/model-load.txt" 2>/dev/null | oneline || true)"; fi
  verdict model-load "$v"
  if [ "$had" = true ]; then fact "model load: $secs s (the file was already here: load only)"
  else fact "model load: $secs s ($((MODEL_SIZE / 1000000)) MB download + load)"; fi

  # model-loaded: status says it runs here, this model, nothing loading
  curl -sS --max-time 10 -o "$OUT/model-status-after.txt" "$api/status" 2>> "$OUT/model-curl.log" || true
  verdict model-loaded "$(jsf "$OUT/model-status-after.txt" 'if (!x) return "FAIL status is not json";
    const l = x.loaded;
    const d = "loaded " + (l ? l.mode + " " + (l.model && l.model.id) + " ctx " + l.ctx : "null") + ", loading " + JSON.stringify(x.loading);
    return (l && l.mode === "here" && l.model && l.model.id === process.env.MODEL_ID && x.loading == null ? "PASS " : "FAIL ") + d;')"

  # model-file-sha256: the file the app fetched (the first model dir, ui/engine.ts defaultModelDirs)
  f="$H/models/$MODEL_FILE"
  if [ "$MODE" = model-only ] && [ ! -f "$f" ] && [ -f "$REPO/.llama/models/$MODEL_FILE" ]; then f="$REPO/.llama/models/$MODEL_FILE"; fi
  if [ -f "$f" ]; then
    local size sum
    size="$(size_of "$f")"
    sum="$(sha256_of "$f")"
    if [ "$size" = "$MODEL_SIZE" ] && [ "$sum" = "$MODEL_SHA" ]; then pass model-file-sha256 "$f $size bytes sha256 $sum"
    else fail model-file-sha256 "$f: size $size (want $MODEL_SIZE), sha256 $sum (want $MODEL_SHA)"; fi
  else fail model-file-sha256 "no $f"; fi

  # model-llama-loopback: llama-server listens on 127.0.0.1 only (node/src/api.ts: --host 127.0.0.1)
  if command -v ss > /dev/null; then
    local rows bad p
    ss -ltnpH > "$OUT/model-listeners.txt" 2>&1 || true
    rows="$(grep -F '"llama-server"' "$OUT/model-listeners.txt" | awk '{print $4}' | sort -u || true)"
    nc="$(printf '%s\n' "$rows" | grep -c . || true)"
    bad="$(printf '%s\n' "$rows" | grep -v '^127\.0\.0\.1:' | grep . | oneline || true)"
    if [ "$nc" -ge 1 ] && [ -z "$bad" ]; then pass model-llama-loopback "llama-server on $(oneline <<< "$rows")"
    else fail model-llama-loopback "llama-server listening on: $(oneline <<< "${rows:-nothing}")"; fi
    for p in $(pgrep -x llama-server || true); do fact "llama-server $p: $(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null || true)"; done
    fact "listeners of kula and llama: $(grep -E '"(kula|llama-server|ggml-rpc-server|rpc-server)"' "$OUT/model-listeners.txt" | awk '{print $4, $6}' | oneline || true)"
  else
    echo "CHECK model-llama-loopback SKIP no ss"
  fi

  # model-answer: one question, temperature 0; thinking arrives inline as <think>...</think> (node/src/api.ts)
  rc=0
  code="$(curl -sS -N --max-time 180 -o "$OUT/model-chat.txt" -w '%{http_code}' -H 'content-type: application/json' -H "Origin: $origin" \
    --data-binary '{"messages":[{"role":"user","content":"What is the capital of France? Answer in one short sentence."}],"maxTokens":512,"temperature":0}' \
    "$api/chat" 2>> "$OUT/model-curl.log")" || rc=$?
  local answer='const raw = evs.filter((x) => x && typeof x.t === "string").map((x) => x.t).join("");
    const ans = raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
    const think = raw.includes("<think>");'
  v="$(ssef "$OUT/model-chat.txt" "$answer"'
    if (!e) return "FAIL";
    const why = [];
    if (e.done !== true) why.push("last event " + JSON.stringify(e).slice(0, 160));
    if (e.error !== undefined) why.push("error " + e.error);
    if (e.stopped === true) why.push("stopped");
    if (!(e.tokens >= 1)) why.push("tokens " + e.tokens);
    if (!(e.tps > 0)) why.push("tps " + e.tps);
    if (!ans) why.push(think ? "only thinking (" + raw.length + " chars)" : "empty answer");
    const said = ans.replace(/\s+/g, " ").slice(0, 120);
    return (why.length ? "FAIL " + why.join(", ") + (said ? ": " + said : "") : "PASS " + said);')"
  if [ "$v" = FAIL ]; then v="FAIL http ${code:-none}, curl exit $rc: $(head -c 200 "$OUT/model-chat.txt" 2>/dev/null | oneline || true)"; fi
  verdict model-answer "$v"
  SMOKE_CORES="$(node -p 'require("os").cpus().length' 2>/dev/null || echo '?')"
  export SMOKE_CORES
  fact "$(ssef "$OUT/model-chat.txt" "$answer"'
    const d = e || {};
    return "model: Qwen3 0.6B Q8_0 here, " + process.env.SMOKE_CORES + " cores: " + d.tokens + " tokens, " + d.tps + " tok/s, first token " + d.firstMs + " ms, "
      + d.ms + " ms, device " + d.device + ", thinking " + (think ? "yes" : "no") + ", says Paris " + (/paris/i.test(ans) ? "yes" : "no");')"
}

if [ "$MODE" = model-only ]; then
  echo "== kula model-only: $OPEN_URL, home $H, out $OUT"
  model_steps
  DONE=1
  echo "== $FAILS failed check(s)"
  if [ "$FAILS" = 0 ]; then exit 0; else exit 1; fi
fi

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

# ---------- step 4b: a model, here (the deb app still running) ----------
if [ -z "${OPEN_URL:-}" ] || [ -z "$LS" ]; then fail model-load "app not up (page ${OPEN_URL:-none}, llama-server ${LS:-none})"
else model_steps; fi

# ---------- step 5: quit, the model still loaded ----------
fact "before quit: llama-server pids $(pgrep -x llama-server | oneline || true)"
quit_checks deb

# ---------- step 5b: nvidia, a fake nvidia-smi, a home of its own ----------
# node/src/llama.ts hasNvidia: `nvidia-smi -L` exiting 0 (KULA_NVIDIA unset); assets.ts pickAsset then
# takes llama-<tag>-bin-ubuntu-cuda-<v>-<arch>.tar.gz and its cudart-...-same-suffix companion
NVH="${RUNNER_TEMP:-/tmp}/h-nvidia"
NVBIN="$NVH/llama-$TAG/bin"                    # llama.ts cacheDir()/bin: both archives unpack here
NVLOG="$OUT/nvidia-setup.log"
KN=/opt/kula/resources/kula-node
mkdir -p "$OUT/fakebin" "$NVH"
printf '%s\n' '#!/bin/sh' 'echo "GPU 0: NVIDIA Fake GPU for the kula smoke test (UUID: GPU-00000000-0000-0000-0000-000000000000)"' 'exit 0' > "$OUT/fakebin/nvidia-smi"
chmod +x "$OUT/fakebin/nvidia-smi"
fact "nvidia-smi -L with the fake: $(PATH="$OUT/fakebin:$PATH" nvidia-smi -L 2>&1 | oneline || true)"
if [ -f "$KN/dist/bin/kula-node.js" ] && [ -f "$REL" ]; then
  nrc=0
  ( cd "$KN" && env -u KULA_NVIDIA KULA_NODE_HOME="$NVH" KULA_RELEASE_JSON="$REL" PATH="$OUT/fakebin:$PATH" \
      timeout 900 node dist/bin/kula-node.js setup ) > "$NVLOG" 2>&1 || nrc=$?
  pick_main="$(grep -oE "(^|[[:space:]/])llama-$TAG-bin-ubuntu-cuda-[0-9.]+-$ARCH\.tar\.gz" "$NVLOG" | grep -oE "llama-$TAG-.*" | sort -u | head -1 || true)"
  pick_rt="$(grep -oE "cudart-llama-$TAG-bin-ubuntu-cuda-[0-9.]+-$ARCH\.tar\.gz" "$NVLOG" | sort -u | head -1 || true)"
  if [ -n "$pick_main" ] && [ -n "$pick_rt" ]; then pass nvidia-pick "$pick_main + $pick_rt"
  else fail nvidia-pick "build ${pick_main:-not named}, runtime ${pick_rt:-not named}; $(grep -m3 -E 'for linux|cuda|cpu build' "$NVLOG" | oneline || true)"; fi
  nok="$(grep -c 'sha256 ok' "$NVLOG" || true)"
  if [ "$nrc" = 0 ] && [ "$nok" -ge 2 ] && grep -q '^ready: ' "$NVLOG"; then pass nvidia-setup "exit 0, sha256 ok x$nok, $(grep -m1 '^ready: ' "$NVLOG")"
  else fail nvidia-setup "exit $nrc, sha256 ok x$nok, ready: $(grep -c '^ready: ' "$NVLOG" || true)x; last: $(tail -n 3 "$NVLOG" | oneline)"; fi
  fact "nvidia first start downloads: $(grep -m1 -E 'will download [0-9]+ files?, ' "$NVLOG" | sed -E 's/^[[:space:]]+//' || echo 'no "will download" line')"
else
  fail nvidia-pick "no $KN/dist/bin/kula-node.js or no $REL"
  fail nvidia-setup "not run"
  : > "$NVLOG"
fi
NLS="$(find "$NVBIN" -type f -name llama-server 2>/dev/null | head -1 || true)"
if [ -n "$NLS" ]; then
  NBD="$(dirname "$NLS")"
  NLSREL="${NLS#"$NVBIN"/}"
  NRPC="$(find "$NBD" -maxdepth 1 -type f \( -name ggml-rpc-server -o -name rpc-server -o -name llama-rpc-server \) | head -1 || true)"
  cud="$(find "$NVBIN" \( -name 'libcudart.so*' -o -name 'libcublas.so*' -o -name 'libcublasLt.so*' \) 2>/dev/null | sort | while read -r f; do
           if [ "$(dirname "$f")" = "$NBD" ]; then echo "$(basename "$f") (beside it)"; else echo "${f#"$NVBIN"/} (elsewhere)"; fi
         done | oneline || true)"
  fact "nvidia cuda libraries, llama-server at $NLSREL: ${cud:-no libcudart/libcublas at all}"
  NLSDIR="$(dirname "$NLSREL")"
  # the runtime patterns with no file beside llama-server (llama.ts placeCudaRuntime puts them there)
  cuda_beside() { local p miss=""; for p in 'libcudart.so*' 'libcublas.so*' 'libcublasLt.so*'; do [ -n "$(find "$NBD" -maxdepth 1 -name "$p" | head -1)" ] || miss="$miss $p"; done; echo "${miss# }"; }
  cudart_left() { find "$NVBIN" -mindepth 1 -maxdepth 1 -type d -name 'cudart-*' -exec basename {} \; | sort | oneline || true; }
  # CHECK nvidia-layout: after the first setup the runtime is beside llama-server, no cudart-* folder left
  lmiss="$(cuda_beside)"; lleft="$(cudart_left)"
  if [ -z "$lmiss" ] && [ -z "$lleft" ]; then pass nvidia-layout "libcudart, libcublas, libcublasLt beside $NLSREL; no cudart-* left under bin"
  else fail nvidia-layout "not beside llama-server: ${lmiss:-none}; cudart-* left under bin: ${lleft:-none}"; fi
  # CHECK nvidia-repair: a home set up by the first debs (runtime in its own folder) is fixed by the
  # `setup --check` the app runs on every start, without downloading again
  OLDRT="$NVBIN/cudart-llama-$TAG-old"
  NVREP="$OUT/nvidia-repair.log"
  mkdir -p "$OLDRT"
  nback=0
  while IFS= read -r f; do mv "$f" "$OLDRT/" && nback=$((nback + 1)); done < <(find "$NBD" -maxdepth 1 \( -name 'libcudart.so*' -o -name 'libcublas.so*' -o -name 'libcublasLt.so*' \))
  if [ "$nback" -eq 0 ]; then fail nvidia-repair "no cuda runtime beside llama-server to move back"; : > "$NVREP"
  elif [ ! -f "$KN/dist/bin/kula-node.js" ]; then fail nvidia-repair "no $KN/dist/bin/kula-node.js"; : > "$NVREP"
  else
    rrc=0
    ( cd "$KN" && env -u KULA_NVIDIA KULA_NODE_HOME="$NVH" KULA_RELEASE_JSON="$REL" PATH="$OUT/fakebin:$PATH" \
        timeout 300 node dist/bin/kula-node.js setup --check ) > "$NVREP" 2>&1 || rrc=$?
    rmiss="$(cuda_beside)"
    rline="$(grep -m1 'files moved beside llama-server' "$NVREP" || true)"
    ndl="$(grep -c 'downloading' "$NVREP" || true)"
    if [ "$rrc" = 0 ] && [ -n "$rline" ] && [ -z "$rmiss" ] && [ "${ndl:-0}" = 0 ]; then pass nvidia-repair "$nback files moved back into cudart-llama-$TAG-old/; setup --check: exit 0, $rline, nothing downloaded"
    else fail nvidia-repair "$nback files moved back; setup --check: exit $rrc, ${rline:-no files-moved line}, not beside: ${rmiss:-none}, downloading lines: ${ndl:-0}; last: $(tail -n 3 "$NVREP" | oneline)"; fi
  fi
  # ldd the programs and the llama.cpp libraries beside them, not the cudart ones (alone they can miss each other);
  # first with LD_LIBRARY_PATH as children.ts childEnv sets it, then plain (a FACT: does the library's own path do?)
  list="$NLSREL"
  [ -n "$NRPC" ] && list="$list ${NRPC#"$NVBIN"/}"
  for f in $(find "$NBD" -maxdepth 1 \( -name 'libggml*.so*' -o -name 'libllama*.so*' -o -name 'libmtmd*.so*' \) | sort); do list="$list ${f#"$NVBIN"/}"; done
  LDD="$OUT/nvidia-ldd-docker.txt"
  if docker run --rm -v "$NVBIN:/n:ro" -v "$DIR:/d:ro" ubuntu:24.04 sh -c "
      export DEBIAN_FRONTEND=noninteractive
      if apt-get update > /dev/null && apt-get install -y --no-install-recommends \$(dpkg-deb -f /d/kula-linux-$ARCH.deb Depends | tr ',' ' ') > /dev/null
      then echo 'kula: depends installed'; else echo 'kula: depends install failed'; exit 0; fi
      echo 'kula: ldd with LD_LIBRARY_PATH=/n/$NLSDIR'
      for f in $list; do echo \"== \$f\"; LD_LIBRARY_PATH=/n/$NLSDIR ldd \"/n/\$f\" 2>&1 || true; done
      LD_LIBRARY_PATH=/n/$NLSDIR /n/$NLSREL --version > /tmp/v.txt 2>&1; echo \"kula: version exit \$?\"; cat /tmp/v.txt
      echo 'kula: plain ldd'
      for f in $list; do echo \"== \$f\"; ldd \"/n/\$f\" 2>&1 || true; done
      exit 0" > "$LDD" 2>&1; then
    missing="$(sed -n '/^kula: ldd with/,/^kula: version exit/p' "$LDD" | awk '/=> not found/ {print $1}' | sort -u | oneline || true)"
    plain="$(sed -n '/^kula: plain ldd/,$p' "$LDD" | awk '/=> not found/ {print $1}' | sort -u | oneline || true)"
    others="$(tr ' ' '\n' <<< "$missing" | grep -vx 'libcuda.so.1' | grep . | oneline || true)"
    nfiles="$(wc -w <<< "$list" | tr -d ' ')"
    if ! grep -q 'kula: depends installed' "$LDD"; then fail nvidia-ldd "installing the deb's Depends failed: $(tail -n 3 "$LDD" | oneline)"
    elif ! grep -qE '(^| |/)libggml-cuda\.so( |$)' <<< "$list"; then fail nvidia-ldd "libggml-cuda.so is not among the $nfiles files looked at: $list"
    elif [ -n "$others" ]; then fail nvidia-ldd "LD_LIBRARY_PATH=/n/$NLSDIR, not found: $others ($nfiles files looked at)"
    else pass nvidia-ldd "ubuntu:24.04 with the deb's Depends, LD_LIBRARY_PATH=/n/$NLSDIR: $nfiles files incl. libggml-cuda.so, nothing missing but the driver's"; fi
    if tr ' ' '\n' <<< "$missing" | grep -qx 'libcuda.so.1'; then fact "nvidia expected missing without a driver: libcuda.so.1"
    else fact "nvidia expected missing without a driver: none"; fi
    fact "nvidia llama-server --version in the container: $(grep -m1 '^kula: version exit' "$LDD" | sed 's/^kula: version //' || echo 'exit ?'), $(sed -n '/^kula: version exit/,/^kula: plain ldd/p' "$LDD" | sed '1d;$d' | grep -m1 . || echo 'no output')"
    fact "nvidia plain ldd (no LD_LIBRARY_PATH) not found: ${plain:-none}"
  else fail nvidia-ldd "docker run failed: $(tail -n 3 "$LDD" | oneline)"; fi
else
  fail nvidia-layout "no llama-server under $NVBIN"
  fail nvidia-repair "no llama-server under $NVBIN"
  fail nvidia-ldd "no llama-server under $NVBIN"
fi

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
