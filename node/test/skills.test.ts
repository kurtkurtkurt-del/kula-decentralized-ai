// Skills (src/ui/static/skills.js, the same module the page imports): the 8 built-in ones, what
// the message box's / means, the / list's order, own skills in this browser's settings, and the
// notes a chat carries (which one is active, and the one leading system message the model gets).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sk = await import('../src/ui/static/skills.js');

const fresh = (o: Record<string, unknown> = {}): any => sk.cleanStore({ temperature: 0.7, ...o });

test('built in: 4 useful and 4 fun, ids unique and slug-shaped, every text at most 1200 chars', () => {
  const b: any[] = sk.BUILTIN as any;
  assert.equal(b.length, 8);
  assert.deepEqual(b.filter((s) => s.kind === 'useful').map((s) => s.id), ['explain', 'proofread', 'summarize', 'translate']);
  assert.deepEqual(b.filter((s) => s.kind === 'fun').map((s) => s.id), ['pirate', 'grandma', 'roast', 'trailer']);
  assert.equal(new Set(b.map((s) => s.id)).size, 8);
  for (const s of b) {
    assert.match(s.id, /^[a-z0-9-]{1,40}$/);
    assert.ok(s.name && s.about && s.text, s.id);
    assert.ok(s.text.length <= 1200, `${s.id}: ${s.text.length}`);
    assert.equal(s.text, s.text.trim(), `${s.id} has no edge whitespace`);
  }
  assert.equal(b.find((s) => s.id === 'translate').name, 'translate tr ⇄ en');
  assert.ok(b.find((s) => s.id === 'pirate').text.startsWith('You are a cheerful old pirate captain.'));
  assert.ok(b.find((s) => s.id === 'trailer').text.includes('"In a world where..."'));
  assert.ok(Object.isFrozen(sk.BUILTIN));
});

test('queryOf: only / and /word open the list', () => {
  assert.equal(sk.queryOf('/'), '');
  assert.equal(sk.queryOf('/pi'), 'pi');
  assert.equal(sk.queryOf('/PI'), 'pi');
  assert.equal(sk.queryOf('/a b'), null);
  assert.equal(sk.queryOf('/a\n'), null);
  assert.equal(sk.queryOf('/usr/bin'), null);
  assert.equal(sk.queryOf('x/'), null);
  assert.equal(sk.queryOf(''), null);
  assert.equal(sk.queryOf(' /pi'), null);
});

test('matches: prefix on id or name first, then substring; useful before fun before own', () => {
  const s = fresh();
  sk.addMine(s, { name: 'pick a song', about: 'a song for the mood', text: 'Suggest one song.' });
  const list = sk.enabled(s);
  // / alone: everything, useful, fun, own
  assert.deepEqual(sk.matches(list, '').map((x: any) => x.id),
    ['explain', 'proofread', 'summarize', 'translate', 'pirate', 'grandma', 'roast', 'trailer', 'pick-a-song']);
  assert.equal(sk.matches(list, 'pi')[0].id, 'pirate');
  // pirate (fun) before pick-a-song (own), both prefix; then trailer, whose about has "epic"
  assert.deepEqual(sk.matches(list, 'pi').map((x: any) => x.id), ['pirate', 'pick-a-song', 'trailer']);
  // "fix" is the name's prefix of proofread
  assert.equal(sk.matches(list, 'fix')[0].id, 'proofread');
  // prefix beats substring: "tr" starts translate and trailer; any other hit only contains it
  const tr = sk.matches(list, 'tr').map((x: any) => x.id);
  assert.deepEqual(tr.slice(0, 2), ['translate', 'trailer']);
  // substring in about only: "bullet" is in summarize's about
  assert.deepEqual(sk.matches(list, 'bullet').map((x: any) => x.id), ['summarize']);
  assert.deepEqual(sk.matches(list, 'zzz'), []);
});

