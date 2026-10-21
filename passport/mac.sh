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
RELAY_URL="${PASSPORT_RELAY_URL:-https://eshgfeasffxryrijwksp.supabase.co}"
RELAY_KEY="${PASSPORT_RELAY_KEY:-sb_publishable_eSYlpNsoLWyijpzcN1KEkg_hHia0yF0}"
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
/* kula · the Mac's native measurement (21.10.2026). mac.sh compiles this when the Mac has
   Apple's command line tools and prints what it says into the passport. The same three tests
   as the phone's Measure.kt / Probe.kt, so a Mac and a phone stand side by side:

     copy    256 MB copied end to end (first half -> second, then back), one warm-up, three
             timed passes; traffic per pass = read + write = 2 x size      -> mem_bw_gbs
     read    the same buffer summed by 1, 2, 4, P and N threads, one slice each; the best
             count wins                                                      -> bw_threads,
                                                                                mem_bw_read_gbs,
                                                                                best_threads
     matmul  512 x 512 floats, rows split over every core, one warm-up, three timed
             GFLOPS = 3 x 2n^3 / time                                        -> gflops

   Output: one key=value per line. Usage: mac-bench <performance cores> <all cores> */
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

#define MB (1024UL * 1024UL)
static uint64_t *buf;
static size_t words;

typedef struct { size_t from, to; uint64_t sum; } slice_t;

static void *read_slice(void *arg) {
  slice_t *s = arg;
  uint64_t a = 0, b = 0, c = 0, d = 0;
  for (size_t i = s->from; i + 4 <= s->to; i += 4) { a += buf[i]; b += buf[i + 1]; c += buf[i + 2]; d += buf[i + 3]; }
  s->sum = a + b + c + d;
  return NULL;
}

static double read_bw(int threads) {
  pthread_t th[64];
  slice_t sl[64];
  double best = 0;
  for (int rep = 0; rep < 4; rep++) { /* the first pass warms up; the best of the other three counts */
    size_t per = words / threads;
    double t0 = now();
    for (int i = 0; i < threads; i++) {
      sl[i].from = i * per; sl[i].to = (i == threads - 1) ? words : (i + 1) * per;
      pthread_create(&th[i], NULL, read_slice, &sl[i]);
    }
    for (int i = 0; i < threads; i++) pthread_join(th[i], NULL);
    double sec = now() - t0;
    double gbs = (double)words * 8 / sec / 1e9;
    if (rep > 0 && gbs > best) best = gbs;
  }
  return best;
}

static double copy_bw(void) {
  size_t half = words / 2 * 8;
  char *p = (char *)buf;
  memcpy(p + half, p, half); memcpy(p, p + half, half); /* warm-up */
  double t0 = now();
  for (int r = 0; r < 3; r++) { memcpy(p + half, p, half); memcpy(p, p + half, half); }
  double sec = now() - t0;
  return 2.0 * (double)(words * 8) * 3 / sec / 1e9;
}

#define N 512
static float A[N * N], B[N * N], C[N * N];
typedef struct { int r0, r1; } rows_t;
static void *mul_rows(void *arg) {
  rows_t *r = arg;
  for (int i = r->r0; i < r->r1; i++) {
    float *ci = C + i * N;
    memset(ci, 0, N * sizeof(float));
    for (int k = 0; k < N; k++) {
      float aik = A[i * N + k];
      const float *bk = B + k * N;
      for (int j = 0; j < N; j++) ci[j] += aik * bk[j];
    }
  }
  return NULL;
}
static void multiply(int workers) {
  pthread_t th[64];
  rows_t rs[64];
  int per = (N + workers - 1) / workers, used = 0;
  for (int w = 0; w < workers; w++) {
    rs[w].r0 = w * per; rs[w].r1 = (w + 1) * per > N ? N : (w + 1) * per;
    if (rs[w].r0 >= rs[w].r1) break;
    pthread_create(&th[used], NULL, mul_rows, &rs[w]);
    used++;
  }
  for (int i = 0; i < used; i++) pthread_join(th[i], NULL);
}
static double gflops(int workers) {
  for (int i = 0; i < N * N; i++) { A[i] = (i % 7) * 0.5f; B[i] = (i % 5) * 0.25f; }
  multiply(workers); /* warm-up */
  double t0 = now();
  for (int r = 0; r < 3; r++) multiply(workers);
  double sec = now() - t0;
  return 3.0 * 2.0 * N * N * (double)N / sec / 1e9;
}

