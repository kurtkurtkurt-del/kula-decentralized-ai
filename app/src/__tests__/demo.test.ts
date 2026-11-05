// src/demo: a build without a server runs on the example world. Every read answers in the
// server's own shapes (the snapshot was taken from a real local server); writes change it.
import { describe, expect, it } from '@jest/globals';
import { demoRpc, freshState, ME } from '@/demo/server';

const data = (name: string, args = {}, s = freshState()) => {
  const a = demoRpc(s, name, args);
  expect(a.error).toBeNull();
  return a.data as any;
};

// a project nobody kept yet (the deck rpc that listed them went with the swipe deck, 4.11.2026)
const openSlug = (s: ReturnType<typeof freshState>) => (s.projects as { slug: string }[]).find((p) => !s.joins[p.slug])!.slug;

describe('the example world', () => {
  it('answers what every tab asks', () => {
    const s = freshState();
    for (const n of ['profile_me', 'kept', 'friends_list', 'friends_kept', 'friends_live', 'my_cards', 'credits_mine', 'passport_mine', 'dm_list', 'my_coops', 'call_inbox', 'call_mine', 'network_nodes', 'device_catalog', 'network_estimate', 'people_suggested', 'terms_status', 'account_status', 'contribution_open', 'my_blocks']) {
      expect(demoRpc(s, n, { p_limit: 40 }).error).toBeNull();
    }
    expect(data('profile_me', {}, s)[0].handle).toBe('deniz');
    expect(data('project_page', { p_slug: openSlug(s) }, s).length).toBeGreaterThan(0);
    expect(data('network_estimate', {}, s)[0].phones).toBeGreaterThan(5);
  });
  it('says plainly what it does not know', () => {
    expect(demoRpc(freshState(), 'no_such_thing').error?.message).toMatch(/demo/);
  });
});

