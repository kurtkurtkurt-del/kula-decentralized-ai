// The brain only suggests. Every step that lets work leave the home, or lets another home's work in,
// is a card the person answers: offer tonight's phones, send a project's pieces out and how far,
// stop working for someone, give back to a friend first. A card's choices are words the person
// taps; kula's engine carries out the tap, the brain never does.
import type { Ring, Units } from './types.js';

export interface NetCard {
  id: string;                      // "net:<topic>[:<subject>]", stable while its reason holds
  kind: 'suggest' | 'warn';
  title: string;
  why: string;
  choices: string[];               // first is the brain's suggestion
  weight: 1 | 2 | 3;
}

export interface CardInput {
  now: number;
  /** tonight's idle window the forecast saw, or null */
  idle: null | { from: number; to: number; devices: number; maxB: number; ring: Ring };
  /** projects waiting for the person's word on how far their pieces may go */
  asks: { job: string; title: string; pieces: number; world: number; circle: number; home: number }[];
  /** devices this home just stopped taking work from */
  caught: { device: string; name: string; home: string; why: 'wrong' | 'outvoted'; recalled: number }[];
  /** friends this home owes the most, and how much */
  owe: { home: string; name: string; units: Units }[];
  /** homes that took much and gave little back, past their room */
  takers: { home: string; name: string; units: Units }[];
}

const hm = (ms: number) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const ringWord: Record<Ring, string> = { home: 'only this home', circle: 'your circle (friends)', world: 'anyone' };

export function netCards(x: CardInput): NetCard[] {
  const cards: NetCard[] = [];
  for (const c of x.caught) {
    cards.push({
      id: `net:caught:${c.device}`, kind: 'warn', weight: 3,
      title: `${c.name} gave a wrong answer`,
      why: `${c.why === 'wrong' ? 'It answered a question this home already knew the answer to, and got it wrong.' : 'It answered twice against two others who agreed.'} No more work goes to its home; ${c.recalled} of its unchecked pieces run again.`,
      choices: ['tell my circle', 'only note it'],
    });
  }
  for (const a of x.asks) {
    const out = a.world + a.circle;
    cards.push({
      id: `net:ask:${a.job}`, kind: 'suggest', weight: 2,
      title: `${a.title}: ${a.pieces} pieces, ${out} may go out`,
      why: `${a.home} stay on this home’s devices. ${a.circle} may go to friends. ${a.world} may go to anyone whose night it is: they read those in plain text.`,
      choices: a.world > 0 ? ['send them out', 'friends only', 'keep all at home'] : a.circle > 0 ? ['send to friends', 'keep all at home'] : ['run at home tonight'],
    });
  }
  if (x.idle) {
    const i = x.idle;
    cards.push({
      id: 'net:offer', kind: 'suggest', weight: 2,
      title: `${i.devices} device${i.devices === 1 ? '' : 's'} idle ${hm(i.from)}–${hm(i.to)}: lend them?`,
      why: `They will be charging and unused, up to ${i.maxB}B models. Work would come from ${ringWord[i.ring]}; your own work always goes first.${x.owe[0] ? ` ${x.owe[0].name} is owed most and would be served first.` : ''}`,
      choices: i.ring === 'world' ? ['lend to anyone', 'friends only', 'not tonight'] : ['lend to friends', 'not tonight'],
    });
  }
  for (const o of x.owe.slice(0, 2)) {
    if (o.units <= 0) continue;
    cards.push({
      id: `net:owe:${o.home}`, kind: 'suggest', weight: 1,
      title: `${o.name} did ${Math.round(o.units)} units more for you`,
      why: 'Their work goes first on your devices until it evens out. Nothing to do unless you want to give more.',
      choices: ['ok'],
    });
  }
  for (const t of x.takers.slice(0, 2)) {
    cards.push({
      id: `net:taker:${t.home}`, kind: 'warn', weight: 1,
      title: `${t.name} took ${Math.round(t.units)} units more than it gave`,
      why: 'It is past the room your trust gave it; it now only gets the gift share, after everyone else.',
      choices: ['keep it so', 'give it more room'],
    });
  }
  return cards.sort((a, b) => b.weight - a.weight);
}
