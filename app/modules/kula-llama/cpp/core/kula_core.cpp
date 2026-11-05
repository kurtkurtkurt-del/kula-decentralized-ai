// kula-llama core, see kula_core.h.
//
// Ported from PrivateLM's llama_flutter_android jni_wrapper.cpp (MIT, dragneel2074 /
// orailnoor / techjarves) on 4.11.2026, without Vulkan, mtmd and the Flutter plumbing; the
// JNI was split off into android/src/main/cpp/kula_llama.cpp on 5.11.2026 so iOS shares it.
//
// Android: backends are separate .so files loaded at runtime from the app's native library
// dir (KULA_BACKEND_DL): one CPU build per Arm generation, the fastest the phone supports is
// picked, and libggml-rpc.so for the cluster.
// iOS: CPU, Metal and RPC are linked in and register themselves (KULA_USE_GPU).
#include "kula_core.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <fstream>
#include <mutex>
#include <thread>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#ifdef KULA_BACKEND_DL
#include <dlfcn.h>
#include <setjmp.h>
#include <signal.h>
#endif

#include "llama.h"
#include "ggml-backend.h"
#include "gguf.h"

namespace kula {

// --- logging ----------------------------------------------------------------------------

static void stderrSink(LogLevel level, const char* text) {
    std::fprintf(stderr, "kula-llama %s: %s\n", level == LogLevel::Error ? "E" : level == LogLevel::Warn ? "W" : "I", text);
}
static LogSink g_sink = stderrSink;
void setLogSink(LogSink sink) { g_sink = sink ? sink : stderrSink; }

static void logf(LogLevel level, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
static void logf(LogLevel level, const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    g_sink(level, buf);
}
#define LOGI(...) logf(LogLevel::Info, __VA_ARGS__)
#define LOGE(...) logf(LogLevel::Error, __VA_ARGS__)

// --- state ------------------------------------------------------------------------------

static llama_model* g_model = nullptr;
static llama_context* g_ctx = nullptr;
static const llama_vocab* g_vocab = nullptr;
static llama_sampler* g_sampler = nullptr;
static std::atomic<bool> g_stop_flag{false};
static std::atomic<bool> g_generating{false};
static int g_n_past = 0;
// Exactly the tokens in the KV cache (sequence 0): each turn reuses the prefix it shares
// with the previous prompt + reply instead of re-feeding the whole conversation.
static std::vector<llama_token> g_cached_tokens;
static std::mutex g_load_log_mutex;
static std::string g_load_error;
static bool g_capture_load_error = false;
// "<buffer>\t<MiB>" per weight buffer of the last load. Workers' buffers are named
// "RPC<n>[host:port]"; everything else is on this phone.
static std::string g_load_buffers;
// Worker: the master connected right now (from the patched RPC log lines), or empty.
static std::string g_worker_peer;
static std::mutex g_backend_mutex;
static std::string g_lib_dir;
static bool g_cpu_backend_loaded = false;
static bool g_rpc_backend_loaded = false;

static void kulaLog(ggml_log_level level, const char* text, void*);

// --- runtime backend loading -----------------------------------------------------------

#ifdef KULA_BACKEND_DL
// Best first. armv9 (SVE2/SME) variants are left out: on a Pixel 8 the SVE2 repack path
// produced out-of-range values and aborted on the first decode (PrivateLM's finding).
static const char* const kCpuVariants[] = {
    "android_armv8.6_1", "android_armv8.2_2", "android_armv8.2_1", "android_armv8.0_1",
};

// Some kernels hide dot-product / fp16 from HWCAP (Poco F1 on LineageOS). Run one
// instruction of each and catch SIGILL instead of trusting the kernel.
static sigjmp_buf g_probe_jmp;
static void probeSigill(int) { siglongjmp(g_probe_jmp, 1); }
static bool cpuRuns(void (*probe)()) {
    struct sigaction ill = {}, old = {};
    ill.sa_handler = probeSigill;
    sigemptyset(&ill.sa_mask);
    sigaction(SIGILL, &ill, &old);
    bool ok = false;
    if (sigsetjmp(g_probe_jmp, 1) == 0) { probe(); ok = true; }
    sigaction(SIGILL, &old, nullptr);
    return ok;
}
#if defined(__aarch64__)
static void probeDotprod() { asm volatile(".inst 0x4e829420" ::: "v0"); }  // sdot
static void probeFp16() { asm volatile(".inst 0x4e421420" ::: "v0"); }     // fadd .8h
#else
static void probeDotprod() {}
static void probeFp16() {}
#endif

static bool loadCpuVariantUnchecked(const std::string& path) {
    void* handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!handle) return false;
    using init_fn = ggml_backend_reg_t (*)();
    auto init = reinterpret_cast<init_fn>(dlsym(handle, "ggml_backend_init"));
    ggml_backend_reg_t reg = init ? init() : nullptr;
    if (!reg) { dlclose(handle); return false; }
    ggml_backend_register(reg);
    return true;
}

static void loadCpuBackendLocked() {
    if (g_cpu_backend_loaded) return;
    std::string best_path, best_name;
    int best_score = 0;
    for (const char* variant : kCpuVariants) {
        const std::string path = g_lib_dir + "/libggml-cpu-" + variant + ".so";
        void* handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
        if (!handle) continue;
        using score_fn = int (*)();
        auto score = reinterpret_cast<score_fn>(dlsym(handle, "ggml_backend_score"));
        const int value = score ? score() : 0;
        dlclose(handle);
        if (value > best_score) { best_score = value; best_path = path; best_name = variant; }
    }
    if (best_name == "android_armv8.0_1" && cpuRuns(probeDotprod)) {
        const char* variant = cpuRuns(probeFp16) ? "android_armv8.2_2" : "android_armv8.2_1";
        if (loadCpuVariantUnchecked(g_lib_dir + "/libggml-cpu-" + variant + ".so")) {
            g_cpu_backend_loaded = true;
            LOGI("CPU backend: %s (probed; the kernel hides these features)", variant);
            return;
        }
    }
    if (!best_path.empty() && ggml_backend_load(best_path.c_str())) {
        g_cpu_backend_loaded = true;
        LOGI("CPU backend: %s (score %d)", best_name.c_str(), best_score);
    } else if (ggml_backend_load((g_lib_dir + "/libggml-cpu.so").c_str())) {
        // a KULA_CPU_VARIANTS=min build ships one generic CPU backend
        g_cpu_backend_loaded = true;
        LOGI("CPU backend: generic");
    } else {
        LOGE("No CPU backend could be loaded from %s", g_lib_dir.c_str());
    }
}

static ggml_backend_reg_t loadRpcBackendLocked() {
    if (!g_rpc_backend_loaded) {
        const std::string path = g_lib_dir + "/libggml-rpc.so";
        if (!ggml_backend_load(path.c_str())) { LOGE("RPC backend unavailable (%s)", path.c_str()); return nullptr; }
        g_rpc_backend_loaded = true;
        LOGI("RPC backend loaded");
    }
    return ggml_backend_reg_by_name("RPC");
}
#else
// Statically linked backends register themselves on first use.
static void loadCpuBackendLocked() {
    if (g_cpu_backend_loaded) return;
    g_cpu_backend_loaded = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU) != nullptr;
    if (!g_cpu_backend_loaded) LOGE("No CPU backend linked in");
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        LOGI("backend device: %s (%s)", ggml_backend_dev_name(dev), ggml_backend_dev_description(dev));
    }
}
static ggml_backend_reg_t loadRpcBackendLocked() {
    ggml_backend_reg_t reg = ggml_backend_reg_by_name("RPC");
    if (reg && !g_rpc_backend_loaded) { g_rpc_backend_loaded = true; LOGI("RPC backend linked in"); }
    return reg;
}
#endif

