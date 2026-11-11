// The giving brain's choice: of all the copies waiting that it heard of, which ones its idle devices
// take. It runs on the giver's side because the devices are the giver's; the asker checks every
// grant again (allowed()) before it sends a word of content.
//
// Order: this home's own work first, then the homes it owes (debts are paid first, whoever they
// are), then the homes with most room on credit (friends, friends of friends), then strangers from
// the gift share. That is BitTorrent's tit for tat with an optimistic share for newcomers, counted
// in signed receipts instead of upload speed. A gift is a try, not a living: a home that already
// owes this giver GIFT_CAP units gets no more gifts from it until it gives something back.
import { within, type Grant, type Offer, type Ring, type Task, type Units } from './types.js';
import type { Room } from './credit.js';
import { coin } from './verify.js';

/** What the giver knows about each asker: how far it is (its ring) and the room it has on credit. */
export interface GiverView {
  rel: Record<string, Ring>;       // asker → home, circle (the giver trusts it) or world
  room: Record<string, Room>;      // asker → room on credit, from credit.room()
  /** how far each asker is from the giver, as the asker sees it (does the asker trust the giver?) */
  back: Record<string, Ring>;
  /** the direct balance with each asker, credit.owed(g, giver, asker): positive, the asker owes the
   *  giver; negative, the giver owes the asker (and pays that first) */
  balance?: Record<string, Units>;
  /** homes the giver no longer works for (one of their devices lied to it) */
  refuse?: string[];
  /** strangers' work, and work to strangers: off. The person decided (11.11.2026) that only their
   *  own and their friends' devices take part; true only for a "what if" study like the simulation */
  worldOpen?: boolean;
}

export const HOUR = 3_600_000;
export const GIFT_CAP: Units = 24;   // what a stranger may owe one giver in gifts: a piece or two

/** May this copy go to this home at all? Both sides' rings, and the home is not excluded. */
export function allowed(task: Task, offer: Offer, view: GiverView): boolean {
  const asker = task.piece.home;
  const rel = view.rel[asker] ?? 'world';
  const back = view.back[asker] ?? 'world';
  if (!view.worldOpen && (rel === 'world' || back === 'world')) return false;   // no strangers (11.11.2026)
  if (!within(back, task.piece.ring)) return false;      // the asker's piece may not travel this far
  if (!within(rel, offer.ring)) return false;            // the giver does not take work from this far
  if (task.exclude.includes(offer.home)) return false;
  if (view.refuse?.includes(asker)) return false;
  return true;
}

/** Grants for one offer. Pure: the offer and tasks are not changed; the same inputs give the same grants. */
export function match(offer: Offer, tasks: Task[], view: GiverView, now: number): Grant[] {
  if (now < offer.from || now >= offer.to) return [];
  const left = new Map(offer.devices.map((d) => [d.id, d.units] as [string, Units]));
  const total = offer.devices.reduce((s, d) => s + d.units, 0);
  let gift = Math.floor(total * Math.min(1, Math.max(0, offer.gift)));
  const room = new Map(Object.entries(view.room).map(([k, r]) => [k, r.units] as [string, Units]));
  const bal = { ...(view.balance ?? {}) };
  const taken = new Set<string>();                      // one copy of a piece per home
  const grants: Grant[] = [];

  const open = tasks.filter((t) => t.piece.deadline > now && allowed(t, offer, view));
  const askers = [...new Set(open.map((t) => t.piece.home))].sort((a, b) => {
    if (a === offer.home) return -1;
    if (b === offer.home) return 1;
    // equal room (strangers, mostly): a coin per offer, so no name is always first
    return (bal[a] ?? 0) - (bal[b] ?? 0) || (room.get(b) ?? 0) - (room.get(a) ?? 0) || coin(offer.id, a) - coin(offer.id, b) || (a < b ? -1 : 1);
  });

  for (const asker of askers) {
    const mine = open.filter((t) => t.piece.home === asker)
      .sort((x, y) => x.piece.deadline - y.piece.deadline || (x.piece.id < y.piece.id ? -1 : x.piece.id > y.piece.id ? 1 : x.copy - y.copy));
    for (const t of mine) {
      if (taken.has(t.piece.id)) continue;
      const own = asker === offer.home;
      const r = own ? Infinity : room.get(asker) ?? 0;
      const onCredit = r >= t.piece.units;
      if (!own && !onCredit && (gift < t.piece.units || (bal[asker] ?? 0) + t.piece.units > GIFT_CAP)) continue;
      const dev = offer.devices
        .filter((d) => d.maxB >= t.piece.modelB && (left.get(d.id) ?? 0) >= t.piece.units && !t.avoid.includes(d.id))
        .sort((a, b) => (left.get(b.id)! - left.get(a.id)!) || (a.id < b.id ? -1 : 1))[0];
      if (!dev) continue;
      left.set(dev.id, left.get(dev.id)! - t.piece.units);
      if (!own) {
        if (onCredit) room.set(asker, r - t.piece.units);
        else { gift -= t.piece.units; bal[asker] = (bal[asker] ?? 0) + t.piece.units; }
      }
      taken.add(t.piece.id);
      const hours = t.piece.units / Math.max(1, dev.rate);
      grants.push({
        v: 1, type: 'grant', piece: t.piece.id, job: t.piece.job, copy: t.copy,
        asker, home: offer.home, device: dev.id, at: now,
        due: now + Math.max(HOUR, Math.ceil(2 * hours * HOUR)),
        units: t.piece.units,
        path: own ? [] : onCredit ? view.room[asker]?.path ?? [offer.home, asker] : [offer.home, asker],
        gift: !own && !onCredit,
      });
    }
  }
  return grants;
}