int main(int argc, char **argv) {
  int perf = argc > 1 ? atoi(argv[1]) : 4, all = argc > 2 ? atoi(argv[2]) : perf;
  if (perf < 1) perf = 1;
  if (all < perf) all = perf;
  if (all > 64) all = 64;
  size_t bytes = 256 * MB;
  buf = malloc(bytes);
  if (!buf) { bytes = 64 * MB; buf = malloc(bytes); }
  if (!buf) return 1;
  words = bytes / 8;
  for (size_t i = 0; i < words; i++) buf[i] = i;

  printf("mem_bw_gbs=%.2f\n", copy_bw());
  int counts[5] = {1, 2, 4, perf, all}, best_t = 1;
  double best = 0;
  printf("bw_threads=");
  int seen[65] = {0}, first = 1;
  for (int k = 0; k < 5; k++) {
    int t = counts[k];
    if (t < 1 || t > all || seen[t]) continue;
    seen[t] = 1;
    double g = read_bw(t);
    printf("%s%d:%.1f", first ? "" : ",", t, g);
    first = 0;
    if (g > best) { best = g; best_t = t; }
  }
  printf("\nmem_bw_read_gbs=%.1f\nbest_threads=%d\n", best, best_t);
  printf("gflops=%.2f\n", gflops(all));
  free(buf);
  return 0;
}
MAC_BENCH_C
  if cc -O2 -pthread -o "$TMP/bench" "$TMP/bench.c" 2>/dev/null; then
    BENCH=$("$TMP/bench" "$PCORES" "$NCPU" 2>/dev/null)
  fi
fi
[ -n "$BENCH" ] || say "no command line tools: the copy test runs in javascript (approx). xcode-select --install measures it natively."

# --- the passport, the summary and the qr code (macOS's own JavaScript) -------------
cat > "$TMP/passport.js" <<'MAC_PASSPORT_JS'
var window = {};
/* afterhours — a qr code by hand (21.10.2026).

   The passport page draws the computer's passport as a code the phone
   reads. The site has no dependencies, so this is the encoder: byte
   mode, error correction level M, the smallest version (1–40) that
   fits, the mask with the lowest penalty — the standard, nothing more.

     AH.qr(text)  → { size, get(x, y) }   get() is true where a module is dark

   Written after ISO 18004 the way everybody writes it (Nayuki's
   qrcodegen is the clearest reference). Byte mode only: the passport is
   json, so numeric and alphanumeric modes would never apply. */