#ifdef KULA_USE_GPU
// The GPU linked in (Metal on iOS), or null when this build has none / the device has none.
static ggml_backend_dev_t localGpuDevice() {
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        if (ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_GPU) return dev;
    }
    return nullptr;
}
#endif

// --- cluster plan -----------------------------------------------------------------------

static std::vector<std::string> g_registered_endpoints;

static int readBlockCount(const char* model_path) {
    gguf_init_params params = {/* .no_alloc = */ true, /* .ctx = */ nullptr};
    gguf_context* gguf = gguf_init_from_file(model_path, params);
    if (!gguf) return -1;
    int count = -1;
    const int64_t arch_id = gguf_find_key(gguf, "general.architecture");
    if (arch_id >= 0) {
        const std::string key = std::string(gguf_get_val_str(gguf, arch_id)) + ".block_count";
        const int64_t id = gguf_find_key(gguf, key.c_str());
        if (id >= 0) {
            switch (gguf_get_kv_type(gguf, id)) {
                case GGUF_TYPE_UINT32: count = (int)gguf_get_val_u32(gguf, id); break;
                case GGUF_TYPE_INT32: count = gguf_get_val_i32(gguf, id); break;
                default: break;
            }
        }
    }
    gguf_free(gguf);
    return count;
}

struct ClusterPlan {
    std::vector<ggml_backend_dev_t> devices;  // null-terminated
    std::vector<float> split;
    int n_gpu_layers = 0;
    int local_layers = 0;
    int n_layer = 0;
    llama_model_tensor_buft_override overrides[2] = {};
};

