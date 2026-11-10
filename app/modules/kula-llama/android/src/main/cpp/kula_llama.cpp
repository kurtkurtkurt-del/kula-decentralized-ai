// kula-llama: llama.cpp on the phone, and the phone cluster (ggml's RPC backend).
//
// Ported from PrivateLM's llama_flutter_android jni_wrapper.cpp (MIT, dragneel2074 /
// orailnoor / techjarves) on 4.11.2026, without Vulkan and the Flutter plumbing. mtmd
// (llama.cpp's multimodal library) came back on 10.11.2026 for photos in night projects: a
// vision model's mmproj is loaded next to the text model and a prompt can carry images.
// Bound to expo.modules.kulallama.Native with RegisterNatives, so the package name
// lives in one place (kNatives, bottom of this file).
//
// Backends are separate .so files loaded at runtime from the app's native library dir
// (GGML_BACKEND_DL): one CPU build per Arm generation, the fastest the phone supports is
// picked, and libggml-rpc.so for the cluster.
#include <jni.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <android/log.h>
#include <arpa/inet.h>
#include <dlfcn.h>
#include <netinet/in.h>
#include <setjmp.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>
#include "llama.h"
#include "ggml-backend.h"
#include "gguf.h"
#include "mtmd.h"
#include "mtmd-helper.h"

#define LOG_TAG "kula-llama"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

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
// The vision side of the loaded model (its mmproj), or null: a text-only model, or none asked for.
static mtmd_context* g_mtmd = nullptr;

static void kulaLog(ggml_log_level level, const char* text, void*);

static std::string jstr(JNIEnv* env, jstring value) {
    if (!value) return {};
    const char* chars = env->GetStringUTFChars(value, nullptr);
    if (!chars) return {};
    std::string out(chars);
    env->ReleaseStringUTFChars(value, chars);
    return out;
}

static void throwRuntime(JNIEnv* env, const std::string& message) {
    LOGE("%s", message.c_str());
    env->ThrowNew(env->FindClass("java/lang/RuntimeException"), message.c_str());
}

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
static void loadCpuBackendLocked() { g_cpu_backend_loaded = true; }
static ggml_backend_reg_t loadRpcBackendLocked() { return ggml_backend_reg_by_name("RPC"); }
#endif

// --- cluster plan -----------------------------------------------------------------------

static std::vector<std::string> g_registered_endpoints;

// ggml's rpc protocol has no authentication and can write this process's memory: the
// server is only ever bound to 127.0.0.1 and a client only ever dials 127.0.0.1 (the
// gate's tunnel). Anything else is refused here too, whatever the Kotlin side passed.
static bool isLoopbackEndpoint(const std::string& ep) {
    const std::string prefix = "127.0.0.1:";
    if (ep.compare(0, prefix.size(), prefix) != 0) return false;
    const std::string port = ep.substr(prefix.size());
    if (port.empty() || port.size() > 5) return false;
    for (char c : port) if (c < '0' || c > '9') return false;
    const int n = std::atoi(port.c_str());
    return n >= 1 && n <= 65535;
}

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
        if (!isLoopbackEndpoint(endpoints[i])) return "worker endpoint " + endpoints[i] + " is not on 127.0.0.1";
    }
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
    plan.devices.push_back(nullptr);
    plan.split.assign(llama_max_devices(), 0.0f);
    for (size_t d = 0; d < device_weights.size() && d < plan.split.size(); d++) plan.split[d] = device_weights[d];

    const float total = std::max(local_weight, 0.0f) + remote_weight;
    int local = (int)std::lround(n_layer * std::max(local_weight, 0.0f) / total);
    local = std::clamp(local, 0, n_layer);
    plan.n_gpu_layers = n_layer + 1 - local;
    plan.local_layers = local;
    plan.n_layer = n_layer;
    ggml_backend_dev_t cpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (cpu) {
        plan.overrides[0] = {"^(output|token_embd)\\.weight$", ggml_backend_dev_buffer_type(cpu)};
        plan.overrides[1] = {nullptr, nullptr};
    }
    LOGI("cluster: %d of %d layers local, rest on %zu worker device(s)", local, n_layer, device_weights.size());
    return {};
}

