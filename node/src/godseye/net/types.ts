// beyin-net (11.11.2026): what one home's brain says to another's. docs/BEYIN-NET.md is the
// protocol in words; this folder is the same in code. It imports nothing, not even node's crypto:
// signing, hashing and the clock are handed in, so every function here is pure and gives the same
// answer for the same inputs on a phone, a computer or in a test.
//
// A home is a cell: a model is split only inside a home. Between homes only whole pieces of work
// travel (apart mode), and only to the ring a piece allows.

/** How far something may travel. home: this home's own devices. circle: a home this home trusts
 *  directly (a friend). world: anyone, so whoever runs it reads the prompt in plain text. */
export type Ring = 'home' | 'circle' | 'world';
export const RINGS: Ring[] = ['home', 'circle', 'world'];
export const ringRank = (r: Ring): number => RINGS.indexOf(r);
/** may a thing labelled `allowed` go to someone who is `rel` away? */
export const within = (rel: Ring, allowed: Ring): boolean => ringRank(rel) <= ringRank(allowed);

/** Work is counted in units: a thousand tokens through a one-billion-parameter model. A piece of
 *  2 000 tokens on an 8B model is 16 units. Rough on purpose: it only has to rank and add up. */
export type Units = number;

export interface OfferDevice {
  id: string;                      // the device id (its ledger key, 32 hex)
  maxB: number;                    // the largest model it can run, billions of parameters
  rate: Units;                     // units per hour it managed before (the forecast branch's number)
  units: Units;                    // what it still gives in this window
}

/** "From 01:00 to 06:00 three phones idle, up to 8B, ring: circle." */
export interface Offer {
  v: 1; type: 'offer';
  id: string;
  home: string;                    // the giving home's brain id
  at: number;                      // ms, when it was said
  from: number; to: number;        // ms, the window
  ring: Ring;                      // whose work it takes: home, its circle, or the world
  gift: number;                    // 0..1, the share that may go to homes with no credit here (newcomers)
  devices: OfferDevice[];
}

/** A piece as other homes see it before they take it: what it needs, never what it says. */
export interface Piece {
  id: string;
  job: string;
  home: string;                    // the asking home
  ring: Ring;                      // how far it may travel; set by the person, never widened by a brain
  modelB: number;                  // the model it needs, billions of parameters
  model: string;                   // the model file's sha256 (both copies of a checked piece run the same file)
  units: Units;
  deadline: number;                // ms
}

/** "A project of 200 pieces, 180 of them world-ok." Only the pieces a ring may see go to that ring. */
export interface Ask {
  v: 1; type: 'ask';
  id: string;                      // the job
  home: string;
  at: number;
  title: string;                   // the person's own words, shown to friends only (never to the world)
  pieces: Piece[];
}

/** One copy of a piece waiting for a device. copy 0 is the work; copy 1 is the check. */
export interface Task {
  piece: Piece;
  copy: number;
  exclude: string[];               // homes that may not take it (they hold another copy, or let it lapse)
  avoid: string[];                 // devices the asker no longer takes work from
}

/** The giving brain's yes: this copy runs on this device, by `due`. */
export interface Grant {
  v: 1; type: 'grant';
  piece: string; job: string; copy: number;
  asker: string; home: string; device: string;
  at: number; due: number;
  units: Units;
  /** whose credit carries it, giver first and asker last; [] inside one home */
  path: string[];
  gift: boolean;                   // given from the offer's gift share, not on credit
}

/** The hand-out: only now does the content travel, to the one device granted, over the gate. */
export interface Work {
  v: 1; type: 'work';
  piece: string; copy: number; device: string;
  model: string;                   // sha256 of the model file to use
  input: string;                   // the prompt, in plain text: why the ring matters
  seed: number;                    // decoding is greedy with this seed, so two honest devices agree
}

/** What came back, signed by the device that did it. `digest` is the answer's fingerprint. */
export interface Result {
  v: 1; type: 'result';
  piece: string; copy: number;
  device: string; home: string;
  at: number;
  digest: string;
}

/** "This device lied to me", sent to friends with what proves it. */
export interface Warn {
  v: 1; type: 'warn';
  by: string;                      // the home that caught it
  device: string; home: string;    // who lied
  at: number;
  why: 'wrong' | 'outvoted';             // reputation's outcomes
  evidence: string[];              // the signed result lines and the answer they were held against
}

export type NetMessage = Offer | Ask | Grant | Work | Result | Warn;

/** The trust a person gave: `from` will do up to `limit` units for `to` before anything comes back. */
export interface Trust { from: string; to: string; limit: Units }