// This phone keeps the first layers (by its weight), the workers get the rest split by
// theirs; the output layer stays here so no logits cross Wi-Fi per token.
// Every endpoint must already have answered a TCP probe: add_server aborts the process.
// With KULA_USE_GPU the local share is one more device in the split (the GPU) instead of
// CPU-only front layers; the layer count reported is the same proportional estimate.
static std::string planCluster(const char* model_path, const std::vector<std::string>& endpoints,
                               const std::vector<float>& weights, float local_weight, ClusterPlan& plan) {
    ggml_backend_reg_t rpc;
    {
        std::lock_guard<std::mutex> lock(g_backend_mutex);
        rpc = loadRpcBackendLocked();
    }
    if (!rpc) return "this build has no cluster (RPC) support";
    using add_server_fn = ggml_backend_reg_t (*)(const char*);
    auto add_server = reinterpret_cast<add_server_fn>(ggml_backend_reg_get_proc_address(rpc, "ggml_backend_rpc_add_server"));
    if (!add_server) return "RPC backend is missing ggml_backend_rpc_add_server";

    const int n_layer = readBlockCount(model_path);
    if (n_layer <= 0) return "could not read the model's layer count";

    float remote_weight = 0.0f;
    std::vector<float> device_weights;
    for (size_t i = 0; i < endpoints.size(); i++) {
        ggml_backend_reg_t reg = add_server(endpoints[i].c_str());
        if (!reg) return "worker " + endpoints[i] + " reported no devices";
        if (std::find(g_registered_endpoints.begin(), g_registered_endpoints.end(), endpoints[i]) == g_registered_endpoints.end()) {
            ggml_backend_register(reg);
            g_registered_endpoints.push_back(endpoints[i]);
        }
        const size_t n_dev = ggml_backend_reg_dev_count(reg);
        const float w = std::max(i < weights.size() ? weights[i] : 1.0f, 0.01f);
        for (size_t d = 0; d < n_dev; d++) {
            plan.devices.push_back(ggml_backend_reg_dev_get(reg, d));
            device_weights.push_back(w / n_dev);
        }
        remote_weight += w;
    }
    if (plan.devices.empty()) return "no cluster workers";

    const float total = std::max(local_weight, 0.0f) + remote_weight;
    int local = (int)std::lround(n_layer * std::max(local_weight, 0.0f) / total);
    local = std::clamp(local, 0, n_layer);
    plan.local_layers = local;
    plan.n_layer = n_layer;

    ggml_backend_dev_t local_dev = nullptr;
#ifdef KULA_USE_GPU
    local_dev = localGpuDevice();
#endif
    if (local_dev) {
        plan.devices.push_back(local_dev);
        device_weights.push_back(std::max(local_weight, 0.0f));
        plan.n_gpu_layers = n_layer + 1;
    } else {
        plan.n_gpu_layers = n_layer + 1 - local;
    }
    plan.devices.push_back(nullptr);
    plan.split.assign(llama_max_devices(), 0.0f);
    for (size_t d = 0; d < device_weights.size() && d < plan.split.size(); d++) plan.split[d] = device_weights[d];

    ggml_backend_dev_t here = local_dev ? local_dev : ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (here) {
        plan.overrides[0] = {"^(output|token_embd)\\.weight$", ggml_backend_dev_buffer_type(here)};
        plan.overrides[1] = {nullptr, nullptr};
    }
    LOGI("cluster: %d of %d layers local, rest on %zu worker device(s)", local, n_layer, device_weights.size() - (local_dev ? 1 : 0));
    return {};
}

