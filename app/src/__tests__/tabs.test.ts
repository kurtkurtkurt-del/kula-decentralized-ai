// The tab bar (5.11.2026): models · connect · the brain · projects · passport. Connect holds
// the messages now; the old /messages route redirects into it; every tab has a label in all
// three languages and an icon. Read from the source, so the test needs no navigator.
import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { dict } from '@/i18n/dict';
import { blocksOf } from '@/components/tasks/Markdown';

const app = join(__dirname, '..', 'app');
const read = (p: string) => readFileSync(join(app, p), 'utf8');

describe('the tabs', () => {
  const layout = read('(tabs)/_layout.tsx');
  const triggers = [...layout.matchAll(/<TabTrigger name="([^"]+)" href="([^"]+)"[^>]*>\s*<TabItem icon="([^"]+)"/g)].map((m) => ({ name: m[1], href: m[2], icon: m[3] }));

  it('are models · connect · the brain · projects · passport', () => {
    expect(triggers.map((t) => t.name)).toEqual(['models', 'people', 'brain', 'projects', 'passport']);
    expect(triggers.map((t) => t.href)).toEqual(['/models', '/people', '/brain', '/projects', '/passport']);
    for (const t of triggers) expect(existsSync(join(app, '(tabs)', `${t.name}.tsx`))).toBe(true);
  });

  it('have an icon and a label in every language', () => {
    const icons = readFileSync(join(__dirname, '..', 'components', 'Icon.tsx'), 'utf8');
    for (const t of triggers) {
      expect(icons).toContain(`name === '${t.icon}'`);
      const label = (dict as Record<string, Record<string, string>>)[`tab.${t.icon}`];
      expect(label).toBeDefined();
      for (const l of ['en', 'de', 'tr']) expect(label[l]).toBeTruthy();
    }
    expect(dict['tab.people'].en).toBe('connect');
    expect(dict['tab.projects'].en).toBe('projects');
  });

  it('keep the messages inside connect, and /messages leads there', () => {
    expect(existsSync(join(app, '(tabs)', 'messages.tsx'))).toBe(false);
    expect(read('messages.tsx')).toMatch(/Redirect href=\{\{ pathname: '\/people', params: \{ view: 'messages' \} \}\}/);
    const connect = read('(tabs)/people.tsx');
    expect(connect).toContain("<Messages dms={dms}");
    expect(connect).toContain("params.view === 'messages'");
    // the dm screens stay where they were
    expect(existsSync(join(app, 'dm', '[id].tsx'))).toBe(true);
  });

  it('have the project screens', () => {
    expect(existsSync(join(app, 'task', 'new.tsx'))).toBe(true);
    expect(existsSync(join(app, 'task', '[id].tsx'))).toBe(true);
  });
});

describe("a project's answer as markdown", () => {
  it('cuts headings, lists, code and paragraphs', () => {
    const md = '# Plan\n\nIntro line\ngoes on.\n\n- one\n* two\n1. first\n2) second\n\n```js\nconst a = 1;\n```\nend';
    expect(blocksOf(md)).toEqual([
      { kind: 'h', level: 1, text: 'Plan' },
      { kind: 'p', text: 'Intro line goes on.' },
      { kind: 'li', mark: '•', text: 'one' },
      { kind: 'li', mark: '•', text: 'two' },
      { kind: 'li', mark: '1.', text: 'first' },
      { kind: 'li', mark: '2.', text: 'second' },
      { kind: 'code', text: 'const a = 1;' },
      { kind: 'p', text: 'end' },
    ]);
  });
});
