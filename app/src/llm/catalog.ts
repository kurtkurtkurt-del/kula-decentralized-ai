// The chosen list: models known to run on phones with llama.cpp, one file each, verified
// against the Hugging Face API on 4.11.2026 (size and sha256 are the LFS object's). A
// download is only kept when its sha256 matches. Sizes are bytes. kv_mb_per_1k is the KV
// cache per 1 024 tokens of context (layers × heads_kv × (k+v dims) × 2 bytes), read off
// each model's GGUF header, for the fit estimate before the file is on the phone.
//
// A vision model (10.11.2026, photos in night projects) is two files: the language model and
// its mmproj (the image encoder, for llama.cpp's mtmd), each with its own sha256; both are
// downloaded and checked. `size` and `sha256` stay the model file's (what every downloader
// checks, the computer's too); `mmproj` carries the encoder's own file, size and sha256.
export type Lang = 'en' | 'de' | 'tr';
export type CatalogModel = {
  id: string;
  name: string;
  family: string;
  params_b: number;
  // mixture of experts (10.11.2026): the parameters one token uses, from the model card. Speed
  // estimates use these (fit.ts activeShare, sim/ activeShare); memory uses the whole file.
  active_b?: number;
  // the share of the file's bytes one token reads, measured off the file's tensor table (the
  // routed *_exps tensors at expert_used_count / expert_count, the rest whole; kula-node gguf.ts
  // activeShareOf). Closer to the bandwidth than active_b / params_b when the experts are
  // quantized harder than the rest or the embedding is large: the speed estimate prefers it.
  read_share?: number;
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
  good: Record<Lang, string>;   // what it does well
  use: Record<Lang, string>;    // what to use it for
  mmproj?: { file: string; size: number; sha256: string }; // a vision model's image encoder, same repo
};

/** Sees photos: carries an mmproj. */
export const isVision = (m: { mmproj?: unknown }) => !!m.mmproj;

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;
export const modelUrl = (m: Pick<CatalogModel, 'repo' | 'file'>) => hf(m.repo, m.file);