// --- llama.cpp log ----------------------------------------------------------------------

static ggml_log_level g_last_log_level = GGML_LOG_LEVEL_INFO;

static void kulaLog(ggml_log_level level, const char* text, void*) {
    if (!text) return;
    const ggml_log_level effective = level == GGML_LOG_LEVEL_CONT ? g_last_log_level : level;
    if (level != GGML_LOG_LEVEL_CONT) g_last_log_level = level;
    if (effective == GGML_LOG_LEVEL_DEBUG) return;
    g_sink(effective == GGML_LOG_LEVEL_ERROR ? LogLevel::Error : effective == GGML_LOG_LEVEL_WARN ? LogLevel::Warn : LogLevel::Info, text);

    std::lock_guard<std::mutex> lock(g_load_log_mutex);
    if (const char* at = std::strstr(text, " model buffer size = ")) {
        const char* colon = std::strchr(text, ':');
        const char* start = colon && colon < at ? colon + 1 : text;
        while (start < at && *start == ' ') start++;
        const double mib = std::strtod(at + std::strlen(" model buffer size = "), nullptr);
        g_load_buffers.append(start, at - start).append("\t").append(std::to_string(mib)).append("\n");
    }
    static const char kConnected[] = "RPC client connected: ";
    if (std::strncmp(text, kConnected, sizeof(kConnected) - 1) == 0) {
        g_worker_peer.assign(text + sizeof(kConnected) - 1);
        while (!g_worker_peer.empty() && std::isspace((unsigned char)g_worker_peer.back())) g_worker_peer.pop_back();
    } else if (std::strncmp(text, "RPC client disconnected", 23) == 0) {
        g_worker_peer.clear();
    }
    if (!g_capture_load_error) return;
    if (level == GGML_LOG_LEVEL_ERROR) g_load_error.assign(text);
    else if (level == GGML_LOG_LEVEL_CONT && !g_load_error.empty()) g_load_error.append(text);
    if (g_load_error.size() > 4096) g_load_error.erase(0, g_load_error.size() - 4096);
}

static std::string consumeLoadError() {
    std::lock_guard<std::mutex> lock(g_load_log_mutex);
    g_capture_load_error = false;
    while (!g_load_error.empty() && (g_load_error.back() == '\n' || g_load_error.back() == '\r')) g_load_error.pop_back();
    return g_load_error;
}

// --- utf-8 ------------------------------------------------------------------------------

