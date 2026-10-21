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
