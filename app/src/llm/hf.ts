// Hugging Face search for GGUF files. Two public, keyless calls: the model search and a
// repo's file tree (which carries each LFS file's size and sha256, so a download from here
// is verified like a catalog one). Repos that are gated or without a readable license are
// shown with a warning, not hidden; a gated one cannot be downloaded from here (the resolve
// url answers 401 without a token). Multi-part files ("-00001-of-00003.gguf") are grouped
// into one entry: the parts in order, the total size, each part's own sha256.
export type HfRepo = { id: string; downloads: number; likes: number; gated: boolean; license: string | null; updated: string };
export type HfPart = { file: string; size: number; sha256: string | null };
export type HfFile = HfPart & { parts: HfPart[] }; // parts: one for a single file, n for a split one
export type HfErrorCode = 'ratelimit' | 'offline' | 'gated' | 'notfound' | 'http';
export class HfError extends Error {
  constructor(public code: HfErrorCode, public status = 0) {
    super(code);
  }
}

const API = 'https://huggingface.co/api';
const headers = { Accept: 'application/json', 'User-Agent': 'kula-decentralized-ai' };
/** Waits between retries; swapped out by the tests. */
export const hfTiming = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), retries: 3, baseMs: 1000, maxWaitMs: 15000 };

/** fetch with a backing-off retry on 429 / 5xx / a dropped connection, and a coded error for the screen. */
export async function hfFetch(url: string): Promise<Response> {
  let last: HfError = new HfError('http');
  for (let attempt = 0; attempt <= hfTiming.retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch {
      last = new HfError('offline');
      if (attempt < hfTiming.retries) await hfTiming.sleep(hfTiming.baseMs * 2 ** attempt);
      continue;
    }
    if (res.ok) return res;
    if (res.status === 401 || res.status === 403) throw new HfError('gated', res.status);
    if (res.status === 404) throw new HfError('notfound', 404);
    if (res.status === 429 || res.status >= 500) {
      last = new HfError(res.status === 429 ? 'ratelimit' : 'http', res.status);
      if (attempt < hfTiming.retries) {
        const after = Number(res.headers?.get?.('retry-after')) * 1000;
        await hfTiming.sleep(Math.min(hfTiming.maxWaitMs, after > 0 ? after : hfTiming.baseMs * 2 ** attempt));
      }
      continue;
    }
    throw new HfError('http', res.status);
  }
  throw last;
}

export async function searchGguf(query: string, limit = 30): Promise<HfRepo[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `${API}/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=${limit}&full=false`;
  const res = await hfFetch(url);
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows.map(repoOf).filter((r) => r.id);
}

/** One search row → HfRepo. `gated` on the api is false, true, "auto" or "manual". */
export function repoOf(r: Record<string, unknown>): HfRepo {
  return {
    id: String(r.id ?? r.modelId ?? ''),
    downloads: Number(r.downloads) || 0,
    likes: Number(r.likes) || 0,
    gated: r.gated !== false && r.gated !== undefined && r.gated !== null,
    license: licenseOf(r),
    updated: String(r.lastModified ?? ''),
  };
}

function licenseOf(r: Record<string, unknown>): string | null {
  const card = r.cardData as Record<string, unknown> | undefined;
  if (card && typeof card.license === 'string' && card.license) return card.license;
  const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
  const t = tags.find((x) => x.startsWith('license:'));
  return t ? t.slice(8) : null;
}

export type TreeRow = { path: string; size?: number; lfs?: { oid?: string } };
const PART = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/** The .gguf files of a repo, split files grouped into one entry; smallest first. */
export async function ggufFiles(repo: string): Promise<HfFile[]> {
  const res = await hfFetch(`${API}/models/${repo}/tree/main`);
  return groupGguf((await res.json()) as TreeRow[]);
}

/** Pure: tree rows → files. A split model whose parts are not all there is left out. */
export function groupGguf(rows: TreeRow[]): HfFile[] {
  const singles: HfFile[] = [];
  const groups = new Map<string, { n: number; parts: Map<number, HfPart> }>();
  for (const f of rows) {
    if (!f.path.toLowerCase().endsWith('.gguf') || /mmproj/i.test(f.path)) continue;
    const part: HfPart = { file: f.path, size: Number(f.size) || 0, sha256: f.lfs?.oid ?? null };
    const m = f.path.match(PART);
    if (!m) {
      singles.push({ ...part, parts: [part] });
      continue;
    }
    const key = m[1];
    const g = groups.get(key) ?? { n: Number(m[3]), parts: new Map() };
    g.parts.set(Number(m[2]), part);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.parts.size !== g.n) continue;
    const parts = [...g.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    if (parts.some((p, i) => p.file !== parts[0].file.replace(/-00001-of-/, `-${String(i + 1).padStart(5, '0')}-of-`))) continue;
    singles.push({ file: parts[0].file, size: parts.reduce((a, p) => a + p.size, 0), sha256: parts[0].sha256, parts });
  }
  return singles.sort((a, b) => a.size - b.size);
}

export const isSplit = (f: HfFile) => f.parts.length > 1;
/** Reads the quant from a file name: "...-Q4_K_M.gguf", "...-Q4_K_M-00001-of-00002.gguf" → "Q4_K_M". */
export const quantOf = (file: string) => (file.replace(/-\d{5}-of-\d{5}\.gguf$/i, '.gguf').match(/(IQ\d_[A-Z_]+|Q\d(?:_[A-Z0-9]+)*|F16|BF16|F32)\.gguf$/i)?.[1] ?? '').toUpperCase();
/** A rough parameter count from the name: "7B", "1.5B", "0.6b", "A3B" is skipped in favour of the total. */
export const paramsOf = (name: string) => {
  const all = [...name.matchAll(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  return all.length ? Math.max(...all) : 0;
};
/** The KV estimate for a model we only know by size: 32 MB per 1k ctx per billion params, roughly. */
export const kvGuess = (paramsB: number) => Math.round(Math.max(24, paramsB * 32));
export const hfUrl = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;
export const repoUrl = (repo: string) => `https://huggingface.co/${repo}`;
/** Where the license is read: the model card; a known SPDX-ish id also has a page on hf. */
export const licenseUrl = (repo: string, license: string | null) =>
  license && /^(apache-2\.0|mit|gpl-3\.0|cc-by-4\.0|cc-by-sa-4\.0)$/i.test(license) ? `https://choosealicense.com/licenses/${license.toLowerCase()}/` : `${repoUrl(repo)}/blob/main/README.md`;
/** The repo of an "hf:<owner>/<name>/<file>" id (or url). */
export const repoOfId = (id: string) => id.replace(/^hf:/, '').split('/').slice(0, 2).join('/');

// ---- quick filters and suggestions for the search --------------------------------------
export type FileFilter = { id: string; label: string; test: (f: HfFile) => boolean };
const GB = 1024 ** 3;
export const FILE_FILTERS: FileFilter[] = [
  { id: 'q4km', label: 'Q4_K_M', test: (f) => quantOf(f.file) === 'Q4_K_M' },
  { id: 'q8', label: 'Q8_0', test: (f) => quantOf(f.file) === 'Q8_0' },
  { id: 'le2', label: '≤ 2 gb', test: (f) => f.size <= 2 * GB },
  { id: 'le4', label: '≤ 4 gb', test: (f) => f.size <= 4 * GB },
  { id: 'single', label: '1 file', test: (f) => !isSplit(f) },
];
export const SUGGESTED_QUERIES = ['qwen3 gguf', 'llama 3.2 gguf', 'gemma 3 gguf', 'phi-4 mini gguf', 'smollm gguf'];