describe('what the user does stays', () => {
  it('keeping puts a project into kept', () => {
    const s = freshState();
    const slug = openSlug(s);
    data('join_set', { p_slug: slug, p_direction: 'right' }, s);
    expect(data('kept', {}, s).some((p: { slug: string }) => p.slug === slug)).toBe(true);
    expect(data('project_page', { p_slug: slug }, s)[0].kept).toBe(true);
  });
  it('a message is added to its thread', () => {
    const s = freshState();
    const thread = data('dm_list', {}, s)[0].id;
    const before = data('dm_thread', { p_thread: thread, p_after: 0 }, s).length;
    const id = data('dm_send', { p_thread: thread, p_body: 'merhaba' }, s);
    const lines = data('dm_thread', { p_thread: thread, p_after: 0 }, s);
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toMatchObject({ id, body: 'merhaba', mine: true, user_id: ME.id });
    expect(data('dm_list', {}, s)[0].last_body).toBe('merhaba');
  });
  it('a finished night becomes a card and credits', () => {
    const s = freshState();
    const slug = data('kept', {}, s)[0].slug;
    const cards = data('my_cards', {}, s).length;
    const id = data('contribution_start', { p_slug: slug }, s);
    expect(data('contribution_open', {}, s)[0].id).toBe(id);
    const no = data('contribution_end', { p_id: id, p_tokens: 42000, p_seconds: 7200, p_kwh: 0.008 }, s);
    expect(data('my_cards', {}, s).length).toBe(cards + 1);
    expect(data('my_cards', {}, s)[0].card_no).toBe(no);
    expect(data('contribution_open', {}, s)).toEqual([]);
  });
  it('a morning report is kept once per client id and listed newest first', () => {
    const s = freshState();
    const report = { id: '2026-11-05', slug: data('kept', {}, s)[0].slug, device_id: 'dev-1', units: 12, tokens: 300, seconds: 600, wh: 0.5 };
    const id = data('night_report', { p_report: report, p_client_id: 'c1' }, s);
    expect(data('night_report', { p_report: report, p_client_id: 'c1' }, s)).toBe(id); // a retry
    const id2 = data('night_report', { p_report: { ...report, id: '2026-11-06' }, p_client_id: 'c2' }, s);
    expect(id2).not.toBe(id);
    const list = data('night_reports', {}, s);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: id2, report: { id: '2026-11-06' } });
    expect(list[1].report).toEqual(report);
  });
  it('the same device, project and night again finds the first row; a bad report is refused', () => {
    const s = freshState();
    const slug = data('kept', {}, s)[0].slug;
    const r = { id: '2026-11-05', slug, device_id: 'dev-1', units: 12, checked: 4, wrong: 1, tokens: 300, seconds: 600, wh: 0.5 };
    const id = data('night_report', { p_report: r, p_client_id: 'd1' }, s);
    expect(data('night_report', { p_report: { ...r, units: 99 }, p_client_id: 'd2' }, s)).toBe(id);
    expect(data('night_reports', {}, s)).toHaveLength(1);
    expect(demoRpc(s, 'night_report', { p_report: { ...r, slug: 'nope' }, p_client_id: 'd3' }).error?.message).toBe('noproject');
    expect(demoRpc(s, 'night_report', { p_report: { ...r, id: '2026-11-06', checked: 50 }, p_client_id: 'd4' }).error?.message).toMatch(/add up/);
  });
  it('the summary on the cards: nights this month per project, the streak of this device, the board', () => {
    const s = freshState();
    const slug = data('kept', {}, s)[0].slug;
    const day = (back: number) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
    for (const [i, back] of [0, 1, 2].entries()) data('night_report', { p_report: { id: day(back), slug, device_id: 'dev-1', units: 10, tokens: 100, seconds: 60 }, p_client_id: `s${i}` }, s);
    data('night_report', { p_report: { id: day(1), slug, device_id: 'dev-2', units: 5, tokens: 50, seconds: 60 }, p_client_id: 's9' }, s);
    const sum = data('night_mine_summary', { p_device_id: 'dev-1' }, s);
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ slug, nights_total: 3, streak: 3, last_night: day(0) });
    expect(sum[0].nights_month).toBeGreaterThanOrEqual(1);
    expect(data('night_mine_summary', { p_device_id: 'dev-2' }, s)[0].streak).toBe(1);
    expect(demoRpc(s, 'project_summary', { p_slug: slug }).error?.message).toMatch(/owner/);
    const board = data('night_leaderboard', {}, s);
    expect(board.find((b: { me: boolean }) => b.me)).toMatchObject({ handle: 'deniz', nights: 3 });
    expect(board[0].nights).toBeGreaterThanOrEqual(board[board.length - 1].nights);
  });
  it('a night on a project not kept is refused, as the server does', () => {
    const s = freshState();
    const slug = openSlug(s);
    expect(demoRpc(s, 'contribution_start', { p_slug: slug }).error?.message).toBe('notkept');
  });
  it('a measured passport is the newest', () => {
    const s = freshState();
    data('passport_save', { p_data: { schema: 'passport/0.3', est_tps: 5, measured_at: '2026-10-22T00:00:00Z' } }, s);
    expect(data('passport_mine', { p_limit: 10 }, s)[0].data.est_tps).toBe(5);
  });
  it('accepting a request makes a friend; a new coop and call appear', () => {
    const s = freshState();
    const req = data('friends_list', {}, s).find((f: { direction: string; status: string }) => f.direction === 'incoming' && f.status === 'pending');
    data('friend_accept', { p_other: req.other_id }, s);
    expect(data('profile_card', { p_handle: req.handle }, s)[0].relation).toBe('friend');
    const coop = data('coop_create', { p_name: 'test', p_emoji: '🔋', p_color: 'green', p_members: [req.other_id] }, s);
    expect(data('coop_get', { p_id: coop }, s).members.length).toBe(2);
    const slug = data('kept', {}, s)[0].slug;
    const call = data('call_create', { p_slug: slug, p_night: '2026-10-25', p_reach: 1, p_note: null }, s);
    expect(data('call_mine', {}, s)[0].id).toBe(call);
  });
});
