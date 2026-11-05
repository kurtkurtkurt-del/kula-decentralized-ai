// A qr code by hand, the server side twin of web/passport/qr.js (same algorithm,
// same output): byte mode, level M, the smallest version that fits, the mask
// with the lowest penalty. The dashboard draws the pairing code from this so
// the secret never travels to the page as text; the browser only gets an svg.
// Written after ISO 18004 the way everybody writes it (Nayuki's qrcodegen is
// the clearest reference).

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_M = 0;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  let root = 1;
  for (let j = 0; j < degree; j++) {
    for (let k = 0; k < result.length; k++) {
      result[k] = gfMul(result[k], root);
      if (k + 1 < result.length) result[k] ^= result[k + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];
}

function appendBits(bits: number[], val: number, len: number) {
  for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
}
function codewords(bytes: number[], ver: number): number[] {
  const bits: number[] = [];
  appendBits(bits, 4, 4);
  appendBits(bits, bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) appendBits(bits, b, 8);
  const capacity = dataCodewords(ver) * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  return data;
}
function interleave(data: number[], ver: number): number[] {
  const numBlocks = BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  const gen = rsDivisor(eccLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, gen);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let c = 0; c < blocks[0].length; c++) {
    blocks.forEach((block, j) => { if (c !== shortLen - eccLen || j >= numShort) result.push(block[c]); });
  }
  return result;
}

class Matrix {
  m: boolean[];
  f: boolean[];
  constructor(public size: number) {
    this.m = new Array(size * size).fill(false);
    this.f = new Array(size * size).fill(false);
  }
  set(x: number, y: number, dark: boolean, isFunction: boolean) {
    this.m[y * this.size + x] = dark;
    if (isFunction) this.f[y * this.size + x] = true;
  }
  get(x: number, y: number): boolean { return this.m[y * this.size + x]; }
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const num = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < num; pos -= step) result.splice(1, 0, pos);
  return result;
}
function drawFinder(mx: Matrix, cx: number, cy: number) {
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
    if (x >= 0 && x < mx.size && y >= 0 && y < mx.size) mx.set(x, y, d !== 2 && d !== 4, true);
  }
}
function drawAlignment(mx: Matrix, cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mx.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
}
function drawFormat(mx: Matrix, mask: number) {
  const data = (FORMAT_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const n = mx.size, b = (i: number) => ((bits >>> i) & 1) !== 0;
  let i;
  for (i = 0; i <= 5; i++) mx.set(8, i, b(i), true);
  mx.set(8, 7, b(6), true); mx.set(8, 8, b(7), true); mx.set(7, 8, b(8), true);
  for (i = 9; i < 15; i++) mx.set(14 - i, 8, b(i), true);
  for (i = 0; i < 8; i++) mx.set(n - 1 - i, 8, b(i), true);
  for (i = 8; i < 15; i++) mx.set(8, n - 15 + i, b(i), true);
  mx.set(8, n - 8, true, true);
}
function drawVersion(mx: Matrix, ver: number) {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem, n = mx.size;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0, a = n - 11 + (i % 3), b = Math.floor(i / 3);
    mx.set(a, b, bit, true); mx.set(b, a, bit, true);
  }
}
function drawFunctions(mx: Matrix, ver: number) {
  const n = mx.size;
  for (let i = 0; i < n; i++) { mx.set(6, i, i % 2 === 0, true); mx.set(i, 6, i % 2 === 0, true); }
  drawFinder(mx, 3, 3); drawFinder(mx, n - 4, 3); drawFinder(mx, 3, n - 4);
  const pos = alignmentPositions(ver), num = pos.length;
  for (let i = 0; i < num; i++) for (let j = 0; j < num; j++) {
    if (!((i === 0 && j === 0) || (i === 0 && j === num - 1) || (i === num - 1 && j === 0))) drawAlignment(mx, pos[i], pos[j]);
  }
  drawFormat(mx, 0);
  drawVersion(mx, ver);
}
function drawData(mx: Matrix, data: number[]) {
  const n = mx.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? n - 1 - vert : vert;
        if (!mx.f[y * n + x] && i < data.length * 8) {
          mx.set(x, y, ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0, false);
          i++;
        }
      }
    }
  }
}
function applyMask(mx: Matrix, mask: number) {
  const n = mx.size;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let invert: boolean;
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
function penalty(mx: Matrix): number {
  const n = mx.size;
  let result = 0;
  const finderRuns = (h: number[]) => {
    const core = h[1] > 0 && h[2] === h[1] && h[3] === h[1] * 3 && h[4] === h[1] && h[5] === h[1];
    return (core && h[0] >= h[1] * 4 && h[6] >= h[1] ? 1 : 0) + (core && h[6] >= h[1] * 4 && h[0] >= h[1] ? 1 : 0);
  };
  const pushRun = (h: number[], len: number) => { if (h[0] === 0) len += n; h.pop(); h.unshift(len); };
  const finderTerminate = (dark: boolean, run: number, h: number[]) => { if (dark) { pushRun(h, run); run = 0; } run += n; pushRun(h, run); return finderRuns(h); };
  for (let y = 0; y < n; y++) {
    let runColor = false, runX = 0;
    const hist = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < n; x++) {
      if (mx.get(x, y) === runColor) { runX++; if (runX === 5) result += 3; else if (runX > 5) result++; }
      else { pushRun(hist, runX); if (!runColor) result += finderRuns(hist) * 40; runColor = mx.get(x, y); runX = 1; }
    }
    result += finderTerminate(runColor, runX, hist) * 40;
  }
  for (let x = 0; x < n; x++) {
    let runColor = false, runY = 0;
    const hist = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < n; y++) {
      if (mx.get(x, y) === runColor) { runY++; if (runY === 5) result += 3; else if (runY > 5) result++; }
      else { pushRun(hist, runY); if (!runColor) result += finderRuns(hist) * 40; runColor = mx.get(x, y); runY = 1; }
    }
    result += finderTerminate(runColor, runY, hist) * 40;
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = mx.get(x, y);
    if (c === mx.get(x + 1, y) && c === mx.get(x, y + 1) && c === mx.get(x + 1, y + 1)) result += 3;
  }
  let dark = 0;
  for (const d of mx.m) if (d) dark++;
  const total = n * n, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * 10;
}

export interface Qr { size: number; version: number; mask: number; get(x: number, y: number): boolean }

export function qr(text: string): Qr {
  const bytes = [...Buffer.from(text, 'utf8')];
  let ver = -1;
  for (let v = 1; v <= 40; v++) {
    const bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCodewords(v) * 8) { ver = v; break; }
  }
  if (ver < 0) throw new Error('too long for a qr code');
  const data = interleave(codewords(bytes, ver), ver);
  const mx = new Matrix(ver * 4 + 17);
  drawFunctions(mx, ver);
  drawData(mx, data);
  let best = 0, bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mx, mask); drawFormat(mx, mask);
    const p = penalty(mx);
    if (p < bestPenalty) { bestPenalty = p; best = mask; }
    applyMask(mx, mask);
  }
  applyMask(mx, best); drawFormat(mx, best);
  return { size: mx.size, version: ver, mask: best, get: (x, y) => mx.get(x, y) };
}

// The code as an svg document: one path, four modules of quiet zone, crisp edges.
export function qrSvg(text: string, dark = '#1f1a14', light = '#ffffff'): string {
  const q = qr(text);
  const n = q.size, pad = 4, s = n + pad * 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.get(x, y)) d += `M${x + pad} ${y + pad}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges"><rect width="${s}" height="${s}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