// --- logging ----------------------------------------------------------------------------

static ggml_log_level g_last_log_level = GGML_LOG_LEVEL_INFO;

static void kulaLog(ggml_log_level level, const char* text, void*) {
    if (!text) return;
    const ggml_log_level effective = level == GGML_LOG_LEVEL_CONT ? g_last_log_level : level;
    if (level != GGML_LOG_LEVEL_CONT) g_last_log_level = level;
    if (effective == GGML_LOG_LEVEL_DEBUG) return;
    __android_log_write(effective == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR
                        : effective == GGML_LOG_LEVEL_WARN ? ANDROID_LOG_WARN : ANDROID_LOG_INFO, LOG_TAG, text);

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

// --- jni: backends, info ----------------------------------------------------------------

static jboolean nInitBackends(JNIEnv* env, jclass, jstring lib_dir) {
    std::lock_guard<std::mutex> lock(g_backend_mutex);
    if (g_lib_dir.empty()) g_lib_dir = jstr(env, lib_dir);
    llama_log_set(kulaLog, nullptr);
    loadCpuBackendLocked();
    return g_cpu_backend_loaded ? JNI_TRUE : JNI_FALSE;
}

// "key\tvalue\n" lines of the GGUF header kula needs for the fit estimate and the template.
static jstring nGgufMeta(JNIEnv* env, jclass, jstring jpath) {
    const std::string path = jstr(env, jpath);
    gguf_init_params params = {true, nullptr};
    gguf_context* gguf = gguf_init_from_file(path.c_str(), params);
    if (!gguf) return nullptr;
    std::string out;
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
    return env->NewStringUTF(out.c_str());
}

// --- jni: load / free --------------------------------------------------------------------

// Returns "<local layers>\t<total layers>\t<n_ctx>" or throws.
static jstring nLoadModel(JNIEnv* env, jclass, jstring jpath, jint n_threads, jint ctx_size,
                          jobjectArray endpoints, jfloatArray weights, jfloat local_weight) {
    const std::string model_path = jstr(env, jpath);
    if (model_path.empty()) { throwRuntime(env, "model path is missing"); return nullptr; }
    {
        std::ifstream f(model_path, std::ios::binary);
        char magic[4] = {};
        if (!f || !f.read(magic, 4) || std::memcmp(magic, "GGUF", 4) != 0) {
            throwRuntime(env, "not a GGUF file (incomplete download?)");
            return nullptr;
        }
    }
    { std::lock_guard<std::mutex> lock(g_backend_mutex); loadCpuBackendLocked(); }

    llama_model_params mp = llama_model_default_params();
    static ggml_backend_dev_t no_devices[] = {nullptr};
    mp.devices = no_devices;  // CPU only: never a GPU, never an RPC device by accident
    mp.n_gpu_layers = 0;

    std::vector<std::string> eps;
    std::vector<float> ws;
    const jsize n_ep = endpoints ? env->GetArrayLength(endpoints) : 0;
    for (jsize i = 0; i < n_ep; i++) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(endpoints, i));
        eps.push_back(jstr(env, item));
        env->DeleteLocalRef(item);
    }
    if (weights) {
        const jsize n = env->GetArrayLength(weights);
        ws.resize(n);
        env->GetFloatArrayRegion(weights, 0, n, ws.data());
    }
    ClusterPlan plan;
    const bool has_cluster = !eps.empty();
    if (has_cluster) {
        const std::string err = planCluster(model_path.c_str(), eps, ws, local_weight, plan);
        if (!err.empty()) { throwRuntime(env, "cluster: " + err); return nullptr; }
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
        throwRuntime(env, detail.empty() ? "could not load the model (RAM?)" : "could not load the model: " + detail);
        return nullptr;
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
        throwRuntime(env, "could not create the context (RAM for the context size?)");
        return nullptr;
    }
    g_vocab = llama_model_get_vocab(g_model);
    g_n_past = 0;
    g_cached_tokens.clear();
    g_pending.clear();
    const int layers = has_cluster ? plan.n_layer : llama_model_n_layer(g_model);
    const int local = has_cluster ? plan.local_layers : layers;
    const std::string out = std::to_string(local) + "\t" + std::to_string(layers) + "\t" + std::to_string(llama_n_ctx(g_ctx));
    LOGI("model loaded: %s", out.c_str());
    return env->NewStringUTF(out.c_str());
}

