// The model picker on the chat page (8.11.2026): makers first (Qwen, Gemma, Llama, Phi,
// DeepSeek, then the others), a maker's series next, then the models. Hand-written: what is
// offered and in what order. The facts about each file (size, sha256, architecture, kv cache)
// are not typed here: node/tools/lineup-files.ts reads them off Hugging Face and the gguf
// headers into lineup-files.ts, and a model with no facts there is shown dimmed, never guessed.
//
// A model is either one of the phone app's catalog (`catalog`, see catalog.ts) or a file named
// here. It can run when its file is one file (the page fetches one-file models only) and
// llama.cpp b11157 knows its architecture; otherwise it is listed dimmed with the reason. How
// much memory the devices have is the page's check, at the moment it shows the list.
import { UI_CATALOG, type UiModel } from './catalog.js';
import { LINEUP_FILES, LLAMA_ARCHS, LLAMA_TAG, type FileFacts } from './lineup-files.js';

export interface FileSpec {
  id: string;
  name: string;
  repo: string;
  file?: string;          // one gguf
  parts?: string;         // a model that comes in several files: a regex on their paths
  quant: string;
  params_b: number;
  active_b?: number;      // mixture of experts: the parameters one token uses
  blurb: string;
}
export type ModelSpec = FileSpec | { catalog: string };
export interface SeriesSpec { id: string; name: string; blurb: string; models: ModelSpec[] }
export interface MakerSpec { id: string; name: string; by: string; blurb: string; series: SeriesSpec[] }

const q4 = 'Q4_K_M';