test('own skills: add validates, slugs with -2 on a clash, edit keeps the id, delete removes it', () => {
  const s = fresh();
  assert.deepEqual(sk.addMine(s, { name: '  ', text: 'x' }), { ok: false, error: 'give it a name' });
  assert.deepEqual(sk.addMine(s, { name: 'haiku', text: '  ' }), { ok: false, error: 'write what the model should do' });
  assert.equal(sk.addMine(s, { name: 'haiku', text: 'x'.repeat(4001) }).ok, false);
  const a = sk.addMine(s, { name: 'Haiku!', about: 'three lines', text: 'Answer as a haiku.' });
  assert.equal(a.ok, true);
  assert.equal(a.skill.id, 'haiku');
  assert.equal(sk.addMine(s, { name: 'haiku', text: 'again' }).skill.id, 'haiku-2');
  // a built-in id is taken too
  assert.equal(sk.addMine(s, { name: 'Pirate', text: 'mine' }).skill.id, 'pirate-2');
  assert.equal(sk.slug('Çay saatı ğüş'), 'cay-saati-gus');
  assert.equal(sk.slug('???'), 'skill');
  assert.equal(sk.slug('x'.repeat(60)).length, 40);
  assert.equal(sk.slug('x'.repeat(60), ['x'.repeat(40)]), 'x'.repeat(38) + '-2');
  // caps: name 40, about 120
  const long = sk.addMine(s, { name: 'n'.repeat(50), about: 'a'.repeat(200), text: 't' });
  assert.equal(long.skill.name.length, 40);
  assert.equal(long.skill.about.length, 120);

  const u = sk.updateMine(s, 'haiku', { name: 'haiku poem', about: '', text: 'Answer as a haiku, please.' });
  assert.equal(u.ok, true);
  assert.equal(u.skill.id, 'haiku');
  assert.equal(s.skillsMine.find((m: any) => m.id === 'haiku').text, 'Answer as a haiku, please.');
  assert.equal(sk.updateMine(s, 'haiku', { name: '', text: 'x' }).error, 'give it a name');
  assert.equal(sk.updateMine(s, 'nope', { name: 'a', text: 'b' }).ok, false);

  sk.setOn(s, 'haiku', false);
  assert.equal(sk.removeMine(s, 'haiku'), true);
  assert.equal(sk.removeMine(s, 'haiku'), false);
  assert.equal(sk.removeMine(s, 'pirate'), false, 'built in cannot be deleted');
  assert.ok(!s.skillsMine.some((m: any) => m.id === 'haiku'));
  assert.ok(!s.skillsOff.includes('haiku'));
  assert.ok(sk.allSkills(s).some((x: any) => x.id === 'pirate'));
});

test('own skills: at most 50', () => {
  const s = fresh();
  for (let i = 0; i < 50; i++) assert.equal(sk.addMine(s, { name: `s${i}`, text: 't' }).ok, true);
  const r = sk.addMine(s, { name: 'one more', text: 't' });
  assert.equal(r.ok, false);
  assert.match(r.error, /50/);
  assert.equal(s.skillsMine.length, 50);
});

test('on and off: off hides from the / list, all built in on restores them, own keep their switch', () => {
  const s = fresh();
  sk.addMine(s, { name: 'haiku', text: 'h' });
  sk.setOn(s, 'pirate', false);
  sk.setOn(s, 'haiku', false);
  sk.setOn(s, 'nope', false);
  assert.deepEqual(s.skillsOff, ['pirate', 'haiku']);
  const ids = sk.enabled(s).map((x: any) => x.id);
  assert.ok(!ids.includes('pirate') && !ids.includes('haiku'));
  assert.equal(sk.allSkills(s).find((x: any) => x.id === 'pirate').on, false);
  assert.equal(sk.allSkills(s).find((x: any) => x.id === 'haiku').kind, 'mine');
  assert.equal(sk.allSkills(s).find((x: any) => x.id === 'pirate').builtin, true);
  assert.deepEqual(sk.matches(sk.enabled(s), 'pi').map((x: any) => x.id), ['trailer']);
  sk.setOn(s, 'pirate', false);
  assert.deepEqual(s.skillsOff, ['haiku', 'pirate'], 'no duplicates');
  sk.allBuiltinOn(s);
  assert.deepEqual(s.skillsOff, ['haiku']);
  sk.setOn(s, 'haiku', true);
  assert.deepEqual(s.skillsOff, []);
  assert.equal(sk.enabled(s).length, 9);
});