static bool isValidUTF8(const char* str, size_t len) {
    const unsigned char* b = reinterpret_cast<const unsigned char*>(str);
    size_t i = 0;
    while (i < len) {
        unsigned char c = b[i];
        if ((c & 0x80) == 0) { i++; continue; }
        int n = (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 0;
        if (!n || i + n > len) return false;
        for (int j = 1; j < n; j++) if ((b[i + j] & 0xC0) != 0x80) return false;
        if (n == 2 && (c & 0x1E) == 0) return false;
        if (n == 3 && ((c == 0xED && (b[i + 1] & 0x20)) || (c == 0xE0 && !(b[i + 1] & 0x20)))) return false;
        if (n == 4 && (c > 0xF4 || (c == 0xF0 && !(b[i + 1] & 0x30)) || (c == 0xF4 && b[i + 1] > 0x8F))) return false;
        i += n;
    }
    return true;
}

// Token pieces can split a multi-byte character; keep the valid prefix and hold the rest
// for the next piece (g_pending), so JS never sees replacement characters mid-word.
static std::string g_pending;
static std::string takeValidUtf8(const std::string& in) {
    size_t good = in.size();
    // back up to the last complete sequence
    for (size_t back = 1; back <= 3 && back <= in.size(); back++) {
        if (isValidUTF8(in.data(), in.size() - back + 1) && isValidUTF8(in.data(), in.size())) { good = in.size(); break; }
        if (isValidUTF8(in.data(), in.size() - back)) { good = in.size() - back; break; }
    }
    if (!isValidUTF8(in.data(), good)) return {};
    return in.substr(0, good);
}

// --- backends, info ---------------------------------------------------------------------

bool initBackends(const std::string& lib_dir) {
    std::lock_guard<std::mutex> lock(g_backend_mutex);
    if (g_lib_dir.empty()) g_lib_dir = lib_dir;
    llama_log_set(kulaLog, nullptr);
    loadCpuBackendLocked();
    return g_cpu_backend_loaded;
}

bool ggufMeta(const std::string& path, std::string& out) {
    gguf_init_params params = {true, nullptr};
    gguf_context* gguf = gguf_init_from_file(path.c_str(), params);
    if (!gguf) return false;
    out.clear();
    auto put = [&](const char* name, const std::string& v) { out.append(name).append("\t").append(v).append("\n"); };
    const int64_t arch_id = gguf_find_key(gguf, "general.architecture");
    std::string arch = arch_id >= 0 ? gguf_get_val_str(gguf, arch_id) : "";
    put("arch", arch);
    auto num = [&](const char* suffix, const char* name) {
        const int64_t id = gguf_find_key(gguf, (arch + "." + suffix).c_str());
        if (id < 0) return;
        switch (gguf_get_kv_type(gguf, id)) {
            case GGUF_TYPE_UINT32: put(name, std::to_string(gguf_get_val_u32(gguf, id))); break;
            case GGUF_TYPE_INT32: put(name, std::to_string(gguf_get_val_i32(gguf, id))); break;
            case GGUF_TYPE_UINT64: put(name, std::to_string(gguf_get_val_u64(gguf, id))); break;
            default: break;
        }
    };
    num("block_count", "layers");
    num("context_length", "ctx");
    num("embedding_length", "embd");
    num("attention.head_count", "heads");
    num("attention.head_count_kv", "heads_kv");
    num("attention.key_length", "key_len");
    num("attention.value_length", "value_len");
    for (const char* k : {"general.name", "general.license", "general.size_label", "general.file_type"}) {
        const int64_t id = gguf_find_key(gguf, k);
        if (id < 0) continue;
        if (gguf_get_kv_type(gguf, id) == GGUF_TYPE_STRING) put(k + 8, gguf_get_val_str(gguf, id));
        else if (gguf_get_kv_type(gguf, id) == GGUF_TYPE_UINT32) put(k + 8, std::to_string(gguf_get_val_u32(gguf, id)));
    }
    put("template", gguf_find_key(gguf, "tokenizer.chat_template") >= 0 ? "1" : "0");
    gguf_free(gguf);
    return true;
}

// --- load / free --------------------------------------------------------------------------

bool loadModel(const std::string& model_path, int n_threads, int ctx_size, const std::vector<std::string>& eps,
               const std::vector<float>& ws, float local_weight, LoadResult& out, std::string& err) {
    if (model_path.empty()) { err = "model path is missing"; return false; }
    {
        std::ifstream f(model_path, std::ios::binary);
        char magic[4] = {};
        if (!f || !f.read(magic, 4) || std::memcmp(magic, "GGUF", 4) != 0) {
            err = "not a GGUF file (incomplete download?)";
            return false;
        }
    }
    { std::lock_guard<std::mutex> lock(g_backend_mutex); loadCpuBackendLocked(); }

    llama_model_params mp = llama_model_default_params();
#ifdef KULA_USE_GPU
    // every device linked in (Metal, then CPU); all layers on the GPU, unified memory
    mp.devices = nullptr;
    mp.n_gpu_layers = localGpuDevice() ? 999 : 0;
#else
    static ggml_backend_dev_t no_devices[] = {nullptr};
    mp.devices = no_devices;  // CPU only: never a GPU, never an RPC device by accident
    mp.n_gpu_layers = 0;
#endif

    ClusterPlan plan;
    const bool has_cluster = !eps.empty();
    if (has_cluster) {
        const std::string e = planCluster(model_path.c_str(), eps, ws, local_weight, plan);
        if (!e.empty()) { err = "cluster: " + e; return false; }
        mp.devices = plan.devices.data();
        mp.tensor_split = plan.split.data();
        mp.n_gpu_layers = plan.n_gpu_layers;
        if (plan.overrides[0].pattern) mp.tensor_buft_overrides = plan.overrides;
    }

    llama_log_set(kulaLog, nullptr);
    {
        std::lock_guard<std::mutex> lock(g_load_log_mutex);
        g_load_error.clear();
        g_load_buffers.clear();
        g_capture_load_error = true;
    }
    g_model = llama_model_load_from_file(model_path.c_str(), mp);
    if (!g_model) {
        const std::string detail = consumeLoadError();
        err = detail.empty() ? "could not load the model (RAM?)" : "could not load the model: " + detail;
        return false;
    }
    consumeLoadError();

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = ctx_size;
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    cp.n_batch = 512;
    cp.op_offload = false;  // never push ops over Wi-Fi
    g_ctx = llama_init_from_model(g_model, cp);
    if (!g_ctx) {
        llama_model_free(g_model);
        g_model = nullptr;
        err = "could not create the context (RAM for the context size?)";
        return false;
    }
    g_vocab = llama_model_get_vocab(g_model);
    g_n_past = 0;
    g_cached_tokens.clear();
    g_pending.clear();
    out.layers = has_cluster ? plan.n_layer : llama_model_n_layer(g_model);
    out.local_layers = has_cluster ? plan.local_layers : out.layers;
    out.n_ctx = (int)llama_n_ctx(g_ctx);
    LOGI("model loaded: %d\t%d\t%d", out.local_layers, out.layers, out.n_ctx);
    return true;
}

void freeModel() {
    g_stop_flag = true;
    while (g_generating) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    if (g_sampler) { llama_sampler_free(g_sampler); g_sampler = nullptr; }
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_vocab = nullptr;
    g_n_past = 0;
    g_cached_tokens.clear();
    LOGI("model freed");
}

bool isLoaded() { return g_model && g_ctx; }

// --- chat template ------------------------------------------------------------------------

bool applyTemplate(const std::vector<std::string>& r, const std::vector<std::string>& c, std::string& out, std::string& err) {
    if (!g_model) { err = "no model loaded"; return false; }
    const size_t n = std::min(r.size(), c.size());
    std::vector<llama_chat_message> msgs(n);
    for (size_t i = 0; i < n; i++) msgs[i] = {r[i].c_str(), c[i].c_str()};
    const char* tmpl = llama_model_chat_template(g_model, nullptr);
    if (!tmpl) tmpl = "chatml";
    std::vector<char> buf(4096);
    int32_t len = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), buf.size());
    if (len < 0) {
        // template llama.cpp can't render: fall back to chatml
        len = llama_chat_apply_template("chatml", msgs.data(), msgs.size(), true, buf.data(), buf.size());
    }
    if (len > (int32_t)buf.size()) {
        buf.resize(len + 1);
        len = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), buf.size());
        if (len < 0) len = llama_chat_apply_template("chatml", msgs.data(), msgs.size(), true, buf.data(), buf.size());
    }
    if (len < 0) { err = "could not apply the chat template"; return false; }
    out.assign(buf.data(), len);
    return true;
}

