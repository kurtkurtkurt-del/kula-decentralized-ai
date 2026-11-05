// Hugging Face against a fake fetch (5.11.2026): the search rows as they come, gated and
// license read from tags or the card, the file tree filtered down to single gguf files,
// an http error as 'hf <status>'; and the small helpers that read a file name. Also the
// catalog lookup and the job source's edges (ServerJobs is not yet, results are capped).
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ggufFiles, hfUrl, kvGuess, paramsOf, quantOf, searchGguf } from '@/llm/hf';
import { CATALOG, catalogById, modelUrl } from '@/llm/catalog';

const realFetch = globalThis.fetch;
const calls: string[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: [] };
beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    expect((init!.headers as Record<string, string>).Accept).toBe('application/json');
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('searchGguf', () => {
  it('asks for gguf repos by downloads and reads the rows', async () => {
    answer = { status: 200, body: [
      { id: 'Qwen/Qwen3-0.6B-GGUF', downloads: 1200, likes: 30, gated: false, lastModified: '2026-10-01', tags: ['gguf', 'license:apache-2.0'] },
      { modelId: 'meta/llama', downloads: '7', gated: 'auto', cardData: { license: 'llama3' } },
      { id: 'x/y', gated: true, tags: [] },
      { downloads: 5 },
    ] };
    const rows = await searchGguf('  qwen 3 ', 10);
    expect(calls[0]).toBe('https://huggingface.co/api/models?search=qwen%203&filter=gguf&sort=downloads&direction=-1&limit=10&full=false');
    expect(rows).toEqual([
      { id: 'Qwen/Qwen3-0.6B-GGUF', downloads: 1200, likes: 30, gated: false, license: 'apache-2.0', updated: '2026-10-01' },
      { id: 'meta/llama', downloads: 7, likes: 0, gated: true, license: 'llama3', updated: '' },
      { id: 'x/y', downloads: 0, likes: 0, gated: true, license: null, updated: '' },
    ]);
  });
  it('does not call out for an empty query', async () => {
    expect(await searchGguf('   ')).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('throws hf <status> on an error', async () => {
    answer = { status: 429, body: {} };
    await expect(searchGguf('x')).rejects.toThrow('hf 429');
  });
});

describe('ggufFiles', () => {
  it('keeps single gguf files with their lfs sha256, smallest first', async () => {
    answer = { status: 200, body: [
      { path: 'README.md', size: 10 },
      { path: 'model-Q4_K_M.gguf', size: 3000, lfs: { oid: 'a'.repeat(64) } },
      { path: 'model-Q8_0.GGUF', size: 5000 },
      { path: 'model-Q4-00001-of-00002.gguf', size: 100 },
      { path: 'mmproj-model-f16.gguf', size: 50 },
      { path: 'model-IQ2_XS.gguf', size: 1000, lfs: {} },
    ] };
    const files = await ggufFiles('me/repo');
    expect(calls[0]).toBe('https://huggingface.co/api/models/me/repo/tree/main');
    expect(files).toEqual([
      { file: 'model-IQ2_XS.gguf', size: 1000, sha256: null },
      { file: 'model-Q4_K_M.gguf', size: 3000, sha256: 'a'.repeat(64) },
      { file: 'model-Q8_0.GGUF', size: 5000, sha256: null },
    ]);
  });
  it('throws hf 404 for a repo that is not there', async () => {
    answer = { status: 404, body: {} };
    await expect(ggufFiles('no/such')).rejects.toThrow('hf 404');
  });
});

describe('the name readers', () => {
  it('read the quant, the parameter count and the kv guess', () => {
    expect(quantOf('Qwen3-0.6B-Q8_0.gguf')).toBe('Q8_0');
    expect(quantOf('gemma-3-1b-it-q4_k_m.gguf')).toBe('Q4_K_M');
    expect(quantOf('x-IQ2_XS.gguf')).toBe('IQ2_XS');
    expect(quantOf('x-f16.gguf')).toBe('F16');
    expect(quantOf('x-BF16.gguf')).toBe('BF16');
    expect(quantOf('model.gguf')).toBe('');
    expect(paramsOf('Qwen3-0.6B-Q8_0.gguf')).toBe(0.6);
    expect(paramsOf('Llama-3.2-1B-Instruct')).toBe(1);
    expect(paramsOf('Qwen2.5-7B')).toBe(7);
    expect(paramsOf('gemma-3-1b-it')).toBe(1);
    expect(paramsOf('bert-base')).toBe(0);
    expect(paramsOf('8bit-model')).toBe(0);
    expect(kvGuess(0.6)).toBe(24);
    expect(kvGuess(7)).toBe(224);
    expect(hfUrl('a/b', 'c.gguf')).toBe('https://huggingface.co/a/b/resolve/main/c.gguf');
    expect(modelUrl(CATALOG[0])).toBe(hfUrl(CATALOG[0].repo, CATALOG[0].file));
  });
});

describe('the catalog lookup', () => {
  it('finds a model by id and null for a stranger', () => {
    expect(catalogById(CATALOG[1].id)).toBe(CATALOG[1]);
    expect(catalogById('nope')).toBeNull();
  });
});
