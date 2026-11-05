import Storage from 'expo-sqlite/kv-store';
import type { Message } from '@/llm/native';

// Where the night's work comes from (5.11.2026). A night is cut into units: one prompt,
// a cap on tokens, and now and then a known answer. The worker (LlamaWorker.ts) takes
// units one by one, hands them to a free device and gives the result back here.
//
// v0 has no server side for this: DemoJobs is a bundled list of ~60 short, harmless prompts
// in three kinds (classify, summarise, translate) and keeps the results on the phone, in the
// kv-store under night.results. ServerJobs is the shape of what comes next and throws
// 'notyet'. The contribution itself (start, end, the card) still goes through the server
// as before; only the work is local for now.
// 'project' (5.11.2026): a step of the person's own project (tasks/jobs.ts), with its own
// messages, a longer budget and own: true, so it is not counted on the network's card.
export type UnitType = 'classify' | 'summarise' | 'translate' | 'project';
export type Unit = {
  id: string;
  type: UnitType;
  prompt: string;
  maxTokens: number;
  // the known answer, for a share of the classify units (about 1 in 8): the trust idea.
  // A device whose known answers come out wrong is not trusted with the rest of the night.
  expected?: string;
  messages?: Message[]; // the whole conversation, instead of SYSTEM[type] + prompt
  temperature?: number; // 0 unless given
  own?: boolean; // the person's own work: not the network's units, tokens or card
};
export type UnitResult = { text: string; device: string; tokens: number; ms: number; ok?: boolean };
export interface JobSource {
  next(): Promise<Unit | null>;
  done(unit: Unit, result: UnitResult): Promise<void>;
  // a unit a device could not finish goes back on the pile for the next free device
  retry?(unit: Unit): Promise<void>;
}

// The instruction the model sees in front of every unit of a kind: one word, one
// sentence, one line, so the small models used at night do not wander.
export const SYSTEM: Record<UnitType, string> = {
  classify: 'Answer with exactly one lowercase word and nothing else.',
  summarise: 'Summarise the text in one short sentence. No preamble.',
  translate: 'Translate the line. Answer with the translation only.',
  project: 'You are a helpful assistant.',
};

// Was a known answer met? The first word of the reply, lowercased, without punctuation.
export function checkAnswer(expected: string, text: string): boolean {
  const first = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/)[0] ?? '';
  return first === expected.toLowerCase();
}

const C = (i: number, text: string, kind: 'sentiment' | 'topic', expected?: string): Unit => ({
  id: `demo-c${i}`,
  type: 'classify',
  prompt: kind === 'sentiment' ? `Is the sentiment of this text positive or negative?\n\n"${text}"` : `Which topic is this text about: sports, weather, food, travel, work or music?\n\n"${text}"`,
  maxTokens: 4,
  ...(expected ? { expected } : {}),
});
const S = (i: number, text: string): Unit => ({ id: `demo-s${i}`, type: 'summarise', prompt: text, maxTokens: 40 });
const T = (i: number, to: 'tr' | 'de', text: string): Unit => ({ id: `demo-t${i}`, type: 'translate', prompt: `English to ${to === 'tr' ? 'Turkish' : 'German'}:\n${text}`, maxTokens: 40 });

