// learn (8.11.2026): what to read and watch to grow in local, decentralized AI: running open
// models on your own devices, and one model across many small ones. Three levels; the first
// three tiles are the foundation (how a language model works), everything after is the local and
// decentralized part. A fourth, smaller group holds related things a step to the side. Each tile
// opens to why it matters for kula and its papers, videos, courses, posts and docs. Every link
// was checked to answer (arXiv titles against the export api, YouTube ids against oembed) on the
// day it was written. The page's csp allows nothing from elsewhere: plain links, a new tab each.
// kinds: paper · video · course · post · doc

export const LEVELS = [
  {
    id: 'beginner', name: 'beginner',
    hook: 'three tiles of foundation (how a language model works), then the local part: one on your own computer, why its speed is memory, and many devices running one model.',
    topics: [
      {
        id: 'llm', code: 'B1', base: true, c: '#4f7397', name: 'how LLMs work',
        hook: 'tokens in, one next token out, again and again.',
        why: 'everything kula moves between devices (layers, weights, the kv cache) is a piece of this loop. know the loop and the rest is plumbing.',
        items: [
          { k: 'video', t: 'Large Language Models explained briefly', by: '3Blue1Brown', y: 2024, len: '8 min', u: 'https://www.youtube.com/watch?v=LPZh9BOjkQs' },
          { k: 'video', t: '[1hr Talk] Intro to Large Language Models', by: 'Andrej Karpathy', y: 2023, len: '1 h', u: 'https://www.youtube.com/watch?v=zjkBMFhNj_g' },
          { k: 'video', t: 'Deep Dive into LLMs like ChatGPT', by: 'Andrej Karpathy', y: 2025, len: '3 h 31 min', u: 'https://www.youtube.com/watch?v=7xTGNNLPyMI' },
          { k: 'video', t: 'Let\'s build the GPT Tokenizer', by: 'Andrej Karpathy', y: 2024, len: '2 h 14 min', u: 'https://www.youtube.com/watch?v=zduSFxRajkE' },
          { k: 'post', t: 'LLM Visualization (a 3D walk through a GPT)', by: 'Brendan Bycroft', y: 2023, u: 'https://bbycroft.net/llm' },
          { k: 'post', t: 'Transformer Explainer (runs GPT-2 in the browser)', by: 'Georgia Tech Polo Club', y: 2024, u: 'https://poloclub.github.io/transformer-explainer/' },
          { k: 'post', t: 'How to generate text: using different decoding methods', by: 'Hugging Face', y: 2020, u: 'https://huggingface.co/blog/how-to-generate' },
          { k: 'paper', t: 'The Curious Case of Neural Text Degeneration (top-p)', by: 'Holtzman et al.', y: 2019, u: 'https://arxiv.org/abs/1904.09751' },
        ],
      },
      {
        id: 'nets', code: 'B2', base: true, c: '#5b7a55', name: 'neural nets from zero',
        hook: 'neurons, gradients, backprop; then build one yourself.',
        why: 'the brain\'s learning and forecast branches are small models too. knowing how a net learns lets you read every paper further down.',
        items: [
          { k: 'video', t: 'But what is a neural network?', by: '3Blue1Brown', y: 2017, len: '19 min', u: 'https://www.youtube.com/watch?v=aircAruvnKk' },
          { k: 'video', t: 'Gradient descent, how neural networks learn', by: '3Blue1Brown', y: 2017, len: '21 min', u: 'https://www.youtube.com/watch?v=IHZwWFHWa-w' },
          { k: 'video', t: 'Backpropagation, intuitively', by: '3Blue1Brown', y: 2017, len: '13 min', u: 'https://www.youtube.com/watch?v=Ilg3gGewQ5U' },
          { k: 'video', t: 'Neural networks (the whole series, eight chapters)', by: '3Blue1Brown', u: 'https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi' },
          { k: 'video', t: 'The spelled-out intro to neural networks and backpropagation: building micrograd', by: 'Andrej Karpathy', y: 2022, len: '2 h 26 min', u: 'https://www.youtube.com/watch?v=VMj-3S1tku0' },
          { k: 'course', t: 'Neural Networks: Zero to Hero', by: 'Andrej Karpathy', u: 'https://karpathy.ai/zero-to-hero.html' },
          { k: 'course', t: 'Practical Deep Learning for Coders', by: 'fast.ai', u: 'https://course.fast.ai/' },
        ],
      },
      {
        id: 'attn', code: 'B3', base: true, c: '#8a5a6e', name: 'transformers',
        hook: 'attention by picture first, then the paper, then in code.',
        why: 'a transformer is a stack of identical blocks. split mode cuts that stack between devices, so the block is the unit kula thinks in.',
        items: [
          { k: 'video', t: 'Transformers, the tech behind LLMs', by: '3Blue1Brown', y: 2024, len: '27 min', u: 'https://www.youtube.com/watch?v=wjZofJX0v4M' },
          { k: 'video', t: 'Attention in transformers, step-by-step', by: '3Blue1Brown', y: 2024, len: '26 min', u: 'https://www.youtube.com/watch?v=eMlx5fFNoYc' },
          { k: 'video', t: 'How might LLMs store facts', by: '3Blue1Brown', y: 2024, len: '23 min', u: 'https://www.youtube.com/watch?v=9-Jl0dxWQs8' },
          { k: 'post', t: 'The Illustrated Transformer', by: 'Jay Alammar', y: 2018, u: 'https://jalammar.github.io/illustrated-transformer/' },
          { k: 'post', t: 'The Illustrated GPT-2', by: 'Jay Alammar', y: 2019, u: 'https://jalammar.github.io/illustrated-gpt2/' },
          { k: 'paper', t: 'Attention Is All You Need', by: 'Vaswani et al.', y: 2017, u: 'https://arxiv.org/abs/1706.03762' },
          { k: 'video', t: 'Attention Is All You Need (the paper, read aloud and explained)', by: 'Yannic Kilcher', y: 2017, len: '27 min', u: 'https://www.youtube.com/watch?v=iDulhoQ2pro' },
          { k: 'post', t: 'The Annotated Transformer', by: 'Harvard NLP', y: 2022, u: 'https://nlp.seas.harvard.edu/annotated-transformer/' },
          { k: 'video', t: 'Let\'s build GPT: from scratch, in code, spelled out', by: 'Andrej Karpathy', y: 2023, len: '1 h 56 min', u: 'https://www.youtube.com/watch?v=kCc8FmEb1nY' },
          { k: 'video', t: 'Let\'s reproduce GPT-2 (124M)', by: 'Andrej Karpathy', y: 2024, len: '4 h 1 min', u: 'https://www.youtube.com/watch?v=l8pRSuU81PU' },
        ],
      },
      {
        id: 'local', code: 'B4', c: '#9b5b3a', name: 'running models at home',
        hook: 'llama.cpp, gguf files, and the open models you can download.',
        why: 'kula is llama.cpp (b11157) on every device. this is the engine you will read, patch and measure.',
        items: [
          { k: 'doc', t: 'llama.cpp (read the README first)', by: 'ggml-org', u: 'https://github.com/ggml-org/llama.cpp' },
          { k: 'doc', t: 'GGUF on the Hugging Face Hub', by: 'Hugging Face', u: 'https://huggingface.co/docs/hub/gguf' },
          { k: 'doc', t: 'llama.cpp build guide (Metal, CUDA, Vulkan, Android)', by: 'ggml-org', u: 'https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md' },
          { k: 'doc', t: 'Ollama: llama.cpp with a model library around it', by: 'Ollama', u: 'https://github.com/ollama/ollama' },
          { k: 'doc', t: 'MLX: Apple\'s array framework for Apple silicon', by: 'Apple', u: 'https://github.com/ml-explore/mlx' },
          { k: 'paper', t: 'LLaMA: Open and Efficient Foundation Language Models', by: 'Touvron et al.', y: 2023, u: 'https://arxiv.org/abs/2302.13971' },
          { k: 'post', t: 'Llama 3.2: Revolutionizing edge AI and vision with open, customizable models', by: 'Meta AI', y: 2024, u: 'https://ai.meta.com/blog/llama-3-2-connect-2024-vision-edge-mobile-devices/' },
        ],
      },
      {
        id: 'memory', code: 'B5', c: '#b07d3f', name: 'why speed is memory',
        hook: 'decoding reads every weight once per token: bandwidth, not flops, sets the pace.',
        why: 'this one idea explains why a phone gives 8 tok/s, why quantizing helps, and why split mode adds devices for memory, not speed.',
        items: [
          { k: 'post', t: 'Making Deep Learning Go Brrrr From First Principles', by: 'Horace He', y: 2022, u: 'https://horace.io/brrr_intro.html' },
          { k: 'post', t: 'Transformer Inference Arithmetic', by: 'kipply', y: 2022, u: 'https://kipp.ly/transformer-inference-arithmetic/' },
          { k: 'doc', t: 'Performance of llama.cpp on Apple Silicon M-series (tok/s against memory bandwidth)', by: 'ggml-org discussion', y: 2023, u: 'https://github.com/ggml-org/llama.cpp/discussions/4167' },
          { k: 'post', t: 'LLM Inference Performance Engineering: Best Practices', by: 'Databricks', y: 2023, u: 'https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices' },
          { k: 'post', t: 'Mastering LLM Techniques: Inference Optimization', by: 'NVIDIA', y: 2023, u: 'https://developer.nvidia.com/blog/mastering-llm-techniques-inference-optimization/' },
          { k: 'paper', t: 'Roofline: An Insightful Visual Performance Model for Floating-Point Programs and Multicore Architectures', by: 'Williams, Waterman, Patterson', y: 2008, u: 'https://www2.eecs.berkeley.edu/Pubs/TechRpts/2008/EECS-2008-134.html' },
        ],
      },
      {
        id: 'many', code: 'B6', c: '#4a7f7a', name: 'many devices, one model',
        hook: 'the idea kula is built on, shown by the projects that do it.',
        why: 'kula\'s split mode in other people\'s hands: what they joined, over which link, and how fast it went. watch these before the papers in advanced.',
        items: [
          { k: 'video', t: 'Exo - Run Your Own AI Cluster at Home with Any Device', by: 'Fahd Mirza', y: 2024, len: '8 min', u: 'https://www.youtube.com/watch?v=k25XkHpJfoI' },
          { k: 'video', t: 'Frontier LLMs Locally: EXO Labs CEO on Clustering Macs & DGX Sparks', by: 'ThursdAI', y: 2026, len: '17 min', u: 'https://www.youtube.com/watch?v=JNTsiyj9bj0' },
          { k: 'video', t: 'Run Frontier AI at Home', by: 'Alex Cheema, EXO Labs (AI Engineer)', y: 2026, len: '1 h 45 min', u: 'https://www.youtube.com/watch?v=ESbWpPT_9-o' },
          { k: 'doc', t: 'exo: run your own AI cluster at home with everyday devices', by: 'exo labs', u: 'https://github.com/exo-explore/exo' },
          { k: 'doc', t: 'llama.cpp rpc: run one model across machines (what kula splits over)', by: 'ggml-org', u: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md' },
          { k: 'doc', t: 'Distributed Llama: tensor parallel over ethernet, down to Raspberry Pis', by: 'Bartłomiej Tadych', u: 'https://github.com/b4rtaz/distributed-llama' },
          { k: 'doc', t: 'Petals: run large models BitTorrent-style', by: 'BigScience / Petals', u: 'https://petals.dev/' },
        ],
      },
    ],
  },
  {
    id: 'intermediate', name: 'intermediate',
    hook: 'a model on small devices, from the inside: quantization, the kv cache, llama.cpp, small models, experts, speculative decoding.',
    topics: [
      {
        id: 'quant', code: 'I1', c: '#b07d3f', name: 'quantization and gguf',
        hook: 'from 16 bits to 4 (or fewer) without losing the model.',
        why: 'a Q4_K_M file is a quarter of the size and runs about four times faster on a phone. kula\'s model list is mostly quantized files.',
        items: [
          { k: 'post', t: 'A Visual Guide to Quantization', by: 'Maarten Grootendorst', y: 2024, u: 'https://newsletter.maartengrootendorst.com/p/a-visual-guide-to-quantization' },
          { k: 'video', t: 'Quantization explained with PyTorch', by: 'Umar Jamil', y: 2023, len: '51 min', u: 'https://www.youtube.com/watch?v=0VdNflU08yA' },
          { k: 'doc', t: 'k-quants: the pull request that made Q4_K and friends', by: 'ggml-org', y: 2023, u: 'https://github.com/ggml-org/llama.cpp/pull/1684' },
          { k: 'doc', t: 'GGUF file format spec', by: 'ggml-org', u: 'https://github.com/ggml-org/ggml/blob/master/docs/gguf.md' },
          { k: 'paper', t: 'LLM.int8(): 8-bit Matrix Multiplication for Transformers at Scale', by: 'Dettmers et al.', y: 2022, u: 'https://arxiv.org/abs/2208.07339' },
          { k: 'paper', t: 'GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers', by: 'Frantar et al.', y: 2022, u: 'https://arxiv.org/abs/2210.17323' },
          { k: 'paper', t: 'AWQ: Activation-aware Weight Quantization', by: 'Lin et al.', y: 2023, u: 'https://arxiv.org/abs/2306.00978' },
          { k: 'paper', t: 'SmoothQuant: Accurate and Efficient Post-Training Quantization', by: 'Xiao et al.', y: 2022, u: 'https://arxiv.org/abs/2211.10438' },
          { k: 'paper', t: 'QLoRA: Efficient Finetuning of Quantized LLMs', by: 'Dettmers et al.', y: 2023, u: 'https://arxiv.org/abs/2305.14314' },
        ],
      },
      {
        id: 'kv', code: 'I2', c: '#8a5a6e', name: 'kv cache and attention memory',
        hook: 'the memory that grows with every token of the chat.',
        why: 'in split mode each device holds the kv cache of its own layers; long chats run out of it before they run out of weights.',
        items: [
          { k: 'video', t: 'LLaMA explained: KV-Cache, Rotary Positional Embedding, RMS Norm, Grouped Query Attention, SwiGLU', by: 'Umar Jamil', y: 2023, len: '1 h 11 min', u: 'https://www.youtube.com/watch?v=Mn_9W1nCFLo' },
          { k: 'paper', t: 'Fast Transformer Decoding: One Write-Head is All You Need (MQA)', by: 'Shazeer', y: 2019, u: 'https://arxiv.org/abs/1911.02150' },
          { k: 'paper', t: 'GQA: Training Generalized Multi-Query Transformer Models', by: 'Ainslie et al.', y: 2023, u: 'https://arxiv.org/abs/2305.13245' },
          { k: 'paper', t: 'RoFormer: Enhanced Transformer with Rotary Position Embedding', by: 'Su et al.', y: 2021, u: 'https://arxiv.org/abs/2104.09864' },
          { k: 'paper', t: 'Efficient Memory Management for LLM Serving with PagedAttention (vLLM)', by: 'Kwon et al.', y: 2023, u: 'https://arxiv.org/abs/2309.06180' },
          { k: 'video', t: 'vLLM: Easy, Fast, and Cheap LLM Serving', by: 'Woosuk Kwon, UC Berkeley', y: 2024, len: '23 min', u: 'https://www.youtube.com/watch?v=8BaEwoTk8XI' },
          { k: 'paper', t: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness', by: 'Dao et al.', y: 2022, u: 'https://arxiv.org/abs/2205.14135' },
          { k: 'paper', t: 'FlashAttention-2: Faster Attention with Better Parallelism', by: 'Dao', y: 2023, u: 'https://arxiv.org/abs/2307.08691' },
          { k: 'video', t: 'Flash Attention derived and coded from first principles with Triton (Python)', by: 'Umar Jamil', y: 2024, len: '7 h 38 min', u: 'https://www.youtube.com/watch?v=zy8ChVd_oTM' },
          { k: 'paper', t: 'Efficient Streaming Language Models with Attention Sinks', by: 'Xiao et al.', y: 2023, u: 'https://arxiv.org/abs/2309.17453' },
          { k: 'paper', t: 'H2O: Heavy-Hitter Oracle for Efficient Generative Inference', by: 'Zhang et al.', y: 2023, u: 'https://arxiv.org/abs/2306.14048' },
        ],
      },
      {
        id: 'ggml', code: 'I3', c: '#9b5b3a', name: 'llama.cpp and ggml inside',
        hook: 'tensors, graphs, backends, and how a phone runs them.',
        why: 'split mode is ggml\'s rpc backend behind kula\'s gate. read how a graph is built and sent, and you can read kula-llama.',
        items: [
          { k: 'post', t: 'Introduction to ggml', by: 'Hugging Face (Xuan Son Nguyen)', y: 2024, u: 'https://huggingface.co/blog/introduction-to-ggml' },
          { k: 'doc', t: 'ggml: the tensor library under llama.cpp', by: 'ggml-org', u: 'https://github.com/ggml-org/ggml' },
          { k: 'post', t: 'Understanding how LLM inference works with llama.cpp', by: 'Omri Mallis', y: 2023, u: 'https://www.omrimallis.com/posts/understanding-how-llm-inference-works-with-llama-cpp/' },
          { k: 'doc', t: 'llama.cpp on Android', by: 'ggml-org', u: 'https://github.com/ggml-org/llama.cpp/blob/master/docs/android.md' },
        ],
      },
      {
        id: 'small', code: 'I4', c: '#5b7a55', name: 'small models that fit',
        hook: 'models made to live on a phone, and why training them longer pays.',
        why: 'apart mode puts a whole copy on each device; a good 1–4 B model is often the best a phone alone can do.',
        items: [
          { k: 'paper', t: 'Phi-3 Technical Report: A Highly Capable Language Model Locally on Your Phone', by: 'Abdin et al. (Microsoft)', y: 2024, u: 'https://arxiv.org/abs/2404.14219' },
          { k: 'paper', t: 'MobileLLM: Optimizing Sub-billion Parameter Language Models for On-Device Use', by: 'Liu et al. (Meta)', y: 2024, u: 'https://arxiv.org/abs/2402.14905' },
          { k: 'paper', t: 'SmolLM2: When Smol Goes Big', by: 'Ben Allal et al. (Hugging Face)', y: 2025, u: 'https://arxiv.org/abs/2502.02737' },
          { k: 'post', t: 'SmolLM: blazingly fast and remarkably powerful', by: 'Hugging Face', y: 2024, u: 'https://huggingface.co/blog/smollm' },
          { k: 'paper', t: 'Gemma 3 Technical Report', by: 'Gemma Team (Google)', y: 2025, u: 'https://arxiv.org/abs/2503.19786' },
          { k: 'paper', t: 'OpenELM: An Efficient Language Model Family with Open Training and Inference Framework', by: 'Mehta et al. (Apple)', y: 2024, u: 'https://arxiv.org/abs/2404.14619' },
          { k: 'paper', t: 'The Era of 1-bit LLMs: All Large Language Models are in 1.58 Bits', by: 'Ma et al.', y: 2024, u: 'https://arxiv.org/abs/2402.17764' },
          { k: 'paper', t: 'Training Compute-Optimal Large Language Models (Chinchilla)', by: 'Hoffmann et al.', y: 2022, u: 'https://arxiv.org/abs/2203.15556' },
          { k: 'paper', t: 'Beyond Chinchilla-Optimal: Accounting for Inference in Language Model Scaling Laws', by: 'Sardana et al.', y: 2023, u: 'https://arxiv.org/abs/2401.00448' },
        ],
      },
      {
        id: 'moe', code: 'I5', c: '#6b7a3c', name: 'experts on small devices',
        hook: 'a huge mixture-of-experts model where each token wakes only a few.',
        why: 'frontier open models are moe now. only a few experts run per token, so the rest can wait in slower memory or on another device.',
        items: [
          { k: 'post', t: 'Mixture of Experts Explained', by: 'Hugging Face', y: 2023, u: 'https://huggingface.co/blog/moe' },
          { k: 'post', t: 'A Visual Guide to Mixture of Experts', by: 'Maarten Grootendorst', y: 2024, u: 'https://newsletter.maartengrootendorst.com/p/a-visual-guide-to-mixture-of-experts' },
          { k: 'video', t: 'Mistral / Mixtral Explained: Sliding Window Attention, Sparse Mixture of Experts, Rolling Buffer', by: 'Umar Jamil', y: 2023, len: '1 h 26 min', u: 'https://www.youtube.com/watch?v=UiX8K-xBUpE' },
          { k: 'paper', t: 'Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer', by: 'Shazeer et al.', y: 2017, u: 'https://arxiv.org/abs/1701.06538' },
          { k: 'paper', t: 'Mixtral of Experts', by: 'Jiang et al.', y: 2024, u: 'https://arxiv.org/abs/2401.04088' },
          { k: 'paper', t: 'DeepSeekMoE: Towards Ultimate Expert Specialization', by: 'Dai et al.', y: 2024, u: 'https://arxiv.org/abs/2401.06066' },
          { k: 'paper', t: 'Fast Inference of Mixture-of-Experts Language Models with Offloading', by: 'Eliseev, Mazur', y: 2023, u: 'https://arxiv.org/abs/2312.17238' },
          { k: 'paper', t: 'Fiddler: CPU-GPU Orchestration for Fast Inference of Mixture-of-Experts Models', by: 'Kamahori et al.', y: 2024, u: 'https://arxiv.org/abs/2402.07033' },
        ],
      },
      {
        id: 'spec', code: 'I6', c: '#4a7f7a', name: 'speculative decoding',
        hook: 'a small model guesses, the big one checks many tokens at once.',
        why: 'a phone can run the small drafter while the split model checks: more tokens per pass over the slow link between devices.',
        items: [
          { k: 'paper', t: 'Fast Inference from Transformers via Speculative Decoding', by: 'Leviathan, Kalman, Matias', y: 2022, u: 'https://arxiv.org/abs/2211.17192' },
          { k: 'paper', t: 'Accelerating Large Language Model Decoding with Speculative Sampling', by: 'Chen et al.', y: 2023, u: 'https://arxiv.org/abs/2302.01318' },
          { k: 'paper', t: 'Medusa: Simple LLM Inference Acceleration Framework with Multiple Decoding Heads', by: 'Cai et al.', y: 2024, u: 'https://arxiv.org/abs/2401.10774' },
          { k: 'paper', t: 'EAGLE: Speculative Sampling Requires Rethinking Feature Uncertainty', by: 'Li et al.', y: 2024, u: 'https://arxiv.org/abs/2401.15077' },
          { k: 'post', t: 'Looking back at speculative decoding', by: 'Google Research', y: 2024, u: 'https://research.google/blog/looking-back-at-speculative-decoding/' },
          { k: 'video', t: 'Lecture 22: Hacker\'s Guide to Speculative Decoding in vLLM', by: 'GPU MODE', y: 2024, len: '1 h 9 min', u: 'https://www.youtube.com/watch?v=9wNAgpX6z_4' },
        ],
      },
    ],
  },
  {
    id: 'advanced', name: 'advanced',
    hook: 'one model across many devices you own: parallelism over a network, the research systems, phones and npus, scheduling, trust and privacy, energy.',
    topics: [
      {
        id: 'par', code: 'A1', c: '#c86a51', name: 'pipeline and tensor parallel',
        hook: 'cut a model by layers, or cut each layer across devices.',
        why: 'split mode is pipeline parallel over wi-fi. these are the papers that named the ideas and measured the bubbles.',
        items: [
          { k: 'paper', t: 'GPipe: Efficient Training of Giant Neural Networks using Pipeline Parallelism', by: 'Huang et al.', y: 2018, u: 'https://arxiv.org/abs/1811.06965' },
          { k: 'paper', t: 'PipeDream: Fast and Efficient Pipeline Parallel DNN Training', by: 'Harlap et al.', y: 2018, u: 'https://arxiv.org/abs/1806.03377' },
          { k: 'paper', t: 'Megatron-LM: Training Multi-Billion Parameter Language Models Using Model Parallelism', by: 'Shoeybi et al.', y: 2019, u: 'https://arxiv.org/abs/1909.08053' },
          { k: 'paper', t: 'Efficient Large-Scale Language Model Training on GPU Clusters Using Megatron-LM', by: 'Narayanan et al.', y: 2021, u: 'https://arxiv.org/abs/2104.04473' },
          { k: 'paper', t: 'Efficiently Scaling Transformer Inference', by: 'Pope et al.', y: 2022, u: 'https://arxiv.org/abs/2211.05102' },
          { k: 'course', t: 'The Ultra-Scale Playbook: Training LLMs on GPU Clusters', by: 'Hugging Face', y: 2025, u: 'https://huggingface.co/spaces/nanotron/ultrascale-playbook' },
          { k: 'course', t: 'How to Scale Your Model', by: 'Google DeepMind', y: 2025, u: 'https://jax-ml.github.io/scaling-book/' },
          { k: 'post', t: 'How to Train Really Large Models on Many GPUs?', by: 'Lilian Weng', y: 2021, u: 'https://lilianweng.github.io/posts/2021-09-25-train-large/' },
          { k: 'video', t: 'CS336 Language Modeling from Scratch, 2025 (all lectures, two on parallelism)', by: 'Stanford Online', y: 2025, u: 'https://www.youtube.com/playlist?list=PLoROMvodv4rOY23Y0BoGoBGgQ1zmU_MT_' },
          { k: 'course', t: 'CS336: Language Modeling from Scratch', by: 'Stanford', y: 2025, u: 'https://stanford-cs336.github.io/spring2025/' },
        ],
      },
      {
        id: 'swarm', code: 'A2', c: '#4f7397', name: 'decentralised inference',
        hook: 'big models on phones, home clusters and the internet.',
        why: 'this is kula\'s own field. read what worked, what broke, and where kula differs: no relay, devices on one network.',
        items: [
          { k: 'paper', t: 'Petals: Collaborative Inference and Fine-tuning of Large Models', by: 'Borzunov et al.', y: 2022, u: 'https://arxiv.org/abs/2209.01188' },
          { k: 'paper', t: 'Distributed Inference and Fine-tuning of Large Language Models Over The Internet', by: 'Borzunov et al.', y: 2023, u: 'https://arxiv.org/abs/2312.08361' },
          { k: 'paper', t: 'LinguaLinked: A Distributed Large Language Model Inference System for Mobile Devices', by: 'Zhao et al.', y: 2023, u: 'https://arxiv.org/abs/2312.00388' },
          { k: 'paper', t: 'TPI-LLM: Serving 70B-scale LLMs Efficiently on Low-resource Edge Devices', by: 'Li et al.', y: 2024, u: 'https://arxiv.org/abs/2410.00531' },
          { k: 'paper', t: 'Prima.cpp: Fast 30-70B LLM Inference on Heterogeneous and Low-Resource Home Clusters', by: 'Li et al.', y: 2025, u: 'https://arxiv.org/abs/2504.08791' },
          { k: 'paper', t: 'EdgeShard: Efficient LLM Inference via Collaborative Edge Computing', by: 'Zhang et al.', y: 2024, u: 'https://arxiv.org/abs/2405.14371' },
          { k: 'paper', t: 'Galaxy: A Resource-Efficient Collaborative Edge AI System for In-situ Transformer Inference', by: 'Ye et al.', y: 2024, u: 'https://arxiv.org/abs/2405.17245' },
          { k: 'paper', t: 'HexGen: Generative Inference of Large Language Model over Heterogeneous Environment', by: 'Jiang et al.', y: 2023, u: 'https://arxiv.org/abs/2311.11514' },
        ],
      },
      {
        id: 'edge', code: 'A3', c: '#5b7a55', name: 'phones, edge and npus',
        hook: 'models bigger than the phone\'s memory, and the chips beside the cpu.',
        why: 'every kula device is an edge device. flash offloading, sparsity and the npu are how a phone holds and runs more of the model than its ram suggests.',
        items: [
          { k: 'paper', t: 'LLM in a flash: Efficient LLM Inference with Limited Memory', by: 'Alizadeh et al. (Apple)', y: 2023, u: 'https://arxiv.org/abs/2312.11514' },
          { k: 'paper', t: 'PowerInfer: Fast LLM Serving with a Consumer-grade GPU', by: 'Song et al.', y: 2023, u: 'https://arxiv.org/abs/2312.12456' },
          { k: 'paper', t: 'PowerInfer-2: Fast LLM Inference on a Smartphone', by: 'Xue et al.', y: 2024, u: 'https://arxiv.org/abs/2406.06282' },
          { k: 'doc', t: 'PowerInfer (the code, on llama.cpp)', by: 'SJTU IPADS', u: 'https://github.com/SJTU-IPADS/PowerInfer' },
          { k: 'paper', t: 'Deja Vu: Contextual Sparsity for Efficient LLMs at Inference Time', by: 'Liu et al.', y: 2023, u: 'https://arxiv.org/abs/2310.17157' },
          { k: 'paper', t: 'Fast On-device LLM Inference with NPUs', by: 'Xu et al.', y: 2024, u: 'https://arxiv.org/abs/2407.05858' },
          { k: 'post', t: 'Introducing Apple\'s On-Device and Server Foundation Models', by: 'Apple ML Research', y: 2024, u: 'https://machinelearning.apple.com/research/introducing-apple-foundation-models' },
          { k: 'doc', t: 'MLC LLM: compile models for phones and browsers', by: 'MLC', u: 'https://llm.mlc.ai/' },
          { k: 'doc', t: 'ExecuTorch: PyTorch on phones and edge devices', by: 'PyTorch', u: 'https://pytorch.org/executorch/' },
          { k: 'doc', t: 'LiteRT (TensorFlow Lite): Google\'s on-device runtime', by: 'Google AI Edge', u: 'https://ai.google.dev/edge/litert' },
          { k: 'course', t: 'MIT 6.5940 TinyML and Efficient Deep Learning Computing', by: 'Song Han', u: 'https://efficientml.ai/' },
          { k: 'video', t: 'EfficientML.ai Lecture 12: Transformer and LLM', by: 'MIT HAN Lab (Song Han)', y: 2024, len: '1 h 17 min', u: 'https://www.youtube.com/watch?v=EV6xb4xY708' },
          { k: 'video', t: 'EfficientML.ai Lecture 14: LLM Post-Training', by: 'MIT HAN Lab (Song Han)', y: 2024, len: '1 h 19 min', u: 'https://www.youtube.com/watch?v=udw5TxtbmLI' },
          { k: 'video', t: 'EfficientML.ai Lecture 15: Long-Context LLM', by: 'MIT HAN Lab (Song Han)', y: 2024, len: '1 h 14 min', u: 'https://www.youtube.com/watch?v=kgTWKjbnrBA' },
        ],
      },
      {
        id: 'sched', code: 'A4', c: '#b07d3f', name: 'scheduling and forecasting',
        hook: 'who runs what, when, and how long it will take.',
        why: 'the planner and forecast branches: placing layers on uneven devices and guessing how long a night project needs.',
        items: [
          { k: 'paper', t: 'Helix: Serving Large Language Models over Heterogeneous GPUs and Network via Max-Flow', by: 'Mei et al.', y: 2024, u: 'https://arxiv.org/abs/2406.01566' },
          { k: 'paper', t: 'Orca: A Distributed Serving System for Transformer-Based Generative Models', by: 'Yu et al., OSDI', y: 2022, u: 'https://www.usenix.org/conference/osdi22/presentation/yu' },
          { k: 'post', t: 'How continuous batching enables 23x throughput in LLM inference', by: 'Anyscale', y: 2023, u: 'https://www.anyscale.com/blog/continuous-batching-llm-inference' },
          { k: 'paper', t: 'Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve', by: 'Agrawal et al.', y: 2024, u: 'https://arxiv.org/abs/2403.02310' },
          { k: 'paper', t: 'DistServe: Disaggregating Prefill and Decoding', by: 'Zhong et al.', y: 2024, u: 'https://arxiv.org/abs/2401.09670' },
          { k: 'paper', t: 'Splitwise: Efficient Generative LLM Inference Using Phase Splitting', by: 'Patel et al.', y: 2023, u: 'https://arxiv.org/abs/2311.18677' },
          { k: 'paper', t: 'Efficient LLM Scheduling by Learning to Rank', by: 'Fu et al.', y: 2024, u: 'https://arxiv.org/abs/2408.15792' },
        ],
      },
      {
        id: 'trust', code: 'A5', c: '#6b7a3c', name: 'trust, privacy, verification',
        hook: 'when a device you do not control computes part of your answer.',
        why: 'the trust branch and the passport: how to know a device ran the layers it says it ran, what it can see of your chat, and what to do when one lies.',
        items: [
          { k: 'paper', t: 'The Byzantine Generals Problem', by: 'Lamport, Shostak, Pease', y: 1982, u: 'https://lamport.azurewebsites.net/pubs/byz.pdf' },
          { k: 'paper', t: 'Practical Byzantine Fault Tolerance', by: 'Castro, Liskov, OSDI', y: 1999, u: 'https://www.usenix.org/conference/osdi-99/practical-byzantine-fault-tolerance' },
          { k: 'paper', t: 'SafetyNets: Verifiable Execution of Deep Neural Networks on an Untrusted Cloud', by: 'Ghodsi et al.', y: 2017, u: 'https://arxiv.org/abs/1706.10268' },
          { k: 'paper', t: 'zkLLM: Zero Knowledge Proofs for Large Language Models', by: 'Sun et al.', y: 2024, u: 'https://arxiv.org/abs/2404.16109' },
          { k: 'paper', t: 'TOPLOC: A Locality Sensitive Hashing Scheme for Trustless Verifiable Inference', by: 'Ong et al.', y: 2025, u: 'https://arxiv.org/abs/2501.16007' },
          { k: 'paper', t: 'Privacy-Aware Split Inference with Speculative Decoding for LLMs over Wide-Area Networks', by: 'Cunningham et al.', y: 2026, u: 'https://arxiv.org/abs/2602.16760' },
        ],
      },
      {
        id: 'energy', code: 'A6', c: '#b4513a', name: 'energy and heat',
        hook: 'joules per token, and what a hot phone does to speed.',
        why: 'the limits branch: a phone on battery in a warm room slows down; a night project should know what it costs.',
        items: [
          { k: 'paper', t: 'From Words to Watts: Benchmarking the Energy Costs of LLM Inference', by: 'Samsi et al.', y: 2023, u: 'https://arxiv.org/abs/2310.03003' },
          { k: 'paper', t: 'Power Hungry Processing: Watts Driving the Cost of AI Deployment?', by: 'Luccioni et al.', y: 2023, u: 'https://arxiv.org/abs/2311.16863' },
          { k: 'paper', t: 'Energy and Policy Considerations for Deep Learning in NLP', by: 'Strubell et al.', y: 2019, u: 'https://arxiv.org/abs/1906.02243' },
          { k: 'paper', t: 'Zeus: Understanding and Optimizing GPU Energy Consumption of DNN Training', by: 'You et al.', y: 2022, u: 'https://arxiv.org/abs/2208.06102' },
          { k: 'doc', t: 'ML.ENERGY Leaderboard', by: 'ML.ENERGY', u: 'https://ml.energy/leaderboard' },
        ],
      },
    ],
  },
  {
    id: 'also', name: 'also interesting', side: true,
    hook: 'related, a step to the side: computing and learning together without one owner, and the open models kula runs.',
    topics: [
      {
        id: 'fed', code: 'X1', c: '#5f6b7a', name: 'federated learning',
        hook: 'learning from many devices without collecting their data.',
        why: 'the learning branch: how the brain could get better from every kula without any chat leaving its device.',
        items: [
          { k: 'paper', t: 'Communication-Efficient Learning of Deep Networks from Decentralized Data', by: 'McMahan et al.', y: 2016, u: 'https://arxiv.org/abs/1602.05629' },
          { k: 'paper', t: 'Advances and Open Problems in Federated Learning', by: 'Kairouz et al.', y: 2019, u: 'https://arxiv.org/abs/1912.04977' },
          { k: 'post', t: 'Federated Learning: Collaborative Machine Learning without Centralized Training Data', by: 'Google Research', y: 2017, u: 'https://research.google/blog/federated-learning-collaborative-machine-learning-without-centralized-training-data/' },
          { k: 'post', t: 'Federated Learning, an online comic', by: 'Google', y: 2019, u: 'https://federated.withgoogle.com/' },
          { k: 'video', t: 'CS-E4740 Federated Learning: horizontal FL', by: 'Alexander Jung, Aalto University', y: 2025, len: '9 min', u: 'https://www.youtube.com/watch?v=dOe4jf0bCCg' },
          { k: 'doc', t: 'Flower: a friendly federated learning framework', by: 'Flower Labs', u: 'https://flower.ai/docs/framework/' },
        ],
      },
      {
        id: 'volunteer', code: 'X2', c: '#8b6a4a', name: 'volunteer computing',
        hook: 'millions of home computers on one problem, since 1999.',
        why: 'SETI@home and Folding@home did with idle pcs what kula does with idle phones. they solved trust, churn and credit long before ai.',
        items: [
          { k: 'paper', t: 'BOINC: A Platform for Volunteer Computing', by: 'David P. Anderson', y: 2019, u: 'https://arxiv.org/abs/1903.01699' },
          { k: 'paper', t: 'Folding@home: achievements from over twenty years of citizen science herald the exascale era', by: 'Voelz et al.', y: 2023, u: 'https://arxiv.org/abs/2303.08993' },
          { k: 'doc', t: 'BOINC', by: 'UC Berkeley', u: 'https://boinc.berkeley.edu/' },
          { k: 'doc', t: 'Folding@home', by: 'Folding@home consortium', u: 'https://foldingathome.org/' },
          { k: 'doc', t: 'SETI@home (in hibernation since 2020)', by: 'UC Berkeley', u: 'https://setiathome.berkeley.edu/' },
        ],
      },
      {
        id: 'dtrain', code: 'X3', c: '#4a7f7a', name: 'decentralized training',
        hook: 'training a model across continents and strangers\' machines.',
        why: 'the same problem as kula one step harder: slow links and devices that come and go, but gradients instead of tokens.',
        items: [
          { k: 'paper', t: 'DiLoCo: Distributed Low-Communication Training of Language Models', by: 'Douillard et al.', y: 2023, u: 'https://arxiv.org/abs/2311.08105' },
          { k: 'paper', t: 'OpenDiLoCo: An Open-Source Framework for Globally Distributed Low-Communication Training', by: 'Jaghouar et al.', y: 2024, u: 'https://arxiv.org/abs/2407.07852' },
          { k: 'post', t: 'INTELLECT-1: Launching the First Globally-Distributed Training of a 10B Parameter Model', by: 'Prime Intellect', y: 2024, u: 'https://www.primeintellect.ai/blog/intellect-1' },
          { k: 'paper', t: 'INTELLECT-1 Technical Report', by: 'Prime Intellect', y: 2024, u: 'https://arxiv.org/abs/2412.01152' },
          { k: 'paper', t: 'DeMo: Decoupled Momentum Optimization', by: 'Peng et al. (Nous Research)', y: 2024, u: 'https://arxiv.org/abs/2411.19870' },
          { k: 'paper', t: 'SWARM Parallelism: Training Large Models Can Be Surprisingly Communication-Efficient', by: 'Ryabinin et al.', y: 2023, u: 'https://arxiv.org/abs/2301.11913' },
          { k: 'paper', t: 'Towards Crowdsourced Training of Large Neural Networks using Decentralized Mixture-of-Experts', by: 'Ryabinin, Gusev', y: 2020, u: 'https://arxiv.org/abs/2002.04013' },
          { k: 'paper', t: 'Decentralized Training of Foundation Models in Heterogeneous Environments', by: 'Yuan et al.', y: 2022, u: 'https://arxiv.org/abs/2206.01288' },
          { k: 'doc', t: 'hivemind: decentralized deep learning in PyTorch', by: 'learning@home', u: 'https://github.com/learning-at-home/hivemind' },
        ],
      },
      {
        id: 'p2p', code: 'X4', c: '#4f7397', name: 'peer-to-peer and gossip',
        hook: 'finding each other, staying in touch, and noticing who left.',
        why: 'kula finds phones with mdns and keeps a list of who is alive; these are the classic answers to the same questions.',
        items: [
          { k: 'doc', t: 'Multicast DNS (RFC 6762)', by: 'Cheshire, Krochmal', y: 2013, u: 'https://www.rfc-editor.org/rfc/rfc6762' },
          { k: 'doc', t: 'DNS-Based Service Discovery (RFC 6763)', by: 'Cheshire, Krochmal', y: 2013, u: 'https://www.rfc-editor.org/rfc/rfc6763' },
          { k: 'paper', t: 'Kademlia: A Peer-to-peer Information System Based on the XOR Metric', by: 'Maymounkov, Mazières', y: 2002, u: 'https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf' },
          { k: 'paper', t: 'Incentives Build Robustness in BitTorrent', by: 'Bram Cohen', y: 2003, u: 'https://www.bittorrent.org/bittorrentecon.pdf' },
          { k: 'paper', t: 'SWIM: Scalable Weakly-consistent Infection-style Process Group Membership Protocol', by: 'Das, Gupta, Motivala', y: 2002, u: 'https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf' },
          { k: 'paper', t: 'Dynamo: Amazon\'s Highly Available Key-value Store', by: 'DeCandia et al., SOSP', y: 2007, u: 'https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf' },
        ],
      },
      {
        id: 'open', code: 'X5', c: '#c86a51', name: 'open-weight models',
        hook: 'how the models kula runs are made and released.',
        why: 'every model in kula\'s list comes from a report like these: its size, its experts, its context and its licence decide where it can run.',
        items: [
          { k: 'paper', t: 'Llama 2: Open Foundation and Fine-Tuned Chat Models', by: 'Touvron et al.', y: 2023, u: 'https://arxiv.org/abs/2307.09288' },
          { k: 'paper', t: 'The Llama 3 Herd of Models', by: 'Grattafiori et al. (Meta)', y: 2024, u: 'https://arxiv.org/abs/2407.21783' },
          { k: 'paper', t: 'DeepSeek-V3 Technical Report', by: 'DeepSeek-AI', y: 2024, u: 'https://arxiv.org/abs/2412.19437' },
          { k: 'paper', t: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning', by: 'DeepSeek-AI', y: 2025, u: 'https://arxiv.org/abs/2501.12948' },
          { k: 'paper', t: 'Qwen3 Technical Report', by: 'Yang et al. (Qwen)', y: 2025, u: 'https://arxiv.org/abs/2505.09388' },
          { k: 'paper', t: 'gpt-oss-120b & gpt-oss-20b Model Card', by: 'OpenAI', y: 2025, u: 'https://arxiv.org/abs/2508.10925' },
          { k: 'paper', t: '2 OLMo 2 Furious (fully open: data, code, weights)', by: 'Team OLMo (Ai2)', y: 2024, u: 'https://arxiv.org/abs/2501.00656' },
        ],
      },
      {
        id: 'lofi', code: 'X6', c: '#8a5a6e', name: 'local-first software',
        hook: 'apps where your data lives on your devices first.',
        why: 'kula keeps chats on the computer and talks device to device; local-first is the same stance for all software, with the tools to sync without a server.',
        items: [
          { k: 'post', t: 'Local-first software: You own your data, in spite of the cloud', by: 'Ink & Switch (Kleppmann et al.)', y: 2019, u: 'https://www.inkandswitch.com/essay/local-first/' },
          { k: 'video', t: 'The past, present, and future of local-first', by: 'Martin Kleppmann (Local-First Conf)', y: 2024, len: '30 min', u: 'https://www.youtube.com/watch?v=NMq0vncHJvU' },
          { k: 'video', t: 'Creating Local-First Collaboration Software with Automerge', by: 'Martin Kleppmann (GOTO 2023)', y: 2023, len: '41 min', u: 'https://www.youtube.com/watch?v=esMjP-7jlRE' },
          { k: 'doc', t: 'CRDTs: the data types that merge without a server', by: 'crdt.tech', u: 'https://crdt.tech/' },
          { k: 'doc', t: 'Automerge', by: 'Automerge', u: 'https://automerge.org/' },
        ],
      },
    ],
  },
];

// ---------- the learn tab of the brain panel: a tab row under the head, the levels as tiles
// (the WS 26/27 tiles of hayat paneli in kula's palette: a colour bar on the left, a faint circle
// in the corner, the name large), and a drawer over the panel when a tile opens. What you ticked
// stays in this browser only.

const KINDS = [['video', 'watch'], ['paper', 'papers'], ['course', 'courses'], ['post', 'posts'], ['doc', 'docs']];
const WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const DONE_KEY = 'kula.chat.learn.done';
const TAB_KEY = 'kula.chat.brain.tab';

const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const readDone = () => { try { const v = JSON.parse(localStorage.getItem(DONE_KEY) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); } };
const saveDone = (s) => { try { localStorage.setItem(DONE_KEY, JSON.stringify([...s])); } catch {} };

export const LEARN_COUNT = LEVELS.reduce((n, l) => n + l.topics.reduce((m, t) => m + t.items.length, 0), 0);

// brain: the aside; tabs: the tab row (buttons with data-btab); view: the learn view's box
export function mountLearn({ brain, tabs, view }) {
  const done = readDone();
  let drawer = null;
  let opener = null;
  const tiles = new Map(); // topic id -> its tile, to refresh its tick count

  function setTab(name, focus = false) {
    const learn = name === 'learn';
    brain.classList.toggle('learning', learn);
    view.hidden = !learn;
    for (const b of tabs.querySelectorAll('[data-btab]')) {
      const on = b.dataset.btab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    if (learn && !view.firstChild) render();
    if (!learn) closeTopic(false);
    try { localStorage.setItem(TAB_KEY, name); } catch {}
  }
  tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-btab]'); if (b) setTab(b.dataset.btab); });
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setTab(brain.classList.contains('learning') ? 'brain' : 'learn', true);
  });

  const countOf = (t) => t.items.filter((i) => done.has(i.u)).length;

  function tileOf(level, t) {
    const b = mk('button', 'ltile');
    b.type = 'button';
    b.style.setProperty('--c', t.c);
    b.setAttribute('aria-haspopup', 'dialog');
    const top = mk('span', 'lt-top');
    top.append(mk('span', 'lt-code', `${t.code} · ${t.base ? 'foundation' : level.side ? 'aside' : level.name}`), mk('span', 'lt-name', t.name), mk('span', 'lt-hook', t.hook));
    const n = (k) => t.items.filter((i) => i.k === k).length;
    const read = t.items.length - n('video');
    const badge = mk('span', 'lt-badge');
    if (n('video')) badge.append(mk('span', '', String(n('video'))), ` watch${read ? ' · ' : ''}`);
    if (read) badge.append(mk('span', '', String(read)), ' read');
    const go = mk('span', 'lt-go');
    const bar = mk('span', 'lt-bar'); bar.appendChild(mk('i'));
    go.append(mk('span', 'lt-n'), bar, mk('span', 'lt-arr', '→'));
    b.append(top, badge, go);
    b.addEventListener('click', () => openTopic(level, t, b));
    tiles.set(t.id, { b, t });
    paintTile(t.id);
    return b;
  }
  function paintTile(id) {
    const x = tiles.get(id);
    if (!x) return;
    const d = countOf(x.t);
    x.b.querySelector('.lt-n').textContent = d ? `${d}/${x.t.items.length} done` : plural(x.t.items.length, 'link', 'links');
    x.b.querySelector('.lt-bar i').style.width = `${Math.round((d / x.t.items.length) * 100)}%`;
    x.b.title = `${x.t.name}: ${x.t.hook}`;
  }

  function render() {
    const core = LEVELS.filter((l) => !l.side);
    const topics = core.reduce((n, l) => n + l.topics.length, 0);
    const side = LEVELS.filter((l) => l.side).reduce((n, l) => n + l.topics.length, 0);
    const intro = mk('p', 'ln-intro', `what to read and watch to grow in local, decentralized ai: open models on your own devices, and one model across many small ones. three levels, ${topics} topics, then ${side} related ones a step to the side; ${LEARN_COUNT} links, each opens in a new tab. tick what you have done.`);
    const jump = mk('nav', 'ln-jump');
    jump.setAttribute('aria-label', 'levels');
    const sections = LEVELS.map((level, i) => {
      const s = mk('section', `ln-level${level.side ? ' aside' : ''}`);
      const mark = level.side ? '+' : String(i + 1);
      s.id = `learn-${level.id}`;
      s.setAttribute('aria-labelledby', `learn-${level.id}-h`);
      const h = mk('h3', 'ln-h');
      h.id = `learn-${level.id}-h`;
      h.append(mk('span', 'ln-i', mark), level.name, mk('em', '', ` — ${WORD[level.topics.length] ?? level.topics.length} ${level.side ? 'side ' : ''}doors`));
      const grid = mk('div', 'ln-grid');
      grid.append(...level.topics.map((t) => tileOf(level, t)));
      s.append(h, mk('p', 'ln-hook', level.hook), grid);
      const j = mk('button', '', level.side ? 'also' : level.name);
      j.type = 'button';
      j.prepend(mk('span', 'ln-i', mark));
      j.addEventListener('click', () => s.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
      jump.appendChild(j);
      return s;
    });
    view.replaceChildren(jump, intro, ...sections);
  }

  function item(i, t) {
    const row = mk('li', 'li');
    const a = mk('a', 'li-a');
    a.href = i.u;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const meta = [i.by, i.y, i.len].filter(Boolean).join(' · ');
    a.append(mk('span', 'li-k', i.k), mk('span', 'li-t', i.t), mk('span', 'li-m', meta));
    a.title = `${i.t} (opens in a new tab)`;
    const tick = mk('button', 'li-done');
    tick.type = 'button';
    const paint = () => {
      const on = done.has(i.u);
      tick.setAttribute('aria-pressed', String(on));
      tick.setAttribute('aria-label', `${on ? 'done' : 'mark done'}: ${i.t}`);
      row.classList.toggle('on', on);
    };
    tick.addEventListener('click', () => {
      if (done.has(i.u)) done.delete(i.u); else done.add(i.u);
      saveDone(done); paint(); paintTile(t.id); paintProgress(t);
    });
    paint();
    row.append(a, tick);
    return row;
  }
  function paintProgress(t) {
    if (!drawer) return;
    const d = countOf(t);
    drawer.querySelector('.ld-prog i').style.width = `${Math.round((d / t.items.length) * 100)}%`;
    drawer.querySelector('.ld-prog span').textContent = `${d} of ${t.items.length} done`;
  }

  function openTopic(level, t, from) {
    closeTopic(false);
    opener = from;
    drawer = mk('div', 'ldrw');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-labelledby', 'ld-title');
    drawer.style.setProperty('--c', t.c);
    const head = mk('div', 'ld-head');
    const ttl = mk('div', 'ld-ttl');
    const h = mk('h3', '', t.name);
    h.id = 'ld-title';
    ttl.append(mk('small', '', `${t.code} · ${t.base ? 'foundation' : level.name} · ${plural(t.items.length, 'link', 'links')}`), h);
    const x = mk('button', 'ld-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', `close ${t.name}`);
    x.addEventListener('click', () => closeTopic(true));
    head.append(ttl, x);
    const body = mk('div', 'ld-body');
    const why = mk('p', 'ld-why');
    why.append(mk('b', '', 'why it matters for kula'), t.why);
    const prog = mk('div', 'ld-prog');
    const bar = mk('div', 'ld-bar'); bar.appendChild(mk('i'));
    prog.append(bar, mk('span'));
    body.append(why, prog);
    for (const [k, word] of KINDS) {
      const its = t.items.filter((i) => i.k === k);
      if (!its.length) continue;
      const h4 = mk('h4', '', word);
      h4.appendChild(mk('span', '', String(its.length)));
      const ul = mk('ul', 'ld-list');
      ul.append(...its.map((i) => item(i, t)));
      body.append(h4, ul);
    }
    drawer.append(head, body);
    drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeTopic(true); } });
    brain.appendChild(drawer);
    paintProgress(t);
    requestAnimationFrame(() => { drawer?.classList.add('on'); x.focus({ preventScroll: true }); });
  }
  function closeTopic(back) {
    if (!drawer) return;
    const d = drawer;
    drawer = null;
    d.classList.remove('on');
    const gone = () => d.remove();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) gone(); else setTimeout(gone, 260);
    if (back && opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  let first = 'brain';
  try { if (localStorage.getItem(TAB_KEY) === 'learn') first = 'learn'; } catch {}
  setTab(first);
}