static void nFreeModel(JNIEnv*, jclass) {
    g_stop_flag = true;
    while (g_generating) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    if (g_sampler) { llama_sampler_free(g_sampler); g_sampler = nullptr; }
    if (g_mtmd) { mtmd_free(g_mtmd); g_mtmd = nullptr; }
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_vocab = nullptr;
    g_n_past = 0;
    g_cached_tokens.clear();
    LOGI("model freed");
}

static jboolean nIsLoaded(JNIEnv*, jclass) { return g_model && g_ctx ? JNI_TRUE : JNI_FALSE; }

// --- jni: chat template -------------------------------------------------------------------

// Applies the model's own chat template (or ChatML when it has none) to roles/contents and
// appends the assistant prefix.
static jstring nApplyTemplate(JNIEnv* env, jclass, jobjectArray roles, jobjectArray contents) {
    if (!g_model) { throwRuntime(env, "no model loaded"); return nullptr; }
    const jsize n = env->GetArrayLength(roles);
    std::vector<std::string> r(n), c(n);
    std::vector<llama_chat_message> msgs(n);
    for (jsize i = 0; i < n; i++) {
        auto jr = static_cast<jstring>(env->GetObjectArrayElement(roles, i));
        auto jc = static_cast<jstring>(env->GetObjectArrayElement(contents, i));
        r[i] = jstr(env, jr);
        c[i] = jstr(env, jc);
        env->DeleteLocalRef(jr);
        env->DeleteLocalRef(jc);
        msgs[i] = {r[i].c_str(), c[i].c_str()};
    }
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
    if (len < 0) { throwRuntime(env, "could not apply the chat template"); return nullptr; }
    return env->NewStringUTF(std::string(buf.data(), len).c_str());
}

// --- jni: generate --------------------------------------------------------------------------

static jint sampleReply(JNIEnv* env, jint max_tokens, jfloat temperature, jfloat top_p, jint top_k, jfloat min_p,
                        jfloat repeat_penalty, jint seed, jobject cb, bool track);

// Streams pieces to cb.invoke(String). Returns the number of generated tokens, or -1 when
// stopped before the first token. Blocks; call it off the main thread.
static jint nGenerate(JNIEnv* env, jclass, jstring jprompt, jint max_tokens, jfloat temperature,
                      jfloat top_p, jint top_k, jfloat min_p, jfloat repeat_penalty, jint seed, jobject cb) {
    if (!g_model || !g_ctx || !g_vocab) { throwRuntime(env, "no model loaded"); return -1; }
    if (g_generating.exchange(true)) { throwRuntime(env, "already generating"); return -1; }
    struct Done { ~Done() { g_generating = false; } } done;
    g_stop_flag = false;

    const std::string prompt = jstr(env, jprompt);
    const int n_prompt = -llama_tokenize(g_vocab, prompt.c_str(), prompt.size(), nullptr, 0, true, true);
    if (n_prompt <= 0) { throwRuntime(env, "could not tokenize the prompt"); return -1; }
    std::vector<llama_token> tokens(n_prompt);
    const int actual = llama_tokenize(g_vocab, prompt.c_str(), prompt.size(), tokens.data(), tokens.size(), true, true);
    if (actual < 0) { throwRuntime(env, "could not tokenize the prompt"); return -1; }
    tokens.resize(actual);

    const int n_ctx = llama_n_ctx(g_ctx);
    const int reserve = std::min(std::max((int)max_tokens, 64), n_ctx / 2);
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
            throwRuntime(env, "decode failed on the prompt (context full?)");
            return -1;
        }
        processed += size;
    }
    llama_batch_free(batch);
    g_n_past = (int)tokens.size();
    g_cached_tokens = tokens;
    return sampleReply(env, max_tokens, temperature, top_p, top_k, min_p, repeat_penalty, seed, cb, true);
}