// --- generate -----------------------------------------------------------------------------

int generate(const std::string& prompt, int max_tokens, float temperature, float top_p, int top_k, float min_p,
             float repeat_penalty, int seed, TokenCallback cb, void* user, std::string& err) {
    if (!g_model || !g_ctx || !g_vocab) { err = "no model loaded"; return -2; }
    if (g_generating.exchange(true)) { err = "already generating"; return -2; }
    struct Done { ~Done() { g_generating = false; } } done;
    g_stop_flag = false;

    const int n_prompt = -llama_tokenize(g_vocab, prompt.c_str(), prompt.size(), nullptr, 0, true, true);
    if (n_prompt <= 0) { err = "could not tokenize the prompt"; return -2; }
    std::vector<llama_token> tokens(n_prompt);
    const int actual = llama_tokenize(g_vocab, prompt.c_str(), prompt.size(), tokens.data(), tokens.size(), true, true);
    if (actual < 0) { err = "could not tokenize the prompt"; return -2; }
    tokens.resize(actual);

    const int n_ctx = llama_n_ctx(g_ctx);
    const int reserve = std::min(std::max(max_tokens, 64), n_ctx / 2);
    const int budget = n_ctx - reserve;
    if ((int)tokens.size() > budget) {
        const int head = std::min(256, budget / 4);
        std::vector<llama_token> trimmed(tokens.begin(), tokens.begin() + head);
        trimmed.insert(trimmed.end(), tokens.end() - (budget - head), tokens.end());
        LOGI("prompt of %zu tokens trimmed to %d (ctx %d)", tokens.size(), budget, n_ctx);
        tokens.swap(trimmed);
    }

    size_t n_keep = 0;
    while (n_keep < g_cached_tokens.size() && n_keep < tokens.size() && g_cached_tokens[n_keep] == tokens[n_keep]) n_keep++;
    if (n_keep >= tokens.size()) n_keep = tokens.size() - 1;
    llama_memory_seq_rm(llama_get_memory(g_ctx), 0, (llama_pos)n_keep, -1);
    g_cached_tokens.resize(n_keep);
    g_n_past = (int)n_keep;
    LOGI("prompt: %zu tokens, %zu reused", tokens.size(), n_keep);

    llama_batch batch = llama_batch_init(512, 0, 1);
    int processed = (int)n_keep;
    while (processed < (int)tokens.size()) {
        if (g_stop_flag) { llama_batch_free(batch); g_cached_tokens.clear(); llama_memory_seq_rm(llama_get_memory(g_ctx), 0, 0, -1); g_n_past = 0; return -1; }
        batch.n_tokens = 0;
        const int size = std::min((int)tokens.size() - processed, 512);
        for (int i = 0; i < size; i++) {
            batch.token[batch.n_tokens] = tokens[processed + i];
            batch.pos[batch.n_tokens] = processed + i;
            batch.n_seq_id[batch.n_tokens] = 1;
            batch.seq_id[batch.n_tokens][0] = 0;
            batch.logits[batch.n_tokens] = (processed + i == (int)tokens.size() - 1);
            batch.n_tokens++;
        }
        if (llama_decode(g_ctx, batch) != 0) {
            llama_batch_free(batch);
            err = "decode failed on the prompt (context full?)";
            return -2;
        }
        processed += size;
    }
    g_n_past = (int)tokens.size();
    g_cached_tokens = tokens;

    if (g_sampler) llama_sampler_free(g_sampler);
    const uint32_t s = seed >= 0 ? (uint32_t)seed : (uint32_t)time(nullptr);
    g_sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    if (repeat_penalty != 1.0f) llama_sampler_chain_add(g_sampler, llama_sampler_init_penalties(llama_vocab_n_tokens(g_vocab), 64, repeat_penalty, 0.0f, 0.0f));
    if (top_k > 0) llama_sampler_chain_add(g_sampler, llama_sampler_init_top_k(top_k));
    if (top_p < 1.0f) llama_sampler_chain_add(g_sampler, llama_sampler_init_top_p(top_p, 1));
    if (min_p > 0.0f && min_p < 1.0f) llama_sampler_chain_add(g_sampler, llama_sampler_init_min_p(min_p, 1));
    llama_sampler_chain_add(g_sampler, llama_sampler_init_temp(temperature));
    llama_sampler_chain_add(g_sampler, llama_sampler_init_dist(s));

    g_pending.clear();
    int generated = 0;
    for (int i = 0; i < max_tokens && !g_stop_flag; i++) {
        const llama_token id = llama_sampler_sample(g_sampler, g_ctx, -1);
        if (llama_vocab_is_eog(g_vocab, id)) break;
        char buf[256];
        const int32_t len = llama_token_to_piece(g_vocab, id, buf, sizeof(buf), 0, true);
        if (len > 0) {
            g_pending.append(buf, len);
            std::string ok = takeValidUtf8(g_pending);
            if (!ok.empty() || g_pending.size() > 8) {
                if (ok.empty()) ok = "\xEF\xBF\xBD";
                g_pending.erase(0, std::min(ok.size(), g_pending.size()));
                if (cb) cb(ok.c_str(), user);
            }
        }
        batch.n_tokens = 0;
        batch.token[0] = id;
        batch.pos[0] = g_n_past;
        batch.n_seq_id[0] = 1;
        batch.seq_id[0][0] = 0;
        batch.logits[0] = true;
        batch.n_tokens = 1;
        if (llama_decode(g_ctx, batch) != 0) { LOGE("decode failed after token %d", i + 1); break; }
        g_n_past++;
        g_cached_tokens.push_back(id);
        generated++;
    }
    llama_batch_free(batch);
    return generated;
}