/** The bundled units: 24 classify (8 with a known answer), 20 summarise, 16 translate. */
export const DEMO_UNITS: Unit[] = [
  C(1, 'The soup was warm and the bread fresh out of the oven.', 'sentiment', 'positive'),
  C(2, 'The train left twenty minutes late and the heating was off.', 'sentiment', 'negative'),
  C(3, 'She finished the book in one sitting and ordered the sequel.', 'sentiment'),
  C(4, 'The paint peeled after a week and the shop would not take it back.', 'sentiment'),
  C(5, 'The park was quiet, the light was soft, and nobody was in a hurry.', 'sentiment', 'positive'),
  C(6, 'The printer jammed three times before the meeting.', 'sentiment'),
  C(7, 'Our neighbours brought cake to welcome us to the building.', 'sentiment'),
  C(8, 'The app crashed every time I opened the camera.', 'sentiment', 'negative'),
  C(9, 'The hike was long but the view from the top made up for it.', 'sentiment'),
  C(10, 'The wifi dropped out during the whole call.', 'sentiment'),
  C(11, 'The garden came back greener than last spring.', 'sentiment'),
  C(12, 'The refund arrived two days early.', 'sentiment'),
  C(13, 'The striker scored twice in the last ten minutes.', 'topic', 'sports'),
  C(14, 'Heavy rain is expected on the coast until Thursday.', 'topic', 'weather'),
  C(15, 'Let the dough rest for an hour before you shape the loaves.', 'topic'),
  C(16, 'The night train to Vienna has a dining car again.', 'topic'),
  C(17, 'The quarterly review moved to Monday morning.', 'topic', 'work'),
  C(18, 'The band plays the small stage at nine, then the choir.', 'topic', 'music'),
  C(19, 'Fog in the valley, clear skies above two thousand metres.', 'topic'),
  C(20, 'The marathon route crosses the old bridge twice.', 'topic'),
  C(21, 'Roast the peppers until the skin blisters.', 'topic'),
  C(22, 'Our flight connects through Istanbul with a three-hour stop.', 'topic'),
  C(23, 'The new intern starts in the design team next week.', 'topic'),
  C(24, 'The second movement is slower than the recording suggests.', 'topic'),
  S(1, 'The library extends its opening hours in winter. From November it stays open until nine on weekdays. The reading rooms on the second floor remain closed for renovation.'),
  S(2, 'A small bakery on the corner started selling bread made from old grain varieties. The owner says the flour comes from a farm forty kilometres away. The loaves sell out by noon.'),
  S(3, 'The city council voted to plant six hundred trees along the river. Work begins in spring. Residents can propose streets for the next round.'),
  S(4, 'Our football club lost the final on penalties. The young goalkeeper saved two shots. The crowd stayed to applaud after the whistle.'),
  S(5, 'The museum returns a bronze figure to its country of origin. It had been in the collection since 1911. A copy will stay in the exhibition.'),
  S(6, 'A school in the hills runs on solar power since last year. The panels cover the gym roof. On sunny days the surplus goes to the village.'),
  S(7, 'The ferry across the lake runs every hour in summer and every two hours in winter. Bicycles travel free. Dogs need a ticket.'),
  S(8, 'A community kitchen opened in the old post office. Volunteers cook lunch three days a week. Anyone can eat; those who can pay leave something in the jar.'),
  S(9, 'The tram line to the airport is finished a year early. Tickets cost the same as a city ticket. The last tram leaves after midnight.'),
  S(10, 'An orchard on the edge of town lets people pick their own apples in October. The farmer lends baskets. Pressing juice costs two euros a bottle.'),
  S(11, 'The repair café meets on the first Saturday of the month. Bring a broken toaster, a lamp or a bicycle. Coffee is free, parts cost what they cost.'),
  S(12, 'The weather station on the hill has measured for a hundred years. The warmest October on record was last year. The staff still read the instruments by hand each morning.'),
  S(13, 'A choir for people who think they cannot sing meets on Tuesdays. There is no audition. They perform once a year in the market square.'),
  S(14, 'The old cinema reopens with one screen and a café. It shows films in the original language. Tuesdays are half price.'),
  S(15, 'The night bus now stops at the hospital. Nurses on the late shift asked for it for years. The first bus ran on Monday.'),
  S(16, 'A beekeeper keeps twelve hives on the roof of the town hall. The honey is sold at the reception. The money pays for flowers in the parks.'),
  S(17, 'The swimming pool heats its water with waste heat from the data centre next door. The water is two degrees warmer than before. The bill is lower.'),
  S(18, 'A bookshop lends out tools as well as books. The drill is the most borrowed item. Members pay ten euros a year.'),
  S(19, 'The village has a free shelf by the bus stop. People leave jars, books and seeds. Nobody keeps a list.'),
  S(20, 'The bridge closes for repairs for six weeks. A footbridge stays open. Buses take the long way round.'),
  T(1, 'tr', 'The kettle is on the left, the cups are above the sink.'),
  T(2, 'tr', 'We meet at the station at seven.'),
  T(3, 'tr', 'The road is closed after the bridge.'),
  T(4, 'tr', 'Please leave the key with the neighbour.'),
  T(5, 'tr', 'The market opens early on Saturdays.'),
  T(6, 'tr', 'My phone charges all night and works for a project.'),
  T(7, 'tr', 'The soup needs a little more salt.'),
  T(8, 'tr', 'The last bus leaves at midnight.'),
  T(9, 'de', 'The window does not close properly.'),
  T(10, 'de', 'There is fresh bread on the table.'),
  T(11, 'de', 'We walked to the lake and back.'),
  T(12, 'de', 'The meeting is moved to Thursday.'),
  T(13, 'de', 'The garden needs water in the evening.'),
  T(14, 'de', 'Her bicycle has a flat tyre.'),
  T(15, 'de', 'The museum is free on the first Sunday.'),
  T(16, 'de', 'Turn left after the bakery.'),
];