// The reply after a decoded prompt (g_n_past is where it ends): sample, stream each valid
// utf-8 piece to cb.invoke(String), decode, until max_tokens, an end token or stop().
// track: the tokens go into g_cached_tokens (a text prompt, so the next turn can reuse the
// prefix); a prompt with images is not a token list and is never reused.
static jint sampleReply(JNIEnv* env, jint max_tokens, jfloat temperature, jfloat top_p, jint top_k, jfloat min_p,
                        jfloat repeat_penalty, jint seed, jobject cb, bool track) {
    llama_batch batch = llama_batch_init(1, 0, 1);
    if (g_sampler) llama_sampler_free(g_sampler);
    const uint32_t s = seed >= 0 ? (uint32_t)seed : (uint32_t)time(nullptr);
    g_sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    if (repeat_penalty != 1.0f) llama_sampler_chain_add(g_sampler, llama_sampler_init_penalties(llama_vocab_n_tokens(g_vocab), 64, repeat_penalty, 0.0f, 0.0f));
    if (top_k > 0) llama_sampler_chain_add(g_sampler, llama_sampler_init_top_k(top_k));
    if (top_p < 1.0f) llama_sampler_chain_add(g_sampler, llama_sampler_init_top_p(top_p, 1));
    if (min_p > 0.0f && min_p < 1.0f) llama_sampler_chain_add(g_sampler, llama_sampler_init_min_p(min_p, 1));
    llama_sampler_chain_add(g_sampler, llama_sampler_init_temp(temperature));
    llama_sampler_chain_add(g_sampler, llama_sampler_init_dist(s));

    jclass cbClass = env->GetObjectClass(cb);
    jmethodID invoke = env->GetMethodID(cbClass, "invoke", "(Ljava/lang/Object;)Ljava/lang/Object;");
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
                jstring js = env->NewStringUTF(ok.c_str());
                env->CallObjectMethod(cb, invoke, js);
                env->DeleteLocalRef(js);
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
        if (track) g_cached_tokens.push_back(id);
        generated++;
    }
    llama_batch_free(batch);
    env->DeleteLocalRef(cbClass);
    return generated;
}

static void nStop(JNIEnv*, jclass) { g_stop_flag = true; }
static jint nTokensUsed(JNIEnv*, jclass) { return g_n_past; }
static jint nContextSize(JNIEnv*, jclass) { return g_ctx ? llama_n_ctx(g_ctx) : 0; }
static void nClearContext(JNIEnv*, jclass) {
    if (!g_ctx) return;
    llama_memory_seq_rm(llama_get_memory(g_ctx), 0, 0, -1);
    g_n_past = 0;
    g_cached_tokens.clear();
}

// --- jni: vision (mtmd) -------------------------------------------------------------------

