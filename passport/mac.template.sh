#!/bin/bash
# kula · a Mac's device passport (21.10.2026).
# Built by tools-passport-mac.py from passport/mac.template.sh, mac-bench.c and qr.js:
# edit those, then run `python3 tools-passport-mac.py`. Do not edit mac.sh by hand.
#
#   curl -fsSL https://<the site>/passport/mac.sh | bash -s -- K7M2QX
#
# Measures this Mac — memory, cores, free memory, disk and battery from the system; read and
# copy bandwidth and compute natively when Apple's command line tools are installed, a copy
# test in macOS's own JavaScript otherwise (then marked approx) — and writes the passport
# (passport/0.3, kind computer) to ~/.kula/passport.json. Then it hands it to the phone: sent
# under the connect id the Passport app shows, or printed as a qr code for the phone's camera
# when there is no id or sending fails. Nothing is installed; the temp files go at the end.
set -u
CODE=$(printf '%s' "${1:-}" | tr '[:lower:]' '[:upper:]' | tr -d ' ')
RELAY_URL="${PASSPORT_RELAY_URL:-@@RELAY_URL@@}"
RELAY_KEY="${PASSPORT_RELAY_KEY:-@@RELAY_KEY@@}"
say() { printf '%s\n' "$*"; }

[ "$(uname -s)" = Darwin ] || { say "this measures a Mac. on another computer, open the passport page in a browser."; exit 1; }
if [ -n "$CODE" ] && ! printf '%s' "$CODE" | grep -Eq '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'; then
  say "connect id: the six letters and digits the phone shows (there is no 0, O, 1, I or L in it)."
  exit 1
fi
DIR="$HOME/.kula"
mkdir -p "$DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
START=$(date +%s)
say "measuring this mac · about ten seconds…"

# --- what the system says ----------------------------------------------------------
ID_FILE="$DIR/device-id"
[ -s "$ID_FILE" ] || uuidgen | tr '[:upper:]' '[:lower:]' > "$ID_FILE"
HW=$(system_profiler SPHardwareDataType 2>/dev/null)
GPU=$(system_profiler SPDisplaysDataType 2>/dev/null)
NAME=$(printf '%s\n' "$HW" | awk -F': ' '/Model Name/ {print $2; exit}')
CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
GPU_CORES=$(printf '%s\n' "$GPU" | awk -F': ' '/Total Number of Cores/ {print $2; exit}')
METAL=$(printf '%s\n' "$GPU" | awk -F': ' '/Metal (Support|Family)/ {print $2; exit}')
RAM=$(sysctl -n hw.memsize)
NCPU=$(sysctl -n hw.ncpu)
PCORES=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || echo "$NCPU")
ECORES=$(sysctl -n hw.perflevel1.physicalcpu 2>/dev/null || echo 0)
PAGE=$(sysctl -n hw.pagesize)
# free, inactive, speculative and purgeable pages: what macOS hands out without swapping
FREE_PAGES=$(vm_stat | awk '/Pages (free|inactive|speculative|purgeable)/ {gsub(/\./, "", $NF); s += $NF} END {print s + 0}')
DISK_KB=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR == 2 {print $4}')
[ -n "$DISK_KB" ] || DISK_KB=$(df -k / | awk 'NR == 2 {print $4}')
BATT=$(pmset -g batt 2>/dev/null)
BATT_PCT=$(printf '%s\n' "$BATT" | grep -Eo '[0-9]+%' | head -1 | tr -d '%')
case "$BATT" in *"AC Power"*) CHARGING=1 ;; *) CHARGING=0 ;; esac
OS="macos $(sw_vers -productVersion)"

# --- the native test, when the Mac can compile it -----------------------------------
# /usr/bin/cc on a Mac without the command line tools opens an install dialog, so ask first.
BENCH=""
if xcode-select -p >/dev/null 2>&1; then
  cat > "$TMP/bench.c" <<'MAC_BENCH_C'
@@BENCH_C@@
MAC_BENCH_C
  if cc -O2 -pthread -o "$TMP/bench" "$TMP/bench.c" 2>/dev/null; then
    BENCH=$("$TMP/bench" "$PCORES" "$NCPU" 2>/dev/null)
  fi
fi
[ -n "$BENCH" ] || say "no command line tools: the copy test runs in javascript (approx). xcode-select --install measures it natively."

# --- the passport, the summary and the qr code (macOS's own JavaScript) -------------
cat > "$TMP/passport.js" <<'MAC_PASSPORT_JS'
var window = {};
@@QR_JS@@

