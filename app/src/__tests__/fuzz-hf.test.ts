// hf.ts name readers under random file names: never throw, agree on the known shapes.
import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import { isWholeGguf, kvGuess, paramsOf, quantOf, shardOf } from '@/llm/hf';

const QUANTS = ['Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q4_0', 'Q4_1', 'Q4_K_S', 'Q4_K_M', 'Q5_0', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'IQ1_S', 'IQ2_XXS', 'IQ3_XS', 'IQ4_XS', 'IQ4_NL', 'F16', 'BF16', 'F32'];
const stem = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/);
const anyName = fc.oneof(fc.string({ maxLength: 120 }), fc.string({ unit: 'binary', maxLength: 60 }), fc.stringMatching(/^[A-Za-z0-9._ -]{0,80}(\.gguf|\.GGUF)?$/));

describe('hf name readers', () => {
  it('never throw and return their declared shapes on any string', () => {
    fc.assert(fc.property(anyName, (name) => {
      const q = quantOf(name);
      expect(typeof q).toBe('string');
      expect(q).toBe(q.toUpperCase());
      const p = paramsOf(name);
      expect(Number.isFinite(p) && p >= 0).toBe(true);
      const s = shardOf(name);
      expect(s === null || (Number.isInteger(s.n) && Number.isInteger(s.of))).toBe(true);
      expect(typeof isWholeGguf(name)).toBe('boolean');
      expect(kvGuess(p)).toBeGreaterThanOrEqual(24);
    }), { numRuns: 1000 });
  });

  it('reads the quant from any stem + quant + .gguf, case-insensitively', () => {
    // a stem that itself ends in Q<digit> ("Q0_Q2_K") is read as one longer quant: not a name anyone ships
    fc.assert(fc.property(stem.filter((s) => !/i?q\d$/i.test(s)), fc.constantFrom(...QUANTS), fc.constantFrom('-', '.', '_'), fc.boolean(), (s, q, sep, lower) => {
      const name = `${s}${sep}${lower ? q.toLowerCase() : q}.gguf`;
      expect(quantOf(name)).toBe(q);
      expect(quantOf(name.toUpperCase())).toBe(q);
    }), { numRuns: 500 });
  });

  it('reads the parameter count from NB / N.NB in any position, not from words like "4bit"', () => {
    fc.assert(fc.property(stem.filter((s) => !/\d\s*b(?![a-z])/i.test(s) && !/\d$/.test(s)), fc.integer({ min: 1, max: 999 }), fc.option(fc.integer({ min: 1, max: 9 }), { nil: null }), fc.boolean(), (s, whole, frac, upper) => {
      const n = frac === null ? `${whole}` : `${whole}.${frac}`;
      const name = `${s}-${n}${upper ? 'B' : 'b'}-Instruct-Q4_K_M.gguf`;
      expect(paramsOf(name)).toBe(Number(n));
      expect(paramsOf(`${s}-${n}bit.gguf`)).toBe(0);
    }), { numRuns: 500 });
  });

  it('tells a shard from a whole file for any part numbers', () => {
    fc.assert(fc.property(stem, fc.integer({ min: 1, max: 99999 }), fc.integer({ min: 1, max: 99999 }), (s, n, of) => {
      const name = `${s}-${String(n).padStart(5, '0')}-of-${String(of).padStart(5, '0')}.gguf`;
      expect(shardOf(name)).toEqual({ n, of });
      expect(isWholeGguf(name)).toBe(false);
      expect(isWholeGguf(`${s}.gguf`)).toBe(true);
      if (n < 10000 && of < 10000) expect(isWholeGguf(`${s}-${n}-of-${of}.gguf`)).toBe(true); // only the 5-digit form is a shard
      expect(isWholeGguf(`${s}-mmproj-f16.gguf`)).toBe(false);
      expect(isWholeGguf(`${s}.safetensors`)).toBe(false);
    }), { numRuns: 300 });
  });

  it('known names', () => {
    expect(quantOf('Qwen2.5-7B-Instruct-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(paramsOf('Qwen2.5-7B-Instruct-Q4_K_M.gguf')).toBe(7);
    expect(quantOf('Llama-3.2-1B-Instruct-IQ4_XS.gguf')).toBe('IQ4_XS');
    expect(paramsOf('Llama-3.2-1B-Instruct-IQ4_XS.gguf')).toBe(1);
    expect(quantOf('gemma-2-9b-it-Q8_0.gguf')).toBe('Q8_0');
    expect(paramsOf('gemma-2-9b-it-Q8_0.gguf')).toBe(9);
    expect(quantOf('ggml-model-f16.gguf')).toBe('F16');
    expect(quantOf('model-bf16.gguf')).toBe('BF16');
    expect(paramsOf('Qwen3-0.6B-Q4_K_M.gguf')).toBe(0.6);
    expect(paramsOf('SmolLM2-360M-Instruct-Q8_0.gguf')).toBe(0);
    expect(paramsOf('Phi-3.5-mini-4k-instruct-q4.gguf')).toBe(0);
    expect(quantOf('Phi-3.5-mini-4k-instruct-q4.gguf')).toBe('Q4');
    expect(quantOf('model.gguf')).toBe('');
    expect(quantOf('')).toBe('');
    expect(shardOf('Meta-Llama-3-70B-Q4_K_M-00001-of-00003.gguf')).toEqual({ n: 1, of: 3 });
    expect(shardOf('Meta-Llama-3-70B-Q4_K_M.gguf')).toBeNull();
    expect(paramsOf('Meta-Llama-3-70B-Q4_K_M-00001-of-00003.gguf')).toBe(70);
  });
});