void stop() { g_stop_flag = true; }
int tokensUsed() { return g_n_past; }
int contextSize() { return g_ctx ? (int)llama_n_ctx(g_ctx) : 0; }
void clearContext() {
    if (!g_ctx) return;
    llama_memory_seq_rm(llama_get_memory(g_ctx), 0, 0, -1);
    g_n_past = 0;
    g_cached_tokens.clear();
}

// --- cluster ---------------------------------------------------------------------------------

std::string lastLoadBuffers() {
    std::lock_guard<std::mutex> lock(g_load_log_mutex);
    return g_load_buffers;
}

std::string workerPeer() {
    std::lock_guard<std::mutex> lock(g_load_log_mutex);
    return g_worker_peer;
}

// Memory read speed in GB/s: token generation streams the weights from RAM, so this ranks
// devices better than core counts. ~0.2 s.
double memBandwidth(int threads) {
    const int n = std::max(1, threads);
    const size_t per_thread = (64u << 20) / sizeof(uint64_t) / n;
    std::vector<uint64_t> data(per_thread * n, 1);
    std::vector<uint64_t> sums(n, 0);
    const int passes = 4;
    auto run = [&](int t) {
        const uint64_t* p = data.data() + per_thread * t;
        uint64_t a = 0, b = 0, c = 0, d = 0;
        for (int pass = 0; pass < passes; pass++)
            for (size_t i = 0; i + 4 <= per_thread; i += 4) { a += p[i]; b += p[i + 1]; c += p[i + 2]; d += p[i + 3]; }
        sums[t] = a + b + c + d;
    };
    run(0);
    const auto start = std::chrono::steady_clock::now();
    std::vector<std::thread> pool;
    for (int t = 0; t < n; t++) pool.emplace_back(run, t);
    for (auto& th : pool) th.join();
    const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    const double bytes = (double)data.size() * sizeof(uint64_t) * passes;
    return secs > 0 ? bytes / secs / 1e9 : 0.0;
}

