import type { Message } from '@/llm/native';
import { STEPS, isCritique, type Form, type Length, type StepName, type StepResult, type Task } from './types';

// What the model is asked at each step of a run (pure). The writing steps (answer, draft,
// revise, final) see the project; the ones after a critique also see the text so far and the
// critique of it. A critique lists what is weak and how to fix it, and does not rewrite.
// The answer's form and length go into the writing steps' instruction.
//
// Budgets: a writing step gets the length's tokens, a critique CRITIQUE_TOKENS; a thinking
// model (qwen3, thinking left on at night: there is time) gets THINK_TOKENS more per step
// for its <think> part, which is taken out before the step is stored.

export const LENGTH_TOKENS: Record<Length, number> = { short: 400, medium: 1200, long: 2400 };
export const CRITIQUE_TOKENS = 600;
export const THINK_TOKENS = 1024;
/** words per token, roughly, for the estimate and the screens */
export const WORDS_PER_TOKEN = 0.75;

const FORM_LINE: Record<Form, string> = {
  summary: 'Answer as a short summary: the essentials in a few clear sentences.',
  long: 'Answer as a well-structured long text with headings where they help.',
  list: 'Answer as a list: one point per line, most important first.',
  code: 'Answer with code: complete, runnable, with short comments; explain only what is needed around it.',
  plan: 'Answer as a plan: numbered steps, each with what to do and why, in order.',
};
const LENGTH_LINE: Record<Length, string> = {
  short: 'Keep it short: about 150–250 words.',
  medium: 'Medium length: about 500–800 words.',
  long: 'It may be long: up to about 1600 words, if the subject needs it.',
};

export const stepsOf = (t: Pick<Task, 'depth'>) => STEPS[t.depth];
export const isThinking = (modelId: string | null | undefined) => !!modelId && /qwen3/i.test(modelId);

export function stepTokens(name: StepName, length: Length, thinking: boolean): number {
  return (isCritique(name) ? CRITIQUE_TOKENS : LENGTH_TOKENS[length]) + (thinking ? THINK_TOKENS : 0);
}

function theTask(t: Pick<Task, 'title' | 'prompt' | 'photos'>, note?: string): string {
  const lines = [`Project: ${t.title.trim()}`, '', t.prompt.trim()];
  if (t.photos.length) lines.push('', `(The person attached ${t.photos.length} photo${t.photos.length > 1 ? 's' : ''} you cannot see; work from the text.)`);
  if (note?.trim()) lines.push('', `A note for this run: ${note.trim()}`);
  return lines.join('\n');
}

/** The messages for step i of a run, given the steps before it. */
export function stepMessages(t: Pick<Task, 'title' | 'prompt' | 'photos' | 'form' | 'length' | 'depth'>, before: StepResult[], i: number, opts: { thinking: boolean; note?: string }): Message[] {
  const name = stepsOf(t)[i];
  const tail = opts.thinking ? ' /think' : '';
  const task = theTask(t, opts.note);
  const lastText = [...before].reverse().find((s) => !isCritique(s.name))?.text ?? '';
  const lastCritique = [...before].reverse().find((s) => isCritique(s.name))?.text ?? '';
  const writer = `You work on the person's own project, overnight, on their phone. ${FORM_LINE[t.form]} ${LENGTH_LINE[t.length]} Write in the language the project is written in. No preamble, no closing remarks.`;
  if (isCritique(name)) {
    return [
      { role: 'system', content: 'You are a careful, honest reviewer. List the main weaknesses of the draft and a concrete fix for each: what is wrong, missing, unclear or too long. Do not rewrite the draft. At most 8 points.' },
      { role: 'user', content: `${task}\n\n--- the draft ---\n${lastText}\n--- end ---\n\nWhat should be better?${tail}` },
    ];
  }
  if (!before.length || !lastCritique) return [{ role: 'system', content: writer }, { role: 'user', content: `${task}${tail}` }];
  return [
    { role: 'system', content: writer },
    { role: 'user', content: `${task}\n\n--- the draft so far ---\n${lastText}\n--- end ---\n\n--- the critique ---\n${lastCritique}\n--- end ---\n\nWrite the improved ${name === 'final' ? 'final' : 'next'} version in full, using the critique. Only the answer itself.${tail}` },
  ];
}
