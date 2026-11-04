// The chosen list: models known to run on phones with llama.cpp, one file each, verified
// against the Hugging Face API on 4.11.2026 (size and sha256 are the LFS object's). A
// download is only kept when its sha256 matches. Sizes are bytes. kv_mb_per_1k is the KV
// cache per 1 024 tokens of context (layers × heads_kv × (k+v dims) × 2 bytes), read off
// each model's GGUF header, for the fit estimate before the file is on the phone.
export type Lang = 'en' | 'de' | 'tr';
export type CatalogModel = {
  id: string;
  name: string;
  family: string;
  params_b: number;
  quant: string;
  repo: string;
  file: string;
  size: number;
  sha256: string;
  license: string;
  license_url: string;
  ctx_max: number;
  kv_mb_per_1k: number;
  blurb: Record<Lang, string>;
};

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;
export const modelUrl = (m: Pick<CatalogModel, 'repo' | 'file'>) => hf(m.repo, m.file);

export const CATALOG: CatalogModel[] = [
  {
    id: 'qwen3-0.6b-q8', name: 'Qwen3 0.6B', family: 'qwen3', params_b: 0.6, quant: 'Q8_0',
    repo: 'Qwen/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q8_0.gguf', size: 639446688,
    sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF', ctx_max: 32768, kv_mb_per_1k: 56,
    blurb: { en: 'the smallest that still talks; runs on any phone', de: 'das kleinste, das noch redet; läuft auf jedem telefon', tr: 'hâlâ konuşan en küçüğü; her telefonda çalışır' },
  },
  {
    id: 'gemma3-1b-q4', name: 'Gemma 3 1B', family: 'gemma3', params_b: 1, quant: 'Q4_K_M',
    repo: 'ggml-org/gemma-3-1b-it-GGUF', file: 'gemma-3-1b-it-Q4_K_M.gguf', size: 806058240,
    sha256: '8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135',
    license: 'gemma', license_url: 'https://ai.google.dev/gemma/terms', ctx_max: 32768, kv_mb_per_1k: 26,
    blurb: { en: 'google’s small one; good at short answers', de: 'googles kleines; gut bei kurzen antworten', tr: 'google’ın küçüğü; kısa cevaplarda iyi' },
  },
  {
    id: 'llama3.2-1b-q4', name: 'Llama 3.2 1B', family: 'llama3', params_b: 1, quant: 'Q4_K_M',
    repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', size: 807694464,
    sha256: '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
    license: 'llama3.2', license_url: 'https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct/blob/main/LICENSE.txt', ctx_max: 131072, kv_mb_per_1k: 32,
    blurb: { en: 'meta’s small one; english first', de: 'metas kleines; englisch zuerst', tr: 'meta’nın küçüğü; önce ingilizce' },
  },
  {
    id: 'qwen2.5-1.5b-q4', name: 'Qwen2.5 1.5B', family: 'qwen2', params_b: 1.5, quant: 'Q4_K_M',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', size: 1117320736,
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF', ctx_max: 32768, kv_mb_per_1k: 28,
    blurb: { en: 'a steady all-rounder for 4 gb phones', de: 'ein solider allrounder für 4-gb-telefone', tr: '4 gb telefonlar için dengeli bir model' },
  },
  {
    id: 'qwen3-1.7b-q8', name: 'Qwen3 1.7B', family: 'qwen3', params_b: 1.7, quant: 'Q8_0',
    repo: 'Qwen/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q8_0.gguf', size: 1834426016,
    sha256: '061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF', ctx_max: 32768, kv_mb_per_1k: 112,
    blurb: { en: 'thinks a little before it answers; 6 gb phones', de: 'denkt kurz nach, bevor es antwortet; 6-gb-telefone', tr: 'cevaplamadan önce biraz düşünür; 6 gb telefonlar' },
  },
  {
    id: 'llama3.2-3b-q4', name: 'Llama 3.2 3B', family: 'llama3', params_b: 3, quant: 'Q4_K_M',
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', size: 2019377696,
    sha256: '6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff',
    license: 'llama3.2', license_url: 'https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/main/LICENSE.txt', ctx_max: 131072, kv_mb_per_1k: 112,
    blurb: { en: 'the usual choice on 6–8 gb phones', de: 'die übliche wahl auf 6–8-gb-telefonen', tr: '6–8 gb telefonlarda olağan seçim' },
  },
  {
    id: 'qwen3-4b-q4', name: 'Qwen3 4B', family: 'qwen3', params_b: 4, quant: 'Q4_K_M',
    repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', size: 2497280256,
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF', ctx_max: 32768, kv_mb_per_1k: 144,
    blurb: { en: 'strong for its size; 8 gb phones', de: 'stark für seine größe; 8-gb-telefone', tr: 'boyutuna göre güçlü; 8 gb telefonlar' },
  },
  {
    id: 'phi4-mini-q4', name: 'Phi-4 mini', family: 'phi3', params_b: 3.8, quant: 'Q4_K_M',
    repo: 'bartowski/microsoft_Phi-4-mini-instruct-GGUF', file: 'microsoft_Phi-4-mini-instruct-Q4_K_M.gguf', size: 2491874688,
    sha256: '01999f17c39cc3074afae5e9c539bc82d45f2dd7faa3917c66cbef76fce8c0c2',
    license: 'mit', license_url: 'https://huggingface.co/microsoft/Phi-4-mini-instruct/blob/main/LICENSE', ctx_max: 131072, kv_mb_per_1k: 96,
    blurb: { en: 'microsoft’s small one; reasoning and code', de: 'microsofts kleines; logik und code', tr: 'microsoft’un küçüğü; akıl yürütme ve kod' },
  },
  {
    id: 'qwen2.5-7b-q4', name: 'Qwen2.5 7B', family: 'qwen2', params_b: 7, quant: 'Q4_K_M',
    repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', size: 4683074240,
    sha256: '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct', ctx_max: 32768, kv_mb_per_1k: 56,
    blurb: { en: 'too big for one phone: this is what split mode is for', de: 'zu groß für ein telefon: dafür ist der geteilte modus da', tr: 'tek telefona büyük: bölünmüş mod bunun için var' },
  },
];

export const catalogById = (id: string) => CATALOG.find((m) => m.id === id) ?? null;