(function () {
  var AH = (window.AH = window.AH || {});

  // level M: error-correction codewords per block, and number of blocks, per version 1..40
  var ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  var BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  var FORMAT_M = 0; // the level bits for M

  // ---- galois field GF(256), the reed-solomon generator ----------------
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var j = 0; j < degree; j++) {
      for (var k = 0; k < result.length; k++) {
        result[k] = gfMul(result[k], root);
        if (k + 1 < result.length) result[k] ^= result[k + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  // ---- how much fits -------------------------------------------------------
  function rawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function dataCodewords(ver) {
    return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];
  }
  function utf8(text) {
    var s = unescape(encodeURIComponent(text));
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  // ---- the bit stream → codewords → interleaved -----------------------------
  function appendBits(bits, val, len) {
    for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  }
  function codewords(bytes, ver) {
    var bits = [];
    appendBits(bits, 4, 4); // byte mode
    appendBits(bits, bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(function (b) { appendBits(bits, b, 8); });
    var capacity = dataCodewords(ver) * 8;
    appendBits(bits, 0, Math.min(4, capacity - bits.length));
    appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
    for (var pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    return data;
  }
  function interleave(data, ver) {
    var numBlocks = BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver];
    var rawCodewords = Math.floor(rawDataModules(ver) / 8);
    var numShort = numBlocks - (rawCodewords % numBlocks);
    var shortLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [], gen = rsDivisor(eccLen), k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var len = shortLen - eccLen + (i < numShort ? 0 : 1);
      var dat = data.slice(k, k + len);
      k += len;
      var ecc = rsRemainder(dat, gen);
      if (i < numShort) dat.push(0); // a hole where the long blocks have one more
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (var c = 0; c < blocks[0].length; c++) {
      blocks.forEach(function (block, j) {
        if (c !== shortLen - eccLen || j >= numShort) result.push(block[c]);
      });
    }
    return result;
  }

  // ---- the matrix ----------------------------------------------------------
  function Matrix(size) {
    this.size = size;
    this.m = []; this.f = []; // modules, and which of them are function patterns
    for (var i = 0; i < size * size; i++) { this.m.push(false); this.f.push(false); }
  }
  Matrix.prototype.set = function (x, y, dark, isFunction) {
    this.m[y * this.size + x] = dark;
    if (isFunction) this.f[y * this.size + x] = true;
  };
  Matrix.prototype.get = function (x, y) { return this.m[y * this.size + x]; };

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    var num = Math.floor(ver / 7) + 2;
    var size = ver * 4 + 17;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < num; pos -= step) result.splice(1, 0, pos);
    return result;
  }
  function drawFinder(mx, cx, cy) {
    for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
      var d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < mx.size && y >= 0 && y < mx.size) mx.set(x, y, d !== 2 && d !== 4, true);
    }
  }
  function drawAlignment(mx, cx, cy) {
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) mx.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
  }
  function drawFormat(mx, mask) {
    var data = (FORMAT_M << 3) | mask; // level M is 00
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    var n = mx.size, b = function (i) { return ((bits >>> i) & 1) !== 0; };
    for (i = 0; i <= 5; i++) mx.set(8, i, b(i), true);
    mx.set(8, 7, b(6), true); mx.set(8, 8, b(7), true); mx.set(7, 8, b(8), true);
    for (i = 9; i < 15; i++) mx.set(14 - i, 8, b(i), true);
    for (i = 0; i < 8; i++) mx.set(n - 1 - i, 8, b(i), true);
    for (i = 8; i < 15; i++) mx.set(8, n - 15 + i, b(i), true);
    mx.set(8, n - 8, true, true); // always dark
  }
  function drawVersion(mx, ver) {
    if (ver < 7) return;
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bits = (ver << 12) | rem, n = mx.size;
    for (i = 0; i < 18; i++) {
      var bit = ((bits >>> i) & 1) !== 0, a = n - 11 + (i % 3), b = Math.floor(i / 3);
      mx.set(a, b, bit, true); mx.set(b, a, bit, true);
    }
  }
  function drawFunctions(mx, ver) {
    var n = mx.size;
    for (var i = 0; i < n; i++) { mx.set(6, i, i % 2 === 0, true); mx.set(i, 6, i % 2 === 0, true); }
    drawFinder(mx, 3, 3); drawFinder(mx, n - 4, 3); drawFinder(mx, 3, n - 4);
    var pos = alignmentPositions(ver), num = pos.length;
    for (i = 0; i < num; i++) for (var j = 0; j < num; j++) {
      if (!((i === 0 && j === 0) || (i === 0 && j === num - 1) || (i === num - 1 && j === 0))) drawAlignment(mx, pos[i], pos[j]);
    }
    drawFormat(mx, 0); // a placeholder: marks the modules as taken
    drawVersion(mx, ver);
  }
  function drawData(mx, data) {
    var n = mx.size, i = 0;
    for (var right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < n; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? n - 1 - vert : vert;
          if (!mx.f[y * n + x] && i < data.length * 8) {
            mx.set(x, y, ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0, false);
            i++;
          }
        }
      }
    }
  }
  function applyMask(mx, mask) {
    var n = mx.size;
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      var invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (!mx.f[y * n + x] && invert) mx.m[y * n + x] = !mx.m[y * n + x];
    }
  }
  function penalty(mx) {
    var n = mx.size, result = 0, x, y;
    function finderRuns(history) {
      var core = history[1] > 0 && history[2] === history[1] && history[3] === history[1] * 3 && history[4] === history[1] && history[5] === history[1];
      return (core && history[0] >= history[1] * 4 && history[6] >= history[1] ? 1 : 0) + (core && history[6] >= history[1] * 4 && history[0] >= history[1] ? 1 : 0);
    }
    function pushRun(history, len) { if (history[0] === 0) len += n; history.pop(); history.unshift(len); }
    function finderTerminate(dark, run, history) { if (dark) { pushRun(history, run); run = 0; } run += n; pushRun(history, run); return finderRuns(history); }
    for (y = 0; y < n; y++) {
      var runColor = false, runX = 0, hist = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < n; x++) {
        if (mx.get(x, y) === runColor) { runX++; if (runX === 5) result += 3; else if (runX > 5) result++; }
        else { pushRun(hist, runX); if (!runColor) result += finderRuns(hist) * 40; runColor = mx.get(x, y); runX = 1; }
      }
      result += finderTerminate(runColor, runX, hist) * 40;
    }
    for (x = 0; x < n; x++) {
      var runColorV = false, runY = 0, histV = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < n; y++) {
        if (mx.get(x, y) === runColorV) { runY++; if (runY === 5) result += 3; else if (runY > 5) result++; }
        else { pushRun(histV, runY); if (!runColorV) result += finderRuns(histV) * 40; runColorV = mx.get(x, y); runY = 1; }
      }
      result += finderTerminate(runColorV, runY, histV) * 40;
    }
    for (y = 0; y < n - 1; y++) for (x = 0; x < n - 1; x++) {
      var c = mx.get(x, y);
      if (c === mx.get(x + 1, y) && c === mx.get(x, y + 1) && c === mx.get(x + 1, y + 1)) result += 3;
    }
    var dark = 0;
    mx.m.forEach(function (d) { if (d) dark++; });
    var total = n * n, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * 10;
  }

  AH.qr = function (text) {
    var bytes = utf8(text), ver = -1;
    for (var v = 1; v <= 40; v++) {
      var bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (bits <= dataCodewords(v) * 8) { ver = v; break; }
    }
    if (ver < 0) throw new Error("too long for a qr code");
    var data = interleave(codewords(bytes, ver), ver);
    var mx = new Matrix(ver * 4 + 17);
    drawFunctions(mx, ver);
    drawData(mx, data);
    var best = 0, bestPenalty = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      applyMask(mx, mask); drawFormat(mx, mask);
      var p = penalty(mx);
      if (p < bestPenalty) { bestPenalty = p; best = mask; }
      applyMask(mx, mask); // undo: xor twice
    }
    applyMask(mx, best); drawFormat(mx, best);
    return { size: mx.size, version: ver, mask: best, get: function (x, y) { return mx.get(x, y); } };
  };
})();

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
