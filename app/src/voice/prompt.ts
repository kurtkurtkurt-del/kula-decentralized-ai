import type { Message } from '@/llm/native';
import type { VLang } from '@/voice/intents';

// What the model is told in talk mode (pure): a concise personal secretary that answers in
// the user's language in one to three spoken sentences, and the last few turns of this
// session as its memory. The memory lives only as long as the talk screen is open.

export const MEMORY_TURNS = 6; // user + assistant pairs kept
export type Turn = { role: 'user' | 'assistant'; text: string };

const LANG_NAME: Record<VLang, string> = { en: 'English', de: 'German', tr: 'Turkish' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function systemPrompt(lang: VLang, now: Date): string {
  const date = `${DAYS[now.getDay()]}, ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return [
    `You are kula, the user's personal secretary, running entirely on their own phone. Nothing they say leaves the phone, so they may talk about anything.`,
    `You are speaking out loud: answer in ${LANG_NAME[lang]}, in one to three short spoken sentences. No lists, no markdown, no emoji, no headings.`,
    `Be warm and direct. If you do not know, say so in one sentence. Never invent calendar entries, messages or facts about the user.`,
    `The phone itself adds calendar events, reads messages, sets alarms and timers and keeps notes when the user asks plainly (for example "add gym tomorrow at 6 pm", "read my messages", "take a note …"). If they ask for something like that and you are answering instead, tell them to say it that way.`,
    `Today is ${date}.`,
  ].join('\n');
}

/** The newest turns that fit the memory, oldest first, always starting with the user. */
export function remember(history: Turn[], turns = MEMORY_TURNS): Turn[] {
  let kept = history.slice(-turns * 2);
  while (kept.length && kept[0].role !== 'user') kept = kept.slice(1);
  return kept;
}

/**
 * The messages for one reply: the system prompt, the remembered turns, the new words.
 * noThink appends qwen3's switch so a reasoning model answers at once.
 */
export function buildMessages(history: Turn[], heard: string, lang: VLang, now: Date, opts: { turns?: number; noThink?: boolean } = {}): Message[] {
  const past = remember(history, opts.turns ?? MEMORY_TURNS).map((t) => ({ role: t.role, content: t.text }) as Message);
  return [{ role: 'system', content: systemPrompt(lang, now) }, ...past, { role: 'user', content: opts.noThink ? `${heard} /no_think` : heard }];
}