// The passport from what bash found (argv: key=value). The estimate rules are the phone's:
// passport-core's estimateModel (largest_model_q4, est_tps) and Probe.kt's budget and
// estimate; device-passport/passport-core/contract pins both.
function run(argv) {
  var a = {};
  argv.forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) a[kv.slice(0, i)] = kv.slice(i + 1); });
  var num = function (k) { var v = parseFloat(a[k]); return isFinite(v) ? v : 0; };
  var r1 = function (x) { return Math.round(x * 10) / 10; };
  var r2 = function (x) { return Math.round(x * 100) / 100; };
  var GB = 1024 * 1024 * 1024;
  var STEPS = [1, 3, 4, 7, 8, 12, 14];
  var native = a.mem_bw_read_gbs !== undefined;

  // without the native test: 64 MB copied five times after a warm-up; TypedArray.set is a
  // memmove inside JavaScriptCore, so this is the memory bus, not a JavaScript loop
  function copyTest() {
    var clock = function () { return $.NSProcessInfo.processInfo.systemUptime; };
    var n = 16 * 1024 * 1024, x = new Float32Array(n), y = new Float32Array(n);
    for (var i = 0; i < n; i += 1024) x[i] = i;
    y.set(x);
    var t0 = clock();
    for (var r = 0; r < 5; r++) y.set(x);
    return (2 * n * 4 * 5) / Math.max(0.001, clock() - t0) / 1e9;
  }
  var bw = native ? num("mem_bw_gbs") : copyTest();
  var ramTotal = r1(num("ram") / GB);
  var ramFree = r1((num("free_pages") * num("page")) / GB);

  // the old rule: usable = free x 0.8, ~0.6 GB per 1B, tok/s = copy bandwidth / size x 0.5
  var usable = ramFree * 0.8, fit = null;
  for (var i = STEPS.length - 1; i >= 0; i--) if (STEPS[i] * 0.6 <= usable) { fit = STEPS[i]; break; }
  var estTps = bw > 0 ? r1((bw / ((fit || 1) * 0.6)) * 0.5) : 0;

  // Probe.kt: budget = free x 0.8 - 0.5 GB; Q4_K_M 0.61 GB per B; read bandwidth x 0.6 / size
  var ramGb = r2(Math.max(0, ramFree * 0.8 - 0.5));
  var budget = { ctx: 2048, reserve_gb: 0.5, ram_gb: ramGb, q4_k_m_b: r1(ramGb / 0.61), q3_k_s_b: r1(ramGb / 0.45), q8_0_b: r1(ramGb / 1.06) };
  var fitB = 0;
  for (var j = STEPS.length - 1; j >= 0; j--) if (STEPS[j] * 0.61 <= ramGb) { fitB = STEPS[j]; break; }
  var high = native && num("mem_bw_read_gbs") > 0 ? (num("mem_bw_read_gbs") * 0.6) / (Math.max(fitB, 1) * 0.61) : 0;

  var name = ("apple " + (a.name || "mac")).toLowerCase().replace(/^apple apple /, "apple ");
  var p = {
    schema: "passport/0.3",
    device: name,
    soc: a.chip || "unknown",
    android: a.os,
    ram_total_gb: ramTotal,
    ram_free_gb: ramFree,
    app_mem_cap_mb: Math.round(num("ram") / 1024 / 1024),
    cpu_cores: num("ncpu"),
    cpu_max_ghz: 0,
    mem_bw_gbs: r2(bw),
    gflops: r2(num("gflops")),
    storage_free_gb: r1(num("disk_kb") / 1024 / 1024),
    battery_pct: num("batt_pct"),
    charging: a.charging === "1",
    largest_model_q4: fit === null ? "<1B" : "~" + fit + "B",
    est_tps: estTps,
    measured_at: new Date().toISOString(),
    device_id: a.device_id,
    kind: "computer",
    os: a.os,
    budget: budget,
    measure_ms: Math.max(0, Date.now() - num("start") * 1000),
  };
  if (native) {
    var threads = {};
    (a.bw_threads || "").split(",").forEach(function (kv) { var s = kv.split(":"); if (s.length === 2) threads[s[0]] = parseFloat(s[1]); });
    p.mem_bw_read_gbs = r1(num("mem_bw_read_gbs"));
    p.bw_threads = threads;
    p.best_threads = num("best_threads");
    p.estimate = { fit_b: fitB, tps_low: r1(high * 0.5), tps_high: r1(high), source: "estimate" };
  } else {
    p.approx = true;
  }
  if (num("pcores") > 0) p.clusters = [{ count: num("pcores"), max_ghz: 0 }].concat(num("ecores") > 0 ? [{ count: num("ecores"), max_ghz: 0 }] : []);
  if (a.gpu_cores) p.gpu = { opencl: false, vulkan: "", model: (a.chip || "gpu") + " · " + a.gpu_cores + " gpu cores" + (a.metal ? " · " + a.metal.toLowerCase() : "") };

  // the qr carries the essentials only, so it stays small enough for a terminal
  var keep = ["schema", "device", "soc", "android", "ram_total_gb", "ram_free_gb", "cpu_cores", "mem_bw_gbs", "gflops", "largest_model_q4", "est_tps", "measured_at", "device_id", "kind", "os"];
  var small = {};
  keep.forEach(function (k) { small[k] = p[k]; });
  if (p.approx) small.approx = true;

  var write = function (path, s) { $.NSString.alloc.initWithUTF8String(s).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null); };
  write(a.out, JSON.stringify(p, null, 2) + "\n");
  write(a.body, JSON.stringify({ p_code: a.code || "", p_data: p }));
  write(a.qr, qrText(JSON.stringify(small)));

  var lines = [
    "",
    "passport · " + name + " · " + p.soc,
    "  memory      " + ramTotal + " gb · " + ramFree + " free",
    "  cores       " + p.cpu_cores + (num("pcores") ? " (" + num("pcores") + " performance)" : ""),
    "  bandwidth   " + (native ? p.mem_bw_read_gbs + " gb/s read · " + r1(bw) + " copy" : r1(bw) + " gb/s copy (approx)"),
    "  compute     " + (native ? r1(p.gflops) + " gflops" : "not measured (needs the command line tools)"),
    // one rule per line: with the native test, Probe.kt's budget (model and range); without it, the old rule
    "  runs alone  " + (native ? (fitB ? "~" + fitB + "B" : "<1B") + " Q4_K_M · " + r1(high * 0.5) + "–" + r1(high) + " tok/s (estimate)" : p.largest_model_q4 + " Q4 · " + estTps + " tok/s"),
    "  saved       ~/.kula/passport.json",
  ];
  return lines.join("\n");
}

