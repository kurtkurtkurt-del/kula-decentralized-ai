// learn (8.11.2026): what to read and watch to get good at what kula does: running big open
// models on many small devices. Three levels; each topic is a tile that opens to why it matters
// for kula and its papers, videos, courses, posts and docs. Every link was checked to answer
// (arXiv titles against the export api, YouTube ids against oembed) on the day it was written.
// The page's csp allows nothing from elsewhere, so these are plain links that open a new tab.
// kinds: paper · video · course · post · doc

export const LEVELS = [
  {
    id: 'beginner', name: 'beginner',
    hook: 'what a language model is, how it runs on your own computer, and why speed is about memory.',
    topics: [
      {
        id: 'llm', code: 'B1', c: '#4f7397', name: 'how LLMs work',
        hook: 'tokens in, one next token out, again and again.',
        why: 'everything kula moves between devices (layers, weights, the kv cache) is a piece of this loop. know the loop and the rest is plumbing.',
        items: [
          { k: 'video', t: 'Large Language Models explained briefly', by: '3Blue1Brown', y: 2024, len: '8 min', u: 'https://www.youtube.com/watch?v=LPZh9BOjkQs' },
          { k: 'video', t: '[1hr Talk] Intro to Large Language Models', by: 'Andrej Karpathy', y: 2023, len: '1 h', u: 'https://www.youtube.com/watch?v=zjkBMFhNj_g' },
          { k: 'video', t: 'Deep Dive into LLMs like ChatGPT', by: 'Andrej Karpathy', y: 2025, len: '3 h 31 min', u: 'https://www.youtube.com/watch?v=7xTGNNLPyMI' },
          { k: 'video', t: 'How I use LLMs', by: 'Andrej Karpathy', y: 2025, len: '2 h 11 min', u: 'https://www.youtube.com/watch?v=EWvNQjAaOHw' },
          { k: 'post', t: 'LLM Visualization (a 3D walk through a GPT)', by: 'Brendan Bycroft', y: 2023, u: 'https://bbycroft.net/llm' },
          { k: 'post', t: 'Transformer Explainer (runs GPT-2 in the browser)', by: 'Georgia Tech Polo Club', y: 2024, u: 'https://poloclub.github.io/transformer-explainer/' },
        ],
      },
      {
        id: 'nets', code: 'B2', c: '#5b7a55', name: 'neural nets from zero',
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
        id: 'attn', code: 'B3', c: '#8a5a6e', name: 'transformers, by picture',
        hook: 'attention without the maths first, then with it.',
        why: 'a transformer is a stack of identical blocks. split mode cuts that stack between devices, so the block is the unit kula thinks in.',
        items: [
          { k: 'video', t: 'Transformers, the tech behind LLMs', by: '3Blue1Brown', y: 2024, len: '27 min', u: 'https://www.youtube.com/watch?v=wjZofJX0v4M' },
          { k: 'video', t: 'Attention in transformers, step-by-step', by: '3Blue1Brown', y: 2024, len: '26 min', u: 'https://www.youtube.com/watch?v=eMlx5fFNoYc' },
          { k: 'video', t: 'How might LLMs store facts', by: '3Blue1Brown', y: 2024, len: '23 min', u: 'https://www.youtube.com/watch?v=9-Jl0dxWQs8' },
          { k: 'post', t: 'The Illustrated Transformer', by: 'Jay Alammar', y: 2018, u: 'https://jalammar.github.io/illustrated-transformer/' },
          { k: 'post', t: 'The Illustrated GPT-2', by: 'Jay Alammar', y: 2019, u: 'https://jalammar.github.io/illustrated-gpt2/' },
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
          { k: 'paper', t: 'LLaMA: Open and Efficient Foundation Language Models', by: 'Touvron et al.', y: 2023, u: 'https://arxiv.org/abs/2302.13971' },
          { k: 'paper', t: 'Llama 2: Open Foundation and Fine-Tuned Chat Models', by: 'Touvron et al.', y: 2023, u: 'https://arxiv.org/abs/2307.09288' },
        ],
      },
      {
        id: 'tokens', code: 'B5', c: '#4a7f7a', name: 'tokens and sampling',
        hook: 'what a token is, and how the next one is picked.',
        why: 'tokens per second is the number the brain shows for every device; temperature and top-p are what the chat sends.',
        items: [
          { k: 'video', t: 'Let\'s build the GPT Tokenizer', by: 'Andrej Karpathy', y: 2024, len: '2 h 14 min', u: 'https://www.youtube.com/watch?v=zduSFxRajkE' },
          { k: 'post', t: 'How to generate text: using different decoding methods', by: 'Hugging Face', y: 2020, u: 'https://huggingface.co/blog/how-to-generate' },
          { k: 'paper', t: 'The Curious Case of Neural Text Degeneration (top-p)', by: 'Holtzman et al.', y: 2019, u: 'https://arxiv.org/abs/1904.09751' },
        ],
      },
      {
        id: 'memory', code: 'B6', c: '#b07d3f', name: 'why speed is memory',
        hook: 'decoding reads every weight once per token: bandwidth, not flops, sets the pace.',
        why: 'this one idea explains why a phone gives 8 tok/s, why quantizing helps, and why split mode adds devices for memory, not speed.',
        items: [
          { k: 'post', t: 'Making Deep Learning Go Brrrr From First Principles', by: 'Horace He', y: 2022, u: 'https://horace.io/brrr_intro.html' },
          { k: 'post', t: 'Transformer Inference Arithmetic', by: 'kipply', y: 2022, u: 'https://kipp.ly/transformer-inference-arithmetic/' },
          { k: 'post', t: 'LLM Inference Performance Engineering: Best Practices', by: 'Databricks', y: 2023, u: 'https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices' },
          { k: 'post', t: 'Mastering LLM Techniques: Inference Optimization', by: 'NVIDIA', y: 2023, u: 'https://developer.nvidia.com/blog/mastering-llm-techniques-inference-optimization/' },
        ],
      },
    ],
  },
  {
    id: 'intermediate', name: 'intermediate',
    hook: 'the papers under the tools: transformers properly, quantization, the kv cache, llama.cpp from inside.',
    topics: [
      {
        id: 'tf', code: 'I1', c: '#4f7397', name: 'the transformer, properly',
        hook: 'the paper, line by line in code, and what changed since.',
        why: 'rope, grouped-query attention and the rest decide how big a layer is and how much kv cache a device must hold.',
        items: [
          { k: 'paper', t: 'Attention Is All You Need', by: 'Vaswani et al.', y: 2017, u: 'https://arxiv.org/abs/1706.03762' },
          { k: 'video', t: 'Attention Is All You Need (the paper, read aloud and explained)', by: 'Yannic Kilcher', y: 2017, len: '27 min', u: 'https://www.youtube.com/watch?v=iDulhoQ2pro' },
          { k: 'video', t: 'Attention is all you need (Transformer): model explanation including math, inference and training', by: 'Umar Jamil', y: 2023, len: '58 min', u: 'https://www.youtube.com/watch?v=bCz4OMemCcA' },
          { k: 'post', t: 'The Annotated Transformer', by: 'Harvard NLP', y: 2022, u: 'https://nlp.seas.harvard.edu/annotated-transformer/' },
          { k: 'video', t: 'Let\'s build GPT: from scratch, in code, spelled out', by: 'Andrej Karpathy', y: 2023, len: '1 h 56 min', u: 'https://www.youtube.com/watch?v=kCc8FmEb1nY' },
          { k: 'paper', t: 'Language Models are Few-Shot Learners (GPT-3)', by: 'Brown et al.', y: 2020, u: 'https://arxiv.org/abs/2005.14165' },
          { k: 'paper', t: 'RoFormer: Enhanced Transformer with Rotary Position Embedding', by: 'Su et al.', y: 2021, u: 'https://arxiv.org/abs/2104.09864' },
          { k: 'paper', t: 'Fast Transformer Decoding: One Write-Head is All You Need (MQA)', by: 'Shazeer', y: 2019, u: 'https://arxiv.org/abs/1911.02150' },
          { k: 'paper', t: 'GQA: Training Generalized Multi-Query Transformer Models', by: 'Ainslie et al.', y: 2023, u: 'https://arxiv.org/abs/2305.13245' },
          { k: 'course', t: 'CS336: Language Modeling from Scratch', by: 'Stanford', y: 2025, u: 'https://stanford-cs336.github.io/spring2025/' },
          { k: 'video', t: 'CS336 Language Modeling from Scratch, 2025 (all lectures)', by: 'Stanford Online', y: 2025, u: 'https://www.youtube.com/playlist?list=PLoROMvodv4rOY23Y0BoGoBGgQ1zmU_MT_' },
          { k: 'course', t: 'CS25: Transformers United', by: 'Stanford', u: 'https://web.stanford.edu/class/cs25/' },
        ],
      },
      {
        id: 'quant', code: 'I2', c: '#b07d3f', name: 'quantization and gguf',
        hook: 'from 16 bits to 4 (or fewer) without losing the model.',
        why: 'a Q4_K_M file is a quarter of the size and runs about four times faster on a phone. kula\'s model list is mostly quantized files.',
        items: [
          { k: 'post', t: 'A Visual Guide to Quantization', by: 'Maarten Grootendorst', y: 2024, u: 'https://newsletter.maartengrootendorst.com/p/a-visual-guide-to-quantization' },
          { k: 'paper', t: 'LLM.int8(): 8-bit Matrix Multiplication for Transformers at Scale', by: 'Dettmers et al.', y: 2022, u: 'https://arxiv.org/abs/2208.07339' },
          { k: 'paper', t: 'GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers', by: 'Frantar et al.', y: 2022, u: 'https://arxiv.org/abs/2210.17323' },
          { k: 'paper', t: 'AWQ: Activation-aware Weight Quantization', by: 'Lin et al.', y: 2023, u: 'https://arxiv.org/abs/2306.00978' },
          { k: 'paper', t: 'SmoothQuant: Accurate and Efficient Post-Training Quantization', by: 'Xiao et al.', y: 2022, u: 'https://arxiv.org/abs/2211.10438' },
          { k: 'paper', t: 'QLoRA: Efficient Finetuning of Quantized LLMs', by: 'Dettmers et al.', y: 2023, u: 'https://arxiv.org/abs/2305.14314' },
          { k: 'doc', t: 'k-quants: the pull request that made Q4_K and friends', by: 'ggml-org', y: 2023, u: 'https://github.com/ggml-org/llama.cpp/pull/1684' },
          { k: 'doc', t: 'GGUF file format spec', by: 'ggml-org', u: 'https://github.com/ggml-org/ggml/blob/master/docs/gguf.md' },
          { k: 'video', t: 'Quantization explained with PyTorch', by: 'Umar Jamil', y: 2023, len: '51 min', u: 'https://www.youtube.com/watch?v=0VdNflU08yA' },
        ],
      },
      {
        id: 'kv', code: 'I3', c: '#8a5a6e', name: 'kv cache and attention memory',
        hook: 'the memory that grows with every token of the chat.',
        why: 'in split mode each device holds the kv cache of its own layers; long chats run out of it before they run out of weights.',
        items: [
          { k: 'video', t: 'LLaMA explained: KV-Cache, Rotary Positional Embedding, RMS Norm, Grouped Query Attention, SwiGLU', by: 'Umar Jamil', y: 2023, len: '1 h 11 min', u: 'https://www.youtube.com/watch?v=Mn_9W1nCFLo' },
          { k: 'paper', t: 'Efficient Memory Management for LLM Serving with PagedAttention (vLLM)', by: 'Kwon et al.', y: 2023, u: 'https://arxiv.org/abs/2309.06180' },
          { k: 'video', t: 'vLLM: Easy, Fast, and Cheap LLM Serving', by: 'Woosuk Kwon, UC Berkeley', y: 2024, len: '23 min', u: 'https://www.youtube.com/watch?v=8BaEwoTk8XI' },
          { k: 'paper', t: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness', by: 'Dao et al.', y: 2022, u: 'https://arxiv.org/abs/2205.14135' },
          { k: 'paper', t: 'FlashAttention-2: Faster Attention with Better Parallelism', by: 'Dao', y: 2023, u: 'https://arxiv.org/abs/2307.08691' },
          { k: 'paper', t: 'Efficient Streaming Language Models with Attention Sinks', by: 'Xiao et al.', y: 2023, u: 'https://arxiv.org/abs/2309.17453' },
          { k: 'paper', t: 'H2O: Heavy-Hitter Oracle for Efficient Generative Inference', by: 'Zhang et al.', y: 2023, u: 'https://arxiv.org/abs/2306.14048' },
        ],
      },
      {
        id: 'ggml', code: 'I4', c: '#9b5b3a', name: 'llama.cpp and ggml inside',
        hook: 'tensors, graphs, backends, and the rpc server kula splits over.',
        why: 'split mode is ggml\'s rpc backend behind kula\'s gate. read how a graph is built and sent, and you can read kula-llama.',
        items: [
          { k: 'post', t: 'Introduction to ggml', by: 'Hugging Face (Xuan Son Nguyen)', y: 2024, u: 'https://huggingface.co/blog/introduction-to-ggml' },
          { k: 'doc', t: 'ggml: the tensor library under llama.cpp', by: 'ggml-org', u: 'https://github.com/ggml-org/ggml' },
          { k: 'doc', t: 'llama.cpp rpc: run one model across machines', by: 'ggml-org', u: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md' },
          { k: 'doc', t: 'llama.cpp on Android', by: 'ggml-org', u: 'https://github.com/ggml-org/llama.cpp/blob/master/docs/android.md' },
          { k: 'post', t: 'Understanding how LLM inference works with llama.cpp', by: 'Omri Mallis', y: 2023, u: 'https://www.omrimallis.com/posts/understanding-how-llm-inference-works-with-llama-cpp/' },
        ],
      },
      {
        id: 'moe', code: 'I5', c: '#6b7a3c', name: 'mixture of experts',
        hook: 'a huge model where each token only wakes a few experts.',
        why: 'frontier open models are moe now. an expert is a natural piece to place on one device, and only a few run per token.',
        items: [
          { k: 'post', t: 'Mixture of Experts Explained', by: 'Hugging Face', y: 2023, u: 'https://huggingface.co/blog/moe' },
          { k: 'post', t: 'A Visual Guide to Mixture of Experts', by: 'Maarten Grootendorst', y: 2024, u: 'https://newsletter.maartengrootendorst.com/p/a-visual-guide-to-mixture-of-experts' },
          { k: 'paper', t: 'Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer', by: 'Shazeer et al.', y: 2017, u: 'https://arxiv.org/abs/1701.06538' },
          { k: 'paper', t: 'Switch Transformers: Scaling to Trillion Parameter Models', by: 'Fedus et al.', y: 2021, u: 'https://arxiv.org/abs/2101.03961' },
          { k: 'paper', t: 'Mixtral of Experts', by: 'Jiang et al.', y: 2024, u: 'https://arxiv.org/abs/2401.04088' },
          { k: 'paper', t: 'DeepSeekMoE: Towards Ultimate Expert Specialization', by: 'Dai et al.', y: 2024, u: 'https://arxiv.org/abs/2401.06066' },
          { k: 'video', t: 'Mistral / Mixtral Explained: Sliding Window Attention, Sparse Mixture of Experts, Rolling Buffer', by: 'Umar Jamil', y: 2023, len: '1 h 26 min', u: 'https://www.youtube.com/watch?v=UiX8K-xBUpE' },
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
      {
        id: 'scale', code: 'I7', c: '#5f6b7a', name: 'scaling laws',
        hook: 'how size, data and compute trade against each other.',
        why: 'tells you which model is worth splitting across four phones and which small one is nearly as good.',
        items: [
          { k: 'paper', t: 'Scaling Laws for Neural Language Models', by: 'Kaplan et al.', y: 2020, u: 'https://arxiv.org/abs/2001.08361' },
          { k: 'paper', t: 'Training Compute-Optimal Large Language Models (Chinchilla)', by: 'Hoffmann et al.', y: 2022, u: 'https://arxiv.org/abs/2203.15556' },
          { k: 'video', t: 'Let\'s reproduce GPT-2 (124M)', by: 'Andrej Karpathy', y: 2024, len: '4 h 1 min', u: 'https://www.youtube.com/watch?v=l8pRSuU81PU' },
        ],
      },
    ],
  },
  {
    id: 'advanced', name: 'advanced',
    hook: 'one model on many machines: parallelism, the internet, phones, scheduling, trust and energy.',
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
          { k: 'paper', t: 'ZeRO: Memory Optimizations Toward Training Trillion Parameter Models', by: 'Rajbhandari et al.', y: 2019, u: 'https://arxiv.org/abs/1910.02054' },
          { k: 'paper', t: 'Efficiently Scaling Transformer Inference', by: 'Pope et al.', y: 2022, u: 'https://arxiv.org/abs/2211.05102' },
          { k: 'course', t: 'The Ultra-Scale Playbook: Training LLMs on GPU Clusters', by: 'Hugging Face', y: 2025, u: 'https://huggingface.co/spaces/nanotron/ultrascale-playbook' },
          { k: 'course', t: 'How to Scale Your Model', by: 'Google DeepMind', y: 2025, u: 'https://jax-ml.github.io/scaling-book/' },
          { k: 'post', t: 'How to Train Really Large Models on Many GPUs?', by: 'Lilian Weng', y: 2021, u: 'https://lilianweng.github.io/posts/2021-09-25-train-large/' },
        ],
      },
      {
        id: 'swarm', code: 'A2', c: '#4f7397', name: 'decentralised inference',
        hook: 'big models over the internet and on consumer machines.',
        why: 'this is kula\'s own field: petals, swarm, exo. read what worked, what broke, and where kula differs (no relay, devices on one network).',
        items: [
          { k: 'paper', t: 'Petals: Collaborative Inference and Fine-tuning of Large Models', by: 'Borzunov et al.', y: 2022, u: 'https://arxiv.org/abs/2209.01188' },
          { k: 'paper', t: 'Distributed Inference and Fine-tuning of Large Language Models Over The Internet', by: 'Borzunov et al.', y: 2023, u: 'https://arxiv.org/abs/2312.08361' },
          { k: 'paper', t: 'SWARM Parallelism: Training Large Models Can Be Surprisingly Communication-Efficient', by: 'Ryabinin et al.', y: 2023, u: 'https://arxiv.org/abs/2301.11913' },
          { k: 'paper', t: 'Towards Crowdsourced Training of Large Neural Networks using Decentralized Mixture-of-Experts', by: 'Ryabinin, Gusev', y: 2020, u: 'https://arxiv.org/abs/2002.04013' },
          { k: 'paper', t: 'Decentralized Training of Foundation Models in Heterogeneous Environments', by: 'Yuan et al.', y: 2022, u: 'https://arxiv.org/abs/2206.01288' },
          { k: 'paper', t: 'DiLoCo: Distributed Low-Communication Training of Language Models', by: 'Douillard et al.', y: 2023, u: 'https://arxiv.org/abs/2311.08105' },
          { k: 'paper', t: 'INTELLECT-1 Technical Report', by: 'Prime Intellect', y: 2024, u: 'https://arxiv.org/abs/2412.01152' },
          { k: 'doc', t: 'exo: run your own AI cluster at home with everyday devices', by: 'exo labs', u: 'https://github.com/exo-explore/exo' },
          { k: 'doc', t: 'hivemind: decentralized deep learning in PyTorch', by: 'learning@home', u: 'https://github.com/learning-at-home/hivemind' },
          { k: 'video', t: 'Run Frontier AI at Home', by: 'Alex Cheema, EXO Labs (AI Engineer)', y: 2026, len: '1 h 45 min', u: 'https://www.youtube.com/watch?v=ESbWpPT_9-o' },
          { k: 'video', t: 'Frontier LLMs Locally: EXO Labs CEO on Clustering Macs & DGX Sparks', by: 'ThursdAI', y: 2026, len: '17 min', u: 'https://www.youtube.com/watch?v=JNTsiyj9bj0' },
        ],
      },
      {
        id: 'edge', code: 'A3', c: '#5b7a55', name: 'on-device and edge AI',
        hook: 'models bigger than the phone\'s memory, and models made for phones.',
        why: 'every kula device is an edge device. flash offloading and sparsity are how a phone can hold more of the model than its ram.',
        items: [
          { k: 'paper', t: 'LLM in a flash: Efficient LLM Inference with Limited Memory', by: 'Alizadeh et al. (Apple)', y: 2023, u: 'https://arxiv.org/abs/2312.11514' },
          { k: 'paper', t: 'PowerInfer: Fast LLM Serving with a Consumer-grade GPU', by: 'Song et al.', y: 2023, u: 'https://arxiv.org/abs/2312.12456' },
          { k: 'paper', t: 'PowerInfer-2: Fast LLM Inference on a Smartphone', by: 'Xue et al.', y: 2024, u: 'https://arxiv.org/abs/2406.06282' },
          { k: 'paper', t: 'Deja Vu: Contextual Sparsity for Efficient LLMs at Inference Time', by: 'Liu et al.', y: 2023, u: 'https://arxiv.org/abs/2310.17157' },
          { k: 'paper', t: 'MobileLLM: Optimizing Sub-billion Parameter Language Models for On-Device Use', by: 'Liu et al. (Meta)', y: 2024, u: 'https://arxiv.org/abs/2402.14905' },
          { k: 'paper', t: 'The Era of 1-bit LLMs: All Large Language Models are in 1.58 Bits', by: 'Ma et al.', y: 2024, u: 'https://arxiv.org/abs/2402.17764' },
          { k: 'course', t: 'MIT 6.5940 TinyML and Efficient Deep Learning Computing', by: 'Song Han', u: 'https://efficientml.ai/' },
          { k: 'video', t: 'EfficientML.ai Lecture 12: Transformer and LLM', by: 'MIT HAN Lab (Song Han)', y: 2024, len: '1 h 17 min', u: 'https://www.youtube.com/watch?v=EV6xb4xY708' },
          { k: 'video', t: 'EfficientML.ai Lecture 14: LLM Post-Training', by: 'MIT HAN Lab (Song Han)', y: 2024, len: '1 h 19 min', u: 'https://www.youtube.com/watch?v=udw5TxtbmLI' },
          { k: 'video', t: 'EfficientML.ai Lecture 15: Long-Context LLM', by: 'MIT HAN Lab (Song Han)', y: 2024, len: '1 h 14 min', u: 'https://www.youtube.com/watch?v=kgTWKjbnrBA' },
          { k: 'doc', t: 'MLC LLM: compile models for phones and browsers', by: 'MLC', u: 'https://llm.mlc.ai/' },
          { k: 'post', t: 'Introducing Apple\'s On-Device and Server Foundation Models', by: 'Apple ML Research', y: 2024, u: 'https://machinelearning.apple.com/research/introducing-apple-foundation-models' },
        ],
      },
      {
        id: 'sched', code: 'A4', c: '#b07d3f', name: 'scheduling and forecasting',
        hook: 'who runs what, when, and how long it will take.',
        why: 'the planner and forecast branches: placing layers on uneven devices and guessing how long a night project needs.',
        items: [
          { k: 'paper', t: 'Orca: A Distributed Serving System for Transformer-Based Generative Models', by: 'Yu et al., OSDI', y: 2022, u: 'https://www.usenix.org/conference/osdi22/presentation/yu' },
          { k: 'post', t: 'How continuous batching enables 23x throughput in LLM inference', by: 'Anyscale', y: 2023, u: 'https://www.anyscale.com/blog/continuous-batching-llm-inference' },
          { k: 'paper', t: 'Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve', by: 'Agrawal et al.', y: 2024, u: 'https://arxiv.org/abs/2403.02310' },
          { k: 'paper', t: 'DistServe: Disaggregating Prefill and Decoding', by: 'Zhong et al.', y: 2024, u: 'https://arxiv.org/abs/2401.09670' },
          { k: 'paper', t: 'Splitwise: Efficient Generative LLM Inference Using Phase Splitting', by: 'Patel et al.', y: 2023, u: 'https://arxiv.org/abs/2311.18677' },
          { k: 'paper', t: 'HexGen: Generative Inference of Foundation Model over Heterogeneous Decentralized Environment', by: 'Jiang et al.', y: 2023, u: 'https://arxiv.org/abs/2311.11514' },
          { k: 'paper', t: 'Helix: Distributed Serving of Large Language Models via Max-Flow on Heterogeneous GPUs', by: 'Mei et al.', y: 2024, u: 'https://arxiv.org/abs/2406.01566' },
          { k: 'paper', t: 'Efficient LLM Scheduling by Learning to Rank', by: 'Fu et al.', y: 2024, u: 'https://arxiv.org/abs/2408.15792' },
        ],
      },
      {
        id: 'fed', code: 'A5', c: '#4a7f7a', name: 'federated learning',
        hook: 'learning from many devices without collecting their data.',
        why: 'the learning branch: how the brain could get better from every kula without any chat leaving its device.',
        items: [
          { k: 'paper', t: 'Communication-Efficient Learning of Deep Networks from Decentralized Data', by: 'McMahan et al.', y: 2016, u: 'https://arxiv.org/abs/1602.05629' },
          { k: 'paper', t: 'Advances and Open Problems in Federated Learning', by: 'Kairouz et al.', y: 2019, u: 'https://arxiv.org/abs/1912.04977' },
          { k: 'video', t: 'CS-E4740 Federated Learning: horizontal FL', by: 'Alexander Jung, Aalto University', y: 2025, len: '9 min', u: 'https://www.youtube.com/watch?v=dOe4jf0bCCg' },
          { k: 'post', t: 'Federated Learning: Collaborative Machine Learning without Centralized Training Data', by: 'Google Research', y: 2017, u: 'https://research.google/blog/federated-learning-collaborative-machine-learning-without-centralized-training-data/' },
          { k: 'post', t: 'Federated Learning, an online comic', by: 'Google', y: 2019, u: 'https://federated.withgoogle.com/' },
          { k: 'doc', t: 'Flower: a friendly federated learning framework', by: 'Flower Labs', u: 'https://flower.ai/docs/framework/' },
        ],
      },
      {
        id: 'trust', code: 'A6', c: '#6b7a3c', name: 'trust and verification',
        hook: 'when a device you do not control computes part of your answer.',
        why: 'the trust branch and the passport: how to know a device ran the layers it says it ran, and what to do when one lies.',
        items: [
          { k: 'paper', t: 'The Byzantine Generals Problem', by: 'Lamport, Shostak, Pease', y: 1982, u: 'https://lamport.azurewebsites.net/pubs/byz.pdf' },
          { k: 'paper', t: 'Practical Byzantine Fault Tolerance', by: 'Castro, Liskov, OSDI', y: 1999, u: 'https://www.usenix.org/conference/osdi-99/practical-byzantine-fault-tolerance' },
          { k: 'paper', t: 'SafetyNets: Verifiable Execution of Deep Neural Networks on an Untrusted Cloud', by: 'Ghodsi et al.', y: 2017, u: 'https://arxiv.org/abs/1706.10268' },
          { k: 'paper', t: 'zkLLM: Zero Knowledge Proofs for Large Language Models', by: 'Sun et al.', y: 2024, u: 'https://arxiv.org/abs/2404.16109' },
          { k: 'paper', t: 'TOPLOC: A Locality Sensitive Hashing Scheme for Trustless Verifiable Inference', by: 'Ong et al.', y: 2025, u: 'https://arxiv.org/abs/2501.16007' },
        ],
      },
      {
        id: 'energy', code: 'A7', c: '#b4513a', name: 'energy and heat',
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
      {
        id: 'kernels', code: 'A8', c: '#9b5b3a', name: 'kernels and the gpu',
        hook: 'where the time actually goes inside one matmul.',
        why: 'to make one device faster (Metal on the Mac, Vulkan or the cpu on a phone), you end up here.',
        items: [
          { k: 'paper', t: 'FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision', by: 'Shah et al.', y: 2024, u: 'https://arxiv.org/abs/2407.08608' },
          { k: 'video', t: 'Flash Attention derived and coded from first principles with Triton (Python)', by: 'Umar Jamil', y: 2024, len: '7 h 38 min', u: 'https://www.youtube.com/watch?v=zy8ChVd_oTM' },
          { k: 'paper', t: 'Roofline: An Insightful Visual Performance Model for Floating-Point Programs and Multicore Architectures', by: 'Williams, Waterman, Patterson', y: 2008, u: 'https://www2.eecs.berkeley.edu/Pubs/TechRpts/2008/EECS-2008-134.html' },
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
    top.append(mk('span', 'lt-code', `${t.code} · ${level.name}`), mk('span', 'lt-name', t.name), mk('span', 'lt-hook', t.hook));
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
    const topics = LEVELS.reduce((n, l) => n + l.topics.length, 0);
    const intro = mk('p', 'ln-intro', `what to read and watch to get good at this: big open models on many small devices. three levels, ${topics} topics, ${LEARN_COUNT} links; each opens in a new tab. tick what you have done.`);
    const jump = mk('nav', 'ln-jump');
    jump.setAttribute('aria-label', 'levels');
    const sections = LEVELS.map((level, i) => {
      const s = mk('section', 'ln-level');
      s.id = `learn-${level.id}`;
      s.setAttribute('aria-labelledby', `learn-${level.id}-h`);
      const h = mk('h3', 'ln-h');
      h.id = `learn-${level.id}-h`;
      h.append(mk('span', 'ln-i', String(i + 1)), level.name, mk('em', '', ` — ${WORD[level.topics.length] ?? level.topics.length} doors`));
      const grid = mk('div', 'ln-grid');
      grid.append(...level.topics.map((t) => tileOf(level, t)));
      s.append(h, mk('p', 'ln-hook', level.hook), grid);
      const j = mk('button', '', level.name);
      j.type = 'button';
      j.prepend(mk('span', 'ln-i', String(i + 1)));
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
    ttl.append(mk('small', '', `${t.code} · ${level.name} · ${plural(t.items.length, 'link', 'links')}`), h);
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