export const LINEUP: MakerSpec[] = [
  {
    id: 'qwen', name: 'Qwen', by: 'Alibaba', blurb: 'the widest range: from phone size to frontier mixtures of experts',
    series: [
      { id: 'qwen3.8', name: 'Qwen3.8', blurb: 'the newest', models: [
        { id: 'qwen3.8-27b', name: 'Qwen3.8 27B', repo: 'unsloth/Qwen3.8-27B-GGUF', file: 'Qwen3.8-27B-UD-Q4_K_M.gguf', quant: 'UD-Q4_K_M', params_b: 27, blurb: 'the newest dense qwen; a computer or several phones' },
        { id: 'qwen3.8-flash-next', name: 'Qwen3.8 Flash Next', repo: 'unsloth/Qwen3.8-Flash-Next-GGUF', parts: '^UD-IQ1_S/', quant: 'UD-IQ1_S', params_b: 0, blurb: 'the frontier flash model; a big mixture of experts' },
      ] },
      { id: 'qwen3.6', name: 'Qwen3.6', blurb: 'a dense 27B and a fast mixture of experts', models: [
        { id: 'qwen3.6-27b', name: 'Qwen3.6 27B', repo: 'unsloth/Qwen3.6-27B-GGUF', file: 'Qwen3.6-27B-Q4_K_M.gguf', quant: q4, params_b: 27, blurb: 'strong all-rounder; needs a computer or several phones' },
        { id: 'qwen3.6-35b-a3b', name: 'Qwen3.6 35B-A3B', repo: 'unsloth/Qwen3.6-35B-A3B-GGUF', file: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', quant: 'UD-Q4_K_M', params_b: 35, active_b: 3, blurb: 'mixture of experts: 35B in memory, 3B per token, so it stays quick' },
      ] },
      { id: 'qwen3.5', name: 'Qwen3.5', blurb: 'small to mid sizes, a good step up from Qwen3', models: [
        { id: 'qwen3.5-0.8b', name: 'Qwen3.5 0.8B', repo: 'unsloth/Qwen3.5-0.8B-GGUF', file: 'Qwen3.5-0.8B-Q4_K_M.gguf', quant: q4, params_b: 0.8, blurb: 'tiny; any phone' },
        { id: 'qwen3.5-2b', name: 'Qwen3.5 2B', repo: 'unsloth/Qwen3.5-2B-GGUF', file: 'Qwen3.5-2B-Q4_K_M.gguf', quant: q4, params_b: 2, blurb: 'small and quick; most phones' },
        { id: 'qwen3.5-4b', name: 'Qwen3.5 4B', repo: 'unsloth/Qwen3.5-4B-GGUF', file: 'Qwen3.5-4B-Q4_K_M.gguf', quant: q4, params_b: 4, blurb: 'a capable phone model on 8 GB phones' },
        { id: 'qwen3.5-9b', name: 'Qwen3.5 9B', repo: 'unsloth/Qwen3.5-9B-GGUF', file: 'Qwen3.5-9B-Q4_K_M.gguf', quant: q4, params_b: 9, blurb: 'a computer, or split over two phones' },
        { id: 'qwen3.5-35b-a3b', name: 'Qwen3.5 35B-A3B', repo: 'unsloth/Qwen3.5-35B-A3B-GGUF', file: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', quant: q4, params_b: 35, active_b: 3, blurb: 'mixture of experts: 3B per token' },
      ] },
      { id: 'qwen3', name: 'Qwen3', blurb: 'the phone favourites', models: [
        { catalog: 'qwen3-0.6b-q8' },
        { catalog: 'qwen3-1.7b-q8' },
        { catalog: 'qwen3-4b-q4' },
        { id: 'qwen3-8b', name: 'Qwen3 8B', repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', quant: q4, params_b: 8, blurb: 'thinks before it answers; a computer or two phones' },
        { catalog: 'qwen3-30b-a3b' },
      ] },
      { id: 'qwen-coder', name: 'Qwen Coder', blurb: 'for code', models: [
        { id: 'qwen3-coder-30b-a3b', name: 'Qwen3 Coder 30B-A3B', repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', file: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf', quant: q4, params_b: 30, active_b: 3, blurb: 'code, quick for its size' },
        { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', repo: 'unsloth/Qwen3-Coder-Next-GGUF', file: 'Qwen3-Coder-Next-Q4_K_M.gguf', quant: q4, params_b: 80, active_b: 3, blurb: 'the big coder; a computer with lots of memory' },
        { id: 'qwen2.5-coder-1.5b', name: 'Qwen2.5 Coder 1.5B', repo: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF', file: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf', quant: q4, params_b: 1.5, blurb: 'small code helper; any phone' },
        { id: 'qwen2.5-coder-7b', name: 'Qwen2.5 Coder 7B', repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', file: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', quant: q4, params_b: 7, blurb: 'code on a computer' },
      ] },
      { id: 'qwen2.5', name: 'Qwen2.5', blurb: 'the older steady ones', models: [
        { catalog: 'qwen2.5-1.5b-q4' },
        { catalog: 'qwen2.5-7b-q4' },
      ] },
    ],
  },
  {
    id: 'gemma', name: 'Gemma', by: 'Google', blurb: 'clean writing in many languages; the E models are made for phones',
    series: [
      { id: 'gemma4', name: 'Gemma 4', blurb: 'the newest gemma', models: [
        { id: 'gemma4-e2b', name: 'Gemma 4 E2B', repo: 'unsloth/gemma-4-E2B-it-GGUF', file: 'gemma-4-E2B-it-Q4_K_M.gguf', quant: q4, params_b: 2, blurb: 'made for phones' },
        { id: 'gemma4-e4b', name: 'Gemma 4 E4B', repo: 'unsloth/gemma-4-E4B-it-GGUF', file: 'gemma-4-E4B-it-Q4_K_M.gguf', quant: q4, params_b: 4, blurb: 'made for phones, a step up' },
        { id: 'gemma4-12b', name: 'Gemma 4 12B', repo: 'unsloth/gemma-4-12b-it-GGUF', file: 'gemma-4-12b-it-Q4_K_M.gguf', quant: q4, params_b: 12, blurb: 'a computer, or split over phones' },
        { catalog: 'gemma4-26b-a4b' },
        { id: 'gemma4-31b', name: 'Gemma 4 31B', repo: 'unsloth/gemma-4-31B-it-GGUF', file: 'gemma-4-31B-it-Q4_K_M.gguf', quant: q4, params_b: 31, blurb: 'the biggest gemma' },
      ] },
      { id: 'gemma3', name: 'Gemma 3', blurb: 'proven on phones', models: [
        { catalog: 'gemma3-1b-q4' },
        { catalog: 'gemma3-4b' }, // the phone's catalog since 10.11.2026: it carries its mmproj (sees photos)
        { id: 'gemma3-12b', name: 'Gemma 3 12B', repo: 'ggml-org/gemma-3-12b-it-GGUF', file: 'gemma-3-12b-it-Q4_K_M.gguf', quant: q4, params_b: 12, blurb: 'a computer' },
        { id: 'gemma3-27b', name: 'Gemma 3 27B', repo: 'ggml-org/gemma-3-27b-it-GGUF', file: 'gemma-3-27b-it-Q4_K_M.gguf', quant: q4, params_b: 27, blurb: 'the big gemma 3' },
      ] },
    ],
  },
  {
    id: 'llama', name: 'Llama', by: 'Meta', blurb: 'english first; the 70B is a classic big model',
    series: [
      { id: 'llama4', name: 'Llama 4', blurb: 'mixtures of experts', models: [
        { id: 'llama4-scout', name: 'Llama 4 Scout 17B-16E', repo: 'unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF', parts: '^Q4_K_M/', quant: q4, params_b: 109, active_b: 17, blurb: 'long context, 17B per token' },
      ] },
      { id: 'llama3.3', name: 'Llama 3.3', blurb: 'the 70B', models: [
        { id: 'llama3.3-70b', name: 'Llama 3.3 70B', repo: 'bartowski/Llama-3.3-70B-Instruct-GGUF', file: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf', quant: q4, params_b: 70, blurb: 'big and dense: slow when split' },
      ] },
      { id: 'llama3.1', name: 'Llama 3.1', blurb: 'the 8B', models: [
        { id: 'llama3.1-8b', name: 'Llama 3.1 8B', repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', file: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', quant: q4, params_b: 8, blurb: 'english all-rounder; a computer' },
      ] },
      { id: 'llama3.2', name: 'Llama 3.2', blurb: 'the phone sizes', models: [
        { catalog: 'llama3.2-1b-q4' },
        { catalog: 'llama3.2-3b-q4' },
      ] },
    ],
  },
  {
    id: 'phi', name: 'Phi', by: 'Microsoft', blurb: 'small models trained to reason',
    series: [
      { id: 'phi4', name: 'Phi-4', blurb: 'mini for phones, 14B for computers', models: [
        { catalog: 'phi4-mini-q4' },
        { id: 'phi4-mini-reasoning', name: 'Phi-4 mini reasoning', repo: 'bartowski/microsoft_Phi-4-mini-reasoning-GGUF', file: 'microsoft_Phi-4-mini-reasoning-Q4_K_M.gguf', quant: q4, params_b: 3.8, blurb: 'maths and step by step on a phone' },
        { id: 'phi4-14b', name: 'Phi-4 14B', repo: 'bartowski/phi-4-GGUF', file: 'phi-4-Q4_K_M.gguf', quant: q4, params_b: 14, blurb: 'a computer' },
        { id: 'phi4-reasoning-plus', name: 'Phi-4 reasoning plus', repo: 'bartowski/microsoft_Phi-4-reasoning-plus-GGUF', file: 'microsoft_Phi-4-reasoning-plus-Q4_K_M.gguf', quant: q4, params_b: 14, blurb: 'long careful reasoning' },
      ] },
    ],
  },
  {
    id: 'deepseek', name: 'DeepSeek', by: 'DeepSeek', blurb: 'the frontier flash models, and small R1 distills that fit phones',
    series: [
      { id: 'deepseek-v4', name: 'DeepSeek V4', blurb: 'frontier mixtures of experts; hundreds of GB', models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017', repo: 'unsloth/DeepSeek-V4.1-Flash-1017-GGUF', parts: '^UD-IQ1_S/', quant: 'UD-IQ1_S', params_b: 748, blurb: 'the newest frontier flash model' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash 0731', repo: 'unsloth/DeepSeek-V4-Flash-0731-GGUF', parts: '^UD-IQ1_S/', quant: 'UD-IQ1_S', params_b: 0, blurb: 'the first V4 flash' },
      ] },
      { id: 'deepseek-r1', name: 'DeepSeek R1 distills', blurb: 'R1 reasoning taught to small Qwen models', models: [
        { id: 'deepseek-r1-0528-qwen3-8b', name: 'R1 0528 Qwen3 8B', repo: 'bartowski/deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-GGUF', file: 'deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf', quant: q4, params_b: 8, blurb: 'the best small R1; a computer' },
        { id: 'deepseek-r1-qwen-1.5b', name: 'R1 Distill Qwen 1.5B', repo: 'bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF', file: 'DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf', quant: q4, params_b: 1.5, blurb: 'thinks out loud; any phone' },
        { id: 'deepseek-r1-qwen-7b', name: 'R1 Distill Qwen 7B', repo: 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF', file: 'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf', quant: q4, params_b: 7, blurb: 'maths and logic' },
        { id: 'deepseek-r1-qwen-14b', name: 'R1 Distill Qwen 14B', repo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF', file: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf', quant: q4, params_b: 14, blurb: 'stronger reasoning; a computer' },
      ] },
    ],
  },
  {
    id: 'mistral', name: 'Mistral', by: 'Mistral AI', blurb: 'european models; Devstral is for code',
    series: [
      { id: 'mistral-small', name: 'Mistral Small', blurb: '24B', models: [
        { id: 'mistral-small-3.2', name: 'Mistral Small 3.2 24B', repo: 'bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF', file: 'mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf', quant: q4, params_b: 24, blurb: 'a strong mid-size all-rounder' },
        { id: 'devstral-small-2', name: 'Devstral Small 2 24B', repo: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF', file: 'Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf', quant: q4, params_b: 24, blurb: 'code agent work' },
      ] },
      { id: 'mistral-7b', name: 'Mistral 7B and Ministral', blurb: 'the small ones', models: [
        { id: 'ministral-8b', name: 'Ministral 8B', repo: 'bartowski/Ministral-8B-Instruct-2410-GGUF', file: 'Ministral-8B-Instruct-2410-Q4_K_M.gguf', quant: q4, params_b: 8, blurb: 'a computer' },
        { id: 'mistral-7b-v0.3', name: 'Mistral 7B v0.3', repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF', file: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf', quant: q4, params_b: 7, blurb: 'the classic 7B' },
      ] },
    ],
  },
  {
    id: 'openai', name: 'gpt-oss', by: 'OpenAI', blurb: 'openai’s open weights; mixtures of experts',
    series: [
      { id: 'gpt-oss', name: 'gpt-oss', blurb: '20B and 120B', models: [
        { id: 'gpt-oss-20b', name: 'gpt-oss 20B', repo: 'ggml-org/gpt-oss-20b-GGUF', file: 'gpt-oss-20b-MXFP4.gguf', quant: 'MXFP4', params_b: 21, active_b: 3.6, blurb: 'quick for its size: 3.6B per token' },
        { id: 'gpt-oss-120b', name: 'gpt-oss 120B', repo: 'ggml-org/gpt-oss-120b-GGUF', file: 'gpt-oss-120b-MXFP4.gguf', quant: 'MXFP4', params_b: 117, active_b: 5.1, blurb: 'frontier class; about 63 GB' },
      ] },
    ],
  },
  {
    id: 'glm', name: 'GLM', by: 'Z.ai', blurb: 'strong agents and code',
    series: [
      { id: 'glm-flash', name: 'GLM Flash', blurb: 'the mid size', models: [
        { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', repo: 'unsloth/GLM-4.7-Flash-GGUF', file: 'GLM-4.7-Flash-Q4_K_M.gguf', quant: q4, params_b: 30, blurb: 'a mixture of experts for a computer' },
      ] },
      { id: 'glm-big', name: 'GLM big', blurb: 'frontier sizes', models: [
        { id: 'glm-4.5-air', name: 'GLM 4.5 Air', repo: 'unsloth/GLM-4.5-Air-GGUF', parts: '^Q4_K_M/', quant: q4, params_b: 106, active_b: 12, blurb: '106B, 12B per token' },
        { id: 'glm-5.3', name: 'GLM 5.3', repo: 'unsloth/GLM-5.3-GGUF', parts: '^UD-IQ1_S/', quant: 'UD-IQ1_S', params_b: 0, blurb: 'the frontier glm' },
      ] },
    ],
  },
  {
    id: 'kimi', name: 'Kimi', by: 'Moonshot AI', blurb: 'a trillion-parameter frontier model',
    series: [
      { id: 'kimi-k', name: 'Kimi K', blurb: 'frontier', models: [
        { id: 'kimi-k3', name: 'Kimi K3', repo: 'unsloth/Kimi-K3-GGUF', parts: '^UD-IQ1_S/', quant: 'UD-IQ1_S', params_b: 0, blurb: 'the frontier kimi' },
      ] },
    ],
  },
  {
    id: 'more', name: 'more small ones', by: 'Hugging Face, NVIDIA, Liquid', blurb: 'small models from other makers',
    series: [
      { id: 'vision', name: 'sees photos', blurb: 'vision models: the model and its image encoder (mmproj)', models: [
        { catalog: 'smolvlm-500m-q8' },
        { catalog: 'smolvlm2-2.2b-q4' },
      ] },
      { id: 'small-others', name: 'small and efficient', blurb: 'phones and laptops', models: [
        { id: 'smollm3-3b', name: 'SmolLM3 3B', repo: 'ggml-org/SmolLM3-3B-GGUF', file: 'SmolLM3-Q4_K_M.gguf', quant: q4, params_b: 3, blurb: 'hugging face’s open 3B; phones' },
        { id: 'nemotron-3.5-bolt-e4b', name: 'Nemotron 3.5 Bolt E4B', repo: 'unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF', file: 'NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q4_K_XL.gguf', quant: 'UD-Q4_K_XL', params_b: 4, blurb: 'nvidia’s small one' },
        { id: 'lfm2.5-24b-a2b', name: 'LFM2.5 24B-A2B', repo: 'unsloth/LFM2.5-24B-A2B-GGUF', file: 'LFM2.5-24B-A2B-UD-Q4_K_XL.gguf', quant: 'UD-Q4_K_XL', params_b: 24, active_b: 2, blurb: 'liquid’s mixture of experts: 2B per token' },
      ] },
    ],
  },
];

export const isFile = (m: ModelSpec): m is FileSpec => !('catalog' in m);
export const fileSpecs = (): FileSpec[] => LINEUP.flatMap((k) => k.series.flatMap((s) => s.models.filter(isFile)));

const GB = 1e9;
// why a model named here cannot run yet; null when it can
export function whyNot(spec: FileSpec, facts: FileFacts | undefined = LINEUP_FILES[spec.id]): string | null {
  if (!facts) return 'not checked yet: its file facts are missing';
  if (!LLAMA_ARCHS.includes(facts.arch)) return `llama.cpp ${LLAMA_TAG} cannot run its architecture (${facts.arch}) yet`;
  if (facts.parts > 1) return `comes in ${facts.parts} files (${Math.round(facts.size / GB)} GB); the chat page fetches one-file models only`;
  return null;
}

// The models named here that can run, in the shape the engine's catalog takes.
export const LINEUP_EXTRA: UiModel[] = fileSpecs().flatMap((s) => {
  const f = LINEUP_FILES[s.id];
  if (!f || whyNot(s, f)) return [];
  return [{
    id: s.id, name: s.name, family: f.arch, params_b: s.params_b, ...(s.active_b ? { active_b: s.active_b } : {}), quant: s.quant, repo: s.repo, file: s.file!,
    size: f.size, sha256: f.sha256, license: f.license, ctx_max: f.ctx_max, kv_mb_per_1k: f.kv_mb_per_1k, blurb: s.blurb, good: '',
  }];
});

export const FULL_CATALOG: UiModel[] = [...UI_CATALOG, ...LINEUP_EXTRA.filter((m) => !UI_CATALOG.some((c) => c.id === m.id))];

// What GET lineup answers: the tree, each model either the id of a row in GET models (it can
// run) or a dimmed entry with its reason. Memory is the page's check: it knows the devices.
export interface LineupModel { id: string; name: string; quant: string; size: number | null; params_b: number | null; active_b: number | null; blurb: string; why: string | null }
export interface LineupSeries { id: string; name: string; blurb: string; models: LineupModel[] }
export interface LineupMaker { id: string; name: string; by: string; blurb: string; series: LineupSeries[] }
export interface LineupView { makers: LineupMaker[]; hereFreeMb: number; hereTotalMb: number; llama: string }

export function lineupView(hereFreeMb: number, hereTotalMb: number): LineupView {
  const makers = LINEUP.map((k) => ({
    id: k.id, name: k.name, by: k.by, blurb: k.blurb,
    series: k.series.map((s) => ({
      id: s.id, name: s.name, blurb: s.blurb,
      models: s.models.flatMap((m): LineupModel[] => {
        if (!isFile(m)) {
          const c = UI_CATALOG.find((x) => x.id === m.catalog);
          return c ? [{ id: c.id, name: c.name, quant: c.quant, size: c.size, params_b: c.params_b, active_b: c.active_b ?? null, blurb: c.blurb, why: null }] : [];
        }
        const f = LINEUP_FILES[m.id];
        return [{ id: m.id, name: m.name, quant: m.quant, size: f?.size ?? null, params_b: m.params_b || null, active_b: m.active_b ?? null, blurb: m.blurb, why: whyNot(m, f) }];
      }),
    })),
  }));
  return { makers, hereFreeMb, hereTotalMb, llama: LLAMA_TAG };
}