// Loads a vision model's mmproj next to the loaded text model (they must belong together:
// mtmd checks the projector's width against the model's). Throws with the reason.
static void nLoadMmproj(JNIEnv* env, jclass, jstring jpath, jint n_threads) {
    if (!g_model || !g_ctx) { throwRuntime(env, "load the model before its mmproj"); return; }
    if (g_generating) { throwRuntime(env, "already generating"); return; }
    const std::string path = jstr(env, jpath);
    {
        std::ifstream f(path, std::ios::binary);
        char magic[4] = {};
        if (!f || !f.read(magic, 4) || std::memcmp(magic, "GGUF", 4) != 0) {
            throwRuntime(env, "the mmproj is not a GGUF file (incomplete download?)");
            return;
        }
    }
    if (g_mtmd) { mtmd_free(g_mtmd); g_mtmd = nullptr; }
    mtmd_helper_log_set(kulaLog, nullptr);
    mtmd_context_params mp = mtmd_context_params_default();
    mp.use_gpu = false;          // CPU only, as the text model
    mp.print_timings = false;
    mp.n_threads = std::max(1, (int)n_threads);
    mp.warmup = false;           // the first photo pays for it; loading stays quick
    {
        std::lock_guard<std::mutex> lock(g_load_log_mutex);
        g_load_error.clear();
        g_capture_load_error = true;
    }
    g_mtmd = mtmd_init_from_file(path.c_str(), g_model, mp);
    const std::string detail = consumeLoadError();
    if (!g_mtmd) { throwRuntime(env, detail.empty() ? "could not load the mmproj" : "could not load the mmproj: " + detail); return; }
    if (!mtmd_support_vision(g_mtmd)) {
        mtmd_free(g_mtmd);
        g_mtmd = nullptr;
        throwRuntime(env, "this mmproj has no vision encoder");
        return;
    }
    LOGI("mmproj loaded: vision on");
}

static void nFreeMmproj(JNIEnv*, jclass) {
    g_stop_flag = true;
    while (g_generating) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    if (g_mtmd) { mtmd_free(g_mtmd); g_mtmd = nullptr; }
}

static jboolean nHasVision(JNIEnv*, jclass) { return g_mtmd ? JNI_TRUE : JNI_FALSE; }

// The text that stands for one image in a prompt; the prompt carries one per image, in order.
static jstring nMediaMarker(JNIEnv* env, jclass) { return env->NewStringUTF(mtmd_default_marker()); }