const RESULTS = 'night.results';
const KEEP = 500; // results kept on the phone, newest last
export type StoredResult = UnitResult & { id: string; type: UnitType; at: string };
export function storedResults(): StoredResult[] {
  try {
    return JSON.parse(Storage.getItemSync(RESULTS) ?? '[]') as StoredResult[];
  } catch {
    return [];
  }
}
export const clearResults = () => Storage.removeItemSync(RESULTS);

/** The bundled list, each unit once, in order; a retried unit goes to the front. */
export class DemoJobs implements JobSource {
  private pile: Unit[];
  constructor(units: Unit[] = DEMO_UNITS) {
    this.pile = [...units];
  }
  left() {
    return this.pile.length;
  }
  async next() {
    return this.pile.shift() ?? null;
  }
  async retry(unit: Unit) {
    this.pile.unshift(unit);
  }
  async done(unit: Unit, result: UnitResult) {
    const all = storedResults();
    all.push({ id: unit.id, type: unit.type, at: new Date().toISOString(), ...result });
    try {
      Storage.setItemSync(RESULTS, JSON.stringify(all.slice(-KEEP)));
    } catch {}
  }
}

/** Several sources, one pile: next() asks them in order, done and retry go back to the
 * source a unit came from. The night puts the person's projects first (5.11.2026). */
export class FirstOf implements JobSource {
  private from = new Map<string, JobSource>();
  constructor(private sources: JobSource[]) {}
  async next() {
    for (const s of this.sources) {
      const u = await s.next().catch(() => null);
      if (u) {
        this.from.set(u.id, s);
        return u;
      }
    }
    return null;
  }
  async done(unit: Unit, result: UnitResult) {
    const s = this.from.get(unit.id);
    this.from.delete(unit.id);
    await s?.done(unit, result);
  }
  async retry(unit: Unit) {
    const s = this.from.get(unit.id);
    this.from.delete(unit.id);
    await s?.retry?.(unit);
  }
}

/** The server's units: not yet. It will call `night_unit_next(p_contribution)` for a unit
 * and `night_unit_done(p_unit, p_text, p_device, p_tokens, p_ms)` for the result, through
 * the outbox so a result survives a dropout; until that rpc exists, 'notyet'. */
export class ServerJobs implements JobSource {
  constructor(public readonly contributionId: string | null) {}
  async next(): Promise<Unit | null> {
    throw new Error('notyet');
  }
  async done(): Promise<void> {
    throw new Error('notyet');
  }
}
