// kula-llama core: llama.cpp on the phone and the phone cluster, without any platform in it.
//
// The Android JNI (android/src/main/cpp/kula_llama.cpp) and the iOS bridge
// (ios/KulaLlamaBridge.mm) are thin adapters over this C API. One model per process; every
// call that can fail writes its reason to the caller's std::string and returns false/-1.
//
// Platform differences are compile-time:
//   KULA_BACKEND_DL=1  backends are separate shared objects in lib_dir (Android)
//   KULA_USE_GPU=1     the local layers run on the GPU backend linked in (Metal on iOS)
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace kula {

enum class LogLevel { Info, Warn, Error };
using LogSink = void (*)(LogLevel level, const char* text);
/** Where the core's own lines and llama.cpp's log go (logcat / os_log). Set once at start. */
void setLogSink(LogSink sink);

/** Loads/registers the CPU backend. lib_dir is where the .so files are (ignored without KULA_BACKEND_DL). */
bool initBackends(const std::string& lib_dir);

/** "key\tvalue\n" lines of the GGUF header; false when the file is not a GGUF. */
bool ggufMeta(const std::string& path, std::string& out);

struct LoadResult {
    int local_layers = 0;
    int layers = 0;
    int n_ctx = 0;
};

/**
 * Loads the model; endpoints are "host:port" RPC workers (already probed), weights their
 * shares, local_weight this device's share. On failure returns false with the reason in err.
 */
bool loadModel(const std::string& path, int n_threads, int ctx_size, const std::vector<std::string>& endpoints,
               const std::vector<float>& weights, float local_weight, LoadResult& out, std::string& err);
void freeModel();
bool isLoaded();

/** The model's own chat template (ChatML when it has none) over roles/contents, with the assistant prefix. */
bool applyTemplate(const std::vector<std::string>& roles, const std::vector<std::string>& contents, std::string& out, std::string& err);

using TokenCallback = void (*)(const char* piece, void* user);
/**
 * Streams UTF-8 complete pieces to cb. Returns generated tokens, -1 when stopped before the
 * first token, and -2 on an error (reason in err). Blocks; call it off the main thread.
 */
int generate(const std::string& prompt, int max_tokens, float temperature, float top_p, int top_k, float min_p,
             float repeat_penalty, int seed, TokenCallback cb, void* user, std::string& err);
void stop();
int tokensUsed();
int contextSize();
void clearContext();

/** "<buffer>\t<MiB>\n" per weight buffer of the last load; RPC<n>[host:port] buffers are on workers. */
std::string lastLoadBuffers();
/** Worker: the master connected right now (from the patched RPC log lines), or empty. */
std::string workerPeer();
/** Memory read speed in GB/s over n threads (~0.2 s). */
double memBandwidth(int threads);

/**
 * Runs this device as a worker. Blocks for as long as the server runs (ggml cannot stop it);
 * returns only when it could not start or stopped, with the reason.
 */
std::string serve(const std::string& lib_dir, const std::string& endpoint, const std::string& cache_dir, int n_threads);

}  // namespace kula