// Keeps the Wi-Fi radio out of power save while a master is connected: one tiny UDP
// datagram to the master's discard port every 20 ms (~50 B/s).
static std::atomic<bool> g_worker_running{false};
static void radioKeepAwake() {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return;
    const char byte = 0;
    while (g_worker_running) {
        std::string ip;
        { std::lock_guard<std::mutex> lock(g_load_log_mutex); ip = g_worker_peer; }
        if (ip.empty()) { std::this_thread::sleep_for(std::chrono::milliseconds(200)); continue; }
        sockaddr_in to = {};
        to.sin_family = AF_INET;
        to.sin_port = htons(9);
        if (inet_pton(AF_INET, ip.c_str(), &to.sin_addr) == 1) sendto(fd, &byte, 1, 0, (const sockaddr*)&to, sizeof(to));
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    close(fd);
}

std::string serve(const std::string& lib_dir, const std::string& ep, const std::string& cache, int n_threads) {
    ggml_backend_reg_t rpc;
    ggml_backend_dev_t cpu;
    {
        std::lock_guard<std::mutex> lock(g_backend_mutex);
        if (g_lib_dir.empty()) g_lib_dir = lib_dir;
        llama_log_set(kulaLog, nullptr);
        loadCpuBackendLocked();
        rpc = loadRpcBackendLocked();
        cpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    }
    if (!rpc) return "this build has no cluster (RPC) support";
    if (!cpu) return "no CPU backend";
    using start_fn = void (*)(const char*, const char*, size_t, size_t, ggml_backend_dev_t*);
    auto start = reinterpret_cast<start_fn>(ggml_backend_reg_get_proc_address(rpc, "ggml_backend_rpc_start_server"));
    if (!start) return "RPC backend is missing its server";
    // the worker serves its CPU on every platform: a Metal device over RPC would make the
    // master's split depend on the worker's GPU memory, which iOS reports unreliably
    ggml_backend_dev_t served = cpu;
    LOGI("worker listening on %s", ep.c_str());
    g_worker_running = true;
    std::thread(radioKeepAwake).detach();
    start(ep.c_str(), cache.empty() ? nullptr : cache.c_str(), (size_t)std::max(1, n_threads), 1, &served);
    g_worker_running = false;
    return "worker stopped: is the port already in use?";
}

}  // namespace kula