test('cleanStore: junk in this browser\'s settings becomes safe fields', () => {
  assert.deepEqual(fresh().skillsOff, []);
  assert.deepEqual(fresh().skillsMine, []);
  const s = fresh({
    skillsOff: ['pirate', 'pirate', 7, 'gone', 'mine-1', 'BAD ID'],
    skillsMine: [
      { id: 'mine-1', name: ' mine ', about: 5, text: ' do this ', extra: 'dropped' },
      { id: 'mine-1', name: 'dup', text: 'x' },
      { id: 'pirate', name: 'pirate', text: 'clash with built in' },
      { id: 'Bad Id', name: 'bad id', text: 'x' },
      { name: '', text: 'no name' },
      { name: 'no text', text: '' },
      null, 'str',
    ],
  });
  assert.deepEqual(s.skillsMine, [
    { id: 'mine-1', name: 'mine', about: '', text: 'do this' },
    { id: 'dup', name: 'dup', about: '', text: 'x' },
    { id: 'pirate-2', name: 'pirate', about: '', text: 'clash with built in' },
    { id: 'bad-id', name: 'bad id', about: '', text: 'x' },
  ]);
  assert.deepEqual(s.skillsOff, ['pirate', 'mine-1']);
  assert.equal(s.temperature, 0.7, 'other settings stay');
  const many = fresh({ skillsMine: Array.from({ length: 70 }, (_, i) => ({ name: `s${i}`, text: 't' })), skillsOff: 'x' });
  assert.equal(many.skillsMine.length, 50);
  assert.deepEqual(many.skillsOff, []);
  assert.equal(fresh({ skillsMine: [{ name: 'n', text: 'y'.repeat(5000) }] }).skillsMine[0].text.length, 4000);
});

test('notes: activeSkill after on, off, on; the off note; one leading system text', () => {
  const pirate: any = sk.BUILTIN.find((s: any) => s.id === 'pirate');
  const grandma: any = sk.BUILTIN.find((s: any) => s.id === 'grandma');
  const on = sk.noteFor(pirate);
  assert.deepEqual(on, { role: 'system', content: pirate.text, skill: { id: 'pirate', name: 'pirate', about: pirate.about } });
  const msgs: any[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  assert.equal(sk.activeSkill(msgs), null);
  assert.equal(sk.activeSkill(undefined), null);
  msgs.push(on);
  assert.equal(sk.activeSkill(msgs), on);
  msgs.push({ role: 'user', content: 'ahoy' }, { role: 'assistant', content: 'arr' });
  assert.equal(sk.activeSkill(msgs), on, 'later turns keep it');
  const off = sk.offNote(sk.activeSkill(msgs));
  assert.deepEqual(off, { role: 'system', content: '', skill: { id: 'pirate', name: 'pirate', off: true } });
  assert.deepEqual(sk.offNote(on.skill), off, 'the skill itself works too');
  msgs.push(off);
  assert.equal(sk.activeSkill(msgs), null);
  const on2 = sk.noteFor(grandma);
  msgs.push(on2);
  assert.equal(sk.activeSkill(msgs), on2);
  // another pick replaces the active one
  msgs.push(sk.noteFor(pirate));
  assert.equal(sk.activeSkill(msgs).skill.id, 'pirate');

  assert.equal(sk.systemWith('be brief.', on), `be brief.\n\n${pirate.text}`);
  assert.equal(sk.systemWith('', on), pirate.text);
  assert.equal(sk.systemWith('be brief.', null), 'be brief.');
  assert.equal(sk.systemWith('  ', null), '');
  assert.equal(sk.systemWith('be brief.', off), 'be brief.');
});
