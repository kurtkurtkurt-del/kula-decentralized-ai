import { describe, expect, test } from '@jest/globals';
import { chatBudget, cutWhileThinking, withoutThinking } from '@/llm/think';

// selcukv1 T10: Qwen3 0.6B thought past the phone's 512 tokens on "17 times 6" and gave no number
describe('a thinking model in the chat', () => {
  test('gets room to think on top of the limit, inside the context', () => {
    const q = [{ content: 'What is 17 times 6? Answer with the number only.' }];
    expect(chatBudget(512, 'qwen3-0.6b', q, 4096)).toBe(1536);
    expect(chatBudget(512, 'llama-3.2-1b', q, 4096)).toBe(512);
    expect(chatBudget(512, 'qwen3-0.6b', q, 0)).toBe(1536);
    // a 2048 context with a long history: what is left, never under 64
    expect(chatBudget(512, 'qwen3-0.6b', [{ content: 'x'.repeat(3500) }], 2048)).toBe(2048 - 1000 - 32);
    expect(chatBudget(512, 'qwen3-0.6b', [{ content: 'x'.repeat(7000) }], 2048)).toBe(64);
  });
  test('a reply cut inside <think> is told apart from an answer', () => {
    expect(cutWhileThinking('<think>17 times 6 is')).toBe(true);
    expect(cutWhileThinking('<think>easy</think>102')).toBe(false);
    expect(cutWhileThinking('102')).toBe(false);
  });
  test('the same question again without thinking, once', () => {
    const m = [{ role: 'user' as const, content: 'a' }, { role: 'assistant' as const, content: 'b' }, { role: 'user' as const, content: '17 × 6?' }];
    const once = withoutThinking(m);
    expect(once.map((x) => x.content)).toEqual(['a', 'b', '17 × 6? /no_think']);
    expect(withoutThinking(once)[2].content).toBe('17 × 6? /no_think');
    expect(m[2].content).toBe('17 × 6?');
  });
});
