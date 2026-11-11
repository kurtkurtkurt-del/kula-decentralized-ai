// What comes from another home is read as plain data and kept only if it is exactly one of the
// shapes in types.ts. Anything else is dropped whole, not repaired.
import { RINGS, type NetMessage, type Offer, type Piece, type Ring } from './types.js';

const str = (x: unknown, max = 200): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const nat = (x: unknown): x is number => num(x) && x >= 0 && Number.isInteger(x);
const ring = (x: unknown): x is Ring => RINGS.includes(x as Ring);
const strs = (x: unknown, max = 64): x is string[] => Array.isArray(x) && x.length <= max && x.every((s) => str(s));
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export const MAX_PIECES = 10_000;
export const MAX_INPUT = 256 * 1024;

function piece(p: unknown): p is Piece {
  return obj(p) && str(p.id) && str(p.job) && str(p.home) && ring(p.ring) && num(p.modelB) && p.modelB > 0
    && str(p.model, 128) && num(p.units) && p.units > 0 && nat(p.deadline);
}
function offerDevices(d: unknown): d is Offer['devices'] {
  return Array.isArray(d) && d.length <= 64 && d.every((x) => obj(x) && str(x.id) && num(x.maxB) && num(x.rate) && num(x.units) && x.units >= 0);
}

export function parseMessage(x: unknown): NetMessage | null {
  if (!obj(x) || x.v !== 1) return null;
  switch (x.type) {
    case 'offer':
      return str(x.id) && str(x.home) && nat(x.at) && nat(x.from) && nat(x.to) && x.to > x.from && ring(x.ring)
        && num(x.gift) && x.gift >= 0 && x.gift <= 1 && offerDevices(x.devices) ? (x as unknown as NetMessage) : null;
    case 'ask':
      return str(x.id) && str(x.home) && nat(x.at) && typeof x.title === 'string' && x.title.length <= 200
        && Array.isArray(x.pieces) && x.pieces.length <= MAX_PIECES && x.pieces.every((p) => piece(p) && p.home === x.home && p.job === x.id)
        ? (x as unknown as NetMessage) : null;
    case 'grant':
      return str(x.piece) && str(x.job) && nat(x.copy) && str(x.asker) && str(x.home) && str(x.device) && nat(x.at) && nat(x.due)
        && num(x.units) && strs(x.path, 8) && typeof x.gift === 'boolean' ? (x as unknown as NetMessage) : null;
    case 'work':
      return str(x.piece) && nat(x.copy) && str(x.device) && str(x.model, 128) && typeof x.input === 'string' && x.input.length <= MAX_INPUT
        && nat(x.seed) ? (x as unknown as NetMessage) : null;
    case 'result':
      return str(x.piece) && nat(x.copy) && str(x.device) && str(x.home) && nat(x.at) && str(x.digest, 128) ? (x as unknown as NetMessage) : null;
    case 'warn':
      return str(x.by) && str(x.device) && str(x.home) && nat(x.at) && (x.why === 'wrong' || x.why === 'outvoted')
        && strs(x.evidence, 8) ? (x as unknown as NetMessage) : null;
    default:
      return null;
  }
}

/** What a home in ring `rel` may be told of an ask: the world never sees the title or the pieces it may not take. */
export function askFor<T extends { title: string; pieces: Piece[] }>(ask: T, rel: Ring): T {
  const pieces = ask.pieces.filter((p) => RINGS.indexOf(rel) <= RINGS.indexOf(p.ring));
  return { ...ask, title: rel === 'world' ? '' : ask.title, pieces };
}