// The code as text: two rows of modules per line, upper half block, black on white set
// explicitly (a dark terminal would otherwise invert it and the camera would not read it).
function qrText(text) {
  var q = window.AH.qr(text), n = q.size, pad = n + 8 <= 80 ? 4 : 2, out = [];
  var dark = function (x, y) { return x >= 0 && y >= 0 && x < n && y < n && q.get(x, y); };
  for (var y = -pad; y < n + pad; y += 2) {
    var line = "";
    for (var x = -pad; x < n + pad; x++) line += "\x1b[" + (dark(x, y) ? "30" : "97") + ";" + (dark(x, y + 1) ? "40" : "107") + "m▀";
    out.push(line + "\x1b[0m");
  }
  return out.join("\n") + "\n";
}
MAC_PASSPORT_JS

ARGS=(
  "name=$NAME" "chip=$CHIP" "os=$OS" "ram=$RAM" "ncpu=$NCPU" "pcores=$PCORES" "ecores=$ECORES"
  "page=$PAGE" "free_pages=$FREE_PAGES" "disk_kb=$DISK_KB" "batt_pct=${BATT_PCT:-0}" "charging=$CHARGING"
  "gpu_cores=$GPU_CORES" "metal=$METAL" "device_id=$(cat "$ID_FILE")" "start=$START" "code=$CODE"
  "out=$DIR/passport.json" "body=$TMP/body.json" "qr=$TMP/qr.txt"
)
while IFS= read -r line; do [ -n "$line" ] && ARGS+=("$line"); done <<< "$BENCH"
SUMMARY=$(osascript -l JavaScript "$TMP/passport.js" "${ARGS[@]}" 2>"$TMP/js.err") || {
  say "the passport could not be written: $(head -c 300 "$TMP/js.err")"
  exit 1
}
say "$SUMMARY"
say ""

# --- to the phone --------------------------------------------------------------------
if [ -n "$CODE" ]; then
  HTTP=$(curl -sS -m 20 -o "$TMP/resp" -w '%{http_code}' -X POST "$RELAY_URL/rest/v1/rpc/passport_drop" \
    -H "apikey: $RELAY_KEY" -H "Content-Type: application/json" --data-binary @"$TMP/body.json" 2>"$TMP/curl.err")
  case "$HTTP" in
    2*) say "sent to your phone under $CODE. it shows up in the Passport app in a few seconds."
        exit 0 ;;
    *)  say "could not send it ($HTTP $(head -c 200 "$TMP/resp" "$TMP/curl.err" 2>/dev/null | tr '\n' ' ')). read this with the phone instead:" ;;
  esac
else
  say "on your phone: Passport → Connect → point it at this code"
fi
cat "$TMP/qr.txt"
