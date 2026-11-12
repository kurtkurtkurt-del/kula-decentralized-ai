import type { Message } from './native';
import { THINK_TOKENS, isThinking } from '@/tasks/prompts';

// A thinking model (qwen3) in the chat (selcukv1, 11 Nov, T10): asked "17 times 6, the number
// only", Qwen3 0.6B thought for 479 tokens on the Mac and ran into the phone's 512-token cap
// still thinking, so the phone showed "…" and no number. The chat now gives such a model the
// projects' THINK_TOKENS on top of the person's limit, kept inside the context; when it still
// ends inside <think> the reply says so and offers the same question without thinking.

/** The reply budget: the person's limit, plus room to think for a thinking model, within ctx. */
export function chatBudget(maxTokens: number, modelId: string | null | undefined, messages: { content: string }[], ctx: number): number {
  const want = maxTokens + (isThinking(modelId) ? THINK_TOKENS : 0);
  if (!ctx) return want;
  const prompt = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 3.5) + 32;
  // never below the person's own limit when the context has room for it, never below 64
  return Math.max(64, Math.min(want, ctx - prompt));
}

/** The reply ended while the model was still thinking: no answer came out. */
export const cutWhileThinking = (text: string) => text.includes('<think>') && !text.includes('</think>');

/** The same conversation, its last question asked without thinking (qwen3's /no_think). */
export function withoutThinking(messages: Message[]): Message[] {
  const i = messages.map((m) => m.role).lastIndexOf('user');
  if (i < 0) return messages;
  return messages.map((m, j) => (j === i && !/\/no_think\s*$/.test(m.content) ? { ...m, content: `${m.content} /no_think` } : m));
}