export const CATALOG: CatalogModel[] = [
  {
    id: 'qwen3-0.6b-q8', name: 'Qwen3 0.6B', family: 'qwen3', params_b: 0.6, quant: 'Q8_0',
    repo: 'Qwen/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q8_0.gguf', size: 639446688,
    sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF', ctx_max: 32768, kv_mb_per_1k: 56,
    blurb: { en: 'the smallest that still talks; runs on any phone', de: 'das kleinste, das noch redet; läuft auf jedem telefon', tr: 'hâlâ konuşan en küçüğü; her telefonda çalışır' },
    good: { en: 'short answers, lists, simple rewrites; surprisingly fluent for its size, in english and turkish. weak at maths and long reasoning.', de: 'kurze antworten, listen, einfache umformulierungen; für seine größe erstaunlich flüssig, auf englisch und türkisch. schwach bei mathe und langem denken.', tr: 'kısa cevaplar, listeler, basit yeniden yazımlar; boyutuna göre şaşırtıcı akıcı, ingilizce ve türkçe. matematikte ve uzun akıl yürütmede zayıf.' },
    use: { en: 'trying the app, old or small phones, a first night job (classifying short texts, tagging). the fastest download.', de: 'die app ausprobieren, alte oder kleine telefone, ein erster nachtauftrag (kurze texte klassifizieren, taggen). der schnellste download.', tr: 'uygulamayı denemek, eski ya da küçük telefonlar, ilk gece işi (kısa metin sınıflama, etiketleme). en hızlı indirme.' },
  },
  {
    id: 'gemma3-1b-q4', name: 'Gemma 3 1B', family: 'gemma3', params_b: 1, quant: 'Q4_K_M',
    repo: 'ggml-org/gemma-3-1b-it-GGUF', file: 'gemma-3-1b-it-Q4_K_M.gguf', size: 806058240,
    sha256: '8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135',
    license: 'gemma', license_url: 'https://ai.google.dev/gemma/terms', ctx_max: 32768, kv_mb_per_1k: 26,
    blurb: { en: 'google’s small one; good at short answers', de: 'googles kleines; gut bei kurzen antworten', tr: 'google’ın küçüğü; kısa cevaplarda iyi' },
    good: { en: 'clean short prose, summaries of a paragraph, question answering over a short text. 140 languages.', de: 'saubere kurze prosa, zusammenfassungen eines absatzes, fragen zu einem kurzen text. 140 sprachen.', tr: 'temiz kısa düzyazı, bir paragrafın özeti, kısa bir metin üzerinden soru-cevap. 140 dil.' },
    use: { en: 'summarising and translating short texts on a 4 gb phone; a night job that reads a lot and writes little.', de: 'kurze texte zusammenfassen und übersetzen auf einem 4-gb-telefon; ein nachtauftrag, der viel liest und wenig schreibt.', tr: '4 gb telefonda kısa metin özetleme ve çeviri; çok okuyup az yazan bir gece işi.' },
  },
  {
    id: 'llama3.2-1b-q4', name: 'Llama 3.2 1B', family: 'llama3', params_b: 1, quant: 'Q4_K_M',
    repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', size: 807694464,
    sha256: '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
    license: 'llama3.2', license_url: 'https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct/blob/main/LICENSE.txt', ctx_max: 131072, kv_mb_per_1k: 32,
    blurb: { en: 'meta’s small one; english first', de: 'metas kleines; englisch zuerst', tr: 'meta’nın küçüğü; önce ingilizce' },
    good: { en: 'english instructions, simple extraction (names, dates, fields from a text), friendly chat.', de: 'englische anweisungen, einfache extraktion (namen, daten, felder aus einem text), freundlicher chat.', tr: 'ingilizce yönergeler, basit çıkarım (bir metinden adlar, tarihler, alanlar), rahat sohbet.' },
    use: { en: 'structured extraction jobs in english on small phones; pairs well with a bigger model on a computer.', de: 'strukturierte extraktionsaufträge auf englisch auf kleinen telefonen; passt gut zu einem größeren modell am computer.', tr: 'küçük telefonlarda ingilizce yapılandırılmış çıkarım işleri; bilgisayardaki büyük bir modelle iyi eşleşir.' },
  },
  {
    id: 'qwen2.5-1.5b-q4', name: 'Qwen2.5 1.5B', family: 'qwen2', params_b: 1.5, quant: 'Q4_K_M',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', size: 1117320736,
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF', ctx_max: 32768, kv_mb_per_1k: 28,
    blurb: { en: 'a steady all-rounder for 4 gb phones', de: 'ein solider allrounder für 4-gb-telefone', tr: '4 gb telefonlar için dengeli bir model' },
    good: { en: 'balanced: writing, summaries, light code, 29 languages incl. turkish and german. follows formats (json, lists) well.', de: 'ausgewogen: schreiben, zusammenfassungen, leichter code, 29 sprachen inkl. türkisch und deutsch. hält formate (json, listen) gut ein.', tr: 'dengeli: yazı, özet, hafif kod, türkçe ve almanca dahil 29 dil. biçimlere (json, liste) iyi uyar.' },
    use: { en: 'the everyday choice on a 4–6 gb phone; night jobs that need json output.', de: 'die alltagswahl auf einem 4–6-gb-telefon; nachtaufträge, die json ausgeben sollen.', tr: '4–6 gb telefonda günlük seçim; json çıktısı isteyen gece işleri.' },
  },
  {
    id: 'qwen3-1.7b-q8', name: 'Qwen3 1.7B', family: 'qwen3', params_b: 1.7, quant: 'Q8_0',
    repo: 'Qwen/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q8_0.gguf', size: 1834426016,
    sha256: '061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF', ctx_max: 32768, kv_mb_per_1k: 112,
    blurb: { en: 'thinks a little before it answers; 6 gb phones', de: 'denkt kurz nach, bevor es antwortet; 6-gb-telefone', tr: 'cevaplamadan önce biraz düşünür; 6 gb telefonlar' },
    good: { en: 'reasons step by step before answering (can be switched off with /no_think); better maths and logic than the 1b class; good turkish.', de: 'denkt schrittweise, bevor es antwortet (mit /no_think abschaltbar); bessere mathe und logik als die 1b-klasse; gutes türkisch.', tr: 'cevaplamadan önce adım adım düşünür (/no_think ile kapatılır); 1b sınıfından daha iyi matematik ve mantık; iyi türkçe.' },
    use: { en: 'questions that need a little thinking on a 6 gb phone; slower per answer, so not for bulk tagging.', de: 'fragen, die etwas nachdenken brauchen, auf einem 6-gb-telefon; langsamer pro antwort, also nicht fürs massen-taggen.', tr: '6 gb telefonda biraz düşünme isteyen sorular; cevap başına yavaş, toplu etiketleme için değil.' },
  },
  {
    id: 'llama3.2-3b-q4', name: 'Llama 3.2 3B', family: 'llama3', params_b: 3, quant: 'Q4_K_M',
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', size: 2019377696,
    sha256: '6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff',
    license: 'llama3.2', license_url: 'https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/main/LICENSE.txt', ctx_max: 131072, kv_mb_per_1k: 112,
    blurb: { en: 'the usual choice on 6–8 gb phones', de: 'die übliche wahl auf 6–8-gb-telefonen', tr: '6–8 gb telefonlarda olağan seçim' },
    good: { en: 'solid general assistant in english: longer answers, rewriting, instructions, some code. the most tested model of this size.', de: 'solider allgemeiner assistent auf englisch: längere antworten, umschreiben, anweisungen, etwas code. das meistgetestete modell dieser größe.', tr: 'ingilizcede sağlam genel asistan: uzun cevaplar, yeniden yazma, yönergeler, biraz kod. bu boyutun en çok test edilmiş modeli.' },
    use: { en: 'a 6–8 gb phone as the main device; english writing jobs at night.', de: 'ein 6–8-gb-telefon als hauptgerät; englische schreibaufträge in der nacht.', tr: 'ana cihaz olarak 6–8 gb telefon; gece ingilizce yazı işleri.' },
  },
  {
    id: 'qwen3-4b-q4', name: 'Qwen3 4B', family: 'qwen3', params_b: 4, quant: 'Q4_K_M',
    repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', size: 2497280256,
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF', ctx_max: 32768, kv_mb_per_1k: 144,
    blurb: { en: 'strong for its size; 8 gb phones', de: 'stark für seine größe; 8-gb-telefone', tr: 'boyutuna göre güçlü; 8 gb telefonlar' },
    good: { en: "close to last year's 7b models: reasoning, code, multilingual writing, long context. thinking mode on by default.", de: 'nahe an den 7b-modellen vom letzten jahr: logik, code, mehrsprachiges schreiben, langer kontext. denkmodus standardmäßig an.', tr: 'geçen yılın 7b modellerine yakın: akıl yürütme, kod, çok dilli yazı, uzun bağlam. düşünme modu varsayılan açık.' },
    use: { en: 'the best a flagship phone runs alone; harder night jobs (evaluation, distillation). warm phone, slower.', de: 'das beste, was ein flaggschiff-telefon allein schafft; schwerere nachtaufträge (bewertung, destillation). warmes telefon, langsamer.', tr: 'amiral gemisi bir telefonun tek başına çalıştırabileceği en iyisi; zor gece işleri (değerlendirme, damıtma). telefon ısınır, yavaştır.' },
  },
  {
    id: 'phi4-mini-q4', name: 'Phi-4 mini', family: 'phi3', params_b: 3.8, quant: 'Q4_K_M',
    repo: 'bartowski/microsoft_Phi-4-mini-instruct-GGUF', file: 'microsoft_Phi-4-mini-instruct-Q4_K_M.gguf', size: 2491874688,
    sha256: '01999f17c39cc3074afae5e9c539bc82d45f2dd7faa3917c66cbef76fce8c0c2',
    license: 'mit', license_url: 'https://huggingface.co/microsoft/Phi-4-mini-instruct/blob/main/LICENSE', ctx_max: 131072, kv_mb_per_1k: 96,
    blurb: { en: 'microsoft’s small one; reasoning and code', de: 'microsofts kleines; logik und code', tr: 'microsoft’un küçüğü; akıl yürütme ve kod' },
    good: { en: 'maths, logic puzzles, code; terse and precise. weaker at casual chat and at turkish.', de: 'mathe, logikrätsel, code; knapp und präzise. schwächer bei lockerem chat und bei türkisch.', tr: 'matematik, mantık bulmacaları, kod; kısa ve kesin. gündelik sohbette ve türkçede daha zayıf.' },
    use: { en: 'code and maths jobs on an 8 gb phone; grading answers with a known solution.', de: 'code- und matheaufträge auf einem 8-gb-telefon; antworten mit bekannter lösung bewerten.', tr: '8 gb telefonda kod ve matematik işleri; çözümü bilinen cevapları puanlama.' },
  },
  {
    id: 'qwen2.5-7b-q4', name: 'Qwen2.5 7B', family: 'qwen2', params_b: 7, quant: 'Q4_K_M',
    repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', size: 4683074240,
    sha256: '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct', ctx_max: 32768, kv_mb_per_1k: 56,
    blurb: { en: 'too big for one phone: this is what split mode is for', de: 'zu groß für ein telefon: dafür ist der geteilte modus da', tr: 'tek telefona büyük: bölünmüş mod bunun için var' },
    good: { en: 'a real assistant: long documents, careful writing, code, 29 languages. the quality step above everything on this list.', de: 'ein echter assistent: lange dokumente, sorgfältiges schreiben, code, 29 sprachen. die qualitätsstufe über allem auf dieser liste.', tr: 'gerçek bir asistan: uzun belgeler, özenli yazı, kod, 29 dil. bu listedeki her şeyin bir üst kalite basamağı.' },
    use: { en: 'split mode across two or three phones, or apart mode with a computer; the model to pick when the job needs quality over speed.', de: 'geteilter modus über zwei oder drei telefone oder getrennter modus mit einem computer; das modell, wenn qualität vor geschwindigkeit geht.', tr: 'iki üç telefonla bölünmüş mod ya da bilgisayarla ayrı mod; iş hızdan çok kalite istiyorsa seçilecek model.' },
  },
  // mixtures of experts (10.11.2026): verified against the Hugging Face API the same way; kv and
  // ctx from each file's gguf header (qwen3moe, gemma4: both known to llama.cpp b11157). The
  // ids are the chat page's (node/src/ui/lineup.ts), so a pick there stays the same model.
  {
    id: 'qwen3-30b-a3b', name: 'Qwen3 30B-A3B', family: 'qwen3moe', params_b: 30.5, active_b: 3.3, read_share: 0.113, quant: 'Q4_K_M',
    repo: 'Qwen/Qwen3-30B-A3B-GGUF', file: 'Qwen3-30B-A3B-Q4_K_M.gguf', size: 18556685824,
    sha256: '0d003f6662faee786ed5da3e31b29c978de5ae5d275c8794c606a7f3c01aa8f5',
    license: 'apache-2.0', license_url: 'https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF/blob/main/LICENSE', ctx_max: 40960, kv_mb_per_1k: 96,
    blurb: { en: 'a mixture of experts: 30B in memory, about 3B per token', de: 'eine mischung aus experten: 30B im speicher, etwa 3B pro token', tr: 'uzmanlar karışımı: bellekte 30B, token başına yaklaşık 3B' },
    good: { en: 'the knowledge and reasoning of a 30b model at close to the speed of a 3b one: writing, code, maths, 119 languages. thinking mode on by default.', de: 'das wissen und denken eines 30b-modells fast im tempo eines 3b-modells: schreiben, code, mathe, 119 sprachen. denkmodus standardmäßig an.', tr: '30b bir modelin bilgisi ve akıl yürütmesi, 3b bir modele yakın hızda: yazı, kod, matematik, 119 dil. düşünme modu varsayılan açık.' },
    use: { en: 'a computer with 24 gb or more, or split over phones that hold 18 gb together; quick on one big device, held back by wi-fi when split.', de: 'ein computer mit 24 gb oder mehr, oder geteilt über telefone, die zusammen 18 gb halten; schnell auf einem großen gerät, geteilt bremst das wlan.', tr: '24 gb ya da daha fazla belleği olan bir bilgisayar, ya da birlikte 18 gb tutan telefonlara bölünmüş; tek büyük cihazda hızlı, bölününce wi-fi yavaşlatır.' },
  },
  {
    id: 'gemma4-26b-a4b', name: 'Gemma 4 26B-A4B', family: 'gemma4', params_b: 25.2, active_b: 3.8, read_share: 0.205, quant: 'UD-Q4_K_M',
    repo: 'unsloth/gemma-4-26B-A4B-it-GGUF', file: 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf', size: 16947541728,
    sha256: 'f2c28b3dc4776931ac6f879e11f203dec637ea0f14267a86ec8f6165f63f293f',
    license: 'apache-2.0', license_url: 'https://ai.google.dev/gemma/docs/gemma_4_license', ctx_max: 262144, kv_mb_per_1k: 420,
    blurb: { en: 'google’s mixture of experts: 26B in memory, about 4B per token', de: 'googles mischung aus experten: 26B im speicher, etwa 4B pro token', tr: 'google’ın uzmanlar karışımı: bellekte 26B, token başına yaklaşık 4B' },
    good: { en: 'clean writing in 140 languages, reasoning and code close to the dense 31b, at about the speed of a 4b model. long context (256k).', de: 'saubere texte in 140 sprachen, denken und code nahe am dichten 31b, etwa im tempo eines 4b-modells. langer kontext (256k).', tr: '140 dilde temiz yazı, yoğun 31b’ye yakın akıl yürütme ve kod, 4b bir model hızında. uzun bağlam (256k).' },
    use: { en: 'a computer with 24 gb or more, or split over phones that hold 17 gb together; its kv cache is large, so keep the context short on phones.', de: 'ein computer mit 24 gb oder mehr, oder geteilt über telefone, die zusammen 17 gb halten; sein kv-cache ist groß, also auf telefonen den kontext kurz halten.', tr: '24 gb ya da daha fazla belleği olan bir bilgisayar, ya da birlikte 17 gb tutan telefonlara bölünmüş; kv önbelleği büyük, telefonlarda bağlamı kısa tut.' },
  },
  // ---- vision models (10.11.2026): each with its mmproj; the vision-model setting picks the one
  // that reads photos (llm/vision.ts), the smallest downloaded one by default
  {
    // verified against the Hugging Face API on 10.11.2026; sizes are the LFS objects'.
    // Text side: SmolLM2 360M (llama arch, 32 layers, 5 kv heads: 40 MB per 1k).
    id: 'smolvlm-500m-q8', name: 'SmolVLM 500M', family: 'smolvlm', params_b: 0.5, quant: 'Q8_0',
    repo: 'ggml-org/SmolVLM-500M-Instruct-GGUF', file: 'SmolVLM-500M-Instruct-Q8_0.gguf', size: 436806912,
    sha256: '9d4612de6a42214499e301494a3ecc2be0abdd9de44e663bda63f1152fad1bf4',
    mmproj: { file: 'mmproj-SmolVLM-500M-Instruct-Q8_0.gguf', size: 108783360, sha256: 'd1eb8b6b23979205fdf63703ed10f788131a3f812c7b1f72e0119d5d81295150' },
    license: 'apache-2.0', license_url: 'https://huggingface.co/HuggingFaceTB/SmolVLM-500M-Instruct', ctx_max: 8192, kv_mb_per_1k: 40,
    blurb: { en: 'sees photos; the smallest, any phone', de: 'sieht fotos; das kleinste, jedes telefon', tr: 'fotoğrafları görür; en küçüğü, her telefonda' },
    good: { en: 'a short, plain description of a photo: what is in it, colours, text on signs and labels. too small to write or reason about it.', de: 'eine kurze, schlichte beschreibung eines fotos: was darauf ist, farben, text auf schildern und etiketten. zu klein, um darüber zu schreiben oder nachzudenken.', tr: 'bir fotoğrafın kısa, sade tarifi: içinde ne var, renkler, tabela ve etiketlerdeki yazı. üzerine yazmak ya da düşünmek için fazla küçük.' },
    use: { en: 'the vision model on a small phone: it reads the photo, your chat model answers. two files, the model and its image encoder.', de: 'das bildmodell auf einem kleinen telefon: es liest das foto, dein chatmodell antwortet. zwei dateien, das modell und sein bild-encoder.', tr: 'küçük telefonda görüntü modeli: fotoğrafı o okur, sohbet modelin cevaplar. iki dosya: model ve görüntü kodlayıcısı.' },
  },
  {
    // verified against the Hugging Face API on 10.11.2026; sizes are the LFS objects'.
    // Text side: llama arch, 24 layers, no grouped kv (192 MB per 1k tokens).
    id: 'smolvlm2-2.2b-q4', name: 'SmolVLM2 2.2B', family: 'smolvlm', params_b: 2.2, quant: 'Q4_K_M',
    repo: 'ggml-org/SmolVLM2-2.2B-Instruct-GGUF', file: 'SmolVLM2-2.2B-Instruct-Q4_K_M.gguf', size: 1112602656,
    sha256: '0cf76814555b8665149075b74ab6b5c1d428ea1d3d01c1918c12012e8d7c9f58',
    mmproj: { file: 'mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf', size: 592523200, sha256: 'ae07ea1facd07dd3230c4483b63e8cda96c6944ad2481f33d531f79e892dd024' },
    license: 'apache-2.0', license_url: 'https://huggingface.co/HuggingFaceTB/SmolVLM2-2.2B-Instruct', ctx_max: 8192, kv_mb_per_1k: 192,
    blurb: { en: 'sees photos; the middle size, 6 gb phones', de: 'sieht fotos; die mittlere größe, 6-gb-telefone', tr: 'fotoğrafları görür; orta boy, 6 gb telefonlar' },
    good: { en: 'describing what is in a photo, reading signs and labels, comparing two pictures, answering a question about an image. short, plain english; weak at long writing.', de: 'beschreiben, was auf einem foto ist, schilder und etiketten lesen, zwei bilder vergleichen, eine frage zu einem bild beantworten. kurzes, schlichtes englisch; schwach bei langen texten.', tr: 'bir fotoğrafta ne olduğunu anlatmak, tabela ve etiket okumak, iki resmi karşılaştırmak, bir resim hakkındaki soruyu cevaplamak. kısa, sade ingilizce; uzun yazıda zayıf.' },
    use: { en: 'the vision model on a 6 gb phone: it reads photos for your chat model and your night projects, or answers about them itself. two files, the model and its image encoder.', de: 'das bildmodell auf einem 6-gb-telefon: es liest fotos für dein chatmodell und deine nachtprojekte oder antwortet selbst dazu. zwei dateien, das modell und sein bild-encoder.', tr: '6 gb telefonda görüntü modeli: fotoğrafları sohbet modelin ve gece projelerin için okur ya da kendisi cevaplar. iki dosya: model ve görüntü kodlayıcısı.' },
  },
  {
    // verified against the Hugging Face API on 10.11.2026; mmproj in f16, the only one ggml-org
    // ships. 34 layers, 4 kv heads of 256: 136 MB per 1k.
    id: 'gemma3-4b', name: 'Gemma 3 4B', family: 'gemma3', params_b: 4, quant: 'Q4_K_M',
    repo: 'ggml-org/gemma-3-4b-it-GGUF', file: 'gemma-3-4b-it-Q4_K_M.gguf', size: 2489757856,
    sha256: '882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863',
    mmproj: { file: 'mmproj-model-f16.gguf', size: 851251104, sha256: '8c0fb064b019a6972856aaae2c7e4792858af3ca4561be2dbf649123ba6c40cb' },
    license: 'gemma', license_url: 'https://ai.google.dev/gemma/terms', ctx_max: 131072, kv_mb_per_1k: 136,
    blurb: { en: 'sees photos and writes well; 8 gb phones', de: 'sieht fotos und schreibt gut; 8-gb-telefone', tr: 'fotoğrafları görür ve iyi yazar; 8 gb telefonlar' },
    good: { en: 'looks at a photo and talks about it properly: details, reading text, comparing, explaining; also a good chat model on its own, 140 languages.', de: 'sieht sich ein foto an und spricht ordentlich darüber: details, text lesen, vergleichen, erklären; allein auch ein gutes chatmodell, 140 sprachen.', tr: 'bir fotoğrafa bakıp düzgünce anlatır: ayrıntılar, yazı okuma, karşılaştırma, açıklama; tek başına da iyi bir sohbet modeli, 140 dil.' },
    use: { en: 'photos in chat and night projects on an 8 gb phone, answering itself without a second model. the largest download here.', de: 'fotos im chat und in nachtprojekten auf einem 8-gb-telefon, antwortet selbst ohne zweites modell. der größte download hier.', tr: '8 gb telefonda sohbet ve gece projelerinde fotoğraflar; ikinci bir model olmadan kendisi cevaplar. buradaki en büyük indirme.' },
  },
];

export const catalogById = (id: string) => CATALOG.find((m) => m.id === id) ?? null;
