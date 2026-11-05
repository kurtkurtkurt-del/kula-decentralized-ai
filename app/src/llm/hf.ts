// Hugging Face search for GGUF files. Two public, keyless calls: the model search and a
// repo's file tree (which carries each LFS file's size and sha256, so a download from here
// is verified like a catalog one). Repos that are gated or without a readable license are
// shown with a warning, not hidden.
export type HfRepo = { id: string; downloads: number; likes: number; gated: boolean; license: string | null; updated: string };
export type HfFile = { file: string; size: number; sha256: string | null };

const API = 'https://huggingface.co/api';
const headers = { Accept: 'application/json', 'User-Agent': 'kula-decentralized-ai' };

export async function searchGguf(query: string, limit = 30): Promise<HfRepo[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `${API}/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=${limit}&full=false`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`hf ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id ?? r.modelId ?? ''),
    downloads: Number(r.downloads) || 0,
    likes: Number(r.likes) || 0,
    gated: r.gated !== false && r.gated !== undefined && r.gated !== null,
    license: licenseOf(r),
    updated: String(r.lastModified ?? ''),
  })).filter((r) => r.id);
}

function licenseOf(r: Record<string, unknown>): string | null {
  const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
  const t = tags.find((x) => x.startsWith('license:'));
  if (t) return t.slice(8);
  const card = r.cardData as Record<string, unknown> | undefined;
  return card && typeof card.license === 'string' ? card.license : null;
}

/** The .gguf files of a repo, single files only (multi-part models are not supported yet). */
export async function ggufFiles(repo: string): Promise<HfFile[]> {
  const res = await fetch(`${API}/models/${repo}/tree/main`, { headers });
  if (!res.ok) throw new Error(`hf ${res.status}`);
  const rows = (await res.json()) as { path: string; size?: number; lfs?: { oid?: string } }[];
  return rows
    .filter((f) => f.path.toLowerCase().endsWith('.gguf') && !/-\d{5}-of-\d{5}\.gguf$/i.test(f.path) && !/mmproj/i.test(f.path))
    .map((f) => ({ file: f.path, size: Number(f.size) || 0, sha256: f.lfs?.oid ?? null }))
    .sort((a, b) => a.size - b.size);
}

/** Reads the quant from a file name: "...-Q4_K_M.gguf" → "Q4_K_M". */
export const quantOf = (file: string) => (file.match(/(IQ\d_[A-Z_]+|Q\d(?:_[A-Z0-9]+)*|F16|BF16|F32)\.gguf$/i)?.[1] ?? '').toUpperCase();
/** A rough parameter count from the name: "7B", "1.5B", "0.6b". */
export const paramsOf = (name: string) => Number(name.match(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/)?.[1]) || 0;
/** The KV estimate for a model we only know by size: 32 MB per 1k ctx per billion params, roughly. */
export const kvGuess = (paramsB: number) => Math.round(Math.max(24, paramsB * 32));
export const hfUrl = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;
