// Hugging Face without the network: a fake fetch answers the search and the tree, so the
// grouping of split files, the name parsing, the gated flag and the back-off are checked.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { FILE_FILTERS, HfError, ggufFiles, groupGguf, hfFetch, hfTiming, licenseUrl, paramsOf, quantOf, repoOf, repoOfId, searchGguf, type TreeRow } from '@/llm/hf';

const sha = (c: string) => c.repeat(64);
const tree: TreeRow[] = [
  { path: 'README.md', size: 10 },
  { path: 'model-Q4_K_M.gguf', size: 4e9, lfs: { oid: sha('a') } },
  { path: 'model-Q8_0-00002-of-00002.gguf', size: 3e9, lfs: { oid: sha('c') } },
  { path: 'model-Q8_0-00001-of-00002.gguf', size: 5e9, lfs: { oid: sha('b') } },
  { path: 'model-F16-00001-of-00003.gguf', size: 6e9, lfs: { oid: sha('d') } },
  { path: 'model-F16-00002-of-00003.gguf', size: 6e9, lfs: { oid: sha('e') } },
  { path: 'mmproj-model-f16.gguf', size: 8e8, lfs: { oid: sha('f') } },
  { path: 'model-IQ2_XS.gguf', size: 1e9 },
];

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'throw';
function fakeFetch(replies: Reply[]) {
  const calls: string[] = [];
  const fn = jest.fn(async (url: string) => {
    calls.push(url);
    const r = replies.shift() ?? { status: 500 };
    if (r === 'throw') throw new TypeError('Network request failed');
    return { ok: r.status < 400, status: r.status, headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null }, json: async () => r.body } as unknown as Response;
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fn;
  return calls;
}
const waits: number[] = [];
hfTiming.sleep = async (ms) => { waits.push(ms); };
afterEach(() => { waits.length = 0; });

describe('grouping gguf files', () => {
  const files = groupGguf(tree);
  it('keeps singles, groups complete split models, drops incomplete ones and mmproj', () => {
    expect(files.map((f) => f.file)).toEqual(['model-IQ2_XS.gguf', 'model-Q4_K_M.gguf', 'model-Q8_0-00001-of-00002.gguf']);
  });
  it('a split model has its parts in order, the sum as size, every sha256', () => {
    const q8 = files.find((f) => f.parts.length > 1)!;
    expect(q8.parts.map((p) => p.file)).toEqual(['model-Q8_0-00001-of-00002.gguf', 'model-Q8_0-00002-of-00002.gguf']);
    expect(q8.size).toBe(8e9);
    expect(q8.sha256).toBe(sha('b'));
    expect(q8.parts.map((p) => p.sha256)).toEqual([sha('b'), sha('c')]);
  });
  it('a single file is its own only part, and a missing sha is null', () => {
    const iq = files[0];
    expect(iq.parts).toEqual([{ file: 'model-IQ2_XS.gguf', size: 1e9, sha256: null }]);
  });
  it('the quick filters pick by quant, size and part count', () => {
    const by = (id: string) => files.filter(FILE_FILTERS.find((f) => f.id === id)!.test).map((f) => f.file);
    expect(by('q4km')).toEqual(['model-Q4_K_M.gguf']);
    expect(by('q8')).toEqual(['model-Q8_0-00001-of-00002.gguf']);
    expect(by('le2')).toEqual(['model-IQ2_XS.gguf']);
    expect(by('single')).toHaveLength(2);
  });
});

describe('names', () => {
  it('reads the quant, also behind a part suffix', () => {
    expect(quantOf('Qwen3-4B-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantOf('Llama-3.1-70B-Q8_0-00001-of-00002.gguf')).toBe('Q8_0');
    expect(quantOf('model-IQ2_XS.gguf')).toBe('IQ2_XS');
    expect(quantOf('model-f16.gguf')).toBe('F16');
    expect(quantOf('model.gguf')).toBe('');
  });
  it('reads the parameter count, the largest when there are several', () => {
    expect(paramsOf('Qwen3-4B-Q4_K_M.gguf')).toBe(4);
    expect(paramsOf('qwen2.5-1.5b-instruct')).toBe(1.5);
    expect(paramsOf('Qwen3-30B-A3B-Q4_K_M.gguf')).toBe(30);
    expect(paramsOf('bartowski/gemma-3-12b-it-GGUF')).toBe(12);
    expect(paramsOf('no-size-here.gguf')).toBe(0);
  });
  it('finds the repo in an hf id and the license page', () => {
    expect(repoOfId('hf:unsloth/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf')).toBe('unsloth/Qwen3-4B-GGUF');
    expect(licenseUrl('a/b', 'apache-2.0')).toContain('choosealicense.com/licenses/apache-2.0');
    expect(licenseUrl('a/b', 'gemma')).toBe('https://huggingface.co/a/b/blob/main/README.md');
    expect(licenseUrl('a/b', null)).toContain('README.md');
  });
});

describe('search rows', () => {
  it('reads gated ("auto" / "manual" / true count, false does not) and the license from the card or the tags', () => {
    expect(repoOf({ id: 'a/b', gated: 'auto', cardData: { license: 'llama3.2' } })).toMatchObject({ id: 'a/b', gated: true, license: 'llama3.2' });
    expect(repoOf({ id: 'a/b', gated: 'manual' }).gated).toBe(true);
    expect(repoOf({ id: 'a/b', gated: true }).gated).toBe(true);
    expect(repoOf({ id: 'a/b', gated: false, tags: ['gguf', 'license:apache-2.0'] })).toMatchObject({ gated: false, license: 'apache-2.0' });
    expect(repoOf({ modelId: 'a/c' })).toMatchObject({ id: 'a/c', gated: false, license: null });
  });
  it('searches with a fake fetch and drops rows without an id', async () => {
    const calls = fakeFetch([{ status: 200, body: [{ id: 'x/y', downloads: 12, gated: false }, { downloads: 1 }] }]);
    const rows = await searchGguf('qwen');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('x/y');
    expect(calls[0]).toContain('search=qwen');
    expect(calls[0]).toContain('filter=gguf');
    expect(await searchGguf('  ')).toEqual([]);
  });
  it('lists a repo tree grouped', async () => {
    fakeFetch([{ status: 200, body: tree }]);
    const files = await ggufFiles('x/y');
    expect(files).toHaveLength(3);
  });
});

describe('backing off', () => {
  it('waits after a 429 (retry-after first) and then succeeds', async () => {
    const calls = fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 429 }, { status: 200, body: [] }]);
    const res = await hfFetch('u');
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([2000, 2000]); // retry-after 2 s, then base × 2¹
  });
  it('gives up with a coded ratelimit error after the retries', async () => {
    fakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    await expect(hfFetch('u')).rejects.toMatchObject({ code: 'ratelimit', status: 429 });
    expect(waits).toHaveLength(hfTiming.retries);
  });
  it('retries a dropped connection and reports offline', async () => {
    fakeFetch(['throw', 'throw', 'throw', 'throw']);
    const err = (await hfFetch('u').catch((e) => e)) as HfError;
    expect(err).toBeInstanceOf(HfError);
    expect(err.code).toBe('offline');
    expect(waits).toEqual([1000, 2000, 4000]);
  });
  it('does not retry a gated or missing repo', async () => {
    const calls = fakeFetch([{ status: 401 }]);
    await expect(hfFetch('u')).rejects.toMatchObject({ code: 'gated' });
    fakeFetch([{ status: 404 }]);
    await expect(hfFetch('u')).rejects.toMatchObject({ code: 'notfound' });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});