// A templated prompt with one marker per image; images are packed RGB (w * h * 3 bytes each).
// The mmproj encodes the images, the prompt and the image embeddings are decoded from an
// empty cache, then the reply streams as in nGenerate. Returns generated tokens, -1 when
// stopped before the first. Blocks; call it off the main thread.
static jint nGenerateImages(JNIEnv* env, jclass, jstring jprompt, jobjectArray images, jintArray widths, jintArray heights,
                            jint max_tokens, jfloat temperature, jfloat top_p, jint top_k, jfloat min_p,
                            jfloat repeat_penalty, jint seed, jobject cb) {
    if (!g_model || !g_ctx || !g_vocab) { throwRuntime(env, "no model loaded"); return -1; }
    if (!g_mtmd) { throwRuntime(env, "no mmproj loaded: this model cannot see images"); return -1; }
    if (g_generating.exchange(true)) { throwRuntime(env, "already generating"); return -1; }
    struct Done { ~Done() { g_generating = false; } } done;
    g_stop_flag = false;

    const jsize n = images ? env->GetArrayLength(images) : 0;
    if (!widths || !heights || env->GetArrayLength(widths) != n || env->GetArrayLength(heights) != n) {
        throwRuntime(env, "images, widths and heights differ in length");
        return -1;
    }
    std::vector<jint> ws(n), hs(n);
    if (n > 0) {
        env->GetIntArrayRegion(widths, 0, n, ws.data());
        env->GetIntArrayRegion(heights, 0, n, hs.data());
    }
    std::vector<mtmd::bitmap> bitmaps;
    for (jsize i = 0; i < n; i++) {
        auto arr = static_cast<jbyteArray>(env->GetObjectArrayElement(images, i));
        const jsize len = arr ? env->GetArrayLength(arr) : 0;
        if (ws[i] <= 0 || hs[i] <= 0 || (int64_t)len != (int64_t)ws[i] * hs[i] * 3) {
            if (arr) env->DeleteLocalRef(arr);
            throwRuntime(env, "image " + std::to_string(i + 1) + " is not w*h*3 RGB bytes");
            return -1;
        }
        jbyte* bytes = env->GetByteArrayElements(arr, nullptr);
        bitmaps.emplace_back((uint32_t)ws[i], (uint32_t)hs[i], reinterpret_cast<const unsigned char*>(bytes));  // copies
        env->ReleaseByteArrayElements(arr, bytes, JNI_ABORT);
        env->DeleteLocalRef(arr);
        if (!bitmaps.back().ptr) { throwRuntime(env, "could not take image " + std::to_string(i + 1)); return -1; }
    }
    std::vector<const mtmd_bitmap*> ptrs;
    for (auto& b : bitmaps) ptrs.push_back(b.ptr.get());

    const std::string prompt = jstr(env, jprompt);
    mtmd_input_text text = {prompt.c_str(), prompt.size(), /* add_special */ true, /* parse_special */ true};
    mtmd::input_chunks chunks(mtmd_input_chunks_init());
    const int32_t tok = mtmd_tokenize(g_mtmd, chunks.ptr.get(), &text, ptrs.data(), ptrs.size());
    if (tok != 0) {
        throwRuntime(env, tok == 1 ? "the prompt's image markers do not match the images" : "could not prepare the images");
        return -1;
    }
    const int n_ctx = llama_n_ctx(g_ctx);
    const size_t n_tokens = mtmd_helper_get_n_tokens(chunks.ptr.get());
    const int reserve = std::min(std::max((int)max_tokens, 64), n_ctx / 2);
    if ((int)n_tokens > n_ctx - reserve) {
        throwRuntime(env, "the photos and the text need " + std::to_string(n_tokens) + " tokens, the context leaves " + std::to_string(n_ctx - reserve));
        return -1;
    }

    // an image prompt is never a prefix of anything cached: start from an empty cache
    llama_memory_seq_rm(llama_get_memory(g_ctx), 0, 0, -1);
    g_cached_tokens.clear();
    g_n_past = 0;
    LOGI("prompt with %d image(s): %zu tokens", (int)n, n_tokens);
    llama_pos new_n_past = 0;
    if (mtmd_helper_eval_chunks(g_mtmd, g_ctx, chunks.ptr.get(), 0, 0, 512, true, &new_n_past) != 0) {
        llama_memory_seq_rm(llama_get_memory(g_ctx), 0, 0, -1);
        throwRuntime(env, "could not read the photos (encode or decode failed; RAM?)");
        return -1;
    }
    if (g_stop_flag) { llama_memory_seq_rm(llama_get_memory(g_ctx), 0, 0, -1); return -1; }
    g_n_past = (int)new_n_past;
    const jint out = sampleReply(env, max_tokens, temperature, top_p, top_k, min_p, repeat_penalty, seed, cb, false);
    // the cache holds image embeddings now: the next text prompt must not reuse any of it
    llama_memory_seq_rm(llama_get_memory(g_ctx), 0, 0, -1);
    g_cached_tokens.clear();
    g_n_past = 0;
    return out;
}

// --- jni: cluster ---------------------------------------------------------------------------

static jstring nLastLoadBuffers(JNIEnv* env, jclass) {
    std::lock_guard<std::mutex> lock(g_load_log_mutex);
    return env->NewStringUTF(g_load_buffers.c_str());
}

static jstring nWorkerPeer(JNIEnv* env, jclass) {
    std::lock_guard<std::mutex> lock(g_load_log_mutex);
    return g_worker_peer.empty() ? nullptr : env->NewStringUTF(g_worker_peer.c_str());
}

// Memory read speed in GB/s: token generation streams the weights from RAM, so this ranks
// devices better than core counts. ~0.2 s.
static jdouble nMemBandwidth(JNIEnv*, jclass, jint threads) {
    const int n = std::max(1, (int)threads);
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

// Runs this device as a worker: blocks for as long as the server runs (ggml can't stop it),
// so it lives in its own process. Returns only when it couldn't start, with the reason.
static jstring nServe(JNIEnv* env, jclass, jstring lib_dir, jstring endpoint, jstring cache_dir, jint n_threads) {
    ggml_backend_reg_t rpc;
    ggml_backend_dev_t cpu;
    {
        std::lock_guard<std::mutex> lock(g_backend_mutex);
        if (g_lib_dir.empty()) g_lib_dir = jstr(env, lib_dir);
        llama_log_set(kulaLog, nullptr);
        loadCpuBackendLocked();
        rpc = loadRpcBackendLocked();
        cpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    }
    if (!rpc) return env->NewStringUTF("this build has no cluster (RPC) support");
    if (!cpu) return env->NewStringUTF("no CPU backend");
    using start_fn = void (*)(const char*, const char*, size_t, size_t, ggml_backend_dev_t*);
    auto start = reinterpret_cast<start_fn>(ggml_backend_reg_get_proc_address(rpc, "ggml_backend_rpc_start_server"));
    if (!start) return env->NewStringUTF("RPC backend is missing its server");
    const std::string ep = jstr(env, endpoint), cache = jstr(env, cache_dir);
    if (!isLoopbackEndpoint(ep)) return env->NewStringUTF("refusing to serve rpc anywhere but 127.0.0.1");
    LOGI("worker listening on %s", ep.c_str());
    g_worker_running = true;
    std::thread(radioKeepAwake).detach();
    start(ep.c_str(), cache.empty() ? nullptr : cache.c_str(), (size_t)std::max(1, (int)n_threads), 1, &cpu);
    g_worker_running = false;
    return env->NewStringUTF("worker stopped: is the port already in use?");
}

// --- registration ----------------------------------------------------------------------------

static const JNINativeMethod kNatives[] = {
    {"initBackends", "(Ljava/lang/String;)Z", (void*)nInitBackends},
    {"ggufMeta", "(Ljava/lang/String;)Ljava/lang/String;", (void*)nGgufMeta},
    {"loadModel", "(Ljava/lang/String;II[Ljava/lang/String;[FF)Ljava/lang/String;", (void*)nLoadModel},
    {"freeModel", "()V", (void*)nFreeModel},
    {"isLoaded", "()Z", (void*)nIsLoaded},
    {"applyTemplate", "([Ljava/lang/String;[Ljava/lang/String;)Ljava/lang/String;", (void*)nApplyTemplate},
    {"generate", "(Ljava/lang/String;IFFIFFILkotlin/jvm/functions/Function1;)I", (void*)nGenerate},
    {"stop", "()V", (void*)nStop},
    {"tokensUsed", "()I", (void*)nTokensUsed},
    {"contextSize", "()I", (void*)nContextSize},
    {"clearContext", "()V", (void*)nClearContext},
    {"lastLoadBuffers", "()Ljava/lang/String;", (void*)nLastLoadBuffers},
    {"workerPeer", "()Ljava/lang/String;", (void*)nWorkerPeer},
    {"memBandwidth", "(I)D", (void*)nMemBandwidth},
    {"serve", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I)Ljava/lang/String;", (void*)nServe},
    {"loadMmproj", "(Ljava/lang/String;I)V", (void*)nLoadMmproj},
    {"freeMmproj", "()V", (void*)nFreeMmproj},
    {"hasVision", "()Z", (void*)nHasVision},
    {"mediaMarker", "()Ljava/lang/String;", (void*)nMediaMarker},
    {"generateImages", "(Ljava/lang/String;[[B[I[IIFFIFFILkotlin/jvm/functions/Function1;)I", (void*)nGenerateImages},
};

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass cls = env->FindClass("expo/modules/kulallama/Native");
    if (!cls) return JNI_ERR;
    if (env->RegisterNatives(cls, kNatives, sizeof(kNatives) / sizeof(kNatives[0])) != JNI_OK) return JNI_ERR;
    return JNI_VERSION_1_6;
}
